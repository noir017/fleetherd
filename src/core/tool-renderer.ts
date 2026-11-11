import type { MessageRef, ToolEvent, ToolFinishEvent, ToolMode } from '../types.js';
import { MessageNotEditableError, retryAfterMsOf } from './outbound-errors.js';

/**
 * Tool bubble renderer.
 *
 * Renders tool progress as bubbles separate from the body: {emoji} {tool}: "{preview≤N}", and
 * ↳ {subagent} · {emoji} {tool}: "{preview≤N}" for a tool a subagent ran — shortened to
 * ↳ {emoji} {tool}: … when the line above is the same subagent's (see ownerPrefix).
 * Four modes: off / all / new (dedupe consecutive same-name) / verbose (append args JSON).
 *
 * Grouping:
 * - separate: one new bubble per tool.
 * - accumulate: edit all progress into one bubble (multi-line in-place refresh);
 *   onToolFinish updates the matching line to "✓/✗ + duration".
 *
 * ── Sealing: when a BUBBLE can take no more ─────────────────────────────────────────────────────
 *
 * Accumulate rewrites one message over and over, so it runs into the same two per-message ceilings
 * StreamBuffer does, and answers them the same way: stop editing that bubble, carry the lines whose
 * state has not been delivered into a fresh one, and keep going. All three of StreamBuffer's
 * sealing rules apply — `maxEdits` (budget spent), `maxMessageLength` (full), and the platform's
 * own refusal (`MessageNotEditableError`).
 *
 * ── Painting: when the CHAT can take no more ────────────────────────────────────────────────────
 *
 * That is a different limit and it needed a different answer. This renderer used to repaint
 * synchronously on every tool start AND every finish, with no throttle, and rethrow anything that
 * was not a `MessageNotEditableError`. Under a run of back-to-back tool calls that is two writes
 * per tool into one chat: Telegram answered 429 with `retry after` up to 229 seconds, the rethrow
 * reached the turn's side-effect chain, and the update was gone — nothing re-triggered a paint
 * until the next tool event, so the bubble sat frozen on stale progress. One daemon run logged 78.
 *
 * So painting is now:
 *
 * - **Asynchronous.** `onToolStart` / `onToolFinish` mutate the line set and return; a single
 *   painter drains it. They no longer sit in the turn's side-effect chain, so a paused lane cannot
 *   stall the reply behind a tool bubble.
 * - **Retried, never dropped.** Any failure that is not a seal keeps every piece of state and arms
 *   a retry — at the platform's own `retryAfterMs` when it named one, else an exponential backoff.
 *   A write the pacer discards (`WriteDroppedError`) is treated the same way: not delivered, so
 *   still pending.
 * - **Tracked by revision, not by a flag.** `deliveredRev` is the highest revision of the line set
 *   that actually reached the platform. A `finishDelivered` boolean was correct only while writes
 *   were synchronous: a ✓ recorded WHILE a paint is in flight is not delivered by that paint, and
 *   marking it so would let the next seal drop a line the user never saw finish.
 *
 * Note: the body is owned by StreamBuffer; this renderer only handles tool bubbles
 * and signals segment breaks. The daemon coordinates: it completes the current body
 * buffer, emits the tool bubble, then starts a fresh body buffer.
 */

/** Retry interval used after a failure that named no wait of its own. */
const DEFAULT_RETRY_INTERVAL_MS = 1_200;
/** Ceiling on the exponential retry backoff. */
const DEFAULT_MAX_RETRY_MS = 30_000;
/** Ceiling on a wait the platform states, so one absurd number cannot freeze the bubble. */
const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;
/**
 * Longest subagent name a bubble line carries. Sixteen CJK characters already fill half a phone's
 * width — on the first line of each run of that subagent's tools, which is the only line that
 * carries it (see ownerPrefix).
 */
const AGENT_LABEL_LIMIT = 16;

