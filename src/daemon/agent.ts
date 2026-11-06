import type {
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  EffortSelector,
  ElicitAnswer,
  ModelSelector,
  PermissionAnswer,
  QuotaPool,
  SteerOutcome,
  ToolEvent,
  ToolFinishEvent,
  TurnFailureReason,
} from '../types.js';
import type { PromptImageType } from '../core/attachment-ingest.js';
// ModelSelector lives in types.ts rather than here: core/model-menu.ts renders it into a paginated
// button menu, and core may not import daemon/. Re-exported so the runtimes keep one import site.
// EffortSelector likewise, for core/effort-menu.ts; SteerOutcome for core/inbound-merger.ts.
export type { EffortSelector, ModelSelector, SteerOutcome };

/**
 * Thin wrapper over the agent runtime (ACP implementation in agent-acp.ts). One AgentSession per session
 * key, context retained across turns. Under the ACP resident process the token is a per-session stable
 * value, injected into the child env at spawn so the session's reverse CLI (talkcode) can connect back to
 * the daemon and locate "current session → current channel".
 */

export interface AgentStreamHandlers {
  /** Text delta → StreamBuffer.push */
  onText(delta: string): void;
  /** Tool start → ToolRenderer.onToolStart */
  onToolStart(evt: ToolEvent): void;
  /** Tool finish → ToolRenderer.onToolFinish (accumulate mode marks the bubble ✓/✗ + duration) */
  onToolFinish(evt: ToolFinishEvent): void;
  /** Body segment switch (around tools) → flush current buffer and start a new segment */
  onSegmentBreak(): void;
  /**
   * Agent dynamically reports its available-commands list (ACP `available_commands_update`).
   * Optional: not every harness / turn sends it (usually once after first-turn startup, then on change).
   * The daemon registers native platform slash from it.
   */
  onAvailableCommands?(cmds: AgentCommand[]): void;
  /**
   * Agent reports live context usage (ACP `usage_update`): tokens currently in context and the
   * window size. Optional — a harness that never sends it leaves the footer's context segment
   * absent rather than showing a guessed number.
   *
   * Sent repeatedly within a turn (claude-agent-acp emits one mid-stream per assistant message and
   * one at turn end); each is a full snapshot, so consumers overwrite rather than accumulate.
   */
  onUsage?(usage: AgentUsage): void;
  /**
   * The model actually serving this session, as the harness reports it (ACP session config option
   * `model`). More accurate than config: the `claude` harness takes its model from ANTHROPIC_MODEL
   * and resolves aliases like `opus[1m]` internally, so only the harness knows the concrete model.
   * Fired once after session startup and again on any `config_option_update`.
   */
  onModel?(model: string): void;
  /**
   * The session's reasoning effort (ACP config option in the `thought_level` category), for the
   * footer. Fired at turn start when there is one, and on every `config_option_update` — with
   * undefined when the update no longer carries a level, so a stale one is cleared, not kept.
   */
  onEffort?(effort: string | undefined): void;
  /**
   * The harness's usage-quota pools (agy, through its one-shot `agy -p=/usage` — see
   * daemon/agy-acp.ts). A full snapshot each time, like onUsage. Optional: no ACP harness reports
   * quota in a form the gateway reads, so for them the status bar simply has no quota segment.
   */
  onQuota?(pools: QuotaPool[]): void;
  /**
   * The agent stopped mid-turn to ask the user something (ACP `elicitation/create`), and is
   * blocked on the answer. Resolve with the user's choice, `decline`, or `cancel`.
   *
   * Turn-scoped rather than session-scoped because the question needs somewhere to be asked: the
   * turn is what knows the platform and address the conversation is currently answering in. A
   * question arriving with no turn open has no such lane, and is cancelled by the runtime.
   *
   * Optional, and absent means "cancel it": a client that cannot render the question must say so
   * rather than answer for the user. On the `claude` harness the model then reports the question
   * as unanswered instead of proceeding on a guess.
   */
  onElicit?(request: AgentElicitation): Promise<ElicitAnswer>;
  /**
   * The agent asks leave to run a tool, and its agent is configured `permissions: ask`: put it to
   * the user and resolve with what became of it (see PermissionAnswer). Same lane and same
   * blocking contract as onElicit.
   *
   * Absent means nobody can be asked, and the runtime declines with the agent told why — never
   * approves, since `ask` is a promise that nothing runs unseen.
   */
  onPermission?(request: AgentPermissionRequest): Promise<PermissionAnswer>;
  /**
   * Something worth saying about this turn that is not part of the agent's reply: the harness
   * logged an error and is retrying (see harness-log.ts), or reported a retry, an advisory or a
   * failure over ACP itself (see session-failure.ts).
   *
   * Sent as its own message rather than pushed into the streaming body, because the body belongs to
   * the agent: folding a gateway diagnostic into it would leave a sentence the agent never wrote
   * sitting inside its answer, and the footer would then count it as output.
   *
   * Optional, and absent means the runtime stays quiet — a client with nowhere to put an aside is
   * not a reason to fail the turn.
   */
  onNotice?(text: string): void;
}

