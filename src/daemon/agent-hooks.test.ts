import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDefSchema, parseConfig } from '../config/schema.js';
import { createAcpAgentFactory } from './agent-acp.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import { PreLaunchCancelled, runPreLaunchHook, tailReason } from './agent-hooks.js';

/**
 * The preLaunch hook, run for real: `bash -lc` in its own process group, against the clock. The
 * runtime half drives the ACP runtime against a fake agent that records its own spawn, which is
 * what "before the child exists" and "never spawned" are read off.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), 'tc-hook-'));
const never = (): AbortSignal => new AbortController().signal;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const hookDef = (preLaunch?: string, env: Record<string, string> = {}) =>
  AgentDefSchema.parse({ id: 'a', harness: 'custom', command: 'x', env, ...(preLaunch ? { hooks: { preLaunch } } : {}) });

// Hook output is logged under the config dir; keep every run in this file out of the operator's.
let savedConfigDir: string | undefined;
beforeEach(() => {
  savedConfigDir = process.env.FLEETHERD_CONFIG_DIR;
  process.env.FLEETHERD_CONFIG_DIR = scratch();
});
afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.FLEETHERD_CONFIG_DIR;
  else process.env.FLEETHERD_CONFIG_DIR = savedConfigDir;
});

describe('agents[].hooks in config', () => {
  it('rejects a misspelled hook name instead of never running it', () => {
    const r = AgentDefSchema.safeParse({ id: 'a', harness: 'claude', hooks: { prelaunch: 'true' } });
    expect(r.success).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('runPreLaunchHook', () => {
  it('does nothing when the agent has no hook', async () => {
    const dir = scratch();
    await runPreLaunchHook(hookDef(), { cwd: dir, signal: never(), logDir: join(dir, 'logs') });
    expect(existsSync(join(dir, 'logs'))).toBe(false);
  });

  it("runs in the agent's directory with the agent's env, minus the reverse-command token", async () => {
    const dir = scratch();
    const hook = hookDef('pwd > out; printf "%s|%s" "$GREETING" "${FLEETHERD_TURN_TOKEN:-none}" >> out', {
      GREETING: 'hi',
      FLEETHERD_TURN_TOKEN: 'leak',
    });
    await runPreLaunchHook(hook, { cwd: dir, signal: never() });
    expect(readFileSync(join(dir, 'out'), 'utf8')).toBe(`${realpathSync(dir)}\nhi|none`);
  });

  it('fails with the END of what the script printed, which is where its reason is', async () => {
    const dir = scratch();
    const hook = hookDef('echo starting; echo "Error: No such container: foo" >&2; exit 3');
    const run = runPreLaunchHook(hook, { cwd: dir, signal: never() });
    await expect(run).rejects.toThrow(/pre-launch hook failed \(exit 3\): .*No such container: foo$/);
    await expect(run).rejects.not.toBeInstanceOf(PreLaunchCancelled);
  });

  it('times out, and takes everything it started down with it', async () => {
    const dir = scratch();
    const hook = hookDef('sleep 30 & echo $! > pid; wait');
    await expect(runPreLaunchHook(hook, { cwd: dir, signal: never(), timeoutMs: 300 })).rejects.toThrow(
      /pre-launch hook timed out/
    );
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await expect.poll(() => alive(pid), { timeout: 2_000 }).toBe(false);
  });

  it('does not wait on something it left running in the background', async () => {
    // `ssh -fN` and `foo &` inherit the output pipes and hold them for as long as they live.
    const dir = scratch();
    const hook = hookDef('sleep 30 & echo $! > pid');
    const started = Date.now();
    await runPreLaunchHook(hook, { cwd: dir, signal: never(), timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    // ...and leaves it running: starting it was the point.
    expect(alive(pid)).toBe(true);
    process.kill(pid);
  });

  it('is cancelled through its signal, as a kind of its own', async () => {
    const dir = scratch();
    const stop = new AbortController();
    const run = runPreLaunchHook(hookDef('sleep 30'), { cwd: dir, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    await expect(run).rejects.toBeInstanceOf(PreLaunchCancelled);
  });

  it('names a missing working directory rather than bash', async () => {
    const run = runPreLaunchHook(hookDef('true'), { cwd: join(scratch(), 'gone'), signal: never() });
    await expect(run).rejects.toThrow(/could not start: working directory .*gone does not exist/);
  });
});

describe('tailReason', () => {
  it('keeps the end of a long output, on one line', () => {
    const out = `${'noise '.repeat(100)}\nError: the actual reason\n`;
    const reason = tailReason(out);
    expect(reason).toHaveLength(150);
    expect(reason.startsWith('…')).toBe(true);
    expect(reason.endsWith('Error: the actual reason')).toBe(true);
  });
});

/** An ACP agent that writes `spawn` to its log the moment it starts, and answers just enough. */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];
fs.appendFileSync(LOG, 'spawn\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's1' });
  if (msg.method === 'session/prompt') return reply(msg.id, { stopReason: 'end_turn' });
  if (msg.id !== undefined) reply(msg.id, {});
});
`;

const quiet: AgentStreamHandlers = {
  onText: () => {},
  onToolStart: () => {},
  onToolFinish: () => {},
  onSegmentBreak: () => {},
};

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(preLaunch: string): { session: AgentSession; events: () => string[] } {
  const dir = scratch();
  const script = join(dir, 'fake-acp-agent.cjs');
  const log = join(dir, 'events');
  writeFileSync(script, FAKE_AGENT);
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'fake', harness: 'custom', command: process.execPath, args: [script, log], cwd: dir, hooks: { preLaunch } },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  const store = {
    agentSession: () => undefined,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];
  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  const events = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { session, events };
}

describe.skipIf(process.platform === 'win32')('the ACP runtime runs preLaunch ahead of every spawn', () => {
  it('runs the hook before the child exists', async () => {
    const { session, events } = rig('echo hook >> events');
    await session.ensureSession?.('tok');
    expect(events()).toEqual(['hook', 'spawn']);
  });

  it('runs it again when a disposed session respawns', async () => {
    const { session, events } = rig('echo hook >> events');
    await session.ensureSession?.('tok');
    session.dispose();
    await session.ensureSession?.('tok');
    expect(events()).toEqual(['hook', 'spawn', 'hook', 'spawn']);
  });

  it('fails the startup on a failing hook, and never spawns the agent', async () => {
    const { session, events } = rig('echo "tunnel refused" >&2; exit 7');
    await expect(session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, quiet)).rejects.toThrow(
      /agent "fake" pre-launch hook failed \(exit 7\): tunnel refused/
    );
    expect(events()).toEqual([]);
  });

  it('spawns nothing for a session disposed while its hook ran', async () => {
    const { session, events } = rig('sleep 5; echo hook >> events');
    const starting = session.ensureSession?.('tok');
    setTimeout(() => session.dispose(), 200);
    await expect(starting).rejects.toBeInstanceOf(PreLaunchCancelled);
    expect(events()).toEqual([]);
  });

  it('ends a turn stopped during its hook quietly, without running it', async () => {
    const { session, events } = rig('sleep 5; echo hook >> events');
    const turn = session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, quiet);
    setTimeout(() => session.abort(), 200);
    await expect(turn).resolves.toBeUndefined();
    expect(events()).toEqual([]);
  });
});
