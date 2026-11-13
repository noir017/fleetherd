import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import {
  continueDelayMs,
  describeFailureReason,
  failureLine,
  replyLine,
  undeliveredLine,
} from '../core/topic-stage.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, TopicActivity, TurnFailureReason, TurnOutcome } from '../types.js';
import { turnFailureReason } from './agent.js';
import { resolveConversationCwd } from './agent-common.js';
import { runTurnFailedHook } from './agent-hooks.js';
import type { ConversationStore } from './conversation-store.js';
import { CARD_ITEM_CHARS } from './delegation.js';
import type { TurnEnd } from './turn-runner.js';

/** An agent's `hooks.turnFailed.continue` policy, as parsed. */
type TurnFailedContinue = NonNullable<NonNullable<NonNullable<AgentDef['hooks']>['turnFailed']>['continue']>;

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
  /**
   * An agent's usage-limit cooldown is over (see Cooldown): whatever waited on it may go. Delegation
   * listens, for the update cards it held for a parent answered by that agent.
   */
  onCooldownOver?(agentId: string): void;
}

/**
 * A turn's reply or error as an update card needs it: the head the card can carry, and how long
 * the whole was. Keeping the head bounded is what stops one long review from being held in memory
 * forever; the card never shows more than CARD_ITEM_CHARS of one entry, and `total` is what lets a
 * cut say how much it is not showing.
 *
 * `turn` is the library's number for the turn it came from. The card quotes it so the rest can be
 * read from THAT turn: by the time the parent reads, a later turn — a background burst, most
 * often — may be the newest one.
 */
export interface KeptText {
  text: string;
  total: number;
  turn?: number;
}

/** One conversation's automatic-continue bookkeeping. */
interface Continuing {
  /** Continues already SENT in this run of failures. Reset by a normal end, a stop, or the person. */
  sent: number;
  /** Cancels the continue waiting to be sent, if one is. */
  cancel?: () => void;
}

/**
 * One agent over its usage limit, and the continues waiting for it to lift.
 *
 * A usage limit belongs to the agent's account, not to a conversation, but continues used to be
 * counted per conversation. On 2026-11-07 eight sub-agents on one cc account hit "All credentials
 * … are cooling down" together; each continued three times on its own clock, every attempt spent
 * ~200s in Claude Code's own retries, and the parents woken by their failure cards failed and
 * continued too — 43 failed turns in 11 conversations over 1.5 hours, until the person worked out
 * why (`project-reports/fleetherd-agent-friction-20261113/5-failed-stopped-turns.md` §1).
 *
 * So a `limit` failure cools the whole agent down. Its conversations' continues wait here instead of
 * on timers of their own; when the wait ends ONE of them is sent (the probe). If the probe gets
 * through — or any turn on that agent ends normally — the limit has lifted and every waiting continue
 * goes at once. If it hits the limit again the wait doubles (continueDelayMs, by `strikes`) and it
 * tries again; and when it has used up `max`, every conversation waiting with it is left for the
 * person too. The agent's limit gets `max` continues in all, not `max` per conversation.
 *
 * An agent whose policy does not continue after `limit` still cools down, at LIMIT_WAIT_MS: nothing
 * of its own waits, but a sub-agent update card for a parent it answers does (Delegation holds them
 * while `coolingDown`), because a card is a turn on the same account.
 */
interface Cooldown {
  /** `limit` failures that were news this episode — the first, and each probe's. Doubles the wait. */
  strikes: number;
  /** When the wait ends, epoch ms; undefined while a probe is out. */
  until?: number;
  /** Cancels the timer that ends the wait. */
  cancel?: () => void;
  /** The conversation whose continue was sent to find out whether the limit has lifted. */
  probe?: ConversationId;
  /** Conversations whose continue waits for it, in the order they will be tried, with that attempt. */
  waiting: Map<ConversationId, number>;
}

