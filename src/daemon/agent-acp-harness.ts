import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  ActiveSession,
  ClientCapabilities,
  ClientContext,
  ContentBlock,
  InitializeResponse,
  McpServer,
  PromptResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { SteerOutcome } from '../types.js';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import type { AgentStreamHandlers, RunTurnInput } from './agent.js';
import { TurnFailure } from './agent.js';
import { readSteerOutcome, STEER_METHOD, steerParams, type SteeringMode } from './acp-steering.js';
import {
  buildAgentEnv,
  prepareRemoteSpawn,
  remoteAgentEnv,
  trimReason,
  type AgentChild,
} from './agent-common.js';
import { agyWindow } from './agy-acp.js';
import { AGY_COMMAND } from './agy-cli.js';
import { markActivePools } from './agy-meters.js';
import { AGY_CONTEXT_REFRESH_MS, readAgyContext } from './agy-transcript.js';
import { connectAddress, connectHere, connectMeta } from './connect-agent.js';
import { harnessLogProbe, readHarnessErrors } from './harness-log.js';
import { scopeQuotaPools, type QuotaMeter } from './quota-meter.js';
import { relayEnv } from './relay.js';
import { remoteHosts } from './remote-hosts.js';
import { selfInvocation } from './reverse-cli-shim.js';
import {
  describeSessionFailure,
  failureNoticeKey,
  SESSION_FAILURE_CAPABILITY_META,
  type SessionFailure,
} from './session-failure.js';
import { customOptionsOf, type AcpOptionState } from './agent-acp-options.js';
import {
  autonomousResultOrigin,
  hasOpenToolCall,
  isRenderableUpdate,
  type TurnState,
} from './agent-acp-translate.js';

// ───────────────────────── What the agent is given: tools, not text ─────────────────────────

/**
 * The prompt of a turn: what the user sent, as the only text block. The gateway adds nothing of its
 * own — no preamble, no reminder — so that what the agent reads is what it was asked (see
 * ipc/commands.ts HELP_TOPICS for what replaced the `<system-reminder>` that used to go first).
 *
 * The user's pictures go in as pictures when the harness said it takes them (`takesImages`, its
 * `initialize` → `promptCapabilities.image`). Before this every picture was a path, and an agent
 * given a path to a screenshot decides for itself whether to open it — which is a tool call
 * when it does, and an answer about a picture it never saw when it does not. Probed 2026-10-09
 * (project-reports/2026-10-09-agent-anywhere-image-prompt-blocks.md): claude-agent-acp, codex-acp
 * and `opencode acp` all claim it, and each read text off a screenshot with zero tool calls.
 * Asked per harness rather than assumed, because a harness that does not claim it is one that
 * may reject the block. The pictures go first, the order Anthropic's vision docs recommend; the
 * text still names each by path, in the same order.
 */
export function promptBlocks(turn: Pick<RunTurnInput, 'prompt' | 'images'>, takesImages: boolean): ContentBlock[] {
  const text: ContentBlock = { type: 'text', text: turn.prompt };
  if (!takesImages || !turn.images?.length) return [text];
  return [...turn.images.map((img): ContentBlock => ({ type: 'image', data: img.data, mimeType: img.mimeType })), text];
}

/**
 * The name the agent's tools are filed under — Claude Code shows `mcp__chat__send_file`. Neutral on
 * purpose: the name is part of what the model reads, and "this is how you send the user a file"
 * says everything it needs, where the gateway's own name would only say where it is running.
 */
export const NATIVE_TOOLS_SERVER = 'chat';

/**
 * MCP servers handed to the agent in `session/new` and `session/load`: `fleetherd mcp`, which
 * serves `send_file` and `schedule` as native tools (commands/mcp.ts, ipc/tools.ts).
 *
 * Stdio, because it is the one transport every ACP agent MUST support — probed 2026-10-09, the
 * agents here additionally advertise http (claude-agent-acp 0.81.2, codex-acp 2.1.1, opencode
 * 2.0.26), but serving HTTP would mean a listening port where today there is only a 0600 socket.
 * The harness starts the server as its own child, once per session.
 *
 * Its environment is spelled out rather than inherited, because inheritance is the harness's call
 * and codex, for one, passes its MCP servers an allowlist: the session's token (the server is a
 * reverse-command client like any other, with the same rights), the socket, and the session's
 * working directory, which relative paths are resolved against — ACP gives a stdio server no `cwd`,
 * so where it starts is up to the harness.
 *
 * Empty when this process is not the CLI (a test worker): the server is re-invoked through the
 * daemon's own entry, and there is no entry to re-invoke. The agent then simply has no tools, which
 * is the pre-1.40 state, and the CLI behind the skill still works.
 */
export function acpMcpServers(
  sessionToken: string,
  socketPath: string,
  cwd: string,
  self = selfInvocation()
): McpServer[] {
  if (!self) return [];
  return [
    {
      name: NATIVE_TOOLS_SERVER,
      command: self.command,
      args: [...self.args, 'mcp'],
      env: [
        { name: 'FLEETHERD_TURN_TOKEN', value: sessionToken },
        { name: 'FLEETHERD_SOCKET', value: socketPath },
        { name: 'FLEETHERD_CWD', value: cwd },
      ],
    },
  ];
}