/**
 * Where output that arrives OUTSIDE a turn goes.
 *
 * ── Why a harness produces output with no turn open ─────────────────────────────────────────────
 * Because Claude Code's background work outlives the turn that started it, by design. A
 * `run_in_background` Bash call, or a background Task, returns immediately; the agent ends its turn
 * saying it will report back; and when the process exits the SDK re-invokes the model on its own
 * with a task-notification. claude-agent-acp settles the ACP prompt at the turn's terminal `result`
 * precisely so the client unlocks instead of waiting on that background work (its own comment cites
 * issue #773), and then keeps emitting the followup's `session/update` notifications with no prompt
 * in flight — stating outright that "the consumer keeps draining afterward (absorbing idle and
 * forwarding any background output)".
 *
 * talkcode used to break that contract: the read loop stopped at `stop`, so every character
 * the agent produced after a long script finished landed in the SDK's queue unread and was cleared
 * as residue at the start of the next turn. From the chat side the conversation simply went silent
 * after "I've started it in the background, I'll let you know" — the exact bug this seam exists for.
 *
 * ── The lazy shape, and what it protects ────────────────────────────────────────────────────────
 * `handlers()` is asked for once per burst and must always answer, because the metadata half
 * (title / usage / model) has to be recorded whether or not anything is rendered. The RENDERING
 * half opens a fresh message only when text or a tool actually arrives — otherwise a lone
 * `session_info_update`, which claude-agent-acp sends after every single turn, would post an empty
 * "background update" bubble to every conversation forever.
 */
export interface FollowUpSink {
  /**
   * Handlers for one burst of out-of-turn output. Called once when the burst starts; the same set
   * is reused until `close()`.
   */
  handlers(): AgentStreamHandlers;
  /**
   * The burst is over — finalize whatever was opened (flush the tail, append the footer).
   *
   * Called when the harness reports a completed result, when a new turn takes over, or when the
   * burst goes quiet. `stopped` when it was cut off instead of finishing: `/stop`, a new turn
   * taking the lane, or the child exiting mid-burst. That is the difference between a turn the
   * library can call `done` and one it must call `stopped` — the words on screen are the same,
   * the answer to "did it finish" is not. Idempotent, and a no-op when nothing was ever rendered.
   *
   * Returns a promise so a caller that is about to write into the SAME lane can order itself
   * behind the flush. That is not a nicety: in the default `once` delivery mode the burst's entire
   * body is sent by this call, so a new turn's reply streaming concurrently would leave the
   * background report printed underneath an answer it has nothing to do with — with its own `⏱`
   * marker orphaned above both.
   */
  close(reason?: 'done' | 'stopped'): void | Promise<void>;
}

