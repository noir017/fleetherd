import { WriteDroppedError } from './outbound-errors.js';

/**
 * One outbound write budget per chat.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────────
 *
 * Every writer in the system had its own idea of how fast it could write, and the platform has
 * only one. `StreamBuffer` throttled itself to ~1 edit/1200 ms; `ToolRenderer` had no throttle at
 * all and repainted its bubble on every tool start AND every tool finish; the reactions, the acks,
 * the menus and the agent's own reverse commands were unthrottled by construction. Telegram counts
 * all of that as one stream per chat, so it answered 429 — 78 times in a single daemon run, with
 * `retry after` climbing to 229 seconds, each one a progress update that never arrived.
 *
 * A per-writer throttle cannot fix that no matter how it is tuned: the quantity being limited is a
 * SUM, and no summand can see it. So the budget lives here, once, and every write passes through.
 *
 * ── The model ───────────────────────────────────────────────────────────────────────────────────
 *
 *   submit(job) ─▶ [ per-chat FIFO ] ─▶ token bucket (chat) ─▶ token bucket (instance) ─▶ run()
 *                        │
 *                        └─ a queued EDIT is replaced in place by a newer edit to the same message
 *
 * - **FIFO per chat.** Submission order is delivery order, so a tool bubble submitted before the
 *   text below it stays above that text no matter how congested the lane is.
 * - **Token bucket, not a fixed interval.** An idle chat writes immediately (burst tokens are
 *   waiting); a busy one paces. A fixed interval gets this backwards — it delays the first write
 *   of a quiet turn and still over-sends during a flood.
 * - **Coalescing.** An edit is a statement about a message's final content, so when two are queued
 *   for the same message only the newest is worth sending; the older resolves as `superseded`. A
 *   send creates a new object whose ref the caller needs back, so a send is never coalesced. The
 *   replacement keeps the queue POSITION its first version earned, which is what preserves order.
 * - **Pausing.** `penalize(key, ms)` stops a lane for exactly as long as the platform asked. This
 *   is chat-scoped and temporary — the opposite of the message-scoped, permanent seal in
 *   `stream-buffer.ts` (see "Sealing vs. pacing" in the module README).
 *
 * ── What may be dropped ─────────────────────────────────────────────────────────────────────────
 *
 * Waiting is only correct for a write that is still worth making when the wait ends:
 *
 * | class      | meaning                        | dropped when                                    |
 * |------------|--------------------------------|-------------------------------------------------|
 * | `reply`    | the answer, and anything the agent explicitly asked for | never          |
 * | `progress` | tool bubbles: a running commentary | superseded, or queued past `progressMaxWaitMs` |
 * | `typing`   | an indicator that expires by itself | immediately, unless a token is free right now |
 *
 * Dropping is reported as `WriteDroppedError`, never as success: the caller's state is untouched
 * and it is free to write the same content again. That is what makes "a progress update is never
 * lost" structural rather than lucky — the bubble's state simply stays undelivered until a later
 * paint carries it.
 *
 * `typing` is droppable only BECAUSE it expires by itself. A platform whose typing is a switch held
 * until stopped (the web UI, `typingUntilStopped`) never sends it through here: a dropped start
 * there is not a missed beat but a topic marked idle for the whole of a busy turn.
 *
 * Pure: no clock, no IO. `now()`/`schedule()` are injected, the same seam `StreamSink` uses.
 */

/** Which lane a write belongs to; decides what may be dropped under congestion. */
export type OutboundClass = 'reply' | 'progress' | 'typing';

/**
 * How often, at most, finished lanes are let go (see sweepIdle). A sweep walks every lane, so it is
 * rationed by time rather than run on every write; until the next one a finished lane just waits.
 */
export const IDLE_SWEEP_MS = 60_000;

export interface PacerClock {
  now(): number;
  /** Fire `fn` after `ms`; returns a cancel handle. */
  schedule(fn: () => void, ms: number): () => void;
}