export interface ToolRendererOptions {
  mode: ToolMode;
  /**
   * - 'separate': one new bubble per tool.
   * - 'accumulate': edit all progress into one bubble (needs sink.editBubble;
   *   degrades to separate when unavailable).
   * Defaults to 'accumulate' when omitted, so callers that don't pass it still compile.
   */
  grouping?: 'separate' | 'accumulate';
  previewLimit: number;
  defaultEmoji: string;
  emojiMap: Record<string, string>;
  /**
   * In-place edits one bubble accepts before it is sealed and progress continues in a new bubble.
   * Undefined = unbounded. Wired from PlatformCapabilities.maxEditsPerMessage.
   */
  maxEdits?: number;
  /**
   * Rendered length one bubble can carry before it is sealed. Undefined = unbounded.
   * Wired from PlatformCapabilities.maxMessageLength.
   *
   * This is the third of the three sealing rules in core/README.md ("full"). Without it an
   * accumulating bubble grows until the platform rejects the write outright — on Telegram
   * MESSAGE_TOO_LONG on the edit, "text is too long" on the send — and since neither is a
   * MessageNotEditableError, paint() rethrew and the whole block of progress was dropped.
   */
  maxMessageLength?: number;
  /**
   * Measures `text` in the units maxMessageLength counts. Defaults to raw character count.
   *
   * Same seam as StreamBuffer's: a profile whose markdown rendering expands the visible text
   * (Telegram renders tables to bullets, ~1.4x) must measure the RENDERED length, or a block
   * that looks like it fits still overflows on arrival.
   */
  measureLength?: (text: string) => number;
  /** First retry delay after a failure that stated no wait; doubles up to maxRetryMs. */
  retryIntervalMs?: number;
  /** Ceiling on the exponential retry backoff. */
  maxRetryMs?: number;
  /** Ceiling on a platform-stated wait (`RateLimitedError.retryAfterMs`). */
  maxRetryAfterMs?: number;
}

/**
 * Tool bubble send channel.
 * - sendBubble: send a new message, returns a ref.
 * - editBubble (optional): edit a message in place; accumulate uses it to refresh
 *   one bubble. When absent, accumulate degrades to separate.
 * - now/schedule: the injected clock. Core reads no wall clock — same seam as StreamSink.
 */
export interface BubbleSink {
  sendBubble(text: string): Promise<MessageRef>;
  editBubble?(ref: MessageRef, text: string): Promise<void>;
  now(): number;
  /** Fire `fn` after `ms`; returns a cancel handle. */
  schedule(fn: () => void, ms: number): () => void;
}

/** One tool progress line in the current segment (accumulate mode). */
interface ToolLine {
  /** Sequence number linking start/finish; undefined → located by appearance order. */
  index?: number;
  name: string;
  /**
   * The subagent that ran this tool (ToolEvent.agent); undefined for the main agent's own.
   *
   * Kept apart from `body` because how much of it a line shows depends on the line above it, and
   * which line is above changes after the fact: a seal carries unfinished lines into a new
   * bubble, and fitBlock drops the oldest. So the prefix is decided in renderBlock, every time.
   */
  agent?: string;
  /** Rendered "in progress" body (emoji + name + preview), without the owner prefix. */
  body: string;
  /** verbose JSON code block under the line (once); undefined otherwise. */
  json?: string;
  /** Finish state: undefined = in progress; otherwise records ok and duration. */
  finish?: { ok: boolean; durationMs: number };
  /**
   * The line set's revision when this line's finish was recorded.
   *
   * Compared against `deliveredRev` to answer "has the platform shown this ✓ yet", which drives
   * what a seal carries over: a line finished but not yet delivered must move to the new bubble,
   * or its ✓ lands nowhere and the sealed bubble shows it running forever. A boolean cannot answer
   * that once writes are asynchronous — a finish recorded while a paint is in flight would be
   * marked delivered by a write that never contained it.
   */
  finishRev?: number;
}

export class ToolRenderer {
  /** What `new` mode compares the next tool against: its name, plus its owner when a subagent's. */
  private lastToolKey: string | null = null;

  // ---- accumulate segment state ----
  private lines: ToolLine[] = [];
  /** Bubble ref of the current segment (set after the first sendBubble). */
  private bubbleRef: MessageRef | null = null;
  /** Edits spent on the current bubble; the initial send does not count. */
  private bubbleEdits = 0;
  /** Exactly the text the platform currently shows for the open bubble. */
  private lastPaintedText: string | null = null;

