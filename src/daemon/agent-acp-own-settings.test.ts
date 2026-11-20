import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import { createAcpAgentFactory, customOptionsOf, translateUpdate, type TurnState } from './agent-acp.js';
import { parseConfig } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import type { SessionOption } from '../types.js';

/**
 * The agent's own settings (SessionOption): ACP `select` config options in a `_` category, which
 * the spec leaves to the agent. The shape is the one a web agent driver reports for the account
 * a session runs on — every account while the conversation has not started, only the current one
 * once it has, and a refusal in its own words when asked to change it then.
 *
 * Two things are guarded here. Only those options are picked out: the model, effort and mode have
 * paths of their own, and an option in a category the gateway does not handle (`model_config`,
 * which claude-agent-acp reports) or with none at all must not grow a button. And nothing is
 * remembered: the agent keeps its setting across a reload, so the gateway never sends it back.
 */

describe('customOptionsOf', () => {
  const opts = (o: unknown): SessionConfigOption[] => o as SessionConfigOption[];
  const select = (id: string, category: string | undefined, current = 'a') => ({
    id,
    name: id.toUpperCase(),
    ...(category !== undefined ? { category } : {}),
    type: 'select',
    currentValue: current,
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'quota used up' }],
  });

  it('keeps only select options in a custom category', () => {
    const got = customOptionsOf(
      opts([
        select('model', 'model'),
        select('effort', 'thought_level'),
        select('mode', 'mode'),
        select('model_config', 'model_config'),
        select('plain', undefined),
        { id: 'flag', name: 'Flag', category: '_flag', type: 'boolean', currentValue: true },
        select('account', '_account'),
      ])
    );
    expect(got).toEqual([
      {
        id: 'account',
        name: 'ACCOUNT',
        current: 'a',
        options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'quota used up' }],
      },
    ]);
  });

  it('flattens grouped choices, falls back to the value for a blank name, and drops an option with none', () => {
    const got = customOptionsOf(
      opts([
        {
          id: 'region', name: 'Region', category: '_region', type: 'select', currentValue: 'eu',
          options: [{ group: 'g', name: 'G', options: [{ value: 'eu', name: '' }, { value: 'us', name: 'US' }] }],
        },
        { id: 'empty', name: 'Empty', category: '_empty', type: 'select', currentValue: 'x', options: [] },
      ])
    );
    expect(got).toEqual([{ id: 'region', name: 'Region', current: 'eu', options: [{ value: 'eu', name: 'eu' }, { value: 'us', name: 'US' }] }]);
    expect(customOptionsOf(undefined)).toEqual([]);
  });

  it('is reported on every config_option_update, an empty set included', () => {
    const seen: SessionOption[][] = [];
    const st: TurnState = {
      handlers: { onText: () => {}, onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {}, onOptions: (o) => seen.push(o) },
      lastSegment: 'none',
      toolLedger: new Map(),
      toolIndexSeq: 0,
    };
    const feed = (configOptions: unknown): void =>
      translateUpdate({ sessionUpdate: 'config_option_update', configOptions } as SessionUpdate, st);
    feed([select('account', '_account')]);
    // Locked: the agent lists only the value it is on.
    feed([{ ...select('account', '_account', 'b'), options: [{ value: 'b', name: 'B' }] }]);
    feed([select('model', 'model')]);
    expect(seen.map((s) => s.map((o) => `${o.id}=${o.current}/${o.options.length}`))).toEqual([['account=a/2'], ['account=b/1'], []]);
  });
});

/**
 * A fake agent with an account setting that locks on the first prompt and announces it, and the
 * other kinds of option beside it. Every request it receives is appended to a log file.
 */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];

const ACCOUNTS = [{ value: 'work', name: 'Work' }, { value: 'home', name: 'Home', description: '5-hour limit used up' }];
// The fake's own record of its sessions, as the real agent keeps one: it survives the child only in
// the sense the tests need — a reload of a started conversation comes back locked on its account.
const state = { account: process.argv[3] || 'work', started: process.argv[4] === 'started' };

