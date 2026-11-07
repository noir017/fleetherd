import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { formatCost, formatElapsed } from '../core/busy-snapshot.js';
import { parseTarget, type ConversationAddress } from '../core/conversation.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import type { CommandSurface } from '../core/command-translate.js';
import { LINE_MAX, topicStage } from '../core/topic-stage.js';
import { READ_CHAR_BUDGET, type HistoryReadOptions, type HistoryStore, type HistoryTurnRow } from '../history/store.js';
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
import type { AgentStatus, ConversationId, TopicActivity, TopicKillResult, TopicStage } from '../types.js';
import type { LiveTurn } from './turn-progress.js';
import type { ConversationRegistry } from './conversation.js';
import { UPDATE_SENDER, type PersonWords } from './turn-runner.js';

/**
 * Sub-agents: an agent in one conversation hands parts of its job to other agents, each in a topic
 * of its own nested under it, running in parallel — once the person has confirmed them. That gate
 * has three tiers (`delegation.confirm`): wait every time, wait once per agent per conversation,
 * or never. `/super` (the bundled skill of that name) is the person asking for exactly that; any
 * agent may do it unprompted, because by default nothing starts without the person's say-so.
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
 * Structure, enforced here: by default nothing starts until the person taps Start on the card that
 * lists every sub-task in full (the agent cannot start one itself, whatever it is told). With
 * `delegation.confirm: 'first'`, only an agent's first sub-task in a conversation goes on that
 * card; once the person has confirmed it there, later ones start at once. With
 * `delegation.confirm: false`, `task-new` opens each sub-task at once and a card — the same list,
 * without buttons — is posted for the record. A conversation acts only on topics it opened; a
 * sub-agent's topic is an ordinary topic the person can walk into; and the relation is the
 * platform's own record (`PlatformAdapter.parentOf`), so deleting a topic ends it. The switch is a
 * person's decision only: `/setting delegation` writes it, and no reverse command reaches it.
 * Instruction, in the skills (`skill/`): how to split a job, which agent to prefer, what to do with
 * the updates.
 *
 * ── The exception to "nothing of the gateway's in the prompt" ───────────────────────────────────
 * The `[sub-agent updates]` card. It is how the agent that opened the topics learns what happened in
 * them, and no harness mechanism can carry another conversation's state into a session. It goes only
 * to the conversation that opened those topics, and is shown there (folded) before it is sent, so the
 * person sees exactly what the agent was told. What a sub-agent receives is the task text and nothing
 * else.
 *
 * It covers the turns the parent handed out and, since 2026-11-06, the turns the person starts or
 * joins by writing in a sub-agent's topic, with what they wrote quoted above the result. Until then
 * a turn the person started there was theirs alone, and the parent went on from a picture of its
 * sub-agent that the person had already changed — it would report, review or redo work on the
 * strength of a reply the person had since corrected.
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
 * and where the rest is read (quotedBlock), so a truncated review cannot pass for a short one.
 */
export const CARD_ITEM_CHARS = 4_000;
export const CARD_TOTAL_CHARS = 8_000;

/**
 * How much of what the person wrote in a sub-agent's topic one card entry carries, above the result.
 * Less than a reply's CARD_ITEM_CHARS: the reply is what the parent acts on, the person's words are
 * what it needs to read that reply right, and a pasted log should not crowd the reply off the card.
 * A cut says so and where the whole is read, as every other cut on the card does.
 */
export const CARD_SAID_CHARS = 2_000;

/** How many attachment names one entry lists after the person's words; the rest are counted. */
const SAID_ATTACHMENTS_SHOWN = 10;

/**
 * How many sub-agents one card lists. A card has no fixed frame size — every entry's heading and
 * link is its own length — so an unbounded burst could spend the whole budget on headings. The
 * rest is one line pointing at `talkcode tasks`, where every topic is listed.
 */
export const CARD_MAX_ENTRIES = 20;

/** How much of each sub-task's text the confirmation card shows. */
const PROPOSAL_TEXT_CHARS = 1_500;

/** How much of each message `task-read` returns. */
const READ_CHARS = 1_500;

/** How much of a reply `task-status` previews; the card and `task-read` carry the rest. */
const STATUS_REPLY_CHARS = 600;

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
  | 'replyOf'
  | 'failureOf'
  | 'progressOf'
  | 'runningSince'
  | 'statusOf'
  | 'stopConversation'
  | 'stopWithPending'
  | 'killConversation'
  | 'runScheduledPrompt'
  | 'workdirOf'
  | 'boundAgentOf'
  | 'conversationTitle'
  | 'scheduledModelProblem'
>;

export interface DelegationDeps {
  config: Config;
  platforms: Map<string, PlatformAdapter>;
  registry: Registry;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /**
   * The conversation library `task-read` reads. Absent means no `history.db` (a Node without
   * node:sqlite, or a daemon started without one), and the command says so rather than answering
   * from a different source with different rows.
   */
  history?: Pick<HistoryStore, 'read' | 'turnRecord' | 'sessionOf'>;
  /**
   * The conversation's live context — the agent bound now and the generation `/new`/`/cd` last
   * set — which `--turn done` is defined against. The library cannot infer it from its own rows
   * (see HistoryReadOptions.current); absent, it falls back to the newest turn's.
   */
  currentContext?: (id: ConversationId) => { agent: string; generation: number } | undefined;
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
  model?: string;
}

/** One sub-task that has started, as the card that stands in for a confirmation lists it. */
interface OpenedTask {
  /** The topic's name, without the `[agent] ` prefix. */
  title: string;
  /** The id `tasks` and `task-read` take (`web:main/3a9f0c12`). */
  topic: string;
  /** `?t=…`, what opens it in place. */
  link?: string;
  agent: string;
  host?: string;
  cwd?: string;
  model?: string;
}

/** What one sub-agent said — or the person said to it — as the card quotes it. */
interface CardQuote {
  /** `person`: what the person wrote in the topic themselves, quoted above the sub-agent's result. */
  label: 'question' | 'failure' | 'reply' | 'person';
  /** What the card prints before the text, when that is not the label itself. */
  heading?: string;
  /** The head kept for the card; `total` may be larger (see turn-outcomes.ts KeptText). */
  text: string;
  /** The length of the whole text, before the head was cut. */
  total: number;
  /** The library's number for the turn it came from, so a cut can name that turn. */
  turn?: number;
}