/** Live context usage from the agent (ACP UsageUpdate: `used` / `size`). */
export interface AgentUsage {
  /** Tokens currently in context. */
  used: number;
  /** Total context window size in tokens. */
  size: number;
  /**
   * Cumulative session cost, when the harness reports one (ACP `UsageUpdate.cost`). Absent on most
   * snapshots: claude-agent-acp sends it only with the one tied to a finished result, and codex-acp
   * never does. Probed on claude-agent-acp 0.81.0 (2026-09-30): it grows across turns ($0.319 →
   * $0.327) and carries on from there after the child is killed and the session reloaded ($0.337),
   * so it is the SESSION's total, not the process's — which is what lets the gateway quote it.
   */
  cost?: { amount: number; currency: string };
}

/** One picture as a runtime sends it: core's `PromptImage`, base64'd for the wire. */
export interface TurnImage {
  name: string;
  /** Sniffed from the bytes, never the platform's claim (see core `sniffImageType`). */
  mimeType: PromptImageType;
  /** base64, no `data:` prefix — the shape ACP's `ImageContent.data` takes. */
  data: string;
}

export interface RunTurnInput {
  /** Merged user input (already assembled into one segment). */
  prompt: string;
  /**
   * Pictures the user sent, for a runtime that can put them in front of the agent as pictures.
   * `prompt` names every one of them by its saved path regardless, so a runtime that cannot (agy,
   * or an ACP harness whose `initialize` does not claim `promptCapabilities.image`) drops these,
   * logs that it did, and still leaves the agent a file it can open.
   */
  images?: TurnImage[];
  /**
   * per-session stable token (injected into the agent child env as TALKCODE_TURN_TOKEN at spawn).
   * Reverse commands use it to connect back; the daemon resolves it to the current turn's channel. Same value every turn.
   */
  sessionToken: string;
  /** Per-turn model override; defaults to agent.model. Under ACP, model is usually fixed at newSession, so overrides typically apply next session. */
  model?: string;
}

