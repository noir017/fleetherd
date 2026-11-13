import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOffRemoteCli, planRemoteCli } from './remote-cli.js';

/**
 * The handoff that makes `fleetherd` work in a login shell on a host: with FLEETHERD_REMOTE_SOCK set
 * the full Node CLI must become a wrapper for the host's shim, and must refuse everything the
 * gateway's bridge would refuse before anything leaves the machine.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A stand-in for <version>/bin/fleetherd: records its argv, then exits with `code`. */
function fakeShim(code = 0): { dir: string; shim: string; args: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-remote-cli-'));
  dirs.push(dir);
  const shim = path.join(dir, 'fleetherd');
  const args = path.join(dir, 'args');
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(args)}\nexit ${code}\n`, { mode: 0o755 });
  return { dir, shim, args };
}

describe('planRemoteCli', () => {
  it('is local when no host set FLEETHERD_REMOTE_SOCK — even with a shim path lying around', () => {
    expect(planRemoteCli(['task-agents'], { FLEETHERD_REMOTE_CLI: '/somewhere/fleetherd' })).toEqual({ kind: 'local' });
  });

  it('forwards what only the gateway can answer', () => {
    const { shim } = fakeShim();
    for (const argv of [['task-agents'], ['send-file', 'x'], ['mcp']]) {
      expect(planRemoteCli(argv, { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: shim })).toEqual({
        kind: 'forward',
        shim,
      });
    }
  });

  it('answers help and the version itself, so they still work on a host whose helper is older', () => {
    const { shim } = fakeShim();
    for (const argv of [['help'], ['help', 'tasks'], ['--help'], ['--version']]) {
      // No FLEETHERD_REMOTE_CLI: the helper predates this CLI. These read nothing but this program.
      expect(planRemoteCli(argv, { FLEETHERD_REMOTE_SOCK: '/tmp/s' })).toEqual({ kind: 'local' });
      expect(planRemoteCli(argv, { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: shim })).toEqual({ kind: 'local' });
    }
  });

  it('refuses the gateway\'s own administration here, naming the command', () => {
    const { shim } = fakeShim();
    const env = { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: shim };
    for (const cmd of ['start', 'setup', 'doctor']) {
      const plan = planRemoteCli([cmd], env);
      expect(plan.kind).toBe('refuse');
      expect(plan.kind === 'refuse' && plan.message).toContain(`"${cmd}"`);
      expect(plan.kind === 'refuse' && plan.message).toMatch(/administration/);
      // The binary is not the CLI here, and the operator can have it back in this shell.
      expect(plan.kind === 'refuse' && plan.message).toContain('env -u FLEETHERD_REMOTE_SOCK');
    }
    const bare = planRemoteCli([], env);
    expect(bare.kind === 'refuse' && bare.message).toMatch(/only the reverse commands/);
  });

  it('names the variable that is actually set, old name included', () => {
    const plan = planRemoteCli(['start'], { TALKCODE_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: '/x' });
    expect(plan.kind === 'refuse' && plan.message).toContain('env -u TALKCODE_REMOTE_SOCK');
  });

  it('tells the reader to unset both names when both are set, or envOf falls back', () => {
    const plan = planRemoteCli(['start'], {
      FLEETHERD_REMOTE_SOCK: '/tmp/s',
      TALKCODE_REMOTE_SOCK: '/tmp/s',
      FLEETHERD_REMOTE_CLI: '/x',
    });
    const message = plan.kind === 'refuse' ? plan.message : '';
    expect(message).toContain('FLEETHERD_REMOTE_SOCK and TALKCODE_REMOTE_SOCK are set');
    expect(message).toContain('env -u FLEETHERD_REMOTE_SOCK -u TALKCODE_REMOTE_SOCK fleetherd');
    // Sentences are joined with a space, not run together: "…lists them FLEETHERD…".
    expect(message).toContain('lists them). FLEETHERD_REMOTE_SOCK');
  });

  it('refuses an unknown command with the gateway\'s own wording, not as administration', () => {
    const { shim } = fakeShim();
    // A typo is not administration; saying it were would send the reader looking for a switch.
    const plan = planRemoteCli(['task-agent'], { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: shim });
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.message).toContain('"task-agent" is not a command an agent can run here');
    expect(plan.kind === 'refuse' && plan.message).not.toMatch(/administration/);
    expect(plan.kind === 'refuse' && plan.message).toContain('Did you mean `task-agents`?');
    expect(plan.kind === 'refuse' && plan.message).toContain('`task-agents`? FLEETHERD_REMOTE_SOCK is set');
  });

  it('refuses before forwarding when the host helper is older than this CLI', () => {
    const plan = planRemoteCli(['task-agents'], { FLEETHERD_REMOTE_SOCK: '/tmp/s' });
    expect(plan.kind).toBe('refuse');
    // The message has to name the cause: nothing on the host can be edited to fix this.
    expect(plan.kind === 'refuse' && plan.message).toMatch(/older than this CLI/);
    expect(plan.kind === 'refuse' && plan.message).toMatch(/FLEETHERD_REMOTE_CLI/);
  });

  it('refuses when the path the host named is not there', () => {
    const plan = planRemoteCli(['task-agents'], { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: '/nonexistent/fleetherd' });
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.message).toContain('/nonexistent/fleetherd');
  });
});

describe('handOffRemoteCli', () => {
  it('returns null where there is no host, so the CLI carries on', async () => {
    await expect(handOffRemoteCli(['doctor'], {})).resolves.toBeNull();
  });

  it('runs the shim with argv unchanged and carries its exit code back', async () => {
    const { shim, args } = fakeShim(3);
    const code = await handOffRemoteCli(['task-new', 'do the thing', '--agent', 'oc@a'], {
      FLEETHERD_REMOTE_SOCK: '/tmp/s',
      FLEETHERD_REMOTE_CLI: shim,
    });
    expect(code).toBe(3);
    expect(fs.readFileSync(args, 'utf8')).toBe('task-new\ndo the thing\n--agent\noc@a\n');
  });

  it('answers a refused command on stderr, with the exit code the gateway uses', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await handOffRemoteCli(['start'], { FLEETHERD_REMOTE_SOCK: '/tmp/s', FLEETHERD_REMOTE_CLI: fakeShim().shim });
    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"start"'));
  });
});

describe('the CLI entry', () => {
  // Everything above tests the decision; this runs the program. cli.ts is the one line that makes
  // the decision matter, and deleting it (`const remoteExit = null`) leaves every other test green —
  // so this one goes through the real entry point, in a child process.
  it('hands argv to the forwarder before commander sees it', () => {
    const { shim, args } = fakeShim(3);
    const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, 'task-agents', '--agent', 'oc@a'], {
      env: {
        ...process.env,
        FLEETHERD_REMOTE_SOCK: '/tmp/s',
        FLEETHERD_REMOTE_CLI: shim,
        // The failure mode this guards against is commander running the command instead.
        FLEETHERD_SOCKET: '',
        FLEETHERD_TURN_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(3);
    expect(fs.readFileSync(args, 'utf8')).toBe('task-agents\n--agent\noc@a\n');
  });
});
