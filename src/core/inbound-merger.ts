import type { InboundMessage, MessageRef, SteerOutcome } from '../types.js';
import { addressOf } from './conversation.js';

/**
 * Inbound merger (one instance per session).
 *
 * - Coalesces rapid consecutive messages into one context turn instead of
 *   replying per message.
 * - A message that arrives while the agent is busy never cancels what it is doing. It is offered to
 *   the running turn first (`steer`), for a harness that can take input mid-turn; what the turn
 *   cannot take waits in a queue (keeps the latest batch, never drops) and starts as a fresh batch
 *   after the turn ends.
 * - `interrupt()` is the only way to cut a turn short: a user who typed `/stop` gets the turn
 *   cancelled, and what was waiting behind it is KEPT, not run: it goes in with their next message
 *   (see interrupt for why neither running nor dropping it is right).
 * - Lifecycle reactions: received 👀 / done ✅ / error ❌.
 *
 * ── Why a new message no longer interrupts ──────────────────────────────────────────────────────
 * Through 2.0.0 it did (`inbound.interruptOnNewMessage`, frozen on): every message sent mid-turn
 * cancelled the turn and restarted it with the new input. That made "also check the docs" cost a
 * half-finished test run, and a session query like `/usage` once cancelled a full suite mid-Bash
 * (see GenericCommand.query). The way a coding agent's own CLI handles the same thing is the model
 * here: Claude Code queues what is typed during a turn and hands it to the model at the next tool
 * boundary; codex calls the same thing steering. Probed 2026-10-10, with a message sent six seconds
 * into a thirty-second foreground command: claude (claude-agent-acp 0.81, Claude Code 2.1.296) and
 * codex (codex-acp 2.2.1, codex 0.160.1) both let the command finish and answered both requests in
 * one reply; opencode 2.0.26 rejects a second prompt outright over ACP, and agy 1.3.2 runs it as the
 * next turn. So "offer, else queue" is what every harness here supports, and `/stop` is the stop.
 */

export interface InboundMergerOptions {
  mergeWindowMs: number;
  /** Hard cap: when sliding-window wait exceeds this, force start to avoid starving the turn. */
  maxMergeWindowMs: number;
  reactions: { received: string; done: string; error: string };
  /**
   * Whether to mark the user's message with the lifecycle reactions at all (display.reactions.enabled).
   * false = never call addReaction, so the user's own messages stay unmarked. Independent of the emoji
   * above, which stay frozen in EXPERIENCE.
   */
  reactionsEnabled?: boolean;
}

export interface MergerDeps {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  /**
   * Hand the merged batch to the agent; resolve = turn ended. `signal` aborts when `/stop` cuts this
   * turn short — the runner reads it to finalize the partial reply cleanly (no footer) instead of
   * decorating it as a completed turn.
   */
  runTurn(batch: InboundMessage[], signal?: AbortSignal): Promise<void>;
  /**
   * Offer messages that arrived mid-turn to the turn that is running (see SteerOutcome). Anything but
   * `refused` means the agent has them, and they must not be sent again. Absent = no runtime here can
   * take input mid-turn, which reads exactly like `refused`: the messages wait for the turn to end.
   */
  steer?(batch: InboundMessage[]): Promise<SteerOutcome>;
  addReaction(ref: MessageRef, emoji: string): Promise<void>;
  /** Cancel the running turn (`/stop`); no-op if absent. */
  abortTurn?(): void;
  /** Called when the turn ends with no backlog and returns to idle; drives idle reclaim. */
  onIdle?(): void;
}

type Phase = 'idle' | 'collecting' | 'running';

/** Where a lifecycle reaction for this message goes. */
function refOf(msg: InboundMessage): MessageRef {
  return { address: addressOf(msg.conversation), messageId: msg.messageId };
}

/** How a solo turn (enqueueSolo) ended. */
export type SoloOutcome = 'ok' | 'failed' | 'interrupted';