export interface PacerOptions {
  /** Sustained writes per second, per chat. */
  ratePerSec: number;
  /** Writes that may go out back-to-back on a chat that has been idle. */
  burst: number;
  /** Ceiling across all chats of one platform instance. */
  globalRatePerSec: number;
  globalBurst: number;
  /** How long a `progress` write may sit queued before it is no longer worth delivering. */
  progressMaxWaitMs: number;
  /** Ceiling on an honored `penalize`, so one absurd value cannot wedge a lane for the process. */
  maxRetryAfterMs: number;
}

export interface PaceJob<T> {
  /**
   * The chat this write lands in: `<platformInstance>:<channel>`, NEVER including the thread.
   * A Telegram forum topic shares its parent chat's flood budget, so keying by lane would hand
   * every topic its own allowance and reproduce the flood one level down. The one exception is a
   * platform with no flood budget at all (`paceByLane`, the web UI), where the lane is the chat.
   */
  key: string;
  /** Instance-wide bucket key, for the platform's overall ceiling. */
  instance: string;
  cls: OutboundClass;
  /** Coalescing identity. A QUEUED job with the same `key` and `slot` is replaced by this one. */
  slot?: string;
  run(): Promise<T>;
}

/** A job waiting for its turn on one chat's FIFO. */
interface Queued {
  cls: OutboundClass;
  slot?: string;
  /** When it was submitted — `progressMaxWaitMs` is measured from here. */
  at: number;
  run(): Promise<unknown>;
  settle(value: unknown): void;
  fail(err: unknown): void;
}

/** One chat's queue plus its bucket state. */
interface Lane {
  queue: Queued[];
  /** Fractional tokens; refilled lazily from `ratePerSec` at read time. */
  tokens: number;
  lastRefill: number;
  /** Set by penalize: nothing runs on this lane before it. */
  pausedUntil: number;
  /** Whether a pump is already scheduled/running for this lane. */
  pumping: boolean;
  cancelTimer: (() => void) | null;
}

export class OutboundPacer {
  private readonly lanes = new Map<string, Lane>();
  /** Instance-wide buckets, keyed by PaceJob.instance. Same shape, no queue of their own. */
  private readonly instances = new Map<string, { tokens: number; lastRefill: number }>();
  private draining = false;
  /** When sweepIdle last walked the lanes. */
  private lastSweep = 0;

  constructor(
    private readonly opts: PacerOptions,
    private readonly clock: PacerClock
  ) {}

  /**
   * Queue a write and resolve with whatever `run()` returns.
   *
   * Rejects with `WriteDroppedError` when the job never ran (superseded / timed out / drained);
   * a failure from `run()` itself propagates untouched, since only the caller knows what to do
   * with a platform error.
   */
  submit<T>(job: PaceJob<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(new WriteDroppedError('shutdown'));
    }
    const now = this.clock.now();
    this.sweepIdle(now);
    const lane = this.laneFor(job.key);

    // `typing` is the one class with no queue semantics at all: an indicator that arrives late is
    // worse than one that never arrives, and it self-expires anyway. Take a token or give up.
    if (job.cls === 'typing' && !(lane.queue.length === 0 && this.takeTokens(job, now))) {
      return Promise.reject(
        new WriteDroppedError('timeout', { retryAfterMs: this.pausedForMs(job.key) || undefined })
      );
    }

