import { decide, nextRunOf, type ScheduleRunStatus, type ScheduleTask } from '../core/schedule.js';
import type { ScheduleStore } from './schedule-store.js';

/**
 * The running half of scheduled tasks: when to look, what to do when something is due, and the
 * bookkeeping that keeps a restart from repeating or losing a run. The decisions are core/schedule.ts
 * (`decide`); how a run is actually carried out — a bash process, a turn in a conversation — is the
 * executor the daemon injects, so this file never touches a platform or an agent.
 *
 * ── One timer, re-armed ───────────────────────────────────────────────────────────────────────
 * After every look the timer is set for the earliest thing due, capped at LOOK_AGAIN_MS. The cap is
 * not an optimisation: it is what makes a host clock that jumps (NTP after a suspend, a container
 * restored from a snapshot) cost at most a minute rather than a whole setTimeout's worth of drift,
 * and it keeps every timeout far below Node's 2^31 ms ceiling.
 *
 * ── The order of the bookkeeping is the point ─────────────────────────────────────────────────
 * `lastPlannedAt` is written BEFORE a run starts. If the daemon dies mid-run, the run is not made
 * again on restart — an at-most-once promise, which for "post the morning brief" and "run this
 * backup" is the right one. The outcome is written when the run ends.
 */

/** How a run ended, as the executor reports it. The scheduler adds timing. */
export interface ScheduleRunResult {
  status: Extract<ScheduleRunStatus, 'ok' | 'failed' | 'interrupted'>;
  exitCode?: number;
  error?: string;
}

export interface ScheduleExecutor {
  /** Carry out one run. Must not throw — a failure is a result. `signal` fires on daemon shutdown. */
  run(task: ScheduleTask, planned: number, signal: AbortSignal): Promise<ScheduleRunResult>;
  /** A task changed state on its own (a fixed-session window closed). Best-effort; say so in chat. */
  notify?(task: ScheduleTask, event: 'expired'): void;
}

/** Longest the scheduler goes without looking. */
const LOOK_AGAIN_MS = 60_000;

/** An error string written into a task's record is capped: it is shown in a one-line list. */
export const ERROR_LIMIT = 200;

export class Scheduler {
  private cancelTimer: (() => void) | null = null;
  /** Task id → the abort for its run in flight. One run per task at a time. */
  private running = new Map<string, AbortController>();
  private stopped = false;

  constructor(
    private readonly store: ScheduleStore,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    private readonly executor: ScheduleExecutor
  ) {}

  start(): void {
    this.stopped = false;
    const active = this.store.list().filter((t) => t.state === 'active').length;
    console.log(`[schedule] started with ${this.store.list().length} task(s), ${active} active`);
    this.look();
  }

