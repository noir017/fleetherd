import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { formatCost, formatElapsed } from '../core/busy-snapshot.js';
import { parseTarget, type ConversationAddress } from '../core/conversation.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import type { CommandSurface } from '../core/command-translate.js';
import { LINE_MAX, topicStage } from '../core/topic-stage.js';
import type {
  IpcAction,
  TaskActionResult,
  TaskAgentsResult,
  TaskListResult,
  TaskNewResult,
  TaskReadResult,
  TaskRow,
  TaskStatusResult,
} from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentStatus, ConversationId, TopicActivity, TopicStage } from '../types.js';
import type { LiveTurn } from './turn-progress.js';
import type { ConversationRegistry } from './conversation.js';
import { UPDATE_SENDER } from './turn-runner.js';

/**
 * Sub-agents: an agent in one conversation hands parts of its job to other agents, each in a topic
 * of its own nested under it, running in parallel — once the person has confirmed them — and is told
 * when each one finishes, fails or asks something. `/super` (the bundled skill of that name) is the
 * person asking for exactly that; any agent may do it unprompted, because nothing starts without the
 * person's say-so.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────────────────────────
 * One person watching their agents is the ceiling on how many they can run: on this deployment's own
 * month (2026-10-03 – 11-02), the conversations written to per active hour were 2 at the median and
 * 4 at p90 (project-reports/talkcode-借鉴-super-agent-20261102.md). Splitting a job across agents
 * without the person in the middle of every hand-off is the part of that an agent can take over.
 * 2.18.0 tried it as a standing router topic (DeepSeek's Super-agent shape) and it was removed the
 * same day: a router earns its keep triaging a team's inbox, and one person has no inbox to triage —
 * they already know which topic a message belongs in. What one person does not have is a second pair
 * of hands that splits a job, hands the pieces out and reads what comes back. That is this.
 *
 * ── What is structure and what is instruction ────────────────────────────────────────────────────
 * Structure, enforced here: nothing starts until the person taps Start on the card that lists every
 * sub-task in full (the agent cannot start one itself, whatever it is told); a conversation acts only
 * on topics it opened; a sub-agent's topic is an ordinary topic the person can walk into; and the
 * relation is the platform's own record (`PlatformAdapter.parentOf`), so deleting a topic ends it.
 * Instruction, in the skills (`skill/`): how to split a job, which agent to prefer, what to do with
 * the updates.
 *
 * ── The exception to "nothing of the gateway's in the prompt" ───────────────────────────────────
 * The `[sub-agent updates]` card. It is how the agent that opened the topics learns what happened in
 * them, and no harness mechanism can carry another conversation's state into a session. It goes only
 * to the conversation that opened those topics, and is shown there (folded) before it is sent, so the
 * person sees exactly what the agent was told. What a sub-agent receives is the task text and nothing
 * else.
 */

/**
 * How long the first `task-new` of a burst waits for its siblings: an agent proposing three makes
 * three calls, and the card should go up once rather than three times. Only the FIRST card waits —
 * once it is on screen, a later `task-new` re-renders the same card instead of starting a second one,
 * and nothing is lost if the agent takes a minute between calls.
 */
export const PROPOSAL_GATHER_MS = 3_000;

/**
 * How long a card waits for the person. A day, not the hour a question gets: nothing is blocked on
 * it (the agent's turn has ended), and the person may well come back to it tomorrow.
 */
export const PROPOSAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** How long sub-agent updates are gathered before the agent is told: a burst is one card. */
export const CARD_DELAY_MS = 5_000;

/**
 * How much of one finished reply, question or error an update card carries, and how much it carries
 * across a burst (several sub-agents' news is one card).
 *
 * A review worth acting on is a few thousand characters, and the card exists so the parent agent
 * does not have to open the topic to get its conclusion; an excerpt that stops before the verdict
 * is worse than no card. An entry longer than its budget is cut, and the cut states its full length
 * and where the rest is read (clipCard), so a truncated review cannot pass for a short one.
 */
export const CARD_ITEM_CHARS = 4_000;
export const CARD_TOTAL_CHARS = 8_000;

/** How much of each sub-task's text the confirmation card shows. */
const PROPOSAL_TEXT_CHARS = 1_500;

/** How much of each message `task-read` returns. */
const READ_CHARS = 1_500;

/**
 * How much `task-read --full` returns per message, and in all.
 *
 * The per-message cut is what the tool bubble needs: in accumulate mode it holds a whole turn's
 * commands, and 1500 characters is the first dozen of them. The total is the guard that keeps a
 * `--full` read from becoming a second runaway turn — a hundred messages at 20k each is a quarter of
 * a context window.
 */
const READ_FULL_CHARS = 20_000;
const READ_TOTAL_CHARS = 80_000;

/**
 * Whether a platform can hold sub-agents: the relation is the platform's own record of which topic
 * opened which (`parentOf`/`childrenOf`), so one without it has nowhere to put them. The one test,
 * shared by the refusal of a task command here, the slash menu (`/super` is registered only where
 * this is true) and the refusal of a typed `/super` (ConversationRegistry.refusedForNesting).
 */