export interface AgentSession {
  /** The conversation this agent instance serves (the factory's key). */
  readonly conversationId: string;
  /**
   * Run one turn, translating runtime stream events to handlers.
   * resolve = turn ended naturally; reject = error; abort() can interrupt.
   */
  runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void>;
  /**
   * Hand a message to the turn that is running right now, for the harness to take in at its own next
   * natural point — between tool calls, before its next request to the model — the way a coding
   * agent's CLI treats what is typed while it works. Nothing is cancelled: the tool running now
   * finishes, and the turn's reply answers the new message too. The turn ends only once it has.
   *
   * `refused` whenever that cannot be promised: no turn running, the turn already ending, a cancel
   * under way, or a harness with no way to take input mid-turn. The caller still owns the message
   * then, and sends it as the next turn.
   *
   * Optional: a runtime with no notion of it omits it, which reads as `refused` every time.
   */
  steer?(input: Pick<RunTurnInput, 'prompt' | 'images'>): Promise<SteerOutcome>;
  /** Interrupt the current turn (`/stop`). */
  abort(): void;
  /**
   * Install the destination for output this session produces outside any turn (see FollowUpSink).
   *
   * Optional so a runtime with no notion of out-of-turn output simply omits it, and idempotent —
   * TurnRunner installs the same sink at the top of every turn rather than tracking whether this
   * session has one yet, because a session can be rebuilt underneath it (crash, `/cd`, idle
   * reclaim) and a sink installed once would then be attached to a dead child.
   */
  setFollowUpSink?(sink: FollowUpSink): void;
  /**
   * Cancel background work that is producing output right now — a follow-up burst (see
   * FollowUpSink) — and report whether there was any.
   *
   * `abort()` cannot do this, because it is scoped to a turn and a burst has none: the harness
   * re-invoked itself when a background task finished, so from the gateway's side the merger is
   * idle and `/stop` used to answer "Nothing is running here" while tool bubbles were still
   * appearing above it. The cancel itself does reach that work — claude-agent-acp's `cancel()`
   * interrupts the SDK query whether or not a prompt is in flight (verified in 0.81.0,
   * acp-agent.js `cancel`, 2026-09-24).
   *
   * False whenever no burst is rendering, including the stretch BETWEEN bursts where the agent is
   * waiting on a background process: no model cycle is running then, so there is nothing a cancel
   * could interrupt and saying otherwise would be untrue. Also false while a turn is running —
   * that is `abort()`'s job, and the merger already routes `/stop` there.
   *
   * Optional so a runtime with no out-of-turn output simply omits it; `/stop` then reports idle.
   */
  stopBackground?(): boolean;
  /**
   * The live session's model selector, or undefined when the harness exposes none.
   *
   * Non-spawning: reports what is already known and never starts a child. A caller that wants an
   * answer for a conversation which has not run yet must ask for one with `ensureSession` first —
   * see the note there for why that used to be refused outright.
   */
  modelSelector?(): ModelSelector | undefined;
  /**
   * Bring the session up — spawn the child, `session/new` or `session/load` — without running a turn.
   *
   * Exists because a model list is not knowable without it. Under ACP the selector arrives as part
   * of the `session/new` response, so before a conversation's first turn there is genuinely nothing
   * to show; `modelSelector()` used to answer undefined and the gateway told the user to "send a
   * message, then /model".
   *
   * That was the wrong trade, and the flow it broke is the common one: pick a directory with `/cd`,
   * pick a model, then start work. `/cd` even makes it worse than a fresh conversation — it drops
   * the session so the next `/model` has nothing to read either. The child being started here is
   * the same child the next message would have started anyway, so the cost is bounded to bringing
   * it forward; the reason to keep this separate from `runTurn` is that no prompt is sent and no
   * context is consumed.
   *
   * Resolving means "a selector may now be available", not that one is — a harness with no model
   * selector at all is a normal outcome, and callers must still handle `modelSelector()` returning
   * undefined. Rejects when the session cannot be established (harness missing, auth required), and
   * that rejection is worth surfacing: it is the real reason, where "no selector yet" was a guess.
   *
   * Optional so a runtime with nothing to warm up (or nothing to warm it with) simply omits it.
   */
  ensureSession?(sessionToken: string): Promise<void>;
  /**
   * Re-ask the harness which models it offers, ahead of a `/model` that is about to show them.
   *
   * For a runtime whose list is NOT part of the live session. An ACP selector arrives with
   * `session/new` and is kept current by `config_option_update`, so it has nothing to refresh and
   * omits this. agy's list comes from a separate `agy models` call that is cached per factory, and
   * that list is served by Google, not baked into the binary: on 2026-10-03 the same agy 1.2.13
   * binary listed `claude-opus-5-5-*`, while a daemon started on 2026-09-29 still offered only the
   * list it fetched at startup. Without a refresh, the only way to see a new model was to restart
   * the daemon.
   *
   * Never rejects, and a failed or empty answer keeps the previous list: a `/model` that briefly
   * cannot reach the harness should still show what it knew, not report "no model selector".
   */
  refreshModels?(): Promise<void>;
  /**
   * Switch the live session's model, returning the name the harness reports afterwards.
   *
   * Applies to the RUNNING session (ACP `session/set_config_option`), and is remembered so a later
   * restart of the same conversation's child re-applies it instead of falling back to config.
   * Rejects when there is no session, no selector, or the harness refuses the value.
   */
  setModel?(value: string): Promise<string>;
  /**
   * The live session's reasoning-effort selector, or undefined when its current model offers none.
   *
   * Non-spawning, like modelSelector — `ensureSession` first for a conversation that has not run.
   * Undefined is a per-MODEL answer, not a per-harness one: opencode and codex both offer levels
   * for some models and not others, so it can change with a `/model`.
   */
  effortSelector?(): EffortSelector | undefined;
  /**
   * Switch the live session's reasoning effort, returning the level the harness reports afterwards.
   *
   * Remembered like setModel's choice, and re-applied on every rebuilt child — which, unlike the
   * model, is not optional: probed 2026-09-23, claude-agent-acp 0.81.0 and codex-acp 1.13.0 both
   * answer `session/load` at their DEFAULT level, not the one the session was left on (opencode
   * 2.0.14 keeps it). So an idle reclaim would otherwise quietly undo the user's choice.
   * Rejects when the live session offers no levels or the harness refuses the value.
   */
  setEffort?(value: string): Promise<string>;
  /**
   * Whether this session's resident child could be shut down right now without losing anything.
   *
   * Answers exactly one question, asked only by the registry's idle sweeper: is there a process
   * worth reclaiming here, and would the NEXT turn be able to pick the conversation back up?
   *
   * Absent (a runtime that does not implement it) is read as `unresumable` — never reclaimed.
   * Silently restarting a user's task is the one degradation this gateway refuses, so a runtime
   * that cannot state its own resumability does not get guessed at.
   */
  reclaimState?(): ReclaimState;
  /**
   * Release the session: abort the running turn and drop continuation context (shut down the ACP
   * child). Called on idle reclaim and on shutdown.
   *
   * Not a terminal operation on the handle: both runtimes reset their connection handles and
   * respawn on the next turn (the same self-healing path a crashed child takes), which is what lets
   * the sweeper reclaim a process while keeping the session object — and with it, the conversation's
   * runtime model choice.
   */
  dispose(): void;
}