/** One sub-agent's entry on an update card, before the card's budgets are applied. */
interface CardEntry {
  /** The topic id, as `task-read` takes it; also what a cut points at. */
  topic: string;
  /** The `- topic … · stage` line. */
  head: string;
  /** What the person wrote in the topic since the last card, shown first (Delegation.said). */
  said?: CardQuote;
  /** What the sub-agent said, whole; the card cuts it (quotedBlock). */
  quote?: CardQuote;
  link?: string;
}

/**
 * What the person wrote directly in one sub-agent's topic since its parent was last told: every
 * message, in order, as the agent read them. Bounded like a kept reply — the head the card can show
 * and the whole length — because nothing else bounds what a person may paste.
 */
interface Said {
  text: string;
  total: number;
  /** Attachment names, the first SAID_ATTACHMENTS_SHOWN of them; `moreAttachments` counts the rest. */
  attachments: string[];
  moreAttachments: number;
  /** The library's numbers for the turns the words went into, distinct, oldest first. */
  turns: number[];
  /** Some went in with no number (no library, or a harness that took them outside a turn). */
  unnumbered: boolean;
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
  /**
   * Sub-tasks started without a confirmation (`delegation.confirm: false`, or `'first'` once this
   * conversation has confirmed that agent), per conversation, gathered for PROPOSAL_GATHER_MS so a
   * burst is one card. Nothing waits on it — the work is already running — so unlike `gathering` it
   * is never dropped by the person writing.
   */
  private readonly started = new Map<ConversationId, { opened: OpenedTask[]; failed: string[]; cancel: () => void }>();
  /**
   * Agents this conversation has confirmed at least once, for `delegation.confirm: 'first'`. In
   * memory only, and per proposing conversation: a restart asks again, and another conversation
   * asks for itself. A change of tier clears it (see syncConfirmMode). A sub-agent's topic never
   * reads or writes it — it asks every time.
   */
  private readonly confirmedOnce = new Map<ConversationId, Set<string>>();
  /** The tier `confirmedOnce` was gathered under. Kept so a change made behind our back — /reload — is noticed. */
  private confirmMode: Config['delegation']['confirm'] | undefined;
  /** Sub-agent topics with news, per conversation to tell, gathered for CARD_DELAY_MS. */
  private readonly updates = new Map<ConversationId, { children: Set<ConversationId>; cancel: () => void }>();
  /**
   * Sub-agent topics whose turn the parent is told about when it ends: one the parent handed them
   * (task-new, task-send), or one the person started or joined by writing there (personWrote). Kept
   * while a question holds the turn open, and dropped once the end is on a card. Any other turn there
   * — a scheduled run, a burst of background output — is nobody's news.
   *
   * Until 2026-11-06 only handed-out turns counted, on the view that a turn the person starts in a
   * sub-agent's topic is theirs and telling the parent would wake an agent to read a conversation it
   * is not in. It is in it, though: it opened that topic for a part of its job and reports on it, and
   * a parent that never hears the person redirect its sub-agent goes on to summarise, review or redo
   * work from a reply the person already corrected.
   *
   * In memory only — a turn a restart cuts off is reported as failed in its own topic (TurnOutcomes),
   * not to the parent. What the person writes after a restart is reported as before: the relation
   * is the platform's record, not this set.
   */
  private readonly owed = new Set<ConversationId>();
  /**
   * What the person wrote in each sub-agent topic and no card has carried yet. Shown on the next card
   * from that topic, above its result, and then dropped — including on a card about a question, so
   * the end of the same turn does not repeat it. A turn the person stops is not reported (nothing is
   * left of it to act on), but what they wrote stays here for the next card: the sub-agent's session
   * still holds it, and so whatever it does next was asked for partly in those words.
   */
  private readonly said = new Map<ConversationId, Said>();

  constructor(private readonly deps: DelegationDeps) {}

