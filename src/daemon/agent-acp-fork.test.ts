import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import { ConversationStore } from './conversation-store.js';
import { ForkRefused, type AgentFactory, type AgentStreamHandlers } from './agent.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * `/fork` over real children (AgentSession.forkFrom): the new conversation's own child forks the
 * source's stored session, the way every probed harness takes it (acp-fork.ts, 2026-11-20).
 *
 * The fake keeps its sessions in a file shared by every process, as the real harnesses keep theirs on
 * disk, so the source's child and the fork's child are two processes over one store. Like
 * claude-agent-acp, a fork is not prompt-able until `session/resume` has loaded it. Every request is
 * appended to FAKE_LOG with the pid that received it.
 */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const text = (sessionId, t) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
const log = (line) => fs.appendFileSync(process.env.FAKE_LOG, process.pid + ' ' + line + '\\n');
const caps = JSON.parse(process.env.FAKE_CAPS || '{}');
const read = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_STORE, 'utf8')); } catch { return {}; } };
const write = (db) => fs.writeFileSync(process.env.FAKE_STORE, JSON.stringify(db));
const loaded = new Set();
let n = 0;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return;
  const sid = msg.params && msg.params.sessionId;
  log(msg.method + ' ' + (sid || ''));
  const db = read();
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: caps }, authMethods: [] });
    case 'session/new': {
      const id = 's-' + process.pid + '-' + ++n;
      db[id] = []; write(db); loaded.add(id);
      return reply(msg.id, { sessionId: id });
    }
    case 'session/load':
      if (!db[sid]) return fail(msg.id, 'no such session');
      loaded.add(sid);
      return reply(msg.id, {});
    case 'session/fork': {
      if (!db[sid]) return fail(msg.id, 'Session not found');
      const id = 'f-' + process.pid + '-' + ++n;
      db[id] = db[sid].slice(); write(db);   // copied on disk, NOT loaded
      return reply(msg.id, { sessionId: id });
    }
    case 'session/resume':
      loaded.add(sid);
      return reply(msg.id, {});
    case 'session/prompt': {
      if (!loaded.has(sid)) return fail(msg.id, 'Session not found');
      const words = msg.params.prompt.map((b) => b.text || '').join('');
      db[sid].push(words); write(db);
      text(sid, 'heard [' + db[sid].join(' | ') + ']');
      return reply(msg.id, { stopReason: 'end_turn' });
    }
  }
});
`;

function collector(): { handlers: AgentStreamHandlers; text: () => string } {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(''),
    handlers: { onText: (d) => void chunks.push(d), onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {} },
  };
}

let factory: AgentFactory | undefined;
afterEach(() => {
  factory?.dispose('web#main#source');
  factory?.dispose('web#main#fork');
  factory = undefined;
});

function rig(caps: Record<string, object> = { fork: {}, resume: {}, delete: {} }) {
  const dir = makeTempDir('aa-acp-fork-');
  const script = join(dir, 'fake-acp-agent.cjs');
  const logFile = join(dir, 'calls.log');
  writeFileSync(script, FAKE_AGENT);
  writeFileSync(logFile, '');
  const cfg = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [
      {
        id: 'fake',
        harness: 'custom',
        command: process.execPath,
        args: [script],
        cwd: dir,
        env: { FAKE_LOG: logFile, FAKE_STORE: join(dir, 'sessions.json'), FAKE_CAPS: JSON.stringify(caps) },
      },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  const store = new ConversationStore(join(dir, 'conversations.json'));
  store.bind('web#main#source', 'fake');
  store.bind('web#main#fork', 'fake');
  factory = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store, { provisions: [] });
  return {
    factory,
    store,
    /** Each request as `<which process> <method> <session>`, the processes named in order of appearance. */
    calls: () => {
      const pids: string[] = [];
      return readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [pid, ...rest] = l.split(' ');
          if (!pids.includes(pid!)) pids.push(pid!);
          return `P${pids.indexOf(pid!) + 1} ${rest.join(' ')}`.trim();
        })
        .filter((l) => !l.includes('initialize'));
    },
  };
}

describe('forkFrom over ACP', () => {
  it("starts the new conversation's own child as a copy of the source's session, and leaves the source alone", async () => {
    const { factory, store, calls } = rig();
    const source = factory.getOrCreate('web#main#source', 'fake');
    await source.runTurn({ prompt: 'the code word is PELICAN', sessionToken: 'tok' }, collector().handlers);
    const sourceId = store.agentSession('web#main#source', 'fake')!;

    const fork = factory.getOrCreate('web#main#fork', 'fake');
    await fork.forkFrom!({ sessionId: sourceId, sessionToken: 'tok2' });
    const forkId = store.agentSession('web#main#fork', 'fake');
    expect(forkId).toMatch(/^f-/);
    expect(forkId).not.toBe(sourceId);

    const asked = collector();
    await fork.runTurn({ prompt: 'what is the code word?', sessionToken: 'tok2' }, asked.handlers);
    // The copy knows what the source was told; the replayed history is not re-rendered.
    expect(asked.text()).toBe('heard [the code word is PELICAN | what is the code word?]');

    const again = collector();
    await source.runTurn({ prompt: 'and here?', sessionToken: 'tok' }, again.handlers);
    expect(again.text()).toBe('heard [the code word is PELICAN | and here?]');

    // Forked and resumed in the SECOND process, while the first one still held the source.
    expect(calls()).toEqual([
      `P1 session/new`,
      `P1 session/prompt ${sourceId}`,
      `P2 session/fork ${sourceId}`,
      `P2 session/resume ${forkId}`,
      `P2 session/prompt ${forkId}`,
      `P1 session/prompt ${sourceId}`,
    ]);
    expect(fork.canFork?.()).toBe(true);
  });

  it('reloads the copy, not the source, once its child is gone', async () => {
    const { factory, store, calls } = rig();
    const source = factory.getOrCreate('web#main#source', 'fake');
    await source.runTurn({ prompt: 'first', sessionToken: 'tok' }, collector().handlers);
    const fork = factory.getOrCreate('web#main#fork', 'fake');
    await fork.forkFrom!({ sessionId: store.agentSession('web#main#source', 'fake')!, sessionToken: 'tok2' });
    const forkId = store.agentSession('web#main#fork', 'fake')!;
    factory.dispose('web#main#fork');

    const back = factory.getOrCreate('web#main#fork', 'fake');
    const asked = collector();
    await back.runTurn({ prompt: 'still there?', sessionToken: 'tok2' }, asked.handlers);
    expect(asked.text()).toBe('heard [first | still there?]');
    expect(calls()).toContain(`P3 session/load ${forkId}`);
  });

  it('refuses an agent that declares no fork, without asking it to fork or leaving a child behind', async () => {
    const { factory, store, calls } = rig({ resume: {}, delete: {} });
    const source = factory.getOrCreate('web#main#source', 'fake');
    await source.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    expect(source.canFork?.()).toBe(false);
    const fork = factory.getOrCreate('web#main#fork', 'fake');
    const err = await fork.forkFrom!({ sessionId: store.agentSession('web#main#source', 'fake')!, sessionToken: 'tok2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForkRefused);
    expect((err as Error).message).toBe('fake does not support /fork: its agent declares no session/fork, which a fork is made with.');
    expect(calls().some((c) => c.includes('session/fork'))).toBe(false);
    expect(store.agentSession('web#main#fork', 'fake')).toBeUndefined();
    expect(fork.reclaimState?.()).toBe('no-child');
  });

  it('says it cannot tell before any child of the agent has answered', () => {
    const { factory } = rig();
    expect(factory.getOrCreate('web#main#source', 'fake').canFork?.()).toBeUndefined();
  });

  it('refuses to replace a session that is already up', async () => {
    const { factory, store } = rig();
    const source = factory.getOrCreate('web#main#source', 'fake');
    await source.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    const err = await source.forkFrom!({ sessionId: store.agentSession('web#main#source', 'fake')!, sessionToken: 'tok' }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/already has a session here; a fork must be its first/);
  });

  it('reports a source the agent cannot find as a failed fork, naming the step', async () => {
    const { factory, store } = rig();
    const fork = factory.getOrCreate('web#main#fork', 'fake');
    const err = await fork.forkFrom!({ sessionId: 'gone', sessionToken: 'tok2' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ForkRefused);
    expect((err as Error).message).toMatch(/session\/fork failed: .*Session not found/);
    expect(store.agentSession('web#main#fork', 'fake')).toBeUndefined();
  });
});