/**
 * Whether a session's resident child can be reclaimed (killed) without costing the user anything.
 *
 * - `no-child`   — nothing is running; reclaiming would free nothing.
 * - `resumable`  — a child is up AND its context id is recorded where the next turn can replay it
 *                  (ACP `session/load`, agy `--conversation`). Killing it costs a respawn, not a
 *                  conversation. This is the same path a daemon restart already takes.
 * - `unresumable`— a child is up but its context exists only inside that process. Never reclaimed.
 */
export type ReclaimState = 'no-child' | 'resumable' | 'unresumable';

/**
 * A turn failure the runtime could put a reason to (see TurnFailureReason for the vocabulary).
 *
 * Thrown by the runtimes in place of a plain Error wherever they know WHY, so that
 * `hooks.turnFailed` can tell an upstream 5xx worth continuing after from a missing login that no
 * amount of continuing fixes. The message is unchanged: it is still the sentence the chat shows.
 * Anything thrown that is not one of these reads as `other` (turnFailureReason).
 *
 * Here, in the interfaces file, because both runtimes and the agent hooks throw it and the turn
 * runner reads it — and this file imports nothing they could cycle through.
 */
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly reason: TurnFailureReason
  ) {
    super(message);
    this.name = 'TurnFailure';
  }
}

/** The reason a turn failed with, `other` for anything a runtime did not classify. */
export function turnFailureReason(err: unknown): TurnFailureReason {
  return err instanceof TurnFailure ? err.reason : 'other';
}

/**
 * Session factory. getOrCreate gets/builds a session by (sessionId, agentId) — agentId selects which
 * agent def (harness/cwd/model/env). The same sessionId reuses the same session handle.
 */
export interface AgentFactory {
  getOrCreate(sessionId: string, agentId: string): AgentSession;
  /**
   * The session serving this conversation, or undefined — WITHOUT creating one.
   *
   * getOrCreate would defeat its only caller: the idle sweeper asks "is there a child here worth
   * stopping", and building a session handle in order to answer is the opposite of the question.
   */
  peek(sessionId: string): AgentSession | undefined;
  /** Release and remove a session (called on shutdown / `/new`); no-op if absent. */
  dispose(sessionId: string): void;
}