export function commandSurface(adapter: Pick<PlatformAdapter, 'parentOf' | 'childrenOf'>): CommandSurface {
  return { nested: Boolean(adapter.parentOf && adapter.childrenOf) };
}

type Registry = Pick<
  ConversationRegistry,
  | 'openTask'
  | 'handTo'
  | 'isBusy'
  | 'isAsking'
  | 'workdirChoices'
  | 'listChannels'
  | 'conversationAt'
  | 'laneFor'
  | 'activityOf'
  | 'replyTextOf'
  | 'failureTextOf'
  | 'progressOf'
  | 'runningSince'
  | 'statusOf'
  | 'stopConversation'
  | 'stopWithPending'
  | 'runScheduledPrompt'
  | 'workdirOf'
  | 'boundAgentOf'
>;

export interface DelegationDeps {
  config: Config;
  platforms: Map<string, PlatformAdapter>;
  registry: Registry;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /** The question waiting on the person in a conversation, when there is one (the daemon's asks). */
  questionOf?(id: ConversationId): string | undefined;
  /**
   * Put the card up as a question with buttons, in the conversation that proposed it, and resolve
   * with the label tapped — null when it was called off (`signal`, `/stop`, `/new`) or ran out of time.
   */
  confirm(opts: {
    adapter: PlatformAdapter;
    address: ConversationAddress;
    conversation: ConversationId;
    text: string;
    labels: string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<string | null>;
}

/** A conversation where it lives, with its platform. */
interface Place {
  key: ConversationId;
  platformId: string;
  address: ConversationAddress;
  adapter: PlatformAdapter;
}

/** One proposed sub-task. */
interface Item {
  agent: string;
  text: string;
  cwd?: string;
  title?: string;
}

/** One sub-agent's entry on an update card, before the card's budgets are applied. */
interface CardEntry {
  /** The topic id, as `task-read` takes it; also what a cut points at. */
  topic: string;
  /** The `- topic … · stage` line. */
  head: string;
  /** What the sub-agent said, whole; the card cuts it (clipCard). */
  quote?: { label: 'question' | 'failure' | 'reply'; text: string };
  link?: string;
}

type TaskAction = Extract<IpcAction, { kind: `task-${string}` }>;

export class Delegation {
  /**
   * Sub-tasks proposed and not yet confirmed, per proposing conversation. Kept until the person
   * answers: a `task-new` arriving while the card is up joins this list and re-renders the card,
   * rather than starting a second one that would replace the first.
   */
  private readonly gathering = new Map<ConversationId, { items: Item[]; cancel: () => void; card?: AbortController }>();
  /** The card on screen per proposing conversation: a newer one replaces it. */
  private readonly onScreen = new Map<ConversationId, AbortController>();
  /** Sub-agent topics with news, per conversation to tell, gathered for CARD_DELAY_MS. */
  private readonly updates = new Map<ConversationId, { children: Set<ConversationId>; cancel: () => void }>();
  /**
   * Sub-agent topics working on something their parent handed them (task-new, task-send) and not yet
   * reported back. Only those turns are the parent's news: a turn the person starts by writing in a
   * sub-agent's topic is theirs, and telling the parent about it would wake an agent to read a
   * conversation it is not in. In memory only — a turn a restart cuts off is reported as failed in its
   * own topic (TurnOutcomes), not to the parent.
   */
  private readonly handedOut = new Set<ConversationId>();

  constructor(private readonly deps: DelegationDeps) {}

  /** Shutdown: drop what is gathering, and take every card off the screen. */
  dispose(): void {
    for (const g of this.gathering.values()) g.cancel();
    for (const u of this.updates.values()) u.cancel();
    for (const c of this.onScreen.values()) c.abort();
    this.gathering.clear();
    this.updates.clear();
    this.onScreen.clear();
    this.handedOut.clear();
  }

  // ── The task commands ─────────────────────────────────────────────────────────────────────────

  /** One task command from conversation `from`. */
  async handle(from: ConversationId | undefined, action: TaskAction): Promise<unknown> {
    const here = from ? this.place(from) : undefined;
    if (!here) throw new Error(`${action.kind} runs from a conversation's own turn, and this call came from none`);
    if (!commandSurface(here.adapter).nested) {
      throw new Error(
        `sub-agents are opened as topics nested under the one that asked, which only the web UI can show; ` +
          `this conversation is on "${here.platformId}" (${this.deps.config.platforms[here.platformId]?.type ?? 'unknown'})`
      );
    }
    switch (action.kind) {
      case 'task-agents':
        return this.agents(here);
      case 'task-list':
        return this.list(here, action.limit ?? 30);
      case 'task-new':
        return this.propose(here, action);
      case 'task-send':
        return this.send(here, action.topic, action.text, action.interrupt === true);
      case 'task-read':
        return this.read(here, action.topic, action.limit ?? 10, { full: action.full === true, tail: action.tail });
      case 'task-status':
        return this.status(here, action.topic);
      case 'task-stop':
        return this.stop(here, action.topic);
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown task command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Every agent, the one answering this conversation first, then the ones on its own machine.
   *
   * The order is the whole of "which agent by default": `task-new` has no default of its own, and an
   * agent reading the list takes the first row it can use. That used to be whatever the config listed
   * first — `cc` here, on 2026-11-03, even in conversations cbc was answering — so the row for the
   * conversation's own agent goes first. It is also the safest default: already running on this
   * machine, with the same checkouts and tools.
   */
  private agents(here: Place): TaskAgentsResult {
    const mine = this.hostOf(here.key);
    const current = this.deps.registry.boundAgentOf(here.key);
    const rows = this.deps.config.agents.map((def) => {
      const choices = this.deps.registry.workdirChoices(def.id);
      return {
        id: def.id,
        harness: def.harness,
        where: def.host ?? 'gateway',
        here: (def.host ?? '') === mine,
        model: def.model ?? '',
        root: choices?.root ?? '',
        // Names, not paths: task-new takes a name inside the root, and two dozen of them is plenty.
        dirs: (choices?.dirs ?? []).slice(0, 24).map((d) => d.split('/').pop() ?? d),
      };
    });
    const rest = rows.filter((r) => r.id !== current);
    // Stable: within each half, the configuration's own order.
    return {
      agents: [...rows.filter((r) => r.id === current), ...rest.filter((r) => r.here), ...rest.filter((r) => !r.here)],
    };
  }

  /** The machine a conversation's agent runs on: its `host`, or '' for the gateway's own. */
  private hostOf(key: ConversationId): string {
    const agent = this.deps.registry.boundAgentOf(key);
    return (agent ? findAgent(this.deps.config, agent)?.host : undefined) ?? '';
  }

  /** The topics this conversation opened. */
  private list(here: Place, limit: number): TaskListResult {
    const rows = this.childrenOf(here).map((c) => this.row(c));
    return { tasks: rows.slice(0, limit), total: rows.length };
  }

  /**
   * Add one sub-task to the proposal waiting in this conversation.
   *
   * The proposal lives until the person answers it: while the card is on screen, another `task-new`
   * re-renders that same card with the new item on it. Batching used to be a 3-second window, so an
   * agent that made its three calls a few seconds apart — the normal case, one tool call per step —
   * got three cards, each replacing the one before, and the person's Start covered only the last.
   */
  private propose(here: Place, a: Extract<TaskAction, { kind: 'task-new' }>): TaskNewResult {
    const def = findAgent(this.deps.config, a.agent);
    if (!def) {
      throw new Error(`no agent "${a.agent}"; task-agents lists them: ${this.deps.config.agents.map((d) => d.id).join(', ')}`);
    }
    const g = this.gathering.get(here.key) ?? { items: [], cancel: () => undefined };
    g.cancel();
    g.items.push({ agent: a.agent, text: a.text, ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.title ? { title: a.title } : {}) });
    this.gathering.set(here.key, g);
    if (this.onScreen.has(here.key)) {
      // A card is up and unanswered: re-render it now, so it shows every item proposed so far.
      void this.putUp(here.key);
    } else {
      g.cancel = this.deps.clock.schedule(() => void this.putUp(here.key), PROPOSAL_GATHER_MS);
    }
    return {
      item: g.items.length,
      result:
        `Sub-task ${g.items.length} is on the card the person is about to be asked to confirm; more task-new calls ` +
        `join the same card while it waits. Nothing starts until they confirm. Then each gets a topic nested under ` +
        `this one, all start at once, and you are told here as each finishes, fails or asks something.`,
    };
  }

  /**
   * Put the proposal up as one card, and start what it lists if the person says so.
   *
   * A newer card replaces this one (a `task-new` arrived, or the person wrote and `personSpoke` dropped
   * the proposal), and an aborted confirm must not settle a list that is no longer its own — hence the
   * two identity checks after the await. Items proposed while this card was up are not on it: they go
   * on the next card, so a tap can never start something the person did not see.
   */
  private async putUp(key: ConversationId): Promise<void> {
    const g = this.gathering.get(key);
    const here = this.place(key);
    if (!g?.items.length || !here) return;
    const items = g.items.slice();
    g.cancel();
    this.onScreen.get(key)?.abort();
    const abort = new AbortController();
    g.card = abort;
    this.onScreen.set(key, abort);
    const n = items.length;
    const start = n === 1 ? 'Start it' : `Start all ${n}`;
    let picked: string | null = null;
    try {
      picked = await this.deps.confirm({
        adapter: here.adapter,
        address: here.address,
        conversation: key,
        text: this.cardText(here, items),
        labels: [start, 'Cancel'],
        timeoutMs: PROPOSAL_TIMEOUT_MS,
        signal: abort.signal,
      });
    } catch (e) {
      console.warn(`[delegation] ${key}: could not put the sub-agents up for confirmation:`, e instanceof Error ? e.message : e);
    } finally {
      if (this.onScreen.get(key) === abort) this.onScreen.delete(key);
    }
    // Superseded: a newer card owns the gathering now, or the person wrote and dropped it.
    if (this.gathering.get(key) !== g || g.card !== abort) return;
    if (picked !== start) {
      this.gathering.delete(key);
      console.log(`[delegation] ${key}: ${n} sub-agent(s) not started (${picked ?? 'called off'})`);
      return;
    }
    // Confirmed. Anything proposed while this card was up was not on it, so it gets its own card.
    g.items = g.items.filter((item) => !items.includes(item));
    if (g.items.length) void this.putUp(key);
    else this.gathering.delete(key);
    await this.start(here, items);
  }

  /**
   * The person wrote in this conversation: the card on screen is not the proposal to confirm any more.
   *
   * A typed reply is never a yes (the card's buttons are the only answer), and it is how a proposal is
   * changed — "use cbc instead". So the pending list is dropped here, before the agent reads the
   * message and proposes again; without this, the re-proposal would append to the very items it means
   * to replace. `/stop` and `/new` already reach this through the question they call off; a plain
   * message does not, because the card refuses text.
   */
  personSpoke(key: ConversationId): void {
    const g = this.gathering.get(key);
    if (!g) return;
    this.gathering.delete(key);
    g.cancel();
    this.onScreen.get(key)?.abort();
    console.log(`[delegation] ${key}: ${g.items.length} sub-agent(s) not started (the person wrote instead)`);
  }

  /** What the person is asked to confirm: every sub-task, whole enough to judge. */
  private cardText(here: Place, items: Item[]): string {
    const asker = this.deps.registry.boundAgentOf(here.key) ?? 'this agent';
    const lines = [`**${asker} wants to start ${items.length === 1 ? 'a sub-agent' : `${items.length} sub-agents`}** — each in a topic of its own under this one:`];
    items.forEach((item, i) => {
      const def = findAgent(this.deps.config, item.agent);
      const where = def?.host ? ` @ ${def.host}` : '';
      const dir = item.cwd ? ` · \`${item.cwd}\`` : '';
      const title = item.title ? ` — ${item.title}` : '';
      const text = item.text.length > PROPOSAL_TEXT_CHARS ? `${item.text.slice(0, PROPOSAL_TEXT_CHARS - 1)}…` : item.text;
      lines.push('', `${i + 1}. **${item.agent}**${where}${dir}${title}`, ...text.split('\n').map((l) => `> ${l}`));
    });
    lines.push('', 'To change them, say what to change instead of tapping.');
    return lines.join('\n');
  }

  /** Open every confirmed sub-task, say where they went, and tell the agent of any that could not start. */
  private async start(here: Place, items: Item[]): Promise<void> {
    const header = this.headerOf(here);
    const opened: string[] = [];
    const failed: string[] = [];
    // One after another, not all at once: each is a topic created, named and bound, and the order
    // they appear in under the parent is the order on the card. Their turns run in parallel all the
    // same — handTo starts one and returns.
    for (const [i, item] of items.entries()) {
      try {
        const { key, address } = await this.deps.registry.openTask({
          platform: here.platformId,
          parent: here.address,
          agentId: item.agent,
          text: item.text,
          header,
          ...(item.cwd ? { cwd: item.cwd } : {}),
          ...(item.title ? { title: item.title } : {}),
        });
        this.handedOut.add(key);
        const title = subjectOf(this.titleOf(key, { platformId: here.platformId, address }));
        opened.push(`- [${title}](?t=${address.thread ?? ''}) — ${item.agent}`);
        console.log(`[delegation] ${here.key} opened ${key} for "${item.agent}"`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        failed.push(`- ${i + 1}. ${item.agent}: ${why}`);
        console.warn(`[delegation] ${here.key}: sub-task ${i + 1} for "${item.agent}" could not start: ${why}`);
      }
    }
    const said = [
      ...(opened.length ? [`Started ${opened.length}:`, ...opened] : []),
      ...(failed.length ? [`${opened.length ? '\n' : ''}Could not start ${failed.length}:`, ...failed] : []),
    ].join('\n');
    await here.adapter
      .sendMessage(here.address, said)
      .catch((e) => console.warn('[delegation] could not say which sub-agents started:', e instanceof Error ? e.message : e));
    if (failed.length) this.tell(here, [`[sub-agent updates] ${failed.length} of ${items.length} could not be started:`, ...failed], [], failed.length);
  }

  private async send(here: Place, topic: string, text: string, interrupt: boolean): Promise<TaskActionResult> {
    const c = this.child(here, topic);
    const header = this.headerOf(here);
    // Stop first, and queue the message behind the stop: the dying turn must not be offered it
    // (InboundMerger.queueBehind). `idle` means there was nothing to stop, and the send is ordinary.
    const stopped = interrupt ? this.deps.registry.stopConversation(c.key) !== 'idle' : false;
    const how = await this.deps.registry.handTo(
      c.key,
      c.platformId,
      c.address,
      text,
      header,
      interrupt ? { queue: true } : {}
    );
    this.handedOut.add(c.key);
    return { topic, result: sendResult(how, stopped) };
  }

  /**
   * A sub-agent topic's messages, as the agent that opened it reads them.
   *
   * `full` and `tail` answer the two ways the default cut fails. A tool bubble in accumulate mode is
   * one message holding the turn's commands, so a head cut shows the oldest of them and hides what it
   * is doing now; `tail` keeps the end, `full` raises the cap. The total budget is the guard against
   * a `--full` read of a hundred messages: the newest whole messages are kept and the rest is said
   * in `note`, never silently dropped.
   */
  private async read(
    here: Place,
    topic: string,
    limit: number,
    opts: { full: boolean; tail?: number }
  ): Promise<TaskReadResult> {
    const c = this.child(here, topic);
    const messages = await c.adapter.fetchHistory(c.address, { limit });
    const cap = opts.full || opts.tail !== undefined ? READ_FULL_CHARS : READ_CHARS;
    const shaped = messages.map((m) => ({
      from: m.authorIsBot ? ('agent' as const) : ('person' as const),
      at: new Date(m.timestamp).toISOString(),
      text: clip(m.content, cap, opts.tail),
    }));
    let used = 0;
    let from = shaped.length;
    for (let i = shaped.length - 1; i >= 0; i--) {
      const size = shaped[i]!.text.length;
      if (used + size > READ_TOTAL_CHARS && from !== shaped.length) break;
      used += size;
      from = i;
    }
    const dropped = from;
    return {
      topic,
      messages: shaped.slice(from),
      ...(dropped > 0
        ? {
            note:
              `the ${dropped} oldest of ${shaped.length} messages were left out to keep this under ` +
              `${READ_TOTAL_CHARS} characters; ask for fewer messages (--limit) or fewer lines (--tail) to fit the rest`,
          }
        : {}),
    };
  }

  /** One sub-agent topic in detail: its live row, its last tool calls, and its last reply. */
  private status(here: Place, topic: string): TaskStatusResult {
    const c = this.child(here, topic);
    const live = this.deps.registry.progressOf(c.key);
    return {
      task: this.row(c),
      recent: (live?.recent ?? []).map((t) => ({ at: new Date(t.at).toISOString(), tool: t.tool, detail: t.detail })),
      reply: this.deps.registry.replyTextOf(c.key) ?? '',
    };
  }

  private stop(here: Place, topic: string): TaskActionResult {
    const c = this.child(here, topic);
    const outcome = this.deps.registry.stopConversation(c.key);
    if (outcome !== 'idle') {
      void c.adapter
        .sendMessage(c.address, `⏹ Stopped by the agent in [${subjectOf(this.titleOf(here.key, here))}](?t=${here.address.thread ?? ''}).`)
        .catch((e) => console.warn('[delegation] could not mark a stop:', e instanceof Error ? e.message : e));
    }
    return {
      topic,
      result: outcome === 'idle' ? 'Nothing was running there.' : 'Stopped. Its context is kept; a message there carries on from it.',
    };
  }

  /**
   * `/stop` in a conversation: stop every sub-agent it opened that is still at work, and the ones
   * those opened, saying so in each. Returns how many were stopped.
   *
   * The person stopping a /super job means the job. Its own turn ends as soon as the parts are
   * handed out, so a `/stop` that reached only that turn stopped nothing while every sub-agent ran
   * on — and the only way to stop them was to open each one. Each is stopped as its own `/stop`
   * would (questions called off too); its conversation is kept.
   */
  stopOpened(key: ConversationId, seen: Set<ConversationId> = new Set()): number {
    const here = this.place(key);
    if (!here || seen.has(key) || !commandSurface(here.adapter).nested) return 0;
    seen.add(key);
    let stopped = 0;
    for (const c of this.childrenOf(here)) {
      const { outcome, calledOff, transcripts } = this.deps.registry.stopWithPending(c.key, 'stopped from the topic that opened it');
      if (outcome !== 'idle' || calledOff + transcripts > 0) {
        stopped++;
        void c.adapter
          .sendMessage(c.address, `⏹ Stopped with /stop in [${subjectOf(this.titleOf(here.key, here))}](?t=${here.address.thread ?? ''}).`)
          .catch((e) => console.warn('[delegation] could not mark a stop:', e instanceof Error ? e.message : e));
      }
      stopped += this.stopOpened(c.key, seen);
    }
    return stopped;
  }

  /** What a sub-agent's topic shows above what it is handed: whose words these are, linked. */
  private headerOf(here: Place): string {
    return `**↳ From [${subjectOf(this.titleOf(here.key, here))}](?t=${here.address.thread ?? ''})**`;
  }

  /**
   * One of this conversation's sub-agent topics, named the way `tasks` and the updates name it
   * (`web:main/3a9f0c12`), or by its bare topic id. Refused when it is not one this conversation
   * opened: a conversation acts on its own sub-agents and nobody else's.
   */
  private child(here: Place, topic: string): Place {
    let address: ConversationAddress | undefined = /^[0-9a-f]{8}$/.test(topic) ? { channel: here.address.channel, thread: topic } : undefined;
    if (!address) {
      try {
        const target = parseTarget(topic, new Set(Object.keys(this.deps.config.platforms)));
        if ((target.platform ?? here.platformId) === here.platformId) address = target.address;
      } catch {
        address = undefined;
      }
    }
    const parent = address ? here.adapter.parentOf?.(address) : undefined;
    if (!address || !parent || parent.channel !== here.address.channel || parent.thread !== here.address.thread) {
      throw new Error(`"${topic}" is not a topic this conversation opened; \`talkcode tasks\` lists the ones it did`);
    }
    const conv = this.deps.registry.conversationAt(here.platformId, address);
    if (!conv?.agent) throw new Error(`nothing has happened in "${topic}" yet`);
    return { key: conv.key, platformId: here.platformId, address, adapter: here.adapter };
  }

  /** The topics a conversation opened, as places. */
  private childrenOf(here: Place): Place[] {
    const out: Place[] = [];
    for (const address of here.adapter.childrenOf?.(here.address) ?? []) {
      const conv = this.deps.registry.conversationAt(here.platformId, address);
      if (conv) out.push({ key: conv.key, platformId: here.platformId, address, adapter: here.adapter });
    }
    return out;
  }

  /** One sub-agent topic as the agent that opened it sees it. */
  private row(c: Place): TaskRow {
    const stage = this.stageOf(c);
    const activity = this.deps.registry.activityOf(c.key);
    const agent = this.deps.registry.boundAgentOf(c.key) ?? '';
    const host = agent ? findAgent(this.deps.config, agent)?.host : undefined;
    // Live only while it works: after the turn ends the outcome is the honest answer, and a tool
    // line left over from it would describe something that is no longer happening.
    const live = stage === 'working' ? this.deps.registry.progressOf(c.key) : undefined;
    const since = stage === 'working' ? this.deps.registry.runningSince(c.key) : undefined;
    const status = this.deps.registry.statusOf(c.key);
    return {
      topic: `${c.platformId}:${c.address.channel}${c.address.thread ? `/${c.address.thread}` : ''}`,
      title: subjectOf(this.titleOf(c.key, c)),
      agent: host ? `${agent} @ ${host}` : agent,
      cwd: shortenHome(this.deps.registry.workdirOf(c.key) ?? ''),
      stage,
      line: this.lineOf(c.key, stage, activity, live),
      step: live?.steps ?? 0,
      elapsed: since !== undefined ? formatElapsed(this.deps.clock.now() - since) : '',
      context: contextOf(status),
      cost: status?.cost ? formatCost(status.cost) : '',
      lastAt: lastAtOf(activity, live),
      ...(c.address.thread ? { link: `?t=${c.address.thread}` } : {}),
    };
  }

  /** What to put beside the stage: the question, what it is doing now, or how its last turn ended. */
  private lineOf(
    key: ConversationId,
    stage: TopicStage,
    activity: TopicActivity | undefined,
    live: LiveTurn | undefined
  ): string {
    if (stage === 'answer') {
      const question = this.deps.questionOf?.(key);
      return question ? oneLine(question) : 'a question is waiting';
    }
    if (live?.current) return `${live.current.tool}: ${live.current.detail}`;
    return activity?.outcome?.line ?? '';
  }

  /**
   * Where a sub-agent topic stands for the agent that opened it. Not read through `seenAt`: that the
   * person has looked at a finished reply does not mean the agent that is waiting on it has.
   */
  private stageOf(c: Place): TopicStage {
    return topicStage({
      running: this.deps.registry.isBusy(c.key),
      asking: this.deps.registry.isAsking(c.key),
      activity: this.deps.registry.activityOf(c.key),
    });
  }

  // ── Sub-agent updates ────────────────────────────────────────────────────────────────────────

  /**
   * A conversation has something for the person (TurnOutcomes, or a question was asked). When it is
   * a sub-agent's topic, the agent that opened it is told — gathered for CARD_DELAY_MS, so a burst of
   * finishes is one card rather than one turn each.
   */
  childChanged(id: ConversationId): void {
    if (!this.handedOut.has(id)) return;
    const parent = this.parentOf(id);
    if (!parent) return;
    const u = this.updates.get(parent.key) ?? {
      children: new Set<ConversationId>(),
      cancel: this.deps.clock.schedule(() => this.sendUpdates(parent.key), CARD_DELAY_MS),
    };
    u.children.add(id);
    this.updates.set(parent.key, u);
  }

  /** The conversation that opened this one, while both are still there. */
  private parentOf(id: ConversationId): Place | undefined {
    const lane = this.deps.registry.laneFor(id);
    const adapter = lane ? this.deps.platforms.get(lane.platformId) : undefined;
    const address = lane && adapter?.parentOf?.(lane.address);
    const conv = address && lane ? this.deps.registry.conversationAt(lane.platformId, address) : undefined;
    if (!lane || !adapter || !address || !conv) return undefined;
    return { key: conv.key, platformId: lane.platformId, address, adapter };
  }

  /** Tell one conversation what its sub-agents did since it was last told. */
  private sendUpdates(key: ConversationId): void {
    const u = this.updates.get(key);
    this.updates.delete(key);
    const here = this.place(key);
    if (!u || !here) return;
    const entries: CardEntry[] = [];
    const shown: string[] = [];
    for (const id of u.children) {
      const c = this.childrenOf(here).find((x) => x.key === id);
      if (!c) continue;
      const stage = this.stageOf(c);
      // Started again since (someone wrote there): what it is doing now is news only when it ends.
      if (stage === 'working' || stage === 'idle' || stage === 'retrying') continue;
      // A question leaves the turn open; an end closes what the parent handed out.
      if (stage !== 'answer') this.handedOut.delete(c.key);
      const row = this.row(c);
      entries.push(this.entry(c, row, stage));
      shown.push(`🔔 ${row.title || row.topic} (${row.agent}) — ${describeStage(stage)}${row.line ? `: ${row.line}` : ''}`);
    }
    if (entries.length === 0) return;
    this.tell(here, this.card(`[sub-agent updates] ${this.tally(here)}`, entries), shown, entries.length);
  }

  /**
   * One sub-agent on the card: where it is, how it stands, and what it said.
   *
   * The body is the whole of what the sub-agent said — the reply the turn ended on, the question it
   * is waiting on, the error the turn failed with — because the parent agent is meant to act on the
   * card without opening the topic. A reply is not accompanied by its first line: that line is
   * already in it.
   */
  private entry(c: Place, row: TaskRow, stage: TopicStage): CardEntry {
    const text =
      stage === 'review'
        ? this.deps.registry.replyTextOf(c.key) ?? row.line
        : stage === 'answer'
          ? this.deps.questionOf?.(c.key) ?? row.line
          : stage === 'failed'
            ? this.deps.registry.failureTextOf(c.key) ?? row.line
            : undefined;
    const label = stage === 'answer' ? 'question' : stage === 'review' ? 'reply' : 'failure';
    return {
      topic: row.topic,
      head: `- topic ${row.topic} · "${row.title}" · ${row.agent}${row.cwd ? ` in ${row.cwd}` : ''} · ${describeStage(stage)}`,
      ...(text ? { quote: { label, text } } : {}),
      ...(row.link ? { link: row.link } : {}),
    };
  }

  /**
   * The card's lines, with the sub-agent text cut to what one card can carry.
   *
   * Entries share CARD_TOTAL_CHARS in the order the updates arrived, and one may take at most
   * CARD_ITEM_CHARS. A body that does not fit is cut and says where the rest is; an entry whose
   * share is already spent keeps its heading and link, and its body is that notice. Headings are
   * the card's frame, not part of the budget: the budget bounds how much the sub-agents said, which
   * is what the parent agent would otherwise open each topic to read.
   */
  private card(header: string, entries: CardEntry[]): string[] {
    const lines = [header];
    let left = CARD_TOTAL_CHARS;
    for (const e of entries) {
      lines.push(e.head);
      if (e.quote) {
        const cap = Math.min(CARD_ITEM_CHARS, Math.max(0, left));
        const text = clipCard(e.quote.text, cap, e.topic);
        lines.push(`  ${e.quote.label}: ${text}`.replace(/\n/g, '\n  '));
        left -= text.length;
      }
      if (e.link) lines.push(`  link: ${e.link}`);
    }
    return lines;
  }

  /** "2 of 3 sub-agents have finished; 1 is still working." — so the agent knows whether to wait. */
  private tally(here: Place): string {
    const stages = this.childrenOf(here).map((c) => this.stageOf(c));
    const busy = stages.filter((s) => s === 'working' || s === 'retrying').length;
    const asking = stages.filter((s) => s === 'answer').length;
    const done = stages.length - busy - asking;
    return (
      `${done} of ${stages.length} sub-agent${stages.length === 1 ? ' has' : 's have'} finished or stopped` +
      (busy ? `; ${busy} still working` : '') +
      (asking ? `; ${asking} waiting on a question for the person` : '') +
      '.'
    );
  }

  /** One card to one conversation: shown folded there, then put in front of its agent as a turn. */
  private tell(here: Place, lines: string[], shown: string[], count = shown.length): void {
    const agentId = this.deps.registry.boundAgentOf(here.key);
    if (!agentId || !findAgent(this.deps.config, agentId)) return;
    if (shown.length) {
      void here.adapter
        .sendMessage(here.address, shown.join('\n'), { kind: 'tools' })
        .catch((e) => console.warn('[delegation] could not show a sub-agent update:', e instanceof Error ? e.message : e));
    }
    void this.deps.registry
      .runScheduledPrompt({ key: here.key, platform: here.platformId, address: here.address, agentId, prompt: lines.join('\n'), user: UPDATE_SENDER })
      .then((outcome) => {
        if (typeof outcome === 'object') console.warn(`[delegation] sub-agent updates not delivered to ${here.key}: ${outcome.refused}`);
      })
      .catch((e) => console.warn('[delegation] sub-agent updates failed:', e instanceof Error ? e.message : e));
    console.log(`[delegation] told ${here.key} about ${count} sub-agent(s)`);
  }

  // ── Lookups ───────────────────────────────────────────────────────────────────────────────────

  private place(key: ConversationId): Place | undefined {
    const lane = this.deps.registry.laneFor(key);
    const adapter = lane ? this.deps.platforms.get(lane.platformId) : undefined;
    return lane && adapter ? { key, platformId: lane.platformId, address: lane.address, adapter } : undefined;
  }

  /** A conversation's name, from what `channels` knows. */
  private titleOf(id: ConversationId, place: { platformId: string; address: ConversationAddress }): string {
    const want = `${place.platformId}:${place.address.channel}${place.address.thread ? `/${place.address.thread}` : ''}`;
    const ch = this.deps.registry.listChannels({ platform: place.platformId, limit: 200 }).channels.find((c) => c.id === want);
    return ch?.title || id;
  }
}

/** The context column, in the form the footer and `/context` already use; empty when unreported. */
function contextOf(status: AgentStatus | undefined): string {
  if (!status?.context) return '';
  return formatRuntimeFooter({ contextTokens: status.context.used, contextLength: status.context.size }, ['context']);
}

/** When it last did anything: the last turn's outcome, else the tool it is running now. */
function lastAtOf(activity: TopicActivity | undefined, live: LiveTurn | undefined): string {
  const at = activity?.outcome?.at ?? live?.current?.at;
  return at === undefined ? '' : new Date(at).toISOString();
}

/**
 * What to say after `task-send`, from what actually happened rather than from "it looked busy".
 *
 * `queued` used to be reported as `joined`, which told the agent its correction had been seen while
 * the sub-agent was still running the commands it was told to stop (reported 2026-11-03).
 */
function sendResult(how: 'started' | 'joined' | 'queued', stopped: boolean): string {
  if (stopped) {
    return how === 'queued'
      ? 'Stopped the turn it was running. This is next in line: it runs as soon as the stopped turn unwinds, with its context kept.'
      : 'Stopped the turn it was running and sent this as the next one.';
  }
  switch (how) {
    case 'joined':
      return 'Sent to its agent, which was already working: it takes it into the turn it is running.';
    case 'queued':
      return 'Sent to its agent, which is already working and cannot take input mid-turn: it runs as its next turn, once this one ends. If it is going the wrong way, `task-send --interrupt` stops it first.';
    case 'started':
      return 'Sent to its agent, which is starting on it now.';
    default: {
      const _exhaustive: never = how;
      return String(_exhaustive);
    }
  }
}

/**
 * One message as `task-read` returns it.
 *
 * `tail` is the half that matters for a tool bubble: accumulate mode keeps the turn's newest lines
 * in the bubble, so a head cut shows the oldest of what is still there — the commands it ran ten
 * minutes ago, not the one it is running now. `cap` is raised whenever either flag is used, and what
 * was left out is said in the text rather than silently gone.
 */
function clip(text: string, cap: number, tail: number | undefined): string {
  let out = text;
  let droppedLines = 0;
  if (tail !== undefined) {
    const lines = out.split('\n');
    if (lines.length > tail) {
      droppedLines = lines.length - tail;
      out = lines.slice(-tail).join('\n');
    }
  }
  let droppedChars = 0;
  if (out.length > cap) {
    droppedChars = out.length - (cap - 1);
    out = `${out.slice(0, cap - 1)}…`;
  }
  if (droppedLines) out = `…[${droppedLines} earlier lines]\n${out}`;
  // The default cut keeps its bare ellipsis; a raised cap says how much it still could not fit,
  // because there the caller asked for the whole thing and deserves to know it did not get it.
  if (droppedChars && cap !== READ_CHARS) out = `${out}\n…[${droppedChars} later characters]`;
  return out;
}

/**
 * One quoted text cut to `cap` characters, saying what was left out.
 *
 * The notice counts against the cap, so a budget is the length the card actually carries. It names
 * the whole's length, where the cut fell, and the existing way to read the rest: a parent agent
 * that cannot tell a cut review from a short one will act on half a conclusion, which is the bug
 * the long excerpt is here to end. When the cap is smaller than the notice itself, the notice
 * still goes in — a budget is not worth losing the fact that something was omitted.
 */
function clipCard(text: string, cap: number, topic: string): string {
  if (text.length <= cap) return text;
  const note = (cut: number) =>
    `\n…[${text.length} chars total, cut at ${cut}; the rest is in this topic — task-read ${topic} --full]`;
  // The cut changes the note's digit count, so settle it in a second pass.
  let cut = Math.max(0, cap - note(0).length);
  cut = Math.max(0, cap - note(cut).length);
  return `${text.slice(0, cut)}${note(cut)}`;
}

/** A multi-line text on one row: a sidebar line, not a summary (see core/topic-stage.ts LINE_MAX). */
function oneLine(text: string, max = LINE_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A stage in a sentence. */
function describeStage(stage: TopicStage): string {
  switch (stage) {
    case 'answer':
      return 'waiting on a question';
    case 'failed':
      return 'failed';
    case 'review':
      return 'finished';
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

/**
 * A topic's name without the `[agent] ` its lane title starts with (core formatLaneTitle), and with no
 * square brackets left: it is handed to an agent that writes it as link text, `[title](?t=…)`, and
 * the web UI's markdown does not take brackets inside link text. The agent is a column of its own.
 */
function subjectOf(title: string): string {
  return title.replace(/^\[[^\]]*\]\s*/, '').replace(/[[\]]/g, '');
}

/** `/home/user/workspace/x` → `~/workspace/x`, for a column that is read, not used. */
function shortenHome(p: string): string {
  return p.replace(/^\/(home\/[^/]+|root)(?=\/|$)/, '~');
}