/** The first wait of a cooldown for an agent whose policy names no backoff for `limit`. */
const LIMIT_WAIT_MS = 60_000;

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
  /** Agents over their usage limit, by agent id (see Cooldown). */
  private readonly cooldowns = new Map<string, Cooldown>();

  constructor(private readonly deps: TurnOutcomesDeps) {}

  /** Whether an agent is cooling down after a usage limit (see Cooldown). */
  coolingDown(agentId: string): boolean {
    return this.cooldowns.has(agentId);
  }

  /** The conversation's last finished reply, while it is still the last thing that happened. */
  replyOf(id: ConversationId): KeptText | undefined {
    return this.activity.get(id)?.outcome?.kind === 'done' ? this.replies.get(id) : undefined;
  }

  /** The last failed turn's error, while it is still the last thing that happened. */
  failureOf(id: ConversationId): KeptText | undefined {
    return this.activity.get(id)?.outcome?.kind === 'failed' ? this.failures.get(id) : undefined;
  }

  /**
   * The registry let the conversation go (ConversationRegistry.releaseState: a throwaway scheduled
   * run when it ends, or shutdown): everything kept for it goes, and a continue still waiting is
   * called off — it could only find no lane, log that it could not be sent, and put the outcome back.
   * Nothing reads these afterwards: such a run has no topic, so no list or sub-agent card asks for
   * it. Nothing is pushed either: its lane was the person's own conversation, whose entry in the list
   * is not this run's to clear. Before this, only the texts went, and every run of a task without a
   * topic of its own left its outcome here for the life of the process.
   */
  release(id: ConversationId): void {
    this.callOffPending(id);
    this.leaveCooldown(id);
    this.continuing.delete(id);
    this.activity.delete(id);
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
        if (text) this.replies.set(id, kept(text, end.turn));
        else this.replies.delete(id);
        const line = replyLine(end.text);
        this.set(id, { outcome: { kind: 'done', at, ...(line ? { line } : {}) } });
        this.deps.onNeedsPerson?.(id);
        // A turn on this agent got through: whatever limit it was under has lifted.
        this.liftCooldown(this.deps.agentIdOf(id), 'a turn on it ended normally');
        return;
      }
      case 'stopped':
        // The person stopped it: nothing is left for them, and nothing should carry on by itself.
        this.continuing.delete(id);
        this.replies.delete(id);
        this.failures.delete(id);
        this.leaveCooldown(id);
        this.set(id, {});
        return;
      case 'failed': {
        const error = end.error instanceof Error ? end.error.message : String(end.error);
        // The library's record and the update card say what the ❌ said: that the agent never had it.
        const message = end.undelivered ? `${error}\n${undeliveredLine(end.undelivered.held)}` : error;
        this.failed(id, turnFailureReason(end.error), message, at, end.turn);
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
    const had = this.continuing.get(id)?.cancel !== undefined || this.waitingOn(id) !== undefined;
    this.callOffPending(id);
    this.leaveCooldown(id);
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
    for (const cd of this.cooldowns.values()) cd.cancel?.();
    this.cooldowns.clear();
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
  private failed(
    id: ConversationId,
    reason: TurnFailureReason,
    message: string,
    at: number,
    turn?: number
  ): void {
    const outcome: TurnOutcome = { kind: 'failed', at, line: failureLine(message), reason };
    this.failures.set(id, kept(message, turn));
    const scheduled = this.scheduleContinue(id, reason);
    this.set(id, { outcome, ...(scheduled ? { retry: scheduled } : {}) });
    this.reportToCommand(id, reason, message, at, scheduled);
    if (!scheduled) this.deps.onNeedsPerson?.(id);
    // A probe that failed for another reason got past the limit: that is not what is failing now.
    if (reason !== 'limit') {
      const agentId = this.deps.agentIdOf(id);
      if (this.cooldowns.get(agentId)?.probe === id) this.liftCooldown(agentId, `its probe failed for another reason (${reason})`);
    }
  }

  /**
   * Schedule the next automatic continue if the agent's policy covers this reason and has attempts
   * left. Returns what was scheduled, or undefined (no policy, a reason it does not name, or the
   * attempts are spent — which is said in the chat, since the last notice promised a continue).
   *
   * A `limit` goes to the agent's cooldown instead (limitHit): its continue waits with the others.
   */
  private scheduleContinue(id: ConversationId, reason: TurnFailureReason): TopicActivity['retry'] {
    const agentId = this.deps.agentIdOf(id);
    const policy = findAgent(this.deps.config, agentId)?.hooks?.turnFailed?.continue;
    if (reason === 'limit') return this.limitHit(agentId, id, policy);
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
    this.sendContinue(id, attempt, message);
  }

  /**
   * Put continue number `attempt` in front of the agent. False when it could not be (no lane, or
   * another agent answers here now) — the failure is then the person's, as if none had been promised.
   */
  private sendContinue(id: ConversationId, attempt: number, message: string): boolean {
    const state = this.continuing.get(id) ?? { sent: 0 };
    state.sent = attempt;
    this.continuing.set(id, state);
    if (this.deps.runContinue(id, message)) return true;
    console.warn(`[outcomes] ${id}: continue ${attempt} could not be sent; leaving the failure for the person`);
    this.continuing.delete(id);
    const current = this.activity.get(id);
    this.set(id, { ...(current?.outcome ? { outcome: current.outcome } : {}) });
    this.deps.onNeedsPerson?.(id);
    return false;
  }

  private callOffPending(id: ConversationId): void {
    const state = this.continuing.get(id);
    if (state?.cancel) {
      state.cancel();
      state.cancel = undefined;
    }
    // A continue waiting on its agent's cooldown is called off the same way. Not the probe: its own
    // continue starting a turn is what calls this, and it must stay the probe until that turn ends.
    const agentId = this.waitingOn(id);
    if (agentId !== undefined) this.cooldowns.get(agentId)?.waiting.delete(id);
  }

  // ── usage-limit cooldowns (see Cooldown) ──────────────────────────────────────────────────────

  /**
   * A turn on `agentId` failed with `limit`. Cools the agent down — or, when this was the probe or
   * the first such failure, makes the wait longer — and puts this conversation's continue in line
   * when the policy continues after a limit.
   */
  private limitHit(
    agentId: string,
    id: ConversationId,
    policy: TurnFailedContinue | undefined
  ): TopicActivity['retry'] {
    const continues = policy?.on.includes('limit') ? policy : undefined;
    const { cd, wasProbe } = this.noteLimit(agentId, id, continues?.backoffMs ?? LIMIT_WAIT_MS);
    if (!continues) {
      this.continuing.delete(id);
      return undefined;
    }
    const state = this.continuing.get(id) ?? { sent: 0 };
    if (state.sent >= continues.max) {
      this.continuing.delete(id);
      this.say(id, `↻ Not continuing again: ${continues.max} automatic ${continues.max === 1 ? 'continue' : 'continues'} in a row ended in a failure too.`);
      // The probe has spent the agent's budget: the limit outlasted it, and the conversations
      // waiting on the same limit are told so rather than each spending a budget of their own.
      if (wasProbe) this.giveUpWaiting(agentId, cd, continues.max);
      return undefined;
    }
    const attempt = state.sent + 1;
    this.continuing.set(id, state);
    // The probe goes back to the front: it is the one already trying.
    cd.waiting = wasProbe ? new Map([[id, attempt], ...cd.waiting]) : cd.waiting.set(id, attempt);
    const at = cd.until ?? this.deps.clock.now();
    this.say(id, this.cooldownNotice(agentId, cd, id, continues, attempt, at));
    console.log(`[outcomes] ${id}: limit — continue ${attempt}/${continues.max} waits on ${agentId}'s cooldown`);
    return { attempt, max: continues.max, at };
  }

  /**
   * Count a `limit` failure against the agent's cooldown, starting one if there is none. Answers the
   * cooldown, and whether this conversation was its probe.
   */
  private noteLimit(agentId: string, id: ConversationId, base: number): { cd: Cooldown; wasProbe: boolean } {
    let cd = this.cooldowns.get(agentId);
    const fresh = cd === undefined;
    if (!cd) {
      cd = { strikes: 0, waiting: new Map() };
      this.cooldowns.set(agentId, cd);
      console.log(`[outcomes] ${agentId}: usage limit hit in ${id}; cooling the agent down`);
    }
    const wasProbe = cd.probe === id;
    if (wasProbe) cd.probe = undefined;
    // News is the first failure and each probe's. The rest of a burst that failed together says
    // nothing new and must not stretch the wait — eight of them would make it 2^8 times as long.
    if (fresh || wasProbe) {
      cd.strikes += 1;
      this.armCooldown(agentId, cd, base);
    } else if (!cd.cancel && cd.probe === undefined) {
      // Nobody is trying and nothing is timed (a probe was stopped, or could not be sent).
      this.armCooldown(agentId, cd, base);
    }
    return { cd, wasProbe };
  }

  /** What a conversation waiting on its agent's cooldown says: when it goes, and who waits with it. */
  private cooldownNotice(
    agentId: string,
    cd: Cooldown,
    id: ConversationId,
    policy: TurnFailedContinue,
    attempt: number,
    at: number
  ): string {
    const first = cd.waiting.keys().next().value === id && cd.probe === undefined;
    const others = cd.waiting.size - 1 + (cd.probe !== undefined ? 1 : 0);
    const when = first ? `in ${seconds(Math.max(0, at - this.deps.clock.now()))}` : 'once another conversation on it gets through';
    const behind =
      first && others > 0 ? `; ${others} more ${others === 1 ? 'conversation waits' : 'conversations wait'} for this one to get through` : '';
    return (
      `↻ ${capitalise(describeFailureReason('limit'))} on ${agentId} — sending “${preview(policy.message)}” ${when} ` +
      `(${attempt}/${policy.max})${behind}. Send anything, or /stop, to call it off.`
    );
  }

  /** (Re)start the wait, at the length this many strikes earns. */
  private armCooldown(agentId: string, cd: Cooldown, base: number): void {
    cd.cancel?.();
    const delay = continueDelayMs(cd.strikes || 1, base);
    cd.until = this.deps.clock.now() + delay;
    cd.cancel = this.deps.clock.schedule(() => this.cooldownElapsed(agentId), delay);
    console.log(`[outcomes] ${agentId}: cooling down for ${seconds(delay)} (strike ${cd.strikes})`);
  }

  /** The wait is over: send one waiting continue to find out, or end the cooldown if none waits. */
  private cooldownElapsed(agentId: string): void {
    const cd = this.cooldowns.get(agentId);
    if (!cd) return;
    cd.cancel = undefined;
    cd.until = undefined;
    const message = this.policyOf(agentId)?.message;
    for (const [id, attempt] of cd.waiting) {
      cd.waiting.delete(id);
      if (message === undefined) break;
      cd.probe = id;
      console.log(`[outcomes] ${agentId}: cooldown over; ${id} tries first`);
      if (this.sendContinue(id, attempt, message)) return;
      cd.probe = undefined;
    }
    this.liftCooldown(agentId, 'nothing waits on it any more');
  }

  /**
   * The limit has lifted (or nothing is left to wait on it): every waiting continue goes now, and
   * whatever else held back for it — Delegation's cards — is told.
   */
  private liftCooldown(agentId: string, why: string): void {
    const cd = this.cooldowns.get(agentId);
    if (!cd) return;
    this.cooldowns.delete(agentId);
    cd.cancel?.();
    console.log(`[outcomes] ${agentId}: cooldown lifted (${why}); ${cd.waiting.size} waiting continue(s) go now`);
    const message = this.policyOf(agentId)?.message;
    for (const [id, attempt] of cd.waiting) {
      if (message !== undefined) {
        this.sendContinue(id, attempt, message);
        continue;
      }
      // The policy went in a /reload while they waited: nothing will continue them now.
      this.continuing.delete(id);
      const current = this.activity.get(id);
      this.set(id, { ...(current?.outcome ? { outcome: current.outcome } : {}) });
      this.deps.onNeedsPerson?.(id);
    }
    this.deps.onCooldownOver?.(agentId);
  }

  /** The probe ran out of attempts: everything waiting with it is the person's now. */
  private giveUpWaiting(agentId: string, cd: Cooldown, max: number): void {
    for (const id of cd.waiting.keys()) {
      this.continuing.delete(id);
      const current = this.activity.get(id);
      this.set(id, { ...(current?.outcome ? { outcome: current.outcome } : {}) });
      this.say(id, `↻ Not continuing: ${agentId} stayed over its usage limit through ${max} automatic ${max === 1 ? 'continue' : 'continues'}.`);
      this.deps.onNeedsPerson?.(id);
    }
    console.log(`[outcomes] ${agentId}: the limit outlasted ${max} continue(s); ${cd.waiting.size} waiting conversation(s) left for the person`);
    cd.waiting.clear();
  }

  /**
   * The conversation no longer waits on a cooldown: the person acted there, it was stopped or let go.
   * A probe that leaves hands its turn to the next in line after the current wait.
   */
  private leaveCooldown(id: ConversationId): void {
    for (const [agentId, cd] of this.cooldowns) {
      cd.waiting.delete(id);
      if (cd.probe !== id) continue;
      cd.probe = undefined;
      if (!cd.cancel) this.armCooldown(agentId, cd, this.policyOf(agentId)?.backoffMs ?? LIMIT_WAIT_MS);
    }
  }

  /** The agent whose cooldown this conversation's continue waits on, if it does. */
  private waitingOn(id: ConversationId): string | undefined {
    for (const [agentId, cd] of this.cooldowns) if (cd.waiting.has(id)) return agentId;
    return undefined;
  }

  private policyOf(agentId: string): TurnFailedContinue | undefined {
    const policy = findAgent(this.deps.config, agentId)?.hooks?.turnFailed?.continue;
    return policy?.on.includes('limit') ? policy : undefined;
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
function kept(text: string, turn?: number): KeptText {
  return {
    text: text.length > CARD_ITEM_CHARS ? text.slice(0, CARD_ITEM_CHARS) : text,
    total: text.length,
    ...(turn !== undefined ? { turn } : {}),
  };
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
