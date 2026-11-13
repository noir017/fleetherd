import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RotatingLog, teeStream, installDaemonLog, type WritableLike } from './log-file.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-log-'));
const at = new Date('2026-11-13T09:00:00.000Z');

describe('RotatingLog', () => {
  it('timestamps complete lines and holds a partial one until its newline', () => {
    const dir = tmp();
    const log = new RotatingLog(path.join(dir, 'daemon.log'), 1_000, 3, () => at);
    log.write('[turn] a starting turn\n[turn] b ');
    log.write('starting turn\n');
    log.close();

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
    for (const n of ['one', 'two', 'three', 'four', 'five']) log.write(`${n}\n`);
    log.close();

    expect(fs.readdirSync(dir).sort()).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toContain('one');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('three');
    expect(fs.readFileSync(file, 'utf8')).toContain('five');
  });

  it('appends to an existing file and counts its size', () => {
    const dir = tmp();
    const file = path.join(dir, 'daemon.log');
    fs.writeFileSync(file, 'x'.repeat(140));
    const log = new RotatingLog(file, 150, 2, () => at);
    log.write('one\n');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(140));
  });
});

describe('teeStream', () => {
  it('writes to the stream and the log, and restores the stream on dispose', () => {
    const dir = tmp();
    const log = new RotatingLog(path.join(dir, 'daemon.log'), 1_000, 3, () => at);
    const seen: string[] = [];
    const stream: WritableLike = {
      write(chunk: string | Uint8Array): boolean {
        seen.push(String(chunk));
        return true;
      },
    };
    const restore = teeStream(stream, log);
    stream.write('hello\n');
    restore();
    stream.write('after\n');
    log.close();

    expect(seen).toEqual(['hello\n', 'after\n']);
    expect(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8')).toBe(
      '[2026-11-13T09:00:00.000Z] hello\n'
    );
  });

  it('a failing sink never breaks the stream', () => {
    const seen: string[] = [];
    const stream: WritableLike = {
      write(chunk: string | Uint8Array): boolean {
        seen.push(String(chunk));
        return true;
      },
    };
    const restore = teeStream(stream, {
      write() {
        throw new Error('disk full');
      },
    });
    expect(() => stream.write('still here\n')).not.toThrow();
    restore();
    expect(seen).toEqual(['still here\n']);
  });
});

describe('installDaemonLog', () => {
  it('writes what the process prints and stops when restored', () => {
    const dir = tmp();
    const restore = installDaemonLog(dir);
    try {
      // console.log is captured by the test runner; the tee sits under process.stdout itself.
      process.stdout.write('to both\n');
    } finally {
      restore();
    }
    expect(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8')).toContain('to both');
  });

  it('is a no-op when the directory cannot be created', () => {
    const dir = tmp();
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(() => installDaemonLog(path.join(file, 'logs'))()).not.toThrow();
  });
});
