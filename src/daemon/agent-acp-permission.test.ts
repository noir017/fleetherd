import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestError, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { createAcpAgentFactory, PERMISSION_DECLINED_CODE, permissionResponse, permissionRequestOf } from './agent-acp.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import type { AgentPermissionRequest, PermissionAnswer } from '../types.js';

/**
 * `permissions: ask` on the ACP side: what each PermissionAnswer becomes on the wire, and that the
 * runtime asks through the right handlers — the turn's, or with no turn open a background burst's.
 *
 * The point of the whole feature is in the `unanswered` case: a request nobody answered must reach
 * the model as exactly that, never as the user refusing. That travels as a JSON-RPC error message,
 * which only works because of two things outside this repo — both pinned by the contract tests.
 */

const REQUEST: RequestPermissionRequest = {
  sessionId: 's1',
  toolCall: { toolCallId: 't1', title: '`touch probe-file.txt`' },
  options: [
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
};

describe('permissionRequestOf', () => {
  it('shows the tool call title without its code ticks, and the options by name', () => {
    expect(permissionRequestOf(REQUEST)).toEqual({
      title: 'touch probe-file.txt',
      options: [
        { optionId: 'allow-once', label: 'Allow' },
        { optionId: 'reject', label: 'Reject' },
      ],
    });
  });

  it('names agy’s generic MCP call instead of its `Bash` title', () => {
    // Same frame as the tool row (agent-acp-agy.test.ts): kind execute, title Bash.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't2',
        title: 'Bash',
        kind: 'execute',
        rawInput: { ServerName: 'notes-server', ToolName: 'list_notes', Arguments: {} },
      },
    };
    expect(permissionRequestOf(req).title).toBe('MCP list_notes — notes-server');
  });
});

