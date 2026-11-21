import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
import { applyPermissionLevel, createAcpAgentFactory, modeControlOf, permissionModesOf } from './agent-acp.js';
import { parseConfig, type AgentDef, type Config, type PermissionLevel } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import type { AgentPermissionRequest, PermissionAnswer } from '../types.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * `agents[].permissions` on the ACP side: which mode a session is put in, by which route, and how
 * the level decides whether a permission request reaches the person.
 *
 * The mode lists are the ones the harnesses reported on 2026-11-18
 * (core/permission-levels.ts), so a test failing here after an adapter upgrade says the mapping
 * needs measuring again, not just the test updating.
 */

const opt = (values: string[], current: string): SessionConfigOption =>
  ({
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: current,
    options: values.map((v) => ({ value: v, name: v })),
  }) as SessionConfigOption;
const modes = (ids: string[], current: string): SessionModeState => ({
  currentModeId: current,
  availableModes: ids.map((id) => ({ id, name: id })),
});

const CODEX = ['read-only', 'workspace-write', 'agent', 'agent-full-access'];
const CLAUDE = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const OPENCODE = ['build', 'plan'];

function def(harness: AgentDef['harness'], permissions?: PermissionLevel, options: AgentDef['options'] = {}): AgentDef {
  return parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'a', harness, ...(harness === 'custom' ? { command: 'x' } : {}), options, ...(permissions ? { permissions } : {}) }],
    routing: { default: 'a' },
  }).agents[0]!;
}

/** A ClientContext that records what it was asked and answers like a harness would. */
function ctx(fail = false) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    request: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (fail) throw new Error('refused');
      if (method === 'session/set_config_option') return { configOptions: [opt(OPENCODE, String(params['value']))] };
      return {};
    }) as never,
  };
}

describe('modeControlOf', () => {
  it('prefers `modes` and session/set_mode where the harness reports them', () => {
    const c = modeControlOf(modes(CODEX, 'agent'), [opt(CODEX, 'agent')]);
    expect(c).toMatchObject({ via: 'set_mode', current: 'agent' });
    expect(c?.options.map((m) => m.value)).toEqual(CODEX);
  });

  it('falls back to the config option of category `mode` (opencode reports no `modes`)', () => {
    const c = modeControlOf(undefined, [opt(OPENCODE, 'build')]);
    expect(c).toMatchObject({ via: 'config_option', configId: 'mode', current: 'build' });
  });

  it('is undefined for a harness that reports neither', () => {
    expect(modeControlOf(undefined, [])).toBeUndefined();
    expect(modeControlOf({ currentModeId: 'x', availableModes: [] }, undefined)).toBeUndefined();
  });

  it('leaves agy out: its modes were not measurable, and its `default` wrote without asking', () => {
    const state = { modes: modes(['default', 'accept-edits', 'plan'], 'default'), options: undefined };
    expect(permissionModesOf(def('agy'), state)).toBeUndefined();
    expect(permissionModesOf(def('codex'), { modes: modes(CODEX, 'agent'), options: undefined })?.options).toHaveLength(4);
  });
});

describe('applyPermissionLevel', () => {
  const cases: Array<[PermissionLevel, string]> = [
    ['ask', 'read-only'],
    ['edits', 'workspace-write'],
    // Not codex's own `agent`: its reviewer refused the edit and the command it was asked for.
    ['auto', 'workspace-write'],
    ['full', 'agent-full-access'],
  ];
  for (const [level, mode] of cases) {
    it(`puts codex in ${mode} for ${level}, through session/set_mode`, async () => {
      const c = ctx();
      const after = await applyPermissionLevel(c, 's1', def('codex', level), { modes: modes(CODEX, 'agent'), options: undefined });
      expect(c.calls).toEqual([{ method: 'session/set_mode', params: { sessionId: 's1', modeId: mode } }]);
      expect(after?.modes?.currentModeId).toBe(mode);
    });
  }

  it('sets opencode through its config option, and keeps what it reports back', async () => {
    const c = ctx();
    const after = await applyPermissionLevel(c, 's1', def('opencode', 'plan'), { modes: undefined, options: [opt(OPENCODE, 'build')] });
    expect(c.calls).toEqual([{ method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value: 'plan' } }]);
    expect(after?.options?.[0]?.currentValue).toBe('plan');
  });

  it('sends nothing with no level set — the harness keeps the mode it chose', async () => {
    const c = ctx();
    expect(await applyPermissionLevel(c, 's1', def('claude'), { modes: modes(CLAUDE, 'acceptEdits'), options: undefined })).toBeUndefined();
    expect(c.calls).toEqual([]);
  });

  it('sends nothing when the session is already there, or offers no mode for the level', async () => {
    const c = ctx();
    await applyPermissionLevel(c, 's1', def('claude', 'ask'), { modes: modes(CLAUDE, 'default'), options: undefined });
    await applyPermissionLevel(c, 's1', def('codex', 'plan'), { modes: modes(CODEX, 'agent'), options: undefined });
    await applyPermissionLevel(c, 's1', def('opencode', 'edits'), { modes: undefined, options: [opt(OPENCODE, 'build')] });
    await applyPermissionLevel(c, 's1', def('agy', 'plan'), { modes: modes(['default', 'plan'], 'default'), options: undefined });
    expect(c.calls).toEqual([]);
  });

  it('under auto goes back to a pinned options.mode; any other level outranks the pin', async () => {
    const c = ctx();
    const state = { modes: modes(CODEX, 'read-only'), options: undefined };
    await applyPermissionLevel(c, 's1', def('codex', 'auto', { mode: 'agent-full-access' }), state);
    await applyPermissionLevel(c, 's1', def('codex', 'ask', { mode: 'agent-full-access' }), { ...state, modes: modes(CODEX, 'agent') });
    expect(c.calls.map((x) => x.params['modeId'])).toEqual(['agent-full-access', 'read-only']);
  });

  it('never fails the turn when the harness refuses the mode', async () => {
    expect(await applyPermissionLevel(ctx(true), 's1', def('codex', 'ask'), { modes: modes(CODEX, 'agent'), options: undefined })).toBeUndefined();
  });
});

