import { randomUUID } from 'node:crypto';
import { looksLikeCommand } from './routing.js';
import type { ConversationId, InboundMessage, MessageRef } from '../types.js';

/**
 * What becomes of a failed turn's input: held for the next turn when the agent never received it,
 * and kept for a Retry button either way.
 *
 * ── Held: the agent never got it ───────────────────────────────────────────────────────────────
 * A turn whose start failed (TurnFailure.undelivered — the child did not come up, the host could not
 * be reached) never sent its prompt. Before this, the message was simply gone: the ❌ gave the cause
 * and not that, so a "continue" from the person, a parent agent or `hooks.turnFailed` became the
 * only thing the agent ever read. On 2026-11-07 thirteen sub-agents failed to start and were each
 * sent "继续执行原任务"; they went looking through their own session logs for a task they had never
 * been given (`project-reports/fleetherd-agent-friction-20261113/5-failed-stopped-turns.md` §2). So
 * such a turn's messages are held here and go to the agent in front of whatever starts the next
 * turn — the person's next message, a continue, a sub-agent card — and the chat says so.
 *
 * Not held: a scheduled run's prompt (the next run comes by itself, and two copies of "check the
 * build" would be one question asked twice), the operator's continue message (a nudge that only means
 * something after the input it follows), and a slash command (one runs only as the first thing in a
 * prompt, so put in front of the next message it would run with that message as its argument).
 *
 * ── Kept for Retry ─────────────────────────────────────────────────────────────────────────────
 * Every failed turn's input, delivered or not, is kept under an id the ❌ notice's buttons carry, so
 * the person can send it again — to the same agent, or another — instead of copying it out by hand
 * (#208467 → #208472). One record per conversation: the newest failure's. A turn that is only the
 * operator's continue keeps the input of the failure it continued, because retrying "continue" is
 * not what anybody means. A normal end or a stop retires it, and so does using it.
 *
 * ── Never twice ────────────────────────────────────────────────────────────────────────────────
 * The two meet when an undelivered turn is retried: the held copy and the record are the same input.
 * Claiming the record drops the hold, and a turn that carried the hold along clears the record when
 * it ends normally, so the same message cannot reach the agent once through the hold and again
 * through a Retry.
 *
 * In memory only: a restart forgets both, as it forgets a waiting continue.
 */

/** What a Retry button carries back: the input of the failed turn, and the agent it was meant for. */
export interface RetryRecord {
  id: string;
  conversation: ConversationId;
  input: InboundMessage[];
  agentId: string;
  /** The ❌ notice carrying its buttons, once sent — what `retire` takes the buttons off. */
  notice?: FailedNotice;
}

/** A ❌ notice with Retry buttons, as sent: where, and the text to keep when its buttons go. */
export interface FailedNotice {
  platformId: string;
  ref: MessageRef;
  text: string;
}

/** Who sent what the gateway itself writes, by `ConversationRef.user` (turn-runner.ts senders). */
export interface FailedInputSenders {
  scheduled: string;
  continued: string;
}

/** The most messages one conversation holds for its next turn; older ones are dropped, and logged. */
const HELD_MAX = 50;

export class FailedInputs {
  private readonly held = new Map<ConversationId, InboundMessage[]>();
  private readonly records = new Map<ConversationId, RetryRecord>();

  constructor(
    private readonly senders: FailedInputSenders,
    /**
     * A record's notice whose buttons no longer do anything — it was used, or a later turn replaced
     * or ended it. The registry takes them off where the platform can edit buttons, so a stale Retry
     * is not left looking live; where it cannot, a tap says there is nothing to retry.
     */
    private readonly retire: (notice: FailedNotice) => void = () => {},
    private readonly newId: () => string = () => randomUUID().slice(0, 8)
  ) {}

  /**
   * A turn failed with `input` (its batch and anything joined into it). Answers what became of it:
   * the Retry id when there is something to retry, and how many messages are held for the next turn
   * (0 when it was delivered, or held nothing worth sending again).
   */
  failed(
    id: ConversationId,
    failure: { input: InboundMessage[]; undelivered: boolean; agentId: string }
  ): { retryId?: string; held: number } {
    const own = failure.input.filter((m) => m.conversation.user !== this.senders.continued);
    const input = own.length > 0 ? own : this.records.get(id)?.input;
    let retryId: string | undefined;
    this.drop(id);
    if (input && input.length > 0) {
      retryId = this.newId();
      this.records.set(id, { id: retryId, conversation: id, input, agentId: failure.agentId });
    }
    if (!failure.undelivered) return { ...(retryId ? { retryId } : {}), held: 0 };
    const keep = failure.input.filter(
      (m) =>
        m.conversation.user !== this.senders.continued &&
        m.conversation.user !== this.senders.scheduled &&
        !looksLikeCommand(m.content.trim())
    );
    if (keep.length > HELD_MAX) {
      console.warn(`[turn] ${id}: ${keep.length - HELD_MAX} undelivered message(s) dropped; ${HELD_MAX} are held for the next turn`);
    }
    const held = keep.slice(-HELD_MAX);
    if (held.length > 0) this.held.set(id, held);
    else this.held.delete(id);
    return { ...(retryId ? { retryId } : {}), held: held.length };
  }

  /**
   * The messages held for this conversation's next turn, handed over once: the turn that takes them
   * sends them in front of its own (TurnRunner.runTurn).
   */
  take(id: ConversationId): InboundMessage[] {
    const held = this.held.get(id);
    if (!held) return [];
    this.held.delete(id);
    return held;
  }

  /** How many messages are held for this conversation's next turn. */
  heldCount(id: ConversationId): number {
    return this.held.get(id)?.length ?? 0;
  }

  /**
   * The ❌ notice for record `retryId` went out with its buttons. Retired at once when the record is
   * already gone — a Retry tapped faster than the send returned.
   */
  noticeSent(retryId: string, notice: FailedNotice): void {
    const record = this.peek(retryId);
    if (record) record.notice = notice;
    else this.retireNotice(notice);
  }

  /** A turn ended without failing: there is nothing left to retry. */
  ended(id: ConversationId): void {
    this.drop(id);
  }

  /** `/new`, or the registry letting the conversation go: neither the hold nor the record survives it. */
  forget(id: ConversationId): void {
    this.held.delete(id);
    this.drop(id);
  }

  /** The record a Retry button names, while it is still its conversation's newest. */
  peek(retryId: string): RetryRecord | undefined {
    for (const r of this.records.values()) if (r.id === retryId) return r;
    return undefined;
  }

  /**
   * Use a Retry: the record is retired, and so is the conversation's hold — the retry sends the same
   * input, so the next turn must not send it again.
   */
  claim(retryId: string): RetryRecord | undefined {
    const record = this.peek(retryId);
    if (!record) return undefined;
    this.drop(record.conversation);
    this.held.delete(record.conversation);
    return record;
  }

  /** Forget a conversation's record, and take its buttons off. */
  private drop(id: ConversationId): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    if (record.notice) this.retireNotice(record.notice);
  }

  private retireNotice(notice: FailedNotice): void {
    try {
      this.retire(notice);
    } catch (e) {
      console.warn('[turn] could not retire a Retry notice:', e instanceof Error ? e.message : e);
    }
  }
}
