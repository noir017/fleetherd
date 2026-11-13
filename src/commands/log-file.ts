import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
/** A line longer than this is written whole rather than buffered forever. */
const MAX_LINE = 64 * 1024;

export interface LogSink {
  /** One line, without its newline. */
  append(line: string): void;
}

/**
 * Append-only log with size rotation: `file`, then `file.1` … `file.<maxFiles-1>`.
 *
 * Synchronous on purpose. Log volume is a few lines per message, and a write that is still in a
 * stream buffer when the process is killed is exactly the line a crash investigation wants. A
 * failed write or rotation disables the file (loudly, once) rather than throwing into the daemon's
 * logging — and rather than leaving a size counter that no longer matches the file.
 */
export class RotatingLog implements LogSink {
  private size: number;
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly maxFiles = MAX_FILES,
    private readonly now: () => Date = () => new Date()
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // A file created by an older build (or by hand) is not necessarily 0600; the log can hold
    // whatever the daemon printed, including a path or a host name.
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Not there yet — appendFileSync creates it with the mode below.
    }
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  append(line: string): void {
    this.appendText(`[${this.now().toISOString()}] ${line}\n`);
  }

  private appendText(text: string): void {
    if (this.broken) return;
    const bytes = Buffer.byteLength(text);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes && !this.rotate()) return;
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      this.size += bytes;
    } catch (e) {
      this.fail(e);
    }
  }

  /** True when the files now start empty at `file`; false when a rename failed and writing stops. */
  private rotate(): boolean {
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try {
        fs.renameSync(from, to);
      } catch (e) {
        // Missing is the normal case for the older slots on the first rotations.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.fail(e);
        return false;
      }
    }
    this.size = 0;
    return true;
  }

  private fail(e: unknown): void {
    if (this.broken) return;
    this.broken = true;
    // console.error writes to the stream this file is teeing, but append() returns at once now
    // that `broken` is set, and the stream itself still gets the line.
    console.error(`[log] ${this.file}: ${e instanceof Error ? e.message : e} — the daemon's log file is off`);
  }
}

/** The bit of a writable stream the tee needs; `process.stdout` and `process.stderr` are ones. */
export interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

/**
 * Send everything written to `stream` to `log` as well, and return a function that undoes it and
 * flushes the last, unterminated line.
 *
 * Each stream keeps its own buffer and its own `StringDecoder`: stdout and stderr interleave, and
 * two half-lines must never be glued together. The decoder is what keeps a multi-byte character
 * split across two chunks (agent-acp forwards the harness's stdout as arbitrary Buffers) from
 * turning into U+FFFD.
 */
export function teeStream(stream: WritableLike, log: LogSink): () => void {
  const original = stream.write.bind(stream);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const take = (text: string): void => {
    pending += text;
    for (;;) {
      const cut = pending.indexOf('\n');
      if (cut < 0) break;
      log.append(pending.slice(0, cut).replace(/\r$/, ''));
      pending = pending.slice(cut + 1);
    }
    if (pending.length >= MAX_LINE) {
      log.append(pending);
      pending = '';
    }
  };
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const result = (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    try {
      take(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk)));
    } catch {
      // The sink owns its own failure handling; logging must never break the daemon.
    }
    return result;
  }) as WritableLike['write'];
  return () => {
    stream.write = original as WritableLike['write'];
    try {
      const tail = pending + decoder.end();
      if (tail !== '') log.append(tail.replace(/\r$/, ''));
    } catch {
      // Same rule on the way out.
    }
    pending = '';
  };
}

/**
 * Start the file copy at `<dir>/daemon.log`. Returns a flush-and-restore function (also worth
 * registering on `process.once('exit')`, which is where a daemon stopped by a signal ends up).
 * A directory that cannot be written yields a no-op: a gateway on a read-only config volume still
 * has to start.
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
  let done = false;
  return () => {
    if (done) return;
    done = true;
    restoreOut();
    restoreErr();
  };
}
