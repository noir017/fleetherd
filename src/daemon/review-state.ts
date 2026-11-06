import fs from 'node:fs';
import path from 'node:path';

/**
 * What the review sweep remembers between runs (`<configDir>/reviews.json`).
 *
 * One thing: per conversation, the id of the last message a review saw. A review reads what came
 * AFTER it, so "the person said three things since the last review" is one integer comparison, and
 * a gateway restart does not review the same conversation again. There is no daily counter: this
 * watermark is the only thing that stops a conversation from being reviewed twice.
 *
 * A failed run keeps the watermark where it was and records a retry time: the conversation will
 * be reviewed again later, but a broken reviewer is not retried every minute. A batch that keeps
 * failing is abandoned after three attempts (`gaveUp` moves the watermark past it), so an
 * exhausted reviewer cannot retry the same messages forever.
 *
 * A failure that is the provider having no capacity for the model is different: the review never
 * really ran, so it does not count toward those three attempts and waits one hour instead of six
 * (`failed(..., 'capacity')`). A bare timeout is included in that, because agy has no give-up
 * limit and a killed run leaves no cause to read; the mark records `capacity: true` so the sweep
 * can put a conversation that keeps hitting this behind fresh work instead of at its head. The
 * exemption is capped at REVIEW_CAPACITY_MAX_ATTEMPTS in a row: past that, a failure that still
 * looks like capacity counts like any other, so a permanent fault cannot hide behind it forever.
 *
 * A mark that cannot be written to disk is kept in memory for this process. That is the second
 * half of the same guarantee: with no daily cap, a full disk would otherwise leave the watermark
 * unchanged and the sweep would review the same conversation on the next minute, forever.
 *
 * The file is 0600 like everything else beside it. A missing or unreadable file degrades to empty
 * — the cost is one repeated review, never a daemon that will not start.
 */

export interface ReviewMark {
  /** The newest message id the last successful review saw. */
  messageId: number;
  /** When that review finished. */
  at: string;
  /** The last attempt, successful or not. */
  attemptAt?: string;
  /** Do not try again before this. Set by a failure. */
  retryAt?: string;
  /** Consecutive failures on the current batch. Reset by a review or a give-up. */
  attempts?: number;
  /**
   * The last failure was the provider refusing for lack of capacity. It did not count toward
   * `attempts`. Cleared by a review and by a give-up; absent in files written before this field
   * existed, which reads as an ordinary failure — the behaviour those files were written under.
   */
  capacity?: boolean;
  /**
   * Consecutive capacity failures since the last real attempt or review. Counted even once the
   * cap has been reached, so the next capacity failure still counts. Absent means no streak.
   */
  capacityAttempts?: number;
  /** Why the last attempt failed, for the log line. */
  error?: string;
}

/**
 * Version 1 is still the on-disk shape; `capacity` and `capacityAttempts` are optional additions,
 * so a file from before them (or a reader that does not know them) is unaffected. A file written
 * before the daily cap was removed also carries `day` and `count`; they are ignored when reading
 * and dropped on the next write.
 */
interface ReviewFile {
  version: 1;
  conversations: Record<string, ReviewMark>;
}

/** How long a failed review waits before the same conversation is tried again. */
export const REVIEW_RETRY_MS = 6 * 3_600_000;

/**
 * How long a review that found no capacity waits. A capacity drought was measured at 10–20
 * minutes (2026-11-05/06), so an hour is clear of one; retrying sooner would spend the single
 * review lane on the same unavailable model while other conversations wait.
 */
export const REVIEW_CAPACITY_RETRY_MS = 3_600_000;

/**
 * Consecutive capacity failures that may skip the attempt count. Each one waits an hour and can
 * spend up to the 30-minute review timeout, so twelve span about 18 hours at worst — long enough
 * for a real drought, short enough that a hang or a permanent fault which keeps producing
 * capacity-looking failures still runs into REVIEW_MAX_ATTEMPTS instead of retrying forever.
 */
export const REVIEW_CAPACITY_MAX_ATTEMPTS = 12;

function empty(): ReviewFile {
  return { version: 1, conversations: {} };
}

function clipped(error: string): string {
  return error.length > 300 ? `${error.slice(0, 299)}…` : error;
}