  // ---- painter state ----
  /** Bumped on every mutation of the line set; the version a paint is trying to deliver. */
  private rev = 0;
  /** Highest revision that actually reached the platform. */
  private deliveredRev = -1;
  /** A paint is in flight; a second must not start (one write at a time per bubble). */
  private painting = false;
  /** Cancel handle for an armed retry. */
  private cancelRetry: (() => void) | null = null;
  /**
   * Revision at which the current segment ended, if `resetSegment` is waiting on delivery.
   *
   * A new tool arriving while this is pending forces the rotation through: the previous segment is
   * over, and holding its lines any longer would paint them into the NEXT segment's bubble.
   */
  private closeAtRev: number | null = null;
  /** Current retry delay after a failure that stated no wait. */
  private retryBackoff: number;
  /** Resolvers waiting on settle(). */
  private settleWaiters: Array<() => void> = [];
  /** Resolvers waiting on placed(). */
  private placeWaiters: Array<() => void> = [];
  /** Standalone (separate-grouping) sends still in flight; each one is an unplaced bubble. */
  private standaloneInFlight = 0;
  /**
   * Indexes already sent under `separate` grouping, which has no line set to rewrite.
   *
   * Only used to tell a call's own update (drop it) from a new call (send it) — see onToolStart.
   * Cleared with the segment, so it cannot grow across a long session.
   */
  private sentIndexes = new Set<number>();
  private aborted = false;

  constructor(
    private readonly opts: ToolRendererOptions,
    private readonly sink: BubbleSink
  ) {
    this.retryBackoff = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  }

  /** Effective grouping (defaults to accumulate when omitted). */
  private get grouping(): 'separate' | 'accumulate' {
    return this.opts.grouping ?? 'accumulate';
  }

  /** Whether accumulate is actually usable: mode is accumulate and the sink supports edit. */
  private get accumulateActive(): boolean {
    return this.grouping === 'accumulate' && typeof this.sink.editBubble === 'function';
  }

  /**
   * A tool started — or, with the same `index`, reported again.
   *
   * Returns as soon as the line set is updated; delivery happens on the painter. It used to be
   * awaited by the turn's side-effect chain, which meant every progress write sat between the
   * agent's text and the user — and, once the chat was rate-limited, blocked it.
   *
   * ── Why the same index can arrive twice ──────────────────────────────────────────────────────
   *
   * ACP lets a tool's later update replace its title/kind/rawInput, and some harnesses lean on
   * that hard: CodeBuddy Code opens every call with `{title: "Bash", kind: "other", rawInput: {},
   * status: "in_progress"}`, which is enough to be drawn (status advanced) and says nothing —
   * the row reads `⚙️ Tool: "Bash"` — and only then streams `rawInput.command` and re-sends the
   * call as `{kind: "execute", title: "`echo hi`"}`. Drawn once, that row stayed `Tool: "Bash"`
   * for the whole call and the command never appeared (probed 2026-11-02, project-scripts/
   * cbc-acp-probe). So a second start for an unfinished line REPLACES it in place — the line set
   * is keyed by index, and an edit is how a row that is already on screen changes.
   */
  onToolStart(evt: ToolEvent): void {
    if (this.aborted) return;
    if (this.opts.mode === 'off') return;

    // A tool belonging to the NEXT segment cannot join the last one's line set, even if that
    // segment's closing write has not landed yet. Its content is already on screen or already
    // lost; either way it is not this segment's business.
    if (this.closeAtRev !== null) this.rotate();

    const emoji = this.opts.emojiMap[evt.name] ?? this.opts.defaultEmoji;
    const preview = this.truncate(evt.inputPreview, this.opts.previewLimit);
    // No quoted preview when it only repeats the name: harnesses that title a call with the tool's
    // own name (`Bash`, `ToolSearch`) fall back to that title before the parameters stream, and
    // `💻 Bash: "Bash"` is a row that says one thing twice.
    const body =
      preview && preview !== evt.name ? `${emoji} ${evt.name}: "${preview}"` : `${emoji} ${evt.name}`;
    const json =
      this.opts.mode === 'verbose' && evt.input !== undefined
        ? '```json\n' + safeJson(evt.input) + '\n```'
        : undefined;

    // An update to a call that is already on screen: rewrite its row, do not add a second one.
    if (this.rewriteKnownRow(evt, body, json)) return;

    // A subagent's Bash right after the main agent's is a different call, not a repeat, so the
    // owner is part of what `new` compares.
    const dedupeKey = evt.agent === undefined ? evt.name : `${evt.agent}\u0000${evt.name}`;
    if (this.opts.mode === 'new' && dedupeKey === this.lastToolKey) {
      return; // dedupe consecutive same-name (applies under both groupings)
    }
    this.lastToolKey = dedupeKey;

    if (!this.accumulateActive) {
      // separate (incl. degraded accumulate): one new bubble per tool, no line set — and so no
      // line above to share a name with: every bubble names its owner in full.
      //
      // No line set means no row to rewrite, so an update for a call already sent has nowhere to
      // go: dropping it is the honest answer (the bubble below still names the tool), and posting
      // it again would read as a second run of the same command.
      if (evt.index !== undefined) {
        if (this.sentIndexes.has(evt.index)) return;
        this.sentIndexes.add(evt.index);
      }
      let text = this.ownerPrefix(evt.agent, undefined) + body;
      if (json) text += '\n' + json;
      // No line set to seal here, so an oversized bubble (verbose JSON) can only be clamped.
      if (this.overflows(text)) text = this.clamp(text, this.opts.maxMessageLength!);
      this.emitStandalone(text);
      return;
    }

    // accumulate: add the tool to the line set and re-render the whole bubble.
    this.lines.push({ index: evt.index, name: evt.name, agent: evt.agent, body, json });
    this.touch();
  }

