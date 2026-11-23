import { agentDisplayName, findAgent } from '../config/schema.js';
import { localeOf, type Locale } from '../core/i18n/index.js';
import { tRuntime } from '../core/i18n/runtime.js';
import { addressOf, type ConversationAddress, type ConversationRef } from '../core/conversation.js';
import { InboundMerger, quoteMessages, stopInputNote } from '../core/inbound-merger.js';
import { fallbackTitle } from '../core/title-namer.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, InboundMessage, PendingQueueItem, ToolEvent } from '../types.js';
import { resolveAgentCwd } from './agent-common.js';
import type { RespawnCounts } from './config-reload.js';
import type { ConversationContext, ConversationLane, ConversationState } from './conversation-context.js';
import { formatLaneTitle, type ConversationControls } from './conversation-controls.js';
import type { ConversationHistory } from './conversation-history.js';
import { deliveryIdOf, FailedInputs, type RetryRecord } from './failed-input.js';
import { beginSkillTurn, recordToolUse } from './skill-usage.js';
import { TurnOutcomes } from './turn-outcomes.js';
import {
  CONTINUE_SENDER,
  RECONNECT_SENDER,
  SCHEDULED_SENDER,
  TurnRunner,
  type TurnEnd,
  type TurnRunnerDeps,
} from './turn-runner.js';

/** What `/stop` found; `background` is what the merger cannot see (AgentSession.stopBackground). */
export type StopOutcome = 'running' | 'collecting' | 'background' | 'idle';

/** Distinct sentences per outcome: a stop that says the same for "stopped" and "nothing" is not trusted. */
const STOP_ACK: Record<StopOutcome, string> = {
  running: '⏹ Stopped. The reply above is as far as it got — the conversation is kept, so just send the next message.',
  collecting: '⏹ Stopped before the turn started. Nothing reached the agent.',
  background:
    '⏹ Stopped the background work. The update above is as far as it got — the conversation is kept, so just send the next message.',
  idle: 'Nothing is running here.',
};

const STOP_ACK_QUESTION = '⏹ Called off the question above. Nothing else was running.';
const STOP_ACK_VOICE = '⏹ Called off the voice transcript — nothing was sent. Nothing else was running.';

/** A stop's report: InboundMerger.interrupt's, with `background` added. */
export interface StopResult {
  outcome: StopOutcome;
  kept: InboundMessage[];
  dropped: InboundMessage[];
}

export type KillOutcome = StopOutcome | 'no-child' | 'unresumable';

const KILL_ACK: Record<KillOutcome, string> = {
  running: '🔌 Stopped the turn and ended the agent process. The conversation is kept — the next message starts a new process that picks up where this one left off.',
  collecting: '🔌 Stopped before the turn started, and ended the agent process. The conversation is kept — the next message resumes it.',
  background:
    '🔌 Stopped the background work and ended the agent process. The conversation is kept — the next message starts a new process that picks up where this one left off.',
  idle: '🔌 Ended the agent process. The conversation is kept — the next message starts a new one that picks up where it left off.',
  'no-child': 'No agent process is running here — nothing to end.',
  unresumable:
    'Not ended: this agent cannot resume a stored session, so ending its process would lose the conversation. ' +
    '`/stop` ends the turn; `/new` ends the process and starts fresh.',
};

export function withInputNote(
  ack: string,
  kept: readonly InboundMessage[],
  dropped: readonly InboundMessage[],
  locale: Locale = 'en'
): string {
  const note = stopInputNote(kept, dropped, locale);
  return note ? `${ack}\n${note}` : ack;
}

function stopAck(outcome: StopOutcome, locale: Locale = 'en'): string {
  if (locale === 'zh-CN') {
    switch (outcome) {
      case 'running':
        return tRuntime(locale, 'stopAckRunning');
      case 'collecting':
        return tRuntime(locale, 'stopAckCollecting');
      case 'background':
        return tRuntime(locale, 'stopAckBackground');
      case 'idle':
        return tRuntime(locale, 'stopAckIdle');
    }
  }
  return STOP_ACK[outcome];
}

function stopHead(outcome: StopOutcome, calledOff: number, transcripts: number, also: string, locale: Locale = 'en'): string {
  const ackQ = locale === 'zh-CN' ? tRuntime(locale, 'stopAckQuestion') : STOP_ACK_QUESTION;
  const ackV = locale === 'zh-CN' ? tRuntime(locale, 'stopAckVoice') : STOP_ACK_VOICE;
  const ack = stopAck(outcome, locale);
  if (outcome === 'idle' && calledOff > 0) return also ? `${ackQ}\n⏹ Stopped ${also}.` : ackQ;
  if (outcome === 'idle' && transcripts > 0) return also ? `${ackV}\n⏹ Stopped ${also}.` : ackV;
  if (outcome === 'idle' && also) return `⏹ Stopped the ${also}. Their conversations are kept — a message in one carries on from it.`;
  return also ? `${ack}\n⏹ Also stopped the ${also}.` : ack;
}

const SWEEP_INTERVAL_MS = 60_000;