/**
 * The same server for an agent on a remote host: the host's `fleetherd` shim (on PATH there, but
 * named absolutely — a harness may start MCP servers with a stripped environment), which carries
 * the session back to this gateway's own `fleetherd mcp` (remote-hosts.ts runCli). The socket it
 * dials is passed explicitly for the same reason.
 */
export function remoteMcpServers(sessionToken: string, paths: { shim: string; socket: string }, cwd: string): McpServer[] {
  return [
    {
      name: NATIVE_TOOLS_SERVER,
      command: paths.shim,
      args: ['mcp'],
      env: [
        { name: 'FLEETHERD_TURN_TOKEN', value: sessionToken },
        { name: 'FLEETHERD_REMOTE_SOCK', value: paths.socket },
        { name: 'FLEETHERD_CWD', value: cwd },
      ],
    },
  ];
}

// ───────────────────────── harness preset → launch command ─────────────────────────

/**
 * Entry of the locally installed claude-agent-acp adapter (a declared dependency, so the version
 * is locked by package-lock and `npm install` surfaces network problems at install time instead
 * of at first message). Exported for the doctor check. Throws if node_modules is incomplete.
 */
export function resolveClaudeAdapterEntry(): string {
  // Its bin ("claude-agent-acp": dist/index.js) is reachable via the package's "./*" export.
  return createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
}

/** Resolve an agent def into the actual spawn command + args (presets default; custom self-configures; then append def.args). Exported for the doctor check and the harness unit tests. */
export function resolveHarness(def: AgentDef, remote = false): { command: string; args: string[] } {
  switch (def.harness) {
    case 'claude':
      // On a remote host the adapter is that host's own install (`npm i -g
      // @agentclientprotocol/claude-agent-acp`): the bundled one carries a native Claude Code build
      // for THIS machine (223 MB for linux-arm64 alone), not something to ship to every host.
      if (remote) return { command: 'claude-agent-acp', args: [...def.args] };
      // Claude via the official claude-agent-acp adapter (replacing Zed's claude-code-acp): its
      // @agentclientprotocol/sdk matches ours (protocol aligned), it forwards /usage /status /model
      // built-in echoes, and is more actively maintained. Login still reuses `claude /login` (no API
      // key). Spawned with the current node binary — no PATH or shebang dependence.
      return { command: process.execPath, args: [resolveClaudeAdapterEntry(), ...def.args] };
    case 'gemini':
      // Gemini CLI native ACP (exact flag per `gemini --help`; override/extend via def.args).
      return { command: 'gemini', args: ['--experimental-acp', ...def.args] };
    case 'codex':
      // Codex via @agentclientprotocol/codex-acp (the codex CLI itself has no ACP mode — a bare
      // `codex acp` falls into the TUI and dies with "stdin is not a terminal" when headless).
      // Auth reuses the codex CLI's own login state (~/.codex), including a custom
      // `model_providers` gateway, which the adapter reports back as authStatus kind "gateway".
      //
      // A PATH command, NOT a bundled dependency, which is the opposite of the claude arm above
      // and deliberate: the adapter declares `@openai/codex` as a regular dependency, whose
      // platform binary is ~284 MB unpacked. Bundling that taxes every `npm i -g
      // fleetherd` for a harness most operators never configure, and the operator who
      // does configure it already had to install and log into the codex CLI by hand. So codex
      // follows the same contract as gemini/opencode/dsh — the image (or the operator) installs
      // `@agentclientprotocol/codex-acp` globally, and doctor reports a missing one.
      //
      // The predecessor here was Zed's `@zed-industries/codex-acp`, a declared dependency shipping
      // a Rust binary. It is deprecated upstream in favour of this package, and was worth leaving
      // behind on its own merits: probed side by side on 2026-09-20 against the same newapi
      // gateway, it advertised 6 commands to 1.12.0's 42, reported no model list (so `/model` had
      // only a stale gpt-5.2-era selector), had no `status`/`skills`/`mcp`, and prefixed its first
      // answer with "Model metadata for <model> not found. Defaulting to fallback metadata" —
      // inside the agent's message text, i.e. straight into the user's chat bubble.
      return { command: 'codex-acp', args: [...def.args] };
    case 'opencode':
      // OpenCode native ACP mode (per the ACP registry's official launch spec: `opencode acp`).
      return { command: 'opencode', args: ['acp', ...def.args] };
    case 'dsh':
      // DeepSeek Harness ACP profile (per the ACP registry's official launch spec: `dsh --profile acp`,
      // the dsh equivalent of opencode's `opencode acp`). Config (provider/model, credentials) comes
      // from dsh's own profile, not from args.
      return { command: 'dsh', args: ['--profile', 'acp', ...def.args] };
    case 'custom':
      // The schema guarantees a command unless the agent is a connect one, which is dialled, never
      // started (connect-agent.ts): what could still ask for its command is a review run, which
      // needs a process of its own it can take the tools from.
      if (!def.command) throw new Error(`agent "${def.id}" is reached at ${def.connect?.url ?? '?'} (connect), not started`);
      return { command: def.command, args: [...def.args] };
    case 'agy':
      // agy's own ACP server, since 1.5 (`agy acp --help`). None of the flags the old print-mode
      // launch needed carries over, each re-measured on 1.5.1 (2026-11-06):
      // there is no print-mode timeout to lift; permissions arrive as `session/request_permission`
      // and are answered like any harness's (approved or put to the user, as its permission level
      // says — `--dangerously-skip-permissions` would take that choice away); and a file the
      // agent writes in an untrusted cwd lands in the cwd, so `--add-dir` has nothing to fix. The
      // same command on a remote host: agy is a single binary on PATH there too.
      return { command: AGY_COMMAND, args: ['acp', ...def.args] };
  }
}

