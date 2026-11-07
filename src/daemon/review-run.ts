import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent, REVIEW_ARGS_HARNESSES } from '../config/schema.js';
import type { RemoteHost } from '../remote/host.js';
import { applyModelPreference, resolveHarness } from './agent-acp.js';
import { buildHarnessEnv, expandEnv, remoteAgentEnv, type AgentChild } from './agent-common.js';
import { AGY_COMMAND } from './agy-cli.js';
import { remoteHosts } from './remote-hosts.js';

/**
 * Who runs a review, and how (`docs/skills.md#auto-review`, AGENTS.md invariant 8). review.ts
 * decides when and what; this decides where the prompt goes and how the answer comes back.
 *
 * Three routes, one contract: the prompt in, one answer out, and nothing on the reviewer's side
 * able to write — the gateway applies the answer itself, through skills-store.
 *  - `api`: one OpenAI-compatible `/chat/completions` request. No tools exist at all.
 *  - an `agy` agent: one `agy -p` with every permission class denied (`AGY_NO_TOOLS`).
 *  - any other agent: one ACP session started for this review alone, on the agent's machine, in an
 *    empty directory, with no MCP servers, every permission request refused, and the harness's own
 *    tool switches (`acpReviewLaunch`). It is not a conversation: nothing here touches the registry
 *    or the library, so it never becomes a topic and never reaches the next review's candidates.
 *
 * The switches were measured on 2026-11-07 (project-scripts/talkcode-review-tools), each with a
 * prompt asking the agent to read a file outside its directory, write one, and run a command:
 *  - claude (claude-agent-acp 0.81.2): `_meta.claudeCode.options.tools: []` leaves no tool at all;
 *    with `settingSources: []` and `strictMcpConfig` the operator's settings, skills and MCP servers
 *    are not loaded either. Without them the adapter still asks before each of the three, so the
 *    refusal alone also held.
 *  - codex (codex-acp 2.5.0): `features.shell_tool` / `unified_exec` off in CODEX_CONFIG removes
 *    the shell, and with it every read and command; apply_patch cannot be removed (a model catalog
 *    without it did not take it away). Mode `read-only` makes that write ask, and the refusal stops
 *    it — by cancelling the whole turn, which is then a failed review (review.ts counts it).
 *  - opencode (2.2.5): asks for nothing by default, so a refusal stops nothing; inline config
 *    `{"permission":"deny"}` removed every tool, over a config file that allowed everything.
 *  - agy: `agy acp` has no `--settings` and does not read settings.json at all (its log never
 *    loads CLI settings), so it stays on print mode, where the deny list holds.
 * A harness this list does not name (`custom`, `gemini`, `dsh`) gets only the refusal and whatever
 * `review.args` the operator gives it; whether its writes and commands ask first is that harness's
 * business, which is why the config says so and invariant 8 records it.
 */

/**
 * One review's wall clock. A review reads, thinks and prints one JSON object — but it can also
 * spend a long time waiting on the provider.
 *
 * Thirty minutes, not five, measured on 2026-11-05/06: of 26 reviews, the 6 failures were all
 * `agy on awsfree2 timed out after 5 min`, and every one was Google queueing
 * `gemini-3.8-flash-high` — the request hangs for 2–4.5 minutes, then answers `UNAVAILABLE (503):
 * No capacity available for model gemini-3.8-flash-high`. agy 1.5.1 retries that itself after 4 s
 * (`attempt 1 failed … retrying in 4s`; a recovery after attempt 3 was seen on 11-04), so the old
 * five-minute cap killed agy before its own retry loop could finish. Successful reviews took
 * 37–251 s regardless of prompt size, so 30 minutes is about six worst-case queue waits — enough
 * for a 10–20 minute drought with room to spare. A review has no deadline; holding the single lane
 * longer is cheaper than losing the batch.
 *
 * The timeout is treated as capacity even though it proves nothing about the cause. Measured on
 * 11-06 in agy 1.5.1 (cli-20261106_110242.log): it retried past `attempt 5 failed … retrying in
 * 18.9s`, and no give-up limit was found in the binary, so a capacity queue can keep it running
 * past any cap — and a kill leaves no result event or stderr to read. Calling every timeout an
 * ordinary failure would bring back exactly the six lost batches this change is for. A permanently
 * hung agy is bounded by the twelve-in-a-row capacity limit instead: those timeouts stop being
 * exempt, count, and the batch is given up on after three more. Errors that fail at once — no such
 * host, a spawn failure, ssh refused — never reach the timeout and stay ordinary failures. The
 * other routes share the cap and the rule: an ACP harness and an API endpoint retry upstream
 * trouble inside the call just as agy does.
 */