    return new Promise<T>((resolve, reject) => {
      const entry: Queued = {
        cls: job.cls,
        slot: job.slot,
        at: now,
        run: job.run as () => Promise<unknown>,
        settle: (v) => resolve(v as T),
        fail: reject,
      };

      // Coalesce: a newer edit to the same message subsumes the queued one. Replaced IN PLACE so
      // the newer content inherits the position the older one had already waited for — appending
      // instead would let a busy message drift behind everything submitted after it.
      const at = job.slot === undefined ? -1 : lane.queue.findIndex((q) => q.slot === job.slot);
      if (at >= 0) {
        const stale = lane.queue[at]!;
        lane.queue[at] = entry;
        stale.fail(new WriteDroppedError('superseded'));
      } else {
        lane.queue.push(entry);
      }
      this.pump(job.key, job.instance);
    });
  }

  /**
   * The platform told us to wait: stop this lane for that long.
   *
   * Idempotent and monotonic — the longest pause wins, because two concurrent writes to one chat
   * both get a 429 and the second's (shorter, already-elapsing) number must not shorten the first.
   */
  penalize(key: string, retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
    const lane = this.laneFor(key);
    const until = this.clock.now() + Math.min(retryAfterMs, this.opts.maxRetryAfterMs);
    if (until > lane.pausedUntil) lane.pausedUntil = until;
  }

  /** How much longer this lane is paused; 0 when it is not. */
  pausedForMs(key: string): number {
    const lane = this.lanes.get(key);
    if (!lane) return 0;
    return Math.max(0, lane.pausedUntil - this.clock.now());
  }

  /**
   * Shutdown: stop accepting new work and run what is already queued, up to `budgetMs`.
   *
   * A queued write is somebody's answer, so a stop that simply dropped the queue would lose it.
   * The budget bounds how long a shutdown can be held hostage by a paused lane.
   */
  async drain(budgetMs: number): Promise<{ delivered: number; abandoned: number }> {
    this.draining = true;
    const deadline = this.clock.now() + budgetMs;
    let delivered = 0;

    for (const lane of this.lanes.values()) {
      lane.cancelTimer?.();
      lane.cancelTimer = null;
      while (lane.queue.length > 0 && this.clock.now() < deadline) {
        const entry = lane.queue.shift()!;
        try {
          entry.settle(await entry.run());
        } catch (e) {
          entry.fail(e);
        }
        delivered++;
      }
    }

    let abandoned = 0;
    for (const lane of this.lanes.values()) {
      for (const entry of lane.queue.splice(0)) {
        entry.fail(new WriteDroppedError('shutdown'));
        abandoned++;
      }
    }
    return { delivered, abandoned };
  }

  /** How many chats hold a lane right now. For tests. */
  laneCount(): number {
    return this.lanes.size;
  }

  // --- internal ---

  /**
   * Let go of every lane a fresh one would equal: nothing queued, nothing running or armed, no
   * pause left, and a bucket back to full. A lane starts full (laneFor), so dropping one in that
   * state changes nothing a later write could see — that condition is what makes this safe, not
   * how long the lane has been quiet. Anything short of it is kept: a lane serving out a
   * platform's retry-after must still be paused when the next write comes, and a half-spent
   * bucket must not be handed a fresh burst.
   *
   * Without this every chat ever written to kept its lane for the life of the process — on the web
   * UI, which paces each topic apart (paceByLane), one per topic, every sub-agent's and every
   * scheduled run's included.
   */
  private sweepIdle(now: number): void {
    if (now - this.lastSweep < IDLE_SWEEP_MS) return;
    this.lastSweep = now;
    for (const [key, lane] of this.lanes) {
      if (lane.queue.length > 0 || lane.pumping || lane.cancelTimer || lane.pausedUntil > now) continue;
      if (this.laneTokens(lane, now) < this.opts.burst) continue;
      this.lanes.delete(key);
    }
  }

  private laneFor(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      // A lane starts full: a chat nobody has written to has not spent anything, and making the
      // first reply of a conversation wait for a refill would be a self-inflicted latency.
      lane = {
        queue: [],
        tokens: this.opts.burst,
        lastRefill: this.clock.now(),
        pausedUntil: 0,
        pumping: false,
        cancelTimer: null,
      };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Refill by elapsed time and report the current token count (chat lane). */
  private laneTokens(lane: Lane, now: number): number {
    const elapsed = Math.max(0, now - lane.lastRefill);
    lane.tokens = Math.min(this.opts.burst, lane.tokens + (elapsed * this.opts.ratePerSec) / 1000);
    lane.lastRefill = now;
    return lane.tokens;
  }

  /** Refill and report the instance-wide token count. */
  private instanceTokens(instance: string, now: number): number {
    let bucket = this.instances.get(instance);
    if (!bucket) {
      bucket = { tokens: this.opts.globalBurst, lastRefill: now };
      this.instances.set(instance, bucket);
    }
    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(
      this.opts.globalBurst,
      bucket.tokens + (elapsed * this.opts.globalRatePerSec) / 1000
    );
    bucket.lastRefill = now;
    return bucket.tokens;
  }

  /** Spend one token from both buckets, or spend nothing. */
  private takeTokens(job: { key: string; instance: string }, now: number): boolean {
    const lane = this.laneFor(job.key);
    if (lane.pausedUntil > now) return false;
    if (this.laneTokens(lane, now) < 1) return false;
    if (this.instanceTokens(job.instance, now) < 1) return false;
    lane.tokens -= 1;
    this.instances.get(job.instance)!.tokens -= 1;
    return true;
  }

  /** How long until this lane could run something, in ms (0 = now). */
  private waitFor(key: string, instance: string, now: number): number {
    const lane = this.laneFor(key);
    const paused = Math.max(0, lane.pausedUntil - now);
    const laneWait = Math.max(0, ((1 - this.laneTokens(lane, now)) * 1000) / this.opts.ratePerSec);
    const instWait = Math.max(
      0,
      ((1 - this.instanceTokens(instance, now)) * 1000) / this.opts.globalRatePerSec
    );
    return Math.max(paused, laneWait, instWait);
  }

  /**
   * Run this lane's queue until it stalls, then arm a timer for when it could resume.
   *
   * Serial by design (`pumping`): one write at a time per chat is what makes FIFO order an
   * observable guarantee rather than a hope about scheduling.
   */
  private pump(key: string, instance: string): void {
    const lane = this.laneFor(key);
    if (lane.pumping) return;
    lane.pumping = true;
    void this.runLane(key, instance, lane).finally(() => {
      lane.pumping = false;
      // Work may have arrived while the last job was in flight. Guarded on cancelTimer: when
      // runLane parked because the bucket was empty, the timer it armed is what resumes the lane —
      // re-pumping here would spin, re-arming and returning without end.
      if (lane.queue.length > 0 && !lane.cancelTimer) this.pump(key, instance);
    });
  }

  private async runLane(key: string, instance: string, lane: Lane): Promise<void> {
    for (;;) {
      if (this.draining) return;
      this.expire(lane);
      const head = lane.queue[0];
      if (!head) return;

      const now = this.clock.now();
      if (!this.takeTokens({ key, instance }, now)) {
        // Nothing to spend. Wake at whichever comes first: the moment a token (or the pause's end)
        // could let the head run, or the moment the oldest droppable job stops being worth
        // sending. Without the second term a lane paused for 229 s would sit on a progress write
        // for the whole pause and only then report it dropped — long after its caller could have
        // done anything useful with the answer.
        const wait = Math.max(1, Math.ceil(Math.min(this.waitFor(key, instance, now), this.nextExpiry(lane, now))));
        lane.cancelTimer?.();
        lane.cancelTimer = this.clock.schedule(() => {
          lane.cancelTimer = null;
          this.pump(key, instance);
        }, wait);
        return;
      }

      lane.queue.shift();
      try {
        head.settle(await head.run());
      } catch (e) {
        head.fail(e);
      }
    }
  }

  /**
   * Discard queued writes that are no longer worth making.
   *
   * Only `progress` expires. A stale tool bubble delivered minutes late is worse than none — the
   * next paint carries the current state — while a reply is the thing the user is waiting for and
   * is delivered however long it takes.
   */
  private expire(lane: Lane): void {
    if (lane.queue.length === 0) return;
    const now = this.clock.now();
    const retryAfterMs = Math.max(0, lane.pausedUntil - now) || undefined;
    lane.queue = lane.queue.filter((q) => {
      if (q.cls !== 'progress' || now - q.at < this.opts.progressMaxWaitMs) return true;
      q.fail(new WriteDroppedError('timeout', { retryAfterMs }));
      return false;
    });
  }

  /** How long until the oldest droppable job in this lane expires; Infinity when there is none. */
  private nextExpiry(lane: Lane, now: number): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const q of lane.queue) {
      if (q.cls !== 'progress') continue;
      soonest = Math.min(soonest, q.at + this.opts.progressMaxWaitMs - now);
    }
    return soonest;
  }
}
