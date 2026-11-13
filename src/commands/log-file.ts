import fs from 'node:fs';
import path from 'node:path';

/**
 * The daemon's own log file, under the config directory.
 *
 * `docker logs` is the daemon's log and stays so, but a container recreated for an update takes
 * its json-file log with it — and the incidents that most need a log are the ones around a
 * restart. On 2026-11-11 a crash and an update cut turns off and the account of both was gone with
 * the container; the next week's research could only reconstruct it from history.db and the host
 * wrapper's update.log. The config directory is a volume (docs/docker.md), so a second copy written
 * there outlives the container, and it is written by the daemon itself: no compose change, no extra
 * sidecar, nothing for the operator to do beyond updating.
 *
 * Size-bounded because nobody rotates it by hand: five files of 10 MB. The docker driver keeps its
 * own five files of 20 MB, so the two copies together are capped at 150 MB.
 */

/** Bytes in one file before it rotates. */
const MAX_BYTES = 10 * 1024 * 1024;
/** Files kept, the current one included: daemon.log, daemon.log.1 … daemon.log.4. */
const MAX_FILES = 5;
/** A line longer than this is written with one timestamp rather than buffered forever. */
const MAX_PENDING = 64 * 1024;

export interface LogSink {
  write(text: string): void;
}

/**
 * Append-only log with size rotation: `file`, then `file.1` … `file.<maxFiles-1>`.
 *
 * Synchronous on purpose. Log volume is a few lines per message, and a write that is still in a
 * stream buffer when the process is killed is exactly the line a crash investigation wants. A
 * failed write disables the file (loudly, once) rather than throwing into the daemon's logging.
 */
export class RotatingLog implements LogSink {
  private size: number;
  private pending = '';
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly maxFiles = MAX_FILES,
    private readonly now: () => Date = () => new Date()
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(text: string): void {
    if (this.broken || text === '') return;
    this.pending += text;
    // Console output is one line per call; a stack trace or a chunked write is not. Timestamp
    // complete lines and keep the tail until its newline arrives.
    const cut = this.pending.lastIndexOf('\n');
    if (cut < 0) {
      if (this.pending.length < MAX_PENDING) return;
      this.append(this.stamp(this.pending, true));
      this.pending = '';
      return;
    }
    const complete = this.pending.slice(0, cut + 1);
    this.pending = this.pending.slice(cut + 1);
    this.append(this.stamp(complete, false));
  }

  /** The tail of a line still waiting for its newline, on the way out. */
  close(): void {
    if (this.pending !== '') {
      this.append(this.stamp(this.pending, true));
      this.pending = '';
    }
  }

  private stamp(text: string, unterminated: boolean): string {
    const at = this.now().toISOString();
    const body = unterminated ? text : text.slice(0, -1); // the final newline, if any
    return body
      .split('\n')
      .map((line) => `[${at}] ${line}\n`)
      .join('');
  }

  private append(text: string): void {
    if (this.broken || text === '') return;
    const bytes = Buffer.byteLength(text);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      this.size += bytes;
    } catch (e) {
      this.broken = true;
      // console.error writes to the stream this file is teeing, but write() returns at once now
      // that `broken` is set, and the stream itself still gets the line.
      console.error(`[log] ${this.file}: ${e instanceof Error ? e.message : e} — the daemon's log file is off`);
    }
  }

  private rotate(): void {
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try {
        fs.renameSync(from, to);
      } catch {
        // Missing (first rotation) or unrenamable: the next append still has to happen.
      }
    }
    this.size = 0;
  }
}

/** The bit of a writable stream the tee needs; `process.stdout` and `process.stderr` are ones. */
export interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

/**
 * Send everything written to `stream` to `log` as well, and return a function that undoes it.
 * The stream's own write happens first, so a broken log never delays or swallows the console.
 */
export function teeStream(stream: WritableLike, log: LogSink): () => void {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const result = (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    try {
      log.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    } catch {
      // The sink owns its own failure handling; logging must never break the daemon.
    }
    return result;
  }) as WritableLike['write'];
  return () => {
    stream.write = original as WritableLike['write'];
  };
}

/**
 * Start the file copy at `<dir>/daemon.log`. Returns a no-op when the directory cannot be written:
 * a gateway whose config volume is read-only still has to start.
 */
export function installDaemonLog(dir: string): () => void {
  let log: RotatingLog;
  try {
    log = new RotatingLog(path.join(dir, 'daemon.log'));
  } catch (e) {
    console.error(`[log] cannot write ${dir}: ${e instanceof Error ? e.message : e} — logging to stdout only`);
    return () => {};
  }
  const restoreOut = teeStream(process.stdout, log);
  const restoreErr = teeStream(process.stderr, log);
  return () => {
    restoreOut();
    restoreErr();
    log.close();
  };
}