export const REVIEW_TIMEOUT_MS = 30 * 60_000;

export type ReviewRun =
  | { ok: true; output: string }
  | {
      ok: false;
      error: string;
      /**
       * The provider had no capacity for the model, or the run hit the review timeout. The caller
       * then retries without counting the attempt, up to the consecutive-capacity limit.
       */
      capacity?: boolean;
    };

/**
 * Whether a run that finished said the provider had no capacity for this model.
 *
 * Narrow on purpose. This failure alone skips the attempt count, so a false positive turns any
 * permanent fault into an endless retry and defeats the three-attempt limit. The evidence agy
 * actually produces is `UNAVAILABLE (code 503): No capacity available for model <id> on the
 * server` (measured 11-04/11-06, in the result event or on stderr); it is matched either as
 * `no capacity available` or as `UNAVAILABLE` and a standalone `503` in the same text. A bare
 * `503` (a port, an id), `resource temporarily unavailable`, `Connection timed out`, or any other
 * error is not evidence.
 *
 * A timeout is handled separately, by the runner's own `capacity` flag, not by this match: a
 * killed run has no output to read and no cause to name. See REVIEW_TIMEOUT_MS for why it is
 * still treated as capacity and what bounds that.
 */
export function isCapacityFailure(error: string): boolean {
  if (/no capacity available/i.test(error)) return true;
  return /\bunavailable\b/i.test(error) && /\b503\b/.test(error);
}

/**
 * The configured reviewer, resolved. `id` is what the review is filed and its writes are signed
 * as: the agent's id, or `api:<model>` for an endpoint, which has no agent to name.
 */
export type Reviewer =
  | { kind: 'agent'; id: string; host: string; def: AgentDef; model: string | undefined; args: readonly string[] }
  | { kind: 'api'; id: string; host: ''; url: string; key: string; model: string };

/**
 * `review:` as a reviewer, or undefined when there is none — no block, or an agent id this config
 * no longer has (a pod that stopped declaring it). Read live on every sweep: `/reload` and
 * `/setting` change the config in place.
 */
export function reviewerOf(config: Pick<Config, 'review' | 'agents'>): Reviewer | undefined {
  const review = config.review;
  if (!review) return undefined;
  if (review.api) {
    const { url, key, model } = review.api;
    return { kind: 'api', id: `api:${model}`, host: '', url, key, model };
  }
  const def = review.agent ? findAgent(config as Config, review.agent) : undefined;
  if (!def) return undefined;
  return {
    kind: 'agent',
    id: def.id,
    host: def.host ?? '',
    def,
    model: review.model ?? def.model,
    // The schema already refuses args for any other harness; this keeps a config built in memory
    // (a test, a `/setting` candidate) from slipping them past the switches the gateway owns.
    args: REVIEW_ARGS_HARNESSES.has(def.harness) ? (review.args ?? []) : [],
  };
}

/** One review run, by whichever route the reviewer takes. */
export async function runReview(reviewer: Reviewer, prompt: string): Promise<ReviewRun> {
  if (reviewer.kind === 'api') return runApiReview(reviewer, prompt);
  if (reviewer.def.harness === 'agy') return runAgyReview(reviewer.def, reviewer.model, prompt);
  return runAcpReview(reviewer.def, reviewer.model, reviewer.args, prompt);
}

// ─────────────────────────────────────── the api route ───────────────────────────────────────