/**
 * Whether this agent is Cursor's CLI (`cursor-agent acp`) — the one harness known to read
 * `clientCapabilities._meta.parameterizedModelPicker` (cursor-agent 2026.11.05, its ACP agent's
 * clientSupportsParameterizedModelPicker). Read off the command's last segment, the way
 * skillHomes reads CodeBuddy out of a `custom` agent; a preset harness never matches.
 *
 * The binary has to be named `cursor-agent`, which is what its installer and `npm i -g` both
 * provide. A symlink under another name would not be recognised, and the agent would keep the
 * pre-combined model list — visible, but not silent: `options:` pins would then be skipped with
 * "not offered by this session" in the log.
 */
export function isCursorAgent(def: Pick<AgentDef, 'harness' | 'command'>): boolean {
  return def.harness === 'custom' && path.basename(def.command ?? '') === 'cursor-agent';
}

/**
 * Per-harness `clientCapabilities._meta` flags advertised at `initialize`:
 * - claude: typed failure records (see session-failure.ts); only sent to claude because opencode
 *   validates capabilities strictly.
 * - cursor-agent: `parameterizedModelPicker: true` so context / reasoning effort / fast are split
 *   into separate config options (probed against cursor-agent 2026.11.05-86047df, 2026-11-10).
 */
export function capabilityMetaOf(def: AgentDef): Record<string, unknown> {
  return {
    ...(def.harness === 'claude' ? SESSION_FAILURE_CAPABILITY_META : {}),
    ...(isCursorAgent(def) ? { parameterizedModelPicker: true } : {}),
  };
}

/**
 * Client capabilities sent in `initialize`: fs/terminal stay off (agents use their own tools),
 * `elicitation.form` is `{}` (must be an object, not `true`, because opencode validates strictly),
 * and harness-specific `_meta` flags are attached only where supported.
 */
