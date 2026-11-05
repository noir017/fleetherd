import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { findAgent, type Config } from '../config/schema.js';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import {
  bashResultText,
  bashStatus,
  buildTask,
  formatDay,
  formatInZone,
  nextRunOf,
  runNoticeText,
  taskCardText,
  taskExpiredText,
  taskView,
  type NewTaskInput,
  type ScheduleDaySession,
  type ScheduleTask,
} from '../core/schedule.js';
import type { SoloOutcome } from '../core/inbound-merger.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId } from '../types.js';
import type { ScheduleListResult, ScheduleTaskView } from '../ipc/protocol.js';
import type { ConversationRegistry } from './conversation.js';
import { runBashCommand, runRemoteBashCommand, type BashRunResult } from './schedule-bash.js';
import { remoteHosts } from './remote-hosts.js';
import type { ScheduleStore } from './schedule-store.js';
import { Scheduler, type ScheduleRunResult } from './scheduler.js';

/**
 * Scheduled tasks, wired to the rest of the daemon: how a run is carried out (a bash process, or a
 * turn in a conversation), what the agent's `schedule` commands do, and the cards posted when a
 * task changes. Its own file so daemon.ts stays the switchboard it is; the decisions are
 * core/schedule.ts and the timing is scheduler.ts.
 *
 * Every run posts before it does anything visible — a notice for an agent run, the result for a
 * bash one — so output that arrives unasked always says which task produced it.
 */

/** What the service needs from the registry: the scheduled-run entry points and a few read views. */
type Registry = Pick<
  ConversationRegistry,
  | 'conversationAt'
  | 'runScheduledPrompt'
  | 'scheduledModelProblem'
  | 'applyScheduledModel'
  | 'openScheduledConversation'
  | 'releaseScheduled'
  | 'boundAgentOf'
  | 'laneFor'
  | 'platformFor'
  | 'workdirOf'
>;

export class ScheduleService {
  readonly scheduler: Scheduler;
  private readonly defaultTz: string;

  constructor(
    private readonly config: Config,
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly registry: Registry,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    private readonly store: ScheduleStore,
    /** `<configDir>/schedule-runs` — one directory of bash logs per task. */
    private readonly runsDir: string
  ) {
    // The daemon's own zone (TZ, else the host's) is what "8 o'clock" means to whoever set it up.
    this.defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.scheduler = new Scheduler(store, clock, {
      run: (task, planned, signal) => this.run(task, planned, signal),
      notify: (task) => this.post(task.target.platform, targetAddress(task), taskExpiredText(task), 'expiry notice'),
    });
  }

  // ─────────────────────────────── the agent's commands ───────────────────────────────

  /** `schedule add`. Throws a sentence the agent can act on when the task is refused. */
  async add(input: NewTaskInput, caller: ConversationId, target: { platform: string; address: ConversationAddress }): Promise<ScheduleTaskView> {
    const from = {
      key: caller,
      platform: this.registry.platformFor(caller) ?? target.platform,
      agent: this.registry.boundAgentOf(caller) ?? this.config.routing.default,
      ...optional('cwd', this.registry.workdirOf(caller)),
    };
    const host = findAgent(this.config, from.agent)?.host;
    if (host) Object.assign(from, { host });
    const targetConversation = this.registry.conversationAt(target.platform, target.address);
    const built = buildTask(input, {
      now: this.clock.now(),
      id: this.newId(),
      defaultTz: this.defaultTz,
      agents: this.config.agents.map((a) => a.id),
      from,
      target,
      canOpenTopic: this.platforms.get(target.platform)?.capabilities.thread === true,
      ...(targetConversation ? { targetConversation } : {}),
    });
    if (!built.ok) throw new Error(built.error);
    if (built.task.run.kind === 'agent' && built.task.run.model !== undefined) {
      // The list is the agent's own (`/model` shows the same one), so a typo is refused HERE,
      // while the registering agent can still retry in this turn with a name that exists.
      const why = await this.registry.scheduledModelProblem(built.task.run.agent, built.task.run.model, caller);
      if (why) throw new Error(why);
    }
    this.scheduler.add(built.task);
    this.card(caller, built.task, 'registered');
    return taskView(built.task, this.clock.now(), { detail: true, here: caller });
  }