/** `url` as given when it already names the endpoint, else the base with `/chat/completions`. */
export function chatCompletionsUrl(url: string): string {
  const base = url.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** The request body: the prompt as one user message, nothing else — no tools, no system text. */
export function apiReviewBody(model: string, prompt: string): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: prompt }], stream: false };
}

/**
 * What an OpenAI-compatible completion answered. `content` is a string from every endpoint this
 * was tried against (newapi, CPA); an array of text parts is the other shape the API allows, and
 * is joined rather than refused. A completion with no text — only reasoning, or a refusal — is a
 * failure with the finish reason, never an empty answer the parser would call "nothing found".
 */
export function apiReviewAnswer(body: unknown): ReviewRun {
  const choice = (body as { choices?: unknown[] } | undefined)?.choices?.[0] as
    | { message?: { content?: unknown }; finish_reason?: unknown }
    | undefined;
  if (!choice) return { ok: false, error: `the endpoint answered without a choice: ${JSON.stringify(body).slice(0, 300)}` };
  const content = choice.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('')
        : '';
  if (!text.trim()) {
    return { ok: false, error: `the endpoint answered no text (finish_reason ${String(choice.finish_reason ?? 'none')})` };
  }
  return { ok: true, output: text.trim() };
}

/**
 * One request to the endpoint. `fetch` is the global one, which the daemon has already pointed at
 * the system proxy (core/proxy.ts); injectable for tests only. The key is sent and never logged:
 * an error carries the status and the body, which is where an endpoint says what went wrong.
 */
export async function runApiReview(
  reviewer: Extract<Reviewer, { kind: 'api' }>,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REVIEW_TIMEOUT_MS
): Promise<ReviewRun> {
  const url = chatCompletionsUrl(reviewer.url);
  const label = `api ${reviewer.model}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewer.key}` },
      body: JSON.stringify(apiReviewBody(reviewer.model, prompt)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: `${label} did not answer within ${timeoutMs / 60_000} min`, capacity: true };
    }
    return { ok: false, error: `${label}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: `${label}: HTTP ${res.status} ${raw.slice(0, 500)}` };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${label}: the answer is not JSON: ${raw.slice(0, 300)}` };
  }
  const answer = apiReviewAnswer(body);
  return answer.ok ? answer : { ok: false, error: `${label}: ${answer.error}` };
}

// ─────────────────────────────────────── the acp route ───────────────────────────────────────

/** How one review's ACP child is started: the harness's own launch with the review's switches. */
export interface AcpReviewLaunch {
  command: string;
  args: string[];
  /** Laid over the agent's environment, after its own `env:` block, so these win. */
  env: Record<string, string>;
  /** `session/new` `_meta`. */
  meta?: Record<string, unknown>;
}

/**
 * claude-agent-acp's per-session SDK options (acp-agent.js: `userProvidedOptions?.tools ?? …`,
 * spread into the query options). `tools: []` is no built-in tool; `settingSources: []` loads no
 * settings, hooks, plugins or skills of the operator's; `strictMcpConfig` takes MCP servers from
 * this request alone, which carries none. `disableBuiltInTools` is the adapter's older spelling of
 * `tools: []`, for a host whose adapter predates the option.
 */
export const CLAUDE_NO_TOOLS_META: Record<string, unknown> = {
  claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true } },
  disableBuiltInTools: true,
};

/** The codex features that are a shell. Off, codex has no way to read or run anything. */
const CODEX_NO_SHELL = { shell_tool: false, unified_exec: false };

/**
 * The review's launch for an ACP harness. Pure, so the switches are tested without a harness.
 * `remote` picks the host's own adapter for claude, as resolveHarness does for a conversation.
 */
