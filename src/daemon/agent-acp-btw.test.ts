import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { forkSupportOf, sideQuestionRefusal } from './acp-side-question.js';
import { parseConfig, type Config } from '../config/schema.js';
import { SideQuestionRefused, type AgentSession, type AgentStreamHandlers } from './agent.js';
import type { AgentPermissionRequest } from '../types.js';

/**
 * Side questions (`/btw`) over a real child: a fake ACP agent that forks the way the probed
 * adapters do (project-scripts/fleetherd-btw/, 2026-11-13). Like claude-agent-acp 0.81.0, a fork is
 * not prompt-able until `session/resume` has loaded it, so a runtime that skipped resume fails here
 * the way it failed against the real adapter ("Session not found").
 *
 * What it declares comes from FAKE_CAPS; every request it receives is appended to FAKE_LOG.
 */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const text = (sessionId, t) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
const log = (line) => fs.appendFileSync(process.env.FAKE_LOG, line + '\\n');
const caps = JSON.parse(process.env.FAKE_CAPS || '{}');

const loaded = new Set();   // sessions a prompt can reach
const history = new Map();  // session -> the prompts it has been sent
const pending = new Map();  // session -> { id, timer } of its prompt in flight
let forks = 0;
let nextRequest = 1000;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method) log(msg.method + ' ' + (msg.params && msg.params.sessionId || ''));
  if (msg.id !== undefined && !msg.method) {
    // The client's answer to a permission request this agent made.
    const outcome = msg.result && msg.result.outcome;
    const sid = [...pending.keys()].find((k) => k.startsWith('fork'));
    if (sid) finish(sid, 'permission: ' + (outcome && outcome.outcome === 'selected' ? outcome.optionId : 'cancelled'));
    return;
  }
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: caps }, authMethods: [] });
    case 'session/new':
      loaded.add('s1');
      history.set('s1', []);
      return reply(msg.id, { sessionId: 's1' });
    case 'session/fork': {
      const id = 'fork-' + ++forks;
      // Copied, NOT loaded — claude-agent-acp's shape.
      history.set(id, [...(history.get(msg.params.sessionId) || [])]);
      return reply(msg.id, { sessionId: id });
    }
    case 'session/resume':
      loaded.add(msg.params.sessionId);
      return reply(msg.id, {});
    case 'session/delete':
    case 'session/close':
      loaded.delete(msg.params.sessionId);
      history.delete(msg.params.sessionId);
      return reply(msg.id, {});
    case 'session/cancel': {
      const p = pending.get(msg.params.sessionId);
      if (p) { clearTimeout(p.timer); pending.delete(msg.params.sessionId); reply(p.id, { stopReason: 'cancelled' }); }
      return;
    }
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      if (!loaded.has(sid)) return fail(msg.id, 'Session not found');
      const words = msg.params.prompt.map((b) => b.text || '').join('');
      const seen = history.get(sid).slice();
      history.get(sid).push(words);
      if (sid === 's1') {
        // The conversation's own turn: says what it has been told so far, slowly when asked to.
        text(sid, 'main heard [' + history.get(sid).join(' | ') + ']');
        const timer = setTimeout(() => { pending.delete(sid); reply(msg.id, { stopReason: 'end_turn' }); }, words.includes('slow') ? 800 : 0);
        pending.set(sid, { id: msg.id, timer });
        return;
      }
      // A fork: answers from the history it was copied with.
      if (words.includes('hang')) { pending.set(sid, { id: msg.id, timer: undefined }); return; }
      if (words.includes('perm')) {
        pending.set(sid, { id: msg.id, timer: undefined });
        send({ jsonrpc: '2.0', id: nextRequest++, method: 'session/request_permission', params: {
          sessionId: sid,
          toolCall: { toolCallId: 't1', title: 'rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
        } });
        return;
      }
      text(sid, 'side knows [' + seen.join(' | ') + ']');
      if (words.includes('wait')) { pending.set(sid, { id: msg.id, timer: setTimeout(() => finish(sid, 'late'), 2000) }); return; }
      return reply(msg.id, { stopReason: 'end_turn' });
    }
  }
});
function finish(sid, said) {
  const p = pending.get(sid);
  if (!p) return;
  pending.delete(sid);
  text(sid, said);
  reply(p.id, { stopReason: 'end_turn' });
}
`;

interface Collected {
  handlers: AgentStreamHandlers;
  text: () => string;
  permissions: AgentPermissionRequest[];
}

function collector(answer: 'allow' | 'none' = 'none'): Collected {
  const chunks: string[] = [];
  const permissions: AgentPermissionRequest[] = [];
  return {
    text: () => chunks.join(''),
    permissions,
    handlers: {
      onText: (d) => void chunks.push(d),
      onToolStart: () => {},
      onToolFinish: () => {},
      onSegmentBreak: () => {},
      ...(answer === 'allow'
        ? {
            onPermission: async (req: AgentPermissionRequest) => {
              permissions.push(req);
              return { kind: 'selected' as const, optionId: 'allow' };
            },
          }
        : {}),
    },
  };
}

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: { caps?: Record<string, object>; turnTimeoutMs?: number; stored?: string; permissions?: 'ask' } = {}): {
  session: AgentSession;
  calls: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-btw-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  const logFile = join(dir, 'calls.log');
  writeFileSync(script, FAKE_AGENT);
  writeFileSync(logFile, '');
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'fake',
        harness: 'custom',
        command: process.execPath,
        args: [script],
        cwd: dir,
        env: { FAKE_LOG: logFile, FAKE_CAPS: JSON.stringify(opts.caps ?? { fork: {}, resume: {}, delete: {} }) },
        ...(opts.permissions ? { permissions: opts.permissions } : {}),
      },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  const cfg: Config = opts.turnTimeoutMs ? { ...parsed, session: { ...parsed.session, turnTimeoutMs: opts.turnTimeoutMs } } : parsed;
  const store = {
    agentSession: () => opts.stored,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];
  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  return {
    session,
    calls: () => readFileSync(logFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('initialize')),
  };
}

const ask = (s: AgentSession, prompt: string, c: Collected): Promise<'done' | 'stopped'> =>
  s.sideQuestion!({ prompt, sessionToken: 'tok' }, c.handlers);

describe('side questions over ACP (sideQuestion)', () => {
  it('asks a fork while the turn runs, answers from the conversation, and keeps the question out of it', async () => {
    const { session, calls } = rig();
    const first = collector();
    await session.runTurn({ prompt: 'the code word is PELICAN', sessionToken: 'tok' }, first.handlers);

    const main = collector();
    const turn = session.runTurn({ prompt: 'slow work', sessionToken: 'tok' }, main.handlers);
    await new Promise((r) => setTimeout(r, 100));
    const side = collector();
    expect(await ask(session, 'what is the code word?', side)).toBe('done');
    // Answered while the turn was still running, from everything it had been told.
    expect(side.text()).toBe('side knows [the code word is PELICAN | slow work]');
    await turn;
    expect(main.text()).toBe('main heard [the code word is PELICAN | slow work]');

    // The next turn has never heard the side question.
    const after = collector();
    await session.runTurn({ prompt: 'and now?', sessionToken: 'tok' }, after.handlers);
    expect(after.text()).toBe('main heard [the code word is PELICAN | slow work | and now?]');

    // Forked from the conversation's session, loaded, asked, and deleted — in that order.
    const fork = calls().filter((c) => /fork|resume|delete|prompt fork/.test(c));
    expect(fork).toEqual(['session/fork s1', 'session/resume fork-1', 'session/prompt fork-1', 'session/delete fork-1']);
  });

  it('closes the fork where the agent can close but not delete', async () => {
    const { session, calls } = rig({ caps: { fork: {}, resume: {}, close: {} } });
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    await ask(session, 'q', collector());
    expect(calls()).toContain('session/close fork-1');
    expect(calls().some((c) => c.startsWith('session/delete'))).toBe(false);
  });

  it('refuses by name an agent that declares no fork, without asking it anything', async () => {
    const { session, calls } = rig({ caps: { resume: {}, delete: {} } });
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    const err = await ask(session, 'q', collector()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SideQuestionRefused);
    expect((err as Error).message).toBe('fake does not support /btw: its agent declares no session/fork, which a side question is asked on.');
    expect(calls().some((c) => c.startsWith('session/fork'))).toBe(false);
  });

  it('refuses when there is nothing to fork, without starting a child', async () => {
    const { session, calls } = rig();
    const err = await ask(session, 'q', collector()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SideQuestionRefused);
    expect((err as Error).message).toMatch(/^Nothing to ask fake about yet/);
    expect(session.reclaimState?.()).toBe('no-child');
    expect(calls()).toEqual([]);
  });

  it('stops on /stop: the fork is cancelled, the answer ends as stopped, and the fork is still deleted', async () => {
    const { session, calls } = rig();
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    const side = collector();
    const answer = ask(session, 'wait for it', side);
    await new Promise((r) => setTimeout(r, 200));
    expect(session.stopSideQuestions?.()).toBe(1);
    expect(await answer).toBe('stopped');
    expect(side.text()).not.toContain('late');
    expect(calls()).toEqual(expect.arrayContaining(['session/cancel fork-1', 'session/delete fork-1']));
    expect(session.stopSideQuestions?.()).toBe(0);
  });

  it("puts the fork's permission request to the side answer, not to the running turn", async () => {
    const { session } = rig({ permissions: 'ask' });
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    const main = collector('allow');
    const turn = session.runTurn({ prompt: 'slow work', sessionToken: 'tok' }, main.handlers);
    await new Promise((r) => setTimeout(r, 100));
    const side = collector('allow');
    await ask(session, 'perm please', side);
    await turn;
    expect(side.permissions.map((p) => p.title)).toEqual(['rm -rf build']);
    expect(main.permissions).toEqual([]);
    expect(side.text()).toBe('permission: allow');
  });

  it('gives up on a fork that goes silent, and still deletes it', async () => {
    const { session, calls } = rig({ turnTimeoutMs: 300 });
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    const err = await ask(session, 'hang', collector()).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/sent nothing for 300ms/);
    expect(calls()).toEqual(expect.arrayContaining(['session/cancel fork-1', 'session/delete fork-1']));
  });
});

describe('forkSupportOf / sideQuestionRefusal', () => {
  it('reads each capability by its presence', () => {
    expect(forkSupportOf({ agentCapabilities: { sessionCapabilities: { fork: {}, delete: {}, close: null } } })).toEqual({
      fork: true,
      resume: false,
      delete: true,
      close: false,
    });
    expect(forkSupportOf({})).toEqual({ fork: false, resume: false, delete: false, close: false });
  });

  it('holds opencode to between turns, where its fork would repeat the running one', () => {
    const yes = { fork: true, resume: true, delete: true, close: true };
    expect(sideQuestionRefusal('oc', 'opencode', yes, true)).toMatch(/cannot take \/btw while a turn runs/);
    expect(sideQuestionRefusal('oc', 'opencode', yes, false)).toBeUndefined();
    expect(sideQuestionRefusal('cc', 'claude', yes, true)).toBeUndefined();
    expect(sideQuestionRefusal('ag', 'agy', { ...yes, fork: false }, false)).toMatch(/does not support \/btw/);
  });
});
