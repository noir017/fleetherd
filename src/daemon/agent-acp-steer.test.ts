import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import type { SteeringMode } from './acp-steering.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * A message handed to a running turn (AgentSession.steer), against a real child process speaking
 * ACP — one fake agent that plays each of the three kinds of harness (see SteeringMode):
 *
 * - `prompt`, the way claude-agent-acp + Claude Code behave: a second `session/prompt` is queued and
 *   absorbed at the tool boundary, the FIRST prompt then settles, and the combined reply streams
 *   under the second. A turn that ended on its own prompt's `stop` would lose that reply — the case
 *   this file exists for.
 * - `steer`, the way codex-acp behaves: `_session/steering` answers `injected` and the turn's one
 *   prompt settles when the merged turn is done; or `startedNewTurn` when no turn was running.
 * - `none`, the way opencode behaves: a second prompt is REJECTED and the message is lost, so the
 *   runtime must never send one.
 *
 * The timings are the ones observed live on 2026-10-10 (see acp-steering.ts), compressed.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const mode = process.env.FAKE_STEERING;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const notify = (sessionId, update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
const text = (sessionId, t) =>
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const resultUsage = (sessionId) =>
  notify(sessionId, { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
const words = (prompt) => (prompt || []).map((b) => b.text || '').join(' ');

// The turn in flight: its prompt id, what was steered into it, and prompts queued behind it.
let active = null;
// Every prompt text the agent was sent, in order — so a test can see what reached it.
const prompts = [];

function finishWork() {
  const a = active;
  active = null;
  notify(a.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'w-1', status: 'completed' });
  if (a.queued.length > 0) {
    // Claude Code: the queued message was absorbed at this boundary. The adapter settles the first
    // prompt as the absorbed one starts, and the reply belongs to the LAST prompt.
    reply(a.id, { stopReason: 'end_turn' });
    setTimeout(() => {
      text(a.sessionId, 'answered both: ' + a.queued.map((q) => q.words).join(' + '));
      resultUsage(a.sessionId);
      for (const q of a.queued) reply(q.id, { stopReason: 'end_turn' });
    }, 40);
    return;
  }
  text(a.sessionId, 'work done' + (a.steered.length ? ', and also ' + a.steered.join(' + ') : ''));
  resultUsage(a.sessionId);
  reply(a.id, { stopReason: 'end_turn' });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    const agentCapabilities = { loadSession: true };
    const res = { protocolVersion: 1, agentCapabilities, authMethods: [] };
    // claude-agent-acp advertises both; codex-acp only the steering extension; opencode neither.
    if (mode === 'prompt') agentCapabilities._meta = { claudeCode: { promptQueueing: true } };
    if (mode === 'prompt' || mode === 'steer') res._meta = { steering: { supported: true } };
    reply(msg.id, res);
    return;
  }
  if (msg.method === 'session/new') {
    // Slow on request, so a message can arrive while the turn is still starting.
    setTimeout(() => reply(msg.id, { sessionId: 's1' }), process.env.FAKE_SLOW_START ? 300 : 0);
    return;
  }
  if (msg.method === 'session/cancel') {
    if (active) {
      const a = active;
      active = null;
      reply(a.id, { stopReason: 'cancelled' });
      for (const q of a.queued) reply(q.id, { stopReason: 'cancelled' });
      // Claude Code: a queued message was already pushed to the SDK, and still runs after the
      // cancel settles its prompt (claude-agent-acp's own cancel() says so).
      if (a.queued.length > 0) {
        setTimeout(() => {
          text(a.sessionId, 'ran the queued message anyway: ' + a.queued.map((q) => q.words).join(' + '));
          resultUsage(a.sessionId);
        }, 100);
      }
    }
    return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const w = words(msg.params.prompt);
    prompts.push(w);
    if (w.includes('WHAT_REACHED_YOU')) {
      text(sessionId, 'prompts: ' + prompts.join(' | '));
      resultUsage(sessionId);
      reply(msg.id, { stopReason: 'end_turn' });
      return;
    }
    if (active) {
      if (mode !== 'prompt') return fail(msg.id, 'Session already has an active ACP prompt: ' + sessionId);
      active.queued.push({ id: msg.id, words: w });
      return;
    }
    if (w.includes('WORK')) {
      active = { id: msg.id, sessionId, steered: [], queued: [] };
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'w-1',
        title: 'the long build',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './build.sh' },
      });
      setTimeout(finishWork, 300);
      return;
    }
    text(sessionId, 'plain answer to ' + w);
    resultUsage(sessionId);
    reply(msg.id, { stopReason: 'end_turn' });
    return;
  }
  if (msg.method === '_session/steering') {
    const sessionId = msg.params.sessionId;
    const w = words(msg.params.prompt);
    const idle = msg.params._meta && msg.params._meta.steering && msg.params._meta.steering.idleBehavior;
    if (w.includes('STEER_FAILS')) return fail(msg.id, 'cannot steer a review turn');
    if (!active || w.includes('ALREADY_OVER')) {
      // codex-acp: no turn to join, so it starts one of its own — with no session/prompt behind it.
      reply(msg.id, { outcome: 'startedNewTurn' });
      setTimeout(() => {
        text(sessionId, 'detached answer to ' + w);
        resultUsage(sessionId);
      }, 20);
      return;
    }
    active.steered.push(w + ' [idle=' + idle + ']');
    reply(msg.id, { outcome: 'injected' });
    return;
  }
});
`;

function collector(): { handlers: AgentStreamHandlers; text: () => string; tools: string[] } {
  const chunks: string[] = [];
  const tools: string[] = [];
  return {
    text: () => chunks.join(''),
    tools,
    handlers: {
      onText: (d) => void chunks.push(d),
      onToolStart: (e) => void tools.push(e.name),
      onToolFinish: () => {},
      onSegmentBreak: () => {},
    },
  };
}

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(mode: SteeringMode, opts: { slowStart?: boolean } = {}): AgentSession {
  const dir = makeTempDir('aa-acp-steer-');
  const script = join(dir, 'fake-acp-agent.cjs');
  writeFileSync(script, FAKE_AGENT);
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'fake',
        harness: 'custom',
        command: process.execPath,
        args: [script],
        cwd: dir,
        env: { FAKE_STEERING: mode, ...(opts.slowStart ? { FAKE_SLOW_START: '1' } : {}) },
      },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  const store = {
    agentSession: () => undefined,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];
  live = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  return live;
}

const turn = { sessionToken: 'tok' };

/** Resolve once the turn's tool is running — the moment a user would type "also…". */
async function toolRunning(c: ReturnType<typeof collector>): Promise<void> {
  for (let i = 0; i < 200 && c.tools.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(c.tools.length).toBeGreaterThan(0);
}

describe('a message handed to a running turn — prompt mode (claude)', () => {
  it('joins the turn, and the turn ends with the reply that answers it, not on its own stop', async () => {
    const session = rig('prompt');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);

    expect(await session.steer!({ prompt: 'also check the docs' })).toBe('joined');
    await running;
    // Lost entirely by a turn that ended on the first prompt's stop: the reply arrives after it.
    expect(c.text()).toBe('answered both: also check the docs');
  });

  it('refuses once the turn has ended — the message then waits for its own turn', async () => {
    const session = rig('prompt');
    await session.runTurn({ ...turn, prompt: 'hello' }, collector().handlers);
    expect(await session.steer!({ prompt: 'late' })).toBe('refused');
  });

  it('waits for a turn that is still starting, and sends the message after the turn\'s own prompt', async () => {
    const session = rig('prompt', { slowStart: true });
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    // Before the child has even answered session/new: no prompt is out yet.
    expect(await session.steer!({ prompt: 'typed during startup' })).toBe('joined');
    await running;
    expect(c.text()).toBe('answered both: typed during startup');
  });

  it('refuses after a stop', async () => {
    const session = rig('prompt');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    session.abort();
    expect(await session.steer!({ prompt: 'too late' })).toBe('refused');
    await running;
  });

  it('a stop ends the child when a joined message is still queued in it, so that message never runs', async () => {
    const session = rig('prompt');
    const background: string[] = [];
    session.setFollowUpSink?.({
      handlers: () => ({ ...collector().handlers, onText: (d) => void background.push(d) }),
      close: () => {},
    });
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    expect(await session.steer!({ prompt: 'and then deploy it' })).toBe('joined');
    session.abort(); // `/stop`, before the harness reached the joined message
    await running;
    await new Promise((r) => setTimeout(r, 300));
    // What Claude Code does when the child survives: answers the queued message after the stop.
    expect(background.join('')).toBe('');

    // The conversation goes on, on a fresh child (the fake has no memory, so a new one has seen
    // only this prompt).
    const next = collector();
    await session.runTurn({ ...turn, prompt: 'WHAT_REACHED_YOU' }, next.handlers);
    expect(next.text()).toBe('prompts: WHAT_REACHED_YOU');
  });

  it('a stop with nothing queued behind it leaves the child alone', async () => {
    const session = rig('prompt');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    session.abort();
    await running;
    const next = collector();
    await session.runTurn({ ...turn, prompt: 'WHAT_REACHED_YOU' }, next.handlers);
    expect(next.text()).toBe('prompts: WORK | WHAT_REACHED_YOU');
  });
});

describe('a message handed to a running turn — steer mode (codex)', () => {
  it('joins through _session/steering, asking for it back if no turn is running', async () => {
    const session = rig('steer');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);

    expect(await session.steer!({ prompt: 'also check the docs' })).toBe('joined');
    await running;
    expect(c.text()).toBe('work done, and also also check the docs [idle=promptRequired]');
  });

  it('reports a message the harness answers outside the turn as detached', async () => {
    const session = rig('steer');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    // The race codex-acp leaves open: its turn ended a moment before the steer reached it, so it
    // starts one of its own (the fake answers that way on cue).
    expect(await session.steer!({ prompt: 'ALREADY_OVER' })).toBe('detached');
    await running;
  });

  it('treats a steer the harness rejects as refused, so the message is not lost', async () => {
    const session = rig('steer');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    expect(await session.steer!({ prompt: 'STEER_FAILS' })).toBe('refused');
    await running;
    expect(c.text()).toBe('work done');
  });
});

describe('a message handed to a running turn — a harness that cannot (opencode)', () => {
  it('refuses without sending anything, because a second prompt would be rejected and lost', async () => {
    const session = rig('none');
    const c = collector();
    const running = session.runTurn({ ...turn, prompt: 'WORK' }, c.handlers);
    await toolRunning(c);
    expect(await session.steer!({ prompt: 'also' })).toBe('refused');
    await running;

    const probe = collector();
    await session.runTurn({ ...turn, prompt: 'WHAT_REACHED_YOU' }, probe.handlers);
    expect(probe.text()).toBe('prompts: WORK | WHAT_REACHED_YOU');
  });
});
