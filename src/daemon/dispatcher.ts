import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { parseTarget, type ConversationAddress } from '../core/conversation.js';
import { needsPerson, topicStage } from '../core/topic-stage.js';
import type { IpcAction, TaskActionResult, TaskAgentsResult, TaskListResult, TaskReadResult, TaskRow } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, TopicStage } from '../types.js';
import type { ConversationRegistry } from './conversation.js';
import { dispatcherConversations } from './dispatcher-home.js';

/**
 * The dispatcher: one conversation (the 📥 topic) whose agent hands work to other conversations
 * instead of doing it, and is told when one of them needs the person.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────────────────────────
 * One person watching their agents is the ceiling on how many they can run: on this deployment's own
 * month (2026-10-03 – 11-02), the conversations written to per active hour were 2 at the median and
 * 4 at p90, and with five or more open the person's reply to the one waiting took twice as long
 * (project-reports/talkcode-借鉴-super-agent-20261102.md). DeepSeek's Super-agent prototype names the
 * same limit and answers it with a router session over worker sessions; this is that shape on what
 * talkcode already has — a topic per piece of work, each its own conversation — with the router
 * added as one more conversation, and the person still free to walk into any topic and talk there.
 *
 * ── What is structure and what is instruction ────────────────────────────────────────────────────
 * Structure, enforced here: only the dispatcher's conversation can run the task commands; on claude
 * it has no built-in tools at all (agent-acp.ts DISPATCHER_SESSION_META), so it cannot do the work
 * itself; what reaches a worker is the person's text, verbatim, shown in that topic as coming from
 * the dispatcher; and what reaches the dispatcher about the others is decided from facts
 * (core/topic-stage.ts), not from anyone's reading of a reply. Instruction, in a file the operator
 * owns (dispatcher-home.ts): how to choose an agent, when a message belongs to existing work, how to
 * word an update.
 *
 * ── The one exception to "nothing of the gateway's in the prompt" ───────────────────────────────
 * The `[topic updates]` card. It is the dispatcher's input — what happened in conversations it is not
 * in — and no harness mechanism can carry another conversation's state into a session. It goes to the
 * dispatcher's conversation only, never to a worker, and is shown there (folded) before it is sent,
 * so the person sees exactly what the dispatcher was told.
 */

/** How long topic updates are gathered before the dispatcher is told: a burst is one card. */
export const CARD_DELAY_MS = 5_000;

/** How much of a finished reply a card carries. Super-agent's worker reports stop at 600 too. */
export const CARD_EXCERPT_CHARS = 600;

/** How much of each message `task-read` returns. */
const READ_CHARS = 1_500;

type Registry = Pick<
  ConversationRegistry,
  | 'bindDispatcher'
  | 'openTask'
  | 'handTo'
  | 'isBusy'
  | 'isAsking'
  | 'workdirChoices'
  | 'listChannels'
  | 'conversationAt'
  | 'laneFor'
  | 'activityOf'
  | 'replyExcerptOf'
  | 'stopConversation'
  | 'runScheduledPrompt'
  | 'resetConversation'
  | 'workdirOf'
  | 'boundAgentOf'
>;

export interface DispatcherDeps {
  config: Config;
  platforms: Map<string, PlatformAdapter>;
  registry: Registry;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /** The question waiting on the person in a conversation, when there is one (the daemon's asks). */
  questionOf?(id: ConversationId): string | undefined;
}

/** Where one dispatcher conversation lives. */
interface Lane {
  platformId: string;
  address: ConversationAddress;
}

type TaskAction = Extract<IpcAction, { kind: `task-${string}` }>;

export class Dispatcher {
  /** Each dispatcher conversation (one per platform instance that can hold one) → where it lives. */
  private readonly lanes = new Map<ConversationId, Lane>();
  /** Conversations with an update for the dispatcher, gathered for CARD_DELAY_MS. */
  private readonly pending = new Set<ConversationId>();
  private cancelCard: (() => void) | undefined;