export function clientCapabilitiesFor(def: AgentDef): ClientCapabilities {
  const meta = capabilityMetaOf(def);
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    elicitation: { form: {} },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/** Build a user-facing `access` TurnFailure when `session/new` rejects with `auth_required`. */
export function authRequiredFailure(def: AgentDef, initResult: InitializeResponse): TurnFailure {
  const methods = (initResult?.authMethods ?? [])
    .map((m) => m.name || m.id)
    .filter(Boolean)
    .join(' / ');
  const how = methods
    ? `(available login methods: ${methods})`
    : '(e.g. run `claude /login` to complete subscription login)';
  return new TurnFailure(`agent "${def.id}" must be logged in before use ${how}, then retry this turn.`, 'access');
}

// ───────────────────────── Per-machine startup concurrency & spawn ─────────────────────────

/**
 * How many agent processes may be cold-starting at once on one machine.
 *
 * Starting one is the most expensive thing this runtime does: a cbc child needs about 4.5
 * CPU-seconds and 500MB of RSS before it answers `initialize` (measured 2026-11-07 on a 2-core
 * host). Thirteen sub-agents confirmed together therefore put that machine into swap, took 60–90s
 * each, and every one missed START_TIMEOUT_MS — the card reported 13 startup timeouts and none of
 * the work ran. The limit is per machine (`local`, or a remote host's id) because that is where
 * the cost is paid. A queued start waits here, before startSession's timeout timer begins, so the
 * queue is not charged to it.
 */
const START_CONCURRENCY = 4;

/** A plain counting semaphore — twelve lines, so no dependency. */
class StartupSlots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(count: number) {
    this.free = count;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

/** The slot set for one machine: `local`, or a remote host's id. */
const startupSlots = new Map<string, StartupSlots>();
export function startupSlot(host: string): StartupSlots {
  let slots = startupSlots.get(host);
  if (!slots) {
    slots = new StartupSlots(START_CONCURRENCY);
    startupSlots.set(host, slots);
  }
  return slots;
}

export interface RemotePlace {
  host: RemoteHost;
  welcome: Welcome;
}

/**
 * For an agent on another machine: reach it (a first contact that fails ends the startup here,
 * with the reason), and settle the directory there before anything is started in it.
 */
export async function placeOnHost(
  def: AgentDef,
  cwd: string
): Promise<{ place: RemotePlace; cwd: string } | undefined> {
  const host = remoteHosts.hostFor(def);
  if (!host) return undefined;
  const prepared = await prepareRemoteSpawn(def, host, cwd);
  return { place: { host, welcome: prepared.welcome }, cwd: prepared.cwd };
}

/**
 * Start the agent: what was run, the child, and what its `initialize` carries besides the
 * capabilities. A connect agent is dialled, not started (connect-agent.ts): its address stands
 * where the command would in a failure's message, and what it is told goes in `_meta`.
 */
export async function launchAcpChild(opts: {
  def: AgentDef;
  cwd: string;
  socketPath: string;
  sessionToken: string;
  place: RemotePlace | undefined;
  topic?: string;
}): Promise<{
  command: string;
  args: string[];
  initExtra: { _meta?: Record<string, unknown> };
  child: AgentChild;
  mcpServers: () => McpServer[];
}> {
  const { def, cwd, socketPath, sessionToken, place, topic } = opts;
  const initExtra = def.connect ? { _meta: await connectMeta(def, def.connect, place, topic) } : {};
  const { command, args } = def.connect
    ? { command: def.connect.url, args: [] }
    : resolveHarness(def, place !== undefined);
  const relay = await relayEnv(def, place?.host);
  return { command, args, initExtra, ...spawnChild(def, command, args, cwd, socketPath, sessionToken, place, relay) };
}

function spawnChild(
  def: AgentDef,
  command: string,
  args: string[],
  cwd: string,
  socketPath: string,
  sessionToken: string,
  place: RemotePlace | undefined,
  relay: Record<string, string>
): { child: AgentChild; mcpServers: () => McpServer[] } {
  if (def.connect) {
    return place
      ? { child: place.host.connect(connectAddress(def.connect)), mcpServers: () => remoteMcpServers(sessionToken, place.host.paths(place.welcome), cwd) }
      : { child: connectHere(def.connect), mcpServers: () => acpMcpServers(sessionToken, socketPath, cwd) };
  }
  if (!place) {
    return {
      child: spawn(command, args, { cwd, env: { ...buildAgentEnv(def, sessionToken, socketPath), ...relay } }),
      mcpServers: () => acpMcpServers(sessionToken, socketPath, cwd),
    };
  }
  return {
    child: place.host.spawn(command, args, { cwd, env: { ...remoteAgentEnv(def, sessionToken), ...relay } }),
    mcpServers: () => remoteMcpServers(sessionToken, place.host.paths(place.welcome), cwd),
  };
}

/**
 * Attach stderr tailing, spawn-error tracking, and crash-exit handling to a spawned child.
 * `onCurrentExit` fires only if the exiting child is still the session's current process.
 */
export function adoptAcpChild(
  def: AgentDef,
  child: AgentChild,
  isCurrent: () => boolean,
  onCurrentExit: () => void
): { spawnError: () => Error | undefined; stderrTail: () => string } {
  let tail = '';
  child.stderr.on('data', (d: Buffer) => {
    process.stderr.write(d);
    tail = (tail + d.toString('utf8')).slice(-STDERR_TAIL_KEEP);
  });
  let spawnError: Error | undefined;
  child.on('error', (e) => {
    spawnError = e;
    console.error(`[acp] child process error (${def.id}):`, e.message);
  });
  child.on('exit', (code, signal) => {
    if (!isCurrent()) return;
    console.debug(`[acp] child process exited (${def.id}): code=${code} signal=${signal}; resetting connection handles to rebuild next turn`);
    onCurrentExit();
  });
  return { spawnError: () => spawnError, stderrTail: () => tail };
}

/**
 * Build the ACP content blocks for a turn prompt, handling reconnect probes and connect-agent
 * topic metadata.
 */
export function buildTurnPromptInput(
  def: AgentDef,
  input: RunTurnInput,
  blocksOf: (input: Pick<RunTurnInput, 'prompt' | 'images'>) => ContentBlock[]
): ContentBlock[] {
  if (input.reconnect) {
    return [{ type: 'text', text: '', _meta: { fleetherd: { reconnect: true } } }] as ContentBlock[];
  }
  const blocks = blocksOf(input);
  // Carry the topic on the prompt too for connect agents: a session warmed up by `/model`
  // before the first turn initialized without one.
  if (def.connect && input.topic) {
    const last = blocks[blocks.length - 1];
    if (last?.type === 'text') {
      blocks[blocks.length - 1] = { ...last, _meta: { fleetherd: { topic: input.topic } } } as ContentBlock;
    }
  }
  return blocks;
}

// ───────────────────────── Startup diagnostics & RPC helpers ─────────────────────────

/** How much of a child's stderr is kept for a startup failure to quote (see adoptAcpChild). */
export const STDERR_TAIL_KEEP = 4_000;
/** How much of it the failure message carries: the last lines, which is where an error ends up. */
const STDERR_QUOTE_CHARS = 600;
/** How much of an error the agent answered with the failure message carries. */
const STARTUP_ERROR_CHARS = 600;

/** How far an agent's startup got (startSession), for the message its failure is reported with. */
export interface StartupProgress {
  /** Whether the process has answered anything at all — a result or an error, to any request. */
  answered: boolean;
  /** The request the startup was waiting on, or the last one it sent. */
  step: 'initialize' | 'session/load' | 'session/new' | 'session/set_config_option' | 'session/fork' | 'session/resume';
}

/** The startup's own deadline, told apart from an error the agent sent. */
export class StartupTimeout extends Error {
  constructor() {
    super('startup timed out');
    this.name = 'StartupTimeout';
  }
}

/**
 * What to add to a startup failure the harness gave no reason for. An agy older than 1.5 has no
 * `acp` subcommand — it takes the word as a stray prompt argument and exits — which reaches here as
 * a closed connection, so the version to check is named.
 */
function startupHint(def: AgentDef): string {
  return def.harness === 'agy'
    ? ' (`agy acp` needs agy 1.5 or later — check `agy --version` on that machine and upgrade it)'
    : '';
}

/**
 * The TurnFailure a startup that did not happen is reported with (startupFailureMessage). `err` is
 * what ended it: the startup's own deadline, an error the agent answered with, or the connection
 * closing under it.
 */
export function startupFailure(
  def: AgentDef,
  err: unknown,
  p: { host: string | undefined; launch: string; progress: StartupProgress; stderr: string; timeoutMs: number }
): TurnFailure {
  const timedOut = err instanceof StartupTimeout;
  const message = startupFailureMessage({
    agent: def.id,
    ...(p.host ? { host: p.host } : {}),
    launch: p.launch,
    // An error answer is the process speaking, whichever request it answered.
    progress: isRpcError(err) ? { ...p.progress, answered: true } : p.progress,
    ...(timedOut ? { timeoutMs: p.timeoutMs } : { error: err }),
    stderr: p.stderr,
    hint: startupHint(def),
  });
  return new TurnFailure(message, 'startup');
}

/**
 * Whether an error is a JSON-RPC error answer (the SDK's RequestError carries the numeric `code`).
 * A closed connection rejects with a plain Error instead, which is the process going away without a
 * word — the one way an `initialize` failure says nothing about whether it ever came up.
 */
function isRpcError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number';
}

/**
 * An error the agent answered with, as one line: its message and, when it sent any, its `data` —
 * where an ACP agent puts the detail (`Internal error` alone names nothing).
 */
function rpcErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const data = (err as { data?: unknown } | null)?.data;
  let detail = '';
  if (typeof data === 'string') detail = data;
  else if (data !== undefined && data !== null) {
    const inner = (data as { details?: unknown; message?: unknown }).details ?? (data as { message?: unknown }).message;
    detail = typeof inner === 'string' ? inner : JSON.stringify(data);
  }
  const text = (detail && !message.includes(detail) ? `${message}: ${detail}` : message).replace(/\s+/g, ' ').trim();
  return text.length > STARTUP_ERROR_CHARS ? `${text.slice(0, STARTUP_ERROR_CHARS - 1)}…` : text;
}