  /** Stop looking and abort runs in flight (their outcome is recorded as interrupted). */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (const abort of this.running.values()) abort.abort();
  }

  /**
   * Stop starting runs, and let the ones in flight finish — for a gateway waiting to restart
   * (restart-drain.ts). What falls due meanwhile is not recorded as missed or run late: it is still
   * due when the next gateway starts, which catches up a run missed by less than an hour.
   */
  hold(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** Runs in flight right now. */
  get inFlight(): number {
    return this.running.size;
  }

  list(): ScheduleTask[] {
    return this.store.list();
  }

  get(id: string): ScheduleTask | undefined {
    return this.store.get(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  add(task: ScheduleTask): void {
    this.store.put(task);
    console.log(`[schedule] #${task.id} "${task.name}" added (${task.run.kind}${task.run.kind === 'agent' ? `/${task.run.session}` : ''})`);
    this.look();
  }

  /**
   * Replace a task after an edit. Same id and history; the timer is re-armed so the new time rule
   * takes effect at once rather than at the old task's next planned run.
   *
   * Returns false, writing nothing, when the id is gone: `put` inserts, and an edit that was being
   * checked while the task was deleted must not bring it back.
   */
  update(task: ScheduleTask): boolean {
    if (!this.store.has(task.id)) return false;
    this.store.put(task);
    console.log(`[schedule] #${task.id} "${task.name}" updated`);
    this.look();
    return true;
  }

  remove(id: string): ScheduleTask | undefined {
    const task = this.store.get(id);
    if (!task) return undefined;
    this.store.remove(id);
    // A run in flight is left to finish: killing a half-done backup because its schedule was
    // deleted is not what "delete the schedule" means. Its outcome simply has nowhere to be written.
    console.log(`[schedule] #${id} removed`);
    this.look();
    return task;
  }

  /**
   * Pause or resume. Resuming does not replay what was skipped while paused — the next run is the
   * first planned time from now — and a fixed-session task whose window closed meanwhile comes back
   * expired rather than active. Returns the task, or a sentence saying why nothing changed.
   */
  setPaused(id: string, paused: boolean): ScheduleTask | string {
    const task = this.store.get(id);
    if (!task) return `no scheduled task #${id}`;
    if (task.state === 'expired') return `#${id} has expired (fixed-session tasks live 24h); register a new one instead`;
    if (task.state === 'done') return `#${id} was a one-time task and has already had its run`;
    if (paused === (task.state === 'paused')) return `#${id} is already ${task.state}`;
    const now = this.clock.now();
    const next: ScheduleTask = paused
      ? { ...task, state: 'paused' }
      : {
          ...task,
          state: task.expiresAt !== undefined && now >= task.expiresAt ? 'expired' : 'active',
          lastPlannedAt: Math.max(task.lastPlannedAt ?? -Infinity, now),
        };
    this.store.put(next);
    console.log(`[schedule] #${id} ${next.state}`);
    this.look();
    return next;
  }

  /**
   * Run a task now, out of schedule — to try one out. Its planned times are untouched, so the next
   * scheduled run still happens. Refused while a run of it is already going.
   */
  runNow(id: string): ScheduleTask | string {
    const task = this.store.get(id);
    if (!task) return `no scheduled task #${id}`;
    if (this.running.has(id)) return `#${id} is running right now`;
    if (this.stopped) return `the gateway is restarting; run #${id} again once it is back`;
    void this.execute(task, this.clock.now(), { manual: true });
    return task;
  }

  /** Evaluate every task, act on what is due, and arm the timer for the next look. */
  private look(): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    const now = this.clock.now();
    let wake = now + LOOK_AGAIN_MS;
    for (const task of this.store.list()) {
      if (task.state !== 'active') continue;
      const at = this.handle(task, now);
      if (at !== undefined) wake = Math.min(wake, at);
    }
    this.cancelTimer = this.clock.schedule(() => this.look(), Math.max(0, wake - now));
  }

  /** Act on one active task; returns when it next wants looking at, if it does. */
  private handle(task: ScheduleTask, now: number): number | undefined {
    const decision = decide(task, now);
    switch (decision.kind) {
      case 'wait':
        return decision.at;
      case 'run':
        if (this.running.has(task.id)) {
          // Still running from last time: this run is skipped, not stacked behind it.
          this.record(task, decision.planned, { at: now, status: 'skipped', error: 'the previous run was still going' });
        } else {
          void this.execute(task, decision.planned, { manual: false });
        }
        return undefined;
      case 'missed':
        console.warn(`[schedule] #${task.id} missed its ${new Date(decision.planned).toISOString()} run (the daemon was not running)`);
        this.record(task, decision.planned, { at: now, status: 'missed', error: 'the gateway was not running at the time' });
        return undefined;
      case 'expire': {
        const expired: ScheduleTask = { ...task, state: 'expired' };
        this.store.put(expired);
        console.log(`[schedule] #${task.id} expired`);
        this.executor.notify?.(expired, 'expired');
        return undefined;
      }
      case 'done':
        this.store.put({ ...task, state: 'done' });
        return undefined;
      default: {
        const _exhaustive: never = decision;
        throw new Error(`unknown schedule decision ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Record a planned time as handled without running it, then look again for what follows. */
  private record(task: ScheduleTask, planned: number, lastRun: NonNullable<ScheduleTask['lastRun']>): void {
    const next: ScheduleTask = {
      ...task,
      lastPlannedAt: planned,
      lastRun,
      ...('at' in task.when ? { state: 'done' as const } : {}),
    };
    this.store.put(next);
    // Another look straight away: the task's following run may itself be due (it will not be, for
    // the catch-up walk already skipped to the latest planned time, but the timer must be re-armed).
    queueMicrotask(() => this.look());
  }

  private async execute(task: ScheduleTask, planned: number, opts: { manual: boolean }): Promise<void> {
    const abort = new AbortController();
    this.running.set(task.id, abort);
    // Written before the run so a crash mid-run does not make it again (see the file header).
    if (!opts.manual) this.store.put({ ...task, lastPlannedAt: planned });
    const started = this.clock.now();
    console.log(`[schedule] #${task.id} "${task.name}" running${opts.manual ? ' (run now)' : ''}`);
    let result: ScheduleRunResult;
    try {
      result = await this.executor.run(task, planned, abort.signal);
    } catch (e) {
      // The executor promises not to throw; if it does anyway the outcome is still written down.
      result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running.delete(task.id);
    }
    const current = this.store.get(task.id);
    if (!current) return; // removed while it ran
    const durationMs = this.clock.now() - started;
    const error = result.error && result.error.length > ERROR_LIMIT ? `${result.error.slice(0, ERROR_LIMIT - 1)}…` : result.error;
    this.store.put({
      ...current,
      runs: current.runs + 1,
      lastRun: {
        at: started,
        status: result.status,
        durationMs,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(error ? { error } : {}),
      },
      // A one-shot is done once its scheduled run has been made; a manual try leaves it pending.
      ...(!opts.manual && 'at' in current.when ? { state: 'done' as const } : {}),
    });
    console.log(`[schedule] #${task.id} finished: ${result.status}${error ? ` (${error})` : ''} in ${durationMs}ms`);
    this.look();
  }

  /** When an active task runs next — for the list and the cards. */
  nextRun(task: ScheduleTask): number | undefined {
    return nextRunOf(task, this.clock.now());
  }
}