  constructor(private readonly deps: DispatcherDeps) {}

  /** Whether a conversation is a dispatcher's. */
  isDispatcher(id: ConversationId): boolean {
    return this.lanes.has(id);
  }

  /** Whether a dispatcher is configured and has somewhere to live. */
  get active(): boolean {
    return this.lanes.size > 0;
  }

  /**
   * Read `dispatcher:` and make the platforms agree with it: open (or keep) the 📥 topic and bind it
   * to `dispatcher.agent` where there is one, retire it where there is not. Run at start, after the
   * platforms are up, and after every `/reload` — idempotent, so the second run of an unchanged
   * config changes nothing.
   *
   * A conversation that stops being a dispatcher's is started over (`/new`): its session was created
   * without tools, and as an ordinary conversation it would keep that session and stay toolless.
   */
  configure(): void {
    const agentId = this.deps.config.dispatcher?.agent;
    const before = new Set(this.lanes.keys());
    this.lanes.clear();
    dispatcherConversations.clear();
    for (const [platformId, adapter] of this.deps.platforms) {
      if (!adapter.dispatchLane) continue;
      let address: ConversationAddress | undefined;
      try {
        address = adapter.dispatchLane(agentId !== undefined);
      } catch (e) {
        console.warn(`[dispatcher] "${platformId}" could not ${agentId ? 'open' : 'retire'} its dispatcher topic:`, e instanceof Error ? e.message : e);
        continue;
      }
      if (!agentId || !address) continue;
      const conv = this.deps.registry.conversationAt(platformId, address);
      if (!conv) {
        console.warn(`[dispatcher] "${platformId}": the dispatcher topic maps to no conversation of its own under this scope`);
        continue;
      }
      this.lanes.set(conv.key, { platformId, address });
      dispatcherConversations.add(conv.key);
      this.deps.registry.bindDispatcher(conv.key, platformId, agentId);
    }
    for (const key of before) {
      if (!this.lanes.has(key)) {
        this.deps.registry.resetConversation(key);
        console.log(`[dispatcher] ${key} is no longer the dispatcher topic; started over as an ordinary conversation`);
      }
    }
    if (agentId && this.lanes.size === 0) {
      console.warn(`[dispatcher] dispatcher.agent is "${agentId}", but no platform here can hold a dispatcher topic (the web UI can)`);
    }
  }

  /** Shutdown. */
  dispose(): void {
    this.cancelCard?.();
    this.cancelCard = undefined;
    this.pending.clear();
  }

  // ── The task commands ─────────────────────────────────────────────────────────────────────────