  list(caller: ConversationId | undefined, id?: string): ScheduleListResult {
    const now = this.clock.now();
    if (id !== undefined) {
      const task = this.scheduler.get(id);
      if (!task) throw new Error(`no scheduled task #${id}; \`talkcode schedule list\` shows them all`);
      return { tasks: [taskView(task, now, { detail: true, here: caller })] };
    }
    return { tasks: this.scheduler.list().map((t) => taskView(t, now, { here: caller })) };
  }

  /**
   * remove / pause / resume / run. Throws when nothing changed, with the reason. `announce` posts the
   * task's card in the caller's conversation — on for the agent's commands (the user should read
   * what changed in the daemon's words), off for the `/setting` menu, whose own message already says.
   */
  op(
    id: string,
    op: 'remove' | 'pause' | 'resume' | 'run',
    caller: ConversationId | undefined,
    announce = true
  ): ScheduleTaskView {
    const now = this.clock.now();
    const say = (task: ScheduleTask, verb: string): void => {
      if (caller && announce) this.card(caller, task, verb);
    };
    if (op === 'remove') {
      const removed = this.scheduler.remove(id);
      if (!removed) throw new Error(`no scheduled task #${id}`);
      say(removed, 'deleted');
      return taskView(removed, now, { here: caller });
    }
    const result = op === 'run' ? this.scheduler.runNow(id) : this.scheduler.setPaused(id, op === 'pause');
    if (typeof result === 'string') throw new Error(result);
    if (op !== 'run') say(result, op === 'pause' ? 'paused' : 'resumed');
    return taskView(result, now, { here: caller });
  }

  /** One task by id, for the menu's re-read at every click. */
  get(id: string): ScheduleTask | undefined {
    return this.scheduler.get(id);
  }

  now(): number {
    return this.clock.now();
  }

  /** Every task, for `/setting schedule`. */
  tasks(): ScheduleTask[] {
    return this.scheduler.list();
  }

  /**
   * Whether a task that can still run posts into the conversation at `ref` — what keeps the web
   * UI from evicting that topic (`PlatformAdapter.useScheduleLookup`).
   *
   * Paused counts: resuming it would otherwise find its topic gone. Expired and done do not; an
   * expired task has already posted its notice and runs no more.
   */
  targets(ref: ConversationRef): boolean {
    return this.scheduler.list().some((t) => {
      if (t.state !== 'active' && t.state !== 'paused') return false;
      if (t.target.platform !== ref.platform) return false;
      if (t.target.channel === ref.channel && t.target.thread === ref.thread) return true;
      // A daily task's topic for today is not its target — it is the conversation the day's runs
      // join, and evicting it would lose the day's context (and force a fresh topic next run).
      return (
        t.daySession !== undefined &&
        t.daySession.address.channel === ref.channel &&
        t.daySession.address.thread === ref.thread
      );
    });
  }

  nextRun(task: ScheduleTask): number | undefined {
    return nextRunOf(task, this.clock.now());
  }

  // ─────────────────────────────── running ───────────────────────────────