/** The last lines of what a child wrote to stderr, on one line, or '' when it wrote nothing. */
function stderrQuote(tail: string): string {
  // Terminal colour codes, which some agents put in their logs whether or not stderr is a terminal.
  const lines = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]} | ${out}` : lines[i]!;
    if (next.length > STDERR_QUOTE_CHARS) {
      if (!out) out = `…${next.slice(-(STDERR_QUOTE_CHARS - 1))}`;
      break;
    }
    out = next;
  }
  return out;
}

/**
 * What a failed startup says. Two different failures with two different fixes, and the message
 * has to send the person to the right one:
 *
 *  - **the process did not come up** — it never answered `initialize`. The launch command, or the
 *    machine it runs on, is what to look at.
 *  - **the process came up and opening a session failed** — it answered `initialize`, then
 *    `session/new` (or `session/load`) failed or went unanswered. The command is fine; what the
 *    agent needs behind it — its model backend, a relay, the network — is not. The agent's own error
 *    is quoted when it sent one.
 *
 * Until 2026-11-13 every timeout said "Make sure the launch command is executable on PATH", which was
 * wrong for the second kind: the four agy timeouts of 2026-11-11 had answered `initialize` in 11ms
 * and hung on `session/new` behind a relay answering 502 and a DNS timeout.
 *
 * Whatever the child last wrote to stderr is added to either: it is often the only place an agent
 * says why. Exported for its test.
 */
export function startupFailureMessage(p: {
  agent: string;
  host?: string;
  launch: string;
  progress: StartupProgress;
  /** Set when the startup's deadline passed; the error then is the deadline, not the agent's. */
  timeoutMs?: number;
  error?: unknown;
  stderr: string;
  /** What to add when the process never answered (startupHint). */
  hint: string;
}): string {
  const where = p.host ? ` on host "${p.host}"` : '';
  const said = stderrQuote(p.stderr);
  const stderr = said ? ` Its last output on stderr: ${said}` : '';
  const within = p.timeoutMs !== undefined ? ` within ${Math.round(p.timeoutMs / 1000)}s` : '';
  if (!p.progress.answered) {
    const why =
      p.timeoutMs !== undefined
        ? `its process gave no answer to initialize${within}`
        : `its process went away before answering initialize (${p.error instanceof Error ? p.error.message : String(p.error)})`;
    return (
      `agent "${p.agent}" did not start${where}: ${why}. ` +
      `Check that \`${p.launch}\` runs there and speaks ACP, and how loaded that machine is.${stderr}${p.hint}`
    );
  }
  if (p.timeoutMs !== undefined) {
    return (
      `agent "${p.agent}" started${where}, but ${p.progress.step} got no answer${within}. The process is up; ` +
      `what it needs to open a session (its model backend, a relay, the network) is not responding.${stderr}`
    );
  }
  return `agent "${p.agent}" started${where}, but ${p.progress.step} failed: ${rpcErrorText(p.error)}.${stderr}`;
}

