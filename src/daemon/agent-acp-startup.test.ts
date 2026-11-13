import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory, startupFailureMessage } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import { promptUndelivered, TurnFailure, type AgentSession, type AgentStreamHandlers } from './agent.js';

/**
 * What a startup that failed says (agent-acp.ts startupFailureMessage): "the process never came up"
 * and "it came up, and opening a session failed" are different failures with different fixes.
 * Reported 2026-11-11: four agy starts answered `initialize` in 11ms, hung on `session/new` behind a
 * relay answering 502, and were each reported as a launch command missing from PATH.
 */

describe('startupFailureMessage', () => {
  const base = { agent: 'ag', launch: 'agy acp', stderr: '', hint: '' };

  it('a process that never answered initialize did not start — look at the command and the machine', () => {
    const text = startupFailureMessage({ ...base, progress: { answered: false, step: 'initialize' }, timeoutMs: 30_000 });
    expect(text).toBe(
      'agent "ag" did not start: its process gave no answer to initialize within 30s. Check that `agy acp` runs there and speaks ACP, and how loaded that machine is.'
    );
  });

  it('a process that answered and then hung on session/new is up — what is behind it is not', () => {
    const text = startupFailureMessage({
      ...base,
      host: 'laptop',
      progress: { answered: true, step: 'session/new' },
      timeoutMs: 30_000,
      stderr: 'starting\n\x1b[31merror\x1b[0m: relay 127.0.0.1:45119 answered 502 Bad Gateway\n',
    });
    expect(text).toBe(
      'agent "ag" started on host "laptop", but session/new got no answer within 30s. The process is up; what it needs to open a session ' +
        '(its model backend, a relay, the network) is not responding. Its last output on stderr: starting | error: relay 127.0.0.1:45119 answered 502 Bad Gateway'
    );
    expect(text).not.toContain('PATH');
  });

  it('quotes the error the agent answered with, its data included', () => {
    const err = Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'lookup api.example.com: i/o timeout' } });
    const text = startupFailureMessage({ ...base, progress: { answered: true, step: 'session/new' }, error: err });
    expect(text).toBe('agent "ag" started, but session/new failed: Internal error: lookup api.example.com: i/o timeout.');
  });

  it('keeps only the tail of a long stderr', () => {
    const text = startupFailureMessage({ ...base, progress: { answered: true, step: 'session/new' }, timeoutMs: 30_000, stderr: 'x'.repeat(5_000) });
    const quoted = text.split('Its last output on stderr: ')[1]!;
    expect(quoted.length).toBeLessThanOrEqual(600);
    expect(quoted.startsWith('…')).toBe(true);
  });
});

/** A fake ACP agent: answers initialize, then refuses session/new with an error and a line on stderr. */
const REFUSING_AGENT = /* js */ `
const readline = require('node:readline');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    process.stderr.write('backend: 502 Bad Gateway from relay\\n');
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: 'upstream answered 502' } }), 20);
    return;
  }
});
`;

/** A process that exits without a word. */
const SILENT_EXIT = `process.stderr.write('fatal: unknown subcommand acp\\n'); setTimeout(() => process.exit(2), 50);`;

const handlers: AgentStreamHandlers = { onText: () => {}, onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {} };

let live: AgentSession[] = [];
afterEach(() => {
  for (const s of live) s.dispose();
  live = [];
});

function sessionFor(source: string): AgentSession {
  const dir = mkdtempSync(join(tmpdir(), 'tc-acp-startup-'));
  const script = join(dir, 'agent.cjs');
  writeFileSync(script, source);
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [script], cwd: dir }],
    routing: { default: 'fake', pipeline: [] },
  });
  const store = { agentSession: () => undefined, setAgentSession: () => {}, conversationCwd: () => undefined } as unknown as Parameters<
    typeof createAcpAgentFactory
  >[2];
  const s = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('c1', 'fake');
  live.push(s);
  return s;
}

async function failureOf(s: AgentSession): Promise<TurnFailure> {
  try {
    await s.runTurn({ prompt: 'hello', sessionToken: 't' }, handlers);
  } catch (e) {
    return e as TurnFailure;
  }
  throw new Error('the turn did not fail');
}

describe('a startup that fails, end to end', () => {
  it('a refused session/new names the step and quotes the agent, and the prompt is marked undelivered', async () => {
    const err = await failureOf(sessionFor(REFUSING_AGENT));
    expect(err).toBeInstanceOf(TurnFailure);
    expect(err.reason).toBe('startup');
    expect(promptUndelivered(err)).toBe(true);
    expect(err.message).toContain('agent "fake" started, but session/new failed: Internal error: upstream answered 502.');
    expect(err.message).toContain('Its last output on stderr: backend: 502 Bad Gateway from relay');
  });

  it('a process that goes away before initialize did not start', async () => {
    const err = await failureOf(sessionFor(SILENT_EXIT));
    expect(err.reason).toBe('startup');
    expect(promptUndelivered(err)).toBe(true);
    expect(err.message).toMatch(/^agent "fake" did not start: its process went away before answering initialize/);
    expect(err.message).toContain('fatal: unknown subcommand acp');
  });
});
