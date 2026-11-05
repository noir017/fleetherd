import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import { looksLikeCommand } from './routing.js';
import { addressOf, sameAddress, type ConversationAddress } from '../core/conversation.js';
import type {
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  ConversationId,
  ElicitAnswer,
  PermissionAnswer,
  InboundMessage,
  QuotaPool,
  SteerOutcome,
  ToolEvent,
} from '../types.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, AgentUsage, FollowUpSink, TurnImage } from './agent.js';
import { StreamBuffer } from '../core/stream-buffer.js';
import { ToolRenderer } from '../core/tool-renderer.js';
import { describeOutboundError, MessageNotEditableError } from '../core/outbound-errors.js';
import { outboundLane } from './paced-adapter.js';
import { formatRuntimeFooter } from '../core/runtime-footer.js';
import { ingestAttachments, type AttachmentInput } from '../core/attachment-ingest.js';
import { createAttachmentIngestDeps, remoteAttachmentSave } from './attachment-io.js';
import { remoteHosts } from './remote-hosts.js';
import type { HistoryEvent } from '../history/record.js';
import { kindForTrigger, toolLine } from '../history/record.js';
import type { HistoryKind, HistoryTurnEnd, HistoryTurnStart, HistoryTrigger } from '../history/store.js';

/**
 * The sender a scheduled run's message carries (ConversationRegistry.runScheduledPrompt). Exported
 * so the one place that writes it and the one that reads it — a scheduled turn is unattended, see
 * runTurn — cannot drift apart.
 */
export const SCHEDULED_SENDER = 'schedule';

/**
 * The sender an automatic continue carries (hooks.turnFailed, see turn-outcomes.ts). Distinct from
 * SCHEDULED_SENDER on purpose: a continue is the operator's own word sent on their behalf, and the
 * person may well be watching — so a `permissions: ask` agent still asks them, where a scheduled run
 * is answered as unattended.
 */
export const CONTINUE_SENDER = 'continue';

/**
 * The sender of what another conversation's agent hands a sub-agent (task-new once the person
 * confirmed it, task-send — daemon/delegation.ts). Attended like CONTINUE_SENDER: the person is
 * there, in the topic that opened this one, and a `permissions: ask` agent still asks them.
 */
export const DELEGATE_SENDER = 'delegated';

/**
 * The sender of a `[sub-agent updates]` card (daemon/delegation.ts), run as a turn in the conversation
 * that opened the sub-agents. Attended like DELEGATE_SENDER; set apart from it because such a turn
 * names nothing — it is the gateway reporting, not anyone saying what the topic is about, and a
 * `/super` topic, whose opening message is a command, would otherwise be named after the first card.
 */
export const UPDATE_SENDER = 'sub-agent-updates';

/**
 * How much of a failed turn's reason the ❌ notice in its topic carries.
 *
 * The notice is a chat line, so it keeps the opening only. The whole error is in the turn's record
 * (`turns.detail`), which the update card points at when it cuts its own quote — the card itself
 * carries at most CARD_ITEM_CHARS.
 */
export const FAILURE_NOTICE_CHARS = 300;

/**
 * The job a command carries, for the one command that carries one: `/super <job>` (the bundled
 * `super` skill — daemon/skill-link.ts BUNDLED_SKILLS) is what its topic is about, where `/model
 * opus` or `/compact` names nothing.
 */
export function jobInCommand(text: string): string | undefined {
  const m = /^\/super\s+([\s\S]+)$/.exec(text.trim());
  return m?.[1]?.trim() || undefined;
}

/**
 * What started a turn, from the sender the daemon put on its batch. The senders are the ones
 * the gateway actually uses (SCHEDULED_SENDER and the two delegation senders above, plus the
 * automatic continue) — a batch that is not all one of them is a person's, which is also what a
 * mixed batch has to be: someone typed into a conversation, and whoever else wrote there wrote
 * into the same turn.
 *
 * A background burst is not a batch at all; it is reported as `background` by the follow-up
 * sink, which opens a turn of its own when it starts rendering.
 */
export function historyTriggerOf(batch: InboundMessage[]): HistoryTrigger {
  const user = batch[0]?.conversation.user;
  if (user !== undefined && batch.every((m) => m.conversation.user === user)) {
    switch (user) {
      case SCHEDULED_SENDER:
        return 'schedule';
      case CONTINUE_SENDER:
        return 'continue';
      case DELEGATE_SENDER:
        return 'delegate';
      case UPDATE_SENDER:
        return 'update';
      default:
        break;
    }
  }
  // The two delegation senders are the one pair the merger can put in the same batch (a task and
  // the gateway's update card arriving together). Both are subagent work; name the batch after
  // the task, which is the half that carries what someone asked for.
  if (batch.length > 0 && batch.every((m) => m.conversation.user === DELEGATE_SENDER || m.conversation.user === UPDATE_SENDER)) {
    return batch.some((m) => m.conversation.user === DELEGATE_SENDER) ? 'delegate' : 'update';
  }
  return 'person';
}

/**
 * The attachment names of a batch, for the library. The prompt the agent received has their
 * CONTENTS inlined (or their saved paths); what the library keeps is only what the person sent,
 * by name — an index of the gateway's conversation should not become a second copy of every file
 * that passed through it.
 */
function attachmentNames(batch: InboundMessage[]): string[] {
  const names: string[] = [];
  for (const m of batch) {
    for (const a of m.attachments ?? []) names.push(a.name ?? 'attachment');
  }
  return names;
}

/**
 * The handlers a turn hands the agent. A scheduled run has nobody watching for a permission
 * request, so it is answered as `permissions: auto` would — asking would only hold the run for the
 * ask timeout and then decline it.
 */
function turnHandlers(batch: InboundMessage[], handlers: AgentStreamHandlers): AgentStreamHandlers {
  const unattended = batch.every((m) => m.conversation.user === SCHEDULED_SENDER);
  return unattended ? { ...handlers, onPermission: async () => ({ kind: 'unattended' }) } : handlers;
}

/**
 * Introduces a message that was NOT asked for in the moment — the agent reporting back on work
 * that outlived its turn.
 *
 * Worth a bubble of its own because without it the message is unattributable: it arrives with no
 * message of the user's above it, minutes or hours after the exchange it belongs to, and reads like
 * the bot talking to itself. Deliberately not configurable — a gateway that could be set to deliver
 * background output indistinguishably from a reply would just be recreating the confusion.
 */
const FOLLOW_UP_MARKER = '⏱ background update — picking up where the last reply left off';

/**
 * How long the body text waits for a tool bubble to take its place in the chat.
 *
 * Bought for reading order: without it the bubble for a tool can be posted below the text of the
 * segment that came after it, because the painter runs one write behind this chain (see
 * ToolRenderer.placed). Paid at most once per bubble, and it overlaps the tool's own execution —
 * the wait starts the moment the tool is registered, and the tool has not run yet.
 *
 * A constant rather than a setting, on the rule in the config README: it is a deadline nobody would
 * tune, and the two ends of the range are not a preference. Too short and it buys nothing; too long
 * and a chat the platform has paused holds the reply hostage to a progress bubble — which is the
 * failure the asynchronous painter was introduced to end. Two seconds is comfortably more than a
 * round trip on every platform here and comfortably less than a user waiting on an answer notices.
 * Past it, the reply goes on and the bubble lands wherever it lands: order is the thing worth
 * giving up, never the answer.
 */
const BUBBLE_PLACEMENT_WAIT_MS = 2_000;

/**
 * Collaborator capabilities TurnRunner needs (DI interface).
 *
 * Deliberately exposes only what running one turn needs, not the whole ConversationRegistry — to
 * avoid bidirectional coupling. The registry remains the sole owner of state/lifecycle; this
 * borrows read-only views (agentIdOf / tokenFor / modelOverride) and a small write entry
 * (setLane).
 */