  /**
   * One task command from conversation `from`. Refused to anyone but a dispatcher: the commands open
   * conversations and put words in front of other agents, which is the dispatcher's job and nobody
   * else's (a worker that could do it would be a second dispatcher nobody configured).
   */
  async handle(from: ConversationId | undefined, action: TaskAction): Promise<unknown> {
    const lane = from ? this.lanes.get(from) : undefined;
    if (!from || !lane) {
      throw new Error(
        `${action.kind} is the dispatcher's command, and runs only in its topic${this.active ? '' : ' (no dispatcher is configured: `dispatcher.agent` in config.yaml)'}`
      );
    }
    switch (action.kind) {
      case 'task-agents':
        return this.agents();
      case 'task-list':
        return this.list(from, action.limit ?? 30);
      case 'task-new':
        return this.open(lane, action);
      case 'task-send':
        return this.send(lane, action.topic, action.text);
      case 'task-read':
        return this.read(lane, action.topic, action.limit ?? 10);
      case 'task-stop':
        return this.stop(lane, action.topic);
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown task command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private agents(): TaskAgentsResult {
    return {
      agents: this.deps.config.agents.map((def) => {
        const choices = this.deps.registry.workdirChoices(def.id);
        return {
          id: def.id,
          harness: def.harness,
          where: def.group ?? def.host ?? 'this machine',
          model: def.model ?? '',
          root: choices?.root ?? '',
          // Names, not paths: task-new takes a name inside the root, and two dozen of them is plenty.
          dirs: (choices?.dirs ?? []).slice(0, 24).map((d) => d.split('/').pop() ?? d),
        };
      }),
    };
  }

  /**
   * Every conversation the gateway has answered in, the ones needing the person first, then by how
   * recently anything happened. The dispatcher's own topic is not on it.
   */
  private list(from: ConversationId, limit: number): TaskListResult {
    const listed = this.deps.registry.listChannels({ limit: 200, currentKey: from });
    const rows: TaskRow[] = [];
    for (const ch of listed.channels) {
      if (ch.kind !== 'topic' || ch.current) continue;
      const place = this.place(ch.id);
      if (!place) continue;
      const conv = this.deps.registry.conversationAt(place.platformId, place.address);
      if (!conv || this.isDispatcher(conv.key)) continue;
      rows.push(this.row(conv.key, place, { title: ch.title, agent: ch.agent, lastAt: ch.lastAt }));
    }
    const rank = (s: string): number => (needsPerson(s as TopicStage) ? 0 : 1);
    rows.sort((a, b) => rank(a.stage) - rank(b.stage) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    return { tasks: rows.slice(0, limit), total: rows.length };
  }

  private async open(lane: Lane, a: Extract<TaskAction, { kind: 'task-new' }>): Promise<{ task: TaskRow }> {
    const { key, address } = await this.deps.registry.openTask({
      platform: lane.platformId,
      root: { channel: lane.address.channel },
      agentId: a.agent,
      text: a.text,
      ...(a.cwd ? { cwd: a.cwd } : {}),
      ...(a.title ? { title: a.title } : {}),
    });
    console.log(`[dispatcher] opened ${key} for "${a.agent}"`);
    return { task: this.row(key, { platformId: lane.platformId, address }, { title: a.title ?? '', agent: a.agent }) };
  }

  private async send(lane: Lane, topic: string, text: string): Promise<TaskActionResult> {
    const t = this.resolve(lane, topic);
    const how = await this.deps.registry.handTo(t.key, t.platformId, t.address, text);
    return {
      topic,
      result:
        how === 'joined'
          ? 'Handed to its agent, which was already working: it takes it into the turn it is running.'
          : 'Handed to its agent, which is starting on it now.',
    };
  }

  private async read(lane: Lane, topic: string, limit: number): Promise<TaskReadResult> {
    const t = this.resolve(lane, topic);
    const adapter = this.deps.platforms.get(t.platformId);
    if (!adapter) throw new Error(`platform instance "${t.platformId}" is not running`);
    const messages = await adapter.fetchHistory(t.address, { limit });
    return {
      topic,
      messages: messages.map((m) => ({
        from: m.authorIsBot ? ('agent' as const) : ('person' as const),
        at: new Date(m.timestamp).toISOString(),
        text: m.content.length > READ_CHARS ? `${m.content.slice(0, READ_CHARS - 1)}…` : m.content,
      })),
    };
  }

  private stop(lane: Lane, topic: string): TaskActionResult {
    const t = this.resolve(lane, topic);
    const outcome = this.deps.registry.stopConversation(t.key);
    if (outcome !== 'idle') {
      void this.deps.platforms
        .get(t.platformId)
        ?.sendMessage(t.address, '⏹ Stopped by the dispatcher.')
        .catch((e) => console.warn('[dispatcher] could not mark a stop:', e instanceof Error ? e.message : e));
    }
    return {
      topic,
      result: outcome === 'idle' ? 'Nothing was running there.' : 'Stopped. Its context is kept; a message there carries on from it.',
    };
  }

  /**
   * A conversation named the way the dispatcher names one: the id task-list and task-new print
   * (`web:main/3a9f0c12`), the same without its platform (this dispatcher's), or — on the web UI —
   * the bare topic id.
   */
  private resolve(lane: Lane, topic: string): { key: ConversationId; platformId: string; address: ConversationAddress } {
    const instances = new Set(Object.keys(this.deps.config.platforms));
    let place: Lane | undefined;
    if (/^[0-9a-f]{8}$/.test(topic) && this.deps.config.platforms[lane.platformId]?.type === 'webui') {
      place = { platformId: lane.platformId, address: { channel: lane.address.channel, thread: topic } };
    } else {
      try {
        const target = parseTarget(topic, instances);
        place = { platformId: target.platform ?? lane.platformId, address: target.address };
      } catch {
        place = undefined;
      }
    }
    const conv = place ? this.deps.registry.conversationAt(place.platformId, place.address) : undefined;
    if (!place || !conv) throw new Error(`no conversation "${topic}"; task_list gives the ids`);
    if (this.isDispatcher(conv.key)) throw new Error('that is the dispatcher topic itself');
    if (!conv.agent) throw new Error(`nothing has happened in "${topic}" yet; hand it work with task_new`);
    return { key: conv.key, ...place };
  }

  /** A channel-list id back into a place, or undefined for one this deployment no longer has. */
  private place(id: string): Lane | undefined {
    try {
      const t = parseTarget(id, new Set(Object.keys(this.deps.config.platforms)));
      return t.platform ? { platformId: t.platform, address: t.address } : undefined;
    } catch {
      return undefined;
    }
  }

  /** One conversation as the dispatcher sees it. */
  private row(key: ConversationId, place: Lane, known: { title: string; agent: string; lastAt?: string }): TaskRow {
    const stage = this.stageOf(key, place);
    const activity = this.deps.registry.activityOf(key);
    const line =
      stage === 'answer'
        ? (this.deps.questionOf?.(key) ?? 'a question is waiting')
        : (activity?.outcome?.line ?? '');
    const link = this.linkOf(place);
    return {
      topic: `${place.platformId}:${place.address.channel}${place.address.thread ? `/${place.address.thread}` : ''}`,
      title: known.title,
      agent: known.agent || this.deps.registry.boundAgentOf(key) || '',
      cwd: shortenHome(this.deps.registry.workdirOf(key) ?? ''),
      stage,
      line,
      lastAt: known.lastAt ?? '',
      ...(link ? { link } : {}),
    };
  }

  private stageOf(key: ConversationId, place: Lane): TopicStage {
    return topicStage({
      running: this.deps.registry.isBusy(key),
      asking: this.deps.registry.isAsking(key),
      activity: this.deps.registry.activityOf(key),
      seenAt: this.deps.platforms.get(place.platformId)?.seenAt?.(place.address),
    });
  }

  /**
   * A link that opens the conversation, where the platform has one: the web UI's `?t=<topic>`, which
   * its page switches to in place (platform/web-markdown.ts keeps exactly that relative link).
   */
  private linkOf(place: Lane): string | undefined {
    if (this.deps.config.platforms[place.platformId]?.type !== 'webui' || !place.address.thread) return undefined;
    return `?t=${place.address.thread}`;
  }

  // ── Topic updates ─────────────────────────────────────────────────────────────────────────────

  /**
   * A conversation has something for the person (TurnOutcomes, or a question was asked). Gathered for
   * CARD_DELAY_MS, then decided again: a conversation the person has looked at in the meantime is not
   * news, and a burst of finishes is one card rather than one turn each.
   */
  needsPerson(id: ConversationId): void {
    if (!this.active || this.isDispatcher(id)) return;
    this.pending.add(id);
    this.cancelCard ??= this.deps.clock.schedule(() => this.sendCards(), CARD_DELAY_MS);
  }

  /** Tell each dispatcher about the conversations that still need the person. */
  private sendCards(): void {
    this.cancelCard = undefined;
    const ids = [...this.pending];
    this.pending.clear();
    const byDispatcher = new Map<ConversationId, string[]>();
    const told = new Map<ConversationId, string[]>();
    for (const id of ids) {
      const where = this.deps.registry.laneFor(id);
      if (!where) continue;
      const place = { platformId: where.platformId, address: where.address };
      const stage = this.stageOf(id, place);
      if (!needsPerson(stage)) continue;
      const target = this.dispatcherFor(where.platformId);
      if (!target) continue;
      const row = this.row(id, place, { title: this.titleOf(id, place), agent: '' });
      const excerpt = stage === 'review' ? this.deps.registry.replyExcerptOf(id) : undefined;
      const entry = [
        `- topic ${row.topic} · "${row.title}" · agent ${row.agent}${row.cwd ? ` in ${row.cwd}` : ''} · ${describeStage(stage)}`,
        ...(row.line ? [`  ${stage === 'answer' ? 'question' : stage === 'failed' ? 'failure' : 'first line'}: ${row.line}`] : []),
        ...(excerpt ? [`  reply: ${excerpt.replace(/\s+/g, ' ').trim()}`] : []),
        ...(row.link ? [`  link: ${row.link}`] : []),
      ].join('\n');
      byDispatcher.set(target, [...(byDispatcher.get(target) ?? []), entry]);
      told.set(target, [...(told.get(target) ?? []), `🔔 ${row.title || row.topic} — ${describeStage(stage)}${row.line ? `: ${row.line}` : ''}`]);
    }
    for (const [key, entries] of byDispatcher) this.tell(key, entries, told.get(key) ?? []);
  }

  /** One card to one dispatcher: shown folded in its topic, then put in front of it as a turn. */
  private tell(key: ConversationId, entries: string[], shown: string[]): void {
    const lane = this.lanes.get(key);
    const agentId = this.deps.config.dispatcher?.agent;
    if (!lane || !agentId || !findAgent(this.deps.config, agentId)) return;
    const card = ['[topic updates]', ...entries].join('\n');
    void this.deps.platforms
      .get(lane.platformId)
      ?.sendMessage(lane.address, shown.join('\n'), { kind: 'tools' })
      .catch((e) => console.warn('[dispatcher] could not show a topic update:', e instanceof Error ? e.message : e));
    void this.deps.registry
      .runScheduledPrompt({ key, platform: lane.platformId, address: lane.address, agentId, prompt: card })
      .then((outcome) => {
        if (typeof outcome === 'object') console.warn(`[dispatcher] topic updates not delivered: ${outcome.refused}`);
      })
      .catch((e) => console.warn('[dispatcher] topic updates failed:', e instanceof Error ? e.message : e));
    console.log(`[dispatcher] told ${key} about ${entries.length} topic(s)`);
  }

  /** The dispatcher a conversation on a platform reports to: that platform's, else any. */
  private dispatcherFor(platformId: string): ConversationId | undefined {
    for (const [key, lane] of this.lanes) if (lane.platformId === platformId) return key;
    return this.lanes.keys().next().value;
  }

  /** A conversation's name, from what `channels` knows. */
  private titleOf(id: ConversationId, place: Lane): string {
    const ch = this.deps.registry
      .listChannels({ platform: place.platformId, limit: 200 })
      .channels.find((c) => c.id === `${place.platformId}:${place.address.channel}${place.address.thread ? `/${place.address.thread}` : ''}`);
    return ch?.title ?? id;
  }
}

/** A stage in a sentence. */
function describeStage(stage: TopicStage): string {
  switch (stage) {
    case 'answer':
      return 'waiting on a question';
    case 'failed':
      return 'failed';
    case 'review':
      return 'finished, not yet read';
    case 'retrying':
      return 'failed, continuing automatically';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
    default: {
      const _exhaustive: never = stage;
      return String(_exhaustive);
    }
  }
}

/** `/home/user/workspace/x` → `~/workspace/x`, for a column that is read, not used. */
function shortenHome(p: string): string {
  return p.replace(/^\/(home\/[^/]+|root)(?=\/|$)/, '~');
}
