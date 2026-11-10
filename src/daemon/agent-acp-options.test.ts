import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory, isCursorAgent } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import type { AgentSession } from './agent.js';

/**
 * `agents[].options` — the harness's own session config options, pinned from the agent definition —
 * and the one client capability that makes them exist on cursor.
 *
 * Both are about the same thing: an option the chat has no menu for. Cursor's ACP server only
 * splits a model's context / reasoning effort / fast into separate options when the client says it
 * can render them (`clientCapabilities._meta.parameterizedModelPicker`, cursor-agent 2026.11.05);
 * without it the model list is one pre-combined variant per model and the combination cannot be
 * chosen at all. Once the options exist, the ones `/effort` does not cover are pinned here.
 *
 * Driven against a real child process, like the effort test next door, because the ordering is the
 * point: pins go on after the model settles and before the conversation's `/effort`, and a model
 * switch reshapes the set they apply to.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];

// Model a has a context choice; model b does not — the shape a cursor model switch produces
// (claude's effort vs grok's reasoning_effort, thinking appearing or going).
const EFFORT = { a: ['low', 'medium', 'high', 'xhigh'], b: ['low', 'high'] };
const state = { model: 'a', context: '256k', reasoning_effort: 'high', fast: 'true' };
const defaults = () => {
  state.context = '256k';
  state.reasoning_effort = 'high';
  state.fast = 'true';
};

const options = () => {
  const list = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model,
      options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
    },
  ];
  if (state.model === 'a') {
    list.push({
      id: 'context', name: 'Context', category: 'model_config', type: 'select',
      currentValue: state.context,
      options: [{ value: '256k', name: '256K' }, { value: '500k', name: '500K' }],
    });
  }
  list.push({
    id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select',
    currentValue: state.reasoning_effort,
    options: EFFORT[state.model].map((v) => ({ value: v, name: v })),
  });
  list.push({
    id: 'fast', name: 'Fast', category: 'model_config', type: 'select',
    currentValue: state.fast,
    options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }],
  });
  return list;
};

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
  if (msg.method === 'session/load') return reply(msg.id, { configOptions: options() });
  if (msg.method === 'session/set_config_option') {
    const { configId, value } = msg.params;
    if (configId === 'model') {
      if (!['a', 'b'].includes(value)) return fail(msg.id, 'Invalid model value: ' + value);
      state.model = value;
      defaults();
    } else if (configId === 'context') {
      if (state.model !== 'a' || !['256k', '500k'].includes(value)) return fail(msg.id, 'Invalid params');
      state.context = value;
    } else if (configId === 'reasoning_effort') {
      if (!EFFORT[state.model].includes(value)) return fail(msg.id, 'Invalid params');
      state.reasoning_effort = value;
    } else if (configId === 'fast') {
      if (!['false', 'true'].includes(value)) return fail(msg.id, 'Invalid params');
      state.fast = value;
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
  /** The agent's pinned options. */
  options?: Record<string, string>;
  /** What the conversation's record says the person chose (ConversationStore.conversationChoice). */
  choices?: { model?: string; effort?: string };
  /** Name the executable `cursor-agent`, so isCursorAgent recognises it. */
  cursor?: boolean;
} = {}): {
  session: AgentSession;
  log: () => Array<{ method: string; params: Record<string, unknown> }>;
  /** Just the config writes, as `configId=value`, model included. */
  writes: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-options-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  const logPath = join(dir, 'requests.jsonl');
  writeFileSync(script, FAKE_AGENT);

  // A symlink keeps the argv a plain node run (so the fake starts anywhere) while giving the agent
  // definition the command name isCursorAgent reads.
  const command = join(dir, opts.cursor ? 'cursor-agent' : 'fake-agent');
  symlinkSync(process.execPath, command);

  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'fake',
        harness: 'custom',
        command,
        args: [script, logPath],
        cwd: dir,
        ...(opts.options ? { options: opts.options } : {}),
      },
    ],
    routing: { default: 'fake', pipeline: [] },
  });

  const store = {
    agentSession: () => undefined,
    setAgentSession: () => undefined,
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
  const writes = () =>
    log()
      .filter((r) => r.method === 'session/set_config_option')
      .map((r) => `${String(r.params.configId)}=${String(r.params.value)}`);
  return { session, log, writes };
}

describe('isCursorAgent', () => {
  it('reads the command’s last segment, and only for a custom agent', () => {
    expect(isCursorAgent({ harness: 'custom', command: '/home/u/.local/bin/cursor-agent' })).toBe(true);
    // A symlink under another name is not recognised — the agent keeps the pre-combined list, and
    // its pins are skipped with a log line rather than sent somewhere they do not belong.
    expect(isCursorAgent({ harness: 'custom', command: '/usr/local/bin/agent' })).toBe(false);
    expect(isCursorAgent({ harness: 'claude', command: 'cursor-agent' })).toBe(false);
  });
});

describe('the parameterized model picker', () => {
  it('is advertised only to cursor, because only it reads the key', async () => {
    const cursor = rig({ cursor: true });
    await cursor.session.ensureSession!('tok');
    const init = cursor.log().find((r) => r.method === 'initialize');
    expect(init?.params.clientCapabilities).toMatchObject({ _meta: { parameterizedModelPicker: true } });

    const plain = rig();
    await plain.session.ensureSession!('tok');
    const plainInit = plain.log().find((r) => r.method === 'initialize');
    // Absent, not `{}`: no adapter but cursor is told a capability it never needed.
    expect(plainInit?.params.clientCapabilities).not.toHaveProperty('_meta');
  });
});

describe('pinned session options', () => {
  it('are applied at startup, and the footer’s effort option still works', async () => {
    const { session, writes } = rig({ options: { context: '500k', fast: 'false' } });
    await session.ensureSession!('tok');
    expect(writes()).toEqual(['context=500k', 'fast=false']);
    expect(session.effortSelector!()?.current).toBe('high');
  });

  it('cost no round trip when the harness is already on them', async () => {
    const { session, writes } = rig({ options: { context: '256k', fast: 'true' } });
    await session.ensureSession!('tok');
    expect(writes()).toEqual([]);
  });

  it('lose to a level chosen in chat, which is applied after them', async () => {
    const { session, writes } = rig({ options: { reasoning_effort: 'xhigh' }, choices: { effort: 'low' } });
    await session.ensureSession!('tok');
    expect(writes()).toEqual(['reasoning_effort=xhigh', 'reasoning_effort=low']);
    expect(session.effortSelector!()?.current).toBe('low');
  });

  it('are put back after a model switch, and skipped where the new model lacks them', async () => {
    const { session, writes } = rig({ options: { context: '500k', fast: 'false', mode: 'plan' } });
    await session.ensureSession!('tok');
    expect(writes()).toEqual(['context=500k', 'fast=false']); // `mode` is not offered: skipped

    await session.setModel!('b'); // no `context` on b, and the switch resets `fast`
    expect(writes().slice(2)).toEqual(['model=b', 'fast=false']);

    await session.setModel!('a');
    expect(writes().slice(4)).toEqual(['model=a', 'context=500k', 'fast=false']);
  });

  it('are skipped, not forced, when the harness does not offer the value', async () => {
    const { session, writes } = rig({ options: { context: '1m' } });
    await session.ensureSession!('tok');
    expect(writes()).toEqual([]);
  });
});
