import { encode } from '@toon-format/toon';
import type { Config } from '../config/schema.js';
import { addressOf, formatAddress, parseTarget, type ConversationAddress } from '../core/conversation.js';
import { localeOf } from '../core/i18n/index.js';
import { tMenus } from '../core/i18n/menus.js';
import type { ExternalAction, SessionsCommand } from '../ipc/external-tools.js';
import type { IpcAction, TaskAgentDetail, TaskAgentsResult, TaskListResult } from '../ipc/protocol.js';
import { libraryLine } from '../ipc/tools.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, InboundMessage } from '../types.js';
import { formatLaneTitle } from '../core/lane-title.js';
import type { Delegation, TopicAt } from './delegation.js';
import type { ExternalCaller } from './external-mcp.js';
import type { ExternalTopic, ExternalTopics } from './external-topics.js';
import type { LibraryAsker, SkillLibrary } from './skill-library.js';

/**
 * What an external caller's tool calls do (daemon/external-mcp.ts is the door, this is the room):
 * the skill library read on its behalf, its coordination topics opened and listed, and every task
 * command routed to the topic it acts from — after checking that topic is one it opened.
 *
 * ── Ownership is the boundary ───────────────────────────────────────────────────────────────────
 * A caller acts only from a coordination topic of its own (`external-topics.json`), and a sub-task
 * it names is reached only through that sub-task's parent — the platform's own record of which topic
 * opened which — so it can neither see nor stop anything under a topic a person or another caller
 * opened. A topic it did not open and a topic that does not exist get the same refusal, so a caller
 * cannot probe for the others.
 *
 * ── A topic with no agent ───────────────────────────────────────────────────────────────────────
 * A coordination topic is where the cards go and where the person taps Start; nothing in it runs a
 * turn. A message the person types there would otherwise bind the default agent and start one, so
 * `intercept` answers it instead — and `/stop` there stops every sub-task under it, as it would in
 * any topic that opened sub-agents.
 */

/** How the skill library sees an external caller: on no host and in no harness of the gateway's. */
const EXTERNAL_PLACE = 'external';

/**
 * The most coordination topics one caller may hold at once. The web UI makes room for a new topic
 * by evicting the least recently active one that is not starred (webui/topics.ts MAX_TOPICS), so a
 * caller opening topics in a loop — an injected instruction can ask for exactly that — would push
 * the person's own topics out. A caller needs one per job, and reuses it.
 */
export const MAX_TOPICS_PER_CALLER = 10;

export interface ExternalCallsDeps {
  config: Config;
  platforms: Map<string, PlatformAdapter>;
  topics: ExternalTopics;
  conversationAt(platform: string, address: ConversationAddress): { key: ConversationId; agent?: string } | undefined;
  delegation: Pick<Delegation, 'handleExternal' | 'externalAgents' | 'externalAgent' | 'stopOpened'>;
  skills: Pick<SkillLibrary, 'search' | 'show' | 'categories'>;
  /** Read-only conversation library queries (`sessions list/search/read`). */
  sessions?(action: SessionsCommand): unknown;
  /** Reverse-command dispatch for `trusted: true` callers (`skills` writes, `schedule`, `send_file`, `messages`, `gateway`). */
  reverse?(
    action: IpcAction,
    target: { conversationId?: ConversationId; platformId: string; address: ConversationAddress }
  ): Promise<unknown>;
  /** A reverse command's result as the CLI prints it (commands/reverse.ts renderResult, injected). */
  render(action: IpcAction, data: unknown): string;
  now(): number;
}

export class ExternalCalls {
  constructor(private readonly deps: ExternalCallsDeps) {}