export interface TurnRunnerDeps {
  /** Get this conversation's stable token (reverse-command auth + locate). */
  tokenFor(id: ConversationId): string;
  /** Get the agent currently bound to this conversation (falls back to routing.default). */
  agentIdOf(id: ConversationId): string;
  /** Read this conversation's model override (/model); undefined means use agent.model. */
  getModelOverride(id: ConversationId): string | undefined;
  /**
   * The directory this conversation's turn actually runs in (`/cd`, else `agents[].cwd`).
   *
   * Read per turn rather than taken from config, because after a `/cd` the two disagree and the
   * footer's job is to name what is serving THIS turn. Undefined only when no agent def can be
   * resolved, in which case the footer falls back to the configured value it always used.
   */
  getWorkdir?(id: ConversationId): string | undefined;
  /**
   * Record the lane this turn is running in; everything answered on this conversation's behalf
   * locates it by this — reverse commands, a late harness title, background output.
   *
   * Not cleared at turn end, and that is the point: a conversation does not stop being in a place
   * just because nothing is running there. See ConversationState.lane.
   */
  setLane(id: ConversationId, address: ConversationAddress, platformId: string): void;
  /**
   * Register an auto-created thread as belonging to an existing conversation.
   *
   * autoThread opens a thread mid-turn and moves the reply into it. Without this the user's first
   * message typed inside that thread would identify as a NEW conversation and start an empty one —
   * the agent would answer its own follow-up from scratch. The registry keeps an alias so the
   * thread continues the conversation that opened it, agent and context intact.
   */
  adoptThread?(id: ConversationId, address: ConversationAddress, platformId: string): void;
  /**
   * Record the latest context-usage snapshot for a conversation.
   *
   * The footer reads usage off the per-turn ref, which dies with the turn — but `/context` is asked
   * BETWEEN turns, so the last snapshot has to outlive the turn that produced it. Same numbers, one
   * writer: the harness's own `usage_update`, never a guess.
   */
  recordUsage?(id: ConversationId, usage: AgentUsage): void;
  /**
   * Record that a tool call started in this conversation's turn.
   *
   * The live half of a sub-agent's status (daemon/turn-progress.ts): `TurnOutcomes` only learns what
   * a turn did when it ends, and a turn that is 150 tool calls deep is exactly when the agent that
   * opened it needs to see what it is doing. Called synchronously from `onToolStart`, before the
   * rendering chain — a status read must not queue behind a rate-limited chat.
   */
  recordTool?(id: ConversationId, evt: ToolEvent): void;
  /**
   * Record what the harness reported about the session that is not usage — the serving model, its
   * effort, its quota pools — for a surface that shows them between replies (the web UI's status
   * strip, via the registry's StatusBoard).
   *
   * The footer reads the same facts off the per-turn ref and needs none of these. They exist because
   * the ref dies with the turn, and a status strip is read after it — the same reason recordUsage
   * does. Optional, so a test runner that records nothing needs no stubs.
   */
  recordModel?(id: ConversationId, model: string): void;
  recordEffort?(id: ConversationId, effort: string | undefined): void;
  recordQuota?(id: ConversationId, pools: QuotaPool[]): void;
  /**
   * Record that a turn ran to completion here.
   *
   * `/context` has to tell two empty states apart, because they call for opposite advice: nothing has
   * run yet (send a message and ask again), versus the harness ran and reported no `usage_update` at
   * all — which for a given harness+model is permanent, so asking again is the one thing that cannot
   * help. Without this flag both read as "no numbers yet".
   *
   * Only a turn that ENDED NORMALLY counts: an interrupted turn may simply not have reached its
   * usage snapshot, and a failed one never got near it.
   */
  recordTurnComplete?(id: ConversationId): void;
  /**
   * Name this conversation after the opening message, once.
   *
   * A dep rather than a hook because the answer needs the conversation's address and the store,
   * both of which live in the registry — which is also where the "only if nothing has named it
   * yet" rule lives, so this may be called at the start of every turn and will act on at most one
   * of them.
   *
   * The seed is the user's raw text, NOT a name: the registry summarises it (see core/title-namer).
   * Passing it whole is the point — a name generated from a pre-truncated seed can only ever be a
   * rewording of the first line.
   *
   * Never awaited by the turn, and called before the agent runs rather than after it: the model
   * call and the rename happen alongside the turn, so the topic takes its name as soon as the name
   * exists instead of when the work finishes. A slow or failing editForumTopic must not delay a
   * single character of the answer.
   */
  nameConversation?(id: ConversationId, seed: string): void;
  /**
   * Where to put output that arrives with no turn running (background work reporting in), or
   * undefined when this conversation has never had a turn and so has no lane to write to.
   *
   * The whole point of a follow-up is that it happens after the turn, so this is the conversation's
   * lane (see setLane) rather than anything scoped to a running turn.
   */
  followUpTarget?(id: ConversationId): { address: ConversationAddress; platformId: string } | undefined;
  /**
   * Mark this conversation as active, because something is happening in it outside a turn.
   *
   * Without it a conversation whose agent left a two-hour background job would look idle to the
   * reclaim sweeper (no turn, no messages) and have its child stopped from under the job.
   */
  touch?(id: ConversationId): void;
  /**
   * A turn is starting here: whatever the last one left for a person (a reply to read, a failure) is
   * superseded by it. Also the moment the registry marks the conversation as mid-turn on disk, so a
   * gateway that goes down before the end can be found out on the next start (see recordTurnEnd).
   */
  recordTurnStart?(id: ConversationId): void;
  /**
   * How the turn ended — what the person's list of things to do is built from, and what
   * `hooks.turnFailed` acts on. Called exactly once per recordTurnStart, on every way out.
   */
  recordTurnEnd?(id: ConversationId, end: TurnEnd): void;
  /**
   * Open the library's row for a turn, returning its id, and close it when the turn ends.
   *
   * Separate from recordTurnStart/recordTurnEnd on purpose: those two are about the live
   * conversation (activity, `hooks.turnFailed`, the in-flight marker), while these are the
   * permanent record. A background burst has a turn row of its own but must not be reported as a
   * conversation turn, and a turn can be recorded even if the live bookkeeping is unavailable.
   *
   * `endHistoryTurn` is called exactly once for every id returned, on every way out — this is
   * what keeps the turns table from filling with rows that never end.
   */
  beginHistoryTurn?(id: ConversationId, start: HistoryTurnStart): number | undefined;
  endHistoryTurn?(turnId: number | undefined, end: HistoryTurnEnd): void;
  /**
   * File one fact of this turn in the conversation library (`src/history/`): the prompt, a tool
   * line, the reply.
   *
   * Optional, and every call is guarded: a gateway without a library, or a disk that filled up,
   * must not cost the turn. See HistoryStore's header for why recording is best-effort while
   * searching is not.
   */
  recordHistory?(id: ConversationId, event: HistoryEvent): void;
}

/**
 * How one turn ended, as TurnRunner saw it.
 *
 * `done` carries the reply's last segment of text — the part after the last tool, which is where an
 * answer's conclusion is — so the registry can show its first line without asking the platform.
 * `failed` carries what was thrown, unclassified: the registry reads the reason off it
 * (turnFailureReason) and the message is what the chat was already told.
 */
export type TurnEnd =
  | { kind: 'done'; text: string }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stopped' };

/**
 * How a finished turn is filed. A stopped turn is still a turn that ran — its partial reply is
 * in the library — so it gets `stopped`, not a silent absence. A failure keeps the message the
 * turn was thrown with, whole: the ❌ notice in the topic carries only its opening, and the
 * update card points at this record when it cuts its own quote.
 */