/** One live conversation as the review sweep sees it (daemon/review.ts `eligible`). */
export interface ReviewFacts {
  key: ConversationId;
  agentId: string;
  idleMs: number;
  busyTurn: boolean;
  pendingWork: boolean;
  stopped: boolean;
  unresumable: boolean;
  /** Kept in memory past `/new` (which clears the stored record), so a reset topic stays reviewable. */
  lane?: { platform: string; channel: string; thread?: string };
}

/**
 * How turns run: each conversation's merger and the TurnRunner behind it, delivery into the merger,
 * `/stop` and `/kill`, the restart drain, idle reclaim, and the retries and continues after a failure.
 */
export class ConversationTurns {
  readonly runner: TurnRunner;
  readonly outcomes: TurnOutcomes;
  readonly failedInputs: FailedInputs;
  private cancelSweep: (() => void) | null = null;
  /** Said once per conversation, not every sweep. */
  private readonly unresumableWarned = new Set<ConversationId>();
  private drainingNow = false;

  constructor(
    private readonly ctx: ConversationContext,
    private readonly controls: ConversationControls,
    private readonly history: ConversationHistory
  ) {
    this.failedInputs = new FailedInputs({ scheduled: SCHEDULED_SENDER, continued: CONTINUE_SENDER, reconnect: RECONNECT_SENDER }, (notice) => {
      const adapter = ctx.platforms.get(notice.platformId);
      if (!adapter?.capabilities.editButtons) return;
      void adapter
        .editButtons(notice.ref, notice.text, [])
        .catch((e) => console.warn('[retry] could not take the buttons off a ❌ notice:', e instanceof Error ? e.message : e));
    });
    this.runner = new TurnRunner(ctx.config, ctx.platforms, ctx.agents, ctx.clock, this.runnerDeps(), ctx.hooks);
    this.outcomes = new TurnOutcomes({
      config: ctx.config,
      clock: ctx.clock,
      platforms: ctx.platforms,
      store: ctx.store,
      // laneFor, not laneOf: after a restart an interrupted turn's notice must reach a lane not yet in memory.
      laneOf: (id) => ctx.laneFor(id),
      agentIdOf: (id) => ctx.boundAgentOf(id) ?? ctx.agentIdOf(id),
      runContinue: (id, text) => this.runContinue(id, text),
      onNeedsPerson: (id) => ctx.hooks?.onNeedsPerson?.(id),
      onCooldownOver: (agentId) => ctx.hooks?.onCooldownOver?.(agentId),
    });
  }

  private get locale(): Locale {
    return localeOf(this.ctx.config);
  }

  /** Only what TurnRunner needs, never the registry itself (no circular dependency). */
  private runnerDeps(): TurnRunnerDeps {
    const ctx = this.ctx;
    return {
      tokenFor: (id) => ctx.tokens.tokenFor(id),
      agentIdOf: (id) => ctx.agentIdOf(id),
      getModelOverride: (id) => ctx.conversations.get(id)?.modelOverride,
      getWorkdir: (id) => ctx.workdirOf(id),
      recordUsage: (id, usage) => {
        const state = ctx.conversations.get(id);
        if (!state) return;
        state.lastUsage = usage;
        if (usage.cost) state.lastCost = usage.cost;
        ctx.status.usage(id, usage);
      },
      recordModel: (id, model) => ctx.status.model(id, model),
      recordEffort: (id, effort) => ctx.status.effort(id, effort),
      recordOptions: (id, options) => ctx.status.options(id, options),
      recordQuota: (id, pools) => ctx.status.quota(id, pools),
      recordTool: (id, evt) => this.recordTool(id, evt),
      onToolActivity: (id, activeCount, finished) => {
        ctx.conversations.get(id)?.merger.setActiveTools(activeCount, finished);
      },
      recordTurnComplete: (id) => {
        const state = ctx.conversations.get(id);
        if (state) state.turnCompleted = true;
        ctx.status.settled(id);
      },
      setLane: (id, address, platformId) => {
        const state = ctx.conversations.get(id);
        if (state) {
          state.lane = address;
          state.lanePlatform = platformId;
        }
        // Persisted once per turn: `fleetherd channels` lists it, and memory dies with the process.
        ctx.store?.recordLane?.(id, ctx.agentIdOf(id), platformId, address, ctx.clock.now());
      },
      followUpTarget: (id) => ctx.laneOf(id),
      touch: (id) => ctx.touch(id),
      adoptThread: (id, address, platformId) => ctx.adoptThread(id, address, platformId),
      nameConversation: (id, seed) => this.controls.nameConversation(id, seed),
      recordTurnStart: (id) => {
        ctx.progress.started(id);
        this.outcomes.turnStarted(id);
      },
      recordTurnEnd: (id, end) => this.recordTurnEnd(id, end),
      recordPersonWords: (id, words) => ctx.hooks?.onPersonWords?.(id, words),
      takeUndelivered: (id) => this.failedInputs.take(id),
      keepFailedInput: (id, failure) => this.failedInputs.failed(id, failure),
      keepInterrupted: (id, agentId) => this.failedInputs.interrupted(id, agentId),
      failureNoticeSent: (retryId, notice) => this.failedInputs.noticeSent(retryId, notice),
      recordHistory: (id, event) => this.history.record(id, event),
      beginHistoryTurn: (id, start) => this.history.beginTurn(id, start),
      endHistoryTurn: (turnId, end) => this.history.endTurn(turnId, end),
      // `start` refuses a platform with no `attachTurnChanges`, so every chat platform skips it.
      turnChangesStart: (id, ref, platform, address) => ctx.turnChanges.start(id, ref, platform, address),
      turnChangesEnd: (handle) => ctx.turnChanges.finish(handle),
    };
  }