/**
 * Whether a buildSession().start() (session/new) failure means "must log in first" (auth_required).
 * ACP expresses un-auth as session/new returning an `authRequired` stop reason or an auth-flavored error;
 * wording varies per harness, so match message/code loosely. Used only for a readable hint, not interactive auth.
 */
export function isAuthRequired(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const code = (err as { code?: unknown })?.code;
  return /auth[_-]?required|authentication|not\s+logged\s*in|unauthor/i.test(msg) || code === 'auth_required';
}

export function readReconnectSupport(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const meta = (capabilities as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return false;
  const fleetherd = (meta as Record<string, unknown>)['fleetherd'];
  return !!fleetherd && typeof fleetherd === 'object' && (fleetherd as Record<string, unknown>)['reconnectTurn'] === true;
}

export function isNotSentRpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const data = (err as { data?: unknown }).data;
  return !!data && typeof data === 'object' && (data as Record<string, unknown>)['notSent'] === true;
}

/**
 * Turn a failure record from a `session_info_update` into a deduplicated notice (claude-agent-acp
 * AIR `sessionFailure` extension). Suppressed before the session's first prompt so `session/load`
 * history replay never re-announces historical outages.
 */
export function announceSessionFailure(opts: {
  def: AgentDef;
  conversationId: string;
  promptedYet: boolean;
  failure: SessionFailure;
  handlers: AgentStreamHandlers;
  announced: Set<string>;
}): void {
  const { def, conversationId, promptedYet, failure, handlers, announced } = opts;
  const line = describeSessionFailure(failure);
  if (!promptedYet) {
    console.debug(`[acp] ${conversationId}: not announcing a failure record from before the first prompt: ${line}`);
    return;
  }
  console.log(`[acp] ${conversationId}: ${def.harness} reported a ${failure.severity} (${failure.category}): ${line}`);
  const key = failureNoticeKey(failure);
  if (announced.has(key)) return;
  announced.add(key);
  handlers.onNotice?.(`${failure.severity === 'error' ? '❌' : '⚠️'} ${def.id}: ${trimReason(line)}`);
}

export interface TurnPromptDriver {
  send: (session: ActiveSession, blocks: ContentBlock[]) => void;
  settled: Promise<void>;
  promptFailed: Promise<never>;
  promptDone: () => Promise<PromptResponse> | undefined;
  isLastSettled: () => boolean;
  hasQueuedPrompt: () => boolean;
  onStop: (response?: PromptResponse) => void;
}

/**
 * Tracks one turn's `session/prompt` calls (including mid-turn joined prompts on `prompt`-mode
 * harnesses), matching each queue `stop` against the turn's latest prompt so stale stops from
 * folded or earlier prompts cannot prematurely end the turn.
 */
export function createTurnPromptDriver(conversationId: string): TurnPromptDriver {
  let promptDone: Promise<PromptResponse> | undefined;
  let ownResponse: PromptResponse | undefined;
  let lastSettled = false;
  let unsettled = 0;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let failTurn: (err: unknown) => void = () => {};
  const promptFailed = new Promise<never>((_, reject) => {
    failTurn = reject;
  });
  void promptFailed.catch(() => {});

  const onStop = (response?: PromptResponse): void => {
    if (response === undefined || response === ownResponse) {
      resolveSettled();
      return;
    }
    const ignore = (): void =>
      console.log(`[acp] ${conversationId}: ignoring a stop that belongs to an earlier prompt`);
    if (!promptDone) {
      ignore();
      return;
    }
    void promptDone.then((own) => (own === response ? resolveSettled() : ignore()), () => {});
  };

  const send = (session: ActiveSession, blocks: ContentBlock[]): void => {
    const p = session.prompt(blocks);
    promptDone = p;
    ownResponse = undefined;
    lastSettled = false;
    unsettled++;
    void p.then(
      (r) => {
        unsettled--;
        if (promptDone !== p) return;
        ownResponse = r;
        lastSettled = true;
      },
      (err) => {
        unsettled--;
        if (promptDone === p) lastSettled = true;
        failTurn(err);
      }
    );
  };

  return {
    send,
    settled,
    promptFailed,
    promptDone: () => promptDone,
    isLastSettled: () => lastSettled,
    hasQueuedPrompt: () => unsettled > 1,
    onStop,
  };
}