/**
 * What `/stop` did (interrupt): what was running, and what became of the messages that had not
 * reached the agent. Both lists are in arrival order, and the caller says them in the chat — a stop
 * that keeps or drops someone's words without saying so is how one went missing (see interrupt).
 */
export interface StopReport {
  outcome: 'running' | 'collecting' | 'idle';
  /** Waiting for the person's next message, which they will go in with. */
  kept: InboundMessage[];
  /** Thrown away by this stop. */
  dropped: InboundMessage[];
}

/** Longest a message is quoted in a stop's note (stopInputNote); the person wrote it, so a glance is enough. */
const STOP_QUOTE_CHARS = 120;
/** Most messages a stop's note quotes; the rest are counted. */
const STOP_QUOTE_MAX = 5;

/**
 * What a stop says in the chat about the messages that never reached the agent (StopReport): the
 * ones it kept for the person's next message, and the ones it dropped — each quoted, so the person
 * can tell which words they are without scrolling up. Empty when there were none.
 *
 * Said, never left implicit: through 3.2.0 `/stop` dropped the queue without a word, and a correction
 * typed into a turn that went on after a stop was lost that way (2026-11-13; see interrupt).
 */
export function stopInputNote(kept: readonly InboundMessage[], dropped: readonly InboundMessage[]): string {
  const these = (n: number): string => (n === 1 ? 'this message' : `these ${n} messages`);
  const it = (n: number): string => (n === 1 ? 'it' : 'them');
  const lines: string[] = [];
  if (dropped.length > 0) {
    lines.push(`Dropped ${these(dropped.length)} — the agent never saw ${it(dropped.length)}:`, ...quoteMessages(dropped));
  }
  if (kept.length > 0) {
    lines.push(
      `Kept ${these(kept.length)} for your next one — the agent has not seen ${it(kept.length)} yet, and ` +
        `${kept.length === 1 ? 'it goes' : 'they go'} in with whatever you send next. \`/stop\` again drops ${it(kept.length)}:`,
      ...quoteMessages(kept)
    );
  }
  return lines.join('\n');
}

/** One `> …` line per message, cut to a glance; attachments counted, since a quote cannot show them. */
function quoteMessages(msgs: readonly InboundMessage[]): string[] {
  const lines = msgs.slice(0, STOP_QUOTE_MAX).map((m) => {
    const flat = m.content.replace(/\s+/g, ' ').trim();
    const text = flat.length > STOP_QUOTE_CHARS ? `${flat.slice(0, STOP_QUOTE_CHARS - 1)}…` : flat;
    const files = m.attachments?.length ?? 0;
    const extra = files > 0 ? `[${files} attachment${files === 1 ? '' : 's'}]` : '';
    return `> ${[text, extra].filter(Boolean).join(' ') || '(empty)'}`;
  });
  if (msgs.length > STOP_QUOTE_MAX) lines.push(`> … and ${msgs.length - STOP_QUOTE_MAX} more`);
  return lines;
}

