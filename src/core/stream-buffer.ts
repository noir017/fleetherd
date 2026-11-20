import type { MessageRef } from '../types.js';
import { closeFence, continueFence, fenceAfter, type OpenFence } from './code-fence.js';
import { MessageNotEditableError, retryAfterMsOf } from './outbound-errors.js';

/**
 * Outbound buffer for one turn's reply text. Two delivery modes, chosen by `mode`.
 *
 * ── `'once'` (the DEFAULT; `stream.enabled: false`) ──────────────────────────────────────────────
 *
 *     push … push … complete({footer}) ─▶ [ message ][ message ]…
 *
 * Nothing goes out until the buffer completes; then the accumulated text is split by
 * `maxMessageLength` and sent, as one message or as several. No message is ever edited.
 *
 * This is the default because live editing costs more than it returns. Every flush spends an edit,
 * platforms meter and cap them — Feishu allows 20 per message and then refuses that message
 * forever — so the reply most likely to run out of edits mid-delivery is the long, considered one
 * that matters most. Finished text sent once has no such ceiling: the only limit left is message
 * length, which splits cleanly. The turn is not silent in the meantime either: a text segment is
 * completed and sent at every tool boundary, so a turn that uses tools still reports as it goes.
 *
 * ── `'live'` (`stream.enabled: true`) ───────────────────────────────────────────────────────────
 *
 *     [ sealed ][ sealed ][ open ]
 *                            ↑ still edited in place as text arrives
 *
 * Dual-trigger throttle: flush when `charThreshold` chars accumulate OR `flushIntervalMs` elapses
 * since the last write. Requires a platform that can edit (`capabilities.editMessage`).
 *
 * ── Sealing (both modes) ────────────────────────────────────────────────────────────────────────
 *
 * A message is SEALED — immutable, never touched again — for one of three reasons, all handled
 * identically:
 *
 *   - **full**: the text outgrew `maxMessageLength`, so the remainder continues in a new message.
 *   - **budget spent**: `maxEditsPerMessage` in-place edits have been used up.
 *   - **not editable**: the platform said so mid-stream (`MessageNotEditableError`).
 *
 * Sealing is never a failure. The sealed text counts as delivered and delivery continues into a
 * fresh message, so `sealedText + open.text` is always EXACTLY what the user can see (plus the
 * newlines at each seam, which separate messages rather than open one): nothing is re-sent, nothing
 * is lost. In `'once'` mode only the first reason can occur, which is why that
 * mode cannot lose the tail of a reply at all.
 *
 * Folding the edit budget into the same concept as the length limit is what makes that invariant
 * hold — both are just "this message can take no more". The design this replaced had only "back
 * off, then degrade to whole-message send", which could not express *permanently un-editable*: past
 * Lark's cap the final flush re-edited the dead message, swallowed the rejection, and reported the
 * turn complete, losing everything after the cap.
 *
 * Transient failures (rate limit, network) back the interval off exponentially and keep the open
 * message — except when the platform STATES how long to wait (`RateLimitedError.retryAfterMs`),
 * which overrides the exponential cap because it is a fact rather than a guess. The final flush
 * refuses to leave text undelivered behind a failure it can route around — it seals and sends the
 * remainder instead. Overflow is split without breaking code fences.
 * `[SILENT]` as the whole reply suppresses all output.
 *
 * ── Code fences across buffers ──────────────────────────────────────────────────────────────────
 *
 * One buffer is one stretch of a reply between tool calls, and the stretch can end inside a code
 * block. So the final render closes a fence the text left open, and a buffer made to continue that
 * reply (`carry`, from the previous buffer's `openFence()`) starts inside the block again — see
 * `code-fence.ts` for why and how.
 */

/**
 * Ceiling on a platform-stated wait when the caller names none. Five minutes is longer than any
 * flood wait observed (Telegram's worst so far: 229 s) and short enough that a nonsense value
 * cannot silence a conversation for the rest of the process.
 */
const DEFAULT_MAX_RETRY_AFTER_MS = 300_000;

