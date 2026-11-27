import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test file runs with a HOME of its own. Code under test reaches for the home directory
 * without being handed one — an agent without `cwd` gets `~/.fleetherd/agents/<id>` made for it
 * (agent-common.ts resolveAgentCwd) — and the suite is run on machines whose home is live: a
 * gateway's config, a host's `~/.fleetherd`. Found 2026-11-11, when three daemon tests made
 * `~/.fleetherd/agents/{oc,cc}` on a host still on `~/.talkcode`, which would have stopped that
 * host's directory from being moved to the new name on the gateway's next connection.
 *
 * The home is made under `os.tmpdir()`, which `vitest.global-setup.ts` points at one root for the
 * whole run and removes at the end. Never delete it here: under `isolate: false` a reused worker
 * can still reach an earlier file's paths, and a per-file `rmSync` broke CI on 2026-11-27.
 *
 * The pool is `forks`, so this reaches os.homedir() (a worker thread's process.env would not).
 * Tests that need a particular home still set HOME themselves, as before.
 */
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