export class InboundMerger {
  private phase: Phase = 'idle';
  private buffer: InboundMessage[] = [];      // batch being collected
  private queued: InboundMessage[] = [];      // arrived mid-turn and the turn could not take them: they start the next one
  /**
   * What a `/stop` kept (see interrupt): messages that never reached the agent, waiting to go in
   * FRONT of the next batch the person starts. Not a turn of their own — only a person's next message
   * starts one — and not given to a solo turn, which is never merged with anything.
   */
  private held: InboundMessage[] = [];
  /**
   * Between a `/stop` and the end of the turn it stopped. A message arriving then is not offered to
   * that turn — the harness is unwinding, and one that takes a message and then drops it with the
   * cancel loses it — but waits, and starts the next turn the moment the stopped one ends.
   */
  private stopping = false;
  /**
   * Messages on the offer chain, not yet decided (see offers). Listed by a `/stop` as kept: one that
   * lands while they are being offered keeps them whatever the agent answers (see decideOffer).
   */
  private offeringMsgs: InboundMessage[] = [];
  /**
   * Turns that must run ALONE and must not cut anything short (enqueueSolo): each is one message,
   * never merged into a batch, started only when nothing else is running or collecting.
   */
  private solo: Array<{ batch: InboundMessage[]; settle: (o: SoloOutcome) => void }> = [];
  private collectTimer: (() => void) | null = null;
  private collectStartedAt = 0;               // merge-window start (for the hard cap)
  private interrupted = false;                // turn stopped by `/stop` (then skip ✅)
  private activeAbort: AbortController | null = null; // current running turn's abort (`/stop`)
  private runStartedAt: number | undefined;   // deps.now() when the running turn began (runningSince)
  /**
   * Messages that joined the running turn (see steer): they get the turn's ✅ or ❌, exactly like the
   * message that started it, because that turn's reply is their answer too. Reset per turn.
   */
  private joined: InboundMessage[] = [];
  /**
   * Offers to the running turn, in arrival order. A chain rather than a fire-and-forget per message,
   * because an offer is asynchronous (attachments are fetched, the harness answers over IPC) and two
   * messages typed back to back must reach the agent in the order they were typed — including when
   * the first is refused and goes to the queue, which everything after it must then join too.
   */
  private offers: Promise<void> = Promise.resolve();
  /** How many offers are still on that chain; the merger is not idle while one is (see isIdle). */
  private offering = 0;
  /**
   * Counts `/stop`s. An offer still on the chain when one lands belongs to the backlog it kept, so
   * each offer remembers the count it was made under and is kept rather than offered if that has
   * changed.
   */
  private stops = 0;

  constructor(
    private readonly opts: InboundMergerOptions,
    private readonly deps: MergerDeps
  ) {}

  /**
   * Whether currently idle (lets the registry decide if it can reclaim safely). Not while a message
   * is still being offered to a turn that has just ended: that message is about to start the next one.
   */
  isIdle(): boolean {
    return this.phase === 'idle' && this.offering === 0;
  }

  /**
   * When the turn now running began, on the deps clock; undefined while idle OR collecting. The
   * distinction matters to the one caller (a busy `/usage`): a batch still inside its merge window
   * is busy — a command forwarded now would be merged into it — but it has not started, so there is
   * no elapsed time to report.
   */
  runningSince(): number | undefined {
    return this.phase === 'running' ? this.runStartedAt : undefined;
  }

  /**
   * Explicit user interrupt (`/stop`): stop whatever this conversation is doing, and report what
   * that was — and what became of the messages that had not reached the agent — so the caller can
   * say something true rather than a generic ack.
   *
   * The only way a turn is cut short: a message that arrives mid-turn is offered to it or queued
   * behind it, never allowed to cancel it (see the note at the top of this file).
   *
   * ── What happens to the backlog ─────────────────────────────────────────────────────────────────
   * Running: the messages queued behind the turn — and any still being offered to it — are KEPT.
   * They do not start a turn of their own ("stop, then immediately start what I queued behind it" is
   * not what stop means), and they are not dropped either: they go in front of the person's next
   * message. Through 3.2.0 they were dropped, unannounced, and on 2026-11-13 that lost a correction:
   * a cbc turn ran on for eleven minutes after `/stop` (it never got the cancel — see agent-acp.ts
   * stoppedWhileStarting), the person typed "give me a plan first" into it, a second `/stop` threw
   * that away, and the agent went back to the original job for another 88 minutes. Kept and announced, it is the person's to send (anything they type next) or to
   * drop (`/stop` again).
   *
   * A message that already JOINED the turn goes down with it: the agent had it, and the cancel reaches
   * everything the agent was doing. One that arrives after this, while the turn unwinds, is not
   * offered to it (see `stopping`) and starts the next turn when this one ends — it was written after
   * the stop, so it is the next thing, not part of what was stopped.
   *
   * Collecting: the batch inside its merge window never reached the agent, and stopping it is the
   * way to take back what was just typed — dropped, and reported. What an earlier stop kept stays kept.
   *
   * Idle: what an earlier stop kept is all there is, and a second `/stop` is how it is let go.
   */
  interrupt(): StopReport {
    if (this.phase === 'running') {
      this.interrupted = true; // dispatch then skips ✅: the turn did not finish, it was stopped
      this.held.push(...this.queued);
      this.queued = [];
      this.stops++;
      this.stopping = true;
      // Both halves: trip the turn's signal (the runner finalizes the partial reply cleanly — no
      // footer) *and* cancel the agent itself.
      this.activeAbort?.abort();
      this.deps.abortTurn?.();
      // The offers still on the chain land in `held` as they are decided (decideOffer), after these.
      return { outcome: 'running', kept: [...this.held, ...this.offeringMsgs], dropped: [] };
    }
    if (this.phase === 'collecting') {
      // Still inside the merge window: nothing has reached the agent, so cancelling the timer and
      // dropping the buffer is the entire job — there is no turn to abort.
      this.collectTimer?.();
      this.collectTimer = null;
      const dropped = this.buffer;
      this.buffer = [];
      this.toIdle();
      return { outcome: 'collecting', kept: [...this.held], dropped };
    }
    const dropped = this.held;
    this.held = [];
    return { outcome: 'idle', kept: [], dropped };
  }

