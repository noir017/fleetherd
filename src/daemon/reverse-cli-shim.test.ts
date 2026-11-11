import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureReverseCliShim, isCliEntry } from './reverse-cli-shim.js';

/**
 * The shim is written to a SHARED user path (`~/.config/fleetherd/bin`), which is what makes
 * getting it wrong expensive: that directory leads the PATH of every agent the running daemon
 * spawns, so a bad shim breaks `send-message` / `ask` / `send-file` for every live conversation at
 * once — including conversations belonging to a daemon this process has nothing to do with.
 *
 * Which is exactly what happened: `argv[1]` in a vitest worker is tinypool's worker entry, so
 * running the test suite rewrote the shim of the daemon serving this machine to point at it, and
 * every reverse command started failing with a stack from inside tinypool.
 */
describe('isCliEntry', () => {
  it('accepts the three real launch shapes', () => {
    expect(isCliEntry('/usr/bin/fleetherd')).toBe(true); // global install (a symlink)
    expect(isCliEntry('/usr/bin/talkcode')).toBe(true); // the same, by its name before 3.0.0
    expect(isCliEntry('/app/dist/cli.js')).toBe(true); // node dist/cli.js
    expect(isCliEntry('/home/u/src/cli.ts')).toBe(true); // tsx src/cli.ts
  });

  it('rejects a test runner’s worker entry — the regression', () => {
    expect(isCliEntry('/repo/node_modules/tinypool/dist/entry/process.js')).toBe(false);
  });

  it('rejects anything else that merely happens to be running this code', () => {
    expect(isCliEntry('/usr/lib/node_modules/npm/bin/npm-cli.js')).toBe(false);
    expect(isCliEntry('')).toBe(false);
    expect(isCliEntry('/repo/scripts/release.mjs')).toBe(false);
  });
});

describe('ensureReverseCliShim', () => {
  let dir: string;
  let savedArgv1: string | undefined;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-shim-'));
    savedArgv1 = process.argv[1];
    savedConfigDir = process.env.FLEETHERD_CONFIG_DIR;
    process.env.FLEETHERD_CONFIG_DIR = dir;
  });

  afterEach(() => {
    process.argv[1] = savedArgv1 as string;
    if (savedConfigDir === undefined) delete process.env.FLEETHERD_CONFIG_DIR;
    else process.env.FLEETHERD_CONFIG_DIR = savedConfigDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const shimPath = (): string => path.join(dir, 'bin', 'fleetherd');

  it('writes an executable shim re-executing this runtime when launched as the CLI', () => {
    process.argv[1] = '/app/dist/cli.js';

    const out = ensureReverseCliShim();

    expect(out).toBe(path.join(dir, 'bin'));
    const script = fs.readFileSync(shimPath(), 'utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain("'/app/dist/cli.js'");
    expect(fs.statSync(shimPath()).mode & 0o111).toBeTruthy();
  });

  it('writes the same shim as `talkcode`, the command an agent learned before 3.0.0', () => {
    process.argv[1] = '/app/dist/cli.js';
    ensureReverseCliShim();
    const legacy = path.join(dir, 'bin', 'talkcode');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(fs.readFileSync(shimPath(), 'utf8'));
    expect(fs.statSync(legacy).mode & 0o111).toBeTruthy();
  });

  it('regression: writes NOTHING when argv[1] is not this CLI', () => {
    process.argv[1] = '/repo/node_modules/tinypool/dist/entry/process.js';

    expect(ensureReverseCliShim()).toBeNull();
    expect(fs.existsSync(shimPath())).toBe(false);
    expect(fs.existsSync(path.join(dir, 'bin', 'talkcode'))).toBe(false);
  });

  it('regression: leaves an existing good shim alone rather than clobbering it', () => {
    // The damaging case is not the first write — it is a test run overwriting the shim a real
    // daemon put there. Refusing to guess has to mean refusing to TOUCH it.
    process.argv[1] = '/usr/bin/fleetherd';
    ensureReverseCliShim();
    const good = fs.readFileSync(shimPath(), 'utf8');

    process.argv[1] = '/repo/node_modules/tinypool/dist/entry/process.js';
    expect(ensureReverseCliShim()).toBeNull();
    expect(fs.readFileSync(shimPath(), 'utf8')).toBe(good);
  });

  it('is idempotent: a second call with the same entry rewrites nothing', () => {
    process.argv[1] = '/app/dist/cli.js';
    ensureReverseCliShim();
    const first = fs.statSync(shimPath()).mtimeMs;

    ensureReverseCliShim();
    expect(fs.readFileSync(shimPath(), 'utf8')).toContain("'/app/dist/cli.js'");
    expect(fs.statSync(shimPath()).mtimeMs).toBe(first);
  });
});