export interface StreamBufferOptions {
  /**
   * Delivery mode. `'once'`: accumulate and send on `complete()`. `'live'`: edit one message in
   * place as text arrives. Resolved by the daemon from `stream.enabled` AND the platform's
   * `editMessage` capability, so a platform that cannot edit (QQ/LINE/WeCom/DingTalk) always gets
   * `'once'` no matter what the config asks for.
   */
  mode: 'once' | 'live';
  /** `'live'` only: flush after this many new chars accumulate. */
  charThreshold: number;
  /** `'live'` only: flush once this long has passed since the last write. */
  flushIntervalMs: number;
  /**
   * `'live'` only: cap for the exponential backoff after a transient failure.
   *
   * Caps only the BLIND guess. A wait the platform states overrides it — see maxRetryAfterMs.
   */
  maxBackoffMs: number;
  /**
   * Ceiling on a wait the PLATFORM states (`RateLimitedError.retryAfterMs`), which overrides
   * `maxBackoffMs` rather than being capped by it — see onTransientFailure. Bounded so one absurd
   * value cannot wedge the buffer for the rest of the process. Undefined = 5 minutes.
   */
  maxRetryAfterMs?: number;
  silentToken: string;
  maxMessageLength: number;
  /**
   * In-place edits one delivered message accepts before the buffer seals it and continues in a new
   * one. Undefined = unbounded (most platforms only rate-limit edits). Wired from
   * `PlatformCapabilities.maxEditsPerMessage`; Lark declares 20. Only reachable in `'live'` mode —
   * `'once'` never edits.
   */
  maxEditsPerMessage?: number;
  /**
   * Rendered-length measure for chunking. The chunker splits the RAW text but the platform limit
   * (maxMessageLength) applies to the RENDERED output, which markdown rendering can expand (table→
   * bullets) or re-unit (UTF-8 bytes). Given a raw substring, this returns its rendered length so
   * chunks fit post-render. Defaults to char length (identity) — correct for raw-passthrough.
   */
  measureLength?: (text: string) => number;
}

/** Outbound sink wrapping platform send/edit; bound by the daemon to the current channel. */
export interface StreamSink {
  send(text: string): Promise<MessageRef>;
  /** Only called in `'live'` mode. */
  edit(ref: MessageRef, text: string): Promise<void>;
  /** Clock injected externally so the core never reads Date.now() (eases testing/resume). */
  now(): number;
  /** Throttle timer; returns a cancel fn. */
  schedule(fn: () => void, ms: number): () => void;
}

/** The tail of the run: the one message still open for in-place edits. */
interface OpenMessage {
  ref: MessageRef;
  /** Exactly the text the platform currently shows for this message. */
  text: string;
  /** Edits spent on it so far; the initial send does not count. */
  edits: number;
}

export class StreamBuffer {
  private acc = '';                 // full accumulated text
  /**
   * Text already delivered in sealed messages: immutable, never re-sent. Includes the newlines at
   * each seam between two messages, which were consumed rather than sent (see doFlush).
   */
  private sealedText = '';
  private open: OpenMessage | null = null;
  private lastWriteAt = 0;
  private currentBackoff: number;
  /**
   * Earliest time a non-final flush may touch the platform again. Set by a transient failure;
   * cleared by a success. Distinct from `currentBackoff` (which is a duration) because the char
   * threshold has to be held back too, and that check has no elapsed-time term of its own.
   */
  private pausedUntil = 0;
  private cancelTimer: (() => void) | null = null;
  private aborted = false;          // no more output once the turn is interrupted
  // Serialize flushes: chain each onto the previous so complete()'s final flush
  // runs only after any in-flight flush settles, instead of being dropped by a
  // re-entrancy guard during that in-flight flush.
  private flushChain: Promise<void> = Promise.resolve();
  // Terminal footer: set only by complete({ footer }), appended after the visible
  // body of the final flush only. Does not affect any mid-stream rendering.
  private footer = '';

  constructor(
    private readonly opts: StreamBufferOptions,
    private readonly sink: StreamSink,
    /**
     * The code fence the previous message of this reply ended inside (its buffer's `openFence()`),
     * so this message carries on inside that block instead of opening one with its closing fence.
     */
    private readonly carry?: OpenFence
  ) {
    this.currentBackoff = opts.flushIntervalMs;
  }

  /**
   * The code fence this buffer's text leaves open, if any — closed in its own final message, and
   * what the buffer that continues the reply must be made with.
   */
  openFence(): OpenFence | undefined {
    return fenceAfter(this.acc, this.carry);
  }

