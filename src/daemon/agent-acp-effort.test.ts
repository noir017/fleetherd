import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import type { AgentSession } from './agent.js';

/**
 * `/effort` in the ACP runtime, driven against a real child process.
 *
 * The unit under test is a lifetime, not a function: a level chosen once has to survive everything
 * that rebuilds or reshapes the session under it — an idle reclaim, a crash, a `/model`. Each of
 * those is a real process doing real I/O, so the fake below reproduces the behaviour that forced the
 * design, as probed on 2026-09-23:
 *
 * - the option's id is the harness's own (`reasoning_effort` here, as codex-acp calls it); only its
 *   category, `thought_level`, is common ground;
 * - `session/load` answers at the DEFAULT level (claude-agent-acp 0.81.0 and codex-acp 1.13.0 both
 *   do), not the one the session was left on;
 * - a model switch resets the level, and each model offers its own list.
 *
 * Every request the fake receives is appended to a log file, which is what the assertions read.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];

const LEVELS = { a: ['low', 'medium', 'high', 'max'], b: ['low', 'high'] };
const state = { model: 'a', effort: 'high' };

const options = () => [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model,
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
  },
  {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: state.effort,
    options: LEVELS[state.model].map((v) => ({ value: v, name: v })),
  },
];

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32602, message } });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return;
  fs.appendFileSync(LOG, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
  if (msg.method === 'initialize') {
    return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  }
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 's1', configOptions: options() });
  // A fresh process: whatever level the session was left on is gone.
  if (msg.method === 'session/load') return reply(msg.id, { configOptions: options() });
  if (msg.method === 'session/set_config_option') {
    const { configId, value } = msg.params;
    if (configId === 'model') {
      state.model = value;
      state.effort = 'high'; // a new model starts at its default
    } else if (configId === 'reasoning_effort') {
      if (!LEVELS[state.model].includes(value)) return fail(msg.id, 'Invalid params');
      state.effort = value;
    } else {
      return fail(msg.id, 'unknown config option ' + configId);
    }
    return reply(msg.id, { configOptions: options() });
  }
  if (msg.method === 'session/prompt') return reply(msg.id, { stopReason: 'end_turn' });
  if (msg.id !== undefined) reply(msg.id, {});
});
`;

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: {
  /** What the conversation's record says the person chose (ConversationStore.conversationChoice). */
  choices?: { model?: string; effort?: string };
  /** A session id already on record, as after a restart: the first start takes `session/load`. */
  stored?: string;
} = {}): {
  session: AgentSession;
  /** Every request the fake received, in order. */
  log: () => Array<{ method: string; params: Record<string, unknown> }>;
  /** Just the effort writes, as `configId=value`. */
  effortWrites: () => string[];
  /** Just the model writes, as their values. */
  modelWrites: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-effort-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  const logPath = join(dir, 'requests.jsonl');
  writeFileSync(script, FAKE_AGENT);

  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [script, logPath], cwd: dir }],
    routing: { default: 'fake', pipeline: [] },
  });

  // A store that remembers the session id it is given, so a restarted child takes the
  // `session/load` path — the one an idle reclaim takes in production.
  let stored: string | undefined = opts.stored;
  const store = {
    agentSession: () => stored,
    setAgentSession: (_c: string, _a: string, id: string) => {
      stored = id;
    },
    conversationCwd: () => undefined,
    conversationChoice: (c: string, a: string, which: 'model' | 'effort') =>
      c === 'conv#1' && a === 'fake' ? opts.choices?.[which] : undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];

  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  const log = () =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
      : [];
  const effortWrites = () =>
    log()
      .filter((r) => r.method === 'session/set_config_option' && r.params.configId !== 'model')
      .map((r) => `${String(r.params.configId)}=${String(r.params.value)}`);
  const modelWrites = () =>
    log()
      .filter((r) => r.method === 'session/set_config_option' && r.params.configId === 'model')
      .map((r) => String(r.params.value));
  return { session, log, effortWrites, modelWrites };
}

describe('effort selector and switch', () => {
  it('reads the levels by category and writes through the harness’s own option id', async () => {
    const { session, effortWrites } = rig();
    await session.ensureSession!('tok');
    expect(session.effortSelector!()).toEqual({
      current: 'high',
      options: ['low', 'medium', 'high', 'max'].map((v) => ({ value: v, name: v })),
    });
    expect(await session.setEffort!('max')).toBe('max');
    // Never the gateway's word for it: `effort` would be rejected as an unknown option.
    expect(effortWrites()).toEqual(['reasoning_effort=max']);
    expect(session.effortSelector!()?.current).toBe('max');
  });
});

