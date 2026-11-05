import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOffRemoteCli, planRemoteCli } from './remote-cli.js';

/**
 * The handoff that makes `talkcode` work in a login shell on a host: with TALKCODE_REMOTE_SOCK set
 * the full Node CLI must become a wrapper for the host's shim, and must refuse everything the
 * gateway's bridge would refuse before anything leaves the machine.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A stand-in for <version>/bin/talkcode: records its argv, then exits with `code`. */
function fakeShim(code = 0): { dir: string; shim: string; args: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-remote-cli-'));
  dirs.push(dir);
  const shim = path.join(dir, 'talkcode');
  const args = path.join(dir, 'args');
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(args)}\nexit ${code}\n`, { mode: 0o755 });
  return { dir, shim, args };
}

describe('planRemoteCli', () => {
  it('is local when no host set TALKCODE_REMOTE_SOCK — even with a shim path lying around', () => {
    expect(planRemoteCli(['task-agents'], { TALKCODE_REMOTE_CLI: '/somewhere/talkcode' })).toEqual({ kind: 'local' });
  });

  it('forwards the commands the gateway accepts from a host', () => {
    const { shim } = fakeShim();
    for (const argv of [['task-agents'], ['send-file', 'x'], ['mcp'], ['help'], ['--help']]) {
      expect(planRemoteCli(argv, { TALKCODE_REMOTE_SOCK: '/tmp/s', TALKCODE_REMOTE_CLI: shim })).toEqual({
        kind: 'forward',
        shim,
      });
    }
  });

  it('refuses the gateway\'s own administration here, naming the command', () => {
    const { shim } = fakeShim();
    const env = { TALKCODE_REMOTE_SOCK: '/tmp/s', TALKCODE_REMOTE_CLI: shim };
    for (const cmd of ['start', 'setup', 'doctor']) {
      const plan = planRemoteCli([cmd], env);
      expect(plan.kind).toBe('refuse');
      expect(plan.kind === 'refuse' && plan.message).toContain(`"${cmd}"`);
    }
    const bare = planRemoteCli([], env);
    expect(bare.kind === 'refuse' && bare.message).toMatch(/only the reverse commands/);
  });

  it('refuses before forwarding when the host helper is older than this CLI', () => {
    const plan = planRemoteCli(['task-agents'], { TALKCODE_REMOTE_SOCK: '/tmp/s' });
    expect(plan.kind).toBe('refuse');
    // The message has to name the cause: nothing on the host can be edited to fix this.
    expect(plan.kind === 'refuse' && plan.message).toMatch(/older than this CLI/);
    expect(plan.kind === 'refuse' && plan.message).toMatch(/TALKCODE_REMOTE_CLI/);
  });

  it('refuses when the path the host named is not there', () => {
    const plan = planRemoteCli(['task-agents'], { TALKCODE_REMOTE_SOCK: '/tmp/s', TALKCODE_REMOTE_CLI: '/nonexistent/talkcode' });
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.message).toContain('/nonexistent/talkcode');
  });
});

describe('handOffRemoteCli', () => {
  it('returns null where there is no host, so the CLI carries on', async () => {
    await expect(handOffRemoteCli(['doctor'], {})).resolves.toBeNull();
  });

  it('runs the shim with argv unchanged and carries its exit code back', async () => {
    const { shim, args } = fakeShim(3);
    const code = await handOffRemoteCli(['task-new', 'do the thing', '--agent', 'oc@a'], {
      TALKCODE_REMOTE_SOCK: '/tmp/s',
      TALKCODE_REMOTE_CLI: shim,
    });
    expect(code).toBe(3);
    expect(fs.readFileSync(args, 'utf8')).toBe('task-new\ndo the thing\n--agent\noc@a\n');
  });

  it('answers a refused command on stderr, with the exit code the gateway uses', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await handOffRemoteCli(['start'], { TALKCODE_REMOTE_SOCK: '/tmp/s', TALKCODE_REMOTE_CLI: fakeShim().shim });
    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"start"'));
  });
});
