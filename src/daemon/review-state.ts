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
 * be reviewed again later, but a broken reviewer is not retried every minute.
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
  /** Why the last attempt failed, for the log line. */
  error?: string;
}

/**
 * Version 1 is still the on-disk shape. A file written before the daily cap was removed also
 * carries `day` and `count`; they are ignored when reading and dropped on the next write.
 */
interface ReviewFile {
  version: 1;
  conversations: Record<string, ReviewMark>;
}

/** How long a failed review waits before the same conversation is tried again. */
export const REVIEW_RETRY_MS = 6 * 3_600_000;

function empty(): ReviewFile {
  return { version: 1, conversations: {} };
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

  /** A successful review: move the watermark and clear any retry. */
  reviewed(key: string, messageId: number, now = Date.now()): void {
    this.save(key, { messageId, at: new Date(now).toISOString(), attemptAt: new Date(now).toISOString() });
  }

  /** A failed review: keep the watermark, wait before trying again. */
  failed(key: string, error: string, now = Date.now()): void {
    const previous = this.markOf(key);
    this.save(key, {
      messageId: previous?.messageId ?? 0,
      at: previous?.at ?? new Date(now).toISOString(),
      attemptAt: new Date(now).toISOString(),
      retryAt: new Date(now + REVIEW_RETRY_MS).toISOString(),
      error: error.length > 300 ? `${error.slice(0, 299)}…` : error,
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