  /** Receive a text delta. */
  push(delta: string): void {
    if (this.aborted) return;
    this.acc += delta;
    this.maybeFlush();
  }

  /**
   * End of turn: deliver whatever is still undelivered.
   *
   * opts.footer: optional runtime footer (model · ctx% · cwd). Appended as
   * `\n\n${footer}` only when this buffer has visible body (non-silent, non-empty
   * after trim); avoids emitting a footer-only message.
   */
  async complete(opts?: { footer?: string }): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.aborted) return;
    if (this.isSilent()) return;
    const footer = opts?.footer;
    // Judged on what the message shows, not on what was pushed: a buffer that only closed the block
    // the previous message left open shows nothing, and must not become a footer-only message.
    if (footer && footer.length > 0 && this.body(true).trim().length > 0) {
      this.footer = footer;
    }
    await this.flush(/* final */ true);
  }

  /** Turn interrupted: stop further edits. */
  abort(): void {
    this.aborted = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  // --- internal ---

  private isSilent(): boolean {
    return this.acc.trim() === this.opts.silentToken;
  }

  /**
   * The text this buffer's messages show: what was pushed, continuing a carried fence, and — on the
   * final render — with a fence it leaves open closed, so the footer after it is not taken for code.
   * Only grows from one call to the next while `acc` does, which the sealed-prefix rule relies on.
   */
  private body(final: boolean): string {
    const body = continueFence(this.acc, this.carry, final);
    return final ? closeFence(body) : body;
  }

  /** Dual-trigger check: char threshold OR time interval. `'once'` never flushes mid-turn. */
  private maybeFlush(): void {
    if (this.aborted) return;
    if (this.opts.mode === 'once') return; // delivery happens in complete(), so don't even arm a timer
    if (this.isSilent()) return;
    const now = this.sink.now();

    // A failed write said "not yet", and that outranks BOTH triggers. Backing off only the timer
    // left the char threshold as an open door: a stream that keeps producing text retried every
    // `charThreshold` chars straight through the wait, which is how a rate limit gets deeper
    // instead of expiring. Only the final flush may ignore this (see doFlush).
    if (now < this.pausedUntil) {
      this.armTimer(this.pausedUntil - now);
      return;
    }

    const pendingChars = this.acc.length - this.deliveredLength();
    const elapsed = now - this.lastWriteAt;

    if (pendingChars >= this.opts.charThreshold || elapsed >= this.currentBackoff) {
      void this.flush(false);
      return;
    }
    // Not triggered: arm a fallback timer so an idle stream still flushes after the interval.
    this.armTimer(Math.max(0, this.currentBackoff - elapsed));
  }

  /** Arm the single fallback flush timer, if one is not already pending. */
  private armTimer(wait: number): void {
    if (this.cancelTimer) return;
    this.cancelTimer = this.sink.schedule(() => {
      this.cancelTimer = null;
      void this.flush(false);
    }, wait);
  }

  /** Enqueue a flush onto the serial chain; the returned Promise resolves when it settles. */
  private flush(final: boolean): Promise<void> {
    // Chain after the previous flush so complete()'s final flush always runs
    // after any in-flight streaming flush settles.
    this.flushChain = this.flushChain.then(() => this.doFlush(final));
    return this.flushChain;
  }

  /** Everything the user can currently see from this buffer. */
  private deliveredLength(): number {
    return this.sealedText.length + (this.open?.text.length ?? 0);
  }

  /**
   * Deliver whatever is not on screen yet.
   *
   * Never throws: a failure it cannot route around is absorbed (backoff) so the flushChain stays
   * clean. Each loop iteration either completes the write or seals the open message and retries
   * with the remainder — strictly shorter every time, so it terminates.
   *
   * `final=true` appends the footer and, because there is no later flush to recover, refuses to
   * leave text undelivered behind a failure: it seals the open message and sends the rest.
   */
  private async doFlush(final: boolean): Promise<void> {
    if (this.aborted) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    // 'once': nothing is written until the buffer completes (see the header comment).
    if (this.opts.mode === 'once' && !final) return;

    // The footer joins only the final render; mid-stream is the body as it stands.
    const body = this.body(final);
    const rendered = final && this.footer ? body + '\n\n' + this.footer : body;
    if (rendered === '') return; // never pushed / empty body → don't send an empty message

    // The body only grows, and the closing fence and the footer are suffixes, so the sealed text stays
    // a prefix of `rendered`.
    // If a caller ever breaks that, re-deliver from scratch: a duplicated message beats a silently
    // dropped reply. Unreachable through push()/complete().
    if (!rendered.startsWith(this.sealedText)) {
      this.sealedText = '';
      this.open = null;
    }

    for (;;) {
      if (this.aborted) return;
      const tail = this.consumeSeam(rendered.slice(this.sealedText.length));
      if (tail === '') return;              // sealed messages already carry the whole render
      if (this.open?.text === tail) return; // unchanged → skip the API call entirely

      // Budget spent: seal deliberately and continue in a new message. Not a failure path.
      if (this.open && this.budgetSpent(this.open)) {
        this.seal();
        continue;
      }

      const chunks = this.splitIntoChunks(tail);
      const head = chunks[0]!; // splitIntoChunks never returns an empty list
      try {
        await this.write(head);
      } catch (err) {
        // The open message won't take this text. Sealing costs one extra message and keeps the
        // reply whole; on the final flush that trade is always worth it.
        if (this.open && (final || err instanceof MessageNotEditableError)) {
          this.seal();
          continue;
        }
        this.onTransientFailure(err);
        return;
      }
      this.onWriteSuccess();
      if (chunks.length === 1) return;
      // The head filled this message to the platform limit: it is final content now.
      this.seal();
    }
  }

  /** Whether the open message has spent its edit budget. */
  private budgetSpent(open: OpenMessage): boolean {
    const max = this.opts.maxEditsPerMessage;
    return max !== undefined && open.edits >= max;
  }

  /**
   * Drop the newlines a continuation would open with, counting them as delivered.
   *
   * A continuation begins where the previous message was cut, and cuts sit on line breaks
   * (findTextBreak), so the undelivered tail opens with the separator — one newline, or a blank line
   * when the cut is at a paragraph. That is the seam between two messages, not content, so it is
   * never sent (packChunks drops it the same way). Only when nothing is open and something is sealed:
   * a leading newline of the very first message, or inside an open one, is the reply's own.
   */
  private consumeSeam(tail: string): string {
    if (this.open || this.sealedText === '') return tail;
    const seam = /^\n+/.exec(tail)?.[0] ?? '';
    this.sealedText += seam;
    return tail.slice(seam.length);
  }

  /** Send (nothing open yet) or edit the open message in place. */
  private async write(text: string): Promise<void> {
    if (!this.open) {
      const ref = await this.sink.send(text);
      this.open = { ref, text, edits: 0 };
      return;
    }
    // Already on screen verbatim: happens when the text has outgrown this message, so the head
    // chunk is exactly what it already shows. Spending an edit from the budget to write the same
    // characters would be pure waste.
    if (this.open.text === text) return;
    await this.sink.edit(this.open.ref, text);
    this.open.text = text;
    this.open.edits++;
  }

  /**
   * Close the open message: its text joins the immutable delivered prefix and the next write starts
   * a new message. No-op when nothing is open.
   */
  private seal(): void {
    if (!this.open) return;
    this.sealedText += this.open.text;
    this.open = null;
  }

  private onWriteSuccess(): void {
    this.lastWriteAt = this.sink.now();
    this.currentBackoff = this.opts.flushIntervalMs; // reset backoff on success
    this.pausedUntil = 0;
  }

  /**
   * Rate limit / network: keep the message open and retry later, more slowly.
   *
   * Sets both the interval (how long) and the deadline (until when), because the two triggers in
   * maybeFlush need different shapes of the same answer.
   */
  private onTransientFailure(err: unknown): void {
    // A wait the platform NAMED is data, not a guess, so it overrides maxBackoffMs instead of
    // being capped by it. Telegram has answered `retry after 229`; against the 10 s default cap
    // the buffer would retry 22 times too early and re-earn the flood limit each time. The
    // separate maxRetryAfterMs ceiling keeps a nonsense value from wedging the buffer forever.
    const stated = retryAfterMsOf(err);
    this.currentBackoff =
      stated !== undefined
        ? Math.min(stated, this.opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS)
        : Math.min(this.currentBackoff * 2, this.opts.maxBackoffMs);
    this.pausedUntil = this.sink.now() + this.currentBackoff;
  }


  private splitIntoChunks(text: string): string[] {
    return splitByMeasure(text, this.opts.maxMessageLength, this.opts.measureLength);
  }
}