  /**
   * Let go of what a `/stop` kept, and say what it was — for `/new`, after which the next message
   * starts a fresh conversation the kept words were not written for.
   */
  dropKept(): InboundMessage[] {
    const dropped = this.held;
    this.held = [];
    return dropped;
  }

  /**
   * Run one message as a turn of its own, WITHOUT interrupting anything — for input nobody typed
   * (a scheduled task firing). Resolves when that turn has ended, with how it ended.
   *
   * Differs from ingest() on every axis ingest() is tuned for a person typing:
   *  - it is never offered to a running turn — a scheduled prompt slipped into the middle of what the
   *    user is doing would be answered as part of it; it waits behind the running turn instead;
   *  - it is never merged with other messages — a user message and a scheduled prompt coalesced into
   *    one turn would be answered as one question;
   *  - it goes behind the user's own queued messages, not ahead: a person waiting outranks a clock;
   *  - it gets no lifecycle reactions — there is no platform message to put them on.
   *
   * The reverse does not hold: a message typed while a solo turn runs is offered to it like to any
   * turn. The person is there, and getting their words to the agent now outranks keeping the
   * scheduled turn to itself.
   *
   * `/stop` (interrupt()) stops a running solo turn but leaves queued solo turns queued: the backlog
   * it keeps is what the user typed for the turn being stopped, and a scheduled run is not that.
   *
   * Several messages are one turn, as they were the first time: a failed turn sent again from its
   * Retry button (daemon/failed-input.ts) is the batch it was, not one turn per message.
   */
  enqueueSolo(msg: InboundMessage | InboundMessage[]): Promise<SoloOutcome> {
    const batch = Array.isArray(msg) ? msg : [msg];
    if (batch.length === 0) return Promise.resolve('ok');
    return new Promise((settle) => {
      this.solo.push({ batch, settle });
      if (this.phase === 'idle') void this.drainQueue();
    });
  }

  /** Entry: called once per inbound message. */
  async ingest(msg: InboundMessage): Promise<void> {
    // The "received" reaction is best-effort and must never gate the pipeline:
    // awaiting it would let a flaky platform REST / broken pool stall dispatch.
    void this.safeReaction(refOf(msg), this.opts.reactions.received);

    if (this.phase === 'running') {
      // Busy: offer it to the running turn, or queue it behind (never drop, never cancel).
      this.offer(msg);
      return;
    }
    this.collect(msg);
  }