/**
 * A harness shaped like claude-agent-acp / codex-acp / CodeBuddy: `modes` on session/new, mode
 * changes through session/set_mode, and a permission request whose option ids are codex's
 * (`accept` / `cancel`) — the gateway must pick by kind, never by id. Logs every set_mode and every
 * answer it gets.
 */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'].map((id) => ({ id, name: id }));
let mode = 'default';
const pending = new Map();
let n = 0;
const askPermission = () => new Promise((resolve) => {
  const id = 'perm-' + (++n);
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc' + n, title: 'Edit files', kind: 'edit' },
    options: [
      { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      { optionId: 'acceptForSession', name: 'Always', kind: 'allow_always' },
      { optionId: 'accept', name: 'Yes', kind: 'allow_once' },
    ],
  } });
}).then((answer) => log({ answer }));
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method && pending.has(msg.id)) {
    const done = pending.get(msg.id);
    pending.delete(msg.id);
    return done(msg.error ? { error: msg.error.message } : msg.result);
  }
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  }
  if (msg.method === 'session/load') {
    // Back at its default, as claude and CodeBuddy reload (measured 2026-11-18).
    return send({ jsonrpc: '2.0', id: msg.id, result: { modes: { currentModeId: 'default', availableModes: MODES } } });
  }
  if (msg.method === 'session/new') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: mode, availableModes: MODES } } });
  }
  if (msg.method === 'session/set_mode') {
    mode = msg.params.modeId;
    log({ set_mode: mode });
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt[0].text;
    if (text === 'ask') await askPermission();
    if (text === 'leave-plan') {
      // claude, after the person approves leaving plan with "auto-accept edits"
      mode = 'acceptEdits';
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

/**
 * A harness that reports no session mode at all — agy among them, whose modes are left out
 * (modesLeftOut), and any custom agent whose ACP server offers none. It still asks before a tool
 * call, which is the only half a level can answer here.
 */
const FAKE_AGENT_NO_MODES = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const pending = new Map();
let n = 0;
const askPermission = () => new Promise((resolve) => {
  const id = 'perm-' + (++n);
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc' + n, title: 'Edit files', kind: 'edit' },
    options: [
      { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      { optionId: 'accept', name: 'Yes', kind: 'allow_once' },
    ],
  } });
}).then((answer) => log({ answer }));
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method && pending.has(msg.id)) {
    const done = pending.get(msg.id);
    pending.delete(msg.id);
    return done(msg.error ? { error: msg.error.message } : msg.result);
  }
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  }
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/load') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/set_mode') {
    // Logged, not just answered: the level must not move a mode here, and a silent generic reply
    // would let that regression through the test that says so.
    log({ set_mode: msg.params.modeId });
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    if (msg.params.prompt[0].text === 'ask') await askPermission();
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(permissions?: PermissionLevel, resume?: string, script = FAKE_AGENT) {
  const dir = makeTempDir('fh-acp-level-');
  const file = join(dir, 'fake.cjs');
  const log = join(dir, 'log');
  writeFileSync(file, script);
  const cfg: Config = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'fake', harness: 'custom', command: process.execPath, args: [file, log], cwd: dir, ...(permissions ? { permissions } : {}) },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  const store = { agentSession: () => resume, setAgentSession: () => {}, conversationCwd: () => undefined } as unknown as Parameters<
    typeof createAcpAgentFactory
  >[2];
  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  const entries = (): Array<Record<string, unknown>> =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return { session, def: cfg.agents[0]!, entries };
}

