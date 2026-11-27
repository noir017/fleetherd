import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Every test file runs with a HOME and TMPDIR of its own. Code under test reaches for the home directory
 * without being handed one — an agent without `cwd` gets `~/.fleetherd/agents/<id>` made for it
 * (agent-common.ts resolveAgentCwd) — and the suite is run on machines whose home is live: a
 * gateway's config, a host's `~/.fleetherd`. Found 2026-11-11, when three daemon tests made
 * `~/.fleetherd/agents/{oc,cc}` on a host still on `~/.talkcode`, which would have stopped that
 * host's directory from being moved to the new name on the gateway's next connection.
 *
 * Giving each test file a short per-file root (`f-XXXXXX`) holding `h` (HOME) and `t` (TMPDIR/TMP/TEMP)
 * also ensures everything created under `os.tmpdir()` is removed in `afterAll` even when individual
 * tests forget to clean up, while keeping Unix socket paths well under the 108-byte sun_path limit.
 *
 * Under `isolate: false` the worker process is reused across files, so the original base tmpdir and
 * env vars are captured once on `globalThis` and restored in `afterAll`.
 *
 * The pool is `forks`, so this reaches os.homedir() and os.tmpdir() (a worker thread's process.env
 * would not). Tests that need a particular home still set HOME themselves, as before.
 */
const BASE_ENV_KEY = Symbol.for('fleetherd.test.baseEnv');

interface BaseTestEnv {
  tmpDir: string;
  HOME: string | undefined;
  TMPDIR: string | undefined;
  TMP: string | undefined;
  TEMP: string | undefined;
}

const globalStore = globalThis as Record<symbol, BaseTestEnv | undefined>;
const baseEnv: BaseTestEnv =
  globalStore[BASE_ENV_KEY] ??
  (globalStore[BASE_ENV_KEY] = {
    tmpDir: os.tmpdir(),
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  });

const root = fs.mkdtempSync(path.join(baseEnv.tmpDir, 'f-'));
const home = path.join(root, 'h');
const tmp = path.join(root, 't');
fs.mkdirSync(home);
fs.mkdirSync(tmp);

process.env.HOME = home;
process.env.TMPDIR = tmp;
process.env.TMP = tmp;
process.env.TEMP = tmp;

function restoreEnv(key: 'HOME' | 'TMPDIR' | 'TMP' | 'TEMP', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  restoreEnv('HOME', baseEnv.HOME);
  restoreEnv('TMPDIR', baseEnv.TMPDIR);
  restoreEnv('TMP', baseEnv.TMP);
  restoreEnv('TEMP', baseEnv.TEMP);
  fs.rmSync(root, { recursive: true, force: true });
});