  /**
   * Put one message into the merge buffer and (re)start the merge window — the idle/collecting half
   * of ingest, also where an offer lands when the turn it was made to ended before it was decided.
   */
  private collect(msg: InboundMessage): void {
    if (this.phase === 'idle') this.collectStartedAt = this.deps.now();
    this.buffer.push(msg);
    this.phase = 'collecting';
    this.collectTimer?.();
    // Sliding window + hard cap: remaining budget = maxMergeWindowMs - already waited.
    const waited = this.deps.now() - this.collectStartedAt;
    const wait = Math.max(0, Math.min(this.opts.mergeWindowMs, this.opts.maxMergeWindowMs - waited));
    this.collectTimer = this.deps.schedule(() => void this.dispatch(), wait);
  }

  /**
   * A message arrived while a turn runs: offer it to that turn, else queue it behind. Chained, so
   * offers are decided strictly in arrival order (see `offers`).
   */
  private offer(msg: InboundMessage): void {
    const stops = this.stops;
    this.offering++;
    this.offeringMsgs.push(msg);
    this.offers = this.offers
      .then(() => this.decideOffer(msg, stops))
      .catch((e) =>
        // decideOffer swallows the steer's own failure; this is the last resort that keeps one bad
        // offer from breaking the chain every later message waits on.
        console.error('[dispatch] failed to place a message that arrived mid-turn:', e instanceof Error ? e.message : e)
      )
      .finally(() => {
        this.offering--;
        const i = this.offeringMsgs.indexOf(msg);
        if (i >= 0) this.offeringMsgs.splice(i, 1);
      });
  }

  private async decideOffer(msg: InboundMessage, stops: number): Promise<void> {
    // A `/stop` since it arrived kept it with the rest of the backlog (see interrupt).
    if (stops !== this.stops) {
      this.held.push(msg);
      return;
    }
    // Straight into the turn only while nothing is queued ahead of it: a message the turn refused is
    // waiting for the turn to end, and one typed after it must not overtake it. Nor into a turn that
    // is being stopped (see `stopping`).
    if (this.phase === 'running' && !this.stopping && this.queued.length === 0 && this.deps.steer) {
      let outcome: SteerOutcome = 'refused';
      try {
        outcome = await this.deps.steer([msg]);
      } catch (e) {
        // Treated as refused: the message is still ours, and the queue is a correct place for it.
        console.warn('[dispatch] offering a message to the running turn failed; queueing it instead:', e instanceof Error ? e.message : e);
      }
      // Taken or not, a `/stop` while it was being offered keeps it: if the agent did not take it, it
      // belonged to the backlog that stop kept; if it did, the cancel took it down with the turn (a
      // steered message dies with the interrupted turn in codex, and claude's is ended with the child
      // — see agent-acp.ts endChildAfterStop), so it was never answered. The stop's report already
      // listed it as kept.
      if (stops !== this.stops) {
        this.held.push(msg);
        return;
      }
      if (outcome !== 'refused') {
        console.log(`[dispatch] a message that arrived mid-turn was taken by the agent (${outcome})`);
        // Marked with the turn it joined. Normally that turn is still running — a turn waits for
        // what joined it — and if it has already ended there is no outcome left to wait for.
        if (this.phase === 'running') this.joined.push(msg);
        else void this.safeReaction(refOf(msg), this.opts.reactions.done);
        return;
      }
    }
    if (this.phase === 'running') this.queued.push(msg);
    else this.collect(msg); // the turn ended while this was being offered: start the next one
  }

  /**
   * Put a message behind whatever this conversation is doing, without offering it to the running
   * turn.
   *
   * For `task-send --interrupt`: the turn was just stopped to make room for this message, and the
   * dying turn must not be handed it — a harness still unwinding can accept a steer and then drop
   * it with the abort, which is the one way this message could be lost. When nothing is running the
   * message starts a turn as usual.
   */
  queueBehind(msg: InboundMessage): void {
    void this.safeReaction(refOf(msg), this.opts.reactions.received);
    if (this.phase === 'running' || this.phase === 'collecting') this.queued.push(msg);
    else this.collect(msg);
  }

