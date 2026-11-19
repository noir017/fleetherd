import { encode } from '@toon-format/toon';
import type { Config } from '../config/schema.js';
import { addressOf, formatAddress, parseTarget, type ConversationAddress } from '../core/conversation.js';
import type { ExternalAction } from '../ipc/external-tools.js';
import type { IpcAction, TaskAgentsResult, TaskListResult } from '../ipc/protocol.js';
import { libraryLine } from '../ipc/tools.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, InboundMessage } from '../types.js';
import { formatLaneTitle } from './conversation.js';
import type { Delegation } from './delegation.js';
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
  delegation: Pick<Delegation, 'handleExternal' | 'externalAgents' | 'stopOpened'>;
  skills: Pick<SkillLibrary, 'search' | 'show' | 'categories'>;
  /** A reverse command's result as the CLI prints it (commands/reverse.ts renderResult, injected). */
  render(action: IpcAction, data: unknown): string;
  now(): number;
}

export class ExternalCalls {
  constructor(private readonly deps: ExternalCallsDeps) {}

  /** One call, answered with the text the model reads. Throws a message for the model. */
  async call(caller: ExternalCaller, action: ExternalAction): Promise<string> {
    switch (action.kind) {
      case 'skills':
        return this.deps.render(action.action, this.readSkills(caller, action.action));
      case 'open':
        return this.open(caller, action.title);
      case 'topics':
        return this.topicsOf(caller);
      case 'task': {
        if (action.action.kind === 'task-agents') return agentsText(this.deps.delegation.externalAgents());
        const key = action.in !== undefined ? this.owned(caller, action.in) : this.parentOwned(caller, subTopicOf(action.action));
        return this.deps.render(action.action, await this.deps.delegation.handleExternal(key, action.action));
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
   * skill limited to some (`fleetherd-hosts`, `fleetherd-harnesses`) does not reach it. No
   * conversation, so `show` always answers whole: one caller has many conversations of its own, and
   * the gateway cannot tell which one already read a skill. The search is logged like any other,
   * under `external:<caller>`, so a miss shows up where the Reviews page counts them.
   */
  private readSkills(caller: ExternalCaller, a: Extract<IpcAction, { kind: 'skills' }>): unknown {
    const asker: LibraryAsker = { agent: `external:${caller.name}`, host: EXTERNAL_PLACE, harness: EXTERNAL_PLACE };
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
    if (!adapter.capabilities.thread || !adapter.parentOf || !adapter.childrenOf) {
      throw new Error(`platform instance "${id}" cannot hold topics nested under one another`);
    }
    return { id, adapter };
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
    this.deps.topics.add({ key, caller: caller.name, platform: id, address, title: name, openedAt: new Date(this.deps.now()).toISOString() });
    void adapter
      .sendMessage(
        address,
        `Opened by **${caller.name}**, outside this gateway, through its MCP entrance. The sub-tasks it proposes appear ` +
          `here as cards, and none starts until you tap Start. Nothing typed here reaches an agent; \`/stop\` stops every ` +
          `sub-task under this topic.`
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
      const list = (await this.deps.delegation.handleExternal(t.key, { kind: 'task-list', limit: 200 })) as TaskListResult;
      const busy = list.tasks.filter((r) => r.stage === 'working' || r.stage === 'retrying').length;
      rows.push({ topic: `${t.platform}:${formatAddress(t.address)}`, title: t.title, opened: t.openedAt, subtasks: list.total, working: busy });
    }
    if (rows.length === 0) return encode({ count: 0, note: 'you have no topics here; open one first' });
    return encode({ topics: rows, help: 'list with a topic shows its sub-tasks.' });
  }

  /** Whether a recorded topic is still on its platform; a deleted one is forgotten. */
  private present(t: ExternalTopic): boolean {
    const adapter = this.deps.platforms.get(t.platform);
    if (adapter?.hasThread?.(t.address) !== false) return adapter !== undefined;
    this.deps.topics.remove(t.key);
    console.log(`[external-mcp] forgot ${t.key}: the topic was deleted`);
    return false;
  }

  /** The caller's coordination topic named `topic`, or the refusal. */
  private owned(caller: ExternalCaller, topic: string): ConversationId {
    const { id } = this.platform();
    const address = this.addressOf(caller, topic, id);
    const key = address ? this.deps.conversationAt(id, address)?.key : undefined;
    const t = key ? this.deps.topics.get(key) : undefined;
    if (!key || !t || t.caller !== caller.name || t.platform !== id || !this.present(t)) throw notYours(topic);
    return key;
  }

  /** The caller's coordination topic a sub-task `topic` is nested under, or the refusal. */
  private parentOwned(caller: ExternalCaller, topic: string): ConversationId {
    const { id, adapter } = this.platform();
    const address = this.addressOf(caller, topic, id);
    const parent = address ? adapter.parentOf?.(address) : undefined;
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
    const address = addressOf(msg.conversation);
    const key = this.deps.conversationAt(msg.conversation.platform, address)?.key;
    const t = key ? this.deps.topics.get(key) : undefined;
    if (!key || !t || t.platform !== msg.conversation.platform) return false;
    const adapter = this.deps.platforms.get(t.platform);
    let say: string;
    if (/^\/stop(\s|$)/i.test(msg.content.trim())) {
      const n = this.deps.delegation.stopOpened(key);
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

/** The sub-task topic a status, read or stop names. */
function subTopicOf(a: Exclude<IpcAction, { kind: 'task-agents' }>): string {
  if ('topic' in a && typeof a.topic === 'string') return a.topic;
  throw new Error(`${a.kind} names a topic, and this one named none`);
}

function notYours(topic: string): Error {
  return new Error(`"${topic}" is not a topic you opened, or a sub-task under one; list without a topic shows yours`);
}