  /** One call, answered with the text the model reads. Throws a message for the model. */
  async call(caller: ExternalCaller, action: ExternalAction): Promise<string> {
    switch (action.kind) {
      case 'skills': {
        if (action.action.action === 'search' || action.action.action === 'show') {
          return this.deps.render(action.action, this.readSkills(caller, action.action));
        }
        if (!caller.trusted) throw new Error('skills: only search and show are offered here');
        return this.runReverse(caller, action.action, undefined);
      }
      case 'sessions': {
        if (!this.deps.sessions) throw new Error('the conversation history is not enabled in this daemon');
        return this.deps.render(action.action, this.deps.sessions(action.action));
      }
      case 'reverse': {
        if (!caller.trusted) throw new Error(`${action.action.kind}: requires a trusted caller`);
        return this.runReverse(caller, action.action, action.topic);
      }
      case 'open':
        return this.open(caller, action.title);
      case 'topics':
        return this.topicsOf(caller);
      case 'task': {
        return this.callTask(caller, action);
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown external action ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * What the library holds that reaches a caller, for the end of the `skills` description — the
   * line that tells a model the library is worth a search (ipc/tools.ts libraryLine).
   */
  libraryLine(): string {
    try {
      return libraryLine(this.deps.skills.categories({ host: EXTERNAL_PLACE, harness: EXTERNAL_PLACE }));
    } catch (e) {
      console.warn('[external-mcp] could not read the skill library:', e instanceof Error ? e.message : e);
      return '';
    }
  }

  /**
   * `skills search` / `show` for a caller. The library is asked as from no host and no harness, so a
   * skill limited to some (`fleetherd-hosts`, `fleetherd-harnesses`) does not reach it, and as an
   * external caller, so a hit carries no path on a machine it cannot read and no note about a skill
   * list it does not have. No conversation, so `show` always answers whole: one caller has many
   * conversations of its own, and the gateway cannot tell which one already read a skill. The search
   * is logged like any other, under `external:<caller>`, so a miss shows up where the Reviews page
   * counts them.
   */
  private readSkills(caller: ExternalCaller, a: Extract<IpcAction, { kind: 'skills' }>): unknown {
    const asker: LibraryAsker = { agent: `external:${caller.name}`, host: EXTERNAL_PLACE, harness: EXTERNAL_PLACE, external: true };
    if (a.action === 'search') return this.deps.skills.search(a.query ?? '', asker);
    if (a.action === 'show') {
      if (!a.name) throw new Error('skills show needs a <name>');
      return this.deps.skills.show(a.name, a.file, asker, true);
    }
    // ipc/external-tools.ts builds nothing else; a third lock costs one line.
    throw new Error('skills: only search and show are offered here');
  }

  /** The web UI instance coordination topics open on. */
  private platform(): { id: string; adapter: PlatformAdapter } {
    const id =
      this.deps.config.mcp?.platform ?? Object.entries(this.deps.config.platforms).find(([, p]) => p.type === 'webui')?.[0];
    const adapter = id ? this.deps.platforms.get(id) : undefined;
    if (!id || !adapter) throw new Error('the web UI this gateway would open your topic in is not running');
    if (!adapter.capabilities.thread || !adapter.topics) {
      throw new Error(`platform instance "${id}" cannot hold topics nested under one another`);
    }
    return { id, adapter };
  }

  private async callTask(caller: ExternalCaller, action: Extract<ExternalAction, { kind: 'task' }>): Promise<string> {
    if (action.action.kind === 'task-agents') {
      const id = action.action.agent;
      return id ? agentDetailText(await this.deps.delegation.externalAgent(id)) : agentsText(this.deps.delegation.externalAgents());
    }
    const place = action.in !== undefined ? this.owned(caller, action.in) : this.parentOwned(caller, subTopicOf(action.action));
    const opts =
      place.hosted || caller.trusted
        ? { ...(place.hosted ? { hosted: true } : {}), ...(caller.trusted ? { trusted: true } : {}) }
        : undefined;
    const result = await this.deps.delegation.handleExternal(place.key, action.action, place.at, opts);
    if (action.action.kind === 'task-list' && (result as TaskListResult).tasks.length === 0) {
      const total = (result as TaskListResult).total;
      return encode({
        count: 0,
        note:
          total > 0
            ? `${total} sub-task${total === 1 ? '' : 's'} in this topic; raise limit to list ${total === 1 ? 'it' : 'them'}`
            : 'this topic has no sub-tasks yet; propose one with action new',
      });
    }
    return this.deps.render(action.action, result);
  }

  private defaultPlatformId(): string {
    const id =
      this.deps.config.mcp?.platform ??
      Object.entries(this.deps.config.platforms).find(([, p]) => p.type === 'webui')?.[0] ??
      Object.keys(this.deps.config.platforms)[0];
    if (!id) throw new Error('no platform instance is configured in this daemon');
    return id;
  }

  private resolveTopicForReverse(
    caller: ExternalCaller,
    topic: string
  ): { key?: ConversationId; platformId: string; address: ConversationAddress } {
    try {
      const own = this.owned(caller, topic);
      return { key: own.key, platformId: own.at.platform, address: own.at.address };
    } catch {
      const instances = new Set(Object.keys(this.deps.config.platforms));
      const parsed = parseTarget(topic, instances);
      const platformId = parsed.platform ?? this.defaultPlatformId();
      const key = this.deps.conversationAt(platformId, parsed.address)?.key;
      return { key, platformId, address: parsed.address };
    }
  }

  private async runReverse(caller: ExternalCaller, action: IpcAction, topic: string | undefined): Promise<string> {
    if (!this.deps.reverse) throw new Error('reverse commands are not enabled for external callers in this daemon');
    const instances = new Set(Object.keys(this.deps.config.platforms));
    const topicTarget = topic ? this.resolveTopicForReverse(caller, topic) : undefined;
    const rawChannel = 'channelId' in action && typeof action.channelId === 'string' && action.channelId !== '' ? action.channelId : undefined;
    let platformId: string;
    let address: ConversationAddress;
    let conversationId = topicTarget?.key;
    if (rawChannel) {
      const parsed = parseTarget(rawChannel, instances);
      platformId = parsed.platform ?? topicTarget?.platformId ?? this.defaultPlatformId();
      address = parsed.address;
      conversationId ??= this.deps.conversationAt(platformId, address)?.key;
    } else if (topicTarget) {
      platformId = topicTarget.platformId;
      address = topicTarget.address;
    } else {
      platformId = this.defaultPlatformId();
      address = { channel: '' };
    }
    const data = await this.deps.reverse(action, { conversationId, platformId, address });
    return this.deps.render(action, data);
  }

  /**
   * `tasks open`: a top-level topic in the web UI, named `[<caller>] <title>`, recorded as this
   * caller's. Its first message says whose it is and that nothing typed there reaches an agent —
   * the person meets it in their topic list without having opened it.
   */
  private async open(caller: ExternalCaller, title: string | undefined): Promise<string> {
    const { id, adapter } = this.platform();
    const held = this.deps.topics.of(caller.name).filter((t) => this.present(t)).length;
    if (held >= MAX_TOPICS_PER_CALLER) {
      throw new Error(
        `you already have ${held} topics here, the most a caller may hold; propose in one of them (list shows them), or ask the person to delete one`
      );
    }
    const name = formatLaneTitle(caller.name, title?.trim() || 'tasks');
    // The web UI has one channel and ignores the address a topic is opened from; the answer's is the one.
    const address = (await adapter.createThread({ address: { channel: '' }, messageId: '' }, name)).address;
    if (!address.thread) throw new Error(`platform instance "${id}" opened no topic`);
    const key = this.deps.conversationAt(id, address)?.key;
    if (!key) throw new Error("this deployment's session scope gives a topic no conversation of its own");
    this.deps.topics.add({ caller: caller.name, platform: id, address, title: name, openedAt: new Date(this.deps.now()).toISOString() });
    const locale = localeOf(this.deps.config);
    void adapter
      .sendMessage(
        address,
        tMenus(locale, 'ext_topic_intro', { caller: caller.name })
      )
      .catch((e) => console.warn('[external-mcp] could not introduce a topic:', e instanceof Error ? e.message : e));
    console.log(`[external-mcp] ${caller.name} opened ${key} ("${name}")`);
    const topic = `${id}:${formatAddress(address)}`;
    return encode({
      topic,
      title: name,
      help: `Propose sub-tasks with action new and topic ${topic}; list with that topic shows them.`,
    });
  }

  /** `tasks list` without a topic: the caller's coordination topics that are still there. */
  private async topicsOf(caller: ExternalCaller): Promise<string> {
    const rows: Array<Record<string, unknown>> = [];
    for (const t of this.deps.topics.of(caller.name)) {
      if (!this.present(t)) continue;
      // The record is keyed by the topic, not the conversation id, which moves with the scope.
      const key = this.deps.conversationAt(t.platform, t.address)?.key;
      if (!key) continue;
      const list = (await this.deps.delegation.handleExternal(
        key,
        { kind: 'task-list', limit: 200 },
        { platform: t.platform, address: t.address }
      )) as TaskListResult;
      const busy = list.tasks.filter((r) => r.stage === 'working' || r.stage === 'retrying').length;
      rows.push({ topic: `${t.platform}:${formatAddress(t.address)}`, title: t.title, opened: t.openedAt, subtasks: list.total, working: busy });
    }
    if (rows.length === 0) return encode({ count: 0, note: 'you have no topics here; open one first' });
    return encode({ topics: rows, help: 'list with a topic shows its sub-tasks.' });
  }

  /** Whether a recorded topic is still on its platform; a deleted one is forgotten. */
  private present(t: ExternalTopic): boolean {
    const adapter = this.deps.platforms.get(t.platform);
    if (adapter?.topics?.hasThread(t.address) !== false) return adapter !== undefined;
    this.deps.topics.remove(t.platform, t.address);
    console.log(`[external-mcp] forgot ${t.key}: the topic was deleted`);
    return false;
  }

  /**
   * The topic named `topic` that this caller may act from, or the refusal: either a coordination
   * topic it opened itself (`external-topics.json`), or a live topic bound to an agent listed in
   * `caller.agents` (a hosted web agent calling back into its own conversation).
   */
  private owned(caller: ExternalCaller, topic: string): { key: ConversationId; at: TopicAt; hosted: boolean } {
    const { id, adapter } = this.platform();
    const address = this.addressOf(caller, topic, id);
    if (!address) throw notYours(topic);
    const conv = this.deps.conversationAt(id, address);
    const key = conv?.key;
    const t = this.deps.topics.get(id, address);
    if (key && t && t.caller === caller.name && t.platform === id && this.present(t)) {
      return { key, at: { platform: id, address }, hosted: false };
    }
    if (key && conv?.agent && caller.agents?.length && adapter.topics?.hasThread(address) !== false && matchesCallerAgent(conv.agent, caller.agents)) {
      return { key, at: { platform: id, address }, hosted: true };
    }
    throw notYours(topic);
  }

  /** The caller's coordination topic a sub-task `topic` is nested under, or the refusal. */
  private parentOwned(caller: ExternalCaller, topic: string): { key: ConversationId; at: TopicAt; hosted: boolean } {
    const { id, adapter } = this.platform();
    const address = this.addressOf(caller, topic, id);
    const parent = address ? adapter.topics?.parentOf(address) : undefined;
    if (!parent) throw notYours(topic);
    try {
      return this.owned(caller, `${id}:${formatAddress(parent)}`);
    } catch {
      throw notYours(topic);
    }
  }

  /**
   * A topic as the caller wrote it: `web:main/3a9f0c12` (what open and list print), or the bare
   * eight-character id — on the channel of the caller's own topics, the only one it could mean.
   */
  private addressOf(caller: ExternalCaller, topic: string, platform: string): ConversationAddress | undefined {
    if (/^[0-9a-f]{8}$/.test(topic)) {
      const channel = this.deps.topics.of(caller.name)[0]?.address.channel;
      return channel !== undefined ? { channel, thread: topic } : undefined;
    }
    try {
      const target = parseTarget(topic, new Set(Object.keys(this.deps.config.platforms)));
      return (target.platform ?? platform) === platform ? target.address : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A message the person wrote in a coordination topic: answered here, never routed to an agent.
   * True when it was one; false hands the message on to routing as usual.
   */
  intercept(msg: InboundMessage): boolean {
    const platform = msg.conversation.platform;
    const address = addressOf(msg.conversation);
    // By the topic's own id: the conversation id moves with the session scope, and this answer
    // must not stop working when `/reload` changes it.
    const t = this.deps.topics.get(platform, address);
    if (!t || t.platform !== platform) return false;
    const key = this.deps.conversationAt(platform, address)?.key;
    const adapter = this.deps.platforms.get(t.platform);
    let say: string;
    if (/^\/stop(\s|$)/i.test(msg.content.trim())) {
      const n = key ? this.deps.delegation.stopOpened(key, new Set(), { platform, address }) : 0;
      say = n ? `⏹ Stopped ${n} sub-agent${n === 1 ? '' : 's'} under this topic.` : 'Nothing under this topic was running.';
    } else {
      say =
        `This topic is **${t.caller}**'s, a caller outside this gateway, and has no agent: nothing typed here reaches ` +
        `one. Tap Start or Cancel on its cards; write in a sub-task's own topic to talk to that agent; \`/stop\` stops ` +
        `every sub-task under this one.`;
    }
    void adapter
      ?.sendMessage(address, say)
      .catch((e) => console.warn('[external-mcp] could not answer in a coordination topic:', e instanceof Error ? e.message : e));
    return true;
  }
}

/**
 * `tasks agents` for a caller. Not the CLI's printer: its help line is about `task-new --agent` and
 * "this conversation's agent", neither of which a caller has, and `here` is false on every row —
 * the caller runs on no machine of the gateway's.
 */
function agentsText(result: TaskAgentsResult): string {
  if (result.agents.length === 0) return encode({ count: 0, note: 'no agents are configured' });
  return encode({
    agents: result.agents.map(({ here: _here, ...a }) => ({ ...a, dirs: a.dirs.join(', ') })),
    help: ['new with agent <id> proposes a sub-task to it; cwd is its root or one of its dirs, or an absolute path on its machine.'],
  });
}

function agentDetailText(d: TaskAgentDetail): string {
  const { here: _here, ...agent } = d.agent;
  return encode({
    agent: { ...agent, dirs: agent.dirs.join(', ') },
    models: d.models,
    settings: d.settings,
    ...(d.error !== undefined ? { error: d.error } : {}),
    help: [
      'new with this agent, model (a value from models) and option (id=value from settings, comma-separated) proposes a sub-task on them; default marks what it uses without them. note is the agent\'s own word on a value (an account\'s quota, say).',
      'running: turns in progress on it now. cooling: it hit a usage limit and is waiting it out. permissions plan, ask or edits: it may stop to ask the person.',
    ],
  });
}

/** The sub-task topic a status, read or stop names. */
function subTopicOf(a: Exclude<IpcAction, { kind: 'task-agents' }>): string {
  if ('topic' in a && typeof a.topic === 'string') return a.topic;
  throw new Error(`${a.kind} names a topic, and this one named none`);
}

function notYours(topic: string): Error {
  return new Error(`"${topic}" is not a topic you opened, or a sub-task under one; list without a topic shows yours`);
}

/** Exact match or pod-qualified `<name>@<host>` match against `caller.agents`. */
function matchesCallerAgent(bound: string, allowed: readonly string[]): boolean {
  return allowed.some((name) => bound === name || bound.startsWith(`${name}@`));
}
