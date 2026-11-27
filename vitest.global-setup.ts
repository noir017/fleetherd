import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One temporary root for the whole run, removed only once every worker is done. Workers inherit
 * TMPDIR from this process, so whatever a test makes under `os.tmpdir()` and forgets lands here.
 *
 * Deleting per file instead broke CI on 2026-11-27: under `isolate: false` a reused worker still
 * pointed later files at a root an earlier file's `afterAll` had already removed (ENOENT from
 * `mkdtemp`). Nothing is deleted mid-run now. The prefix stays short for the 108-byte socket limit.
 */
export default function setup(): () => void {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fhv-'));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
}
