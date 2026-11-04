import type { Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import {
  continueDelayMs,
  describeFailureReason,
  failureLine,
  replyLine,
} from '../core/topic-stage.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, TopicActivity, TurnFailureReason, TurnOutcome } from '../types.js';
import { turnFailureReason } from './agent.js';
import { resolveConversationCwd } from './agent-common.js';
import { runTurnFailedHook } from './agent-hooks.js';
import type { ConversationStore } from './conversation-store.js';
import { CARD_ITEM_CHARS } from './delegation.js';
import type { TurnEnd } from './turn-runner.js';

/**
 * What each conversation's last turn left for the person, and what the gateway does about a failed
 * one. One object for the three things that all start from "a turn ended":
 *
 *  1. **Activity** — the outcome (a reply to read, a failure) and any scheduled continue, pushed to a
 *     platform that lists conversations (`PlatformAdapter.setActivity`), so the person can see which
 *     of them need them without opening each. Super-agent's lesson, built from facts only (see
 *     core/topic-stage.ts): one person watching N conversations is the bottleneck, so the gateway's
 *     job is to make the N cost nothing until one needs them.
 *  2. **`hooks.turnFailed`** — continue automatically after a failure the operator named, and run
 *     their alert command. Super-agent retries a passing provider failure three times with a growing
 *     backoff before it asks a person; here the operator decides whether to, after which reasons, how
 *     often, and with what words, because the words are put in front of the agent as theirs.
 *  3. **Interrupted turns** — a turn still marked as running when the daemon starts was cut off by
 *     the last one (a drain that ran out of time, or a crash). Said in the chat, and treated as a
 *     failure with reason `restart`, so it reaches the list and can be continued like any other.
 *
 * The registry owns the conversations and calls in; this holds no conversation state of its own
 * beyond these facts, and is told about everything through the methods below.
 */

/** What TurnOutcomes needs from the registry (DI, like TurnRunnerDeps). */
export interface TurnOutcomesDeps {
  config: Config;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  platforms: Map<string, PlatformAdapter>;
  store?: ConversationStore;
  /** Where the conversation is answered; undefined before its first turn. */
  laneOf(id: ConversationId): { address: ConversationAddress; platformId: string } | undefined;
  /** The agent bound to the conversation. */
  agentIdOf(id: ConversationId): string;
  /**
   * Put the operator's continue message in front of the agent as a turn of its own, behind anything
   * already running there and interrupting nothing (InboundMerger.enqueueSolo). False when it could
   * not be (the conversation has no lane, or another agent answers it now).
   */
  runContinue(id: ConversationId, text: string): boolean;
  /**
   * The conversation now has something for the person (a reply, a failure that will not be
   * continued). Delegation listens here, for a sub-agent's topic (daemon/delegation.ts); absent = nobody does.
   */
  onNeedsPerson?(id: ConversationId): void;
}

/**
 * A turn's reply or error as an update card needs it: the head the card can carry, and how long
 * the whole was. Keeping the head bounded is what stops one long review from being held in memory
 * forever; the card never shows more than CARD_ITEM_CHARS of one entry, and `total` is what lets a
 * cut say how much it is not showing.
 */
export interface KeptText {
  text: string;
  total: number;
}

/** One conversation's automatic-continue bookkeeping. */
interface Continuing {
  /** Continues already SENT in this run of failures. Reset by a normal end, a stop, or the person. */
  sent: number;
  /** Cancels the continue waiting to be sent, if one is. */
  cancel?: () => void;
}

export class TurnOutcomes {
  private readonly activity = new Map<ConversationId, TopicActivity>();
  /**
   * The head of each conversation's last finished reply, for a sub-agent update, with the whole's
   * length. Kept here rather than pushed with the activity: a platform's list shows one line, and
   * this is only ever read by the daemon. Bounded rather than whole, because every conversation's
   * outcomes are held here, not just sub-agent topics; the card applies its own budget on top
   * (delegation.ts).
   */
  private readonly replies = new Map<ConversationId, KeptText>();
  /** The same for a failed turn's error: the card needs more than its first line. */
  private readonly failures = new Map<ConversationId, KeptText>();
  private readonly continuing = new Map<ConversationId, Continuing>();

  constructor(private readonly deps: TurnOutcomesDeps) {}

  /** The conversation's last finished reply, while it is still the last thing that happened. */
  replyOf(id: ConversationId): KeptText | undefined {
    return this.activity.get(id)?.outcome?.kind === 'done' ? this.replies.get(id) : undefined;
  }

  /** The last failed turn's error, while it is still the last thing that happened. */
  failureOf(id: ConversationId): KeptText | undefined {
    return this.activity.get(id)?.outcome?.kind === 'failed' ? this.failures.get(id) : undefined;
  }

  /** A released scheduled run, or shutdown, is dropping the conversation's state: its texts go too. */
  dropTexts(id: ConversationId): void {
    this.replies.delete(id);
    this.failures.delete(id);
  }

  /** What is known about a conversation's last turn (for a list built on the daemon's side). */
  activityOf(id: ConversationId): TopicActivity | undefined {
    return this.activity.get(id);
  }

  /**
   * A turn started. Whatever the last one left is superseded — the person's reply-to-read and a
   * failure alike — and a continue still waiting is called off: this turn is the next thing that
   * happens here, whoever started it. The count of continues already sent is kept, because this
   * turn may BE one of them; only an end that is not a failure resets it.
   *
   * Also marks the conversation as mid-turn on disk (ConversationRecord.inFlight).
   */
  turnStarted(id: ConversationId): void {
    this.callOffPending(id);
    this.replies.delete(id);
    this.failures.delete(id);
    this.set(id, {});
    this.deps.store?.setInFlight(id, this.deps.clock.now());
  }

  /** A turn ended (TurnRunner.recordTurnEnd). */
  turnEnded(id: ConversationId, end: TurnEnd): void {
    this.deps.store?.setInFlight(id, undefined);
    const at = this.deps.clock.now();
    switch (end.kind) {
      case 'done': {
        this.continuing.delete(id);
        this.failures.delete(id);
        const text = end.text.trim();
        if (text) this.replies.set(id, kept(text));
        else this.replies.delete(id);
        const line = replyLine(end.text);
        this.set(id, { outcome: { kind: 'done', at, ...(line ? { line } : {}) } });
        this.deps.onNeedsPerson?.(id);
        return;
      }
      case 'stopped':
        // The person stopped it: nothing is left for them, and nothing should carry on by itself.
        this.continuing.delete(id);
        this.replies.delete(id);
        this.failures.delete(id);
        this.set(id, {});
        return;
      case 'failed': {
        const message = end.error instanceof Error ? end.error.message : String(end.error);
        this.failed(id, turnFailureReason(end.error), message, at);
        return;
      }
      default: {
        const _exhaustive: never = end;
        throw new Error(`unknown turn end: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * The person did something here — sent a message, `/stop`, `/new`, `/kill`. Calls off a continue
   * that is waiting and forgets the count: from now on they are driving, and a failure after this is
   * the first of a new run.
   */
  personActed(id: ConversationId): void {
    const had = this.continuing.get(id)?.cancel !== undefined;
    this.callOffPending(id);
    this.continuing.delete(id);
    if (had) {
      const current = this.activity.get(id);
      if (current?.retry) this.set(id, { ...(current.outcome ? { outcome: current.outcome } : {}) });
    }
  }

  /** `/new`: the conversation's slate is clean, outcome and all. */
  forget(id: ConversationId): void {
    this.personActed(id);
    this.activity.delete(id);
    this.replies.delete(id);
    this.failures.delete(id);
    this.push(id, undefined);
  }

  /** Shutdown: no continue may fire into a daemon that is going away. */
  dispose(): void {
    for (const c of this.continuing.values()) c.cancel?.();
    this.continuing.clear();
  }

  /**
   * Find the turns the last daemon never finished (ConversationRecord.inFlight) and treat each as a
   * failure with reason `restart`: say so where it ran, put it in the person's list, and continue it
   * if the agent's `hooks.turnFailed` says to. Called once, after the platforms are up — the notice
   * has to have somewhere to go.
   *
   * `ensure` creates the conversation's state (bound as the store remembers) so a continue has a
   * merger to run in; false when it cannot be (an agent since removed from config).
   */
  recoverInterrupted(ensure: (id: ConversationId, platform: string, agentId: string) => boolean): number {
    const store = this.deps.store;
    if (!store) return 0;
    let found = 0;
    for (const [id, rec] of store.entries()) {
      const startedAt = rec.inFlight;
      if (startedAt === undefined) continue;
      // Read before clearing: entries() hands out the store's own records, which this rewrites.
      const lane = rec.lane;
      const agent = rec.agent;
      store.setInFlight(id, undefined);
      found++;
      const since = new Date(startedAt).toISOString();
      console.warn(`[outcomes] ${id}: a turn started at ${since} was still running when the gateway last stopped`);
      if (!lane || !ensure(id, lane.platform, agent)) continue;
      const where = this.deps.laneOf(id);
      if (where) {
        void this.deps.platforms
          .get(where.platformId)
          ?.sendMessage(where.address, '⚠️ The gateway restarted before this turn finished — the agent stopped where it was.')
          .catch((e) => console.warn('[outcomes] could not report an interrupted turn:', e instanceof Error ? e.message : e));
      }
      this.failed(id, 'restart', 'the gateway restarted mid-turn', this.deps.clock.now());
    }
    return found;
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /** A failed turn: record it, run the operator's command, and continue if the policy says to. */
  private failed(id: ConversationId, reason: TurnFailureReason, message: string, at: number): void {
    const outcome: TurnOutcome = { kind: 'failed', at, line: failureLine(message), reason };
    this.failures.set(id, kept(message));
    const scheduled = this.scheduleContinue(id, reason);
    this.set(id, { outcome, ...(scheduled ? { retry: scheduled } : {}) });
    this.reportToCommand(id, reason, message, at, scheduled);
    if (!scheduled) this.deps.onNeedsPerson?.(id);
  }

  /**
   * Schedule the next automatic continue if the agent's policy covers this reason and has attempts
   * left. Returns what was scheduled, or undefined (no policy, a reason it does not name, or the
   * attempts are spent — which is said in the chat, since the last notice promised a continue).
   */
  private scheduleContinue(id: ConversationId, reason: TurnFailureReason): TopicActivity['retry'] {
    const agentId = this.deps.agentIdOf(id);
    const policy = findAgent(this.deps.config, agentId)?.hooks?.turnFailed?.continue;
    if (!policy || !policy.on.includes(reason)) {
      this.continuing.delete(id);
      return undefined;
    }
    const state = this.continuing.get(id) ?? { sent: 0 };
    if (state.sent >= policy.max) {
      this.continuing.delete(id);
      this.say(id, `↻ Not continuing again: ${policy.max} automatic ${policy.max === 1 ? 'continue' : 'continues'} in a row ended in a failure too.`);
      return undefined;
    }
    const attempt = state.sent + 1;
    const delay = continueDelayMs(attempt, policy.backoffMs);
    const at = this.deps.clock.now() + delay;
    state.cancel = this.deps.clock.schedule(() => this.fire(id, attempt, policy.message), delay);
    this.continuing.set(id, state);
    this.say(
      id,
      `↻ ${capitalise(describeFailureReason(reason))} — sending “${preview(policy.message)}” in ${seconds(delay)} ` +
        `(${attempt}/${policy.max}). Send anything, or /stop, to call it off.`
    );
    console.log(`[outcomes] ${id}: ${reason} — continue ${attempt}/${policy.max} in ${seconds(delay)}`);
    return { attempt, max: policy.max, at };
  }

  /** Send a scheduled continue. */
  private fire(id: ConversationId, attempt: number, message: string): void {
    const state = this.continuing.get(id);
    if (!state?.cancel) return; // called off in the meantime
    state.cancel = undefined;
    state.sent = attempt;
    if (!this.deps.runContinue(id, message)) {
      console.warn(`[outcomes] ${id}: continue ${attempt} could not be sent; leaving the failure for the person`);
      this.continuing.delete(id);
      const current = this.activity.get(id);
      this.set(id, { ...(current?.outcome ? { outcome: current.outcome } : {}) });
      this.deps.onNeedsPerson?.(id);
    }
  }

  private callOffPending(id: ConversationId): void {
    const state = this.continuing.get(id);
    if (state?.cancel) {
      state.cancel();
      state.cancel = undefined;
    }
  }

  /** hooks.turnFailed.command, fire-and-forget (it never fails a turn; see runTurnFailedHook). */
  private reportToCommand(
    id: ConversationId,
    reason: TurnFailureReason,
    message: string,
    at: number,
    scheduled: TopicActivity['retry']
  ): void {
    const def = findAgent(this.deps.config, this.deps.agentIdOf(id));
    if (!def?.hooks?.turnFailed?.command) return;
    void runTurnFailedHook(
      def,
      {
        agent: def.id,
        conversation: id,
        reason,
        message,
        at,
        ...(scheduled ? { continuing: { attempt: scheduled.attempt, max: scheduled.max } } : {}),
      },
      { cwd: resolveConversationCwd(def, id, this.deps.store) }
    );
  }

  private set(id: ConversationId, activity: TopicActivity): void {
    this.activity.set(id, activity);
    this.push(id, activity);
  }

  /** Tell the conversation's platform. Best-effort: a list that is out of date is not worth a turn. */
  private push(id: ConversationId, activity: TopicActivity | undefined): void {
    const lane = this.deps.laneOf(id);
    if (!lane) return;
    try {
      this.deps.platforms.get(lane.platformId)?.setActivity?.(lane.address, activity);
    } catch (e) {
      console.warn('[outcomes] could not push a conversation outcome:', e instanceof Error ? e.message : e);
    }
  }

  /** A line in the conversation, best-effort. */
  private say(id: ConversationId, text: string): void {
    const lane = this.deps.laneOf(id);
    if (!lane) return;
    void this.deps.platforms
      .get(lane.platformId)
      ?.sendMessage(lane.address, text)
      .catch((e) => console.warn('[outcomes] could not post a notice:', e instanceof Error ? e.message : e));
  }
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/**
 * A reply or error kept for the update card, cut to the most the card can show of one entry.
 *
 * The card never shows more, so holding more would only keep a long review's bytes for every
 * conversation until its next turn; `total` still says how long the whole was, so a cut is honest.
 */
function kept(text: string): KeptText {
  return { text: text.length > CARD_ITEM_CHARS ? text.slice(0, CARD_ITEM_CHARS) : text, total: text.length };
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