  /**
   * Rewrite the row of a call that is already in the line set, and say whether this event was that.
   *
   * Runs before the `new` dedupe in onToolStart, or an upgrade that keeps the name (same tool, its
   * parameters finally streamed in) would be swallowed as a repeat. A row that already carries its
   * ✓ is closed: a late frame for it is the harness catching up, and a second row would read as a
   * second run of the same command.
   */
  private rewriteKnownRow(evt: ToolEvent, body: string, json: string | undefined): boolean {
    if (evt.index === undefined) return false;
    const line = this.lines.find((l) => l.index === evt.index);
    if (!line) return false;
    if (line.finish) return true; // closed; nothing to redraw
    line.name = evt.name;
    line.body = body;
    line.json = json;
    this.touch();
    return true;
  }

  /**
   * Tool finish: locate the line by index/name, mark ok and duration, re-render.
   *
   * separate trade-off: each tool is a separate bubble with no per-index ref, so
   * its bubble can't be edited afterward → safe no-op.
   * accumulate: update the line set and repaint the bubble.
   */
  onToolFinish(evt: ToolFinishEvent): void {
    if (this.aborted) return;
    if (this.opts.mode === 'off') return;
    if (!this.accumulateActive) return; // separate: can't locate a per-tool bubble, no-op

    const line = this.findLine(evt);
    if (!line) return; // no matching line (e.g. deduped by 'new'): ignore

    line.finish = { ok: evt.ok, durationMs: evt.durationMs };
    line.finishRev = this.rev + 1;
    this.touch();
  }

  /**
   * Called at end of turn / body-segment switch. Clears the accumulate line set
   * and bubble ref (next segment starts a new bubble) and resets 'new' dedupe state.
   *
   * The clear is DEFERRED until the segment's final state has actually been delivered. Clearing
   * immediately would race the painter: a ✓ that arrived while a write was in flight would be
   * dropped along with the line that carried it, and every tool run would end looking unfinished —
   * which is precisely the failure asynchronous painting would otherwise reintroduce.
   */
  resetSegment(): void {
    this.lastToolKey = null;
    if (this.aborted || this.lines.length === 0) {
      this.rotate();
      return;
    }
    this.rev++;
    this.closeAtRev = this.rev;
    void this.pump();
  }

  /** Actually start a fresh segment: empty line set, no open bubble. */
  private rotate(): void {
    this.lines = [];
    this.bubbleRef = null;
    this.bubbleEdits = 0;
    this.lastPaintedText = null;
    this.closeAtRev = null;
    this.sentIndexes.clear();
    this.deliveredRev = this.rev;
    // Nothing is owed a send any more — the line set that would have needed one is gone.
    this.releasePlaceWaiters();
  }

