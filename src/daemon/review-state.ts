import fs from 'node:fs';
import path from 'node:path';

/**
 * What the review sweep remembers between runs (`<configDir>/reviews.json`).
 *
 * Two things, both small:
 *  - per conversation, the id of the last message a review saw. A review reads what came AFTER
 *    it, so "the person said three things since the last review" is one integer comparison, and a
 *    gateway restart does not review the same conversation again;
 *  - one counter per UTC day, so a bug that keeps finding candidates cannot spend a day's worth
 *    of the reviewer's quota in a minute.
 *
 * A failed run keeps the watermark where it was and records a retry time: the conversation will
 * be reviewed again later, but a broken reviewer is not retried every minute.
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
  /** Why the last attempt failed, for the log line. */
  error?: string;
}

interface ReviewFile {
  version: 1;
  conversations: Record<string, ReviewMark>;
  /** UTC date (`YYYY-MM-DD`) the counter belongs to. */
  day: string;
  count: number;
}

/** How long a failed review waits before the same conversation is tried again. */
export const REVIEW_RETRY_MS = 6 * 3_600_000;

function empty(): ReviewFile {
  return { version: 1, conversations: {}, day: '', count: 0 };
}

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class ReviewStateStore {
  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {}

  /** One conversation's mark, or undefined when it has never been reviewed. */
  markOf(key: string): ReviewMark | undefined {
    return this.read().conversations[key];
  }

  /** A successful review: move the watermark and clear any retry. */
  reviewed(key: string, messageId: number, now = Date.now()): void {
    const data = this.read();
    data.conversations[key] = { messageId, at: new Date(now).toISOString(), attemptAt: new Date(now).toISOString() };
    this.write(data);
  }

  /** A failed review: keep the watermark, wait before trying again. */
  failed(key: string, error: string, now = Date.now()): void {
    const data = this.read();
    const previous = data.conversations[key];
    data.conversations[key] = {
      messageId: previous?.messageId ?? 0,
      at: previous?.at ?? new Date(now).toISOString(),
      attemptAt: new Date(now).toISOString(),
      retryAt: new Date(now + REVIEW_RETRY_MS).toISOString(),
      error: error.length > 300 ? `${error.slice(0, 299)}…` : error,
    };
    this.write(data);
  }

  /** Whether a failure's back-off has passed. */
  ready(key: string, now = Date.now()): boolean {
    const retryAt = this.markOf(key)?.retryAt;
    return !retryAt || Date.parse(retryAt) <= now;
  }

  /** Today's used reviews. */
  countToday(now = Date.now()): number {
    const data = this.read();
    return data.day === dayOf(now) ? data.count : 0;
  }

  /**
   * Claim one review from today's budget. Returns false when it is gone — the caller stops the
   * sweep rather than logging once per remaining conversation.
   */
  takeSlot(limit: number, now = Date.now()): boolean {
    const data = this.read();
    const day = dayOf(now);
    if (data.day !== day) {
      data.day = day;
      data.count = 0;
    }
    if (data.count >= limit) return false;
    data.count += 1;
    this.write(data);
    return true;
  }

  private read(): ReviewFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ReviewFile>;
      if (parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== 'object') {
        this.log(`[review] ${this.file} is not a version-1 review file; starting its records over`);
        return empty();
      }
      return {
        version: 1,
        conversations: parsed.conversations,
        day: typeof parsed.day === 'string' ? parsed.day : '',
        count: typeof parsed.count === 'number' ? parsed.count : 0,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[review] could not read ${this.file}: ${e instanceof Error ? e.message : e}`);
      }
      return empty();
    }
  }

  private write(data: ReviewFile): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[review] could not write ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