  /** Merge window elapsed: hand the batch to the agent, behind whatever a `/stop` kept. */
  private async dispatch(): Promise<void> {
    this.collectTimer = null;
    if (this.buffer.length === 0) {
      this.toIdle();
      return;
    }
    // Kept messages go first: they were sent first, and the stop that kept them said they would go
    // in with the next message.
    const batch = [...this.held, ...this.buffer];
    if (this.held.length > 0) console.log(`[dispatch] ${this.held.length} message(s) kept by /stop go in with this batch`);
    this.held = [];
    this.buffer = [];
    console.log(`[dispatch] triggered, ${batch.length} message(s) into this turn`);
    await this.runBatch(batch);
    await this.drainQueue();
  }

  /**
   * Run one batch as a turn and mark its last message — and every message that joined it mid-turn —
   * with the outcome. Resolves with the outcome rather than throwing, so a solo caller can report it
   * and a normal one can ignore it.
   */
  private async runBatch(batch: InboundMessage[], opts: { solo?: boolean } = {}): Promise<SoloOutcome> {
    this.phase = 'running';
    this.interrupted = false;
    this.runStartedAt = this.deps.now();
    // Fresh per-turn abort: `/stop` trips it so the runner finalizes the partial reply cleanly.
    // Cleared in finally so a late abort can never bleed into the next turn.
    const abort = new AbortController();
    this.activeAbort = abort;

    const last = batch[batch.length - 1]!; // batch is non-empty here (dispatch returns early when empty)
    // A solo turn has no platform message behind it, so there is nothing to react on — but a message
    // the user typed into it mid-turn does have one.
    const mark = (emoji: string): Promise<void> => {
      const joined = this.joined;
      this.joined = [];
      const refs = [...(opts.solo ? [] : [refOf(last)]), ...joined.map(refOf)];
      return Promise.all(refs.map((ref) => this.safeReaction(ref, emoji))).then(() => undefined);
    };
    try {
      await this.deps.runTurn(batch, abort.signal);
      // Skip ✅ for a stopped turn: it did not finish, it was stopped.
      if (this.interrupted) {
        this.joined = [];
        return 'interrupted';
      }
      await mark(this.opts.reactions.done);
      return 'ok';
    } catch {
      await mark(this.opts.reactions.error);
      return 'failed';
    } finally {
      this.activeAbort = null;
      this.stopping = false;
    }
  }

  /**
   * After a turn ends: start the queued messages as a fresh batch, else the next solo turn, else go
   * idle. The user's own backlog first — see enqueueSolo for why a clock waits behind a person.
   */
  private async drainQueue(): Promise<void> {
    if (this.queued.length > 0) {
      this.buffer = this.queued;
      this.queued = [];
      this.phase = 'collecting';
      // Queued messages start immediately (already waited, no second merge window).
      await this.dispatch();
      return;
    }
    const next = this.solo.shift();
    if (!next) {
      this.toIdle();
      return;
    }
    console.log(`[dispatch] triggered, ${next.batch.length} solo message(s) into this turn`);
    const outcome = await this.runBatch(next.batch, { solo: true });
    next.settle(outcome);
    await this.drainQueue();
  }

  /**
   * Switch to idle and notify the registry (for idle reclaim) — unless a message is still being
   * offered to the turn that just ended. Such an offer can no longer join anything, so it is about to
   * start the next turn, and telling the registry the conversation went idle would invite it to
   * reclaim the child that turn is going to need. The idle after that turn is reported instead.
   */
  private toIdle(): void {
    this.phase = 'idle';
    this.collectStartedAt = 0;
    if (this.offering === 0) this.deps.onIdle?.();
  }

  /**
   * Lifecycle reactions are best-effort markers; failures are swallowed, never escaping dispatch.
   * The single choke point for all three (received/done/error), so the display.reactions.enabled
   * gate lives here rather than at each call site.
   */
  private async safeReaction(ref: MessageRef, emoji: string): Promise<void> {
    if (this.opts.reactionsEnabled === false) return;
    try {
      await this.deps.addReaction(ref, emoji);
    } catch {
      // Reaction failure (network/rate-limit/deleted/permission) must not escape dispatch.
    }
  }
}