describe('permissionResponse', () => {
  const thrown = (answer: PermissionAnswer): RequestError => {
    try {
      permissionResponse(REQUEST, answer);
    } catch (e) {
      return e as RequestError;
    }
    throw new Error('did not throw');
  };

  it('sends back the option the user picked', () => {
    expect(permissionResponse(REQUEST, { kind: 'selected', optionId: 'reject' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('answers an unattended run as permissions: auto would', () => {
    expect(permissionResponse(REQUEST, { kind: 'unattended' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('cancels with the turn', () => {
    expect(permissionResponse(REQUEST, { kind: 'cancelled' })).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('declines an unanswered request as an error that says nobody answered — not that the user refused', () => {
    const e = thrown({ kind: 'unanswered', waitedMs: 3_600_000 });
    expect(e).toBeInstanceOf(RequestError);
    expect(e.code).toBe(PERMISSION_DECLINED_CODE);
    expect(e.message).toContain('No one answered this permission request within 60 minutes');
    expect(e.message).toContain('This is not a refusal');
    // Never the reject option: claude-agent-acp turns that into "User refused permission".
    expect(e.message).not.toMatch(/refused permission/i);
  });

  it('declines one that could not be asked, saying why', () => {
    const e = thrown({ kind: 'unavailable', why: 'wecom cannot show buttons' });
    expect(e.code).toBe(PERMISSION_DECLINED_CODE);
    expect(e.message).toContain('could not be shown to the user (wecom cannot show buttons)');
    expect(e.message).toContain('not a refusal by the user');
  });
});

describe('contracts the unanswered message depends on', () => {
  it('the ACP SDK keeps a RequestError\'s own message on the wire (any other error becomes "Internal error")', () => {
    const wire = new RequestError(PERMISSION_DECLINED_CODE, 'No one answered').toErrorResponse();
    expect(wire).toMatchObject({ code: PERMISSION_DECLINED_CODE, message: 'No one answered' });
  });

  it('the installed claude-agent-acp rethrows a failed permission request to the model (not a fixed "aborted")', () => {
    // Hyrum's Law guard: measured 2026-10-28 against 0.81.2, the model read our error message
    // verbatim. If the adapter starts swallowing it, unanswered requests become anonymous
    // failures again — fail here, and re-measure, instead.
    const dist = readFileSync(
      createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
      'utf8'
    );
    const at = dist.indexOf('async requestPermissionFromClient(');
    expect(at).toBeGreaterThan(0);
    const body = dist.slice(at, at + 2500);
    expect(body).toMatch(/catch \(error\) \{\s*if \(signal\.aborted\) \{[\s\S]*?\}\s*throw error;/);
  });
});

// ─────────────────────────────── against a real child process ───────────────────────────────

/**
 * Asks one permission per prompt (`ask`), or one after replying (`bg` — background work asking with
 * no turn open), and writes the client's answer — result or error — to the log, one JSON line each.
 */
const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const fs = require('node:fs');
const LOG = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const pending = new Map();
let n = 0;
const askPermission = (sessionId) => new Promise((resolve) => {
  const id = 'perm-' + (++n);
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId,
    toolCall: { toolCallId: 'tc' + n, title: 'touch probe-file.txt' },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  } });
}).then((answer) => fs.appendFileSync(LOG, JSON.stringify(answer) + '\\n'));
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method && pending.has(msg.id)) {
    const done = pending.get(msg.id);
    pending.delete(msg.id);
    return done(msg.error ? { error: { code: msg.error.code, message: msg.error.message } } : { result: msg.result });
  }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt[0].text;
    if (text === 'ask') await askPermission('s1');
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    if (text === 'bg') setTimeout(() => askPermission('s1'), 100);
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(permissions: 'auto' | 'ask', turnTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-perm-'));
  const script = join(dir, 'fake.cjs');
  const log = join(dir, 'answers');
  writeFileSync(script, FAKE_AGENT);
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [script, log], cwd: dir, permissions }],
    routing: { default: 'fake', pipeline: [] },
  });
  const cfg: Config = turnTimeoutMs ? { ...parsed, session: { ...parsed.session, turnTimeoutMs } } : parsed;
  const store = { agentSession: () => undefined, setAgentSession: () => {}, conversationCwd: () => undefined } as unknown as Parameters<
    typeof createAcpAgentFactory
  >[2];
  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  const answers = (): unknown[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { session, answers };
}

const handlers = (onPermission?: (r: AgentPermissionRequest) => Promise<PermissionAnswer>): AgentStreamHandlers => ({
  onText: () => {},
  onToolStart: () => {},
  onToolFinish: () => {},
  onSegmentBreak: () => {},
  ...(onPermission ? { onPermission } : {}),
});

describe('the ACP runtime answering session/request_permission', () => {
  it('approves without asking under permissions: auto, the default', async () => {
    const { session, answers } = rig('auto');
    let asked = 0;
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async () => (asked++, { kind: 'cancelled' })));
    expect(asked).toBe(0);
    expect(answers()).toEqual([{ result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }]);
  });

  it('asks under permissions: ask, and sends back what the user picked', async () => {
    const { session, answers } = rig('ask');
    const seen: AgentPermissionRequest[] = [];
    await session.runTurn(
      { prompt: 'ask', sessionToken: 't' },
      handlers(async (r) => (seen.push(r), { kind: 'selected', optionId: 'reject' }))
    );
    expect(seen.map((r) => r.title)).toEqual(['touch probe-file.txt']);
    expect(answers()).toEqual([{ result: { outcome: { outcome: 'selected', optionId: 'reject' } } }]);
  });

  it('declines an unanswered request with an error the agent can read', async () => {
    const { session, answers } = rig('ask');
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers(async () => ({ kind: 'unanswered', waitedMs: 3_600_000 })));
    const [answer] = answers() as Array<{ error: { code: number; message: string } }>;
    expect(answer!.error.code).toBe(PERMISSION_DECLINED_CODE);
    expect(answer!.error.message).toContain('No one answered');
  });

  it('never approves when there is no way to ask', async () => {
    const { session, answers } = rig('ask');
    await session.runTurn({ prompt: 'ask', sessionToken: 't' }, handlers());
    const [answer] = answers() as Array<{ error: { message: string } }>;
    expect(answer!.error.message).toContain('could not be shown to the user (no chat to ask in)');
  });

  it('does not let the silence watchdog fail a turn while the user reads the request', async () => {
    // The watchdog has to cover the startup before the request arrives (a loaded CI box spends
    // hundreds of ms there), and the answer has to come well after it would have fired.
    const { session, answers } = rig('ask', 1500);
    await session.runTurn(
      { prompt: 'ask', sessionToken: 't' },
      handlers(() => new Promise((r) => setTimeout(() => r({ kind: 'selected', optionId: 'allow-once' }), 2500)))
    );
    expect(answers()).toHaveLength(1);
  });

  it('asks background work through the follow-up sink when no turn is open', async () => {
    const { session, answers } = rig('ask');
    const seen: string[] = [];
    session.setFollowUpSink?.({
      handlers: () => handlers(async (r) => (seen.push(r.title), { kind: 'selected', optionId: 'allow-once' })),
      close: async () => {},
    });
    await session.runTurn({ prompt: 'bg', sessionToken: 't' }, handlers(async () => ({ kind: 'cancelled' })));
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual(['touch probe-file.txt']);
    expect(answers()).toEqual([{ result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }]);
  });
});
