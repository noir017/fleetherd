import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type AgentDef, type Config } from '../config/schema.js';
import { expandEnvVars } from '../config/env-expand.js';
import {
  CLAUDE_NO_TOOLS_META,
  acpReviewLaunch,
  apiReviewAnswer,
  apiReviewBody,
  chatCompletionsUrl,
  refusePermission,
  reviewerOf,
  runAcpReview,
  runApiReview,
  type Reviewer,
} from './review-run.js';

/**
 * The reviewer's routes without a model: the switches each harness is launched with, the api
 * request and its answer against a stubbed fetch, and the ACP session against a fake agent — a
 * plain NDJSON JSON-RPC process written below — so what the gateway sends and refuses is seen
 * from the agent's side.
 */

function agent(over: Partial<AgentDef> & Pick<AgentDef, 'id' | 'harness'>): AgentDef {
  return { args: [], env: {}, ...over } as AgentDef;
}

function config(review: unknown, agents: unknown[] = []): Config {
  return parseConfig({
    platforms: { telegram: { type: 'telegram', token: 'x' } },
    agents: [{ id: 'cc', harness: 'claude', model: 'opus' }, ...agents],
    routing: { default: 'cc' },
    review,
  });
}

describe('acpReviewLaunch', () => {
  it('claude: no built-in tools, no settings, MCP from the request alone', () => {
    const launch = acpReviewLaunch(agent({ id: 'cc', harness: 'claude' }), true);
    expect(launch.command).toBe('claude-agent-acp');
    expect(launch.env).toEqual({});
    expect(launch.meta).toEqual(CLAUDE_NO_TOOLS_META);
    expect(launch.meta).toMatchObject({
      claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true } },
    });
  });

  it('codex: the shell off inside the agent’s own CODEX_CONFIG, and read-only over its mode', () => {
    const def = agent({
      id: 'cx',
      harness: 'codex',
      env: {
        INITIAL_AGENT_MODE: 'agent-full-access',
        CODEX_CONFIG: JSON.stringify({ model: 'gpt-x', features: { shell_tool: true, goals: true } }),
      },
    });
    const launch = acpReviewLaunch(def, false);
    expect(launch.command).toBe('codex-acp');
    expect(launch.env.INITIAL_AGENT_MODE).toBe('read-only');
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({
      model: 'gpt-x',
      features: { shell_tool: false, unified_exec: false, goals: true },
    });
    expect(launch.meta).toBeUndefined();
  });

  it('codex: an unreadable CODEX_CONFIG of the agent’s still gets the switches', () => {
    const launch = acpReviewLaunch(agent({ id: 'cx', harness: 'codex', env: { CODEX_CONFIG: '{not json' } }), false);
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({ features: { shell_tool: false, unified_exec: false } });
  });

  it('opencode: every permission denied inline, over whatever inline config it had', () => {
    const def = agent({ id: 'oc', harness: 'opencode', env: { OPENCODE_CONFIG_CONTENT: '{"model":"newapi/x","permission":{"bash":"allow"}}' } });
    const launch = acpReviewLaunch(def, false);
    expect(launch).toMatchObject({ command: 'opencode', args: ['acp'] });
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: 'newapi/x', permission: 'deny' });
  });

  it('custom, gemini and dsh: their own command with review.args appended, nothing else', () => {
    const cur = agent({ id: 'cur', harness: 'custom', command: '/opt/cursor-agent', args: ['acp'] });
    expect(acpReviewLaunch(cur, false, ['--mode', 'ask'])).toEqual({
      command: '/opt/cursor-agent',
      args: ['acp', '--mode', 'ask'],
      env: {},
    });
    expect(acpReviewLaunch(agent({ id: 'g', harness: 'gemini' }), false, ['--x']).args).toEqual(['--experimental-acp', '--x']);
    expect(acpReviewLaunch(agent({ id: 'd', harness: 'dsh' }), false, ['--x']).args).toEqual(['--profile', 'acp', '--x']);
  });

  it('agy is not an ACP review', () => {
    expect(() => acpReviewLaunch(agent({ id: 'ag', harness: 'agy' }), false)).toThrow(/agy -p/);
  });
});