  private async run(task: ScheduleTask, planned: number, signal: AbortSignal): Promise<ScheduleRunResult> {
    const platform = this.platforms.get(task.target.platform);
    if (!platform) return { status: 'failed', error: `platform instance "${task.target.platform}" is not configured any more` };
    try {
      if (task.run.kind === 'bash') return await this.runBash(task, task.run, platform, planned, signal);
      return await this.runAgent(task, task.run, platform, planned);
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async runBash(
    task: ScheduleTask,
    run: Extract<ScheduleTask['run'], { kind: 'bash' }>,
    platform: PlatformAdapter,
    planned: number,
    signal: AbortSignal
  ): Promise<ScheduleRunResult> {
    const started = this.clock.now();
    const stamp = new Date(planned).toISOString().replace(/[:.]/g, '-');
    const opts = {
      command: run.command,
      ...optional('cwd', run.cwd),
      timeoutMs: run.timeoutMs,
      logDir: path.join(this.runsDir, task.id),
      stamp,
      signal,
    };
    let r: BashRunResult;
    if (run.host) {
      const host = remoteHosts.get(run.host);
      if (!host) return { status: 'failed', error: `host "${run.host}" is not configured any more` };
      r = await runRemoteBashCommand(host, opts);
    } else {
      r = await runBashCommand(opts);
    }
    const outcome = { ...r, durationMs: this.clock.now() - started };
    const { text, attach } = bashResultText(task, outcome, run.timeoutMs);
    const address = targetAddress(task);
    await platform.sendMessage(address, text).catch((e) => warn('bash result', e));
    if (attach && r.logFile) {
      await platform.sendFile(address, { path: r.logFile, name: `${task.id}-${stamp}.log` }).catch((e) => warn('bash log', e));
    }
    const { status, error } = bashStatus(outcome, run.timeoutMs);
    return { status, ...optional('exitCode', r.exitCode ?? undefined), ...optional('error', error) };
  }

  private async runAgent(
    task: ScheduleTask,
    run: Extract<ScheduleTask['run'], { kind: 'agent' }>,
    platform: PlatformAdapter,
    planned: number
  ): Promise<ScheduleRunResult> {
    // Sent exactly as it was registered, with nothing marking it as scheduled: the agent wrote this
    // prompt itself when it added the task, so it already says what to do, and a gateway preamble
    // would be the only text in the conversation the agent did not get from a person or itself.
    // The user is told the run started by its own notice (runNoticeText), outside the agent's view.
    const prompt = run.prompt;
    if (run.session === 'fixed') {
      const key = task.conversation!;
      const bound = this.registry.boundAgentOf(key);
      if (bound !== undefined && bound !== run.agent) {
        // A topic keeps its agent; after /new the user may have given it another on purpose.
        const why = `this topic is now answered by ${bound}, not ${run.agent}`;
        await platform.sendMessage(targetAddress(task), `⏰ \`#${task.id}\` **${task.name}** skipped — ${why}.`).catch((e) => warn('skip notice', e));
        return { status: 'failed', error: why };
      }
      await platform.sendMessage(targetAddress(task), runNoticeText(task, planned)).catch((e) => warn('run notice', e));
      return toResult(
        await this.registry.runScheduledPrompt({ key, platform: task.target.platform, address: targetAddress(task), agentId: run.agent, prompt })
      );
    }

    if (run.session === 'daily') return this.runDaily(task, run, platform, planned);

    const opened = await this.registry.openScheduledConversation({
      platform: task.target.platform,
      address: targetAddress(task),
      agentId: run.agent,
      title: `⏰ ${task.name} · ${formatInZone(planned, task.when.tz)}`,
      ...optional('cwd', run.cwd),
      ephemeralKey: `schedule#${task.id}#${planned}`,
    });
    try {
      if (run.model) {
        // Before the notice: a run that cannot use the model it was given must not announce
        // itself as started. Strict by design — see applyScheduledModel.
        const why = await this.registry.applyScheduledModel(opened.key, task.target.platform, run.agent, run.model);
        if (why) {
          await platform
            .sendMessage(opened.address, `⏰ \`#${task.id}\` **${task.name}** failed — ${why}.`)
            .catch((e) => warn('model failure notice', e));
          return { status: 'failed', error: why };
        }
      }
      await platform.sendMessage(opened.address, runNoticeText(task, planned)).catch((e) => warn('run notice', e));
      return toResult(
        await this.registry.runScheduledPrompt({ key: opened.key, platform: task.target.platform, address: opened.address, agentId: run.agent, prompt })
      );
    } finally {
      if (opened.ephemeral) this.registry.releaseScheduled(opened.key);
    }
  }

  /**
   * One session a day: the first run of the task's local day opens a topic, and every later run
   * that day — including a catch-up whose PLANNED time was before midnight — joins it. The topic is
   * recorded with the task (`daySession`), so a restart in the middle of the day does not open a
   * second one; a topic deleted meanwhile is reopened on the next run.
   *
   * There is deliberately no throwaway fallback here. A conversation the person cannot reply into
   * would hide the output instead of delivering it, so a platform that cannot open a topic — or a
   * create that fails — makes the run fail, and the chat is told why.
   */
  private async runDaily(
    task: ScheduleTask,
    run: Extract<ScheduleTask['run'], { kind: 'agent' }>,
    platform: PlatformAdapter,
    planned: number
  ): Promise<ScheduleRunResult> {
    const day = formatDay(planned, task.when.tz);
    const stored = this.store.get(task.id)?.daySession;
    // Ask the platform whether the topic is still there when it can answer; one that cannot is
    // assumed to have kept it, which is the only honest guess a chat app allows.
    const reuse = stored?.day === day && (platform.hasThread?.(stored.address) ?? true) ? stored : undefined;

    let key: string;
    let address: ConversationAddress;
    if (reuse) {
      key = reuse.conversation;
      address = reuse.address;
      const bound = this.registry.boundAgentOf(key);
      if (bound !== undefined && bound !== run.agent) {
        // The day's topic was given another agent on purpose; a schedule must not undo that.
        const why = `this topic is now answered by ${bound}, not ${run.agent}`;
        await platform.sendMessage(targetAddress(task), `⏰ \`#${task.id}\` **${task.name}** skipped — ${why}.`).catch((e) => warn('skip notice', e));
        return { status: 'failed', error: why };
      }
    } else {
      let opened: { key: string; address: ConversationAddress };
      try {
        opened = await this.registry.openScheduledConversation({
          platform: task.target.platform,
          address: targetAddress(task),
          agentId: run.agent,
          title: `⏰ ${task.name} · ${day}`,
          ...optional('cwd', run.cwd),
          ephemeralKey: `schedule#${task.id}#${planned}`,
          mustOpen: true,
        });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        await platform
          .sendMessage(
            targetAddress(task),
            `⏰ \`#${task.id}\` **${task.name}** failed — could not open a topic for today's session: ${why}`
          )
          .catch((err) => warn('failure notice', err));
        return { status: 'failed', error: why };
      }
      key = opened.key;
      address = opened.address;
      this.rememberDay(task.id, { day, conversation: key, address });
    }

    if (run.model) {
      // A daily topic applies its model on the day's first run; a `/model` typed there since is
      // the person's choice and the conversation's override wins (applyScheduledModel).
      const why = await this.registry.applyScheduledModel(key, task.target.platform, run.agent, run.model);
      if (why) {
        await platform
          .sendMessage(address, `⏰ \`#${task.id}\` **${task.name}** failed — ${why}.`)
          .catch((e) => warn('model failure notice', e));
        return { status: 'failed', error: why };
      }
    }
    await platform.sendMessage(address, runNoticeText(task, planned)).catch((e) => warn('run notice', e));
    return toResult(
      await this.registry.runScheduledPrompt({ key, platform: task.target.platform, address, agentId: run.agent, prompt: run.prompt })
    );
  }

  /** Record which topic today's daily runs join — before the turn, so a crash mid-run keeps it. */
  private rememberDay(id: string, day: ScheduleDaySession): void {
    const current = this.store.get(id);
    // Removed while the topic was being opened: nothing to remember, and putting it back would
    // resurrect a task the user just deleted.
    if (current) this.store.put({ ...current, daySession: day });
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  /** Post the task's card where the change was asked for — the daemon's word, not the agent's. */
  card(conversation: ConversationId, task: ScheduleTask, verb: string): void {
    const lane = this.registry.laneFor(conversation);
    if (!lane) return;
    this.post(lane.platformId, lane.address, taskCardText(task, verb, this.clock.now()), `${verb} card`);
  }

  private post(platformId: string, address: ConversationAddress, text: string, what: string): void {
    void this.platforms
      .get(platformId)
      ?.sendMessage(address, text)
      .catch((e) => warn(what, e));
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString('hex');
      if (!this.scheduler.get(id)) return id;
    }
  }
}

function targetAddress(task: ScheduleTask): ConversationAddress {
  return task.target.thread ? { channel: task.target.channel, thread: task.target.thread } : { channel: task.target.channel };
}

function toResult(r: SoloOutcome | { refused: string }): ScheduleRunResult {
  return typeof r === 'string' ? { status: r } : { status: 'failed', error: r.refused };
}

/** `{ [key]: value }` when value is defined, else `{}` — for optional fields under strict types. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function warn(what: string, e: unknown): void {
  console.warn(`[schedule] failed to post the ${what}:`, e instanceof Error ? e.message : e);
}