  /**
   * Resolve once nothing is in flight and nothing is armed, or `timeoutMs` has passed.
   *
   * The deadline is what keeps a rate-limited chat from holding a turn open: the turn stops
   * WAITING for its tool bubbles, it does not cancel them — a write already queued still lands.
   */
  settle(timeoutMs: number): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        cancel();
        resolve();
      };
      const cancel = this.sink.schedule(finish, timeoutMs);
      this.settleWaiters.push(finish);
    });
  }

  /**
   * Resolve once no bubble is still waiting to be POSTED, or `timeoutMs` has passed.
   *
   * ── Why this exists, and why it is not settle() ───────────────────────────────
   * Painting asynchronously fixed a flood and introduced a reordering: the painter runs one write
   * behind the turn's side-effect chain, so the bubble for a tool could be posted *after* the body
   * text of the segment that came next. A turn read bottom-up as "now let me check the profile" →
   * "found it, three profiles declare it" → and only then the Grep that found them. Reproduced with
   * no rate pressure at all; it is the normal case, not a congestion edge.
   *
   * The narrow thing being fixed is worth stating precisely, because it is what keeps the wait
   * cheap: **only a SEND can land in the wrong place.** An edit rewrites a message that already
   * holds its position, so it may stay off the chain, late and unordered, exactly as before. So
   * this waits for placement — a bubble taking its spot in the chat — and for nothing else. At
   * most one such wait per bubble, and it overlaps the tool's own execution.
   *
   * Bounded for the same reason settle() is, and with the same preference: if the platform is
   * making us wait, the reply matters more than the reading order. Past the deadline the body goes
   * on and the bubble lands wherever it lands.
   */
  placed(timeoutMs: number): Promise<void> {
    if (!this.awaitingPlacement) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        cancel();
        resolve();
      };
      const cancel = this.sink.schedule(finish, timeoutMs);
      this.placeWaiters.push(finish);
    });
  }

  /**
   * Whether a bubble still has to be SENT (as opposed to edited) before it is on screen.
   *
   * True in exactly two states: an accumulate line set with no bubble carrying it yet (a fresh
   * segment, or one whose bubble was just sealed and whose lines are being carried into a new
   * one), and a standalone send still in flight under `separate` grouping.
   */
  private get awaitingPlacement(): boolean {
    if (this.aborted || this.opts.mode === 'off') return false;
    if (this.standaloneInFlight > 0) return true;
    return this.lines.length > 0 && this.bubbleRef === null;
  }

  /** Turn interrupted: stop painting and drop anything armed. */
  abort(): void {
    this.aborted = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.releaseWaiters();
    // An aborted renderer owes nothing, so anything holding a message back for a bubble that is
    // never coming is let go too — an interrupted turn must not leave the reply waiting.
    this.releasePlaceWaiters();
  }

  // --- painting ---

  /** Record a change to the line set and make sure a paint is coming. */
  private touch(): void {
    this.rev++;
    void this.pump();
  }

  private idle(): boolean {
    return this.aborted || (!this.painting && this.cancelRetry === null && this.deliveredRev >= this.rev);
  }

  private releaseWaiters(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Let go of anyone waiting on placed(), once nothing is owed a send.
   *
   * Called from every point that can flip `awaitingPlacement` false — a successful send, a rotate
   * that drops the line set, an abort — rather than polled, so the body's next message is held for
   * exactly as long as the bubble takes and not a tick longer.
   */
  private releasePlaceWaiters(): void {
    if (this.awaitingPlacement) return;
    const waiters = this.placeWaiters;
    this.placeWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Deliver the newest line set, one write at a time.
   *
   * Loops rather than returning after one write: a mutation that arrived DURING a write raised
   * `rev` past what that write carried, and the whole point of the revision watermark is that such
   * a change is not silently considered delivered.
   */
  private async pump(): Promise<void> {
    if (this.painting || this.aborted) return;
    this.painting = true;
    try {
      while (!this.aborted && this.deliveredRev < this.rev && this.cancelRetry === null) {
        const target = this.rev;
        const outcome = await this.runPaint();
        if (outcome === 'failed') break; // a retry is armed (or the renderer aborted)
        // 'sealed' delivered nothing — the bubble was closed and the same content still has to
        // land in a fresh one, so the watermark must NOT advance or the loop would exit believing
        // the seal was the delivery.
        if (outcome === 'delivered') {
          this.deliveredRev = Math.max(this.deliveredRev, target);
          if (this.closeAtRev !== null && this.deliveredRev >= this.closeAtRev) this.rotate();
        }
      }
    } finally {
      this.painting = false;
      if (this.idle()) this.releaseWaiters();
    }
  }

  /**
   * One write of the current line set.
   *
   * Never throws. Every outcome that is not `delivered` keeps the state exactly as it was, so the
   * content is carried by the next attempt rather than lost — which is the whole difference from
   * the rethrow this replaced.
   */
  private async runPaint(): Promise<'delivered' | 'sealed' | 'failed'> {
    // Budget spent: stop editing this bubble before the platform starts refusing.
    if (this.bubbleRef !== null && this.budgetSpent()) this.seal();
    // Full: the block outgrew what one message can carry. Seal on the same rule StreamBuffer
    // uses, so the overflow continues in a fresh bubble instead of being rejected on the wire.
    if (this.bubbleRef !== null && this.overflows(this.renderBlock())) this.seal();

    if (this.lines.length === 0) return 'delivered'; // nothing to say; don't send an empty bubble

    const editing = this.bubbleRef !== null;
    const text = this.fitBlock();
    if (editing && text === this.lastPaintedText) {
      return 'delivered'; // already on screen verbatim: a write saying the same thing is waste
    }

    try {
      if (!editing) {
        this.bubbleRef = await this.sink.sendBubble(text);
        this.bubbleEdits = 0;
        // The bubble now holds a position in the chat, so whatever is waiting to write BELOW it
        // may go (see placed()). Released here rather than at the end of the paint loop: the
        // ordering constraint is satisfied by the send, not by the rest of the painting.
        this.releasePlaceWaiters();
      } else {
        await this.sink.editBubble!(this.bubbleRef!, text);
        this.bubbleEdits++;
      }
      this.lastPaintedText = text;
      this.retryBackoff = this.opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
      return 'delivered';
    } catch (e) {
      // Guarded on `editing`: a SEND that somehow reports un-editable has no bubble to seal, and
      // treating it as one would spin — seal() would be a no-op and the loop would call back in.
      if (editing && e instanceof MessageNotEditableError) {
        // This bubble is finished, but the progress is not: seal, and let the loop repaint the
        // carried-over lines into a fresh one.
        this.seal();
        return 'sealed';
      }
      // Rate limit, a dropped write, a network blip — all "not delivered, try again". Waiting the
      // time the platform NAMED matters here: guessing 1.2 s against a stated 229 s is what keeps
      // a flood alive.
      this.armRetry(retryAfterMsOf(e));
      return 'failed';
    }
  }

  /** Wait, then paint again. `stated` is the platform's own number when it gave one. */
  private armRetry(stated: number | undefined): void {
    if (this.aborted || this.cancelRetry) return;
    const max = this.opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    const wait =
      stated !== undefined ? Math.min(stated, max) : this.retryBackoff;
    if (stated === undefined) {
      this.retryBackoff = Math.min(this.retryBackoff * 2, this.opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS);
    }
    this.cancelRetry = this.sink.schedule(() => {
      this.cancelRetry = null;
      void this.pump();
    }, wait);
  }

  /**
   * A standalone bubble (separate grouping): fire and forget, with no retry.
   *
   * Deliberately not retried. Separate grouping has no line set, so a failed bubble has no state
   * to recover — and re-sending it later would drop it below progress that has since arrived,
   * which reads worse than the gap it fills.
   */
  private emitStandalone(text: string): void {
    this.rev++;
    this.painting = true;
    this.standaloneInFlight++;
    void this.sink
      .sendBubble(text)
      .catch(() => undefined)
      .finally(() => {
        this.deliveredRev = this.rev;
        this.painting = false;
        this.standaloneInFlight--;
        this.releasePlaceWaiters();
        if (this.idle()) this.releaseWaiters();
      });
  }

  // --- rendering / sealing ---

  /** Measure in the units maxMessageLength counts; raw characters unless a profile says otherwise. */
  private measure(text: string): number {
    return this.opts.measureLength ? this.opts.measureLength(text) : text.length;
  }

  private overflows(text: string): boolean {
    const max = this.opts.maxMessageLength;
    return max !== undefined && this.measure(text) > max;
  }

  /**
   * The line set rendered down to something one message can actually carry.
   *
   * Usually a no-op: runPaint has already sealed an overflowing bubble, and the lines carried
   * over are far shorter. It bites only when the survivors alone still overflow — a burst of
   * tools running in parallel, none of them finished. Then the OLDEST lines go first: those
   * are the ones already readable in the sealed bubble above, while the newest progress is
   * what the user is actually waiting on.
   */
  private fitBlock(): string {
    if (this.opts.maxMessageLength === undefined) return this.renderBlock();

    while (this.lines.length > 1 && this.overflows(this.renderBlock())) this.lines.shift();

    const block = this.renderBlock();
    if (!this.overflows(block)) return block;
    // One line alone over the limit (a verbose-mode JSON dump). Truncating loses part of that
    // line; not truncating loses the entire block to a platform rejection.
    return this.clamp(block, this.opts.maxMessageLength);
  }

  /** Longest prefix of `text` that still measures within `max`, marked with an ellipsis. */
  private clamp(text: string, max: number): string {
    const ellipsis = '…';
    // Binary search on the raw string: measure() may be non-linear (rendering expands), so the
    // cut point cannot be computed directly from a character count.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.measure(text.slice(0, mid) + ellipsis) <= max) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + ellipsis;
  }

  private budgetSpent(): boolean {
    const max = this.opts.maxEdits;
    return max !== undefined && this.bubbleEdits >= max;
  }

  /**
   * Freeze the current bubble and prepare a fresh one: keep only the lines whose current state the
   * frozen bubble does NOT already show (still running, or finished since the last write). Lines
   * fully rendered there are dropped — they stay readable above, and repeating them would grow every
   * subsequent bubble by the whole history.
   */
  private seal(): void {
    this.bubbleRef = null;
    this.bubbleEdits = 0;
    this.lastPaintedText = null;
    this.lines = this.lines.filter((l) => l.finish === undefined || !this.finishDelivered(l));
  }

  /** Whether the platform has actually shown this line's finish mark. */
  private finishDelivered(line: ToolLine): boolean {
    return line.finishRev !== undefined && line.finishRev <= this.deliveredRev;
  }

  /** Locate the best matching unfinished line by index (preferred) or name (fallback). */
  private findLine(evt: ToolFinishEvent): ToolLine | undefined {
    if (evt.index !== undefined) {
      const byIndex = this.lines.find((l) => l.index === evt.index);
      if (byIndex) return byIndex;
    }
    // No index or no hit: take the earliest unfinished line with the same name.
    return this.lines.find((l) => l.name === evt.name && l.finish === undefined);
  }

  /** Render the line set into one block (lines joined by \n; verbose JSON under its line). */
  private renderBlock(): string {
    const parts: string[] = [];
    let above: ToolLine | undefined;
    for (const l of this.lines) {
      let row = this.ownerPrefix(l.agent, above?.agent) + l.body;
      above = l;
      if (l.finish) {
        const mark = l.finish.ok ? '✓' : '✗';
        row += ` ${mark} ${formatDuration(l.finish.durationMs)}`;
      }
      parts.push(row);
      if (l.json) parts.push(l.json);
    }
    return parts.join('\n');
  }

  private truncate(s: string, n: number): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
  }

  /**
   * `↳ {subagent} · ` before a subagent's tool, nothing before the main agent's — and only `↳ `
   * when the line above (`above`, that line's owner) is the same subagent's.
   *
   * Text rather than indentation or styling because it has to survive every renderer: leading
   * whitespace is collapsed by most chat markdown, and only the web UI could style a line. The
   * name is what tells two parallel subagents apart; it is the model's own short label for the
   * job, cut to AGENT_LABEL_LIMIT so the preview after it — the part that changes — stays visible.
   *
   * Once per run rather than on every line: a subagent's tools usually come in a long unbroken
   * run, and repeating its name on each of them spent the width the commands needed. On
   * 2026-10-10 a phone showed fifteen lines of one subagent's work as `↳ 接手修复 shop-api 存… ·
   * 💻 Bash: "cd /h…`, half of every row the same sixteen characters. The bare `↳` still marks
   * each line as not the main agent's, and a switch of owner — the main agent, or a parallel
   * subagent — puts the name back on the next line, as does the top of every bubble, so
   * attribution survives interleaving and sealing at the cost of the old width there.
   */
  private ownerPrefix(agent: string | undefined, above: string | undefined): string {
    if (agent === undefined) return '';
    if (agent === above) return '↳ ';
    return `↳ ${this.truncate(agent, AGENT_LABEL_LIMIT)} · `;
  }
}

/** Duration formatting: <1000ms → "832ms"; otherwise "1.2s" (one decimal). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