/** Build the mid-turn steering handler for `prompt` (claude/agy) or `steer` (codex) harnesses. */
export function createSteerHandler(opts: {
  conversationId: string;
  steeringMode: SteeringMode;
  session: ActiveSession;
  agentCtx: ClientContext;
  driver: TurnPromptDriver;
  canSteer: () => boolean;
}): ((blocks: ContentBlock[]) => Promise<SteerOutcome>) | undefined {
  const { conversationId, steeringMode, session, agentCtx, driver, canSteer } = opts;
  if (steeringMode === 'none') return undefined;
  return (blocks) => {
    if (driver.isLastSettled() || !canSteer()) return Promise.resolve('refused');
    if (steeringMode === 'prompt') {
      driver.send(session, blocks);
      return Promise.resolve('joined');
    }
    return agentCtx.request(STEER_METHOD, steerParams(session.sessionId, blocks)).then(
      (res) => {
        const outcome = readSteerOutcome(res);
        if (outcome === 'detached') {
          console.warn(`[acp] ${conversationId}: the turn had ended inside the harness; it answers the message as background output`);
        }
        return outcome;
      },
      (err: unknown) => {
        console.warn(`[acp] ${conversationId}: ${STEER_METHOD} failed (${err instanceof Error ? err.message : err}); the message waits for the turn`);
        return 'refused' as const;
      }
    );
  };
}

// ───────────────────────── Harness quirk adapters ─────────────────────────

/**
 * How long a turn waits, after an AUTONOMOUS cycle of the harness ends inside it with no reply of
 * the turn's own, before concluding that its prompt was answered inside that cycle.
 *
 * ── The upstream bug this works around ─────────────────────────────────────────────────────────
 * claude-agent-acp issue #1145 (open as of 2026-09-29; the fix, PR #1185, unmerged; still present
 * in 0.84.0). A background task finishes, and Claude Code starts a cycle of its own to report it
 * (`origin: {kind: "task-notification"}`). A prompt sent while that cycle runs is FOLDED into it:
 * Claude Code's transcript records `queue-operation remove, reason: "absorbed_mid_turn"`. The model
 * answers both and the cycle ends with one `result`, which names the prompt in
 * `user_message_uuid(s)` — but the adapter classifies results by origin alone, files it as
 * autonomous, and never settles the prompt. `session/prompt` does not return until something else
 * releases it: the next prompt, or a cancel.
 *
 * Capped at half the silence budget when that is smaller, because the point is to decide before
 * the watchdog does: a fold declared after the turn already failed as hung is no help.
 */
export const FOLDED_PROMPT_GRACE_MS = 30_000;

/**
 * Watch one turn for the sign that its prompt was folded into an autonomous cycle and answered
 * there — the claude-agent-acp bug described at FOLDED_PROMPT_GRACE_MS, where the prompt's own
 * `stop` never comes.
 */
export function watchForFoldedPrompt(
  conversationId: string,
  turnTimeoutMs: number,
  state: TurnState,
  isAwaitingUser: () => boolean
): {
  /** Feed every update the turn receives once its prompt is out. */
  observe: (update: SessionUpdate) => void;
  /** Resolves when the turn should stop waiting for a `stop` that is not coming. */
  folded: Promise<'folded'>;
  stop: () => void;
} {
  const graceMs =
    turnTimeoutMs > 0 ? Math.min(FOLDED_PROMPT_GRACE_MS, turnTimeoutMs / 2) : FOLDED_PROMPT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let declare: () => void = () => {};
  const folded = new Promise<'folded'>((resolve) => {
    declare = () => resolve('folded');
  });
  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const decide = (origin: string): void => {
    timer = undefined;
    if (isAwaitingUser()) return;
    if (hasOpenToolCall(state)) {
      console.log(
        `[acp] ${conversationId}: a ${origin} cycle ended with a tool call still open; leaving this turn to the watchdog`
      );
      return;
    }
    console.log(
      `[acp] ${conversationId}: a ${origin} cycle ended ${graceMs}ms ago and this prompt has had no reply of its own; ` +
        'treating it as answered inside that cycle (claude-agent-acp #1145) and ending the turn'
    );
    declare();
  };
  return {
    folded,
    observe: (update) => {
      const origin = autonomousResultOrigin(update);
      if (origin) {
        disarm();
        timer = setTimeout(() => decide(origin), graceMs);
        return;
      }
      if (isRenderableUpdate(update)) disarm();
    },
    stop: disarm,
  };
}

/**
 * How often a turn asks the harness's own log what went wrong (see harness-log.ts).
 *
 * A minute is chosen against the thing being waited on, not the thing being read: the failure it
 * surfaces is a retry loop that lasts until the watchdog fires ten minutes later, so a minute turns
 * a silent ten-minute wait into one that explains itself early and repeats nothing. Only harnesses
 * with a probe start the timer at all, and each tick is one bounded tail read.
 */
const HARNESS_LOG_POLL_MS = 60_000;

/**
 * Watch the harness's own log for the duration of one turn (e.g. opencode rate-limit retries).
 * Deliberately does NOT end the turn; announces each distinct reason once and supplies the latest
 * reason to the watchdog on timeout.
 */
