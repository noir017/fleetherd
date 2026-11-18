import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestError, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { createAcpAgentFactory, decidePermission, PERMISSION_DECLINED_CODE, permissionResponse, permissionRequestOf } from './agent-acp.js';
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

  it('carries the diff of an edit, so the card asks about the change and not just its name', () => {
    // As claude-agent-acp 0.81.2 sends an Edit (measured 2026-11-18).
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't3',
        title: 'Edit src/app.ts',
        kind: 'edit',
        content: [
          { type: 'diff', path: '/w/src/app.ts', oldText: 'const PORT = 3000;\n', newText: 'const PORT = 8080;\n' },
        ],
        locations: [{ path: '/w/src/app.ts' }],
        rawInput: { file_path: '/w/src/app.ts', old_string: 'PORT = 3000', new_string: 'PORT = 8080' },
      },
    };
    expect(permissionRequestOf(req)).toMatchObject({
      title: 'Edit src/app.ts',
      detail: '--- /w/src/app.ts\n+++ /w/src/app.ts\n-const PORT = 3000;\n+const PORT = 8080;',
    });
  });

  it('names a titleless CodeBuddy request and shows what its Write will put in the file', () => {
    // Exactly the frame codebuddy 2.181.0 sent on 2026-11-18: no title, no kind, no content —
    // the tool's name in _meta and the change in rawInput. It used to reach the user as a bare
    // path, with nothing saying it was a write and nothing saying what would be written.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't4',
        rawInput: { file_path: '/w/hello.txt', content: 'banana\n' },
        _meta: { 'codebuddy.ai/toolName': 'Write' },
      },
    };
    expect(permissionRequestOf(req)).toMatchObject({
      title: 'Write: /w/hello.txt',
      detail: 'banana',
    });
  });

  it('reads the verb off the arguments when the request names nothing at all', () => {
    // The same CodeBuddy frame without the _meta hint: a file_path beside content is a write, and
    // a bare path was the card that said nothing about what was about to happen to it.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: { toolCallId: 't7', rawInput: { file_path: '/w/hello.txt', content: 'banana\n' } },
    };
    expect(permissionRequestOf(req)).toMatchObject({ title: 'Write: /w/hello.txt', detail: 'banana' });
  });

  it('leaves a bare file path alone rather than calling it an edit', () => {
    // A read (or a delete) asks with nothing but a path. Calling that `Edit:` would tell the user
    // the agent is about to change a file it only wants to look at.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: { toolCallId: 't8', rawInput: { file_path: '/w/a.txt' } },
    };
    expect(permissionRequestOf(req)).toEqual({
      title: '/w/a.txt',
      options: [
        { optionId: 'allow-once', label: 'Allow' },
        { optionId: 'reject', label: 'Reject' },
      ],
    });
  });

  it('shows a titleless edit’s own change, which is where CodeBuddy puts the diff', () => {
    // CodeBuddy's Edit: no title, no kind, no `content` — `{file_path, old_string, new_string}`.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't9',
        rawInput: { file_path: '/w/src/app.ts', old_string: 'const PORT = 3000;', new_string: 'const PORT = 8080;' },
      },
    };
    expect(permissionRequestOf(req)).toMatchObject({
      title: 'Edit: /w/src/app.ts',
      detail: '--- /w/src/app.ts\n+++ /w/src/app.ts\n-const PORT = 3000;\n+const PORT = 8080;',
    });
  });

  it('takes the tool name from `_meta` even when the arguments alone would say nothing', () => {
    // The name is the only thing that distinguishes a read from an edit here, so this is the test
    // that pins the `_meta` read itself: without it the card falls back to the bare path.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't10',
        rawInput: { file_path: '/w/a.txt' },
        _meta: { 'codebuddy.ai/toolName': 'Read' },
      },
    };
    expect(permissionRequestOf(req)).toMatchObject({ title: 'Read: /w/a.txt' });
  });

  it('says what an ExitPlanMode request is about, not its raw JSON', () => {
    // The frame codebuddy 2.181.0 sent in plan mode on 2026-11-18, verbatim but for the ids: no
    // title, no kind, the tool named in `_meta`, and the plan the user must read also in `_meta`.
    const plan = '# Plan: create planwrite.txt\n\n## Steps\n1. Write the file.\n2. Reply done.';
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't11',
        rawInput: {},
        _meta: {
          'codebuddy.ai/toolName': 'ExitPlanMode',
          'codebuddy.ai/planFilePath': '/h/.codebuddy/plans/plan.md',
          'codebuddy.ai/plan': plan,
        },
      },
      options: [
        { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject_and_exit_plan', name: 'Exit plan mode', kind: 'reject_once' },
      ],
    };
    expect(permissionRequestOf(req)).toMatchObject({
      title: 'Exit plan mode',
      detail: plan,
      options: [
        { optionId: 'allow_always', label: 'Always Allow' },
        { optionId: 'allow', label: 'Allow' },
        { optionId: 'reject', label: 'Reject' },
        { optionId: 'reject_and_exit_plan', label: 'Exit plan mode' },
      ],
    });
  });

  it('names the prompts an ExitPlanMode request wants pre-approved when there is no plan text', () => {
    // The other frame the same harness sent: `allowedPrompts` and nothing else.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't12',
        rawInput: { allowedPrompts: [{ tool: 'Bash', prompt: 'run echo redirect to create cmd.txt' }] },
        _meta: { 'codebuddy.ai/toolName': 'ExitPlanMode' },
      },
    };
    expect(permissionRequestOf(req)).toMatchObject({
      title: 'Exit plan mode',
      detail: 'Bash: run echo redirect to create cmd.txt',
    });
  });

  it('does not repeat a shell call’s description as its change', () => {
    // claude-agent-acp puts the Bash call's own description in `content`; the command is the title.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't5',
        title: 'npm test',
        kind: 'execute',
        content: [{ type: 'content', content: { type: 'text', text: 'Run the unit tests' } }],
        rawInput: { command: 'npm test', description: 'Run the unit tests' },
      },
    };
    expect(permissionRequestOf(req)).toEqual({
      title: 'npm test',
      options: [
        { optionId: 'allow-once', label: 'Allow' },
        { optionId: 'reject', label: 'Reject' },
      ],
    });
  });

  it('bounds the change preview, saying how much it left out', () => {
    const big = 'x'.repeat(5000);
    const req: RequestPermissionRequest = {
      ...REQUEST,
      toolCall: {
        toolCallId: 't6',
        title: 'Write big.txt',
        kind: 'edit',
        content: [{ type: 'diff', path: '/w/big.txt', oldText: null, newText: big }],
      },
    };
    const detail = permissionRequestOf(req).detail ?? '';
    expect(detail.length).toBeLessThan(1_400);
    expect(detail).toContain('more characters)');
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

  it('answers a harness whose option ids are its own (codex: accept / acceptForSession / cancel)', () => {
    // Measured on codex-acp 2.5.0: the ids carry no meaning a client may rely on, so the kind is
    // what `auto` picks and what a tapped button's own id echoes back.
    const req: RequestPermissionRequest = {
      ...REQUEST,
      options: [
        { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
        { optionId: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    };
    expect(decidePermission(req)).toEqual({ outcome: { outcome: 'selected', optionId: 'accept' } });
    expect(permissionResponse(req, { kind: 'selected', optionId: 'acceptForSession' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'acceptForSession' },
    });
    expect(permissionRequestOf(req).options).toEqual([
      { optionId: 'accept', label: 'Allow' },
      { optionId: 'acceptForSession', label: 'Allow for this session' },
      { optionId: 'cancel', label: 'Reject' },
    ]);
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