describe('the choice outlives the child', () => {
  it('is put back after a reclaim, because session/load comes back at the default', async () => {
    const { session, log, effortWrites } = rig();
    await session.ensureSession!('tok');
    await session.setEffort!('low');
    session.dispose(); // what the idle sweeper does
    await session.ensureSession!('tok');

    const methods = log().map((r) => r.method);
    expect(methods.filter((m) => m === 'session/load')).toHaveLength(1);
    // Re-applied AFTER the reload answered, which is the only order in which it sticks.
    expect(methods.lastIndexOf('session/set_config_option')).toBeGreaterThan(methods.indexOf('session/load'));
    expect(effortWrites()).toEqual(['reasoning_effort=low', 'reasoning_effort=low']);
    expect(session.effortSelector!()?.current).toBe('low');
  });

  it('is applied on first start when it was chosen before any child existed', async () => {
    const { session, effortWrites } = rig();
    // The warm-up has not happened; the choice is recorded, not sent.
    expect(await session.setEffort!('medium')).toBe('medium');
    expect(effortWrites()).toEqual([]);
    await session.ensureSession!('tok');
    expect(effortWrites()).toEqual(['reasoning_effort=medium']);
    expect(session.effortSelector!()?.current).toBe('medium');
  });

  it('costs no round trip when the reloaded session is already at the chosen level', async () => {
    const { session, effortWrites } = rig();
    await session.ensureSession!('tok');
    await session.setEffort!('high'); // the fake's default, so the reload lands on it anyway
    session.dispose();
    await session.ensureSession!('tok');
    expect(effortWrites()).toEqual(['reasoning_effort=high']);
  });
});

describe('a /model switch', () => {
  it('keeps the level where the new model offers it', async () => {
    const { session } = rig();
    await session.ensureSession!('tok');
    await session.setEffort!('low');
    await session.setModel!('b'); // resets to `high` in the fake, as a model switch does
    expect(session.effortSelector!()?.current).toBe('low');
  });

  it('does not force a level the new model lacks, and restores it on a model that has it', async () => {
    const { session, effortWrites } = rig();
    await session.ensureSession!('tok');
    await session.setEffort!('max');
    await session.setModel!('b'); // b has no `max`
    expect(session.effortSelector!()?.current).toBe('high');
    expect(session.effortSelector!()?.options.map((o) => o.value)).toEqual(['low', 'high']);
    await session.setModel!('a');
    expect(session.effortSelector!()?.current).toBe('max');
    // Written for the choice and for the return to `a` — never attempted against `b`.
    expect(effortWrites()).toEqual(['reasoning_effort=max', 'reasoning_effort=max']);
  });
});

describe('the model choice outlives the child', () => {
  // The fake reloads at its default model (`a`), as it does the effort level: whatever the session
  // was left on is process state there.
  it('is put back after a reclaim, before the effort, because the levels are the model’s', async () => {
    const { session, log, modelWrites } = rig();
    await session.ensureSession!('tok');
    await session.setModel!('b');
    session.dispose(); // what the idle sweeper does
    await session.ensureSession!('tok');

    expect(modelWrites()).toEqual(['b', 'b']);
    const methods = log().map((r) => r.method);
    expect(methods.lastIndexOf('session/set_config_option')).toBeGreaterThan(methods.indexOf('session/load'));
    expect(session.modelSelector!()?.current).toBe('b');
  });

  it('leaves a reloaded session alone when nobody chose a model here', async () => {
    const { session, log, modelWrites } = rig();
    await session.ensureSession!('tok');
    session.dispose();
    await session.ensureSession!('tok');
    expect(log().filter((r) => r.method === 'session/load')).toHaveLength(1);
    expect(modelWrites()).toEqual([]);
  });
});

describe('a choice on the conversation’s record', () => {
  // What `/new`, `/cd` and a daemon restart hand the runtime: a new session object, with only the
  // record to say what the person chose.
  it('is applied to a new session, model then effort', async () => {
    const { session, log, modelWrites, effortWrites } = rig({ choices: { model: 'b', effort: 'low' } });
    await session.ensureSession!('tok');
    const sent = log().find((r) => r.method === 'session/new');
    // The hint names the choice too, for a harness that reads it.
    expect((sent?.params._meta as { model?: string } | undefined)?.model).toBe('b');
    expect(modelWrites()).toEqual(['b']);
    expect(effortWrites()).toEqual(['reasoning_effort=low']);
    const writes = log().filter((r) => r.method === 'session/set_config_option').map((r) => r.params.configId);
    expect(writes).toEqual(['model', 'reasoning_effort']);
    expect(session.modelSelector!()?.current).toBe('b');
    expect(session.effortSelector!()?.current).toBe('low');
  });

  it('is applied to a session resumed after a restart', async () => {
    const { session, log, modelWrites, effortWrites } = rig({ choices: { model: 'b', effort: 'low' }, stored: 's1' });
    await session.ensureSession!('tok');
    expect(log().map((r) => r.method)).toContain('session/load');
    expect(log().map((r) => r.method)).not.toContain('session/new');
    expect(modelWrites()).toEqual(['b']);
    expect(effortWrites()).toEqual(['reasoning_effort=low']);
  });

  it('costs one write when the same model is chosen again before the child starts', async () => {
    const { session, modelWrites } = rig({ choices: { model: 'b' } });
    // Deferred as before: recorded, applied on start — once.
    await session.setModel!('b');
    await session.ensureSession!('tok');
    expect(modelWrites()).toEqual(['b']);
  });
});