export function watchHarnessLog(
  def: AgentDef,
  conversationId: string,
  getSessionId: () => string | undefined,
  handlers: AgentStreamHandlers
): {
  /** The harness's last word on this turn, re-read at the moment it is asked for. */
  lastReason: () => Promise<string | undefined>;
  stop: () => void;
} {
  const startedAt = new Date();
  const announced = new Set<string>();
  let latest: string | undefined;
  const poll = async (announce: boolean): Promise<void> => {
    const events = await readHarnessErrors(def, getSessionId(), startedAt);
    for (const e of events) {
      latest = e.reason;
      if (!announce || announced.has(e.reason)) continue;
      announced.add(e.reason);
      console.log(`[acp] ${conversationId}: ${def.harness} logged an error mid-turn: ${e.reason}`);
      handlers.onNotice?.(`⚠️ ${def.id} hit an error and is retrying: ${trimReason(e.reason)}`);
    }
  };
  const timer = harnessLogProbe(def.harness)
    ? setInterval(() => void poll(true), HARNESS_LOG_POLL_MS)
    : undefined;
  timer?.unref();
  return {
    lastReason: async () => {
      await poll(false);
      return latest;
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

/**
 * Tracks agy's transcript-based context readings and quota reporting for one session.
 * Composed by `AcpSession` so agy-specific metering stays out of the core lifecycle file.
 */
export class AgyMeterHelper {
  private readonly loggedOnce = new Set<string>();
  private contextSeq = 0;
  private contextShown = 0;
  private contextReadAt = 0;

  constructor(
    private readonly def: AgentDef,
    private readonly conversationId: string,
    private readonly options: AcpOptionState,
    private readonly quota: QuotaMeter | undefined,
    private readonly isDisposed: () => boolean,
    private readonly getSessionId: () => string | undefined
  ) {}

  private logOnce(key: string, line: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    console.log(line);
  }

  /** Report the cached quota pools scoped to this session's active model/options. */
  reportScopedQuota(handlers: AgentStreamHandlers): void {
    const pools = this.quota?.read(this.def);
    if (!this.isDisposed() && pools) {
      const scoped = scopeQuotaPools(pools, customOptionsOf(this.options.liveConfigOptions));
      handlers.onQuota?.(markActivePools(scoped, this.options.liveModel));
    }
  }

  /** Report cached quota immediately and kick off a background refresh beside the turn. */
  quotaForTurn(handlers: AgentStreamHandlers, cwd: string): void {
    const meter = this.quota;
    if (!meter) return;
    const report = (): void => this.reportScopedQuota(handlers);
    report();
    void meter.refresh(this.def, cwd).then(report, () => {});
  }

  /** Report agy's context against the window known for the session's model, or say once why not. */
  private reportAgyContext(handlers: AgentStreamHandlers, used: number): void {
    const model = this.options.currentModelValue();
    const size = agyWindow(this.def, model);
    if (size) handlers.onUsage?.({ used, size });
    else {
      this.logOnce(
        `window:${model}`,
        `[acp] ${this.conversationId}: no known context window for agy's ${model}, so its footer shows no context numbers (see daemon/agy-meters.ts)`
      );
    }
  }

  /** Read agy's context off its transcript and report it; false when there was nothing to report. */
  private async readAgyContextInto(handlers: AgentStreamHandlers): Promise<boolean> {
    const sessionId = this.getSessionId();
    if (!sessionId) return false;
    const seq = ++this.contextSeq;
    this.contextReadAt = Date.now();
    const used = await readAgyContext(this.def, sessionId);
    if (used === undefined || this.isDisposed()) return false;
    if (seq < this.contextShown) return true;
    this.contextShown = seq;
    this.reportAgyContext(handlers, used);
    return true;
  }

  /** Mid-turn throttled refresh after a model call that asked for a tool. */
  refreshAgyContext(handlers: AgentStreamHandlers): void {
    if (Date.now() - this.contextReadAt < AGY_CONTEXT_REFRESH_MS) return;
    void this.readAgyContextInto(handlers);
  }

  /**
   * The end of an agy turn that came back `end_turn`: fail it on agy's own word, or report its
   * context from the prompt's usage or agy's transcript.
   */
  async settleAgyTurn(state: TurnState, response: PromptResponse, aborting: boolean): Promise<void> {
    const watch = state.agy;
    if (!watch || aborting || response.stopReason === 'cancelled') return;
    const handlers = state.handlers;
    const outcome = watch.settle(response.usage);
    if (outcome.failure) throw outcome.failure;
    if (outcome.contextTokens !== undefined) {
      this.contextShown = ++this.contextSeq;
      this.reportAgyContext(handlers, outcome.contextTokens);
    } else if (outcome.noContext === 'tools' && !(await this.readAgyContextInto(handlers))) {
      this.logOnce(
        'tools',
        `[acp] ${this.conversationId}: agy reports usage once per turn, summed over its model calls, and its transcript could not be read, so a turn that ran tools gets no context numbers (see daemon/agy-transcript.ts)`
      );
    }
  }
}
