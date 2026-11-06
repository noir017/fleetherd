import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory, resolveHarness } from './agent-acp.js';
import { parseConfig, type AgentDef } from '../config/schema.js';
import { TurnFailure, type AgentSession, type AgentStreamHandlers, type AgentUsage } from './agent.js';
import type { AgyCliRunner } from './agy-cli.js';
import type { QuotaPool, ToolEvent } from '../types.js';

/**
 * `harness: agy` in the ACP runtime, driven against a fake `agy acp` that behaves the way agy 1.5.1
 * was measured to (project-scripts/talkcode-agy-acp/, 2026-11-06):
 *
 * - `configOptions.model` offers bare ids, the thinking level is a separate `thought_level` option
 *   that only Gemini has;
 * - `session/load` answers on the DEFAULT model, whatever the session was on;
 * - diagnostics arrive as `agent_message_chunk`s framed `"\n⚠ …\n"`, and a turn that got no model
 *   call through ends `end_turn` with no `usage`;
 * - usage comes once, in the prompt response, summed over the turn's model calls;
 * - a tool call of kind `other` is titled `Run <tool name>` (it also carries a `name` field, which
 *   the SDK strips before the gateway sees it).
 *
 * The fake is put on PATH as `agy` through the agent's own env, with HOME pointed at a temp dir so
 * nothing is linked into the real home. Every request it receives is logged for the assertions.
 */