// ============================================================================
// smart chunking (pure: no side effects, no clock, no class state)
// ============================================================================

/** Fence line of a fenced code block, e.g. ``` or ```ts; captures the language tag. */
const FENCE_RE = /^[ \t]*```([^\n`]*)\s*$/;

interface Segment {
  kind: 'text' | 'code';
  /** Code block language tag (may be empty); always empty for text segments. */
  lang: string;
  /** Segment content: raw text for text; for code, the content between fences (no ``` lines). */
  content: string;
}

/**
 * Split text into ordered segments by fenced code block.
 * Content between paired ``` is a code segment (with its language tag); the rest
 * is text. A trailing unclosed ``` is also treated as a code segment.
 */
function parseSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];
  let inCode = false;
  let codeLang = '';

  const flushText = () => {
    if (buf.length) {
      segs.push({ kind: 'text', lang: '', content: buf.join('\n') });
      buf = [];
    }
  };
  const flushCode = () => {
    // Emit a code segment even when empty, to keep fences paired.
    segs.push({ kind: 'code', lang: codeLang, content: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (!inCode) {
        flushText();
        inCode = true;
        codeLang = (m[1] ?? '').trim();
      } else {
        flushCode();
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    buf.push(line);
  }
  if (inCode) flushCode();
  else flushText();
  return segs;
}

/** Max possible width of the `(i/total) ` label prefix (uses total as the upper bound for i). */
function labelWidth(total: number): number {
  const n = String(total).length;
  return `(${'9'.repeat(n)}/${'9'.repeat(n)}) `.length;
}

/**
 * How full a message must be for a cut to move back to a block boundary rather than take the last
 * line break. Three quarters: every message but the last is then at least 3/4 full, so a reply
 * costs at most a third more messages than the tightest packing — which matters where each message
 * spends quota (QQ passive replies, LINE push). The last quarter of a message is also where a
 * paragraph break almost always is (about 1000 chars on Telegram's 4096).
 */
const BLOCK_BREAK_MIN_FILL = 0.75;

/**
 * A line that titles what follows it: an ATX heading, or a line that is nothing but one bold span
 * (`**Option A: smallest change**`), which agents use as a heading just as often.
 */
function isTitleLine(line: string): boolean {
  return /^ {0,3}#{1,6}\s/.test(line) || /^\*\*[^*\n]+\*\*[:：]?$/.test(line.trim());
}

/** The line that ends at the newline `nl`, without it. */
function lineEndingAt(s: string, nl: number): string {
  return s.slice(s.lastIndexOf('\n', nl - 1) + 1, nl);
}

/** The line that starts at `from`, without its newline. */
function lineStartingAt(s: string, from: number): string {
  const end = s.indexOf('\n', from);
  return s.slice(from, end < 0 ? s.length : end);
}

/**
 * Find a natural break point for a text segment within [0, max].
 * Returns the cut index (cuts off [0, idx)), with 1 <= idx <= max.
 * Priority: block boundary > line break > any newline > space > hard cut.
 *
 * The last newline that fits used to win outright, which made the cut land wherever the budget
 * ran out: a four-item list went out as items 1–2 in one message and 3–4 in the next, and the
 * reader of the second message saw a list start at "3." with its heading out of sight. Now:
 *
 *   - A **block boundary** — a blank line or a title follows — is taken if it keeps the message
 *     at least BLOCK_BREAK_MIN_FILL full, so a list, a paragraph or a titled section stays whole
 *     when there is room to keep it so.
 *   - Otherwise the last **line break**.
 *   - Neither ever leaves a title as a message's last line, nor cuts inside a run of blank lines
 *     (the cut goes at the run's start, and the continuation drops the blank lines).
 *   - Only when every newline in the window breaks those rules does any newline do.
 */
function findTextBreak(s: string, max: number): number {
  if (s.length <= max) return s.length;
  const window = s.slice(0, max);
  const floor = Math.floor(max * BLOCK_BREAK_MIN_FILL);
  let lineBreak = -1;
  for (let at = window.lastIndexOf('\n'); at > 0; at = window.lastIndexOf('\n', at - 1)) {
    const before = lineEndingAt(s, at);
    if (before.trim() === '' || isTitleLine(before)) continue;
    const after = lineStartingAt(s, at + 1);
    if (at >= floor && (after.trim() === '' || isTitleLine(after))) return at;
    if (lineBreak < 0) lineBreak = at;
    // Below the floor no block boundary can qualify, and the latest line break is already found.
    if (at < floor) break;
  }
  if (lineBreak > 0) return lineBreak;
  const nl = window.lastIndexOf('\n');
  if (nl > 0) return nl;
  const sp = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
  if (sp > 0) return sp;
  // No natural boundary (e.g. one long token / contiguous CJK): hard-cut to max.
  return max;
}

/**
 * Smart chunking: split overlong outbound text to fit an IM per-message limit.
 *
 * Rules:
 *  1. text.length <= limit → return [text] unchanged.
 *  2. Overlong:
 *     - Never break a fenced code block; an overlong code block is cut at its
 *       internal line breaks, each slice re-closing/reopening the ``` fence
 *       (language tag preserved).
 *     - Non-code prefers newline breaks, then spaces, to avoid splitting words.
 *  3. withLabels=true prefixes each chunk with `(i/total)` (counted against the
 *     limit budget); default false emits multiple unlabeled messages.
 *
 * Pure: depends only on its arguments.
 */
export function splitIntoChunks(text: string, limit: number, withLabels = false): string[] {
  if (text.length <= limit) return [text];
  if (!withLabels) return packChunks(text, limit, 0); // no label: use the full budget
  const chunks = packWithStableLabels(text, limit);
  return chunks.length === 1
    ? chunks // unreachable (length <= limit handled above); defensive return.
    : chunks.map((c, i) => `(${i + 1}/${chunks.length}) ${c}`);
}

/**
 * Split so each chunk's RENDERED length (per `measure`) is <= `limit`.
 *
 * Why: the platform limit applies to the rendered output, but chunking happens on the RAW markdown
 * before the profile renders it. Rendering can expand the counted length (Telegram counts the
 * entity-parsed visible text, and table→bullets expands ~1.4x) or re-unit it (WeCom counts UTF-8
 * bytes). Chunking by raw chars against the limit therefore overflows on expanding content (this is
 * what `/context`'s table hit on Telegram).
 *
 * Strategy: split by chars first (cheap, fence-aware via splitIntoChunks), then re-split ONLY the
 * chunks whose measured render exceeds the limit, shrinking that chunk's char budget proportionally
 * until it fits. Non-expanding chunks keep the full budget, so capacity isn't wasted and shrinking
 * renderers (most plain text) never pay anything. `measure` defaults to identity (char length).
 */
export function splitByMeasure(
  text: string,
  limit: number,
  measure: (s: string) => number = (s) => s.length
): string[] {
  const out: string[] = [];
  for (const chunk of splitIntoChunks(text, limit)) {
    if (measure(chunk) <= limit) {
      out.push(chunk);
    } else {
      out.push(...resplitToFit(chunk, limit, measure));
    }
  }
  return out;
}

/**
 * Re-split one over-limit chunk until every part renders within `limit`. Each attempt shrinks the
 * char budget proportionally to the worst observed overshoot (budget · limit / worst), with a
 * guaranteed strict decrease so it always converges; capped attempts + a budget floor bound the
 * worst case (a pathological unbreakable token degrades to small char cuts, whose render is tiny).
 */
function resplitToFit(chunk: string, limit: number, measure: (s: string) => number): string[] {
  let budget = limit;
  let parts = [chunk];
  for (let attempt = 0; attempt < 8; attempt++) {
    let worst = 0;
    for (const p of parts) worst = Math.max(worst, measure(p));
    if (worst <= limit) return parts;
    const proportional = Math.floor((budget * limit) / worst);
    budget = Math.max(1, Math.min(budget - 1, proportional));
    if (budget < 1) break;
    parts = splitIntoChunks(chunk, budget);
  }
  return parts;
}

/**
 * Resolve the label-width ↔ chunk-count dependency: label `(i/total)` width
 * depends on total, which depends on how much budget the label reserves. Iterate
 * to a fixed point: cut, and if the actual chunk count widens the label, grow the
 * reserve and re-cut. Returns label-free content chunks.
 */
function packWithStableLabels(text: string, limit: number): string[] {
  let reserve = labelWidth(2); // start assuming at least 2 chunks
  for (let iter = 0; iter < 8; iter++) {
    const chunks = packChunks(text, limit, reserve);
    const needed = labelWidth(chunks.length);
    if (needed <= reserve || chunks.length <= 1) return chunks; // stable (or single chunk)
    reserve = needed; // label widened, grow reserve and re-cut
  }
  return packChunks(text, limit, reserve); // fallback (near-unreachable)
}

/**
 * With content budget = limit - reserve, split text into label-free chunks.
 * Each returned chunk (including fence completion) is <= limit - reserve.
 */
function packChunks(text: string, limit: number, reserve: number): string[] {
  const budget = Math.max(1, limit - reserve);
  const segs = parseSegments(text);
  const out: string[] = [];
  // The chunk currently being assembled (text content appended directly; code carries fences).
  let cur = '';

  const pushCur = () => {
    if (cur.length) {
      out.push(cur);
      cur = '';
    }
  };

  for (const seg of segs) {
    if (seg.kind === 'text') {
      let rest = seg.content;
      while (rest.length) {
        const room = budget - (cur.length ? cur.length + 1 : 0); // +1 for joining newline
        if (room <= 0) {
          pushCur();
          continue;
        }
        if (rest.length <= room && (cur.length === 0 || rest.length + cur.length + 1 <= budget)) {
          cur = cur.length ? cur + '\n' + rest : rest;
          rest = '';
        } else {
          const brk = findTextBreak(rest, room);
          const head = rest.slice(0, brk);
          cur = cur.length ? cur + '\n' + head : head;
          pushCur();
          // Skip the separator at the cut point to avoid leading whitespace: the whole run of newlines
          // when the cut is at a block boundary (it can sit before blank lines), else one space.
          rest = rest.slice(brk);
          if (rest[0] === '\n') rest = rest.replace(/^\n+/, '');
          else if (rest[0] === ' ' || rest[0] === '\t') rest = rest.slice(1);
        }
      }
    } else {
      // Code segment stands alone (eases fence balancing): flush text, then pack it.
      pushCur();
      for (const piece of packCodeSegment(seg, budget)) out.push(piece);
    }
  }
  pushCur();
  return out.length ? out : [''];
}

/**
 * Split one code segment into chunks each carrying paired fences, each <= budget.
 * Prefers code line boundaries; hard-cuts a single overlong line by characters
 * (fences always stay paired). Pure.
 */
function packCodeSegment(seg: Segment, budget: number): string[] {
  const out: string[] = [];
  const fenceOpen = '```' + seg.lang;
  const fenceClose = '```';
  const overhead = fenceOpen.length + 1 + 1 + fenceClose.length; // open\n + \nclose
  const codeBudget = Math.max(1, budget - overhead);

  let lineBuf: string[] = [];
  let bufLen = 0;
  const flush = () => {
    out.push(fenceOpen + '\n' + lineBuf.join('\n') + '\n' + fenceClose);
    lineBuf = [];
    bufLen = 0;
  };

  for (const line of seg.content.split('\n')) {
    const addLen = (lineBuf.length ? 1 : 0) + line.length; // +1 inter-line newline
    if (bufLen + addLen <= codeBudget) {
      lineBuf.push(line);
      bufLen += addLen;
      continue;
    }
    // Doesn't fit: flush the buffer, then handle this line (hard-cut if too long).
    if (lineBuf.length) flush();
    let l = line;
    while (l.length > codeBudget) {
      out.push(fenceOpen + '\n' + l.slice(0, codeBudget) + '\n' + fenceClose);
      l = l.slice(codeBudget);
    }
    if (l.length) {
      lineBuf.push(l);
      bufLen = l.length;
    }
  }
  // Emit a (possibly empty) code block to keep fences paired.
  flush();
  return out;
}