export interface ReviewFailure {
  /** Consecutive counted failures on this batch. */
  attempts: number;
  /** False when the failure was capacity and did not count. */
  counted: boolean;
}

export class ReviewStateStore {
  /** Marks whose write failed; `markOf` prefers them over what is still on disk. */
  private readonly unpersisted = new Map<string, ReviewMark>();

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {}

  /** One conversation's mark, or undefined when it has never been reviewed. */
  markOf(key: string): ReviewMark | undefined {
    return this.unpersisted.get(key) ?? this.read().conversations[key];
  }

  /** A successful review: move the watermark, clear any retry and the attempt count. */
  reviewed(key: string, messageId: number, now = Date.now()): void {
    this.save(key, { messageId, at: new Date(now).toISOString(), attemptAt: new Date(now).toISOString() });
  }

  /**
   * A failed review: keep the watermark, wait before trying again. Returns the counted attempts on
   * this batch, which the caller uses to decide when to give up, and whether this failure counted.
   *
   * A `capacity` failure is the provider refusing the model, not the reviewer failing: the wait is
   * shorter and the attempt count does not move, so a drought can never exhaust the batch. That
   * exemption stops after REVIEW_CAPACITY_MAX_ATTEMPTS in a row: from then on the same failure is
   * recorded as an ordinary one (six hours, counted), which is the only way a permanent fault that
   * keeps looking like capacity can still be given up on.
   */
  failed(key: string, error: string, now = Date.now(), kind: 'attempt' | 'capacity' = 'attempt'): ReviewFailure {
    const previous = this.markOf(key);
    const streak = kind === 'capacity' ? (previous?.capacityAttempts ?? 0) + 1 : 0;
    const capacity = kind === 'capacity' && streak <= REVIEW_CAPACITY_MAX_ATTEMPTS;
    const attempts = (previous?.attempts ?? 0) + (capacity ? 0 : 1);
    const mark: ReviewMark = {
      messageId: previous?.messageId ?? 0,
      at: previous?.at ?? new Date(now).toISOString(),
      attemptAt: new Date(now).toISOString(),
      retryAt: new Date(now + (capacity ? REVIEW_CAPACITY_RETRY_MS : REVIEW_RETRY_MS)).toISOString(),
      error: clipped(error),
      attempts,
    };
    // Not written for an ordinary failure: a later review or give-up clears it, and a capacity
    // flag left over from an earlier attempt would keep the conversation at the back of the queue.
    if (capacity) mark.capacity = true;
    // Kept after the cap is crossed, so the next capacity failure is past it too. A non-capacity
    // failure starts a new streak, because the failures are no longer consecutive.
    if (kind === 'capacity') mark.capacityAttempts = streak;
    this.save(key, mark);
    return { attempts, counted: !capacity };
  }

  /**
   * Give up on the current batch: move the watermark past it so only messages that arrive later
   * can start another review, and clear the retry. The error is kept for the record's sake;
   * nothing about scheduling reads it.
   */
  gaveUp(key: string, messageId: number, error: string, now = Date.now()): void {
    this.save(key, {
      messageId,
      at: new Date(now).toISOString(),
      attemptAt: new Date(now).toISOString(),
      error: clipped(error),
    });
  }

  /** Whether a failure's back-off has passed. */
  ready(key: string, now = Date.now()): boolean {
    const retryAt = this.markOf(key)?.retryAt;
    return !retryAt || Date.parse(retryAt) <= now;
  }

  /**
   * Store one mark. A write that fails is not fatal — the mark lives in memory until the file can
   * be written again, and the sweep treats the conversation as seen either way.
   */
  private save(key: string, mark: ReviewMark): void {
    const data = this.read();
    data.conversations[key] = mark;
    if (this.write(data)) this.unpersisted.delete(key);
    else this.unpersisted.set(key, mark);
  }

  private read(): ReviewFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ReviewFile>;
      if (parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== 'object') {
        this.log(`[review] ${this.file} is not a version-1 review file; starting its records over`);
        return empty();
      }
      return { version: 1, conversations: parsed.conversations };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[review] could not read ${this.file}: ${e instanceof Error ? e.message : e}`);
      }
      return empty();
    }
  }

  private write(data: ReviewFile): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log(`[review] could not write ${this.file}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}