const FAKE_AGY = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
// argv: [node, script, 'acp', LOG]
const LOG = process.argv[3];
const state = { model: 'gemini-3.8-flash', level: 'high' };
const options = () => [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model,
    options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  ...(state.model === 'gemini-3.8-flash'
    ? [{ id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: state.level,
         options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })) }]
    : []),
];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const text = (sid, t) => update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const warn = (sid, t) => text(sid, '\\n\\u26a0 ' + t + '\\n');
const usage = (input, cached) => ({ inputTokens: input, outputTokens: 10, cachedReadTokens: cached, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: input + cached + 10 });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return;
  fs.appendFileSync(LOG, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
  const sid = msg.params && msg.params.sessionId;
  if (msg.method === 'initialize') {
    return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] });
  }
  if (msg.method === 'session/new') return reply(msg.id, { sessionId: 'agy-1', configOptions: options() });
  // agy 1.5.1: a reload comes back on the default model, whatever the session was on.
  if (msg.method === 'session/load') {
    state.model = 'gemini-3.8-flash';
    return reply(msg.id, { sessionId: msg.params.sessionId, configOptions: options() });
  }
  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'model') state.model = msg.params.value;
    else if (msg.params.configId === 'thought_level') state.level = msg.params.value;
    return reply(msg.id, { configOptions: options() });
  }
  if (msg.method === 'session/prompt') {
    const p = msg.params.prompt.map((b) => b.text || '').join('');
    if (p === 'plain') {
      text(sid, 'hi');
      return reply(msg.id, { stopReason: 'end_turn', usage: usage(230, 5696) });
    }
    if (p === 'tool') {
      const call = { toolCallId: 'c1', name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', rawInput: { Prompt: 'echo SUB-OK' } };
      update(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
      update(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...call });
      const mcp = { toolCallId: 'c2', name: 'mcp_chat_send_file', kind: 'other', title: 'Run mcp_chat_send_file', rawInput: { path: 'a.png' } };
      update(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...mcp });
      update(sid, { sessionUpdate: 'tool_call_update', status: 'completed', ...mcp });
      text(sid, 'done');
      return reply(msg.id, { stopReason: 'end_turn', usage: usage(5601, 18176) });
    }
    if (p === 'quota') {
      warn(sid, 'You have exhausted your quota on this model.');
      return reply(msg.id, { stopReason: 'end_turn' });
    }
    if (p === 'retry') {
      warn(sid, 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.');
      warn(sid, 'API error (attempt 2): INTERNAL (code 500): Internal error encountered.');
      text(sid, 'recovered');
      return reply(msg.id, { stopReason: 'end_turn', usage: usage(300, 6000) });
    }
    if (p === 'invalid') {
      warn(sid, 'Model produced invalid output.');
      text(sid, 'ok');
      return reply(msg.id, { stopReason: 'end_turn', usage: usage(300, 6000) });
    }
    if (p === 'gave-up') {
      text(sid, 'Let me look.');
      warn(sid, 'API error (attempt 8): INTERNAL (code 500): Internal error encountered.');
      warn(sid, 'Agent execution terminated due to error.');
      return reply(msg.id, { stopReason: 'end_turn' });
    }
    return reply(msg.id, { stopReason: 'end_turn' });
  }
  if (msg.id !== undefined) reply(msg.id, {});
});
`;

const QUOTA_OUTPUT = [
  'Gemini Models\tWeekly Limit Remaining\t1%\t2026-11-07T04:24:11Z',
  'Claude and GPT models\tWeekly Limit Remaining\t99%\t2026-11-11T13:55:21Z',
].join('\n');

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: { model?: string; stored?: string; contextWindow?: number } = {}): {
  session: AgentSession;
  log: () => Array<{ method: string; params: Record<string, unknown> }>;
  writes: () => string[];
  quotaRuns: () => number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-agy-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const script = join(dir, 'fake-agy.cjs');
  const logPath = join(dir, 'requests.jsonl');
  writeFileSync(script, FAKE_AGY);
  writeFileSync(join(bin, 'agy'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(bin, 'agy'), 0o755);

  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      {
        id: 'agy',
        harness: 'agy',
        args: [logPath],
        cwd: dir,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
      },
    ],
    routing: { default: 'agy', pipeline: [] },
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

  let runs = 0;
  const cli: AgyCliRunner = async (name) => {
    runs++;
    return name === 'usage' ? { ok: true, output: QUOTA_OUTPUT } : { ok: false, error: `unexpected /${name}` };
  };
  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store, cli).getOrCreate('conv#1', 'agy');
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
  return { session, log, writes, quotaRuns: () => runs };
}

interface Recorded {
  handlers: AgentStreamHandlers;
  text: () => string;
  notices: string[];
  usage: AgentUsage[];
  quota: QuotaPool[][];
  tools: ToolEvent[];
}

function record(): Recorded {
  const chunks: string[] = [];
  const r: Recorded = {
    notices: [],
    usage: [],
    quota: [],
    tools: [],
    text: () => chunks.join(''),
    handlers: {
      onText: (t) => chunks.push(t),
      onToolStart: (e) => r.tools.push(e),
      onToolFinish: () => {},
      onSegmentBreak: () => {},
      onNotice: (t) => r.notices.push(t),
      onUsage: (u) => r.usage.push(u),
      onQuota: (q) => r.quota.push(q),
    },
  };
  return r;
}

const turn = (session: AgentSession, prompt: string, r: Recorded): Promise<void> =>
  session.runTurn({ prompt, sessionToken: 'tok' } as Parameters<AgentSession['runTurn']>[0], r.handlers);

describe('agy over ACP: launch', () => {
  it('is `agy acp` plus the agent’s own args, here and on a host', () => {
    const def = { harness: 'agy', args: ['--sandbox'] } as unknown as AgentDef;
    expect(resolveHarness(def)).toEqual({ command: 'agy', args: ['acp', '--sandbox'] });
    expect(resolveHarness(def, true)).toEqual({ command: 'agy', args: ['acp', '--sandbox'] });
  });
});

describe('agy over ACP: models', () => {
  it('splits a model named the `agy models` way into the model and its thinking level', async () => {
    const { session, writes } = rig({ model: 'gemini-3.8-flash-low' });
    await session.ensureSession!('tok');
    // Already on gemini-3.8-flash, so only the level is written — not refused as an unknown model.
    expect(writes()).toEqual(['thought_level=low']);
    expect(session.modelSelector!()?.current).toBe('gemini-3.8-flash');
    expect(session.effortSelector!()?.current).toBe('low');
  });

  it('puts the configured model back after session/load, which agy answers on its default', async () => {
    const { session, log, writes } = rig({ model: 'gpt-oss-120b-medium', stored: 'agy-old' });
    await session.ensureSession!('tok');
    const methods = log().map((r) => r.method);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/new');
    expect(writes()).toEqual(['model=gpt-oss-120b-medium']);
    expect(session.modelSelector!()?.current).toBe('gpt-oss-120b-medium');
  });
});

describe('agy over ACP: a turn', () => {
  it('reports the context of a one-call turn over the measured window, and the quota', async () => {
    const { session } = rig();
    const r = record();
    await turn(session, 'plain', r);
    expect(r.text()).toBe('hi');
    expect(r.usage).toEqual([{ used: 230 + 5696, size: 1_048_576 }]);
    const pools = r.quota.at(-1)!;
    expect(pools.map((p) => [p.id, p.active])).toEqual([
      ['3p-weekly', false],
      ['gemini-weekly', true],
    ]);
  });

  it('prefers a configured window to the table', async () => {
    const { session } = rig({ contextWindow: 200_000 });
    const r = record();
    await turn(session, 'plain', r);
    expect(r.usage).toEqual([{ used: 5926, size: 200_000 }]);
  });

  it('reports no context for a turn that ran tools, whose usage is a sum over several calls', async () => {
    const { session } = rig();
    const r = record();
    await turn(session, 'tool', r);
    expect(r.usage).toEqual([]);
    expect(r.text()).toBe('done');
  });

  it('labels a subagent as a Task and the gateway’s own MCP tool by its name', async () => {
    const { session } = rig();
    const r = record();
    await turn(session, 'tool', r);
    expect(r.tools.map((t) => t.name)).toEqual(['Task', 'send_file']);
  });

  it('asks for the quota at most once a minute', async () => {
    const { session, quotaRuns } = rig();
    await turn(session, 'plain', record());
    await turn(session, 'plain', record());
    expect(quotaRuns()).toBe(1);
  });
});

describe('agy over ACP: its warnings', () => {
  it('fails a turn that ended in one — a spent quota is not an answer', async () => {
    const { session } = rig();
    const r = record();
    const err = await turn(session, 'quota', r).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TurnFailure);
    expect((err as TurnFailure).reason).toBe('provider');
    expect((err as Error).message).toContain('You have exhausted your quota on this model.');
    expect(r.text()).toBe('');
    expect(r.notices).toEqual([]);
  });

  it('fails a turn whose retries ran out, even after it had started to answer', async () => {
    const { session } = rig();
    const err = await turn(session, 'gave-up', record()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('Agent execution terminated due to error.');
  });

  it('says a retry once, as a notice, and keeps it out of the reply', async () => {
    const { session } = rig();
    const r = record();
    await turn(session, 'retry', r);
    expect(r.text()).toBe('recovered');
    expect(r.notices).toEqual([
      '⚠️ agy hit an error and is retrying: API error (attempt 1): INTERNAL (code 500): Internal error encountered.',
    ]);
  });

  it('says a warning the agent got past as recovered, at the end of the turn', async () => {
    const { session } = rig();
    const r = record();
    await turn(session, 'invalid', r);
    expect(r.text()).toBe('ok');
    expect(r.notices).toEqual(['⚠️ agy hit an error and recovered: Model produced invalid output.']);
  });
});