function historyEndOf(end: TurnEnd, at: number): HistoryTurnEnd {
  switch (end.kind) {
    case 'done':
      return { outcome: 'done', at };
    case 'stopped':
      return { outcome: 'stopped', at };
    case 'failed': {
      const reason = end.error instanceof Error ? end.error.message : String(end.error);
      return {
        outcome: 'failed',
        at,
        detail: reason.length > HISTORY_FAILURE_KEEP ? `${reason.slice(0, HISTORY_FAILURE_KEEP - 1)}…` : reason,
      };
    }
    default: {
      const _exhaustive: never = end;
      throw new Error(`unknown turn end: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * One rendering context: the buffers and handlers that turn a stream of agent events into IM
 * messages, plus the finalizer that seals the result.
 *
 * Extracted so a turn and a follow-up burst render through the same code — the serial effects
 * chain, the segment rotation at tool boundaries and the footer are all properties of "agent output
 * being written into a chat", not of a turn.
 */
interface Render {
  ref: TurnRef;
  handlers: AgentStreamHandlers;
  /** Queue a side effect onto this render's serial chain (ordering with the stream is preserved). */
  enqueue(fn: () => Promise<void> | void): void;
  /** Drain the chain and seal the last message, appending `footer` when there is a body. */
  finalize(footer: string): Promise<void>;
  /** Interrupted: stop the tool painter so an armed retry doesn't outlive the turn. */
  abort(): void;
}

/**
 * Turn-level mutable state shared between the runTurn body and the extracted stream callbacks
 * (see the comment at its construction for why this is an object rather than bare locals).
 */
interface TurnRef {
  /** Active text buffer, rotated at segment boundaries. */
  stream: StreamBuffer;
  /** Whether the turn emitted visible output (drives the command zero-output fallback). */
  producedOutput: boolean;
  /**
   * Latest context snapshot the agent reported this turn (ACP `usage_update`). Overwritten on each
   * update — the harness sends full snapshots, and the footer wants the value as of turn end.
   * Absent when the harness reports no usage; the footer then omits the context segment.
   */
  usage?: AgentUsage;
  /**
   * Model the harness reports as actually serving this turn. Preferred over the configured value:
   * an agent whose model comes from the environment (the `claude` harness reads ANTHROPIC_MODEL)
   * has no `model` in config at all, and an alias like `opus[1m]` only the harness can resolve.
   */
  model?: string;
  /** Reasoning effort the harness reports for this turn (see AgentStreamHandlers.onEffort). */
  effort?: string;
  /**
   * The text of the segment being written now, and of the last segment that had any. What a turn
   * ends on is the segment after its last tool, but a turn can end ON a tool — so the last one with
   * words in it is kept as well. Only the head of each is kept (REPLY_TEXT_KEEP): what reads them is
   * a one-line summary and a card of a few hundred characters.
   */
  segmentText: string;
  lastText: string;
  /**
   * Everything the agent said in this render, across segments — what the conversation library
   * keeps as the reply. Separate from segmentText, which keeps only the head of the current
   * segment for a one-line summary; a library row that held 4 KB of a long answer would be a
   * search result nobody could use. Capped at HISTORY_REPLY_KEEP so a runaway stream cannot
   * grow the row without bound.
   */
  replyText: string;
}

/** How much of one render's text the library keeps (see TurnRef.replyText). */
const HISTORY_REPLY_KEEP = 200_000;

/**
 * How much of a failed turn's error the library keeps in `turns.detail`.
 *
 * The update card carries CARD_ITEM_CHARS (4,000) of it and points at the record for the rest, so
 * the record has to hold more than the card — a long ACP error was unreadable past 4,000 characters
 * before this. Bounded at the same size a reply row is, which is what one row can be read back in;
 * an error longer than that is not a message a model wrote.
 */
const HISTORY_FAILURE_KEEP = 200_000;

/** How much of a segment's text a TurnRef keeps for TurnEnd (see TurnRef.segmentText). */
const REPLY_TEXT_KEEP = 4_000;

/** Close the segment being written: it becomes the last one with words, if it has any. */
function rollSegment(ref: TurnRef): void {
  if (ref.segmentText.trim()) ref.lastText = ref.segmentText;
  ref.segmentText = '';
  // A segment boundary is a paragraph break in the library's one reply row; without it the text
  // before and after a tool call would run together.
  if (ref.replyText && !ref.replyText.endsWith('\n')) ref.replyText += '\n\n';
}

/** The text a turn ended on (see TurnRef.segmentText). */
function finalText(ref: TurnRef): string {
  return ref.segmentText.trim() ? ref.segmentText : ref.lastText;
}

/**
 * The part of a TurnRef a burst of background output learns before it has a message: the runtime
 * reports the model and effort when the burst begins, and the message opens on the first text.
 */
type BurstFacts = Pick<TurnRef, 'model' | 'effort'>;

/** A running turn, as far as a message handed into it needs to know (see TurnRunner.steer). */
interface RunningTurn {
  agent: AgentSession;
  platformId: string;
  /** What the library files this turn's messages under (see kindForTrigger). */
  kind: HistoryKind;
  /** The library's row for this turn; a mid-turn message merged into it belongs to it. */
  turnId?: number;
  /**
   * Where messages that belong to this turn come from: the lane the batch was sent in, and the lane
   * the reply is going to. The two differ under autoThread, which opens a thread for the reply and
   * makes the user's next message there arrive from it.
   */
  lanes: ConversationAddress[];
}

/**
 * Single-turn orchestrator: all timing logic for running one turn — register the TurnContext
 * (channel/token), wire StreamBuffer / ToolRenderer, drive the agent turn, and preserve observable
 * behaviors: serial effects chain ("text → tool boundary → tool bubble → trailing text"), footer only
 * on the last stream, typing keep-alive loop, command zero-output fallback, best-effort attachment injection.
 *
 * State (merger/token/activeChannel/...) and session lifecycle (routing/eviction/maintenance) stay with
 * SessionRegistry; TurnRunner borrows its capabilities via TurnRunnerDeps and holds no reference to it.
 */
export class TurnRunner {
  /**
   * How many things are holding each conversation's typing indicator on right now: a turn, a
   * burst of background output, or — for the moment one hands over to the other — both.
   *
   * Counted because the two overlap and the indicator is a single switch. runTurn switches typing
   * on first, and only then does the runtime seal the previous burst, from inside the turn (see
   * FollowUpSink.close) — so a burst that simply switched typing off on close would do it to the
   * turn that had just begun. The reverse happens too: a turn's `finally` runs after the runtime
   * has stopped routing to it, so background output can open a burst in that gap, and the turn
   * would switch it off. On the web UI either one is the topic dot going quiet, the "running"
   * label vanishing and the Stop button hiding while the agent is visibly still working.
   *
   * Keyed by conversation, not address. The two differ only under autoThread, where a new turn
   * opens a new thread while the burst it seals still names the old one; skipping that stop costs
   * nothing, because every chat platform expires typing on its own (satori's stopTyping is a
   * no-op) and the web UI — the one adapter where stopping is real — never auto-threads (that path
   * needs a group channel, and every web UI topic is a direct lane).
   */
  private readonly typingHolds = new Map<ConversationId, number>();
  /**
   * The turn running in each conversation, with what a message needs to be handed into it (see steer):
   * the session it runs on — captured, not looked up again, so a message cannot reach a different
   * agent than the one doing the work — and the lane it answers in.
   */
  private readonly running = new Map<ConversationId, RunningTurn>();

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id; each turn resolves its adapter from the batch's platform. */
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    private readonly deps: TurnRunnerDeps,
    /**
     * Optional callback hooks. onAvailableCommands: fired when a session's agent reports its command
     * list. The agentId is passed alongside because the daemon keys those lists by AGENT, not by
     * session: a command set is a property of the harness and its configuration, so every session of
     * one agent reports the same list, and keying by session would make the newest report look like
     * a change. Absent = don't care (test/no-slash).
     */
    private readonly hooks?: {
      onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
      /**
       * The agent asked the user a question mid-turn and is blocked on it (ACP elicitation).
       * Resolves with what the user picked, or a cancel when nobody did.
       *
       * Takes the turn's platform and address rather than resolving them from the conversation:
       * the question belongs in the lane this turn is already answering in — which on autoThread
       * is a thread that did not exist when the conversation was created.
       */
      onElicitRequest?(
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: AgentElicitation
      ): Promise<ElicitAnswer>;
      /**
       * An agent configured `permissions: ask` asks leave to run a tool. Same lane rule as
       * onElicitRequest; the answer says what became of it (see PermissionAnswer).
       */
      onPermissionRequest?(
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: AgentPermissionRequest
      ): Promise<PermissionAnswer>;
    }
  ) {}

  /**
   * One turn: register TurnContext → wire core classes → drive the agent.
   *
   * `signal` (from the merger) trips when `/stop` cuts this turn short: the agent is cancelled in
   * parallel, and here it switches the final flush to a clean finalize — finalize with no footer and
   * no command fallback, since the turn did not finish. Absent = never stopped (treat as a normal turn).
   */
  async runTurn(conversationId: ConversationId, batch: InboundMessage[], signal?: AbortSignal): Promise<void> {
    // The turn's platform is the batch's platform instance (all messages of one batch come from
    // one merger, i.e. one channel — same instance; a shared-scope session may hop instances
    // between turns, so this resolves per turn, not per session).
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const platformId = last.conversation.platform;
    const platform = this.adapterFor(platformId);

    // All subsequent outbound (typing, StreamBuffer sink, tool bubbles, reverse commands) targets
    // this address; on autoThread it is the newly opened thread, so the whole turn lands in it.
    const address = await this.resolveTurnAddress(platform, batch, conversationId, platformId);

    const sessionToken = this.deps.tokenFor(conversationId);
    const agentId = this.deps.agentIdOf(conversationId);
    // Record the lane: everything answered for this conversation locates it via
    // token→conversation→lane, during the turn and after it.
    this.deps.setLane(conversationId, address, platformId);

    // producedOutput (whether the turn emitted visible output) lives in the ref below. Used for the
    // command zero-output fallback: a few built-ins (e.g. /compact) produce a marker-only shell stripped
    // to null by the harness, leaving the turn idle and the IM side waiting silently.
    const lastContent = last.content?.trim() ?? '';
    const isCommandTurn = looksLikeCommand(lastContent);

    // Name the topic from this conversation's opening message, starting NOW rather than at turn
    // end. Everything the namer needs is already known — the seed is what the user just typed, and
    // the lane was recorded a line above — so waiting for the answer only delays the rename by the
    // length of the turn, which for real work is minutes: the user watches the topic column under
    // the old name for the entire time the thing they asked about is being done.
    //
    // Fire-and-forget on purpose (see TurnRunnerDeps.nameConversation): the model call and the
    // rename run beside the turn, and the topic changes the moment the name comes back. The
    // registry ignores this once the conversation has a name, so of all the turns that call it,
    // only the first one does anything.
    //
    // The predecessor waited for a SUCCESSFUL turn so that a topic could not be labelled with
    // something that failed. That reasoning was about the wrong text: the seed is the user's own
    // request, and a request is no less what the topic is about for the harness having failed to
    // answer it. Command turns are still skipped — `/model` names nothing.
    // Nor are the gateway's own reports to an agent (UPDATE_SENDER), which say nothing about the topic.
    const seed = this.titleSeedOf(batch, lastContent, isCommandTurn);
    if (seed !== undefined) this.deps.nameConversation?.(conversationId, seed);

    // Typing keep-alive: Discord's typing indicator self-expires ~10s, so re-fire every typingIntervalMs
    // (fire-and-forget, never gates the turn). Released in finally — held rather than simply
    // stopped there, because a burst of background output may be holding it too (see typingHolds).
    const releaseTyping = this.holdTyping(conversationId, platform, address);

    // What this batch was: one trigger for the turn, and the message kind the library files its
    // rows under. The two are the same fact at different resolutions (see kindForTrigger).
    const trigger = historyTriggerOf(batch);
    const historyKind = kindForTrigger(trigger);

    const agent = this.agents.getOrCreate(conversationId, agentId);
    // Re-installed every turn rather than once per session: the session object outlives its child
    // (crash, `/cd`, idle reclaim all rebuild one underneath it), and a sink installed on a dead
    // child would leave background output with nowhere to go.
    agent.setFollowUpSink?.(this.followUpSink(conversationId));
    const { prompt, images } = await this.buildPrompt(batch, platform, agentId);
    // Open the turn only now, immediately before the first row that names it: everything above
    // can throw (spawning an agent, building a prompt), and a turn opened before it would be left
    // running until the next start. A failure HERE leaves turnId undefined, and every later row
    // is written exactly as it was before turns existed.
    const turnId = this.beginHistoryTurn(conversationId, {
      agent: agentId,
      trigger,
      at: this.clock.now(),
    });
    // Everything that turns agent events into messages in this lane. Shared with the follow-up
    // path (see followUpSink) so out-of-turn output renders exactly like in-turn output.
    const render = this.beginRender(conversationId, platform, address, historyKind, turnId);
    const ref = render.ref;
    // The library keeps the prompt WITHOUT the inlined attachment text — the file names, not
    // what was in the files. `mergePrompt` is the same text minus the attachment block.
    this.recordHistory(conversationId, {
      type: 'prompt',
      text: this.mergePrompt(batch),
      attachments: attachmentNames(batch),
      kind: historyKind,
      at: this.clock.now(),
      turn: turnId,
    });
    console.log(`[turn] ${conversationId} starting turn (${batch.length} message(s))`);
    // Open to messages sent while it runs (see steer) from here until it ends. Keyed by conversation,
    // and removed only if it is still THIS turn, so a turn can never unregister its successor.
    const turn: RunningTurn = {
      agent,
      platformId,
      kind: historyKind,
      turnId,
      lanes: [addressOf(last.conversation), address],
    };
    this.running.set(conversationId, turn);
    this.reportStart(conversationId);
    // Exactly one end per start, whichever way out the turn takes (see TurnRunnerDeps.recordTurnEnd).
    let end: TurnEnd = { kind: 'stopped' };

    try {
      await agent.runTurn(
        { prompt, ...(images.length > 0 ? { images } : {}), sessionToken, model: this.deps.getModelOverride(conversationId) },
        turnHandlers(batch, render.handlers)
      );
      if (signal?.aborted) {
        // Stopped (`/stop`): finalize the partial reply cleanly — drop the streaming reply with no
        // footer (it didn't finish), and skip the command fallback.
        //
        // The tool painter is stopped first: an armed retry belongs to a turn that is over, and
        // firing it would repaint an abandoned bubble underneath the next turn's output.
        render.abort();
        await render.finalize('');
        console.log(`[turn] ${conversationId} turn stopped`);
        end = { kind: 'stopped' };
      } else {
        // Final flush: footer only on the last stream (intermediate segments carry none).
        await render.finalize(this.buildFooter(conversationId, ref));
        // Command zero-output fallback: the agent ran a command but produced nothing displayable (often
        // harness-swallowed built-in stdout, or an unknown command); send a note instead of total silence. best-effort.
        if (isCommandTurn && !ref.producedOutput) {
          await this.sendCommandFallback(platform, address, lastContent);
        }
        // Normal end: whatever usage this harness was going to report, it has reported. Recorded
        // only here (not in `finally`) so a stopped or failed turn doesn't claim the harness
        // stayed silent — see recordTurnComplete.
        this.deps.recordTurnComplete?.(conversationId);
        console.log(`[turn] ${conversationId} turn complete`);
        end = { kind: 'done', text: finalText(ref) };
      }
    } catch (err) {
      end = { kind: 'failed', error: err };
      // Log error detail (InboundMerger only adds a ❌ reaction, keeping no reason).
      console.error(`[turn] ${conversationId} turn failed:`, err instanceof Error ? err.stack ?? err.message : err);
      // Deliver what the turn DID produce before saying it failed — the same clean finalize a
      // stopped turn gets, with no footer because it did not finish.
      //
      // Not a nicety: text is only sent when its segment completes (at the next tool boundary, or
      // here at the end), so a failed turn used to throw away everything after its last tool —
      // which is usually the conclusion. Reported 2026-09-29: an answer claude-agent-acp never
      // closed (see FOLDED_PROMPT_GRACE_MS in agent-acp.ts) sat complete in this buffer for the
      // full ten-minute watchdog, and the only thing that ever reached the chat was the ❌.
      //
      // Guarded separately: a failure to flush must neither swallow the ❌ nor replace the error
      // the merger is about to mark.
      render.abort();
      await render
        .finalize('')
        .catch((e) => console.error('[turn] failed to flush a failed turn\'s output:', describeOutboundError(e)));
      // Surface a readable reason in-channel: the agent-acp error messages (auth_required, startup
      // / turn timeout, command not on PATH) are written to be user-actionable, but otherwise only
      // a bare ❌ reaction reaches the user. Best-effort and capped — a send failure here must not
      // mask the original error, which is rethrown for the merger to mark ❌.
      const reason = err instanceof Error ? err.message : String(err);
      const short = reason.length > FAILURE_NOTICE_CHARS ? reason.slice(0, FAILURE_NOTICE_CHARS - 1) + '…' : reason;
      await platform
        .sendMessage(address, `❌ This turn failed: ${short}`)
        .catch((e) => console.error('[turn] failed to send error notice:', e instanceof Error ? e.message : e));
      throw err;
    } finally {
      if (this.running.get(conversationId) === turn) this.running.delete(conversationId);
      await releaseTyping();
      // After typing is released, so a platform listing what needs a person sees the turn's end and
      // its outcome together rather than "failed" over a dot that still says running.
      this.reportEnd(conversationId, end);
      // The permanent record, in every way out — including the failure path that rethrows above,
      // which is why this is in the finally rather than after the try.
      this.endHistoryTurn(turnId, historyEndOf(end, this.clock.now()));
    }
  }

  /** beginHistoryTurn, never allowed to break the turn it describes. */
  private beginHistoryTurn(conversationId: ConversationId, start: HistoryTurnStart): number | undefined {
    try {
      return this.deps.beginHistoryTurn?.(conversationId, start);
    } catch (e) {
      console.error('[history] could not open a turn:', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  /** endHistoryTurn, likewise. */
  private endHistoryTurn(turnId: number | undefined, end: HistoryTurnEnd): void {
    try {
      this.deps.endHistoryTurn?.(turnId, end);
    } catch (e) {
      console.error('[history] could not close a turn:', e instanceof Error ? e.message : e);
    }
  }

  /** recordTurnStart, never allowed to break the turn it reports on. */
  private reportStart(conversationId: ConversationId): void {
    try {
      this.deps.recordTurnStart?.(conversationId);
    } catch (e) {
      console.error('[turn] recordTurnStart failed:', e instanceof Error ? e.message : e);
    }
  }

  /** recordTurnEnd, likewise. */
  private reportEnd(conversationId: ConversationId, end: TurnEnd): void {
    try {
      this.deps.recordTurnEnd?.(conversationId, end);
    } catch (e) {
      console.error('[turn] recordTurnEnd failed:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * recordHistory, likewise — and for a stronger reason: the library is a convenience, and a
   * full disk or a corrupt database must not fail the turn it was describing. The store's own
   * writes are already guarded; this is the second wall, for a recorder that throws.
   */
  private recordHistory(conversationId: ConversationId, event: HistoryEvent): void {
    try {
      this.deps.recordHistory?.(conversationId, event);
    } catch (e) {
      console.error('[history] could not record:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Hand messages that arrived mid-turn to the turn running in this conversation (see
   * AgentSession.steer), or say why not — the merger queues whatever this refuses.
   *
   * Refused here, before the harness is asked:
   *  - A slash command. The SDK runs one only when it is the FIRST thing in a prompt (see mergePrompt),
   *    and a harness taking input mid-turn delivers it as part of the turn's own continuing work,
   *    where `/compact` would be text in the middle of a task. So it waits for the turn to end, and
   *    then runs as what it is.
   *  - A message from a lane this turn is not answering in (a `shared`-scope conversation that hopped
   *    channels). Joining would answer it in the other one.
   *
   * The prompt is built exactly as a turn's is (quote line, attachments), because to the harness it
   * is the same thing: a message from the user. Built before the turn is checked again, since
   * fetching attachments takes time a short turn may not have.
   */
  async steer(conversationId: ConversationId, batch: InboundMessage[]): Promise<SteerOutcome> {
    const turn = this.running.get(conversationId);
    if (!turn?.agent.steer) return 'refused';
    if (batch.some((m) => looksLikeCommand(m.content.trim()))) return 'refused';
    const fromThisLane = batch.every(
      (m) =>
        m.conversation.platform === turn.platformId &&
        turn.lanes.some((lane) => sameAddress(lane, addressOf(m.conversation)))
    );
    if (!fromThisLane) return 'refused';
    const { prompt, images } = await this.buildPrompt(batch, this.adapterFor(turn.platformId), this.deps.agentIdOf(conversationId));
    if (this.running.get(conversationId) !== turn) return 'refused';
    const outcome = await turn.agent.steer({ prompt, ...(images.length > 0 ? { images } : {}) });
    // Recorded only when the harness really took it. A `refused` message stays queued and runs as
    // the next turn, which records it then — writing it here too would put it in the library twice.
    //
    // `joined` belongs to the running turn: the agent is still working on the same answer.
    // `detached` does not: the harness had already finished the turn and started one of its own
    // (see SteerOutcome), whose output reaches the gateway as a background burst. Filing the
    // prompt under the old turn would leave that turn holding a question it never answered, and
    // `--turn done` would then offer it as a finished turn.
    if (outcome !== 'refused') {
      this.recordHistory(conversationId, {
        type: 'prompt',
        text: this.mergePrompt(batch),
        attachments: attachmentNames(batch),
        kind: turn.kind,
        at: this.clock.now(),
        turn: outcome === 'joined' ? turn.turnId : undefined,
      });
    }
    console.log(`[turn] ${conversationId} ${batch.length} message(s) sent mid-turn: ${outcome}`);
    return outcome;
  }

  /**
   * Whether the turn running here can take a message mid-turn at all.
   *
   * Asked before saying so: a harness with no `steer` (agy) has the merger queue the message behind
   * the turn, so reporting it as joined would tell the agent something the sub-agent never saw.
   */
  canSteer(conversationId: ConversationId): boolean {
    return this.running.get(conversationId)?.agent.steer !== undefined;
  }

  /**
   * Assemble the stream-event callbacks passed to agent.runTurn — extracted from the runTurn body purely
   * to shorten it and gather the timing in one place; no behavior change.
   *
   * Mutable-sharing: the "current stream" and "producedOutput" read/written by onText/onSegmentBreak are
   * not bare locals but the ref container passed from runTurn — callbacks read ref.stream's current value
   * and rotate via ref.stream = makeStream(), and the runTurn body reads the same ref. Sharing the object
   * makes both ends mutually visible, equivalent to the original bare-`let` closure (never cache ref.stream).
   *
   * All side effects are serialized via enqueue into the effects chain: "text push → tool-boundary flush
   * → tool bubble → trailing text" in strict arrival order, no interleaving, failures swallowed.
   */
  private buildStreamHandlers(
    conversationId: ConversationId,
    ref: TurnRef,
    makeStream: () => StreamBuffer,
    tools: ToolRenderer,
    enqueue: (fn: () => Promise<void> | void) => void,
    /** Where a question to the user is posted — the lane this render is already writing to. */
    platform: PlatformAdapter,
    address: ConversationAddress,
    /** How this render is filed in the conversation library. */
    historyKind: HistoryKind,
    /** The library turn every row of this render belongs to (a background burst has its own). */
    turnId: number | undefined
  ): AgentStreamHandlers {
    return {
      onText: (delta) => {
        if (delta) ref.producedOutput = true;
        if (ref.segmentText.length < REPLY_TEXT_KEEP) ref.segmentText += delta;
        if (ref.replyText.length < HISTORY_REPLY_KEEP) ref.replyText += delta;
        enqueue(() => ref.stream.push(delta));
      },
      onToolStart: (evt) => {
        // Before the rendering chain: the live status is read while this turn runs, and must not
        // wait for a rate-limited bubble to be painted. See TurnRunnerDeps.recordTool.
        this.deps.recordTool?.(conversationId, evt);
        this.recordHistory(conversationId, {
          type: 'tool',
          title: toolLine(evt.name, evt.inputPreview, evt.agent),
          kind: historyKind,
          at: this.clock.now(),
          turn: turnId,
        });
        rollSegment(ref);
        // Before a tool: finish the current text as its own bubble (no footer: not the last segment), then
        // register the tool. Registering is synchronous — the bubble is delivered by the renderer's own
        // painter, off this chain, so a rate-limited chat cannot stall the reply behind a progress write.
        //
        // The one thing that IS waited for is the bubble taking its place in the chat. The painter runs
        // a write behind this chain, so without the wait the next segment's text could be sent first and
        // the bubble would appear below the text describing what it found. See ToolRenderer.placed for
        // why only a SEND has to be ordered and an edit never does.
        enqueue(async () => {
          ref.producedOutput = true;
          await ref.stream.complete();
          tools.onToolStart(evt);
          await tools.placed(BUBBLE_PLACEMENT_WAIT_MS);
        });
      },
      onToolFinish: (evt) => enqueue(() => tools.onToolFinish(evt)),
      onSegmentBreak: () => {
        rollSegment(ref);
        // Tool→text boundary: finish the current (pre-tool) buffer, reset the tool segment, then start a
        // fresh buffer so trailing text goes to a new message (intermediate segments carry no footer).
        enqueue(async () => {
          await ref.stream.complete();
          tools.resetSegment();
          ref.stream = makeStream();
        });
      },
      // Agent reported available commands: forward to the daemon hook (feeds the harness pickers).
      // Non-blocking, errors swallowed.
      onAvailableCommands: (cmds) => {
        try {
          this.hooks?.onAvailableCommands?.(conversationId, this.deps.agentIdOf(conversationId), cmds);
        } catch (e) {
          console.error('[turn] onAvailableCommands hook failed:', e instanceof Error ? e.message : e);
        }
      },
      // Context snapshot: recorded straight onto the ref (not enqueued) — it renders nothing on its
      // own, and the footer reads it only after the effects chain has drained at turn end.
      onUsage: (usage) => {
        ref.usage = usage;
        this.deps.recordUsage?.(conversationId, usage);
      },
      // Same for the live model name (see TurnRef.model for why it beats the configured value).
      onModel: (model) => {
        ref.model = model;
        this.deps.recordModel?.(conversationId, model);
      },
      onEffort: (effort) => {
        ref.effort = effort;
        this.deps.recordEffort?.(conversationId, effort);
      },
      // Nothing per-turn reads quota — the footer has no field for it — so it goes straight through.
      onQuota: (pools) => this.deps.recordQuota?.(conversationId, pools),
      /**
       * An aside about this turn — the harness logged an error and is retrying.
       *
       * Sent immediately and OFF the effects chain, which is the entire point: the chain is drained
       * by the reply's own rendering, and the turns this fires on are exactly the ones producing no
       * reply to drain it. Queueing the notice behind the body would hold it until the turn ended,
       * which is ten minutes too late to be worth saying.
       *
       * Best-effort like every other side channel here: a failed send is logged and the turn goes on.
       */
      onNotice: (text) => {
        void platform
          .sendMessage(address, text)
          .catch((e) => console.warn('[turn] failed to deliver a notice:', e instanceof Error ? e.message : e));
      },
      /**
       * The agent stopped to ask the user something. Post it as buttons and block this ACP request
       * until they answer.
       *
       * NOT enqueued onto the effects chain, unlike every other handler here: that chain is what
       * serializes rendering, and parking a minutes-long wait in it would freeze the reply text
       * behind the question — including the sentence that explains why the question is being
       * asked. The question is its own message in the same lane, so nothing it does can interleave
       * with the body stream.
       *
       * With no hook wired (tests, a daemon built without one) the answer is `cancel`: the agent
       * learns nobody answered, rather than waiting on a promise that never settles.
       */
      onElicit: async (request) => {
        const ask = this.hooks?.onElicitRequest;
        if (!ask) return { action: 'cancel' };
        try {
          return await ask(conversationId, platform, address, request);
        } catch (e) {
          console.error('[turn] onElicitRequest hook failed:', e instanceof Error ? e.message : e);
          return { action: 'cancel' };
        }
      },
      // Off the effects chain for the reason onElicit is: the wait can be an hour.
      onPermission: (request) => this.askPermission(conversationId, platform, address, request),
    };
  }

  /**
   * Build one rendering context for a lane: the text buffer, the tool renderer, the serial effects
   * chain, the stream handlers, and the finalizer that seals it all.
   *
   * Lifted out of runTurn so a follow-up burst renders identically (see the Render interface). The
   * only thing NOT in here is the footer text, which differs between a turn and a follow-up and is
   * therefore passed to `finalize`.
   */
  private beginRender(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    /** How this render's text and tool calls are filed in the conversation library. */
    historyKind: HistoryKind,
    /** The library turn this render's rows belong to; undefined when there is no library turn. */
    turnId: number | undefined
  ): Render {
    // StreamBuffer factory closure: sink bound to this address, callable repeatedly to rotate a
    // fresh buffer per segment — trailing text below a tool bubble goes to a new message, not editing the prior one.
    const makeStream = (): StreamBuffer => this.makeStreamBuffer(platform, address);
    // Tool bubbles are billed to the same per-chat budget as everything else, but in the lane that
    // may be dropped under congestion — see OutboundClass.
    const progressLane = outboundLane(platform, 'progress');

    // Render-level mutable container: stream (active text buffer, rotated at segment boundaries),
    // producedOutput (whether it emitted visible output) and usage (latest context snapshot the
    // agent reported) are written by stream callbacks and read by the caller. Wrapped in one object
    // rather than separate `let`s because the callbacks are extracted to buildStreamHandlers —
    // across that function boundary a bare local's mutable binding can't be shared. Sharing the ref
    // makes assignment (ref.stream = makeStream()) and reads mutually visible (never cache a
    // ref.stream instance early).
    const ref: TurnRef = {
      stream: makeStream(),
      producedOutput: false,
      segmentText: '',
      lastText: '',
      replyText: '',
    };

    const tools = new ToolRenderer(
      {
        mode: this.config.tools.mode,
        // Tool-progress grouping (accumulate = edit one bubble in place; needs editBubble).
        grouping: this.config.tools.grouping,
        // A platform that folds long lines itself asks for more of each command than a chat app
        // can show (PlatformCapabilities.toolPreviewLimit); never less than the operator set.
        previewLimit: Math.max(this.config.tools.previewLimit, platform.capabilities.toolPreviewLimit ?? 0),
        defaultEmoji: this.config.tools.defaultEmoji,
        emojiMap: this.config.tools.emojiMap,
        // Same edit budget the body stream respects: a long tool run seals its bubble and opens a
        // new one rather than freezing once the platform stops accepting edits.
        maxEdits: this.editBudget(platform),
        // ...and the same length limit, measured the same way. A bubble that accumulates past what
        // one message can carry is sealed and continued, instead of being rejected on the wire
        // (Telegram answered MESSAGE_TOO_LONG on the edit and "text is too long" on the send, and
        // neither is a MessageNotEditableError, so the whole block of progress was dropped).
        maxMessageLength: platform.capabilities.maxMessageLength,
        measureLength: (s) => platform.measureRendered(s),
        retryIntervalMs: this.config.tools.retryIntervalMs,
        maxRetryMs: this.config.tools.maxRetryMs,
        maxRetryAfterMs: this.config.outbound.maxRetryAfterMs,
      },

      {
        // The 'progress' lane: a tool bubble is a running commentary, so under congestion it may
        // be superseded or dropped, where the reply may not. Everything else about this sink is
        // ordinary — the pacing lives in the adapter (daemon/paced-adapter.ts). Marked as a tool
        // bubble for the platform that draws one differently (SendOptions); the mark rides on the
        // send alone, since the edits below restate a message whose kind is already known.
        sendBubble: (text) => progressLane.sendMessage(address, text, { kind: 'tools' }),
        // accumulate mode flushes whole tool progress/completion into one bubble (address closure).
        // Capability-gated: on platforms with editMessage=false (QQ/LINE/WeCom) editMessage throws, so
        // pass undefined to let ToolRenderer degrade to separate (one new bubble per tool) instead of
        // throwing on every accumulate edit. Symmetric with StreamBuffer's noEdit inference.
        editBubble: platform.capabilities.editMessage
          ? (bubble, text) => progressLane.editMessage(bubble, text)
          : undefined,
        now: this.clock.now,
        schedule: this.clock.schedule,
      }
    );

    // Serialize all stream-event side effects into one promise chain: "text push → tool-boundary flush →
    // tool bubble → trailing text" execute strictly in arrival order, no interleaving; any failure is
    // swallowed into the chain (best-effort rendering) rather than bubbling as an unhandled rejection.
    let effects: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void> | void): void => {
      effects = effects.then(fn).catch((e) =>
        console.error('[turn] render side effect failed:', describeOutboundError(e))
      );
    };

    return {
      ref,
      enqueue,
      handlers: this.buildStreamHandlers(conversationId, ref, makeStream, tools, enqueue, platform, address, historyKind, turnId),
      abort: () => tools.abort(),
      finalize: async (footer: string) => {
        await effects; // wait for all queued side effects to land
        // Submit the segment's final tool state before sealing the body, so the last ✓ is not
        // discarded with the line set that carried it.
        tools.resetSegment();
        // …and if a bubble is still waiting to be POSTED — a seal mid-run carries its lines into a
        // fresh one — let it land before the closing text, for the reason onToolStart waits.
        await tools.placed(BUBBLE_PLACEMENT_WAIT_MS);
        await ref.stream.complete(footer ? { footer } : undefined);
        // What the agent said, filed once per render. A render that produced no text (a turn
        // that only ran tools) adds no reply row rather than an empty one.
        this.recordHistory(conversationId, {
          type: 'reply',
          text: ref.replyText.trim(),
          kind: historyKind,
          at: this.clock.now(),
          turn: turnId,
        });
        // Then STOP WAITING for the tool bubbles — bounded, because a chat the platform has
        // paused for minutes must not hold the turn (and its ✅) open for the same minutes.
        await tools.settle(this.config.outbound.finalizeWaitMs);
        // Past that deadline the renderer is done trying. `settle` returns immediately when
        // everything landed, so this is a no-op in the normal case; it matters when it is not,
        // because an armed retry keeps the whole render alive on a timer and would go on
        // repainting a finished turn's bubble for the life of the process.
        tools.abort();
      },
    };
  }

  /**
   * A destination for output the harness produces once the turn that asked for it has ended — a
   * background script finishing, and the agent reporting what it found.
   *
   * Rendered as a NEW message rather than an edit of the finished reply: that reply was already
   * sealed and footered, and a chat that silently rewrites an old message is worse than one that
   * posts a new one. The `⏱` marker bubble says which it is, because a paragraph arriving with no
   * message of the user's before it is otherwise baffling.
   *
   * Lazy on purpose. `handlers()` always answers, because the metadata half (title / usage / model)
   * must be recorded whether or not anything is displayed — but the message itself is opened only
   * when text or a tool actually shows up. Without that, claude-agent-acp's post-turn
   * `session_info_update` (which it sends after EVERY turn) would post an empty follow-up to every
   * conversation, forever.
   */
  followUpSink(conversationId: ConversationId): FollowUpSink {
    /** The follow-up message being rendered, once anything has been written to it. */
    let render: Render | undefined;
    /** Whether opening was already TRIED — a failed open must not be retried per chunk. */
    let tried = false;
    /** Lets go of the typing indicator the open message is holding (see typingHolds). */
    let releaseTyping: (() => Promise<void>) | undefined;
    /** What this burst was told about the session before it had a message to put it on. */
    let facts: BurstFacts = {};
    /**
     * The library's turn for this burst. Background output is not a conversation turn — nothing
     * asked for it and it may run long after its turn ended — so it gets a turn row of its own,
     * opened when the burst starts rendering and closed when the runtime seals it. Its rows
     * carry `kind: background` and this id, which is what makes "what did it say after the
     * answer" answerable without mixing it into the turn that asked.
     */
    let burstTurn: number | undefined;

    const open = (): Render | undefined => {
      if (tried) return render;
      tried = true;
      const target = this.deps.followUpTarget?.(conversationId);
      if (!target) {
        console.warn(
          `[follow-up] ${conversationId} produced output outside a turn, but no lane is known for it; dropping`
        );
        return undefined;
      }
      const platform = this.platforms.get(target.platformId);
      if (!platform) {
        console.warn(`[follow-up] ${conversationId}: no adapter for platform "${target.platformId}"; dropping`);
        return undefined;
      }
      burstTurn = this.beginHistoryTurn(conversationId, {
        agent: this.deps.agentIdOf(conversationId),
        trigger: 'background',
        at: this.clock.now(),
      });
      render = this.beginRender(conversationId, platform, target.address, 'background', burstTurn);
      // The runtime reports the model and effort when the burst begins, which is before its first
      // text — so before this message existed to record them on.
      if (facts.model) render.ref.model = facts.model;
      if (facts.effort) render.ref.effort = facts.effort;
      // Queued onto the render's own chain rather than sent directly, so the marker cannot land
      // after the first chunk of the text it is introducing.
      render.enqueue(() =>
        platform
          .sendMessage(target.address, FOLLOW_UP_MARKER)
          .then(() => undefined)
          .catch((e) => console.warn('[follow-up] failed to send the marker:', e instanceof Error ? e.message : e))
      );
      // The agent is working, and every surface that says so reads the typing indicator — on the
      // web UI that is the topic's dot, the "running" label and the Stop button. A burst used to
      // hold none of it, so minutes of tool calls ran under a topic marked idle.
      releaseTyping = this.holdTyping(conversationId, platform, target.address);
      console.log(`[follow-up] ${conversationId}: rendering background output as a new message`);
      return render;
    };

    /** Let go of typing, absorbing failure: a stuck indicator must not fail whoever closed the burst. */
    const letGo = (release: (() => Promise<void>) | undefined): Promise<void> | undefined =>
      release?.().catch((e) => console.warn('[follow-up] failed to stop typing:', e instanceof Error ? e.message : e));

    return {
      handlers: () => {
        // A backstop, not a path: the runtime closes every burst it opens. But a hold that
        // outlived its burst would mark the conversation running for the life of the process,
        // so a new burst starting over an unclosed one lets go of it. Its turn is closed here
        // for the same reason — a row left running would be read as a turn still going.
        void letGo(releaseTyping);
        releaseTyping = undefined;
        render = undefined;
        if (burstTurn !== undefined) {
          this.endHistoryTurn(burstTurn, { outcome: 'stopped', at: this.clock.now() });
          burstTurn = undefined;
        }
        tried = false;
        facts = {};
        return this.buildFollowUpHandlers(conversationId, open, () => render, facts);
      },
      close: (reason = 'done') => {
        const done = render;
        const release = releaseTyping;
        const turn = burstTurn;
        render = undefined;
        releaseTyping = undefined;
        burstTurn = undefined;
        tried = false;
        if (!done) {
          if (turn !== undefined) this.endHistoryTurn(turn, { outcome: 'stopped', at: this.clock.now() });
          return;
        }
        // Returned rather than voided: the runtime awaits it before letting a new turn write into
        // the same lane (see FollowUpSink.close). Failures are absorbed — a background report that
        // could not be flushed must not fail the turn that happened to seal it. Typing goes AFTER
        // the flush, because in `once` mode the flush is when the whole message is sent.
        return done
          .finalize(this.buildFooter(conversationId, done.ref))
          .catch((e) => console.error('[follow-up] failed to finalize:', describeOutboundError(e)))
          .then(() => {
            // After the flush: the reply row is written by finalize, and a turn must not be
            // closed before the last row that names it exists. `reason` is the caller's fact —
            // `/stop`, a new turn, or the child going away — never inferred here.
            this.endHistoryTurn(turn, { outcome: reason, at: this.clock.now() });
            return letGo(release);
          });
      },
    };
  }

  /**
   * Stream handlers for out-of-turn output: rendering events go through `open()` (which opens the
   * follow-up message on first use), while everything that is merely REPORTED is forwarded to the
   * conversation whether or not a message was ever opened.
   *
   * That split is the point. A title, a context snapshot and a model name are facts about the
   * session which the gateway records and shows elsewhere (`/context`, the topic name, the footer);
   * they are not output, and treating them as output is what would post empty bubbles.
   *
   * Each event also touches the conversation, so the reclaim sweeper can see that a conversation
   * which looks idle from the outside (no turn, no messages) is in fact still working.
   */
  private buildFollowUpHandlers(
    conversationId: ConversationId,
    open: () => Render | undefined,
    /** The open render, WITHOUT opening one — for events that must not cause a message. */
    peek: () => Render | undefined,
    /** Written on every model/effort report, so a message opened later still starts with them. */
    facts: BurstFacts
  ): AgentStreamHandlers {
    const touch = (): void => this.deps.touch?.(conversationId);
    return {
      onText: (delta) => {
        touch();
        open()?.handlers.onText(delta);
      },
      onToolStart: (evt) => {
        touch();
        open()?.handlers.onToolStart(evt);
      },
      onToolFinish: (evt) => {
        touch();
        open()?.handlers.onToolFinish(evt);
      },
      // Via peek, not open: a segment boundary before anything was rendered has no buffer to
      // rotate, and opening a message for one would defeat the laziness.
      onSegmentBreak: () => peek()?.handlers.onSegmentBreak(),
      onAvailableCommands: (cmds) => {
        try {
          this.hooks?.onAvailableCommands?.(conversationId, this.deps.agentIdOf(conversationId), cmds);
        } catch (e) {
          console.error('[follow-up] onAvailableCommands hook failed:', e instanceof Error ? e.message : e);
        }
      },
      onUsage: (usage) => {
        touch();
        this.deps.recordUsage?.(conversationId, usage);
        // Also onto the open render's ref, so the follow-up's own footer reports the context as of
        // the background work rather than as of the turn before it.
        const live = peek();
        if (live) live.ref.usage = usage;
      },
      onModel: (model) => {
        facts.model = model;
        this.deps.recordModel?.(conversationId, model);
        const live = peek();
        if (live) live.ref.model = model;
      },
      onEffort: (effort) => {
        facts.effort = effort;
        this.deps.recordEffort?.(conversationId, effort);
        const live = peek();
        if (live) live.ref.effort = effort;
      },
      onQuota: (pools) => this.deps.recordQuota?.(conversationId, pools),
      // A background cycle's own failure, or a retry inside one (see session-failure.ts). Sent
      // straight to the lane rather than through open(): a notice is not output, and opening the
      // burst's message for it would post a follow-up marker over nothing. Unordered against a
      // burst that is rendering, for the reason the in-turn notice is (see buildStreamHandlers).
      onNotice: (text) => {
        const target = this.deps.followUpTarget?.(conversationId);
        const platform = target && this.platforms.get(target.platformId);
        if (!target || !platform) {
          console.warn(`[follow-up] ${conversationId}: no lane for a notice; dropping: ${text}`);
          return;
        }
        void platform
          .sendMessage(target.address, text)
          .catch((e) => console.warn('[follow-up] failed to deliver a notice:', e instanceof Error ? e.message : e));
      },
      // Background work asking leave (a task the agent left running after its turn): asked in the
      // conversation's lane like a notice, and — like a notice — without opening the burst's message.
      onPermission: (request) => {
        const target = this.deps.followUpTarget?.(conversationId);
        const platform = target && this.platforms.get(target.platformId);
        if (!target || !platform) {
          return Promise.resolve({ kind: 'unavailable', why: 'no chat is known for this conversation' });
        }
        return this.askPermission(conversationId, platform, target.address, request);
      },
    };
  }

  /** Put a permission request to the user through the daemon; any failure to ask is an answer too. */
  private async askPermission(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentPermissionRequest
  ): Promise<PermissionAnswer> {
    const ask = this.hooks?.onPermissionRequest;
    if (!ask) return { kind: 'unavailable', why: 'this gateway has no way to ask' };
    try {
      return await ask(conversationId, platform, address, request);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`[turn] ${conversationId}: could not put a permission request to the user: ${why}`);
      return { kind: 'unavailable', why };
    }
  }

  /** Adapter for a platform instance id; a clear error beats an undefined-method crash mid-turn. */
  private adapterFor(platformId: string): PlatformAdapter {
    const adapter = this.platforms.get(platformId);
    if (!adapter) {
      throw new Error(`no platform adapter for instance "${platformId}" (configured: ${[...this.platforms.keys()].join(', ')})`);
    }
    return adapter;
  }

  /**
   * Resolve this turn's outbound address: when the instance's autoThread='perTurn', the platform
   * supports threads, and the message is non-thread/non-DM, best-effort open a thread and move the
   * whole turn into it; on failure or when not applicable, fall back to the trigger message's own
   * address — never block the turn.
   *
   * A newly opened thread is ADOPTED by this conversation (deps.adoptThread) so the user's reply
   * inside it continues here. Without that the reply identifies as a new conversation and the agent
   * answers its own thread from scratch — the whole point of auto-threading is that the exchange
   * moves, not that it restarts.
   */
  private async resolveTurnAddress(
    platform: PlatformAdapter,
    batch: InboundMessage[],
    conversationId: ConversationId,
    platformId: string
  ): Promise<ConversationAddress> {
    const last = batch[batch.length - 1]!; // batch is non-empty: the merger never dispatches an empty batch
    const own = addressOf(last.conversation);
    const platformCfg = this.config.platforms[platformId];
    if (
      platformCfg?.autoThread === 'perTurn' &&
      platform.capabilities.thread &&
      last.conversation.kind === 'group'
    ) {
      try {
        const flat = this.buildThreadName(batch) || 'Conversation';
        const { address } = await platform.createThread(
          { address: own, messageId: last.messageId },
          flat,
          { autoArchiveMinutes: platformCfg.threadAutoArchiveMinutes }
        );
        if (!sameAddress(address, own)) {
          this.deps.adoptThread?.(conversationId, address, platformId);
        }
        return address;
      } catch (e) {
        console.error('[turn] autoThread failed to create thread, falling back to the original channel:', e instanceof Error ? e.message : e);
      }
    }
    return own;
  }

  /**
   * StreamBuffer factory: sink bound to the given address; each call yields a fresh buffer for
   * per-segment rotation (trailing text below a tool bubble goes to a new message, not editing the prior).
   */
  private makeStreamBuffer(platform: PlatformAdapter, address: ConversationAddress): StreamBuffer {
    return new StreamBuffer(
      {
        // Streaming is opt-in AND capability-gated in one place: `stream.enabled` is what the
        // operator asked for, editMessage is whether it is possible at all. A platform that cannot
        // edit (QQ/LINE/WeCom/DingTalk) delivers whole segments no matter what the config says,
        // which is also the shape their 1-2 message quota wants.
        mode: this.config.stream.enabled && platform.capabilities.editMessage ? 'live' : 'once',
        charThreshold: this.config.stream.charThreshold,
        flushIntervalMs: this.config.stream.flushIntervalMs,
        maxBackoffMs: this.config.stream.maxBackoffMs,
        silentToken: this.config.stream.silentToken,
        maxMessageLength: platform.capabilities.maxMessageLength,
        // Per-message edit budget: config overrides the profile's declared value (see the schema).
        // Once spent, the buffer seals that message and continues in a new one.
        maxEditsPerMessage: this.editBudget(platform),
        // Chunk by the platform's RENDERED length (markdown rendering can expand/re-unit it), so a
        // chunk never overflows the platform after the profile renders it.
        measureLength: (s) => platform.measureRendered(s),
      },

      {
        now: this.clock.now,
        schedule: this.clock.schedule,
        send: async (text) => {
          try {
            const ref = await platform.sendMessage(address, text);
            console.log(`[out] send ok (${text.length} chars) → ${ref.messageId}`);
            return ref;
          } catch (e) {
            console.error(`[out] send failed (${text.length} chars):`, describeOutboundError(e));
            throw e;
          }
        },
        edit: async (ref, text) => {
          try {
            await platform.editMessage(ref, text);
            console.log(`[out] edit ok (${text.length} chars)`);
          } catch (e) {
            // A sealed message is expected bookkeeping, not a fault: the caller continues in a new
            // message. Logging it as an error made a working delivery look broken.
            if (e instanceof MessageNotEditableError) {
              console.log(`[out] ${e.message}; continuing in a new message`);
            } else {
              console.error(`[out] edit failed (${text.length} chars):`, describeOutboundError(e));
            }
            throw e;
          }
        },
      }
    );
  }

  /**
   * Per-message edit budget for this platform: the config override when set, else what the profile
   * declares (undefined = the platform doesn't cap edits, only rate-limits them).
   */
  private editBudget(platform: PlatformAdapter): number | undefined {
    return this.config.stream.maxEditsPerMessage ?? platform.capabilities.maxEditsPerMessage;
  }


  /**
   * Command zero-output fallback: the agent ran a command but produced nothing displayable (often
   * harness-swallowed built-in stdout, or an unknown command); send a note. best-effort, failures logged.
   */
  private async sendCommandFallback(platform: PlatformAdapter, address: ConversationAddress, lastContent: string): Promise<void> {
    const cmd = lastContent.split(/\s+/)[0];
    await platform
      .sendMessage(
        address,
        `ℹ️ Ran \`${cmd}\`, but there was no output to display.\n(A few built-in commands such as /compact don't relay their results to IM; an unknown command does nothing.)`
      )
      .catch((e) => console.error('[turn] failed to send command fallback notice:', e instanceof Error ? e.message : e));
  }

  /**
   * Start the typing keep-alive loop: fire once immediately, then re-fire every typingIntervalMs.
   * Returns a cancel handle (called at turn end to stop re-scheduling). Each startTyping is
   * fire-and-forget and swallows errors — typing never gates the turn.
   *
   * On the 'typing' lane, so a beat is DROPPED rather than queued when the chat has no budget: an
   * indicator that arrives after the message it was announcing is worse than one that never does,
   * and the platform expires it on its own anyway.
   */
  private startTypingLoop(platform: PlatformAdapter, address: ConversationAddress): () => void {
    const lane = outboundLane(platform, 'typing');
    let cancel: (() => void) | null = null;
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void lane.startTyping(address).catch(() => {});
      cancel = this.clock.schedule(beat, this.config.inbound.typingIntervalMs);
    };
    beat();
    return () => {
      stopped = true;
      cancel?.();
      cancel = null;
    };
  }

  /**
   * Hold a conversation's typing indicator on — keep-alive included — until the returned release
   * is called. Release always stops this holder's keep-alive, but switches the indicator off only
   * when nothing else is still holding it (see typingHolds). Idempotent, so a double release can
   * never take the count below another holder's share.
   */
  private holdTyping(
    id: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress
  ): () => Promise<void> {
    this.typingHolds.set(id, (this.typingHolds.get(id) ?? 0) + 1);
    const stopLoop = this.startTypingLoop(platform, address);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      stopLoop();
      const left = (this.typingHolds.get(id) ?? 1) - 1;
      if (left > 0) {
        this.typingHolds.set(id, left);
        return;
      }
      this.typingHolds.delete(id);
      await platform.stopTyping(address);
    };
  }

  /**
   * Compute the turn footer text (only when display.footer.enabled; else empty string = no append).
   *
   * Everything reported by the agent wins over configuration, because configuration can be silent or
   * merely an intent:
   * - context numbers come from ACP `usage_update` (`used` is the harness's own tally, `size` the
   *   window it learned from the live model), never from a guess. A harness that reports no usage
   *   leaves both undefined and the context fields render nothing rather than an invented limit.
   * - the model comes from the agent's session config when available; `agents[].model` is empty for
   *   an env-pinned harness and at best an unresolved alias.
   *
   * The agent field is the config id (`cc` / `oc`), deliberately terse: the footer is a compact
   * status line appended to every reply, so it uses the short name even though the header bubble —
   * sent once per session — spells out the harness.
   */
  private buildFooter(conversationId: ConversationId, ref: TurnRef): string {
    if (!this.config.display.footer.enabled) return '';
    const agentId = this.deps.agentIdOf(conversationId);
    const def = findAgent(this.config, agentId);
    return formatRuntimeFooter(
      {
        agent: agentId,
        model: ref.model ?? this.deps.getModelOverride(conversationId) ?? def?.model,
        contextTokens: ref.usage?.used,
        contextLength: ref.usage?.size,
        effort: ref.effort,
        // The conversation's own directory, not `agents[].cwd`: after a `/cd` the two differ, and
        // the footer reports what is actually serving this turn.
        cwd: this.deps.getWorkdir?.(conversationId) ?? def?.cwd,
        homeDir: process.env.HOME,
      },
      this.config.display.footer.fields
    );
  }

  /**
   * Take ~first 40 chars of the batch as a thread name (cleaned of newlines/extra whitespace). Empty
   * returns "" (caller falls back to 'Conversation'). Concatenate raw content without identity/quote prefixes
   * to keep `[Alice]` noise out of the thread name.
   */
  private buildThreadName(batch: InboundMessage[]): string {
    const flat = batch
      .map((m) => m.content)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (flat.length <= 40) return flat;
    return flat.slice(0, 39) + '…';
  }

  /**
   * The text a conversation is named from: what the user actually said, whole.
   *
   * Deliberately NOT buildThreadName. That one cuts to 40 characters because a thread being created
   * needs a name right now and there is nothing to summarise it with; this one is summarised by a
   * model, and handing it a pre-cut seed would cap the result at a rewording of the first line.
   *
   * Sender names are left out, as they are everywhere else in the prompt now. A summariser
   * given `[Alice] …` puts the speaker's name in the topic title.
   */
  /** What a turn may name its topic from: the messages, a `/super` job, or nothing (see runTurn). */
  private titleSeedOf(batch: InboundMessage[], last: string, isCommandTurn: boolean): string | undefined {
    if (batch.every((m) => m.conversation.user === UPDATE_SENDER)) return undefined;
    return isCommandTurn ? jobInCommand(last) : this.buildTitleSeed(batch);
  }

  private buildTitleSeed(batch: InboundMessage[]): string {
    return batch
      .map((m) => m.content)
      .join('\n')
      .trim();
  }

  /**
   * Merge multiple user messages into one prompt segment, injecting quoted context.
   *
   * Rules:
   *  - The message text goes in as typed. No sender name is added, in any kind of conversation.
   *  - If a message has quotedContent, prepend a quote-context line:
   *    `(replying to: "<quotedContent truncated to 120 chars>")`. It carries no author either.
   *  - Multiple messages joined by newlines.
   *
   * Sender names used to be added as a `[<authorName>] ` prefix wherever the conversation kind was
   * not `direct`, so that an agent in a busy group could tell speakers apart. Removed on 2026-10-08
   * because nobody here is in that situation: `access.allowFrom` admits a single person, so the
   * name never told two speakers apart. It only put that person's handle at the start of every
   * turn. And `direct` was the wrong test anyway. A Telegram private chat with topics enabled
   * reports `kind: 'thread'` (see `telegramConversation`), so the user's own DMs reached the agent
   * as `[<their handle>] …`, as did their one-person Lark topic group. The quoted author went for the
   * same reason: in a one-person chat the quoted message is either theirs or the bot's.
   *
   * `InboundMessage.authorName` and `quotedAuthor` are still filled in by the platforms. This was
   * the only place that read them.
   */
  private mergePrompt(batch: InboundMessage[]): string {
    const QUOTE_LIMIT = 120;
    return batch
      .map((m) => {
        // Slash commands must reach the agent starting with `/cmd` (the SDK decides command execution by
        // whether the first block starts with `/`), so output as-is with no quote line; a
        // `(replying to …)` line in front would turn the command into plain chat text.
        if (looksLikeCommand(m.content)) return m.content;
        const lines: string[] = [];
        if (m.quotedContent) {
          const flat = m.quotedContent.replace(/\s+/g, ' ').trim();
          const quoted = flat.length <= QUOTE_LIMIT ? flat : flat.slice(0, QUOTE_LIMIT - 1) + '…';
          lines.push(`(replying to: "${quoted}")`);
        }
        lines.push(m.content);
        return lines.join('\n');
      })
      .join('\n');
  }

  /**
   * Assemble the final turn prompt: after mergePrompt (quote context), best-effort append injected text
   * from inbound attachments (readable text inlined + binary/image saved-path lines), plus the pictures
   * a harness may be shown as pictures (core `pickImages` decides which).
   *
   * Any attachment-processing error is swallowed and logged — never blocks the turn (the agent still
   * runs, just without attachment context). The attachment block is separated by `---\nAttachments:`.
   */
  private async buildPrompt(
    batch: InboundMessage[],
    platform: PlatformAdapter,
    agentId: string
  ): Promise<{ prompt: string; images: TurnImage[] }> {
    const base = this.mergePrompt(batch);
    if (!this.config.attachments.enabled) return { prompt: base, images: [] };

    // Collect all attachments in the batch (order-preserving); return early if none.
    const atts: AttachmentInput[] = [];
    for (const m of batch) {
      for (const a of m.attachments ?? []) {
        atts.push({ type: a.type, url: a.url, name: a.name, mime: a.mime, size: a.size });
      }
    }
    if (atts.length === 0) return { prompt: base, images: [] };

    try {
      // The platform fetches its own private media (Lark `internal:` URLs); everything else
      // goes over plain HTTP. Bound per turn because the adapter is resolved per turn.
      const deps = createAttachmentIngestDeps(
        this.config,
        platform.fetchAttachment ? (url) => platform.fetchAttachment!(url) : undefined
      );
      // A file for an agent on another machine is put on that machine, where it can open it.
      const host = remoteHosts.hostFor(findAgent(this.config, agentId));
      if (host) deps.save = remoteAttachmentSave(host);
      const { promptText, images, heldBack } = await ingestAttachments(
        atts,
        {
          maxInjectBytes: this.config.attachments.maxInjectBytes,
          maxDownloadBytes: this.config.attachments.maxDownloadBytes,
        },
        deps
      );
      for (const h of heldBack) {
        console.log(`[turn] picture ${h.name} goes to the agent by path only: ${h.reason}`);
      }
      const turnImages = images.map((img) => ({
        name: img.name,
        mimeType: img.mimeType,
        data: Buffer.from(img.bytes).toString('base64'),
      }));
      if (!promptText) return { prompt: base, images: turnImages };
      return { prompt: `${base}\n\n---\nAttachments:\n${promptText}`, images: turnImages };
    } catch (e) {
      // best-effort: attachment injection failure never blocks the turn.
      console.error('[turn] attachment injection failed:', e instanceof Error ? e.message : e);
      return { prompt: base, images: [] };
    }
  }
}