  private recordTurnEnd(id: ConversationId, end: TurnEnd): void {
    if (end.kind !== 'failed') this.failedInputs.ended(id);
    this.outcomes.turnEnded(id, end);
  }

  private recordTool(id: ConversationId, evt: ToolEvent): void {
    this.ctx.progress.tool(id, evt);
    recordToolUse(id, this.ctx.agentIdOf(id), evt);
  }

  buildMerger(conversationId: ConversationId): InboundMerger {
    const ctx = this.ctx;
    return new InboundMerger(
      {
        mergeWindowMs: ctx.config.inbound.mergeWindowMs,
        maxMergeWindowMs: ctx.config.inbound.maxMergeWindowMs,
        reactions: ctx.config.inbound.reactions,
        reactionsEnabled: ctx.config.display.reactions.enabled,
        steerDelayMs: Math.min(3_000, ctx.config.inbound.mergeWindowMs * 2),
      },
      {
        now: ctx.clock.now,
        schedule: ctx.clock.schedule,
        // Resolved at call time: a shared-scope conversation's platform may change after the merger is built.
        addReaction: (ref, emoji) => this.adapterFor(conversationId).addReaction(ref, emoji),
        runTurn: (batch, signal) => {
          beginSkillTurn(conversationId, ctx.agentIdOf(conversationId), batch);
          return this.runner.runTurn(conversationId, batch, signal);
        },
        steer: (batch) => this.runner.steer(conversationId, batch),
        canSteer: () => this.runner.canSteer(conversationId),
        onPendingChange: (items) => this.pushPendingQueue(conversationId, items),
        onPendingDeliver: (msgs) => this.notifyPendingDelivered(conversationId, msgs),
        abortTurn: () => {
          // Every cancel passes here: a question left on screen would pin the child and read the next message as its answer.
          ctx.hooks?.cancelPendingAsks?.(conversationId, 'interrupted');
          ctx.agents.getOrCreate(conversationId, ctx.agentIdOf(conversationId)).abort();
        },
        // Idle starts when the turn ends, not when the message arrived: a long task is never reclaimed mid-run.
        onIdle: () => {
          ctx.touch(conversationId);
          const state = ctx.conversations.get(conversationId);
          if (state?.reclaimOnIdle) {
            state.reclaimOnIdle = false;
            this.reclaimSession(conversationId, 'ask timed out (1h)');
          }
          if (state?.respawnOnIdle) {
            state.respawnOnIdle = false;
            ctx.agents.dispose(conversationId);
            console.log(`[reload] ${conversationId}: turn over — agent "${state.agentId}" restarts on its new definition with the next message`);
          }
        },
      }
    );
  }