describe('reviewerOf', () => {
  it('is undefined without a block', () => {
    expect(reviewerOf(config(undefined))).toBeUndefined();
  });

  it('an agent: its model unless review.model says otherwise', () => {
    expect(reviewerOf(config({ agent: 'cc' }))).toMatchObject({ kind: 'agent', id: 'cc', host: '', model: 'opus', args: [] });
    expect(reviewerOf(config({ agent: 'cc', model: 'sonnet' }))).toMatchObject({ model: 'sonnet' });
  });

  it('an endpoint: signed as api:<model>', () => {
    const r = reviewerOf(config({ api: { url: 'http://newapi:3000/v1', key: 'k', model: 'gemini-3.8-flash' } }));
    expect(r).toEqual({ kind: 'api', id: 'api:gemini-3.8-flash', host: '', url: 'http://newapi:3000/v1', key: 'k', model: 'gemini-3.8-flash' });
  });

  it('args reach a custom reviewer only', () => {
    const cfg = config({ agent: 'cur', args: ['--mode', 'ask'] }, [{ id: 'cur', harness: 'custom', command: 'x' }]);
    expect(reviewerOf(cfg)).toMatchObject({ args: ['--mode', 'ask'] });
    // Built in memory past the schema: still not handed to a harness with switches of its own.
    const forged = { ...config({ agent: 'cc' }), review: { agent: 'cc', args: ['--dangerously-skip-permissions'] } };
    expect(reviewerOf(forged)).toMatchObject({ args: [] });
  });

  it('an agent that is gone is no reviewer', () => {
    const cfg = config({ agent: 'cc' });
    expect(reviewerOf({ ...cfg, review: { agent: 'nobody' } })).toBeUndefined();
  });
});