const handlers = (onPermission?: (r: AgentPermissionRequest) => Promise<PermissionAnswer>): AgentStreamHandlers => ({
  onText: () => {},
  onToolStart: () => {},
  onToolFinish: () => {},
  onSegmentBreak: () => {},
  ...(onPermission ? { onPermission } : {}),
});

describe('the ACP runtime under a permission level', () => {
  for (const level of ['plan', 'ask', 'edits'] as const) {
    it(`puts the request to the person under ${level}`, async () => {
      const { session, entries } = rig(level);
      const seen: string[] = [];
      await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async (r) => (seen.push(r.title), { kind: 'selected', optionId: 'cancel' })));
      expect(seen).toEqual(['Edit files']);
      expect(entries().filter((e) => 'answer' in e)).toEqual([{ answer: { outcome: { outcome: 'selected', optionId: 'cancel' } } }]);
    });
  }

  it('puts a request to the person on a harness with no mode, and sets none', async () => {
    // `ask` is offered to these harnesses for the gateway's half alone (permission-levels.ts):
    // whatever the agent does ask must reach the person, and there is no mode to move it to.
    const { session, entries } = rig('ask', undefined, FAKE_AGENT_NO_MODES);
    const seen: string[] = [];
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async (r) => (seen.push(r.title), { kind: 'selected', optionId: 'cancel' })));
    expect(seen).toEqual(['Edit files']);
    // Nothing was sent to move the mode: there is none to move, and the gateway's half is the level.
    expect(entries().filter((e) => 'set_mode' in e)).toEqual([]);
    expect(entries()).toEqual([{ answer: { outcome: { outcome: 'selected', optionId: 'cancel' } } }]);
  });

  it('declines rather than approves when nobody can be asked, on a harness with no mode too', async () => {
    // The invariant does not depend on a mode existing: no handler, no answer, and never a yes.
    const { session, entries } = rig('ask', undefined, FAKE_AGENT_NO_MODES);
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers());
    const [answer] = entries().filter((e) => 'answer' in e) as Array<{ answer: { error?: string } }>;
    expect(answer!.answer.error).toContain('could not be shown to the user');
  });

  for (const level of [undefined, 'auto', 'full'] as const) {
    it(`approves by the option's kind, without asking, under ${level ?? 'no level'}`, async () => {
      const { session, entries } = rig(level);
      let asked = 0;
      await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async () => (asked++, { kind: 'cancelled' })));
      expect(asked).toBe(0);
      // `accept` is codex's allow_once — chosen by kind, not by guessing an id like `allow-once`.
      expect(entries().filter((e) => 'answer' in e)).toEqual([{ answer: { outcome: { outcome: 'selected', optionId: 'accept' } } }]);
    });
  }

  it('puts a new session in the level’s mode before the first prompt, and leaves an unset one alone', async () => {
    const plan = rig('plan');
    await plan.session.runTurn({ prompt: 'hi', sessionToken: 't' }, handlers());
    expect(plan.entries()).toEqual([{ set_mode: 'plan' }]);
    expect(plan.session.permissionModes?.()?.current).toBe('plan');
    plan.session.dispose();

    const unset = rig();
    await unset.session.runTurn({ prompt: 'hi', sessionToken: 't' }, handlers());
    expect(unset.entries()).toEqual([]);
    expect(unset.session.permissionModes?.()?.options.map((m) => m.value)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  });

  it('switches a running session when the level changes, and answers the next request the new way', async () => {
    const { session, def, entries } = rig('ask');
    await session.runTurn({ prompt: 'hi', sessionToken: 't' }, handlers());
    // What SettingsStore does: mutate the definition the session holds, then call the hook.
    def.permissions = 'full';
    await session.applyPermissions?.();
    expect(entries()).toEqual([{ set_mode: 'bypassPermissions' }]);
    let asked = 0;
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async () => (asked++, { kind: 'cancelled' })));
    expect(asked).toBe(0);
  });

  it('follows the harness moving its own mode, and does not move it back mid-session', async () => {
    const { session, entries } = rig('plan');
    await session.runTurn({ prompt: 'leave-plan', sessionToken: 't' }, handlers());
    expect(session.permissionModes?.()?.current).toBe('acceptEdits');
    await session.runTurn({ prompt: 'hi', sessionToken: 't' }, handlers());
    expect(entries()).toEqual([{ set_mode: 'plan' }]);
  });

  it('puts the level back on a reloaded session, which comes back at its default', async () => {
    const { session, entries } = rig('edits', 's0');
    await session.runTurn({ prompt: 'hi', sessionToken: 't' }, handlers());
    expect(entries()).toEqual([{ set_mode: 'acceptEdits' }]);
  });

  it('does nothing to a session that has no child yet', async () => {
    const { session, entries } = rig('plan');
    await session.applyPermissions?.();
    expect(entries()).toEqual([]);
  });
});