  /** Shutdown: drop what is gathering, and take every card off the screen. */
  dispose(): void {
    for (const g of this.gathering.values()) g.cancel();
    for (const s of this.started.values()) s.cancel();
    for (const u of this.updates.values()) u.cancel();
    for (const c of this.onScreen.values()) c.abort();
    this.gathering.clear();
    this.started.clear();
    this.confirmedOnce.clear();
    this.updates.clear();
    this.onScreen.clear();
    this.owed.clear();
    this.said.clear();
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
        return this.read(here, action);
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
   * The order mirrors the default: without --agent, `task-new` uses the agent bound to this
   * conversation, and that agent also leads this list. The first row used to be whatever the config
   * listed first — `cc` here, on 2026-11-03, even in conversations cbc was answering. The current
   * agent is the safest default: already running on this machine, with the same checkouts and tools.
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
   * Add one sub-task to the proposal waiting in this conversation — or start it at once when this
   * agent needs no confirmation here.
   *
   * With confirmation on, the proposal lives until the person answers it: while the card is on
   * screen, another `task-new` re-renders that same card with the new item on it. Batching used to be
   * a 3-second window, so an agent that made its three calls a few seconds apart — the normal case,
   * one tool call per step — got three cards, each replacing the one before, and the person's Start
   * covered only the last.
   *
   * A sub-task starts at once in two cases, and the answer says it is running. `delegation.confirm:
   * false` starts all of them; `'first'` starts the ones whose agent this conversation has already
   * confirmed, so a batch of mixed agents both starts some and puts the rest on a card. In either
   * case the card is still posted, without buttons, so the person sees what an agent started on its
   * own; it gathers a burst the same way, only for the record.
   */
  private async propose(here: Place, a: Extract<TaskAction, { kind: 'task-new' }>): Promise<TaskNewResult> {
    this.syncConfirmMode();
    const agent = a.agent ?? this.deps.registry.boundAgentOf(here.key);
    if (!agent) throw new Error('this conversation has no agent to use by default; give task-new --agent <id>');
    const def = findAgent(this.deps.config, agent);
    if (!def) {
      throw new Error(`no agent "${agent}"; task-agents lists them: ${this.deps.config.agents.map((d) => d.id).join(', ')}`);
    }
    if (a.model) {
      // Refuse a typo while the asking agent can still retry in this turn, using the same list
      // /model and schedule add --model use. Applying it later is strict too (openTask).
      const why = await this.deps.registry.scheduledModelProblem(agent, a.model, here.key);
      if (why) throw new Error(why);
    }
    const item: Item = {
      agent,
      text: a.text,
      ...(a.cwd ? { cwd: a.cwd } : {}),
      ...(a.title ? { title: a.title } : {}),
      ...(a.model ? { model: a.model } : {}),
    };
    if (this.startsAtOnce(here, item.agent)) {
      const { opened, failed } = await this.start(here, [item]);
      this.queueStartedCard(here.key, opened, failed);
      // The card's position, the same fact `item` carries when a confirmation card is gathering.
      const card = this.started.get(here.key);
      return { item: card ? card.opened.length + card.failed.length : 1, result: startedResult(opened, failed) };
    }
    const g = this.gathering.get(here.key) ?? { items: [], cancel: () => undefined };
    g.cancel();
    g.items.push(item);
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
   * Whether this conversation is a sub-agent's own topic (it has a parent).
   *
   * The switch is the person's: it removes the tap in the conversation the person talks to the
   * agent in, never one an agent opened. Otherwise a sub-agent could open more sub-agents — and
   * those more — with nobody asked, which is the spend the default exists to bound.
   */
  private nested(here: Place): boolean {
    return here.adapter.parentOf?.(here.address) !== undefined;
  }

  /**
   * Whether this proposal starts without a card: the switch is `false`, or it is `'first'` and this
   * conversation has already confirmed that agent once.
   *
   * A sub-agent's own topic never starts at once, whatever the switch says (AGENTS.md invariant 6):
   * it asks every time, so a chain of agents cannot spend the operator's machines without a tap.
   */
  private startsAtOnce(here: Place, agent: string): boolean {
    if (this.nested(here)) return false;
    const confirm = this.deps.config.delegation.confirm;
    if (confirm === false) return true;
    return confirm === 'first' && this.confirmedOnce.get(here.key)?.has(agent) === true;
  }

  /**
   * The person tapped Start on a card that included these agents: under `'first'`, this conversation
   * will not ask about them again. Recorded only in this tier — switching back to `on` restores the
   * tap for everything, and the set is consulted only while the tier is `'first'`.
   */
  private rememberConfirmed(key: ConversationId, items: Item[]): void {
    if (this.deps.config.delegation.confirm !== 'first') return;
    const known = this.confirmedOnce.get(key) ?? new Set<string>();
    for (const item of items) known.add(item.agent);
    this.confirmedOnce.set(key, known);
  }

  /**
   * Clear what was confirmed under a tier the operator has since left. Called by the settings store
   * the moment `/setting delegation` lands — including a change away and back with no `task-new` in
   * between, which `syncConfirmMode` could not see — and by `propose` for a `/reload`.
   */
  forgetConfirmations(): void {
    this.confirmedOnce.clear();
    this.confirmMode = this.deps.config.delegation.confirm;
  }

  /** Forget confirmations when the tier read at this proposal differs from the one they were gathered under. */
  private syncConfirmMode(): void {
    const mode = this.deps.config.delegation.confirm;
    if (this.confirmMode === mode) return;
    this.confirmedOnce.clear();
    this.confirmMode = mode;
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
    // A tier change while the card waited still invalidates the old confirmations before this tap
    // is recorded.
    this.syncConfirmMode();
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
    this.rememberConfirmed(key, items);
    g.items = g.items.filter((item) => !items.includes(item));
    if (g.items.length) void this.putUp(key);
    else this.gathering.delete(key);
    const { opened, failed } = await this.start(here, items);
    await this.announceStarted(here, items.length, opened, failed);
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

  /**
   * What the person is asked to confirm: every sub-task, whole enough to judge.
   *
   * Not the record card's layout, deliberately: this one asks, so it is numbered and quotes the task
   * text, and there is no topic to link yet. Its items already open with the agent's name in bold —
   * the record card's whole fix — and both cards put the model straight after that name, because it
   * is the fact that decides what the part costs.
   */
  private cardText(here: Place, items: Item[]): string {
    const asker = this.deps.registry.boundAgentOf(here.key) ?? 'this agent';
    const lines = [`**${asker} wants to start ${items.length === 1 ? 'a sub-agent' : `${items.length} sub-agents`}** — each in a topic of its own under this one:`];
    items.forEach((item, i) => {
      const def = findAgent(this.deps.config, item.agent);
      const where = def?.host ? ` @ ${def.host}` : '';
      const model = item.model ? ` · model \`${item.model}\`` : '';
      const dir = item.cwd ? ` · \`${item.cwd}\`` : '';
      const title = item.title ? ` — ${item.title}` : '';
      const text = item.text.length > PROPOSAL_TEXT_CHARS ? `${item.text.slice(0, PROPOSAL_TEXT_CHARS - 1)}…` : item.text;
      lines.push('', `${i + 1}. **${item.agent}**${model}${where}${dir}${title}`, ...text.split('\n').map((l) => `> ${l}`));
    });
    lines.push('', 'To change them, say what to change instead of tapping.');
    return lines.join('\n');
  }

  /** Open every sub-task, returning what started and what could not; the caller says so. */
  private async start(here: Place, items: Item[]): Promise<{ opened: OpenedTask[]; failed: string[] }> {
    const header = this.headerOf(here);
    const opened: OpenedTask[] = [];
    const failed: string[] = [];
    // One after another, not all at once: each is a topic created, named and bound, and the order
    // they appear in under the parent is the order on the card. Their turns run in parallel all the
    // same — handTo starts one and returns.
    for (const [i, item] of items.entries()) {
      try {
        const { key, address, title: named } = await this.deps.registry.openTask({
          platform: here.platformId,
          parent: here.address,
          agentId: item.agent,
          text: item.text,
          header,
          ...(item.cwd ? { cwd: item.cwd } : {}),
          ...(item.title ? { title: item.title } : {}),
          ...(item.model ? { model: item.model } : {}),
        });
        this.owed.add(key);
        const title = subjectOf(named);
        const host = findAgent(this.deps.config, item.agent)?.host;
        opened.push({
          title,
          topic: `${here.platformId}:${address.channel}${address.thread ? `/${address.thread}` : ''}`,
          ...(address.thread ? { link: `?t=${address.thread}` } : {}),
          agent: item.agent,
          ...(host ? { host } : {}),
          ...(item.cwd ? { cwd: item.cwd } : {}),
          ...(item.model ? { model: item.model } : {}),
        });
        console.log(`[delegation] ${here.key} opened ${key} for "${item.agent}"`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        failed.push(`- ${i + 1}. ${item.agent}: ${why}`);
        console.warn(`[delegation] ${here.key}: sub-task ${i + 1} for "${item.agent}" could not start: ${why}`);
      }
    }
    return { opened, failed };
  }

  /** The confirmed card's answer: where every sub-task went, and the agent told of any that failed. */
  private async announceStarted(here: Place, total: number, opened: OpenedTask[], failed: string[]): Promise<void> {
    // The same first line and rows as the record card: this is the path the default tier takes on
    // every Start, so a card that read one way here and another way with confirmation off would be
    // two layouts for one fact.
    const asker = this.deps.registry.boundAgentOf(here.key) ?? 'this agent';
    const said = [
      ...startedSection(asker, opened),
      ...(failed.length ? [`${opened.length ? '\n' : ''}Could not start ${failed.length}:`, ...failed] : []),
    ].join('\n');
    await here.adapter
      .sendMessage(here.address, said, { kind: 'dispatch' })
      .catch((e) => console.warn('[delegation] could not say which sub-agents started:', e instanceof Error ? e.message : e));
    if (failed.length) this.tell(here, [`[sub-agent updates] ${failed.length} of ${total} could not be started:`, ...failed], [], failed.length);
  }

  /**
   * Add a started sub-task to the card this conversation will get, and schedule that card.
   *
   * Nothing is waiting on it — the work is already running — so this gathers only long enough to
   * name a burst in one message, exactly as the proposal card does. A person writing in between
   * does not drop it (`personSpoke` only touches `gathering`): the record of what started still
   * belongs in the chat.
   */
  private queueStartedCard(key: ConversationId, opened: OpenedTask[], failed: string[]): void {
    if (!opened.length && !failed.length) return;
    const s = this.started.get(key) ?? { opened: [], failed: [], cancel: () => undefined };
    s.cancel();
    s.opened.push(...opened);
    s.failed.push(...failed);
    s.cancel = this.deps.clock.schedule(() => this.postStartedCard(key), PROPOSAL_GATHER_MS);
    this.started.set(key, s);
  }

  private postStartedCard(key: ConversationId): void {
    const s = this.started.get(key);
    this.started.delete(key);
    const here = this.place(key);
    if (!s || !here) return;
    void here.adapter
      .sendMessage(here.address, this.startedCardText(here, s.opened, s.failed), { kind: 'dispatch' })
      .catch((e) => console.warn('[delegation] could not post the started card:', e instanceof Error ? e.message : e));
  }

  /**
   * What the person sees when confirmation is off: the same list a confirmation card carries, with
   * the topics already open and no buttons. The last line says how to put the gate back.
   *
   * The head and the rows are `startedSection`'s, the same ones the answer to Start uses.
   */
  private startedCardText(here: Place, opened: OpenedTask[], failed: string[]): string {
    const asker = this.deps.registry.boundAgentOf(here.key) ?? 'this agent';
    const lines = startedSection(asker, opened);
    if (!lines.length) {
      lines.push(`**${asker} could not start the sub-agent** — no confirmation is asked here, so it was tried at once:`);
    }
    if (failed.length) lines.push('', `Could not start ${failed.length}:`, ...failed);
    lines.push(
      '',
      this.deps.config.delegation.confirm === 'first'
        ? 'Here confirmation is asked once per agent in each conversation; `/setting delegation on` asks every time.'
        : '`/setting delegation on` makes new sub-tasks wait for Start again.'
    );
    return lines.join('\n');
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
    this.owed.add(c.key);
    return { topic, result: sendResult(how, stopped) };
  }

  /**
   * A sub-agent topic's messages, as the agent that opened it reads them — from the conversation
   * library (`history.db`), the same rows and the same filters `sessions read` uses, so a
   * `--turn`/`--role`/`--since` means the same thing in both commands.
   *
   * `full` and `tail` answer the two ways the default cut fails. A tool bubble in accumulate mode is
   * one message holding the turn's commands, so a head cut shows the oldest of them and hides what it
   * is doing now; `tail` keeps the end, `full` raises the cap. The total budget is the guard against
   * a `--full` read of a hundred messages: the newest whole messages are kept and the rest is said
   * in `note`, never silently dropped.
   */
  private read(here: Place, a: Extract<TaskAction, { kind: 'task-read' }>): TaskReadResult {
    const c = this.child(here, a.topic);
    const history = this.deps.history;
    if (!history) {
      throw new Error('the conversation library is unavailable, and task-read reads it; `task-status` shows the live turn');
    }
    // A topic that has not run a turn yet has no session row, and the store would answer with
    // "no conversation" — which reads like a wrong topic id rather than a topic that just started.
    if (!history.sessionOf(c.key)) {
      return { topic: a.topic, messages: [], note: 'nothing has been recorded in this topic yet — no turn has run there' };
    }
    if (a.reply) return this.replyOfTurn(c, a.topic, history);
    const current = this.deps.currentContext;
    const result = history.read(c.key, taskReadOptions(a, current));
    const { cap, total } = readCuts(a);
    const shaped = result.messages.map((m) => ({
      id: m.id,
      role: roleOf(m.role),
      at: m.at,
      text: clip(m.text, cap, a.tail),
      ...(m.turn !== undefined ? { turn: m.turn } : {}),
      ...(m.outcome !== undefined ? { outcome: m.outcome } : {}),
    }));
    let used = 0;
    let from = shaped.length;
    for (let i = shaped.length - 1; i >= 0; i--) {
      const size = shaped[i]!.text.length;
      if (used + size > total && from !== shaped.length) break;
      used += size;
      from = i;
    }
    const dropped = from;
    const notes = [
      result.note,
      dropped > 0
        ? `the ${dropped} oldest of ${shaped.length} messages were left out to keep this under ` +
          `${total} characters; ask for fewer messages (--limit) or fewer lines (--tail) to fit the rest`
        : undefined,
    ].filter((n): n is string => n !== undefined);
    // Only a read scoped to ONE turn has a record worth carrying: it is where a failed turn's whole
    // error lives, and what the update card points at when it cuts the error it quotes.
    const record = a.turn !== undefined ? history.turnRecord(c.key, a.turn, current) : undefined;
    return {
      topic: a.topic,
      messages: shaped.slice(from),
      ...(record ? { turn: turnRecordOf(record) } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  }

  /**
   * `--reply`: the last turn that ended normally, and the reply it ended on — whole, because the
   * card that sent the parent here carried only its first 4,000 characters.
   *
   * The turn is selected the way `sessions read --turn done` selects it (this agent, this
   * generation, so a `/new` in the topic does not answer with the answer it discarded). The reply
   * is the last thing the agent said in that turn — the segment the turn ended on.
   */
  private replyOfTurn(
    c: Place,
    topic: string,
    history: Pick<HistoryStore, 'read' | 'turnRecord' | 'sessionOf'>
  ): TaskReadResult {
    const record = history.turnRecord(c.key, 'done', this.deps.currentContext);
    if (!record) {
      return {
        topic,
        messages: [],
        note:
          'no turn in this topic has ended normally in the current generation yet — nothing to reply with; ' +
          '--turn last is not scoped to the generation, so after /new it may show the turn before the reset',
      };
    }
    const read = history.read(c.key, { turn: String(record.turn), role: 'agent' });
    const last = read.messages[read.messages.length - 1];
    if (!last) return { topic, messages: [], note: `turn ${record.turn} ended normally without a reply` };
    return { topic, messages: [], reply: { turn: record.turn, at: last.at, text: last.text } };
  }

  /** One sub-agent topic in detail: its live row, its last tool calls, and its last reply. */
  private status(here: Place, topic: string): TaskStatusResult {
    const c = this.child(here, topic);
    const live = this.deps.registry.progressOf(c.key);
    const reply = this.deps.registry.replyOf(c.key)?.text ?? '';
    return {
      task: this.row(c),
      recent: (live?.recent ?? []).map((t) => ({ at: new Date(t.at).toISOString(), tool: t.tool, detail: t.detail })),
      reply: previewOf(reply),
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

  /**
   * End the agent process behind this conversation and every sub-agent topic under it — the web
   * UI's "End agent" (`PlatformAdapter.useTopicKill`). `/kill` applied to a tree.
   *
   * The walk is `stopOpened`'s, for the same reason: the relation is the platform's record
   * (`childrenOf`), and a topic acts only on the topics under it. Unlike `/stop`, which records a
   * stop and leaves the process up, each conversation here goes through `killConversation`: a turn
   * running there is interrupted, a question is called off, and the child process is disposed.
   * The conversation itself is kept in every case.
   *
   * `ended` runs BEFORE the first kill, and that ordering is load-bearing. A turn interrupted here
   * ends as 'stopped' and tells nobody (TurnOutcomes), but a turn that ended NORMALLY a moment
   * earlier may still be waiting in `updates` for its card — and that card runs a turn in the
   * parent this call is about to end, waking it again. Silencing first means a turn that ends
   * during the kills already finds no mark that makes it news.
   *
   * Answers root first, one row per topic the platform's record connects. An address this process
   * knows nothing about answers no rows, which the page reads as "nothing to end".
   */
  endTopic(key: ConversationId): TopicKillResult[] {
    const here = this.place(key);
    if (!here) return [];
    const tree = this.treeOf(here);
    this.ended(tree.map((p) => p.key));
    const results: TopicKillResult[] = [];
    // Children before the parent: an interrupt of the parent's own turn cannot then race the
    // children it was waiting on. The answer is put back in root-first order below.
    for (const c of [...tree].reverse()) {
      const outcome = this.deps.registry.killConversation(c.key);
      results.push({
        topic: c.address.thread ?? c.address.channel,
        outcome: outcome === 'no-child' || outcome === 'unresumable' ? outcome : 'ended',
      });
    }
    return results.reverse();
  }

  /** `here` and every topic under it, depth first, each once. */
  private treeOf(here: Place): Place[] {
    const out: Place[] = [];
    const seen = new Set<ConversationId>();
    const walk = (p: Place): void => {
      if (seen.has(p.key)) return;
      seen.add(p.key);
      out.push(p);
      for (const child of this.childrenOf(p)) walk(child);
    };
    walk(here);
    return out;
  }

  /**
   * These conversations are ending; nothing they did is the news of the agent above them.
   *
   * A turn the person stops is already silent — TurnOutcomes records 'stopped' and calls nobody —
   * but `updates` and `owed` outlive a turn: a card gathered for CARD_DELAY_MS, or a child marked
   * as worth reporting when its next end comes. Firing after the parent's process was ended would
   * run a turn in it and bring it back, the one thing "End agent" must not do. Dropping the ids
   * from both, and cancelling a card left with nothing to say, keeps a kill a kill.
   *
   * Not a permanent mute: a person who writes in that topic later is still reported to its parent
   * (personWrote re-marks it). This drops only what was queued when the topic was ended.
   */
  ended(ids: Iterable<ConversationId>): void {
    const gone = new Set(ids);
    for (const id of gone) {
      this.owed.delete(id);
      this.said.delete(id);
    }
    for (const [parent, u] of this.updates) {
      for (const id of gone) u.children.delete(id);
      if (u.children.size === 0) {
        u.cancel();
        this.updates.delete(parent);
      }
    }
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
    if (!this.owed.has(id)) return;
    const parent = this.parentOf(id);
    if (!parent) return;
    const u = this.updates.get(parent.key) ?? {
      children: new Set<ConversationId>(),
      cancel: this.deps.clock.schedule(() => this.sendUpdates(parent.key), CARD_DELAY_MS),
    };
    u.children.add(id);
    this.updates.set(parent.key, u);
  }

  /**
   * The person's own messages reached the agent in conversation `id` (TurnRunnerDeps.recordPersonWords).
   * In a sub-agent's topic that turn becomes the parent's news, and the words go on its card.
   *
   * Only the topic's own parent is told: in a topic a sub-agent opened in turn, the person's words
   * reach that sub-agent, never the agent above it. A topic with no parent — the person's own, or one
   * whose parent was deleted — keeps nothing.
   */
  personWrote(id: ConversationId, words: PersonWords): void {
    if (!words.text.trim() && words.attachments.length === 0) return;
    const parent = this.parentOf(id);
    if (!parent) return;
    const s = this.said.get(id) ?? { text: '', total: 0, attachments: [], moreAttachments: 0, turns: [], unnumbered: false };
    if (words.text) {
      const sep = s.total > 0 ? '\n' : '';
      // The head stays the head: once it is full, later words count toward `total` and nothing else.
      s.text = `${s.text}${sep}${words.text}`.slice(0, CARD_SAID_CHARS);
      s.total += sep.length + words.text.length;
    }
    const room = Math.max(0, SAID_ATTACHMENTS_SHOWN - s.attachments.length);
    s.attachments.push(...words.attachments.slice(0, room));
    s.moreAttachments += Math.max(0, words.attachments.length - room);
    if (words.turn === undefined) s.unnumbered = true;
    else if (s.turns[s.turns.length - 1] !== words.turn) s.turns.push(words.turn);
    this.said.set(id, s);
    this.owed.add(id);
    console.log(`[delegation] ${id}: the person wrote in a sub-agent's topic; ${parent.key} is told when the turn ends`);
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
      // What the person wrote is kept for that card.
      if (stage === 'working' || stage === 'idle' || stage === 'retrying') continue;
      // A question leaves the turn open; an end closes it.
      if (stage !== 'answer') this.owed.delete(c.key);
      const said = this.said.get(c.key);
      this.said.delete(c.key);
      const row = this.row(c);
      entries.push(this.entry(c, row, stage, said));
      shown.push(`🔔 ${row.title || row.topic} (${row.agent}) — ${describeStage(stage)}${said ? ' after you wrote there' : ''}${row.line ? `: ${row.line}` : ''}`);
    }
    if (entries.length === 0) return;
    const visible = entries.slice(0, CARD_MAX_ENTRIES);
    const extra = entries.length - visible.length;
    const folded = shown.slice(0, CARD_MAX_ENTRIES);
    if (extra) folded.push(`🔔 ${extra} more — see talkcode tasks`);
    this.tell(here, this.card(`[sub-agent updates] ${this.tally(here)}`, visible, extra), folded, entries.length);
  }

  /**
   * One sub-agent on the card: where it is, how it stands, and what it said — after what the person
   * wrote to it directly, when they did.
   *
   * The body is the whole of what the sub-agent said — the reply the turn ended on, the question it
   * is waiting on, the error the turn failed with — because the parent agent is meant to act on the
   * card without opening the topic. A reply is not accompanied by its first line: that line is
   * already in it. The person's words come first because they are what the reply answers.
   */
  private entry(c: Place, row: TaskRow, stage: TopicStage, said: Said | undefined): CardEntry {
    const quote = this.quoteOf(c, row, stage);
    return {
      topic: row.topic,
      head: `- topic ${row.topic} · "${row.title}" · ${row.agent}${row.cwd ? ` in ${row.cwd}` : ''} · ${describeStage(stage)}`,
      ...(said ? { said: saidQuote(said) } : {}),
      ...(quote ? { quote } : {}),
      ...(row.link ? { link: row.link } : {}),
    };
  }

  /** What this stage makes worth quoting: the question, the reply or the error. */
  private quoteOf(c: Place, row: TaskRow, stage: TopicStage): CardQuote | undefined {
    if (stage === 'answer') {
      const text = this.deps.questionOf?.(c.key) ?? row.line;
      return text ? { label: 'question', text, total: text.length } : undefined;
    }
    if (stage !== 'review' && stage !== 'failed') return undefined;
    const label = stage === 'review' ? 'reply' : 'failure';
    const kept = stage === 'review' ? this.deps.registry.replyOf(c.key) : this.deps.registry.failureOf(c.key);
    if (kept) {
      return { label, text: kept.text, total: kept.total, ...(kept.turn !== undefined ? { turn: kept.turn } : {}) };
    }
    // A reply's first line is not a stand-in for the reply. The text is absent either because the
    // turn ended without one (turn-outcomes deletes an empty reply) or because a released
    // scheduled conversation dropped it; "no reply" is true of both and claims less than either.
    if (stage === 'review') {
      const text = 'no reply';
      return { label, text, total: text.length };
    }
    return row.line ? { label, text: row.line, total: row.line.length } : undefined;
  }

  /**
   * The card's lines, with the sub-agent text cut to what one card can carry.
   *
   * Headings and links are the frame and are counted, but the frame is bounded: at most
   * CARD_MAX_ENTRIES entries are listed, and any beyond that are one line pointing at
   * `talkcode tasks`. Within that frame, quote blocks share CARD_TOTAL_CHARS and one may take at
   * most CARD_ITEM_CHARS (CARD_SAID_CHARS for the person's words). Every later quote's notice is
   * reserved before an earlier one takes the rest — the result under the person's words as much as
   * the entries below — so a quote keeps at least its notice. The frame is not itself capped by
   * CARD_TOTAL_CHARS — twenty very long titles or cwds can still fill it — and when it does,
   * blocks are dropped and the card can pass the budget on the headings alone.
   */
  private card(header: string, entries: CardEntry[], extra: number): string[] {
    const lines = [header];
    const tail = extra ? `- ${extra} more sub-agent${extra === 1 ? '' : 's'} — see talkcode tasks` : '';
    // Overcounts the joined string by one newline; the slack is what keeps it inside the budget.
    const frame = entries.reduce(
      (n, e) => n + e.head.length + 1 + (e.link ? `  link: ${e.link}`.length + 1 : 0),
      header.length + 1 + (tail ? tail.length + 1 : 0)
    );
    let left = CARD_TOTAL_CHARS - frame;
    const needs = entries.flatMap((e) => quotesOf(e).map((q) => quoteNeed(q, e.topic)));
    let next = 0;
    for (const e of entries) {
      lines.push(e.head);
      for (const q of quotesOf(e)) {
        next++;
        const reserved = needs.slice(next).reduce((n, need) => n + need, 0);
        const block = quotedBlock(q, e.topic, Math.max(0, left - reserved));
        if (block) {
          lines.push(block);
          left -= block.length + 1;
        }
      }
      if (e.link) lines.push(`  link: ${e.link}`);
    }
    if (tail) lines.push(tail);
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
        .sendMessage(here.address, shown.join('\n'), { kind: 'report' })
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

  /**
   * A conversation's name: the store's own record first, `channels` after it.
   *
   * The store is the only source that knows a name written a moment ago. `channels` lists the newest
   * 200 topics and sorts a topic with no `lastAt` last (core/channel-list.ts), so a topic whose first
   * turn has not run — a sub-agent opened seconds ago — falls out of it and the caller was left with
   * `web#main#5e94945d` where the title belonged. `channels` stays for the records older than the
   * title field, and for a channel root, which belongs to no single conversation.
   */
  private titleOf(id: ConversationId, place: { platformId: string; address: ConversationAddress }): string {
    const named = this.deps.registry.conversationTitle(id);
    if (named) return named;
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
 * What `task-new` answers when confirmation is off: the sub-task is already running, so the answer
 * says where — never that it waits. A failure is the honest exception, and it is returned to the
 * agent here rather than through an update, because the agent is still in the turn that asked.
 */
function startedResult(opened: OpenedTask[], failed: string[]): string {
  const parts: string[] = [];
  const first = opened[0];
  if (first) {
    parts.push(`Started in topic ${first.topic} ("${first.title}") — it is running now.`);
    parts.push('The person sees a card listing what started; you are told here as it finishes, fails or asks something.');
  }
  if (failed.length) parts.push(`Could not start: ${failed.map((f) => f.replace(/^- \d+\. /, '')).join('; ')}`);
  return parts.join(' ');
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
 * One quote as the card shows it, cut after `cut` characters of its head.
 *
 * The notice is part of what the card says, not decoration: a parent agent that cannot tell a cut
 * review from a short one will act on half a conclusion, which is the bug the whole quote is for.
 * No harness mechanism carries "this is truncated" beside a message — the note is the gateway's
 * only way to say it — so it is the one line added to the prompt, and only when something was cut.
 */
function renderQuote(q: CardQuote, topic: string, cut: number): string {
  // Empty only for the person's words when they sent files and no text: the heading names the files.
  const body = quoteBody(q, topic, cut);
  return `  ${q.heading ?? q.label}${body ? `: ${body}` : ''}`.replace(/\n/g, '\n  ');
}

/** The quoted text itself, cut after `cut` characters, with its notice when anything was left out. */
function quoteBody(q: CardQuote, topic: string, cut: number): string {
  return q.total <= q.text.length && cut >= q.total ? q.text : `${q.text.slice(0, cut)}${cutNote(q, topic, cut)}`;
}

/** The most of one quote's body a card carries. */
function capOf(q: CardQuote): number {
  return q.label === 'person' ? CARD_SAID_CHARS : CARD_ITEM_CHARS;
}

/** The quotes an entry carries, in the order the card shows them: the person's words, then the result. */
function quotesOf(e: CardEntry): CardQuote[] {
  return [e.said, e.quote].filter((q): q is CardQuote => q !== undefined);
}

/**
 * The person's words as the card quotes them. The heading says whose they are and that they went to
 * the sub-agent directly — not through the parent, which otherwise reads a reply to something it never
 * asked. Attachments go in the heading, by name, so a cut of the text cannot take them with it; their
 * contents stay in the topic, as the library keeps them.
 */
function saidQuote(s: Said): CardQuote {
  const more = s.moreAttachments ? ` and ${s.moreAttachments} more` : '';
  const attached = s.attachments.length ? `, attaching ${s.attachments.join(', ')}${more}` : '';
  const turn = s.turns.length === 1 && !s.unnumbered ? s.turns[0] : undefined;
  return {
    label: 'person',
    heading: `the person wrote to it directly${attached}`,
    text: s.text,
    total: s.total,
    ...(turn !== undefined ? { turn } : {}),
  };
}

/**
 * What a cut leaves out, and where the rest is.
 *
 * A reply and a failure name the turn they were quoted from, by number. "The last turn" is a
 * different turn by the time the parent reads it whenever the topic runs again — a background
 * burst is the usual case — and `--reply` would then answer with the burst instead of the reply the
 * card quoted. A turn number is the same turn however much ran after it.
 *
 * A question names no turn and no command: it is the ask waiting on the person, which the gateway
 * sends itself, so it is not a row the library keeps and `task-read` cannot show it. The topic is
 * where it waits.
 *
 * The person's words are the user rows of the turn they went into; words spread over several turns
 * are every user row there, which the newest-first `--full` read keeps.
 */
function cutNote(q: CardQuote, topic: string, cut: number): string {
  return `\n…[${q.total} chars total, cut at ${cut}; ${whereTheRestIs(q, topic)}]`;
}

function whereTheRestIs(q: CardQuote, topic: string): string {
  switch (q.label) {
    case 'question':
      return 'the question is waiting in this topic for the person to answer it';
    case 'person':
      return q.turn !== undefined
        ? `all of it is in this topic's turn ${q.turn} — task-read ${topic} --turn ${q.turn} --role user --full`
        : `all of it is in this topic — task-read ${topic} --role user --full`;
    case 'reply':
      return q.turn !== undefined
        ? `the rest is in this topic's turn ${q.turn} — task-read ${topic} --turn ${q.turn} --full`
        : `the whole reply is in this topic — task-read ${topic} --reply`;
    case 'failure':
      return q.turn !== undefined
        ? `the whole error is in this topic's turn ${q.turn} — task-read ${topic} --turn ${q.turn}`
        : `the whole error is in this topic's record — task-read ${topic} --turn last`;
    default: {
      const _exhaustive: never = q.label;
      return String(_exhaustive);
    }
  }
}

/**
 * The library options `task-read`'s flags name.
 *
 * The default 10 is "the newest 10 messages", so it applies only to an unfiltered read: a
 * `--turn`/`--turns` read is about those turns, and a `--role`/`--grep` read is a search over the
 * whole log — cutting either at ten rows would answer a question nobody asked. `--since` resumes
 * forward from a cursor and carries no limit at all (the CLI refuses the two together).
 */
function taskReadOptions(
  a: Extract<TaskAction, { kind: 'task-read' }>,
  current?: (key: string) => { agent: string; generation: number } | undefined
): HistoryReadOptions {
  const filtered =
    a.role !== undefined || a.turn !== undefined || a.turns !== undefined || a.grep !== undefined;
  const limit = a.limit ?? (filtered ? undefined : 10);
  return {
    ...(a.since !== undefined ? { since: a.since } : limit !== undefined ? { limit } : {}),
    ...(a.role !== undefined ? { role: a.role } : {}),
    ...(a.turn !== undefined ? { turn: a.turn } : {}),
    ...(a.turns !== undefined ? { turns: a.turns } : {}),
    ...(a.grep !== undefined ? { grep: a.grep } : {}),
    ...(current ? { current } : {}),
  };
}

/**
 * The text cuts one `task-read` answer uses: per message, and in all.
 *
 * A card points at one turn's reply with `--turn <n> --full` and promises the rest of that
 * message, so a single-turn `--full` read is bounded by the library's own answer budget instead of
 * the 20k/80k that keeps a `--full` log readable — a 30k reply would otherwise be cut twice, once
 * by each. `--turns` is not this case: it is a log read, and keeps the smaller bound.
 */
function readCuts(a: Extract<TaskAction, { kind: 'task-read' }>): { cap: number; total: number } {
  if (a.turn !== undefined && a.full === true) return { cap: READ_CHAR_BUDGET, total: READ_CHAR_BUDGET };
  return a.full || a.tail !== undefined
    ? { cap: READ_FULL_CHARS, total: READ_TOTAL_CHARS }
    : { cap: READ_CHARS, total: READ_TOTAL_CHARS };
}

/** A turn's record as `task-read` returns it: the failure detail only when there is one. */
function turnRecordOf(record: HistoryTurnRow): NonNullable<TaskReadResult['turn']> {
  return {
    turn: record.turn,
    at: record.at,
    outcome: record.outcome,
    agent: record.agent,
    ...(record.detail ? { detail: record.detail } : {}),
  };
}

/** The library's three roles, narrowed for the result (writes are typed; nothing else is stored). */
function roleOf(role: string): 'user' | 'agent' | 'tool' {
  return role === 'user' || role === 'tool' ? role : 'agent';
}

/** The least a quote needs to say anything at all: its cut notice (or its whole text, if short). */
function quoteNeed(q: CardQuote, topic: string): number {
  const full = renderQuote(q, topic, Math.min(q.text.length, q.total));
  const noteOnly = renderQuote(q, topic, 0);
  // +1 for the newline the joined card puts after it.
  return Math.min(full.length, noteOnly.length) + 1;
}

/**
 * One quote block no longer than `budget` and no longer than its cap (capOf), cutting the text as
 * far as both allow.
 *
 * Empty when even the notice does not fit: CARD_TOTAL_CHARS is a hard cap. The reservation in
 * `card` means that only happens when the frame itself has filled the card.
 */
function quotedBlock(q: CardQuote, topic: string, budget: number): string {
  if (budget <= 0) return '';
  const cap = capOf(q);
  const fits = (cut: number): boolean =>
    renderQuote(q, topic, cut).length <= budget && quoteBody(q, topic, cut).length <= cap;
  let lo = 0;
  let hi = Math.min(q.text.length, cap);
  let best = fits(0) ? renderQuote(q, topic, 0) : '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = renderQuote(q, topic, mid);
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** `task-status` keeps its old one-value preview; the card and `task-read` carry the whole reply. */
function previewOf(text: string): string {
  return text.length > STATUS_REPLY_CHARS ? `${text.slice(0, STATUS_REPLY_CHARS - 1)}…` : text;
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

/**
 * The first line and one row per started sub-agent — the shape both cards use, so the answer to
 * Start and the record card cannot drift apart.
 *
 * Who got the work leads: the name is what a person scans a card for, and the old row put the topic
 * first, leaving the agent in the middle of a line of ids. The first line names every started agent
 * once (several parts can go to one agent, so the list is deduplicated while the count is not); each
 * row of a batch names its own again, because a row has to be readable on its own. A lone part is
 * already named by the first line, so its row leaves the name out — repeating it there is the same
 * word twice in two lines.
 */
function startedSection(asker: string, opened: OpenedTask[]): string[] {
  if (!opened.length) return [];
  const names = [...new Set(opened.map((o) => o.agent))].join(', ');
  const many = opened.length !== 1;
  // "started by cc" under a line that already names cc reads as a stutter — in a batch that mixed
  // agents, the asker is still one of the names.
  const by = opened.some((o) => o.agent === asker) ? '' : ` started by ${asker}`;
  const head = `**${names}** — ${many ? `${opened.length} sub-agents` : 'a sub-agent'}${by}, ${
    many ? 'each in a topic of its own' : 'in a topic of its own'
  } under this one:`;
  return [head, ...opened.map((t) => startedRow(t, many))];
}

/** One started sub-agent's row; `lead` puts its name first, for a card carrying several parts. */
function startedRow(t: OpenedTask, lead: boolean): string {
  const model = t.model ? `model \`${t.model}\`` : '';
  // A host names its own agents `<id>@<host>` (daemon/pods.ts), so that id already says the machine.
  const machine = t.host && !t.agent.endsWith(`@${t.host}`) ? ` @ ${t.host}` : '';
  const dir = t.cwd ? `\`${t.cwd}\`` : '';
  const name = t.link ? `[${t.title}](${t.link})` : t.title;
  // The machine hangs off whichever of name/model comes first, so no row ever starts with "@ host".
  const fields = lead
    ? [`**${t.agent}**${model ? '' : machine}`, model ? `${model}${machine}` : '', name, dir, t.topic]
    : [`${name}${model ? '' : machine}`, model ? `${model}${machine}` : '', dir, t.topic];
  return `- ${fields.filter(Boolean).join(' · ')}`;
}

/** `/home/user/workspace/x` → `~/workspace/x`, for a column that is read, not used. */
function shortenHome(p: string): string {
  return p.replace(/^\/(home\/[^/]+|root)(?=\/|$)/, '~');
}