describe('refusePermission', () => {
  it('picks the harness’s own reject, once before always', () => {
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'never', name: 'Never', kind: 'reject_always' as const },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(refusePermission({ options })).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(refusePermission({ options: options.slice(0, 2) })).toEqual({ outcome: { outcome: 'selected', optionId: 'never' } });
  });

  it('cancels when there is no reject to pick — never an allow', () => {
    expect(refusePermission({ options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('the api route', () => {
  const reviewer: Extract<Reviewer, { kind: 'api' }> = {
    kind: 'api',
    id: 'api:m',
    host: '',
    url: 'http://newapi:3000/v1/',
    key: 'sk-test',
    model: 'm',
  };
  const reply = (body: unknown, status = 200): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('builds the endpoint from a base, and keeps one that already names it', () => {
    expect(chatCompletionsUrl('http://newapi:3000/v1/')).toBe('http://newapi:3000/v1/chat/completions');
    expect(chatCompletionsUrl('https://x/v1/chat/completions')).toBe('https://x/v1/chat/completions');
  });

  it('sends the prompt as one user message with the key, and reads the answer', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return reply({ choices: [{ message: { content: ' {"changes":[]} ' }, finish_reason: 'stop' }] });
    }) as unknown as typeof fetch;
    const run = await runApiReview(reviewer, 'PROMPT', fetchStub);
    expect(run).toEqual({ ok: true, output: '{"changes":[]}' });
    expect(seen[0]!.url).toBe('http://newapi:3000/v1/chat/completions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(apiReviewBody('m', 'PROMPT'));
    expect(apiReviewBody('m', 'PROMPT')).toEqual({ model: 'm', messages: [{ role: 'user', content: 'PROMPT' }], stream: false });
  });

  it('a non-2xx is a failure with the body, and a 503 for capacity is said to be one', async () => {
    const busy = (async () =>
      reply({ error: { message: 'UNAVAILABLE (code 503): No capacity available for model m' } }, 503)) as unknown as typeof fetch;
    const run = await runApiReview(reviewer, 'p', busy);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error).toContain('HTTP 503');
      expect(run.error).toContain('No capacity available');
      expect(run.error).not.toContain('sk-test');
    }
    const denied = (async () => reply('{"error":"bad key"}', 401)) as unknown as typeof fetch;
    expect(await runApiReview(reviewer, 'p', denied)).toEqual({ ok: false, error: 'api m: HTTP 401 {"error":"bad key"}' });
  });

  it('a request that outlives the review is capacity, like any other route’s timeout', async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const run = await runApiReview(reviewer, 'p', slow, 20);
    expect(run).toMatchObject({ ok: false, capacity: true });
  });

  it('an answer with no text fails with its finish reason; text parts are joined', () => {
    expect(apiReviewAnswer({ choices: [{ message: { content: null }, finish_reason: 'length' }] })).toEqual({
      ok: false,
      error: 'the endpoint answered no text (finish_reason length)',
    });
    expect(apiReviewAnswer({ choices: [] }).ok).toBe(false);
    expect(apiReviewAnswer({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })).toEqual({
      ok: true,
      output: 'ab',
    });
  });
});

/**
 * A fake ACP agent: JSON-RPC over NDJSON, no SDK. On a prompt it asks permission for a write, then
 * answers with what it saw — its argv, its directory, the session/new params, the model it was set
 * to and the permission outcome — or, by FAKE_MODE, cancels the turn, exits, or never answers.
 */
const FAKE_AGENT = String.raw`
const fs = require('node:fs');
const mode = process.env.FAKE_MODE || 'answer';
const seen = { argv: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), env: process.env.FAKE_ENV_PROBE };
let buf = '';
let next = 100;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const model = (current) => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
  options: [{ value: 'm-default', name: 'Default' }, { value: 'm-review', name: 'Review' }] }];
async function handle(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') { seen.newSession = m.params; return send({ id: m.id, result: { sessionId: 's1', configOptions: model('m-default') } }); }
  if (m.method === 'session/set_config_option') { seen.model = m.params.value; return send({ id: m.id, result: { configOptions: model(m.params.value) } }); }
  if (m.method === 'session/prompt') {
    if (mode === 'hang') return;
    if (mode === 'exit') process.exit(3);
    const r = await ask('session/request_permission', { sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'Write notes.md', kind: 'edit', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    seen.permission = r.outcome;
    if (mode === 'cancel') return send({ id: m.id, result: { stopReason: 'cancelled' } });
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seen) } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no ' + m.method } });
}
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); continue; }
    handle(m);
  }
});
`;

describe('the acp route, against a fake agent', () => {
  let dir: string;
  let fake: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-run-'));
    fake = path.join(dir, 'fake-agent.cjs');
    fs.writeFileSync(fake, FAKE_AGENT);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const def = (mode: string): AgentDef =>
    agent({ id: 'fake', harness: 'custom', command: process.execPath, args: [fake], env: { FAKE_MODE: mode, FAKE_ENV_PROBE: 'from-env' } });

  it('runs in an empty directory with no MCP servers, sets the model, appends args and refuses the write', async () => {
    const run = await runAcpReview(def('answer'), 'm-review', ['--review-only'], 'review this');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const seen = JSON.parse(run.output) as Record<string, unknown> & { newSession: { cwd: string; mcpServers: unknown[]; _meta?: unknown } };
    expect(seen.argv).toEqual(['--review-only']);
    expect(seen.entries).toEqual([]);
    expect(seen.cwd).toBe(seen.newSession.cwd);
    expect(seen.newSession.cwd.startsWith(os.tmpdir())).toBe(true);
    expect(seen.newSession.mcpServers).toEqual([]);
    expect(seen.newSession._meta).toBeUndefined();
    expect(seen.model).toBe('m-review');
    expect(seen.permission).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(seen.env).toBe('from-env');
    // The directory is gone afterwards.
    expect(fs.existsSync(seen.newSession.cwd)).toBe(false);
  });

  it('a turn the harness cancels over the refused tool is a failure that says so', async () => {
    const run = await runAcpReview(def('cancel'), undefined, [], 'p');
    expect(run).toMatchObject({ ok: false });
    if (!run.ok) {
      expect(run.error).toContain('ended its turn with cancelled');
      expect(run.error).toContain('refused: Write notes.md');
      expect(run.capacity).toBeUndefined();
    }
  });

  it('an agent that dies mid-turn is a failure, not a hang', async () => {
    const run = await runAcpReview(def('exit'), undefined, [], 'p');
    expect(run).toMatchObject({ ok: false });
    if (!run.ok) expect(run.error).toMatch(/fake exited 3 before answering/);
  });

  it('one that never answers is cut off at the timeout and counted as capacity', async () => {
    const run = await runAcpReview(def('hang'), undefined, [], 'p', 300);
    expect(run).toMatchObject({ ok: false, capacity: true });
  });

  it('a command that does not exist fails at once', async () => {
    const missing = agent({ id: 'nope', harness: 'custom', command: path.join(dir, 'no-such-agent') });
    const run = await runAcpReview(missing, undefined, [], 'p');
    expect(run).toMatchObject({ ok: false });
    if (!run.ok) expect(run.capacity).toBeUndefined();
  });
});

describe('review.api in config.yaml', () => {
  it('expands ${VAR} in url and key like every other field', () => {
    const raw = expandEnvVars(
      {
        platforms: { telegram: { type: 'telegram', token: 'x' } },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
        review: { api: { url: '${REVIEW_URL}', key: '${REVIEW_KEY}', model: 'm' } },
      },
      { REVIEW_URL: 'http://newapi:3000/v1', REVIEW_KEY: 'sk-from-env' }
    );
    expect(parseConfig(raw).review?.api).toEqual({ url: 'http://newapi:3000/v1', key: 'sk-from-env', model: 'm' });
  });
});