export function acpReviewLaunch(def: AgentDef, remote: boolean, extraArgs: readonly string[] = []): AcpReviewLaunch {
  const base = resolveHarness(def, remote);
  switch (def.harness) {
    case 'claude':
      return { ...base, env: {}, meta: CLAUDE_NO_TOOLS_META };
    case 'codex': {
      // Merged into the agent's own CODEX_CONFIG (a provider, a model), the features last so they win.
      const own = jsonObject(def.env['CODEX_CONFIG']);
      const ownFeatures = own['features'];
      const features = {
        ...(ownFeatures && typeof ownFeatures === 'object' && !Array.isArray(ownFeatures) ? ownFeatures : {}),
        ...CODEX_NO_SHELL,
      };
      // INITIAL_AGENT_MODE replaces the agent's own (agent-full-access on a host without bwrap):
      // read-only is the mode whose writes ask, and a refused ask is what stops apply_patch.
      return { ...base, env: { CODEX_CONFIG: JSON.stringify({ ...own, features }), INITIAL_AGENT_MODE: 'read-only' } };
    }
    case 'opencode': {
      // OPENCODE_CONFIG_CONTENT is read last, over every config file; `permission` as a string
      // means `{"*": <it>}` (opencode's PermissionConfig), so this is every tool, MCP ones included.
      const own = jsonObject(def.env['OPENCODE_CONFIG_CONTENT']);
      return { ...base, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...own, permission: 'deny' }) } };
    }
    case 'custom':
    case 'gemini':
    case 'dsh':
      return { command: base.command, args: [...base.args, ...extraArgs], env: {} };
    case 'agy':
      throw new Error('an agy review runs `agy -p` (runAgyReview), not an ACP session');
    default: {
      const _exhaustive: never = def.harness;
      throw new Error(`no review launch for harness ${String(_exhaustive)}`);
    }
  }
}

/**
 * A JSON object from an env value, or `{}`. An unreadable one would have broken that agent's own
 * sessions already; the review's switches still go out whole rather than not at all.
 */
function jsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(expandEnv(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The answer to every permission request: refused, never put to anyone. A review has no person
 * behind it, and invariant 8 holds the writes and commands of a harness whose tools cannot be
 * turned off to exactly this. Picks the harness's own reject option; with none, the request is
 * cancelled, which no harness reads as a yes.
 */
export function refusePermission(params: Pick<RequestPermissionRequest, 'options'>): RequestPermissionResponse {
  const reject = params.options.find((o) => o.kind === 'reject_once') ?? params.options.find((o) => o.kind === 'reject_always');
  return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** Where a review runs: an empty directory here, or one under the host's `~/.talkcode/reviews`. */
interface ReviewPlace {
  dir: string;
  host?: RemoteHost;
  /** For messages: `<agent>` here, `<agent> on <host>` there. */
  label: string;
}

/**
 * Run `fn` in an empty directory on the agent's machine, removed afterwards whatever happened. It
 * exists only so the reviewer has no workspace to read and nothing of the operator's within reach.
 */
async function inReviewDir(def: AgentDef, name: string, fn: (place: ReviewPlace) => Promise<ReviewRun>): Promise<ReviewRun> {
  const host = remoteHosts.hostFor(def);
  // An agent with `host:` whose host is not registered (yet) must not be run HERE: in a
  // gateway-only container that is a machine without the harness, and on any other it is the
  // wrong account and the wrong quota.
  if (def.host && !host) return { ok: false, error: `host "${def.host}" is not registered` };
  if (!host) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-review-'));
    try {
      return await fn({ dir, label: name });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try {
    const welcome = await host.ready();
    const root = path.posix.join(welcome.home, '.talkcode', 'reviews');
    const dir = path.posix.join(root, `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`);
    await host.mkdirp(dir, 0o700);
    try {
      return await fn({ dir, host, label: `${name} on ${host.id}` });
    } finally {
      await host.removePath(dir, root).catch((e: Error) => console.warn(`[review] could not remove ${dir} on ${host.id}: ${e.message}`));
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One review as an ACP session of its own, on the agent's machine. */
export async function runAcpReview(
  def: AgentDef,
  model: string | undefined,
  args: readonly string[],
  prompt: string,
  timeoutMs = REVIEW_TIMEOUT_MS
): Promise<ReviewRun> {
  return inReviewDir(def, def.id, async (place) => {
    const launch = acpReviewLaunch(def, place.host !== undefined, args);
    const child: AgentChild = place.host
      ? place.host.spawn(launch.command, launch.args, { cwd: place.dir, env: { ...remoteAgentEnv(def), ...launch.env } })
      : spawn(launch.command, launch.args, { cwd: place.dir, env: { ...buildHarnessEnv(def), ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    return driveAcpReview(child, { def, cwd: place.dir, meta: launch.meta, model, prompt, label: place.label, timeoutMs });
  });
}

interface AcpReviewTurn {
  def: AgentDef;
  cwd: string;
  meta: Record<string, unknown> | undefined;
  model: string | undefined;
  prompt: string;
  label: string;
  timeoutMs: number;
}

const REVIEW_STDERR_MAX = 8 << 10;

/**
 * initialize, session/new, the model, one prompt — and the child stopped whatever happened. The
 * answer is the agent's message text; a turn that ends any other way than `end_turn` with text is
 * a failure naming how it ended and what was refused, because "cancelled" alone does not say that
 * the harness ended the turn over a tool the review would not allow.
 */
export async function driveAcpReview(child: AgentChild, turn: AcpReviewTurn): Promise<ReviewRun> {
  let text = '';
  let stderr = '';
  const refused: string[] = [];
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-REVIEW_STDERR_MAX);
  });
  const app = client()
    .onRequest('session/request_permission', ({ params }) => {
      refused.push(params.toolCall.title ?? params.toolCall.kind ?? 'a tool');
      return refusePermission(params);
    })
    // Nobody to answer a question either; declined, so the agent goes on without it.
    .onRequest('elicitation/create', () => ({ action: 'decline' as const }))
    .onNotification('session/update', ({ params }) => {
      const u = params.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') text += u.content.text;
    });
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  const ctx = connection.agent;
  const failed = (error: string, capacity = false): ReviewRun => {
    const said = `${error}${stderr.trim() ? ` — ${stderr.trim().slice(-500)}` : ''}`;
    return capacity || isCapacityFailure(`${error}\n${stderr}`) ? { ok: false, error: said, capacity: true } : { ok: false, error: said };
  };
  // A child that dies, or never starts (a command not on PATH, here or on the host), leaves every
  // request unanswered; this is what ends the wait instead of the timeout.
  const ended = new Promise<ReviewRun>((resolve) => {
    child.on('error', (e) => resolve(failed(`${turn.label}: ${e.message}`)));
    child.on('exit', (code, signal) => resolve(failed(`${turn.label} exited ${code ?? signal} before answering`)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ReviewRun>((resolve) => {
    timer = setTimeout(() => resolve(failed(`${turn.label} did not finish within ${turn.timeoutMs / 60_000} min`, true)), turn.timeoutMs);
  });
  const session = (async (): Promise<ReviewRun> => {
    await ctx.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // No fs, no terminal, no elicitation form: nothing for the agent to do through the client,
      // and claude-agent-acp withholds AskUserQuestion when the form is not offered.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const created = await ctx.request('session/new', {
      cwd: turn.cwd,
      mcpServers: [],
      ...(turn.meta ? { _meta: turn.meta } : {}),
    });
    await applyModelPreference(ctx, created.sessionId, turn.def, created.configOptions ?? undefined, turn.model);
    const res = await ctx.request('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: turn.prompt }],
    });
    // The text arrived as notifications before this response (one ordered stream); one turn of the
    // event loop lets the last handler run before it is read.
    await new Promise((r) => setImmediate(r));
    const why = refused.length ? `; refused: ${refused.join(', ')}` : '';
    if (res.stopReason !== 'end_turn') return failed(`${turn.label} ended its turn with ${res.stopReason}${why}`);
    if (!text.trim()) return failed(`${turn.label} produced no answer${why}`);
    return { ok: true, output: text.trim() };
  })().catch(async (e: unknown) => {
    // A child that died closes the connection first; its exit, a moment later, says more than
    // "ACP connection closed" — give it that moment, and `ended` wins the race if it comes.
    await new Promise((r) => setTimeout(r, 200));
    return failed(`${turn.label}: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    return await Promise.race([session, ended, timedOut]);
  } finally {
    clearTimeout(timer);
    connection.close();
    stopChild(child);
  }
}

/** SIGTERM, then SIGKILL if it is still there a few seconds later. */
function stopChild(child: AgentChild): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5_000).unref();
}

// ─────────────────────────────────────── the agy route ───────────────────────────────────────

/**
 * Every permission class the CLI knows, denied. `"*"` is NOT a wildcard here — measured on agy
 * 1.5.0, `deny: ["*"]` matched nothing and `write_file` still wrote a file — so each class is
 * named. The reviewer reads nothing and writes nothing: everything it needs is in the prompt.
 *
 * An unknown class in this list is ignored by the CLI (it logs "ignoring invalid deny entry"), so
 * adding one costs nothing; a NEW tool class in a future agy is not covered, which is why the
 * security note in AGENTS.md calls this list part of the contract. On agy 1.5.2 (2026-11-07)
 * `list_dir`, `search`, `url` and `browser` are such unknown entries: listing, searching and
 * fetching all went through `run_command` and `read_file` instead, and were denied there.
 */
export const AGY_NO_TOOLS = JSON.stringify({
  permissions: {
    deny: [
      'write_file(*)',
      'read_file(*)',
      'list_dir(*)',
      'search(*)',
      'command(*)',
      'url(*)',
      'browser(*)',
      'mcp(*)',
    ],
  },
});

/**
 * The argv for one review. The prompt is NOT here: a single argv entry is capped at 128 KB
 * (`MAX_ARG_STRLEN`), and a long Chinese conversation (40k characters is ~120 KB) plus the skills
 * it used blows through that — measured: a 360 KB `-p=` fails with "Argument list too long".
 * Instead agy runs in its headless print mode, stream-json in and out: one NDJSON user message on
 * stdin, the answer on stdout. Print mode, not `agy acp`, because only print mode reads
 * `--settings` — measured on agy 1.5.2, `agy acp` loads no CLI settings at all, and its read and
 * write tools ask nobody.
 */
export function reviewAgyArgs(model: string | undefined): string[] {
  return [
    ...(model ? [`--model=${model}`] : []),
    `--settings=${AGY_NO_TOOLS}`,
    '--disable-slash-commands',
    '--input-format=stream-json',
    '--output-format=stream-json',
    // No prompt after `-p=`: stream-json reads stdin, which is closed after the one message.
    '-p=',
  ];
}

/** The one NDJSON frame agy expects from stdin in that mode. */
export function reviewAgyInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

interface AgyReviewEvent {
  event?: string;
  step_update?: { step_type?: string; text_delta?: string };
  result?: { status?: string; response?: string; error?: string };
}

/**
 * What agy answered, read off its event stream.
 *
 * The text comes from the `agent_response` deltas, as the resident runtime reads it; `result.response`
 * is the fallback for a version that only fills the final frame. A non-SUCCESS result with no text
 * is a failure — except `ERROR` after a reply, which the runtime also believes, because some
 * providers report a failure after the answer has already streamed.
 */
export function agyReviewAnswer(stdout: string): ReviewRun {
  const { streamed, result } = scanAgyEvents(stdout);
  if (!result) return { ok: false, error: 'agy ended without a result event' };
  const answer = (streamed.trim() ? streamed : result.response ?? '').trim();
  const status = result.status ?? 'SUCCESS';
  if (status !== 'SUCCESS' && !(status === 'ERROR' && answer)) {
    return { ok: false, error: `agy ended with status ${status}${result.error ? `: ${result.error}` : ''}` };
  }
  if (!answer) return { ok: false, error: 'agy produced no answer' };
  return { ok: true, output: answer };
}

/** The two things the answer is built from: the streamed text, and the final frame. */
function scanAgyEvents(stdout: string): { streamed: string; result: AgyReviewEvent['result'] } {
  let streamed = '';
  let result: AgyReviewEvent['result'];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue; // a banner or log line on stdout: not our protocol
    let msg: AgyReviewEvent;
    try {
      msg = JSON.parse(text) as AgyReviewEvent;
    } catch {
      continue;
    }
    if (msg.event === 'step_update' && msg.step_update?.step_type === 'agent_response') {
      streamed += msg.step_update.text_delta ?? '';
    } else if (msg.event === 'result') {
      result = msg.result ?? {};
    }
  }
  return { streamed, result };
}

/**
 * One review run: `agy -p` in an empty directory on the reviewer's machine, with every tool
 * denied and the prompt on stdin. Remote uses the gateway's existing ssh link (`RemoteHost.run`,
 * whose body is the child's stdin); local spawns the CLI directly.
 */
export async function runAgyReview(def: AgentDef, model: string | undefined, prompt: string): Promise<ReviewRun> {
  const argv = reviewAgyArgs(model);
  const input = reviewAgyInput(prompt);
  return inReviewDir(def, 'agy', async (place) => {
    if (!place.host) return runAgyReviewLocal(def, place.dir, argv, input);
    const host = place.host;
    const r = await host.run({
      argv: [AGY_COMMAND, ...argv],
      cwd: place.dir,
      env: remoteAgentEnv(def),
      stdin: input,
      timeoutMs: REVIEW_TIMEOUT_MS,
      max: 1 << 20,
    });
    if (r.spawnError) return { ok: false, error: `agy on ${host.id}: ${r.spawnError}` };
    // A timeout is capacity by the runner's own judgement, not by text: a killed run usually
    // leaves nothing to match. Errors that fail at once (spawn, ssh) never reach this branch and
    // stay ordinary failures, so they still count toward the three-attempt limit.
    if (r.timedOut) {
      return { ok: false, error: `agy on ${host.id} timed out after ${REVIEW_TIMEOUT_MS / 60_000} min`, capacity: true };
    }
    if (r.code !== 0) {
      const error = `agy on ${host.id} exited ${r.code ?? r.signal}${r.stderr ? `: ${r.stderr}` : ''}`;
      // Both streams, as in the local runner: the 503 may be in a result event on stdout while
      // stderr holds only the exit reason.
      const captured = `${r.output.toString('utf8')}\n${r.stderr ?? ''}`;
      return isCapacityFailure(captured) ? { ok: false, error, capacity: true } : { ok: false, error };
    }
    return agyReviewAnswer(r.output.toString('utf8'));
  });
}

/** How much of agy's stdout is kept while it runs. The answer is one JSON object; this is slack. */
const REVIEW_OUTPUT_MAX = 4 << 20;

function runAgyReviewLocal(def: AgentDef, dir: string, argv: string[], input: string): Promise<ReviewRun> {
  return new Promise<ReviewRun>((resolve) => {
    const child = spawn(AGY_COMMAND, argv, { cwd: dir, env: buildHarnessEnv(def), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result: ReviewRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Classified from the full stderr and stdout, before the error sentence keeps only 500
    // characters of it. agy's retry lines go to its own CLI log, not these streams, but a 503 in
    // a result event or a final error does arrive here. The timeout branch below does not use
    // this: a killed run is capacity whether or not it wrote anything.
    const failed = (error: string): ReviewRun => {
      const capacity = isCapacityFailure(`${err}\n${out}`);
      return capacity ? { ok: false, error, capacity } : { ok: false, error };
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `agy did not finish within ${REVIEW_TIMEOUT_MS / 60_000} min`, capacity: true });
    }, REVIEW_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > REVIEW_OUTPUT_MAX) out = out.slice(-REVIEW_OUTPUT_MAX);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
      if (err.length > REVIEW_STDERR_MAX) err = err.slice(-REVIEW_STDERR_MAX);
    });
    child.on('error', (e) => finish({ ok: false, error: `agy: ${e.message}` }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(failed(`agy exited ${code ?? 'by signal'}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ''}`));
        return;
      }
      finish(agyReviewAnswer(out));
    });
    // agy can exit before reading all of stdin; that is a close, not a crash.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
