import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RotatingLog, teeStream, installDaemonLog, type WritableLike } from './log-file.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-log-'));
const at = new Date('2026-11-13T09:00:00.000Z');
const fakeStream = (): WritableLike & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    write(chunk: string | Uint8Array): boolean {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  };
};

describe('RotatingLog', () => {
  it('timestamps every line it is given', () => {
    const dir = tmp();
    const log = new RotatingLog(path.join(dir, 'daemon.log'), 1_000, 3, () => at);
    log.append('[turn] a starting turn');
    log.append('[turn] b starting turn');

    expect(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8')).toBe(
      '[2026-11-13T09:00:00.000Z] [turn] a starting turn\n' +
        '[2026-11-13T09:00:00.000Z] [turn] b starting turn\n'
    );
  });

  it('rotates by size, keeps the newest files and drops the oldest', () => {
    const dir = tmp();
    const file = path.join(dir, 'daemon.log');
    // Each stamped line is 31 bytes: two fit in 70, so every third line rotates.
    const log = new RotatingLog(file, 70, 3, () => at);
    for (const n of ['one', 'two', 'three', 'four', 'five']) log.append(n);

    expect(fs.readdirSync(dir).sort()).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toContain('one');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('three');
    expect(fs.readFileSync(file, 'utf8')).toContain('five');
  });

  it('appends to an existing file, counts its size and makes it 0600', () => {
    const dir = tmp();
    const file = path.join(dir, 'daemon.log');
    fs.writeFileSync(file, 'x'.repeat(140), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const log = new RotatingLog(file, 150, 2, () => at);
    log.append('one');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(140));
  });

  it('stops writing when a rotation cannot rename, instead of growing the file forever', () => {
    const dir = tmp();
    const file = path.join(dir, 'daemon.log');
    fs.writeFileSync(file, 'x'.repeat(140));
    // The slot the rename targets is a non-empty directory: rename fails even for root.
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, 'keep'), '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const log = new RotatingLog(file, 150, 2, () => at);
      log.append('one'); // would rotate
      log.append('two'); // must be a no-op now
      expect(fs.readFileSync(file, 'utf8')).toBe('x'.repeat(140));
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("the daemon's log file is off"));
    } finally {
      errors.mockRestore();
    }
  });
});

describe('teeStream', () => {
  it('keeps stdout and stderr half-lines apart', () => {
    const lines: string[] = [];
    const sink = { append: (line: string) => lines.push(line) };
    const out = fakeStream();
    const err = fakeStream();
    const restoreOut = teeStream(out, sink);
    const restoreErr = teeStream(err, sink);
    out.write('a');
    err.write('b');
    out.write('1\n');
    err.write('2\n');
    restoreOut();
    restoreErr();

    expect(lines).toEqual(['a1', 'b2']);
  });

  it('decodes a multi-byte character split across Buffer chunks', () => {
    const lines: string[] = [];
    const out = fakeStream();
    const restore = teeStream(out, { append: (line: string) => lines.push(line) });
    const bytes = Buffer.from('你好\n');
    out.write(bytes.subarray(0, 2)); // the first character is three bytes
    out.write(bytes.subarray(2));
    restore();

    expect(lines).toEqual(['你好']);
  });

  it('flushes a final line that never got its newline', () => {
    const lines: string[] = [];
    const out = fakeStream();
    const restore = teeStream(out, { append: (line: string) => lines.push(line) });
    out.write('tail');
    restore();
    expect(lines).toEqual(['tail']);
  });

  it('a failing sink never breaks the stream', () => {
    const stream = fakeStream();
    const restore = teeStream(stream, {
      append() {
        throw new Error('disk full');
      },
    });
    expect(() => stream.write('still here\n')).not.toThrow();
    restore();
    expect(stream.seen).toEqual(['still here\n']);
  });
});

describe('installDaemonLog', () => {
  it('writes what the process prints and flushes when restored', () => {
    const dir = tmp();
    const restore = installDaemonLog(dir);
    try {
      // console.log is captured by the test runner; the tee sits under process.stdout itself.
      process.stdout.write('to both\n');
      process.stdout.write('no newline');
    } finally {
      restore();
    }
    const log = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8');
    expect(log).toContain('to both');
    expect(log).toContain('no newline');
  });

  it('is a no-op when the directory cannot be created', () => {
    const dir = tmp();
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(() => installDaemonLog(path.join(file, 'logs'))()).not.toThrow();
  });
});