const options = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
  { id: 'model_config', name: 'Config', category: 'model_config', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }, { value: 'y', name: 'Y' }] },
  { id: 'account', name: 'Account', category: '_account', type: 'select', currentValue: state.account,
    options: state.started ? ACCOUNTS.filter((a) => a.value === state.account) : ACCOUNTS },
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
  if (msg.method === 'session/load') return reply(msg.id, { configOptions: options() });
  if (msg.method === 'session/set_config_option') {
    const { configId, value } = msg.params;
    if (configId === 'account') {
      if (state.started) return fail(msg.id, 'This conversation already started on ' + state.account + '; its account cannot change.');
      if (!ACCOUNTS.some((a) => a.value === value)) return fail(msg.id, 'No account named ' + value + '.');
      state.account = value;
    }
    return reply(msg.id, { configOptions: options() });
  }
  if (msg.method === 'session/prompt') {
    state.started = true;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: options() } } });
    return reply(msg.id, { stopReason: 'end_turn' });
  }
  if (msg.id !== undefined) reply(msg.id, {});
});
`;

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: { account?: string; started?: boolean; stored?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-settings-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  const logPath = join(dir, 'requests.jsonl');
  writeFileSync(script, FAKE_AGENT);
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'fake',
        harness: 'custom',
        command: process.execPath,
        args: [script, logPath, opts.account ?? '', opts.started ? 'started' : ''],
        cwd: dir,
      },
    ],
    routing: { default: 'fake', pipeline: [] },
  });
  let stored: string | undefined = opts.stored;
  const store = {
    agentSession: () => stored,
    setAgentSession: (_c: string, _a: string, id: string) => {
      stored = id;
    },
    conversationCwd: () => undefined,
    conversationChoice: () => undefined,
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
  const accountWrites = () =>
    log()
      .filter((r) => r.method === 'session/set_config_option' && r.params.configId === 'account')
      .map((r) => String(r.params.value));
  return { session, log, accountWrites };
}

function collector(): { handlers: AgentStreamHandlers; seen: SessionOption[][] } {
  const seen: SessionOption[][] = [];
  return {
    seen,
    handlers: { onText: () => {}, onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {}, onOptions: (o) => seen.push(o) },
  };
}

const brief = (s: SessionOption[] | undefined) => (s ?? []).map((o) => `${o.id}=${o.current}/${o.options.map((c) => c.value).join(',')}`);

describe('the agent’s own settings on a live session', () => {
  it('reads them off the started session, nothing else among its options', async () => {
    const { session } = rig();
    expect(session.sessionOptions!()).toBeUndefined();
    await session.ensureSession!('tok');
    expect(session.sessionOptions!()).toEqual([
      {
        id: 'account',
        name: 'Account',
        current: 'work',
        options: [{ value: 'work', name: 'Work' }, { value: 'home', name: 'Home', description: '5-hour limit used up' }],
      },
    ]);
  });

  it('sets one through session/set_config_option and returns the set the agent reports', async () => {
    const { session, accountWrites } = rig();
    await session.ensureSession!('tok');
    expect(brief(await session.setOption!('account', 'home'))).toEqual(['account=home/work,home']);
    expect(accountWrites()).toEqual(['home']);
    expect(session.sessionOptions!()?.[0]?.current).toBe('home');
  });

  it('reports them as a turn starts, and again when the agent locks one mid-turn', async () => {
    const { session } = rig();
    const c = collector();
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, c.handlers);
    expect(c.seen.map(brief)).toEqual([['account=work/work,home'], ['account=work/work']]);
    expect(brief(session.sessionOptions!())).toEqual(['account=work/work']);
  });

  it('passes the agent’s refusal on in its own words', async () => {
    const { session } = rig();
    await session.runTurn({ prompt: 'hello', sessionToken: 'tok' }, collector().handlers);
    await expect(session.setOption!('account', 'home')).rejects.toThrow('This conversation already started on work; its account cannot change.');
  });

  it('refuses an option that is not one of the agent’s own, without asking the agent', async () => {
    const { session, log } = rig();
    await session.ensureSession!('tok');
    await expect(session.setOption!('model', 'm2')).rejects.toThrow('the agent offers no setting "model"');
    await expect(session.setOption!('model_config', 'y')).rejects.toThrow('the agent offers no setting "model_config"');
    expect(log().filter((r) => r.method === 'session/set_config_option')).toEqual([]);
  });

  it('refuses with no live session rather than remembering the pick for later', async () => {
    const { session, log } = rig();
    await expect(session.setOption!('account', 'home')).rejects.toThrow('no live session');
    expect(log()).toEqual([]);
  });
});

describe('nothing is remembered across a reload', () => {
  it('sends nothing back after a reclaim: the reloaded session reports its own setting', async () => {
    // The agent's record says this conversation started on `home`; the gateway's last pick was
    // `home` too, but it is the agent's answer to session/load that the strip shows.
    const { session, log, accountWrites } = rig({ account: 'home', started: true, stored: 's1' });
    await session.ensureSession!('tok');
    expect(log().filter((r) => r.method === 'session/load')).toHaveLength(1);
    session.dispose(); // what the idle sweeper does
    const c = collector();
    await session.runTurn({ prompt: 'again', sessionToken: 'tok' }, c.handlers);
    expect(log().filter((r) => r.method === 'session/load')).toHaveLength(2);
    expect(accountWrites()).toEqual([]);
    expect(c.seen[0]?.map((o) => o.current)).toEqual(['home']);
  });
});