  /**
   * The INBOUND instance's adapter (`state.platform`, not the lane): the merger's reactions mark the
   * user's own message, and under `scope: shared` that may be another platform than the lane's.
   */
  private adapterFor(id: ConversationId): PlatformAdapter {
    const pid = this.ctx.conversations.get(id)?.platform;
    const adapter = pid ? this.ctx.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error(`cannot resolve a platform adapter for conversation ${id} (platform=${pid ?? 'unknown'})`);
    }
    return adapter;
  }

  private pushPendingQueue(id: ConversationId, items: readonly PendingQueueItem[]): void {
    const lane = this.ctx.laneOf(id);
    if (!lane) return;
    try {
      this.ctx.platforms.get(lane.platformId)?.setPendingQueue?.(lane.address, items);
    } catch (e) {
      console.warn('[conversation] failed to push pending queue:', e instanceof Error ? e.message : e);
    }
  }

  private notifyPendingDelivered(id: ConversationId, msgs: readonly InboundMessage[]): void {
    const lane = this.ctx.laneOf(id);
    if (!lane || msgs.length === 0) return;
    const ids = msgs.map((m) => m.messageId).filter(Boolean);
    if (ids.length === 0) return;
    try {
      this.ctx.platforms.get(lane.platformId)?.markPendingDelivered?.(lane.address, ids);
    } catch (e) {
      console.warn('[conversation] failed to mark pending delivered:', e instanceof Error ? e.message : e);
    }
  }

  // ───────────────────────────── delivery ─────────────────────────────

  /** The end of route(): the message goes to the agent. Also where a deferred passthrough lands. */
  forward(key: ConversationId, state: ConversationState, msg: InboundMessage, opts?: { transcript?: boolean }): void {
    this.sendHeader(state, msg);
    // Typing is how a transcript or a sub-agent card is corrected: the one not tapped must not go later.
    if (!opts?.transcript) this.ctx.hooks?.supersedeVoice?.(key);
    this.ctx.hooks?.supersedeProposals?.(key);
    state.reclaimOnIdle = false;
    void state.merger.ingest(msg);
  }

  /** Offer a message for transcription; never a transcript itself. */
  takesVoice(key: ConversationId, msg: InboundMessage, opts?: { transcript?: boolean }): boolean {
    if (opts?.transcript) return false;
    return this.ctx.hooks?.takeVoice?.(key, msg) ?? false;
  }

  /** Straight to a known conversation (a picker click), bypassing routing; false once it is gone. */
  dispatchTo(id: ConversationId, msg: InboundMessage): boolean {
    const state = this.ctx.conversations.get(id);
    if (!state) return false;
    state.platform = msg.conversation.platform;
    state.reclaimOnIdle = false;
    void state.merger.ingest(msg);
    return true;
  }

  /** The once-per-conversation `🤖 <harness>` bubble, sent on receipt and only past every gate. */
  private sendHeader(state: ConversationState, msg: InboundMessage): void {
    if (!this.ctx.config.display.header.enabled || state.headerSent) return;
    // Mark before sending: two messages in one merge window would otherwise both send it.
    state.headerSent = true;
    const name = agentDisplayName(findAgent(this.ctx.config, state.agentId), state.agentId);
    void this.ctx.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(addressOf(msg.conversation), `🤖 ${name}`)
      .catch((e) => console.warn('[conversation] failed to send header:', e instanceof Error ? e.message : e));
  }

  // ───────────────────────────── `/recall` and `/sendnow` ─────────────────────────────

  recallAndReport(key: ConversationId, conv: ConversationRef, all: boolean): string {
    const state = this.ctx.conversations.get(key);
    const recalled = state ? state.merger.recall({ all }) : [];
    if (recalled.length === 0) return tRuntime(this.locale, 'recallEmpty');
    console.log(`[conversation] ${key} /recall by ${conv.platform}:${conv.user} → ${recalled.length} message(s)`);
    const head =
      recalled.length === 1
        ? tRuntime(this.locale, 'recallSingle')
        : tRuntime(this.locale, 'recallMultiple', { count: recalled.length });
    return [head, ...quoteMessages(recalled, this.locale)].join('\n');
  }

  sendNowAndReport(key: ConversationId, conv: ConversationRef): string {
    const state = this.ctx.conversations.get(key);
    if (!state) return tRuntime(this.locale, 'sendNowEmpty');
    const pending = state.merger.pendingItems();
    if (pending.length === 0) return tRuntime(this.locale, 'sendNowEmpty');
    if (!this.runner.canSteer(key)) return tRuntime(this.locale, 'sendNowUnsupported');
    const sent = state.merger.sendNow();
    if (sent.length === 0) return tRuntime(this.locale, 'sendNowUnsupported');
    console.log(`[conversation] ${key} /sendnow by ${conv.platform}:${conv.user} → ${sent.length} message(s)`);
    return sent.length === 1
      ? tRuntime(this.locale, 'sendNowSentSingle')
      : tRuntime(this.locale, 'sendNowSentMultiple', { count: sent.length });
  }

  recallPending(key: ConversationId, messageId?: string): { ok: boolean; recalled: number; content?: string } {
    const state = this.ctx.conversations.get(key);
    if (!state) return { ok: false, recalled: 0 };
    const removed = state.merger.recall(messageId ? { messageId } : {});
    if (removed.length === 0) return { ok: false, recalled: 0 };
    const content = removed.length === 1 ? removed[0]!.content : undefined;
    return { ok: true, recalled: removed.length, ...(content !== undefined ? { content } : {}) };
  }

  sendNowPending(key: ConversationId, messageId?: string): { ok: boolean; sent: number } {
    const state = this.ctx.conversations.get(key);
    if (!state) return { ok: false, sent: 0 };
    const promoted = state.merger.sendNow(messageId);
    return { ok: promoted.length > 0, sent: promoted.length };
  }

  // ───────────────────────────── `/stop` and `/kill` ─────────────────────────────

  /** `/stop`: questions and transcripts first (so "nothing is running" is never untrue), then the turn and side questions. */
  stopAndReport(key: ConversationId, conv: ConversationRef): string {
    const ack = this.stopTurnAndReport(key, conv);
    const asides = this.ctx.agents.peek(key)?.stopSideQuestions?.() ?? 0;
    if (asides === 0) return ack;
    const what = asides === 1 ? 'the side question' : `${asides} side questions`;
    return ack === STOP_ACK.idle ? `⏹ Stopped ${what}.` : `${ack}\n⏹ Also stopped ${what}.`;
  }

  private stopTurnAndReport(key: ConversationId, conv: ConversationRef): string {
    const { outcome, calledOff, transcripts, kept, dropped } = this.stopWithPending(key, 'stopped');
    // A /super turn ends once it hands the work out; stopping it must reach the sub-agents too.
    const subs = this.ctx.hooks?.stopSubAgents?.(key) ?? 0;
    console.log(
      `[conversation] ${key} /stop by ${conv.platform}:${conv.user} → ${outcome}${subs ? ` (+${subs} sub-agent(s))` : ''}` +
        `${kept.length ? `, ${kept.length} message(s) kept` : ''}${dropped.length ? `, ${dropped.length} dropped` : ''}`
    );
    const also = subs ? `${subs} sub-agent${subs === 1 ? '' : 's'} it started` : '';
    return withInputNote(stopHead(outcome, calledOff, transcripts, also, this.locale), kept, dropped, this.locale);
  }

  /** What `/stop` does, silently; public for Delegation.stopOpened, which must leave no question live either. */
  stopWithPending(key: ConversationId, reason: string): StopResult & { calledOff: number; transcripts: number } {
    const calledOff = this.ctx.hooks?.cancelPendingAsks?.(key, reason) ?? 0;
    // Transcripts are called off, not kept: nobody has approved those words yet.
    const transcripts = this.ctx.hooks?.cancelPendingVoice?.(key, reason) ?? 0;
    return { ...this.interruptConversation(key), calledOff, transcripts };
  }

  killAndReport(key: ConversationId, conv: ConversationRef): string {
    const { outcome, kept, dropped } = this.killWithInput(key);
    console.log(`[conversation] ${key} /kill by ${conv.platform}:${conv.user} → ${outcome}`);
    return withInputNote(KILL_ACK[outcome], kept, dropped, this.locale);
  }

  /** Cancel the running turn, keeping context, session ids, binding and child; says what was kept in the lane. */
  stopConversation(id: ConversationId): StopOutcome {
    const { outcome, kept, dropped } = this.interruptConversation(id);
    this.sayInputNote(id, kept, dropped);
    return outcome;
  }

  /**
   * stopConversation without saying anything. Never through agents.getOrCreate: building a session
   * to stop it is backwards. Background output is asked about only when the merger has nothing.
   */
  interruptConversation(id: ConversationId): StopResult {
    this.outcomes.personActed(id);
    const state = this.ctx.conversations.get(id);
    if (!state) return { outcome: 'idle', kept: [], dropped: [] };
    const report = state.merger.interrupt();
    if (report.outcome !== 'idle') return report;
    return { ...report, outcome: this.ctx.agents.peek(id)?.stopBackground?.() ? 'background' : 'idle' };
  }

  private sayInputNote(id: ConversationId, kept: readonly InboundMessage[], dropped: readonly InboundMessage[]): void {
    const note = stopInputNote(kept, dropped, this.locale);
    const lane = this.ctx.laneOf(id);
    if (!note || !lane) return;
    void this.ctx.platforms
      .get(lane.platformId)
      ?.sendMessage(lane.address, note)
      .catch((e) => console.warn('[conversation] failed to say what a stop kept:', e instanceof Error ? e.message : e));
  }

  /** `/kill`: end the agent process, keeping everything that identifies the conversation. */
  killConversation(id: ConversationId): KillOutcome {
    const { outcome, kept, dropped } = this.killWithInput(id);
    this.sayInputNote(id, kept, dropped);
    return outcome;
  }

  /**
   * The order matters: a refusal touches nothing; questions go with the process; the merger is
   * interrupted BEFORE the child (else it marks the turn ✅ and respawns for the backlog); dispose
   * the SESSION, not the factory, so the handle and its `/model` choice survive.
   */
  private killWithInput(id: ConversationId): { outcome: KillOutcome; kept: InboundMessage[]; dropped: InboundMessage[] } {
    const session = this.ctx.agents.peek(id);
    const reclaim = session?.reclaimState?.() ?? 'no-child';
    if (!session || reclaim === 'no-child') return { outcome: 'no-child', kept: [], dropped: [] };
    if (reclaim === 'unresumable') return { outcome: 'unresumable', kept: [], dropped: [] };
    this.ctx.hooks?.cancelPendingAsks?.(id, 'agent process ended');
    const stopped = this.interruptConversation(id);
    session.dispose();
    console.log(`[reclaim] ${id} ended by /kill — agent child stopped; the next message resumes it`);
    return stopped;
  }

  // ───────────────────────────── restart drain ─────────────────────────────

  get draining(): boolean {
    return this.drainingNow;
  }

  /** From now on a message that would start a turn in an idle conversation is refused; busy ones are told once. */
  beginDrain(): void {
    this.drainingNow = true;
    for (const [id, state] of this.ctx.conversations) {
      if (!this.atWork(id, state)) continue;
      // No lane yet: a first batch about to run, which the refusal will not hit.
      const lane = this.ctx.laneOf(id);
      if (!lane) continue;
      void this.ctx.platforms
        .get(lane.platformId)
        ?.sendMessage(lane.address, tRuntime(this.locale, 'gatewayRestartsDoneWaiting'))
        .catch((e) => console.warn('[drain] failed to tell a conversation about the restart:', e instanceof Error ? e.message : e));
    }
  }

  /** While draining, answer here a message that would start a turn in an idle conversation. */
  refuseWhileDraining(
    key: ConversationId,
    state: ConversationState,
    address: ConversationAddress,
    msg: InboundMessage
  ): boolean {
    if (!this.drainingNow || !state.merger.isIdle()) return false;
    console.log(`[route] ${key}: not started — the gateway is waiting to restart`);
    void this.ctx.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(
        address,
        '⏳ Not sent to the agent: the gateway is about to restart, once the turns already running are done. Send this again when it is back.'
      )
      .catch((e) => console.warn('[drain] failed to answer a message:', e instanceof Error ? e.message : e));
    return true;
  }

  /** A turn running, a batch about to start one, or the agent reporting on background work. */
  turnsInProgress(): number {
    let n = 0;
    for (const [id, state] of this.ctx.conversations) if (this.atWork(id, state)) n++;
    return n;
  }

  private atWork(id: ConversationId, state: ConversationState): boolean {
    return !state.merger.isIdle() || this.ctx.agents.peek(id)?.backgroundActive?.() === true;
  }

  // ───────────────────────────── idle reclaim ─────────────────────────────

  startIdleSweeper(): void {
    // Positive test: a hand-built Config without the field leaves reclaim OFF instead of comparing to NaN.
    if (!(this.ctx.config.session.idleTimeoutMs > 0)) return;
    const tick = (): void => {
      this.reclaimIdleSessions();
      this.cancelSweep = this.ctx.clock.schedule(tick, SWEEP_INTERVAL_MS);
    };
    this.cancelSweep = this.ctx.clock.schedule(tick, SWEEP_INTERVAL_MS);
  }

  /** Both directions need a re-arm: from 0 no timer exists, and to 0 the armed one would keep waking. */
  rearmIdleSweeper(): void {
    this.stopIdleSweeper();
    this.startIdleSweeper();
  }

  stopIdleSweeper(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
  }

  /**
   * Stop an idle child, keeping binding, state, token and session ids (the handle too, so a runtime
   * `/model` survives). A runtime that cannot say it resumes keeps its child: silently restarting
   * someone's task is the one degradation refused. True when the child was disposed.
   */
  reclaimSession(id: ConversationId, reason: string): boolean {
    if (this.ctx.hooks?.hasPendingWork?.(id)) return false;
    const session = this.ctx.agents.peek(id);
    if (!session) return false;
    const reclaim = session.reclaimState?.() ?? 'unresumable';
    if (reclaim === 'no-child') return false;
    if (reclaim === 'unresumable') {
      if (!this.unresumableWarned.has(id)) {
        this.unresumableWarned.add(id);
        console.warn(
          `[reclaim] ${id} is idle but its agent cannot resume a stored session; leaving the child ` +
            `resident (stopping it would silently restart the conversation)`
        );
      }
      return false;
    }
    // On the SESSION, not the factory: the factory would drop the handle and the runtime /model choice.
    session.dispose();
    console.log(`[reclaim] ${id} ${reason} — agent child stopped; the next message resumes it`);
    return true;
  }

  /**
   * A reload changed or removed these agents: drop their sessions now when that costs nothing, after
   * the turn when one runs, and never for a harness that cannot resume (unless its agent is gone).
   */
  respawnAgents(agentIds: ReadonlySet<string>): RespawnCounts {
    const counts: RespawnCounts = { now: 0, afterTurn: 0, kept: 0 };
    for (const [id, state] of this.ctx.conversations) {
      if (!agentIds.has(state.agentId)) continue;
      const session = this.ctx.agents.peek(id);
      if (!session) continue;
      const removed = !findAgent(this.ctx.config, state.agentId);
      const reclaim = session.reclaimState?.() ?? 'unresumable';
      if (reclaim === 'no-child') {
        this.ctx.agents.dispose(id);
        continue;
      }
      if (reclaim === 'unresumable' && !removed) {
        counts.kept++;
        continue;
      }
      if (!state.merger.isIdle() || this.ctx.hooks?.hasPendingWork?.(id)) {
        state.respawnOnIdle = true;
        counts.afterTurn++;
        continue;
      }
      this.ctx.agents.dispose(id);
      counts.now++;
    }
    return counts;
  }

  reclaimIdleSessions(): void {
    const idleMs = this.ctx.config.session.idleTimeoutMs;
    if (!(idleMs > 0)) return;
    const now = this.ctx.clock.now();
    for (const [id, state] of this.ctx.conversations) {
      if (now - state.lastActivityAt <= idleMs) continue;
      if (!state.merger.isIdle()) continue;
      const idleMin = Math.round((now - state.lastActivityAt) / 60_000);
      this.reclaimSession(id, `idle for ${idleMin}m`);
    }
  }

  reclaimAfterAskTimeout(id: ConversationId): void {
    const state = this.ctx.conversations.get(id);
    if (!state) return;
    if (state.merger.isIdle()) {
      this.reclaimSession(id, 'ask timed out (1h)');
    } else {
      state.reclaimOnIdle = true;
    }
  }

  /** Live conversations only; `stopped`/`unresumable` are the sweeper's own reading of the child. */
  reviewFacts(now: number): ReviewFacts[] {
    const out: ReviewFacts[] = [];
    for (const [id, state] of this.ctx.conversations) {
      const session = this.ctx.agents.peek(id);
      const reclaim = session ? (session.reclaimState?.() ?? 'unresumable') : 'no-child';
      const lane = this.ctx.laneOf(id);
      out.push({
        key: id,
        agentId: state.agentId,
        idleMs: now - state.lastActivityAt,
        busyTurn: !state.merger.isIdle(),
        pendingWork: this.ctx.hooks?.hasPendingWork?.(id) ?? false,
        stopped: reclaim === 'no-child',
        unresumable: reclaim === 'unresumable',
        ...(lane ? { lane: { platform: lane.platformId, ...lane.address } } : {}),
      });
    }
    return out;
  }

  /** `/new`: what the last turn left belongs to the context just thrown away. */
  forgetTurns(id: ConversationId): void {
    this.outcomes.forget(id);
    this.failedInputs.forget(id);
  }

  /** A released conversation (a throwaway scheduled run, shutdown) leaves nothing behind here. */
  release(id: ConversationId): void {
    this.unresumableWarned.delete(id);
    this.outcomes.release(id);
    this.failedInputs.forget(id);
  }

  // ───────────────────────────── continue and retry ─────────────────────────────

  /** `hooks.turnFailed.continue.message` as a solo turn, filed as CONTINUE_SENDER; false when it cannot run here. */
  private runContinue(id: ConversationId, text: string): boolean {
    const lane = this.ctx.laneFor(id);
    const agentId = this.ctx.boundAgentOf(id);
    if (!lane || !agentId || !findAgent(this.ctx.config, agentId)) return false;
    const state = this.ctx.ensureState(id, lane.platformId, agentId);
    state.reclaimOnIdle = false;
    this.ctx.touch(id);
    void state.merger.enqueueSolo({
      conversation: {
        platform: lane.platformId,
        channel: lane.address.channel,
        ...(lane.address.thread ? { thread: lane.address.thread } : {}),
        kind: 'direct',
        user: CONTINUE_SENDER,
      },
      messageId: '',
      content: text,
      timestamp: this.ctx.clock.now(),
    });
    return true;
  }

  /**
   * A Retry button on a ❌ notice: resend the failed input as the person's own solo turn, here or to
   * another agent. Only a person reaches this (the daemon checks `access.allowFrom`; no reverse command).
   * An agent with a session keeps this topic (switchRefusal), so another one gets a new topic beside it.
   */
  async retryTurn(opts: { retryId: string; user: string; agentId?: string; reconnect?: boolean }): Promise<{ done: boolean; text: string }> {
    const record = this.failedInputs.peek(opts.retryId);
    if (!record) return { done: false, text: tRuntime(this.locale, 'retryNothingToRetry') };
    const key = record.conversation;
    const lane = this.ctx.laneFor(key);
    const bound = this.ctx.boundAgentOf(key) ?? record.agentId;
    if (!lane) return { done: false, text: tRuntime(this.locale, 'retryConversationGone') };
    const live = this.ctx.conversations.get(key);
    if (live && !live.merger.isIdle()) return { done: false, text: tRuntime(this.locale, 'retryTurnRunning') };
    if (this.drainingNow) return { done: false, text: tRuntime(this.locale, 'retryGatewayRestarting') };
    const target = opts.agentId ?? bound;
    const def = findAgent(this.ctx.config, target);
    if (!def) return { done: false, text: tRuntime(this.locale, 'retryAgentNotConfigured', { target }) };
    // By id: two agents on one harness share a display name, and which one is the whole question.
    const name = target;
    if (opts.reconnect) {
      this.useRetry(record.id, key);
      this.enqueueReconnect(key, lane.platformId, lane.address, bound);
      return { done: true, text: tRuntime(this.locale, 'reconnectingTo', { bound }) };
    }
    if (record.input.length === 0) {
      return { done: false, text: tRuntime(this.locale, 'noSavedInputResend') };
    }
    if (target === bound) {
      this.useRetry(record.id, key);
      this.enqueueRetry(key, lane.platformId, lane.address, target, record.input, opts.user);
      return { done: true, text: tRuntime(this.locale, 'retryingWith', { name }) };
    }
    const refused = this.ctx.switchRefusal(key, target);
    if (refused === undefined) {
      this.useRetry(record.id, key);
      const workdir = this.ctx.workdirOf(key, bound);
      const state = this.ctx.ensureState(key, lane.platformId, bound);
      this.ctx.rebind(key, state, target, lane.platformId, lane.address, false);
      this.carryWorkdir(key, bound, target, workdir);
      this.enqueueRetry(key, lane.platformId, lane.address, target, record.input, opts.user);
      return { done: true, text: tRuntime(this.locale, 'retryingWithAnswersTopic', { name }) };
    }
    return this.retryInNewTopic(record, lane, bound, target, refused, opts.user);
  }

  /** retryTurn for another agent when this topic keeps its own: a new topic under the same parent. */
  private async retryInNewTopic(
    record: RetryRecord,
    lane: ConversationLane,
    bound: string,
    target: string,
    refused: string,
    user: string
  ): Promise<{ done: boolean; text: string }> {
    const key = record.conversation;
    const adapter = this.ctx.platforms.get(lane.platformId);
    if (!adapter?.capabilities.thread) return { done: false, text: refused };
    this.useRetry(record.id, key);
    const parent = adapter.parentOf?.(lane.address);
    // formatLaneTitle drops the old `[agent]` prefix itself.
    const seed = this.ctx.store?.conversationTitle(key) || fallbackTitle(record.input.map((m) => m.content).join('\n'));
    const opened = (
      await adapter.createThread({ address: { channel: lane.address.channel }, messageId: '' }, formatLaneTitle(target, seed), {
        ...(parent ? { under: parent } : {}),
      })
    ).address;
    const conv = this.ctx.conversationAt(lane.platformId, opened);
    if (!conv) return { done: false, text: tRuntime(this.locale, 'retryNewTopicMappingFailed') };
    this.ctx.ensureState(conv.key, lane.platformId, target, { fresh: true, opener: 'retry with another agent' });
    this.carryWorkdir(conv.key, bound, target, this.ctx.workdirOf(key, bound));
    this.enqueueRetry(conv.key, lane.platformId, opened, target, record.input, user);
    return { done: true, text: tRuntime(this.locale, 'retryingInNewTopic', { target, bound }) };
  }

  retryRecord(retryId: string): { conversation: ConversationId; agentId: string } | undefined {
    const record = this.failedInputs.peek(retryId);
    return record ? { conversation: record.conversation, agentId: this.ctx.boundAgentOf(record.conversation) ?? record.agentId } : undefined;
  }

  private useRetry(retryId: string, key: ConversationId): void {
    this.failedInputs.claim(retryId);
    this.outcomes.personActed(key);
  }

  /** Keep the directory for the agent a retry moves to, only on the same machine (where the path means the same place). */
  private carryWorkdir(key: ConversationId, from: string, to: string, path: string | undefined): void {
    const a = findAgent(this.ctx.config, from);
    const b = findAgent(this.ctx.config, to);
    if (!path || !a || !b || (a.host ?? '') !== (b.host ?? '') || path === resolveAgentCwd(a)) return;
    const moved = this.controls.setWorkdir(key, to, path);
    if (moved.kind === 'missing' || moved.kind === 'failed') {
      console.warn(`[retry] ${key}: could not keep ${path} for "${to}" (${moved.kind}); it starts in its own root`);
    }
  }

  private enqueueRetry(
    key: ConversationId,
    platformId: string,
    address: ConversationAddress,
    agentId: string,
    input: InboundMessage[],
    user: string
  ): void {
    const state = this.ctx.ensureState(key, platformId, agentId);
    state.reclaimOnIdle = false;
    this.ctx.touch(key);
    const batch: InboundMessage[] = input.map((m) => ({
      ...m,
      deliveryId: deliveryIdOf(m),
      conversation: {
        platform: platformId,
        channel: address.channel,
        ...(address.thread ? { thread: address.thread } : {}),
        kind: 'direct',
        user,
      },
      // No platform message behind it: the merger puts no reactions on a solo turn.
      messageId: '',
      timestamp: this.ctx.clock.now(),
    }));
    console.log(`[retry] ${key}: sending the failed turn's ${batch.length} message(s) again to "${agentId}"`);
    void state.merger.enqueueSolo(batch);
  }

  private enqueueReconnect(
    key: ConversationId,
    platformId: string,
    address: ConversationAddress,
    agentId: string
  ): void {
    const state = this.ctx.ensureState(key, platformId, agentId);
    state.reclaimOnIdle = false;
    this.ctx.touch(key);
    const msg: InboundMessage = {
      conversation: {
        platform: platformId,
        channel: address.channel,
        ...(address.thread ? { thread: address.thread } : {}),
        kind: 'direct',
        user: RECONNECT_SENDER,
      },
      messageId: '',
      content: '',
      timestamp: this.ctx.clock.now(),
    };
    console.log(`[retry] ${key}: reconnecting to interrupted turn on "${agentId}"`);
    void state.merger.enqueueSolo([msg]);
  }

  /** Turns the last daemon never finished (TurnOutcomes.recoverInterrupted); called once platforms are up. */
  recoverInterruptedTurns(): number {
    return this.outcomes.recoverInterrupted(
      (id, platform, agentId) => {
        if (!findAgent(this.ctx.config, agentId)) return false;
        this.ctx.ensureState(id, platform, agentId);
        return true;
      },
      (id, agentId) => {
        const def = findAgent(this.ctx.config, agentId);
        if (!def?.connect) return undefined;
        const retryId = this.failedInputs.interrupted(id, agentId);
        return {
          retryId,
          onSent: (platformId, ref, text) => this.failedInputs.noticeSent(retryId, { platformId, ref, text }),
        };
      }
    );
  }
}
