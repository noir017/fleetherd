import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  ActiveSession,
  ClientConnection,
  ClientContext,
} from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentElicitation,
  AgentPermissionRequest,
  ElicitOption,
  ElicitQuestion,
  PermissionAnswer,
  SteerOutcome,
  ToolEvent,
} from '../types.js';
import type { AgentDef, Config } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type {
  AgentFactory,
  AgentSession,
  AgentStreamHandlers,
  EffortSelector,
  FollowUpSink,
  ModelSelector,
  ReclaimState,
  RunTurnInput,
} from './agent.js';
import { TurnFailure } from './agent.js';
import { harnessLogProbe, readHarnessErrors } from './harness-log.js';
import { readSteerOutcome, STEER_METHOD, steeringModeOf, steerParams, type SteeringMode } from './acp-steering.js';
import {
  describeSessionFailure,
  failureNoticeKey,
  failureReasonOf,
  readSessionFailure,
  SESSION_FAILURE_CAPABILITY_META,
  type SessionFailure,
} from './session-failure.js';
import type { ConversationStore } from './conversation-store.js';
import {
  buildAgentEnv,
  buildInputPreview,
  isNonEmptyObject,
  killChildProcess,
  prepareRemoteSpawn,
  remoteAgentEnv,
  resolveConversationCwd,
  stripCode,
  trimReason,
  truncateToolName,
  watchRemoteLink,
  type AgentChild,
} from './agent-common.js';
import { PreLaunchCancelled, runPreLaunchHook } from './agent-hooks.js';
import { remoteHosts } from './remote-hosts.js';
import { selfInvocation } from './reverse-cli-shim.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';

/**
 * AgentFactory's ACP (Agent Client Protocol) implementation on the official @agentclientprotocol/sdk.
 *
 * talkcode daemon = ACP "client/host". Each (conversationId, agentId) spawns a resident ACP agent child
 * (claude-agent-acp / gemini --experimental-acp / any custom), translating ACP session/update stream
 * notifications back to the existing AgentStreamHandlers, reusing all outbound rendering (StreamBuffer / ToolRenderer).
 *
 * Mapping:
 *   session/new                ↔ an AgentSession (one ACP session per session key, context across turns)
 *   session/prompt             ↔ runTurn (via ActiveSession.prompt + nextUpdate iteration)
 *   agent_message_chunk        ↔ onText
 *   tool_call                  ↔ onToolStart
 *   tool_call_update (terminal)↔ onToolFinish
 *   text↔tool block boundary   ↔ onSegmentBreak
 *   session/cancel             ↔ abort
 *   session/request_permission ↔ permission policy (bypass/deny implemented; ask/acceptEdits see seam)
 *
 * TOKEN model (per-session): ACP is a resident process, env fixed at spawn. So the daemon gives each
 * session a stable token (RunTurnInput.sessionToken, same every turn), injected as TALKCODE_TURN_TOKEN.
 * Reverse commands use it to connect back; the daemon resolves "token → session → current turn channel" (see session.ts).
 */

/** ACP protocol version: taken from the installed SDK's PROTOCOL_VERSION, auto-aligning on upgrade (no hardcoded drift). */
const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

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
 * MCP servers handed to the agent in `session/new` and `session/load`: `talkcode mcp`, which
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
        { name: 'TALKCODE_TURN_TOKEN', value: sessionToken },
        { name: 'TALKCODE_SOCKET', value: socketPath },
        { name: 'TALKCODE_CWD', value: cwd },
      ],
    },
  ];
}

/**
 * The same server for an agent on a remote host: the host's `talkcode` shim (on PATH there, but
 * named absolutely — a harness may start MCP servers with a stripped environment), which carries
 * the session back to this gateway's own `talkcode mcp` (remote-hosts.ts runCli). The socket it
 * dials is passed explicitly for the same reason.
 */
export function remoteMcpServers(sessionToken: string, paths: { shim: string; socket: string }, cwd: string): McpServer[] {
  return [
    {
      name: NATIVE_TOOLS_SERVER,
      command: paths.shim,
      args: ['mcp'],
      env: [
        { name: 'TALKCODE_TURN_TOKEN', value: sessionToken },
        { name: 'TALKCODE_REMOTE_SOCK', value: paths.socket },
        { name: 'TALKCODE_CWD', value: cwd },
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
      // talkcode` for a harness most operators never configure, and the operator who
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
      // refine already guarantees command exists.
      return { command: def.command!, args: [...def.args] };
    case 'agy':
      // Unreachable: agy has no ACP mode, so agent-factory routes it to the agent-agy runtime and
      // this function is never called for it. Kept as an explicit arm so the switch stays exhaustive
      // (a future preset then fails to compile here rather than falling through silently).
      throw new Error('internal: harness "agy" is served by agent-agy.ts, not the ACP runtime');
  }
}

// ───────────────────────────────── factory / session ─────────────────────────────────

export function createAcpAgentFactory(cfg: Config, socketPath: string, store?: ConversationStore): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  const turnTimeoutMs = cfg.session.turnTimeoutMs;

  return {
    getOrCreate(sessionId: string, agentId: string): AgentSession {
      let s = sessions.get(sessionId);
      if (!s) {
        const def = findAgent(cfg, agentId);
        if (!def) throw new Error(`unknown agent id: ${agentId} (check the routing and agents config)`);
        s = createAcpSession(def, socketPath, sessionId, turnTimeoutMs, store);
        sessions.set(sessionId, s);
      }
      return s;
    },
    peek(sessionId: string): AgentSession | undefined {
      return sessions.get(sessionId);
    },
    dispose(sessionId: string): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.dispose();
      sessions.delete(sessionId);
    },
  };
}

/** Thrown by the per-turn silence watchdog so runTurn can reap the hung subprocess before rethrowing. */
class TurnTimeoutError extends TurnFailure {
  constructor(message: string) {
    super(message, 'hung');
  }
}

/**
 * How long a burst of out-of-turn output may stay silent before it is sealed and decorated.
 *
 * A backstop, not the primary signal: a burst normally closes the moment the harness reports its
 * terminal result (see isResultUsage), and this only covers a harness that stops carrying that
 * marker. Generous on purpose — a background followup can sit inside one tool call for minutes, and
 * cutting it early costs an extra message bubble, so the timer errs toward waiting.
 */
const FOLLOW_UP_QUIET_MS = 180_000;

/**
 * Consecutive queue rejections the reader tolerates before standing down, and how long it waits
 * between them. See the comment in pumpUpdates: a failed prompt rejects once and pumping must go
 * on, while a closed connection rejects forever — this bounds the spin to ~1s in the second case
 * without giving up on a session that is merely reporting a per-turn error.
 */
const MAX_QUEUE_REJECTIONS = 20;
const QUEUE_REJECT_BACKOFF_MS = 50;

/**
 * Extra silence a turn is allowed, as a multiple of `turnTimeoutMs`, while the harness has an
 * unfinished tool call open.
 *
 * Not a fudge factor — it closes a guaranteed collision. The watchdog exists to catch an agent that
 * is "alive but never sending `stop` nor any update", and a tool call is silent for exactly as long
 * as it runs, so from outside the two are indistinguishable. Claude Code's own Bash tool allows up
 * to 600000ms (its documented maximum), which is *precisely* the default `turnTimeoutMs` — so a
 * tool call at the limit the harness itself permits was certain to trip a watchdog aimed at hangs,
 * and the turn failed with "sent no update for 600000ms" while the script was still running fine.
 * `turnTimeoutMs` is frozen in EXPERIENCE and not reachable from config.yaml, so an operator could
 * not raise it out of the way either.
 *
 * Granted ONCE per stretch of silence, so the ceiling stays finite: 30 minutes at the default. Long
 * enough for anything the harness will run in the foreground, short enough that a genuinely wedged
 * tool still fails rather than pinning the conversation in `running` forever. Work that outlives
 * even that belongs in the background, which is now forwarded properly (see FollowUpSink).
 */
export const TOOL_SILENCE_FACTOR = 2;

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
 * Seen live 2026-09-29 (web topic, quantlab): the answer streamed in full, then nothing, and the
 * silence watchdog failed the turn ten minutes later as "hung". Most occurrences never got that
 * far — `inbound.interruptOnNewMessage` (removed after 2.0.0) cancelled the stuck turn as soon as the
 * user said anything — which is why thirty-odd folds in a week surfaced as one failure. Without it,
 * this grace is what ends such a turn.
 *
 * ── What the gateway can see, and why this waits instead of acting at once ────────────────────
 * The adapter still reports the cycle's end: the result-tied `usage_update` carries the result's
 * origin in `_meta["_claude/origin"]` (see autonomousResultOrigin). What it cannot say is whether
 * THIS prompt was folded into that cycle or merely queued behind it; a queued prompt starts its
 * own cycle right after, and output resumes. So the turn waits for silence: renderable output
 * cancels the wait, and nothing arriving means there is nothing left to wait for.
 *
 * Getting it wrong costs little either way. Too early — a queued prompt whose first output is
 * slower than this — and the turn ends with what it has, while the real reply still arrives and
 * is rendered as a background update (see FollowUpSink); nothing is lost. The stale prompt is left
 * for the adapter to settle at the next prompt, and runTurn only ends on a `stop` that is its own,
 * so that late settlement cannot end the next turn. Too late costs the same wait as today, bounded
 * by the watchdog. Thirty seconds sits well past a cached cycle's time to first output, and far
 * short of the ten minutes it replaces — and in `once` delivery mode the answer's last segment is
 * not sent until the turn ends, so this IS how late the answer arrives.
 *
 * Capped at half the silence budget when that is smaller, because the point is to decide before
 * the watchdog does: a fold declared after the turn already failed as hung is no help.
 */
export const FOLDED_PROMPT_GRACE_MS = 30_000;

/**
 * Result origins claude-agent-acp files as AUTONOMOUS — work the model did on its own rather than
 * for the prompt. A copy of the adapter's own AUTONOMOUS_RESULT_ORIGINS (0.81.2 dist/acp-agent.js),
 * kept in step with it deliberately: an origin the adapter treats as the user's own settles the
 * prompt normally, so listing more here would only arm a wait that the prompt's `stop` cancels.
 */
const AUTONOMOUS_RESULT_ORIGINS: ReadonlySet<string> = new Set([
  'task-notification',
  'peer',
  'coordinator',
  'observer',
  'observer-activity',
]);

/**
 * The origin of the cycle a result-tied `usage_update` reports, when that cycle was autonomous —
 * i.e. "Claude Code just finished something nobody's prompt asked for". Undefined for everything
 * else, including the ordinary end of a prompt's own cycle.
 *
 * ⚠️ HYRUM'S LAW: `_claude/origin` is claude-agent-acp's private extension, not ACP. Verified in
 * 0.81.2 (2026-09-29), where the result handler sends `usage_update` with
 * `_meta: {"_claude/origin": message.origin}` whenever the SDK result carries an origin. If a
 * release stops sending it, this returns undefined and folded prompts fall back to the silence
 * watchdog — the behaviour before this existed, not a new failure.
 */
export function autonomousResultOrigin(update: SessionUpdate): string | undefined {
  if (!isResultUsage(update)) return undefined;
  const origin = update._meta?.['_claude/origin'];
  const kind = typeof origin === 'object' && origin !== null && 'kind' in origin ? origin.kind : undefined;
  return typeof kind === 'string' && AUTONOMOUS_RESULT_ORIGINS.has(kind) ? kind : undefined;
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
 * Grace period after the harness reports a completed result before a burst of out-of-turn output
 * is sealed and decorated.
 *
 * Not zero, because the "a result finished" marker is weaker than it looks — see the note at its
 * use in pumpUpdates. Short enough that a background report is not visibly late (in the default
 * `once` delivery mode nothing is sent until the buffer completes, so this IS the latency), long
 * enough that a harness reporting cost on every snapshot does not fragment one report into many.
 */
const FOLLOW_UP_SEAL_GRACE_MS = 1_500;

/**
 * Whether a `usage_update` is the one the harness emits with a completed result, as opposed to a
 * mid-stream snapshot — i.e. "a piece of work just finished here".
 *
 * Read off `cost`, which is part of the ACP UsageUpdate schema rather than a private extension.
 * Verified against claude-agent-acp 0.58.1 (2026-09): the mid-stream send passes `{used, size}`
 * only, while the send tied to the SDK's `result` message always adds
 * `cost: {amount: total_cost_usd, currency: 'USD'}`. Hyrum's Law applies — a harness that started
 * reporting cumulative cost mid-stream would end follow-up bursts early, which costs an extra
 * message bubble and loses nothing (the quiet backstop and the next burst both still work).
 */
export function isResultUsage(update: SessionUpdate): boolean {
  return update.sessionUpdate === 'usage_update' && update.cost != null;
}

/**
 * Pull the live model's display name out of an ACP `configOptions` list (as returned by session/new
 * and refreshed by `config_option_update`).
 *
 * Why bother, when the config already names a model: for some agents it doesn't. The `claude` harness
 * takes its model from the ANTHROPIC_MODEL env var (the only source that survives Claude Code
 * rewriting settings.model), so `agents[].model` is empty and the config knows only an alias like
 * `opus[1m]` — never the concrete model actually serving the turn. The harness resolves that alias
 * itself and reports the result here, so this is the only accurate source.
 *
 * Shape (SessionConfigOption): the model selector is `{id:'model', type:'select', currentValue,
 * options}` where options are either flat SessionConfigSelectOption[] or grouped
 * SessionConfigSelectGroup[] ({group, options}). Returns undefined when the agent exposes no model
 * selector; falls back to the raw `currentValue` when the option isn't listed at all (an
 * allowlisted-but-unlisted model still reports a currentValue).
 *
 * Label choice, in order:
 *
 * 1. **The concrete model out of the option's `description`.** Neither the id nor the display name
 *    carries a version on the claude harness — it offers `opus[1m]` / "Opus", which says which
 *    family is running but not which release, so a footer reading `opus[1m]` never changed when the
 *    model behind that alias did. The description is where the harness states it, verbatim:
 *    "Opus 4.8 with 1M context · Best for everyday, complex tasks" (probed live against
 *    claude-agent-acp 0.58.1). Parsed to `opus-4-8`, which is the model, spelled the way it is
 *    everywhere else. `[1m]` drops out with it, and nothing is lost: the footer's own context
 *    segment already reads `/ 1M` beside it, so the qualifier was saying twice what one number says.
 * 2. The option's human-readable `name`, when it doesn't LOSE a qualifier the id carries — the
 *    fallback for a harness whose descriptions carry no version (see nameKeepsQualifiers).
 * 3. The raw `currentValue`, when the option isn't listed at all.
 */
export function liveModelName(options: SessionConfigOption[] | null | undefined): string | undefined {
  const opt = options?.find((o) => o.id === MODEL_CONFIG_ID);
  if (!opt || opt.type !== 'select') return undefined;
  const current = opt.currentValue;
  if (typeof current !== 'string' || current.length === 0) return undefined;
  // Flatten grouped options so both shapes are searched the same way.
  const flat = opt.options.flatMap((entry) =>
    'group' in entry ? entry.options : [entry]
  );
  const selected = flat.find((o) => o.value === current);
  const concrete = concreteModelName(selected?.description);
  if (concrete) return concrete;
  const name = selected?.name;
  if (!name) return current;
  return nameKeepsQualifiers(name, current) ? name : current;
}

/**
 * `<family>-<version>` pulled out of an option description, or undefined when it doesn't state one.
 *
 * The shape being read is the headline before the `·` separator — "Opus 4.8 with 1M context",
 * "Sonnet 5", "Haiku 4.5", "Fable 5.1" — of which only the leading family and version are the
 * model's identity; the rest is either a qualifier the footer already shows or marketing.
 *
 * Deliberately strict, and undefined on anything that doesn't match: this runs for every harness,
 * and a description that is a sentence rather than a model name (opencode writes none at all) must
 * fall through to the name/id path rather than yield a plausible-looking wrong answer.
 */
function concreteModelName(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const headline = description.split('·')[0]!.trim();
  const m = /^([A-Za-z][A-Za-z0-9]*)\s+(\d+(?:\.\d+)*)(?:\s|$)/.exec(headline);
  if (!m) return undefined;
  return `${m[1]!.toLowerCase()}-${m[2]!.replace(/\./g, '-')}`;
}

/**
 * Whether `name` still conveys every bracketed qualifier present in the option `id` (e.g. `[1m]`).
 * Compared loosely — bracket-free and case-insensitive — so "Sonnet 5 (1M context)" counts as
 * carrying `[1m]`, while a bare "Opus" does not carry it for id `opus[1m]`.
 *
 * Only reached when the description states no version. Where one is stated it wins outright, and
 * the qualifier is dropped on purpose — see liveModelName.
 */
function nameKeepsQualifiers(name: string, id: string): boolean {
  const haystack = name.toLowerCase().replace(/[[\]()\s]/g, '');
  return [...id.matchAll(/\[([^\]]+)\]/g)].every((m) =>
    haystack.includes(m[1]!.toLowerCase().replace(/\s/g, ''))
  );
}

/**
 * The session's reasoning effort, read out of its ACP `configOptions` for the footer.
 *
 * Found by `category`, not by `id`, because the harnesses disagree on the id and agree on the
 * category — probed 2026-09-23: claude-agent-acp 0.81.0 and opencode 2.0.14 both call it `effort`,
 * codex-acp (codex-cli 0.155.1) calls it `reasoning_effort`, and all three tag it
 * `category: "thought_level"`, which is the ACP spec's own name for this selector. The spec calls
 * category "UX only", and UX is exactly what this is: nothing but the footer reads the answer.
 *
 * Returns undefined — segment omitted — in three situations, each of them deliberate:
 * - no such option. opencode offers one only while the current model has reasoning variants (none
 *   on `opencode/mimo-v2.6-flash-free`; switching to `anthropic/claude-opus-4-8` adds it), and dsh
 *   and gemini have none at all;
 * - `default`, which is where claude and opencode start. It means "whatever the model defaults to"
 *   and names no level, so printing it would look like a level while telling the reader nothing;
 * - a non-string currentValue (a boolean option filed under the category by some future harness).
 *
 * The raw value is returned rather than the option's display name: the values are already the
 * words (`high`, `xhigh`, `max`), and on codex the name is a sentence.
 */
export function liveEffortName(options: SessionConfigOption[] | null | undefined): string | undefined {
  const opt = options?.find((o) => o.category === THOUGHT_LEVEL_CATEGORY);
  if (!opt) return undefined;
  const current = opt.currentValue;
  if (typeof current !== 'string' || current.length === 0 || current === 'default') return undefined;
  return current;
}

/** ACP's spec-reserved category for the reasoning-effort selector (SessionConfigOptionCategory). */
const THOUGHT_LEVEL_CATEGORY = 'thought_level';

/** A config option of the `select` kind — the only kind a level can be chosen from. */
type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

/**
 * The effort option itself, found the way liveEffortName finds it — by category, because the id is
 * the one thing the three harnesses disagree on. Its `id` is what `session/set_config_option` must
 * be sent, so the caller never spells `effort` or `reasoning_effort` itself.
 */
function effortOption(options: SessionConfigOption[] | null | undefined): SelectConfigOption | undefined {
  const opt = options?.find((o) => o.category === THOUGHT_LEVEL_CATEGORY);
  return opt?.type === 'select' ? opt : undefined;
}

/**
 * The session's effort levels as a selector for `/effort`, or undefined when the current model
 * offers none.
 *
 * Differs from liveEffortName in the one place the two readers want different things: `default`
 * is KEPT as `current`. The footer drops it because it names no level; a menu must show it,
 * because on claude and opencode it is one of the choices, and a menu with no ● anywhere would
 * leave the user unable to tell where they are.
 *
 * An option with no choices is reported as no selector: a menu of nothing is not a menu.
 */
export function effortSelectorOf(options: SessionConfigOption[] | null | undefined): EffortSelector | undefined {
  const opt = effortOption(options);
  if (!opt) return undefined;
  const levels = opt.options
    .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
    .map((o) => ({ value: o.value, name: o.name || o.value }));
  if (levels.length === 0) return undefined;
  return { current: opt.currentValue || undefined, options: levels };
}

/**
 * Re-apply a conversation's `/effort` choice to a freshly started or reloaded session, returning
 * the option list the harness reports afterwards (undefined when nothing was sent).
 *
 * This is not the model's belt-and-braces: without it the choice is lost on the very first idle
 * reclaim. Probed 2026-09-23 by setting `low`, killing the child and `session/load`ing the same
 * session into a new one — claude-agent-acp 0.81.0 and codex-acp 1.13.0 both came back at `high`
 * (their defaults for the model), opencode 2.0.14 came back at `low`. So two of three harnesses
 * treat the level as process state, not session state.
 *
 * Also run after a runtime `/model`, because the effort list belongs to the model: opencode's
 * variants differ per model, and codex falls back to the new model's default when the old level is
 * not among its levels.
 *
 * Best-effort, like applyModelPreference and for its reasons — never fails the turn. A level the
 * current model does not offer is skipped with a log line rather than forced: the preference stays
 * recorded, so a later switch back to a model that has it picks it up again, and the footer shows
 * the level that is really in force meanwhile.
 */
export async function applyEffortPreference(
  ctx: Pick<ClientContext, 'request'>,
  sessionId: string,
  def: AgentDef,
  options: SessionConfigOption[] | undefined,
  want: string | undefined
): Promise<SessionConfigOption[] | undefined> {
  if (!want) return undefined;
  const opt = effortOption(options);
  if (!opt) {
    console.log(`[acp] agent "${def.id}": effort "${want}" not applied — the current model offers no effort levels`);
    return undefined;
  }
  if (opt.currentValue === want) return undefined; // already there — don't spend a round trip
  const offered = opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  if (!offered.some((o) => o.value === want)) {
    console.warn(
      `[acp] agent "${def.id}": effort "${want}" is not offered by the current model; ` +
        `staying at "${opt.currentValue}". Offered: ${offered.map((o) => o.value).join(', ')}`
    );
    return undefined;
  }
  try {
    const res = await ctx.request('session/set_config_option', {
      sessionId,
      configId: opt.id,
      value: want,
    });
    console.log(`[acp] agent "${def.id}": effort re-applied as "${want}"`);
    return res?.configOptions ?? undefined;
  } catch (err) {
    console.warn(
      `[acp] agent "${def.id}": could not re-apply effort "${want}" (${err instanceof Error ? err.message : err}); ` +
        `staying at "${opt.currentValue}"`
    );
    return undefined;
  }
}

/** ACP's well-known id for the model selector among a session's config options. */
const MODEL_CONFIG_ID = 'model';

/**
 * DSH's model selector value: JSON.stringify([provider, model]) — see `modelValue` in
 * @deepseek-ai/dsh-acp (lib/types/model-control.js), where the option's `currentValue` and every
 * choice value carry that exact string and `set` looks the incoming value up in a map keyed by it.
 * talkcode spells models "provider/model" (the opencode convention), so the pair must be
 * JSON-encoded to cross the wire — a bare "provider/model" is rejected as "unknown model option" —
 * and decoded again to present a readable /model menu (see dshModelDisplayValue).
 */
export function dshModelSelectorValue(model: string): string {
  // No provider half (a bare model id): encode with an empty provider. That cannot match DSH's list,
  // so applyModelPreference's offer check rejects it explicitly with the real choices — a clearer
  // failure than DSH's opaque "unknown model option".
  const slash = model.indexOf('/');
  const provider = slash === -1 ? '' : model.slice(0, slash);
  const name = slash === -1 ? model : model.slice(slash + 1);
  return JSON.stringify([provider, name]);
}

/**
 * Inverse of dshModelSelectorValue: decode DSH's JSON-array selector value back to the
 * "provider/model" spelling config and /model queries use. Anything that isn't a 2-element string
 * array (a non-dsh harness's plain model id) passes through unchanged.
 */
export function dshModelDisplayValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    // Not JSON (a bare model id from a non-dsh harness) — pass through.
  }
  return value;
}

/**
 * Enforce `agents[].model` on a freshly created session, returning the option list the harness
 * reports afterwards (undefined when nothing was applied, so the caller keeps what session/new
 * reported).
 *
 * The whole list rather than just the resulting model name, because the model is not the only
 * thing a model switch changes: the effort levels belong to the model too, and the caller re-applies
 * `/effort` against the list this returns — reading it off session/new instead would validate the
 * level against the model the session was just switched AWAY from.
 *
 * Why this exists: session/new carries the model only as a `_meta.model` hint, which the spec lets
 * an agent ignore — and opencode does. Verified against the deployed harness: with
 * `_meta.model: 'anthropic/claude-opus-5'` it still reported `opencode/big-pickle` (its own
 * default), while `session/set_config_option` set it correctly. So a configured model was silently
 * not taking effect, and the only visible symptom was the footer naming a model nobody asked for.
 *
 * Best-effort by design — a harness with no model selector, an unknown model id, or an agent that
 * rejects the request must not fail the turn. Anything unexpected is logged once and the session
 * proceeds on whatever the harness chose, which is strictly better than refusing to answer. The
 * mismatch stays visible in the footer either way.
 */
async function applyModelPreference(
  ctx: ClientContext,
  session: ActiveSession,
  def: AgentDef,
  /** Runtime choice for this conversation (`/model`); outranks the configured model when set. */
  override?: string
): Promise<SessionConfigOption[] | undefined> {
  const want = override ?? def.model;
  if (!want) return undefined;
  // DSH's selector values are JSON.stringify([provider, model]) (see dshModelSelectorValue), so
  // translate the "provider/model" config spelling before comparing against currentValue, checking
  // the offered list, and setting. Logging keeps the readable spelling throughout.
  const wireWant = def.harness === 'dsh' ? dshModelSelectorValue(want) : want;
  const display = (v: string): string => (def.harness === 'dsh' ? dshModelDisplayValue(v) : v);

  const opt = (session.newSessionResponse?.configOptions ?? []).find((o) => o.id === MODEL_CONFIG_ID);
  // No model selector at all (the claude harness pins its model via ANTHROPIC_MODEL instead):
  // nothing to set, and saying so at debug avoids a scary warning for a supported setup.
  if (!opt || opt.type !== 'select') {
    console.debug(`[acp] agent "${def.id}" exposes no model selector; leaving model.${want ? ` (configured "${want}" applies only if the harness reads it elsewhere)` : ''}`);
    return undefined;
  }
  if (opt.currentValue === wireWant) return undefined; // already correct — don't spend a round trip

  // Only offer ids the agent actually lists; a typo would otherwise surface as an opaque rejection.
  const offered = opt.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
  if (offered.length > 0 && !offered.some((o) => o.value === wireWant)) {
    console.warn(
      `[acp] agent "${def.id}": configured model "${want}" is not among the models it offers; ` +
        `continuing with "${display(opt.currentValue)}". Available: ${offered.map((o) => display(o.value)).join(', ')}`
    );
    return undefined;
  }

  try {
    const res = await ctx.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: MODEL_CONFIG_ID,
      value: wireWant,
    });
    console.log(`[acp] agent "${def.id}": model set to "${want}"`);
    return res?.configOptions ?? undefined;
  } catch (err) {
    console.warn(
      `[acp] agent "${def.id}": could not set model "${want}" (${err instanceof Error ? err.message : err}); ` +
        `continuing with "${opt.currentValue}"`
    );
    return undefined;
  }
}

function createAcpSession(
  def: AgentDef,
  socketPath: string,
  /** The conversation this agent instance serves (store key half; the other half is def.id). */
  conversationId: string,
  turnTimeoutMs: number,
  store?: ConversationStore
): AgentSession {
  /**
   * The directory this session's child runs in. Resolved per SPAWN, not once per session, so a
   * `/cd` that disposed the child takes effect on the next turn (see resolveConversationCwd).
   * Held here because three call sites below — spawn, session/load and session/new — must all
   * agree on one answer within a single startup.
   */
  let cwd = resolveConversationCwd(def, conversationId, store);

  /** Lazily-started connection handles; established on first turn, closed on dispose. */
  let proc: AgentChild | undefined;
  let conn: ClientConnection | undefined;
  let active: ActiveSession | undefined;
  /**
   * The single reader of `active`'s update queue, for as long as the child lives (see pumpUpdates).
   * Held only so `resetHandles` can forget it; nothing ever awaits it.
   */
  let pump: Promise<void> | undefined;
  /**
   * The running turn's translation state, or undefined between turns. The pump routes each update
   * here while a turn is in flight and to the follow-up sink otherwise — that switch IS the fix for
   * dropped background output (see FollowUpSink).
   */
  let turnState: TurnState | undefined;
  /**
   * Called by the pump with every update it hands to the running turn — to re-arm the silence
   * watchdog, and to notice the end of an autonomous cycle (see FOLDED_PROMPT_GRACE_MS). Undefined
   * between turns (nothing is being timed).
   */
  let onTurnUpdate: ((update: SessionUpdate) => void) | undefined;
  /**
   * Ends the running turn's wait, because a prompt settled (queue `stop`, passed its response) or
   * the queue rejected (passed nothing). Undefined between turns.
   *
   * The turn decides whether a `stop` is ITS OWN — it is not always: a prompt the turn gave up on
   * (see FOLDED_PROMPT_GRACE_MS) settles later, typically at the next prompt, and its `stop` lands
   * in that next turn's wait.
   */
  let endTurnWait: ((response?: PromptResponse) => void) | undefined;
  /** Where out-of-turn output goes; installed by TurnRunner at the top of every turn. */
  let followUpSink: FollowUpSink | undefined;
  /**
   * The burst of out-of-turn output currently being rendered, together with the sink that opened
   * it. Paired deliberately: TurnRunner installs a FRESH sink at the top of every turn, so closing
   * through `followUpSink` could hand the close to a sink that knows nothing about this burst,
   * leaving the previous one's text unflushed — which in the default `once` delivery mode means
   * never sent at all.
   */
  let followUpState: { state: TurnState; sink: FollowUpSink } | undefined;
  /** Cancels the follow-up quiet backstop (see FOLLOW_UP_QUIET_MS). */
  let cancelFollowUpQuiet: (() => void) | undefined;
  /**
   * Whether the current burst has put output on screen — the difference between a burst that is
   * background work reporting in and one that only ever carried metadata (see followUp). Read for
   * two decisions: whether to say so in the log, and whether `/stop` has anything to stop
   * (see stopBackground). `followUpState` alone cannot answer either, because the post-turn
   * `session_info_update` opens one on every conversation after every turn.
   */
  let burstRendering = false;
  /**
   * Startup currently in flight, shared by concurrent callers so only one child is ever spawned
   * per session (see ensureStarted). Undefined whenever no startup is running.
   */
  let starting: Promise<void> | undefined;
  /**
   * Cancels the preLaunch hook while one is running ahead of a spawn (see agent-hooks.ts), on dispose
   * and on `/stop`. The hook is the one stretch of a startup with no child yet, so killing `proc`
   * cannot stop it: without this, a session disposed mid-hook would go on to spawn a child nobody
   * holds any more, and a stopped turn would sit out the hook and then run anyway.
   */
  let launchHook: AbortController | undefined;
  /** Intentional-abort flag: set by abort(); used to return silently when prompt ends as cancelled. */
  let aborting = false;
  /**
   * How many elicitations are currently in front of the user, waiting to be answered.
   *
   * Read by the turn's silence watchdog: an agent blocked on `elicitation/create` is silent BY
   * DESIGN, and the person it is waiting for is reading three options on a phone. Without this the
   * watchdog would reach its deadline mid-decision and abort the turn as hung — killing the very
   * question it was asked to relay, and doing it more reliably the more carefully the user thought.
   * A counter rather than a flag because a multi-question form is asked one round at a time.
   */
  let awaitingUser = 0;

  /**
   * Answer an ACP `elicitation/create`: put the agent's question to the user and block until they
   * pick (see AgentStreamHandlers.onElicit).
   *
   * Routed through the RUNNING TURN's handlers, because the question needs a lane to be asked in
   * and only the turn knows which platform and address this conversation is currently answering
   * on. Anything that leaves no such lane — no turn open, a url-mode request, a form with nothing
   * tappable in it — is `cancel`led rather than answered. Cancelling is the honest outcome: it
   * tells the harness the question went unanswered, which the model then has to deal with, whereas
   * inventing an accept would hand it a decision the user never made and let it act on it.
   */
  async function answerElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const ask = turnState?.handlers.onElicit;
    if (!ask) {
      console.warn(`[acp] ${conversationId}: elicitation arrived with no turn to ask in; cancelling`);
      return { action: 'cancel' };
    }
    const parsed = parseFormElicitation(params);
    if (!parsed) {
      console.warn(`[acp] ${conversationId}: cannot render this elicitation (mode=${params.mode}); cancelling`);
      return { action: 'cancel' };
    }
    awaitingUser++;
    try {
      const answer = await ask(parsed);
      return answer.action === 'accept'
        ? { action: 'accept', content: answer.content }
        : { action: answer.action };
    } catch (e) {
      // A renderer failure must not leave the agent blocked forever on a reply that will never come.
      console.error(`[acp] ${conversationId}: failed to put an elicitation to the user:`, e instanceof Error ? e.message : e);
      return { action: 'cancel' };
    } finally {
      awaitingUser--;
    }
  }

  /**
   * Answer an ACP `session/request_permission`: approve under `permissions: auto` (the default,
   * see decidePermission), or put it to the user under `permissions: ask`.
   *
   * Asked through the running turn's handlers, so it lands in the lane the turn is answering in;
   * with no turn open (background work the agent left running), through a follow-up burst's, which
   * ask in the conversation's own lane. Counted in `awaitingUser` like an elicitation, so the
   * silence watchdog does not fail a turn whose user is reading the request. What comes back is
   * translated by permissionResponse, which is where "nobody answered" becomes something the agent
   * can tell apart from a refusal.
   */
  async function answerPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (def.permissions !== 'ask') return decidePermission(params);
    const ask = (turnState ?? followUp(false))?.handlers.onPermission;
    let answer: PermissionAnswer;
    if (!ask) {
      answer = { kind: 'unavailable', why: 'no chat to ask in' };
    } else {
      awaitingUser++;
      try {
        answer = await ask(permissionRequestOf(params));
      } finally {
        awaitingUser--;
      }
    }
    console.log(`[acp] ${conversationId}: permission for ${JSON.stringify(permissionRequestOf(params).title)} → ${answer.kind}`);
    return permissionResponse(params, answer);
  }
  /**
   * Tool ids that were still open when the last cancel landed.
   *
   * A cancelled tool call still emits its `tool_call_update`, and it arrives AFTER the prompt has
   * settled — so it would either open a "background update" bubble for the tool the user just
   * stopped, or (when a message right after `/stop` starts a turn within milliseconds) be rendered
   * into the NEXT turn's reply. The deleted pre-prompt drain
   * described exactly this and cleared the queue to prevent it.
   *
   * Answered by identity rather than by a time window, which is what makes it exact: no wreckage
   * escapes by arriving late, and genuine background work reporting in seconds after a `/stop` is
   * not collateral damage. Replaced (not accumulated) at each cancel, and deliberately NOT cleared
   * when a turn starts — that is the moment the wreckage is most likely still in flight, and a tool
   * id is never reused, so a stale entry can only ever match the update it was recorded for.
   */
  let cancelledTools = new Set<string>();
  /**
   * Whether this child has yet been asked to do anything.
   *
   * `session/load` replays the stored session's history as ordinary `session/update` notifications
   * (the resumed session is attached BEFORE the request precisely so they land in this queue), and
   * the pre-prompt drain used to discard them — "history must not re-render to the IM". With a
   * permanent reader and a follow-up sink installed, that replay would instead be posted to the
   * chat as a background update: every daemon restart would re-narrate the previous conversation.
   *
   * Nothing legitimate can render before the first prompt on a fresh or resumed child, so the flag
   * is a sound gate: until one is sent, renderable updates are dropped and only reported facts
   * (the command list, the model, the title) are kept.
   */
  let promptedYet = false;
  /**
   * Resolves once the pump has consumed every notification `session/load` replayed — i.e. once
   * `promptedYet` is safe to set. Undefined when this child did not resume anything.
   *
   * ── The bug this exists to kill ───────────────────────────────────────────────────────────────
   * `promptedYet` alone is a RACE, and losing it re-narrates the entire conversation into the chat.
   * The flag is written by the sender (runTurn, just before `prompt()`) but read by the pump at
   * dequeue time, and between `beginPump()` and that write there are only a handful of microtask
   * ticks. A resumed session replays its whole history into the queue first, so the pump drops
   * however many it manages to reach in that window and renders the rest as if they were this
   * turn's output. Observed 2026-09-11 on a long conversation: exactly five updates were dropped
   * and the remainder — hours of history — was re-sent to Telegram as one turn's reply.
   *
   * The window is proportional to the history, so it is not a rare race; it is one that a
   * conversation is guaranteed to lose once it gets long enough.
   *
   * ── Why the fence is exact ────────────────────────────────────────────────────────────────────
   * By the time `session/load` returns, every replayed notification is already in the queue: the
   * agent emits them before answering, and a single JSON-RPC stream preserves that order. So the
   * replay is a finite, fully-buffered prefix, and "the pump has caught up" is decidable — see
   * `replayDrained` in pumpUpdates for how, and for the one SDK internal it leans on.
   */
  let replayFence: Promise<void> | undefined;
  /** Settles `replayFence`; held by the pump, which is the only thing that can know. */
  let releaseReplayFence: (() => void) | undefined;
  /** Whether the pump is still working through a `session/load` replay. */
  let replayPending = false;

  /** Arm the replay fence for a child that just resumed a stored session. */
  function armReplayFence(): void {
    replayPending = true;
    replayFence = new Promise<void>((resolve) => {
      releaseReplayFence = resolve;
    });
  }

  /** Disarm it, releasing anything waiting (child died, or the pump finished the replay). */
  function clearReplayFence(): void {
    replayPending = false;
    releaseReplayFence?.();
    releaseReplayFence = undefined;
    replayFence = undefined;
  }

  /**
   * Open the stretch during which a message sent mid-turn waits for the turn's prompt instead of
   * being refused (see promptSent). Returns the close, which is idempotent and only clears the
   * window it opened — so a turn can never close its successor's.
   */
  function openPromptWindow(): () => void {
    let release: () => void = () => {};
    const sent = new Promise<void>((resolve) => {
      release = resolve;
    });
    promptSent = sent;
    return () => {
      release();
      if (promptSent === sent) promptSent = undefined;
    };
  }

  /**
   * Whether the harness said it can reload a stored session (initialize → `agentCapabilities.
   * loadSession`). Read once per child and NOT cleared by resetHandles: it describes the harness
   * binary, not the process, and a rebuilt child re-reports the same answer.
   *
   * Only the idle sweeper consumes it (reclaimState below). Verified true on the two harnesses this
   * deployment runs — claude-agent-acp 0.58.1 and opencode 1.18.18 — but asked rather than assumed,
   * because a harness that cannot reload is exactly the one whose child must stay resident.
   */
  let loadSessionSupported = false;
  /**
   * How this harness takes a message into a running turn (see SteeringMode), from its `initialize`.
   * Like loadSessionSupported, a property of the binary: kept across a rebuilt child.
   */
  let steeringMode: SteeringMode = 'none';
  /**
   * Whether this harness takes a picture as a prompt block (initialize → `promptCapabilities.image`;
   * see promptBlocks). A property of the binary like the two above, kept across a rebuilt child.
   */
  let imagePrompts = false;
  /**
   * A turn's or a joined message's blocks, saying in the log when its pictures had to stay paths —
   * which is otherwise invisible: the agent still gets the path line and the turn looks normal.
   */
  const blocksOf = (input: Pick<RunTurnInput, 'prompt' | 'images'>): ContentBlock[] => {
    if (input.images?.length && !imagePrompts) {
      console.log(
        `[acp] ${conversationId}: "${def.id}" does not take pictures in a prompt (initialize: promptCapabilities.image is not true); ${input.images.length} go by path only`
      );
    }
    return promptBlocks(input, imagePrompts);
  };
  /**
   * Hands a message to the running turn, set by runTurn once its prompt is out and cleared when it
   * ends — so its presence is what "a turn is open to messages" means (see steer).
   */
  let joinTurn: ((blocks: ContentBlock[]) => Promise<SteerOutcome>) | undefined;
  /**
   * Resolves when the running turn's prompt has been sent (or the turn ended without sending one).
   * A message sent during a slow start — a child spawning, a long `session/load` — waits for this
   * rather than being refused, which would hold it back for the whole turn.
   */
  let promptSent: Promise<void> | undefined;
  /**
   * Whether the running turn has a message joined into it that the harness has not taken up yet —
   * set by runTurn while one does, cleared when it ends. Read by abort() (see `endChildAfterStop`).
   */
  let joinedStillQueued: (() => boolean) | undefined;
  /**
   * Set by abort() when a stop lands while a joined message is still queued inside the harness:
   * the turn then ends by ending the child, because a cancel alone does not reach that message.
   *
   * Observed 2026-10-10 against claude-agent-acp 0.81 + Claude Code 2.1.296 (the steer probe's `stop`
   * scenario): a message joined six seconds into a thirty-second command, then `/stop`. The cancel
   * killed the command and settled both prompts — and five seconds later Claude Code answered the
   * joined message anyway, as background output. The adapter says as much: on cancel it settles
   * queued turns, but "each removed queued turn's user message was already pushed to the SDK, which
   * processes input FIFO and will still emit a result for it" (dist/acp-agent.js `cancel`). A stop
   * that lets "also deploy it" run afterwards is not a stop. Ending the child takes the queued input
   * with it, and the next message resumes the conversation through `session/load` — the same path
   * `/kill` and an idle reclaim take. codex needs none of this: its steered input died with the
   * interrupted turn in the same probe.
   */
  let endChildAfterStop = false;
  /**
   * Model the harness reports as actually serving this session (from the session/new or session/load
   * config options). Undefined when the agent exposes no model selector; the footer then falls back
   * to the configured value. Cleared on dispose so a rebuilt child re-reports.
   */
  let liveModel: string | undefined;
  /**
   * The session's config options as the harness last reported them (session/new, session/load,
   * set_config_option, config_option_update). Kept whole rather than distilled to `liveModel`
   * because `/model` needs the option's full choice list, and a resumed session (session/load)
   * never populates `newSessionResponse` — reading the selector off that would make every
   * post-restart conversation look like a harness with no model selector.
   */
  let liveConfigOptions: SessionConfigOption[] | undefined;
  /**
   * Names of the subagents this session has spawned (see TurnState.subagents). Held by the session
   * rather than by a turn because a background subagent outlives the turn that launched it.
   */
  const subagentNames = new Map<string, string>();
  /**
   * Model chosen at runtime for THIS conversation (`/model`), outranking `agents[].model`.
   *
   * Held here rather than in config so it survives what it must and no more: a child that crashes
   * or is evicted rebuilds with the user's choice re-applied (resetHandles deliberately leaves this
   * untouched), while a new conversation starts its own closure from the configured default.
   */
  let modelPreference: string | undefined;
  /**
   * Reasoning effort chosen at runtime for THIS conversation (`/effort`). Same lifetime as
   * modelPreference and kept for the same reason — resetHandles leaves it alone — but re-applied on
   * session/load too, where the model's is not: two of three harnesses reload at their default level
   * (see applyEffortPreference).
   */
  let effortPreference: string | undefined;

  /**
   * Reset the three connection handles to undefined (without killing the process). Shared by the child
   * 'exit' callback and dispose: once the process has exited, proc.kill() is meaningless (and may kill a
   * PID-reused new process), so reset and kill are separated. After reset, the next ensureStarted rebuilds
   * the connection (active===undefined), achieving crash self-healing.
   */
  function resetHandles(): void {
    proc = undefined;
    conn = undefined;
    active = undefined;
    // The pump belongs to the queue of the session that just went away; the next spawn starts its
    // own. Its loop notices `active` changed under it and returns.
    pump = undefined;
    // Whatever background output was mid-render died with the child, so finalize it rather than
    // leaving a half-streamed message open forever. Not awaited here — resetHandles is called from
    // synchronous teardown paths (the child's 'exit' callback), and the flush targets the chat
    // platform, which does not care that the child is gone. Stopped, not done: it never finished.
    void closeFollowUp('stopped');
    // A rebuilt child starts from nothing again: its `session/load` replay must not be rendered
    // (see promptedYet).
    promptedYet = false;
    // The pump that would have released this fence is gone with the child, so release it here or a
    // turn already parked on it would wait forever — and the next child arms a fresh one anyway.
    clearReplayFence();
    // The next child re-reports its own model; keeping a stale name would misattribute the footer
    // if the rebuilt session resolves a different one.
    liveModel = undefined;
    // liveConfigOptions is deliberately KEPT: after an idle reclaim the child is gone but the
    // conversation lives on, and `/model` reads its choice list from here — clearing it would make
    // a reclaimed conversation look like a harness with no model selector until the next turn (the
    // "No model selector on this session yet" false negative). The next spawn refreshes it via
    // session/new; a choice made while the child is down defers through modelPreference.
    // `starting` is deliberately NOT cleared here: the in-flight startup promise owns its own slot
    // and clears it on settle. Clearing it from a reset that happens DURING startup (dispose's
    // rollback, or a `/cd` landing mid-spawn) would let the next caller begin a second child while
    // the first is still running — the exact race ensureStarted exists to prevent.
  }

  /** Max wait for initialize + session/new after spawn; on timeout, treat spawn as failed (ENOENT etc.) instead of hanging. */
  const START_TIMEOUT_MS = 30_000;

  /**
   * Close the connection + terminate the child and reset handles. Shared by explicit dispose and
   * start-failure rollback. A short delayed SIGKILL backs up SIGTERM (best-effort, non-blocking); if the
   * process already exited, handles were reset by 'exit', and resetting again here is idempotent.
   */
  function dispose(): void {
    // Only the EXPLICIT path claims the abort: it means "this teardown was asked for, so a turn
    // ending because of it is not an error". teardown() deliberately does not, so a session
    // dropped because its queue died still reports the real reason to the user.
    aborting = true;
    teardown();
  }

  /**
   * Drop the connection and the child, leaving the session rebuildable.
   *
   * Split out of `dispose` for the pump's stand-down: when the update queue has failed there is
   * nothing left to read, and leaving `active` set would present a session that looks ready but
   * can never deliver a `stop` — every later turn would wait out the full silence watchdog, or
   * hang forever with `turnTimeoutMs: 0`. Dropping the handles instead sends the next turn down
   * the crash-self-healing path, which is the honest outcome.
   *
   * A short delayed SIGKILL backs up SIGTERM (best-effort, non-blocking); if the process already
   * exited, handles were reset by 'exit', and resetting again here is idempotent.
   */
  function teardown(): void {
    launchHook?.abort();
    const child = proc; // capture the process to kill (the 'exit' callback compares by reference)
    try {
      active?.dispose();
      conn?.close();
    } catch (e) {
      console.debug('[acp] teardown: ignoring error while closing connection:', e instanceof Error ? e.message : e);
    }
    if (child) killChildProcess(child);
    resetHandles();
  }

  /**
   * Put the conversation's `/effort` choice back on a session, folding the harness's answer into
   * liveConfigOptions. The one call behind all three places that need it — session/load, session/new
   * and a runtime `/model` — so none of them can forget the write-back.
   */
  async function reapplyEffort(ctx: Pick<ClientContext, 'request'>, sessionId: string): Promise<void> {
    const after = await applyEffortPreference(ctx, sessionId, def, liveConfigOptions, effortPreference);
    if (after) liveConfigOptions = after;
  }

  /**
   * A freshly created session's runtime choices, in the only order that works: the model first,
   * then the effort, because the levels on offer are the model's (see applyEffortPreference) and
   * must be checked against the list the model switch produced, not the one it replaced.
   */
  async function reapplyPreferences(ctx: ClientContext, session: ActiveSession): Promise<void> {
    // _meta.model is a hint some harnesses ignore (verified: opencode reports its own default
    // regardless), so enforce the choice through the protocol's own setter. A runtime /model
    // choice outranks config, so a rebuilt child keeps answering as the user asked.
    const afterModel = await applyModelPreference(ctx, session, def, modelPreference);
    if (afterModel) {
      liveConfigOptions = afterModel;
      liveModel = liveModelName(afterModel) ?? liveModel;
    }
    await reapplyEffort(ctx, session.sessionId);
  }

  /**
   * Bring the session up, sharing one startup between concurrent callers.
   *
   * There are two of those now — a turn beginning, and a `/model` warm-up (ensureSession) — and
   * `active` is assigned only at the END of startup, so a second entrant arriving mid-spawn would
   * see `active === undefined`, spawn its own child, and overwrite `proc`. The first child is then
   * an orphan that no dispose can reach while still holding the harness's session. Sharing the
   * in-flight promise makes the second caller wait for the first result instead.
   *
   * The slot clears on settle either way, so a failed startup does not poison later attempts —
   * the next caller retries for real, which is what the crash-self-healing path expects.
   */
  async function ensureStarted(sessionToken: string): Promise<void> {
    if (active) return;
    starting ??= startSession(sessionToken).finally(() => {
      starting = undefined;
    });
    await starting;
  }

  /**
   * For an agent on another machine: reach it (a first contact that fails ends the startup here,
   * with the reason), and settle the directory there before anything is started in it.
   */
  async function placeOnHost(): Promise<{ host: RemoteHost; welcome: Welcome } | undefined> {
    const host = remoteHosts.hostFor(def);
    if (!host) return undefined;
    const prepared = await prepareRemoteSpawn(def, host, cwd);
    cwd = prepared.cwd;
    return { host, welcome: prepared.welcome };
  }

  /**
   * The child, here or on its host, and the native-tools server its sessions are given. That server
   * is started BY the harness, so on a remote host it is the host's `talkcode` shim, which hands the
   * session back to this gateway (remote/shim.go).
   */
  function spawnChild(
    command: string,
    args: string[],
    sessionToken: string,
    place: { host: RemoteHost; welcome: Welcome } | undefined
  ): { child: AgentChild; mcpServers: () => McpServer[] } {
    if (!place) {
      return {
        child: spawn(command, args, { cwd, env: buildAgentEnv(def, sessionToken, socketPath) }),
        mcpServers: () => acpMcpServers(sessionToken, socketPath, cwd),
      };
    }
    return {
      child: place.host.spawn(command, args, { cwd, env: remoteAgentEnv(def, sessionToken) }),
      mcpServers: () => remoteMcpServers(sessionToken, place.host.paths(place.welcome), cwd),
    };
  }

  /**
   * Make `child` this session's process: record it, forward its stderr, and reset the handles when it
   * exits. Returns how to ask whether it failed to start at all — kept, so a startup that fails
   * because the process never started says THAT (a command not on PATH, here or on the agent's host)
   * rather than the "ACP connection closed" it surfaces as.
   */
  function adoptChild(child: AgentChild): () => Error | undefined {
    // Record proc immediately so the 'exit' callback and start-failure dispose can match by reference and
    // terminate this process (conn/active assigned only after start() succeeds; active stays the sole readiness signal).
    proc = child;
    child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    let spawnError: Error | undefined;
    child.on('error', (e) => {
      spawnError = e;
      console.error(`[acp] child process error (${def.id}):`, e.message);
    });
    // On child crash/kill: reset handles so the next ensureStarted rebuilds the connection (otherwise
    // active stays set and reusing the dead connection makes prompt hit a closed stream with "ACP
    // connection closed" — that session fails every turn, never self-heals). Reset only when the exiting
    // child is the current one (avoid a stale 'exit' resetting a post-dispose new child). Don't kill here
    // — it already exited. 'exit' once suffices; 'close' (all stdio shut) is later but not needed here.
    child.on('exit', (code, signal) => {
      if (proc !== child) return; // already replaced/cleared by dispose; stale callback no-ops
      console.debug(`[acp] child process exited (${def.id}): code=${code} signal=${signal}; resetting connection handles to rebuild next turn`);
      resetHandles();
    });
    return () => spawnError;
  }

  /** Lazily start the ACP child and complete initialize + session/new. sessionToken is injected into its env here. */
  async function startSession(sessionToken: string): Promise<void> {
    if (active) return;

    // Re-read the conversation's directory: between the last child and this one the user may have
    // moved the conversation with `/cd`, and this is the only point at which that can be honored.
    cwd = resolveConversationCwd(def, conversationId, store);

    const place = await placeOnHost();

    // The operator's preLaunch hook, inside the shared startup so concurrent callers run it once. A
    // failure throws from here, before there is a child or a connection to roll back.
    if (def.hooks?.preLaunch) {
      const hook = new AbortController();
      launchHook = hook;
      try {
        await runPreLaunchHook(def, { cwd, signal: hook.signal });
      } finally {
        if (launchHook === hook) launchHook = undefined;
      }
    }

    const { command, args } = resolveHarness(def, place !== undefined);
    const { child, mcpServers } = spawnChild(command, args, sessionToken, place);
    const spawnError = adoptChild(child);

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );

    const app = client()
      .onRequest(
        'session/request_permission',
        ({ params }): Promise<RequestPermissionResponse> => answerPermission(params)
      )
      .onRequest(
        'elicitation/create',
        ({ params }): Promise<CreateElicitationResponse> => answerElicitation(params)
      );
    const connection = app.connect(stream);
    conn = connection; // assign early so start-failure dispose can close the connection (active stays the sole readiness signal)
    const ctx = connection.agent;

    // On spawn failure (ENOENT: gemini/codex/custom command not on PATH) the child asynchronously emits error and
    // stdout EOF, but the initialize / session/new request promise may never settle (the SDK's
    // cancellationSignal is cooperative — it waits for a peer reply that a dead peer won't send) →
    // the session hangs in running. So race a real timer: on timeout, dispose the child + throw a
    // readable error so turn-runner sees a failure instead of a silent hang.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Asks claude-agent-acp for typed failure records, through `_meta` in the capabilities below.
    // Without them, an API retry loop reads as a hung agent (see session-failure.ts). Only the
    // claude harness is asked: no other adapter is known to read the key, and opencode validates
    // the capability object strictly (see `form: true` below), so sending it a key it never needed
    // is all risk and no gain.
    const failureRecords = def.harness === 'claude' ? { _meta: SESSION_FAILURE_CAPABILITY_META } : {};
    const startup = (async () => {
      const initResult = await ctx.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Don't advertise fs/terminal: let the agent use its own tools (Bash → talkcode); the client only receives the stream + answers permission.
        //
        // `elicitation.form` IS advertised, and it is load-bearing rather than decorative: the
        // claude adapter gates the model's own AskUserQuestion tool on it
        // (`disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"]`), so without this
        // the model cannot ask the user anything — it guesses, or asks in prose and ends the turn.
        // Verified live 2026-09-11: with this set, a "which database?" prompt produced a real
        // `elicitation/create` carrying three options and their rationales.
        //
        // The value MUST be an object, not `true`. ACP types this as `ElicitationFormCapabilities`
        // (see the SDK's schema.json), claude reads it as a truthy check so `{}` satisfies it, and
        // opencode validates it strictly — `form: true` is rejected with `-32602 Invalid params`
        // ("expected object, received boolean"), which fails initialize and takes down EVERY
        // opencode session, not just its elicitations. `url` is deliberately left out: a browser
        // hand-off has no sensible rendering in a chat message (see parseFormElicitation).
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
          ...failureRecords,
        },
      });
      loadSessionSupported = initResult.agentCapabilities?.loadSession === true;
      steeringMode = steeringModeOf(initResult);
      imagePrompts = initResult.agentCapabilities?.promptCapabilities?.image === true;

      // Resume persisted context first: the harness keeps conversation history on its own disk, so a
      // daemon restart only loses the process — session/load replays the stored ACP session into the
      // fresh child. Attach BEFORE the request so the replayed session/update notifications route into
      // this session's queue (the pre-prompt drain then discards them; history must not re-render to
      // the IM). attachSession is TS-private on ClientContext but stable at runtime — the SDK offers
      // no public "ActiveSession from an existing sessionId" path.
      // Keyed by (conversation, agent): this agent's OWN prior session here, never another
      // agent's. Switching /oc -> /cc -> /oc must resume opencode's thread rather than restart the
      // user's task -- the agent owns its context and the gateway must not disturb it.
      const persistedId = store?.agentSession(conversationId, def.id);
      if (persistedId && initResult.agentCapabilities?.loadSession) {
        const attach = (
          ctx as unknown as { attachSession(r: { sessionId: string }): ActiveSession }
        ).attachSession.bind(ctx);
        const resumed = attach({ sessionId: persistedId });
        try {
          const loaded = await ctx.request('session/load', {
            sessionId: persistedId,
            cwd,
            mcpServers: mcpServers(),
          });
          active = resumed;
          // session/load reports the resumed session's config the same way session/new does.
          liveConfigOptions = loaded?.configOptions ?? undefined;
          liveModel = liveModelName(liveConfigOptions);
          // Every replayed notification is in the queue by now (see armReplayFence): the agent
          // sends them before it answers `session/load`, and one JSON-RPC stream is ordered.
          armReplayFence();
          console.log(`[acp] resumed persisted session for "${def.id}" (${persistedId})`);
          // claude-agent-acp and codex-acp reload at their DEFAULT level, not the one this session
          // was left on — so a `/effort` choice made before an idle reclaim is put back here or lost.
          // Cannot throw (best-effort by design), so it cannot send a good load down the catch below.
          await reapplyEffort(ctx, persistedId);
        } catch (err) {
          // Stored id no longer loadable (history pruned, cwd moved, harness downgraded): start fresh.
          resumed.dispose();
          console.warn(
            `[acp] session/load failed for "${def.id}" (${persistedId}); starting a fresh session:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      if (active) return;

      try {
        const session = await ctx
          .buildSession({
            cwd,
            mcpServers: mcpServers(),
            // model passed best-effort via _meta; whether it takes effect depends on the harness
            // (claude/gemini differ). dsh's bridge ignores _meta entirely — it reads provider/model
            // only from its own profile config (verified in @deepseek-ai/dsh-acp newSession, which
            // uses initialSelection(config)) — so the hint is kept well-formed (JSON-encoded like
            // set_config_option expects) in case a future version reads it; the real enforcement is
            // applyModelPreference below.
            ...(def.model
              ? {
                  _meta: {
                    model: def.harness === 'dsh' ? dshModelSelectorValue(def.model) : def.model,
                  },
                }
              : {}),
          })
          .start();
        active = session; // active set = "ready": assigned last so a half-ready session isn't reused
        liveConfigOptions = session.newSessionResponse?.configOptions ?? undefined;
        liveModel = liveModelName(liveConfigOptions);
        // _meta.model above is a hint some harnesses ignore; reapplyPreferences enforces it, and
        // puts back a `/effort` choice after it.
        await reapplyPreferences(ctx, session);
        store?.setAgentSession(conversationId, def.id, session.sessionId); // for post-restart session/load resume
      } catch (err) {
        // session/new returning auth_required (un-logged-in harness) surfaces as an opaque reject. Build
        // a readable hint from the authMethods the agent advertised in the initialize response (no interactive auth).
        if (isAuthRequired(err)) {
          const methods = (initResult?.authMethods ?? [])
            .map((m) => m.name || m.id)
            .filter(Boolean)
            .join(' / ');
          const how = methods ? `(available login methods: ${methods})` : '(e.g. run `claude /login` to complete subscription login)';
          throw new TurnFailure(`agent "${def.id}" must be logged in before use ${how}, then retry this turn.`, 'access');
        }
        throw err;
      }
    })();

    try {
      await Promise.race([
        startup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new TurnFailure(
                  `agent "${def.id}" startup timed out (${START_TIMEOUT_MS}ms). Make sure the launch command is executable on PATH: ${command} ${args.join(' ')}`,
                  'startup'
                )
              ),
            START_TIMEOUT_MS
          );
        }),
      ]);
    } catch (err) {
      // Start failure (timeout / initialize / session/new throw): clear child and handles so the next
      // turn can retry, and rethrow a readable error to turn-runner (logged + ❌) rather than hang silently.
      dispose();
      const failed = spawnError();
      if (failed) {
        const where = place ? ` on host "${place.host.id}"` : '';
        throw new TurnFailure(`agent "${def.id}" could not start${where}: ${failed.message}`, 'startup');
      }
      // initialize or session/new refused: still a startup that did not happen. Classified rather
      // than rethrown bare so hooks.turnFailed can tell it from a turn the provider failed.
      if (err instanceof TurnFailure) throw err;
      throw new TurnFailure(err instanceof Error ? err.message : String(err), 'startup');
    } finally {
      if (timer) clearTimeout(timer);
    }

    // The session is up: start reading its updates NOW rather than when the first turn does, so
    // nothing that arrives before or between turns is missed (see pumpUpdates).
    beginPump();
  }

  /**
   * Build the translation state one stream of updates renders through.
   *
   * Shared by the running turn and the follow-up burst so both get the same tool ledger, the same
   * `configOptions` write-back and the same context-window override — an out-of-turn reply that
   * rendered tools differently from an in-turn one would be a bug nobody would think to look for.
   */
  function newTranslationState(handlers: AgentStreamHandlers): TurnState {
    /** Notice keys already sent from this turn or burst (see failureNoticeKey). */
    const announced = new Set<string>();
    return {
      handlers,
      lastSegment: 'none',
      toolLedger: new Map(),
      toolIndexSeq: 0,
      // Keep the session's own view of the selector current when the harness changes it, so a
      // later /model reflects reality rather than what session/new happened to report.
      onConfigOptions: (options) => {
        if (!options) return;
        liveConfigOptions = options;
        liveModel = liveModelName(options) ?? liveModel;
      },
      onSessionFailure: (failure) => announceSessionFailure(failure, handlers, announced),
      // Local override for a harness that under-reports the window (e.g. claude-opus-5 → 200k fallback).
      contextWindow: def.contextWindow,
      subagents: subagentNames,
    };
  }

  /**
   * Turn a failure record from a `session_info_update` into a notice: a retry in progress, an
   * advisory, or a failure that has no turn to fail (see session-failure.ts).
   *
   * Every record is logged, and each piece of news is sent once per turn or burst. The adapter
   * sends one warning per retry attempt, and that series is exactly the case that produces ten
   * minutes of them.
   *
   * Nothing is sent before the session's first prompt. `session/load` re-publishes old usage-limit
   * failures from the stored history at that point, and posting them would report an outage the
   * user lived through days ago as if it were happening now. The replay fence makes this a sound
   * test (see promptedYet).
   */
  function announceSessionFailure(
    failure: SessionFailure,
    handlers: AgentStreamHandlers,
    announced: Set<string>
  ): void {
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

  /**
   * The translation state for out-of-turn output, opening a burst if one isn't already running.
   *
   * Returns undefined only when no sink is installed — a session driven by something other than
   * TurnRunner (the doctor check, a test) has nowhere to put background output, and dropping it is
   * then the honest outcome.
   */
  function followUp(renderable: boolean): TurnState | undefined {
    if (!followUpSink) return undefined;
    if (!followUpState) {
      const handlers = followUpSink.handlers();
      followUpState = { state: newTranslationState(handlers), sink: followUpSink };
      // The same up-front report runTurn makes, for the same reason: the model and effort are
      // known from session/new and are never re-sent unless they change, so a burst that is not
      // told them has no way to learn them. Its footer then fell back to config, which for the
      // `claude` harness names no model at all — the background report read `cc · 429k / 1M`
      // directly under a reply that said `cc · 429k / 1M · opus-5-5 · high`.
      if (liveModel) handlers.onModel?.(liveModel);
      const effort = liveEffortName(liveConfigOptions);
      if (effort) handlers.onEffort?.(effort);
    }
    // Only OUTPUT starts a burst. Metadata gets the same translation state (it has to go
    // somewhere) but neither announces itself nor arms a timer, because claude-agent-acp sends a
    // `session_info_update` after every single turn: logging "rendering a follow-up" there would
    // make the one line that tells an operator background work is happening indistinguishable
    // from per-turn noise, and would leave every idle conversation holding a 3-minute timer.
    if (!renderable) return followUpState.state;
    if (!burstRendering) {
      burstRendering = true;
      console.log(`[acp] ${conversationId}: output arrived outside a turn; rendering it as a follow-up`);
    }
    // Re-armed on every update, so the backstop measures SILENCE rather than burst length: a
    // background followup can spend minutes inside one tool call and must not be cut short for it.
    armFollowUpQuiet(FOLLOW_UP_QUIET_MS);
    return followUpState.state;
  }

  /**
   * Whether an update can put something on screen, as opposed to reporting a fact the gateway
   * records and displays elsewhere (the topic name, `/context`, the footer, the slash menu).
   *
   * The distinction carries three separate rules — the replay gate, the cancel-wreckage filter and
   * whether a burst has begun — so it is named once rather than spelled out three times.
   */
  function isRenderableUpdate(update: SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'tool_call':
      case 'tool_call_update':
        return true;
      default:
        return false;
    }
  }

  /** (Re)arm the timer that seals the current burst after `ms` of silence. */
  function armFollowUpQuiet(ms: number): void {
    cancelFollowUpQuiet?.();
    const timer = setTimeout(() => {
      console.log(`[acp] ${conversationId}: follow-up output went quiet; closing it`);
      void closeFollowUp();
    }, ms);
    cancelFollowUpQuiet = () => clearTimeout(timer);
  }

  /**
   * Whether a renderable update is a cancelled turn's trailing write rather than real output.
   *
   * A cancelled tool call still emits its `tool_call_update`, and it lands AFTER the prompt has
   * settled — so it would either open a "background update" message containing a bubble for the
   * very tool the user just stopped, or (when the user's next message follows a `/stop` within
   * milliseconds and starts a turn) be rendered into the NEXT turn's reply. The deleted
   * pre-prompt drain named exactly this case and cleared the queue to prevent it.
   *
   * Two tests, because the cancel and the next turn race:
   *
   * - while `aborting` still stands — i.e. between the cancel and the next turn — anything
   *   tool-shaped is the cancelled turn's tail. The agent has been told to stop, so it is not
   *   starting new tool calls; this is the old drain's rule, stated positively.
   * - once a new turn has cleared `aborting`, the ids the cancel snapshotted still identify the
   *   wreckage. Ids are never reused, so a stale entry can only match the update it was recorded
   *   for — which is why the set is not cleared at turn start, the very moment the trailing write
   *   is most likely still in flight.
   */
  function isWreckage(update: SessionUpdate): boolean {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false;
    if (aborting) return true;
    return typeof update.toolCallId === 'string' && cancelledTools.has(update.toolCallId);
  }

  /**
   * Finish the current burst of out-of-turn output: close any tool bubbles it left open and let the
   * sink flush and decorate the message. Idempotent — every path that could end a burst calls it.
   */
  async function closeFollowUp(reason: 'done' | 'stopped' = 'done'): Promise<void> {
    cancelFollowUpQuiet?.();
    cancelFollowUpQuiet = undefined;
    const burst = followUpState;
    followUpState = undefined;
    burstRendering = false;
    if (!burst) return;
    flushPendingTools(burst.state);
    try {
      // Awaited so a caller that is about to write to the same lane can order itself behind the
      // flush; the pump's own closes have nothing to race and simply `void` it.
      await burst.sink.close(reason);
    } catch (e) {
      console.error('[acp] follow-up sink failed to close:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * One read from the session queue, which also decides when a `session/load` replay has been
   * fully consumed and releases the fence runTurn waits on (see replayFence).
   *
   * ── How "the queue is empty" is decided, and why it is exact ──────────────────────────────────
   * By racing the read against a MACROTASK. The SDK's AsyncQueue answers a read that has a value
   * buffered with `Promise.resolve(value)` — settled on a microtask — and only parks a waiter when
   * it has none (verified in `@agentclientprotocol/sdk` 0.29.0 `AsyncQueue.next`). The event loop
   * drains microtasks to exhaustion before running the next macrotask, so a `setImmediate` can win
   * this race only when nothing is buffered. That makes "the tick won" mean exactly "the replay
   * prefix is consumed", with no assumption about how fast anything runs.
   *
   * ⚠️ HYRUM'S LAW: `AsyncQueue.next()` returning an already-settled promise for buffered values is
   * an implementation detail, not a documented contract. If a future SDK defers buffered reads by a
   * macrotask, the tick could win with items still queued and the replay would render again. The
   * contract test in agent-acp-pump.test.ts pins the behaviour so an upgrade fails there first.
   * A regression is not catastrophic in any case: the fence can only release EARLY, which degrades
   * to the pre-existing race rather than to a hang.
   *
   * The raced read is retained and returned rather than abandoned. Starting a second `nextUpdate()`
   * would leave two waiters on one queue, and the FIRST one — the abandoned promise — is the one
   * the queue hands the next message to, which would then be dropped on the floor.
   */
  async function readNext(
    session: ActiveSession
  ): Promise<Awaited<ReturnType<ActiveSession['nextUpdate']>>> {
    const read = session.nextUpdate();
    if (!replayPending) return read;

    const IDLE = Symbol('idle');
    const idle = new Promise<typeof IDLE>((resolve) => setImmediate(() => resolve(IDLE)));
    const first = await Promise.race([read, idle]);
    if (first !== IDLE) return first;

    console.log(`[acp] ${conversationId}: session/load replay consumed; rendering resumes`);
    clearReplayFence();
    return read; // the SAME outstanding read — never start a second waiter (see above)
  }

  /**
   * The one and only reader of a session's update queue, running from the moment the session is up
   * until its child goes away.
   *
   * ── Why a pump rather than a read loop inside runTurn ──────────────────────────────────────────
   * Two reasons, and the second is what forced it.
   *
   * 1. Updates that arrive with no prompt in flight have to be read, or they are lost.
   *    claude-agent-acp settles the prompt at its terminal `result` and keeps emitting notifications
   *    for background work afterwards (see FollowUpSink) — a loop that returns at `stop` reads none
   *    of them, which is the reported bug: the chat went silent after "I've started it in the
   *    background".
   * 2. There can only be ONE reader, ever. The SDK's AsyncQueue.next() pushes a waiter when the
   *    queue is empty (0.29.0 dist/acp.js AsyncQueue.next), and an abandoned waiter still consumes
   *    the next value that arrives. So "drain between turns, then hand the queue back" cannot be
   *    written safely: whichever reader was waiting when the next turn began would swallow that
   *    turn's first update. Making the reader permanent and switching its DESTINATION instead
   *    removes the handover entirely.
   *
   * This also retires the old pre-prompt residue drain: nothing accumulates in the queue any more,
   * and a `session_info_update` that used to be salvaged a whole turn late (it lands behind the
   * `stop` that ended the loop) now reaches the gateway when it arrives.
   */
  async function pumpUpdates(session: ActiveSession): Promise<void> {
    // Consecutive rejections with no value in between. The queue rejects for two very different
    // reasons and only this tells them apart: a prompt that failed rejects ONCE (the turn learns
    // the reason from its own promptDone, and pumping must continue for the session to survive),
    // while a closed connection FAILS the queue permanently, so every later read rejects with the
    // same error and an unguarded loop would spin the event loop on it.
    let rejections = 0;
    for (;;) {
      // Checked before AND after the await, because the await is unbounded: `resetHandles` can
      // swap `active` while this read is parked, and `turnState` / `endTurnWait` are session-wide,
      // so a value from a replaced child would otherwise end (or be rendered into) the turn of a
      // freshly spawned one. The old per-turn waiter could not do this — it died with its turn.
      if (active !== session) return;
      let msg: Awaited<ReturnType<ActiveSession['nextUpdate']>>;
      try {
        msg = await readNext(session);
        rejections = 0;
      } catch (e) {
        if (active !== session) return;
        // Wake the turn — it rethrows through promptDone, which carries the real reason.
        endTurnWait?.();
        if (++rejections > MAX_QUEUE_REJECTIONS) {
          // Standing down would leave the session with no reader while still looking ready
          // (`active` set, `pump` settled), so every later turn would wait on a `stop` that can
          // never come. Drop the handles instead: the next turn rebuilds the child, which is the
          // same self-healing path a crash takes.
          console.warn(
            `[acp] update queue for "${def.id}" keeps rejecting (${e instanceof Error ? e.message : e}); dropping the connection so the next turn rebuilds it`
          );
          teardown();
          return;
        }
        await new Promise((r) => setTimeout(r, QUEUE_REJECT_BACKOFF_MS));
        continue;
      }
      if (active !== session) return;

      if (msg.kind === 'stop') {
        // The response travels with it so the turn can tell its own `stop` from a stale one.
        endTurnWait?.(msg.response);
        continue;
      }

      const update = msg.update;
      const renderable = isRenderableUpdate(update);

      // A cancelled tool's trailing update is wreckage, not output. Checked whether or not a turn
      // is running: a message sent right after `/stop` can have the next turn under way by the
      // time it arrives (see isWreckage).
      if (renderable && isWreckage(update)) {
        console.debug(`[acp] ${conversationId}: dropping a trailing update for a tool the cancel killed`);
        continue;
      }

      // `session/load`'s replayed history, or anything else a child emits before it is asked to do
      // something. Reported facts still pass — only rendering is suppressed (see promptedYet).
      if (renderable && !promptedYet) {
        console.debug(`[acp] ${conversationId}: not rendering a ${update.sessionUpdate} from before the first prompt`);
        continue;
      }

      const dest = turnState ?? followUp(renderable);
      if (!dest) {
        // Only reachable for a session nothing is driving: `ensureSession` (the `/model` warm-up)
        // and the doctor check both start a child with no turn and no sink. Logged because a
        // dropped update is exactly the class of thing that must never be silent.
        console.debug(
          `[acp] ${conversationId}: dropping a ${update.sessionUpdate} — no turn is running and no follow-up sink is installed`
        );
        continue;
      }

      try {
        translateUpdate(update, dest);
      } catch (err) {
        // Never let one malformed notification kill the reader. This is the session's ONLY reader,
        // so an escaping throw would leave the child permanently deaf: the in-flight turn would
        // wait for a `stop` nobody will deliver, and every later update would go unread. Under the
        // old per-turn loop the same throw merely failed that turn.
        console.error(
          `[acp] ${conversationId}: failed to render a ${update.sessionUpdate}:`,
          err instanceof Error ? err.stack ?? err.message : err
        );
        continue;
      }

      if (turnState) {
        onTurnUpdate?.(update); // the turn is alive: re-arm its silence watchdog
        continue;
      }
      // A result-tied `usage_update` says a piece of work finished, so it is the cue to seal the
      // burst — which matters because in the default `once` delivery mode NOTHING is sent until
      // the buffer completes, and the alternative cue is minutes of quiet.
      //
      // It SHORTENS the timer rather than closing outright, because the marker is weaker than it
      // looks: the ACP schema documents `cost` as "Cumulative session cost (optional)", so a
      // harness is entitled to report it on every snapshot, and closing synchronously would then
      // cut one background report into a message per snapshot — each with its own marker bubble
      // and footer. A grace window degrades to the right answer either way: more output re-arms
      // the full quiet window, silence seals.
      if (isResultUsage(update)) armFollowUpQuiet(FOLLOW_UP_SEAL_GRACE_MS);
    }
  }

  /** Start the queue reader once the session is up. Idempotent (one pump per child). */
  function beginPump(): void {
    if (!active || pump) return;
    const session = active;
    pump = pumpUpdates(session).catch((e) => {
      // pumpUpdates absorbs its own errors; this is the last resort, so a bug in it can never
      // surface as an unhandled rejection that takes the daemon down.
      console.error('[acp] update reader stopped unexpectedly:', e instanceof Error ? e.stack ?? e.message : e);
    });
  }

  /**
   * Watch one turn for the sign that its prompt was folded into an autonomous cycle and answered
   * there — the claude-agent-acp bug described at FOLDED_PROMPT_GRACE_MS, where the prompt's own
   * `stop` never comes.
   *
   * The evidence is an autonomous cycle ending (autonomousResultOrigin) followed by silence. Any
   * renderable output in between cancels it: a prompt that was only queued behind that cycle is now
   * running as its own, and will end with its own `stop`.
   *
   * Two states decline rather than decide, leaving the turn to the watchdog exactly as before: a
   * question put to the user (the agent is waiting on a person, not finished), and a tool call
   * still open (something is visibly running, whatever the cycle's result said).
   */
  function watchForFoldedPrompt(state: TurnState): {
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
      if (awaitingUser > 0) return;
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
   * Watch the harness's own log for the duration of one turn.
   *
   * ── Why a turn needs this at all ──────────────────────────────────────────────────────────────
   * Because the silence watchdog can only report silence, and silence has more than one cause.
   * Reported 2026-09-17: opencode's model pool started rate-limiting, opencode retried internally
   * without saying so over ACP or on stderr, and every `oc` turn sat at "typing" for ten minutes
   * before failing with "sent no update … treating it as hung". The agent was never hung, and the
   * one place the reason existed was opencode's own log file (see harness-log.ts).
   *
   * Deliberately does NOT end the turn. A logged error is evidence that something went wrong, not
   * that the turn is lost — opencode retries and often wins — so acting on it would trade a
   * misleading message for a killed turn that would have succeeded. It only says so out loud, and
   * leaves the verdict to the watchdog that already owns it.
   *
   * Each distinct reason is announced once: a retry loop writes the same line every few seconds,
   * and the point is to end the silence, not to replace it with a stream of duplicates.
   */
  function watchHarnessLog(handlers: AgentStreamHandlers): {
    /** The harness's last word on this turn, re-read at the moment it is asked for. */
    lastReason: () => Promise<string | undefined>;
    stop: () => void;
  } {
    const startedAt = new Date();
    const announced = new Set<string>();
    let latest: string | undefined;
    /**
     * `announce` is false for the final read the timeout makes: by then the turn is over, so
     * "is retrying" would be a false statement, and the reason is about to be delivered anyway as
     * part of the failure message.
     */
    const poll = async (announce: boolean): Promise<void> => {
      // `active` is read at call time, not captured: a turn can outlive the child it started on.
      const events = await readHarnessErrors(def, active?.sessionId, startedAt);
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
    // Never hold the process open for a diagnostic.
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

  return {
    conversationId,

    async runTurn(input: RunTurnInput, handlers: AgentStreamHandlers): Promise<void> {
      aborting = false;
      // From here until the prompt is out, a message sent mid-turn waits for it (see promptSent).
      // Closed on every way out: the prompt sent, the start failing below, or the turn's `finally`.
      // What runs between this try and that one is synchronous bookkeeping that cannot throw.
      const closePromptWindow = openPromptWindow();
      try {
        await ensureStarted(input.sessionToken);

        // Whatever background output was still rendering belongs to the previous exchange. AWAITED,
        // not fired and forgotten: in the default `once` delivery mode the burst's whole body is
        // sent by this call, and the new turn is about to start sending through a different buffer —
        // unordered, they would interleave and the background report would appear underneath an
        // answer it has nothing to do with. Stopped: this turn cut it off.
        await closeFollowUp('stopped');
      } catch (err) {
        closePromptWindow();
        // Stopped (or disposed) while the preLaunch hook ran: nothing failed, so nothing to report.
        if (err instanceof PreLaunchCancelled) return;
        throw err;
      }

      const state = newTranslationState(handlers);

      // Report the live model up front, from the session/new response captured at startup. Doing it
      // here rather than inside ensureStarted keeps it per-turn: handlers belong to this turn, and a
      // session started on an earlier turn would otherwise never report its model to a later one.
      // config_option_update supersedes this if the model changes mid-session.
      if (liveModel) handlers.onModel?.(liveModel);
      // Effort rides along from the same option list, read fresh rather than cached: it has no
      // preference to fall back on, so the list is the whole of what is known about it.
      const effort = liveEffortName(liveConfigOptions);
      if (effort) handlers.onEffort?.(effort);

      // Silence watchdog: one timer, re-armed by the pump on every update it hands to this turn, so
      // it bounds SILENCE rather than turn length. A hung agent — alive but never sending `stop` nor
      // any update — would otherwise leave this turn waiting forever, pinning the conversation in
      // `running` and unreclaimable.
      let hung: ((err: Error) => void) | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      /** Whether this stretch of silence has already been forgiven for a running tool. */
      let toolGraceUsed = false;
      const arm = (ms: number): void => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => onSilence(ms), ms);
      };
      // Read at call time: a remote agent's link state is what decides whether silence means anything.
      const host = remoteHosts.hostFor(def);
      const onSilence = (waited: number): void => {
        // Cut off, not hung: while the link to the agent's host is down nothing CAN arrive, and the
        // agent is still working over there (remote/README.md). The full timeout starts again when
        // the link is back (watchRemoteLink below), so an outage never counts against the agent.
        if (host && !host.isUp) {
          arm(waited);
          return;
        }
        // Blocked on a person, not hung: an elicitation stops the agent by design and the answer
        // arrives at human speed. Re-arm indefinitely rather than spend the one-shot tool grace —
        // the wait is already bounded by the ask's own timeout, which resolves to `cancel` and
        // lets the turn continue, so nothing here can hang forever.
        if (awaitingUser > 0) {
          arm(waited);
          return;
        }
        // Silence with a tool call still open is not a hung agent, it is a script running — and
        // the harness's own tool limit reaches exactly this deadline, so the collision was
        // guaranteed rather than unlucky (see TOOL_SILENCE_FACTOR).
        if (!toolGraceUsed && hasOpenToolCall(state)) {
          toolGraceUsed = true;
          const extra = turnTimeoutMs * TOOL_SILENCE_FACTOR;
          console.log(
            `[acp] ${conversationId}: quiet for ${waited}ms but a tool call is still open; allowing it ${extra}ms more`
          );
          arm(extra);
          return;
        }
        hung?.(
          new TurnTimeoutError(
            `agent "${def.id}" sent no update for ${waited}ms${
              toolGraceUsed ? ' with a tool call still open' : ''
            }; treating it as hung and aborting this turn`
          )
        );
      };
      const rearmWatchdog = (): void => {
        if (turnTimeoutMs <= 0) return; // 0 disables the watchdog entirely
        toolGraceUsed = false; // the agent spoke: this is a fresh stretch of silence
        arm(turnTimeoutMs);
      };

      // The pump routes updates here for as long as this is set, and calls the two callbacks to
      // re-arm the watchdog and to end the wait below. All three are cleared in `finally`, so a late
      // `stop` or a stray update can never bleed into the next turn.
      turnState = state;
      // Runs alongside the watchdog for harnesses that admit their failures only to their own log;
      // for every other harness this allocates a Set and starts no timer.
      const logWatch = watchHarnessLog(handlers);
      const unwatchLink = watchRemoteLink(host, handlers, rearmWatchdog);
      const fold = watchForFoldedPrompt(state);
      /**
       * The LAST prompt this turn sent, and its response once settled — the response being what a
       * `stop` has to carry to end THIS turn (see endTurnWait: a prompt an earlier turn gave up on
       * settles later, into this wait). Usually the turn's only prompt; on a `prompt`-mode harness a
       * message sent mid-turn adds another (see joinTurn), and the turn then ends on that one.
       */
      let promptDone: Promise<PromptResponse> | undefined;
      let ownResponse: PromptResponse | undefined;
      /** Whether that last prompt has settled, either way: past this point the turn is ending. */
      let lastSettled = false;
      onTurnUpdate = (update) => {
        rearmWatchdog();
        // Only once this prompt is out: a cycle that ended before it was sent cannot have absorbed it.
        if (promptDone) fold.observe(update);
      };
      const settled = new Promise<void>((resolve) => {
        endTurnWait = (response) => {
          // A rejected read carries nothing: wake, and let promptFailed say what went wrong.
          if (response === undefined || response === ownResponse) return resolve();
          const ignore = (): void =>
            console.log(`[acp] ${conversationId}: ignoring a stop that belongs to an earlier prompt`);
          if (!promptDone) return ignore();
          // Not yet known to be ours. Normally ownResponse is already set by now (its callback was
          // attached before the pump could read this stop), but the question is settled on the
          // prompt itself rather than on which of two callbacks ran first.
          void promptDone.then((own) => (own === response ? resolve() : ignore()), () => {});
        };
      });
      const timedOut = new Promise<never>((_, reject) => {
        hung = reject;
      });
      // Success is waited on via the QUEUE's `stop`, not via the prompt: the harness emits its last
      // updates (the final usage snapshot among them) before the prompt settles, and the pump
      // delivers them in order, so `stop` is the only signal meaning "this turn's output has all been
      // rendered". The prompt alone would finish the turn with renders still queued.
      //
      // FAILURE, though, has to be waited on directly, because a failed prompt produces no `stop` —
      // and `AsyncQueue.reject` is a no-op once the queue has terminally failed, so on a dead
      // connection nothing would ever wake this turn. It then hung out the full silence watchdog and
      // blamed the agent for "sending no update", or with `turnTimeoutMs: 0` hung forever, pinning
      // the conversation in `running`. So: a promise that rejects with the error of ANY prompt this
      // turn sent and never resolves (success is `settled`'s job). The no-op handler keeps a rejection
      // arriving after the race is decided from surfacing as unhandled.
      let failTurn: (err: unknown) => void = () => {};
      const promptFailed = new Promise<never>((_, reject) => {
        failTurn = reject;
      });
      void promptFailed.catch(() => {});
      /** Send a prompt as part of this turn, and make it the one the turn ends on. */
      let unsettled = 0; // this turn's prompts still open: more than one means one is queued behind
      const send = (session: ActiveSession, blocks: ContentBlock[]): void => {
        const p = session.prompt(blocks);
        promptDone = p;
        ownResponse = undefined;
        lastSettled = false;
        unsettled++;
        // Attached straight after the SDK's own callback (which enqueues the `stop`), so this runs
        // before the pump can read that `stop` — see endTurnWait above.
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
      joinedStillQueued = () => unsettled > 1;
      rearmWatchdog();

      try {
        // ActiveSession.prompt resolves at turn end and enqueues 'stop'; the pump reads the stream.
        // Inside the try so a synchronous throw (a closed stream) still runs the cleanup below.
        //
        // Waited on FIRST, because this flag is what stops a resumed session's replayed history
        // from being rendered as this turn's reply, and it is only sound once the pump has actually
        // reached the end of that replay (see replayFence — without this the gate is a race that a
        // long conversation is guaranteed to lose).
        if (replayFence) await replayFence;
        promptedYet = true; // from here on, renderable output is this session's own (see promptedYet)
        const session = active!;
        const agentCtx = conn!.agent;
        send(session, blocksOf(input));
        joinTurn = steeringMode === 'none' ? undefined : (blocks) => {
          // The turn's last prompt has settled, so its `stop` is on the way: a message taken now
          // would be answered by the harness after this turn stopped listening.
          if (lastSettled || aborting || active !== session) return Promise.resolve('refused');
          if (steeringMode === 'prompt') {
            send(session, blocks);
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
        closePromptWindow();
        const outcome = await Promise.race([settled, timedOut, promptFailed, fold.folded]);
        if (outcome === 'folded') {
          // Answered inside an autonomous cycle, and the harness will not say so. End the turn with
          // what it rendered and leave the prompt pending: the adapter settles it at the next
          // prompt, whose turn ignores that stale `stop` (see endTurnWait). No `session/cancel` —
          // if this was a misjudged queued prompt rather than a folded one, a cancel would kill
          // the very reply that is about to start; left alone, it arrives as a background update.
          flushPendingTools(state);
          return;
        }
        // Already resolved at stop; here only settles / rethrows an in-turn error. The LAST prompt:
        // the turn ended on its `stop`, and an earlier one's failure already lost the race above.
        const response = await promptDone!;
        // A failed turn, as an adapter that negotiated failure records reports one: `end_turn`
        // with the failure in `_meta`, where an older contract rejected the prompt. Thrown before
        // the tools are flushed, exactly as a rejection was, so the two read the same downstream.
        const failure = readSessionFailure(response._meta);
        if (failure?.severity === 'error') throw new TurnFailure(describeSessionFailure(failure), failureReasonOf(failure));
        flushPendingTools(state);
      } catch (err) {
        if (aborting) return; // intentional abort is not an error
        // A hung-agent timeout: reap the subprocess so the next turn rebuilds a fresh connection
        // (and so the pump, which is waiting on this queue, lands on a dead one and stands down).
        if (err instanceof TurnTimeoutError) {
          // Asked BEFORE dispose(), which clears `active` via resetHandles and with it the session
          // id this lookup is keyed on. "Hung" is the gateway's guess; the harness may have written
          // down what actually happened, and if it did, that is what the user should be told.
          const reason = await logWatch.lastReason();
          dispose();
          if (reason) {
            throw new TurnTimeoutError(`${err.message}. ${def.harness} last logged: ${trimReason(reason)}`);
          }
        }
        throw err;
      } finally {
        if (watchdog) clearTimeout(watchdog);
        logWatch.stop();
        unwatchLink();
        fold.stop();
        turnState = undefined;
        onTurnUpdate = undefined;
        endTurnWait = undefined;
        joinTurn = undefined;
        joinedStillQueued = undefined;
        closePromptWindow();
        if (endChildAfterStop) {
          // Before this turn counts as over, so the next one cannot start on the child about to go.
          endChildAfterStop = false;
          console.log(
            `[acp] ${conversationId}: stopped with a joined message still queued in the harness; ending the child so it cannot run it (the next message resumes the session)`
          );
          dispose();
        }
      }
    },

    async steer(input: Pick<RunTurnInput, 'prompt' | 'images'>): Promise<SteerOutcome> {
      // A turn still starting has not sent its prompt: wait for it rather than refuse, or the message
      // would sit out the whole turn (see promptSent).
      if (promptSent) await promptSent;
      if (!joinTurn || aborting) return 'refused';
      return joinTurn(blocksOf(input));
    },

    setFollowUpSink(sink: FollowUpSink): void {
      // Deliberately does NOT close a burst still rendering through the outgoing sink. Two
      // reasons: the close has to be AWAITED to stay ordered against the reply that is about to be
      // written into the same lane (runTurn does that), and a burst carries the sink that opened
      // it (see followUpState), so swapping cannot orphan one.
      followUpSink = sink;
    },

    abort(): void {
      aborting = true;
      launchHook?.abort();
      // A joined message the harness has not taken up yet would outlive the cancel (see
      // endChildAfterStop); the turn ends the child on its way out.
      if (joinedStillQueued?.()) endChildAfterStop = true;
      // The tools this turn had open are the ones whose trailing updates are wreckage once a NEW
      // turn has cleared `aborting` (see isWreckage). Read off the live turn's ledger, which is
      // why that is a session-level variable. Empty when the cancel beats the harness's first
      // tool_call — the `aborting` half of isWreckage covers that window.
      cancelledTools = new Set(turnState?.toolLedger.keys() ?? []);
      if (conn && active) void conn.agent.notify('session/cancel', { sessionId: active.sessionId });
    },

    stopBackground(): boolean {
      if (turnState || !burstRendering || !followUpState || !conn || !active) return false;
      // The burst's open tools are this cancel's wreckage, exactly as a turn's are abort()'s. NOT
      // `aborting`: that flag stands until the next turn clears it, and a conversation stopped
      // out of turn may not see another turn for hours — every tool bubble of every later
      // background report would be dropped as wreckage in the meantime.
      cancelledTools = new Set(followUpState.state.toolLedger.keys());
      console.log(`[acp] ${conversationId}: stopping background output on request`);
      void conn.agent.notify('session/cancel', { sessionId: active.sessionId });
      // Marked failed before the seal would mark them done: a deploy the user just stopped must
      // not be left on screen with a ✓ — observed live against claude-agent-acp 0.81.0, where the
      // harness's own "failed" update arrives after this and is (rightly) dropped as wreckage.
      flushPendingTools(followUpState.state, false);
      // Sealed now rather than left to the quiet timer: the user has just been told it stopped,
      // and a message still streaming (or, in `once` mode, not yet sent at all) says otherwise.
      void closeFollowUp('stopped');
      return true;
    },

    async ensureSession(sessionToken: string): Promise<void> {
      // Exactly what the first turn does, minus the prompt: the child, initialize, and session/new
      // (or session/load), which is where liveConfigOptions — and therefore the model list — comes
      // from. Idempotent via `active`, so a second /model while one warm-up is in flight is free.
      await ensureStarted(sessionToken);
    },

    modelSelector(): ModelSelector | undefined {
      const opt = liveConfigOptions?.find((o) => o.id === MODEL_CONFIG_ID);
      if (!opt || opt.type !== 'select') return undefined;
      // dsh encodes every value as JSON.stringify([provider, model]); /model matches user-typed text
      // against these values and feeds them back to setModel, so decode them to the same
      // "provider/model" spelling config and queries use.
      const display = (v: string): string => (def.harness === 'dsh' ? dshModelDisplayValue(v) : v);
      // Options come flat or grouped by provider; flatten so the caller sees one list.
      const options = opt.options
        .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
        .map((o) => ({ value: display(o.value), name: o.name || display(o.value) }));
      return {
        current: typeof opt.currentValue === 'string' ? display(opt.currentValue) : undefined,
        options,
      };
    },

    async setModel(value: string): Promise<string> {
      // dsh's selector values are JSON.stringify([provider, model]) (see dshModelSelectorValue); the
      // /model menu hands us decoded "provider/model" values, so re-encode before the wire.
      const wire = def.harness === 'dsh' ? dshModelSelectorValue(value) : value;
      // No live session = no selector to set right now: the option list arrives with session/new.
      // Rather than fail, record the choice as this conversation's preference. modelPreference
      // outlives dispose (resetHandles does not clear it), so applyModelPreference re-applies it when
      // the next turn spawns a child — the same self-healing path a crashed child takes. Returning
      // the requested value lets the footer name it immediately; if the harness resolves it to a
      // concrete id, the next config_option_update corrects the display.
      if (!conn || !active) {
        modelPreference = value;
        console.log(`[acp] agent "${def.id}": model "${value}" deferred — no live child, applies on next turn`);
        return value;
      }
      // Captured before the await: `conn` and `active` are reassigned by a child dying under us, and
      // the effort re-apply below must address the session this switch was made on.
      const agentCtx = conn.agent;
      const sessionId = active.sessionId;
      const res = await agentCtx.request('session/set_config_option', {
        sessionId,
        configId: MODEL_CONFIG_ID,
        value: wire,
      });
      // Remember BEFORE trusting the echo: the choice must outlive this child either way.
      modelPreference = value;
      liveConfigOptions = res?.configOptions ?? liveConfigOptions;
      // The new model brings its own effort levels, and may have reset the level to its default.
      // Put the conversation's `/effort` choice back where the new model still offers it.
      await reapplyEffort(agentCtx, sessionId);
      liveModel = liveModelName(liveConfigOptions) ?? value;
      console.log(`[acp] agent "${def.id}": model switched to "${value}" at runtime`);
      return liveModel;
    },

    effortSelector(): EffortSelector | undefined {
      return effortSelectorOf(liveConfigOptions);
    },

    async setEffort(value: string): Promise<string> {
      // No live child: record it, exactly as setModel does. Both startup paths re-apply it — the
      // session/load one being the one that matters, since that is how a reclaimed conversation
      // comes back. The caller has already checked the value against the (kept) option list.
      if (!conn || !active) {
        effortPreference = value;
        console.log(`[acp] agent "${def.id}": effort "${value}" deferred — no live child, applies on next turn`);
        return value;
      }
      const opt = effortOption(liveConfigOptions);
      if (!opt) throw new Error('the current model offers no effort levels');
      const res = await conn.agent.request('session/set_config_option', {
        sessionId: active.sessionId,
        // The harness's own id for it (`effort` / `reasoning_effort`), never spelled here.
        configId: opt.id,
        value,
      });
      effortPreference = value;
      liveConfigOptions = res?.configOptions ?? liveConfigOptions;
      console.log(`[acp] agent "${def.id}": effort switched to "${value}" at runtime`);
      return effortOption(liveConfigOptions)?.currentValue || value;
    },

    reclaimState(): ReclaimState {
      // `active` is this runtime's readiness signal everywhere else, so it is the honest test for
      // "there is something here to reclaim" too.
      if (!proc || !active) return 'no-child';
      // Resumable only when BOTH halves of the restart path are in place: the harness can reload a
      // session, and we know which session is this conversation's. Killing the child then costs a
      // respawn — precisely what a daemon restart already does to every conversation at once.
      return loadSessionSupported && store?.agentSession(conversationId, def.id)
        ? 'resumable'
        : 'unresumable';
    },

    dispose(): void {
      dispose();
    },
  };
}

/**
 * Whether a buildSession().start() (session/new) failure means "must log in first" (auth_required).
 * ACP expresses un-auth as session/new returning an `authRequired` stop reason or an auth-flavored error;
 * wording varies per harness, so match message/code loosely. Used only for a readable hint, not interactive auth.
 */
function isAuthRequired(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const code = (err as { code?: unknown })?.code;
  return /auth[_-]?required|authentication|not\s+logged\s*in|unauthor/i.test(msg) || code === 'auth_required';
}

/**
 * The `permissions: auto` answer to session/request_permission — the default, and what every
 * agent got before `ask` existed: approve, so agents run with full tool access and the only gate
 * is access.allowFrom (who may trigger the agent at all). Also how a scheduled run is answered
 * under `ask`, since nobody is there to be asked. Picks allow_once when offered, else any allow_*;
 * if the agent somehow offers no allow option, falls back to cancelled (can't fabricate an id).
 */
export function decidePermission(req: RequestPermissionRequest): RequestPermissionResponse {
  const opts = req.options;
  const pick = (pred: (o: PermissionOption) => boolean): string | undefined =>
    opts.find(pred)?.optionId;
  const allow = pick((o) => o.kind === 'allow_once') ?? pick((o) => o.kind.startsWith('allow'));
  return allow ? { outcome: { outcome: 'selected', optionId: allow } } : { outcome: { outcome: 'cancelled' } };
}

/**
 * The JSON-RPC error code a declined-without-an-answer permission request is returned with. In the
 * range JSON-RPC leaves to implementations, and not one ACP itself uses (-32000 is auth_required,
 * -32002 resource_not_found).
 */
export const PERMISSION_DECLINED_CODE = -32001;

/** A permission request as the user is shown it: the tool call's title, and the agent's options. */
export function permissionRequestOf(req: RequestPermissionRequest): AgentPermissionRequest {
  const title = stripCode(req.toolCall.title ?? '') || buildInputPreview(req.toolCall.rawInput) || 'a tool call';
  return { title, options: req.options.map((o) => ({ optionId: o.optionId, label: o.name || o.optionId })) };
}

/**
 * Turn what became of a permission request into the ACP response.
 *
 * ── Why "declined" is an ERROR here, not the agent's reject option ───────────────────────────
 * A request nobody answered has to reach the agent as exactly that — never as the user refusing
 * (asked for in so many words, 2026-10-28). ACP's response carries no reason: it is an option id or
 * `cancelled`, and the harness turns each into fixed words. Measured against claude-agent-acp
 * 0.81.2 the same day: the reject option becomes "User refused permission to run tool", which here
 * would be a lie, and `cancelled` becomes "Tool use aborted", which says nothing. A JSON-RPC error
 * is the one channel that carries text — the adapter rethrows it (requestPermissionFromClient) and
 * the model read ours: "nobody answered the request within 10 minutes, so it was declined
 * automatically (not refused)". The tool does not run, and the turn goes on.
 *
 * Hyrum's Law: rethrowing the error is the adapter's internal behaviour, not the protocol's.
 * agent-acp-permission.test.ts pins it against the installed adapter. And the error must be a
 * RequestError: the SDK replaces any other exception's message with "Internal error".
 */
export function permissionResponse(
  req: RequestPermissionRequest,
  answer: PermissionAnswer
): RequestPermissionResponse {
  switch (answer.kind) {
    case 'selected':
      return { outcome: { outcome: 'selected', optionId: answer.optionId } };
    case 'unattended':
      return decidePermission(req);
    case 'cancelled':
      // ACP's own meaning: the turn was cancelled before anyone answered.
      return { outcome: { outcome: 'cancelled' } };
    case 'unanswered': {
      const minutes = Math.round(answer.waitedMs / 60_000);
      throw new RequestError(
        PERMISSION_DECLINED_CODE,
        `No one answered this permission request within ${minutes} minutes, so it was declined automatically. ` +
          'This is not a refusal: the user did not respond to the request.',
        { reason: 'unanswered' }
      );
    }
    case 'unavailable':
      throw new RequestError(
        PERMISSION_DECLINED_CODE,
        `This permission request could not be shown to the user (${answer.why}), so it was declined automatically. ` +
          'This is not a refusal by the user.',
        { reason: 'unavailable' }
      );
    default: {
      const _exhaustive: never = answer;
      throw new Error(`unknown permission answer: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ───────────────────────── session/update → handlers translation (core) ─────────────────────────

/**
 * The choosable options of one elicitation form field.
 *
 * Single-select fields carry them under `oneOf`, multi-select under `items.anyOf`; both hold
 * ACP `EnumOption`s. An option with no usable `const` is dropped rather than guessed at: the
 * answer has to carry that exact value, and sending one the agent never listed is worse than
 * offering one button fewer.
 *
 * Takes `unknown` because `ElicitationPropertySchema` is a union over every primitive type, and
 * the number/boolean arms carry no enum at all — narrowing here rather than at the call site
 * keeps the "no options, skip this question" answer in one place.
 */
function parseElicitOptions(prop: unknown): ElicitOption[] {
  const p = prop as { oneOf?: unknown; items?: { anyOf?: unknown } };
  const raw = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.items?.anyOf) ? p.items.anyOf : [];
  const options: ElicitOption[] = [];
  for (const o of raw) {
    const opt = o as { const?: unknown; title?: unknown; description?: unknown };
    // `const` is the answer, `title` is display only; either may stand in for a missing other,
    // but with neither there is nothing to send back and nothing to print on a button.
    const value = typeof opt.const === 'string' ? opt.const : undefined;
    const label = typeof opt.title === 'string' && opt.title.length > 0 ? opt.title : value;
    if (value === undefined || label === undefined) continue;
    const description = typeof opt.description === 'string' ? opt.description.trim() : '';
    options.push(description ? { label, value, description } : { label, value });
  }
  return options;
}

/**
 * Translate an ACP `elicitation/create` into the platform-agnostic question rounds the daemon
 * renders as buttons. Returns null for anything this client cannot put in front of a user, in
 * which case the caller declines rather than guessing an answer.
 *
 * ── What the wire shape actually is ───────────────────────────────────────────────────────────
 * A form elicitation carries a JSON Schema, not a question list, so the questions have to be read
 * back out of it. The layout is claude-agent-acp's `askUserQuestionsToCreateRequest` (verified
 * against a live payload, see the fixture in agent-acp.test.ts): one `question_<n>` property per
 * question — `oneOf` of `{const, title, description}` for single-select, `items.anyOf` for
 * multi-select — each followed by a `question_<n>_custom` free-text "Other" field. The question
 * text lives in `message` when there is exactly one question, and in each property's
 * `description` when there are several.
 *
 * `_custom` fields are not rounds of their own: they are the CLI's "type your own answer instead"
 * box, and a button row cannot collect free text. They are not dropped either, though — the key is
 * recorded on the question it belongs to (ElicitQuestion.customKey), because that is the field a
 * typed reply in the chat is sent back under. Skipping them as rounds is safe because the adapter
 * marks them optional: an accept that omits them is a complete answer, not a partial one.
 *
 * A question left with no usable options is dropped, and a form where every question drops
 * yields null.
 */
export function parseFormElicitation(params: CreateElicitationRequest): AgentElicitation | null {
  // `url` mode points the user at a browser to finish something out of band. There is no useful
  // rendering of that in a chat message the daemon can then correlate an answer to, so it is
  // declined rather than half-supported (the client advertises only `form` for the same reason).
  if (params.mode !== 'form') return null;

  const message = typeof params.message === 'string' ? params.message.trim() : '';
  const properties = params.requestedSchema?.properties ?? {};

  const questions: ElicitQuestion[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (key.endsWith('_custom')) continue;
    const p = prop as { type?: string; title?: string | null; description?: string | null };
    const options = parseElicitOptions(prop);
    if (options.length === 0) continue;
    // Single-question forms carry the question in `message` and leave `description` unset; the
    // title is a short header, so it is the last resort rather than the first.
    const prompt = p.description?.trim() || message || p.title?.trim() || key;
    // Only claim a free-text field the form actually declared, and only when it takes a string:
    // every other elicitation source (an MCP server's own form) is free to offer none, and
    // inventing the key would send the agent a field its schema never mentioned.
    const customKey = `${key}_custom`;
    const custom = (properties as Record<string, { type?: string } | undefined>)[customKey];
    questions.push({
      key,
      prompt,
      options,
      multi: p.type === 'array',
      ...(custom?.type === 'string' ? { customKey } : {}),
    });
  }

  if (questions.length === 0) return null;
  return { message: message || questions[0]!.prompt, questions };
}

export interface TurnState {
  handlers: AgentStreamHandlers;
  /** 'none' start / 'text' streaming body / 'tool' just had a tool. Used for onSegmentBreak. */
  lastSegment: 'none' | 'text' | 'tool';
  /** toolCallId → evolving tool state (accumulated across tool_call ↔ tool_call_update). */
  toolLedger: Map<string, ToolRec>;
  toolIndexSeq: number;
  /**
   * Hand a fresh `configOptions` list back to the session that owns it (`config_option_update`).
   *
   * Exists because translateUpdate is a module-level function and the option list lives in the
   * session closure: without this the footer learned about a mid-session model switch (onModel
   * fires) while `modelSelector()` kept reporting the old `currentValue` — so a `/model` menu
   * opened afterwards marked the wrong model as current and opened on the wrong page.
   *
   * Optional so the pure translation tests can omit it.
   */
  onConfigOptions?(options: SessionConfigOption[] | null | undefined): void;
  /**
   * Hand a failure record from a `session_info_update` to the session to announce (see
   * session-failure.ts). A callback for the same reason as onConfigOptions: the notice needs the
   * agent's id and the session's replay state, and translateUpdate sees neither. Optional, so the
   * pure translation tests can omit it.
   */
  onSessionFailure?(failure: SessionFailure): void;
  /**
   * Override for the context-window size (tokens) reported over `usage_update`. When set, ingestUsage
   * replaces the harness's `size` with this before forwarding — the local-config fix for a harness that
   * under-reports the window (see AgentDef.contextWindow). Absent = trust the harness's number.
   */
  contextWindow?: number;
  /**
   * The subagents this session has spawned: the id of the Agent/Task call that started each one →
   * the name to show on its tools' bubbles (see claudeAttribution).
   *
   * Session-scoped, and the same Map in every TurnState the session builds, because a background
   * subagent outlives the turn that launched it: the spawning call completes the moment the
   * subagent starts, the turn's toolLedger is cleared when the turn ends, and the subagent's tools
   * keep arriving in later turns and follow-up bursts. Probed 2026-10-10: the call reported
   * `completed` at 9.3s, its subagent's first tool arrived at 20.1s.
   *
   * Optional so the pure translation tests can omit it; without it every subagent is unnamed.
   */
  subagents?: Map<string, string>;
}

/**
 * One tool's evolving state. In ACP the first tool_call is often pending with title/rawInput not fully
 * streamed, completed by later tool_call_update (the protocol allows update to replace title/kind/
 * rawInput/status). So accumulate the latest known values and defer onToolStart until ready.
 */
interface ToolRec {
  index: number;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  startAt: number;
  /** Whether onToolStart (bubble rendered) was already sent. */
  started: boolean;
  /** What that bubble currently says, so a later frame that says something else can correct it. */
  rendered?: { name: string; preview: string };
  /** Whether onToolFinish was already sent. */
  finished: boolean;
  /** Id of the Agent/Task call whose subagent ran this tool; undefined for the main agent's own. */
  parent?: string;
  /** This call is an Agent/Task call: it starts a subagent, whose tools will name it as `parent`. */
  spawns?: boolean;
}

/**
 * Hand a `config_option_update` back to the session and re-report the live model.
 *
 * The whole option list goes back, not just the model name: `/model` needs the choices to build a
 * menu, and this notification is the only place a mid-session change to them shows up.
 */
function reportConfigOptions(u: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>, st: TurnState): void {
  st.onConfigOptions?.(u.configOptions);
  const model = liveModelName(u.configOptions);
  if (model) st.handlers.onModel?.(model);
  // Reported even when undefined, unlike the model: the update is the full option list, so an effort
  // missing from it is news — `/effort default`, or an opencode switch to a model without variants —
  // and a footer still showing the old level would be stating something no longer true.
  st.handlers.onEffort?.(liveEffortName(u.configOptions));
}

export function translateUpdate(u: SessionUpdate, st: TurnState): void {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      ingestText(u, st);
      break;

    // tool_call and tool_call_update are handled identically: merge this tool's latest fields into the
    // ledger, then render based on status / rawInput readiness. Generic across all ACP agents.
    case 'tool_call':
      if (u.toolCallId)
        ingestTool(st, u.toolCallId, { title: u.title, kind: u.kind, rawInput: u.rawInput, status: u.status }, u._meta);
      break;
    case 'tool_call_update':
      if (u.toolCallId)
        ingestTool(st, u.toolCallId, { title: u.title, kind: u.kind, rawInput: u.rawInput, status: u.status }, u._meta);
      break;

    // Agent reports its available-commands list: normalize to AgentCommand[] for the upper layer,
    // which feeds the harness PICKERS only — native slash registration is fixed at startup from
    // config and does not read this (see daemon.ts buildRegisteredSpecs / onAgentCommands).
    // Sent once per session build (session/new, /load, /resume, /fork) and again on a mid-session
    // `commands_changed` — e.g. skills discovered as the agent moves into a subdirectory. Never on
    // prompt(). Each is a full list, so the upper layer just overwrites.
    // Verified against @agentclientprotocol/claude-agent-acp dist/acp-agent.js, 2026-09-11.
    case 'available_commands_update': {
      const cmds = (u.availableCommands ?? []).map((c) => ({
        name: c.name,
        description: c.description,
        hint: c.input?.hint,
      }));
      st.handlers.onAvailableCommands?.(cmds);
      break;
    }

    // Live context usage: tokens in context + window size. Both are the harness's own numbers
    // (claude-agent-acp reads them from the SDK's context tally and learns the real window from the
    // model's reported capabilities), so the footer never has to guess a limit. Emitted several
    // times per turn as full snapshots — the consumer keeps the latest.
    case 'usage_update': {
      ingestUsage(st, u.used, u.size, u.cost);
      break;
    }

    // The agent's session config changed (model / mode / effort picker). The model and the effort
    // interest us: re-read both so a mid-session switch of either is reflected in the footer.
    case 'config_option_update':
      reportConfigOptions(u, st);
      break;

    // A failure record (retry, advisory, or a failure with no turn), when the session asked for them
    // (see session-failure.ts). Its re-arming of the silence watchdog is the pump's doing, like any
    // other update's. This case only decides what to say.
    //
    // A `session_info_update` with no record carries the harness's own name for the conversation,
    // and is ignored on purpose: the gateway names a conversation once from its opening message
    // (see ConversationRegistry.nameConversation) rather than following a title that keeps moving.
    case 'session_info_update': {
      const failure = readSessionFailure(u._meta);
      if (failure) st.onSessionFailure?.(failure);
      break;
    }

    // agent_thought_chunk / plan* / *_update etc.: not rendered.
    default:
      break;
  }
}

/**
 * Forward a text chunk into the reply body. Extracted from translateUpdate to keep that switch's
 * complexity within the lint budget.
 */
function ingestText(u: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>, st: TurnState): void {
  const text = u.content.type === 'text' ? u.content.text : undefined;
  if (typeof text !== 'string' || text.length === 0) return;
  // The body is the main agent's words. A subagent's text does not reach a client like this one
  // (see claudeAttribution), but the adapter's streaming path stamps it rather than filtering it, so
  // should it ever arrive it is kept out of the reply instead of being read as the answer.
  if (claudeAttribution(u._meta).parent) {
    console.debug(`[acp] not rendering ${text.length} chars of subagent text into the reply`);
    return;
  }
  if (st.lastSegment === 'tool') st.handlers.onSegmentBreak(); // tool → text boundary
  st.lastSegment = 'text';
  st.handlers.onText(text);
}

/**
 * Forward a context snapshot, ignoring unusable ones. A zero/absent window would render as a
 * divide-by-zero percentage, so the snapshot is dropped and the footer degrades to "no context
 * segment" rather than a bogus "0%". Extracted from translateUpdate to keep that switch's
 * complexity within the lint budget.
 */
function ingestUsage(st: TurnState, used: unknown, size: unknown, cost: unknown): void {
  if (typeof used !== 'number') return;
  // A local override wins over the harness's window (see AgentDef.contextWindow): the harness
  // under-reports for models missing from its hardcoded table, so a configured window is the more
  // accurate number. Fall back to the reported size when no override is set.
  const window = st.contextWindow ?? size;
  if (typeof window !== 'number' || window <= 0) return;
  // Cost rides along only when it is a real number: it is the one field a busy `/usage` quotes
  // verbatim, so a malformed one is dropped rather than printed as "$NaN".
  const c = cost as { amount?: unknown; currency?: unknown } | null | undefined;
  const reported =
    typeof c?.amount === 'number' && Number.isFinite(c.amount) && typeof c.currency === 'string'
      ? { cost: { amount: c.amount, currency: c.currency } }
      : {};
  st.handlers.onUsage?.({ used, size: window, ...reported });
}

/** Merge a tool's latest fields, then trigger start / finish per readiness. */
function ingestTool(
  st: TurnState,
  id: string,
  f: { title?: string | null; kind?: string | null; rawInput?: unknown; status?: string | null },
  meta?: unknown
): void {
  let rec = st.toolLedger.get(id);
  if (!rec) {
    rec = { index: st.toolIndexSeq++, startAt: nowMs(), started: false, finished: false };
    st.toolLedger.set(id, rec);
  }
  // Overwrite only with real values (update's title/kind may be null = unchanged).
  if (typeof f.title === 'string') rec.title = f.title;
  if (typeof f.kind === 'string') rec.kind = f.kind;
  if (f.rawInput !== undefined) rec.rawInput = f.rawInput;

  // Read before maybeStartTool below, which is where the bubble is drawn: it has to know whose it is.
  const { parent, spawnsSubagent } = claudeAttribution(meta);
  if (parent) rec.parent = parent;
  // Sticky: only the call's early updates carry the flag (the adapter drops it from the result's).
  if (spawnsSubagent) rec.spawns = true;
  if (rec.spawns) nameSubagent(st, id, rec);

  const terminal = f.status === 'completed' || f.status === 'failed';
  // Readiness signal: status reaches in_progress/terminal, or rawInput is non-empty (params streamed).
  maybeStartTool(st, id, f.status === 'in_progress' || terminal);
  if (terminal) finishTool(st, id, f.status === 'completed');
}

/**
 * Who made a session/update, as the `claude` adapter records it in `_meta.claudeCode`:
 *
 * - `parentToolUseId` — on everything a SUBAGENT produces: the id of the Agent/Task call that
 *   spawned it. Without reading it, a subagent's tool calls render exactly like the main agent's,
 *   and a half-hour background run reads as the main agent doing eighty things it never did.
 * - `subagent: true` — on that Agent/Task call itself.
 *
 * Only tools are affected in practice. The adapter keeps a subagent's own text internal unless the
 * client declares ACP `subagents` or `_meta["subagent-transcript"]` (claude-agent-acp 0.81.2
 * dist/acp-agent.js:4549, the `forwardSubagentText` filter), and this client declares neither — so
 * the main agent's relay of what the subagent found is what the user reads, which is the point.
 * Probed 2026-10-10 with a foreground and a background subagent: tools arrived attributed, no
 * subagent text arrived at all. `project-scripts/subagent-output/probe.mjs` reruns it.
 *
 * ⚠️ HYRUM'S LAW: neither field is in the ACP schema. claude-agent-acp 0.81.2 stamps
 * `parentToolUseId` from the SDK's `parent_tool_use_id` in toAcpNotifications (dist/acp-agent.js
 * :7641 for text, :7981 for tools) and sets `subagent` on Agent/Task calls. The contract test in
 * agent-acp.test.ts replays those shapes, so a rename fails there. A regression degrades to bubbles
 * that name no owner — unattributed, never lost. Other harnesses send neither, and are unaffected.
 *
 * Wire data, so every field is checked rather than cast.
 */
function claudeAttribution(meta: unknown): { parent?: string; spawnsSubagent: boolean } {
  const cc = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode : undefined;
  if (!cc) return { spawnsSubagent: false };
  const parent = typeof cc.parentToolUseId === 'string' && cc.parentToolUseId ? cc.parentToolUseId : undefined;
  return { parent, spawnsSubagent: cc.subagent === true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Bound on the names a session remembers. One per Agent/Task call, and an id is never reused, so
 * the oldest are the ones whose subagents finished longest ago; a session that spawns more than
 * this many and still hears from the first gets that one's tools marked as an unnamed subagent.
 */
const MAX_SUBAGENT_NAMES = 64;

/** What a subagent's bubbles say when the call that spawned it was never seen (or forgotten). */
const UNNAMED_SUBAGENT = 'subagent';

/**
 * Remember the name of the subagent an Agent/Task call starts: its `description`, else the call's
 * title (the adapter mirrors the description there once it has streamed in). Re-run on every
 * update of the call, because the first one arrives before its input has streamed and carries only
 * the placeholder title `Task`.
 */
function nameSubagent(st: TurnState, id: string, rec: ToolRec): void {
  if (!st.subagents) return;
  const name = subagentDescription(rec) || stripCode(rec.title);
  if (!name) return;
  if (!st.subagents.has(id) && st.subagents.size >= MAX_SUBAGENT_NAMES) {
    const oldest = st.subagents.keys().next().value;
    if (oldest !== undefined) st.subagents.delete(oldest);
  }
  st.subagents.set(id, name);
}

/** The `description` an Agent/Task call was given: the model's own short label for the job. */
function subagentDescription(rec: ToolRec): string {
  const input = isRecord(rec.rawInput) ? rec.rawInput : undefined;
  return typeof input?.description === 'string' ? input.description.trim() : '';
}

/** Render the bubble once the tool is ready (see upgradeToolRow for the later frames). force = status advanced, render even if rawInput is still empty. */
function maybeStartTool(st: TurnState, id: string, force: boolean): void {
  const rec = st.toolLedger.get(id);
  if (!rec) return;
  if (rec.started) {
    upgradeToolRow(st, rec);
    return;
  }
  if (!force && !isNonEmptyObject(rec.rawInput)) return; // params not streamed yet, keep waiting for update
  // An Agent/Task call also waits for its description, the name its subagent's bubbles will carry.
  // Drawn on the first streamed field instead, it read `{"subagent_type":"general-purpose"}`, and
  // nothing on screen said which subagent the `↳` lines below it belonged to.
  if (!force && rec.spawns && !subagentDescription(rec)) return;
  rec.started = true;
  if (st.lastSegment === 'text') st.handlers.onSegmentBreak(); // text → tool boundary
  const evt = toolStartEvent(st, rec);
  rec.rendered = { name: evt.name, preview: evt.inputPreview };
  st.handlers.onToolStart(evt);
  st.lastSegment = 'tool';
}

/** The row a call would draw now, from everything known about it. */
function toolStartEvent(st: TurnState, rec: ToolRec): ToolEvent {
  return {
    // name uses the short ACP kind (aligns with emojiMap); command/path detail only in the truncated preview.
    name: toolLabel(rec.kind, rec.title),
    inputPreview:
      (rec.spawns && subagentDescription(rec)) || buildInputPreview(rec.rawInput) || stripCode(rec.title),
    input: rec.rawInput,
    index: rec.index,
    // The spawning call always precedes its subagent's first tool, so its name is known by now.
    agent: rec.parent ? (st.subagents?.get(rec.parent) ?? UNNAMED_SUBAGENT) : undefined,
  };
}

/**
 * A call already on screen, whose later frame says something new about it: draw the row again.
 *
 * ── Why a drawn row is not final ────────────────────────────────────────────────────────────────
 *
 * `maybeStartTool` renders as soon as the status advances, which for a harness that announces the
 * call before its parameters is the right trade — a row appears while the tool runs. But "status
 * advanced" can mean only that: CodeBuddy Code opens EVERY call with `{title: "Bash", kind:
 * "other", rawInput: {}}`, so the row is drawn as `⚙️ Tool: "Bash"` — no command, no per-tool
 * emoji — and the parameters stream in on the frames after it, which the old code merged into a
 * record it had already stopped drawing from. Every cbc tool read `Tool: "Bash"` (or
 * `Tool: "ToolSearch"`) for its whole life; the command never appeared. Frames captured on the
 * wire 2026-11-02 by project-scripts/cbc-acp-probe/probe.mjs.
 *
 * So the row is re-emitted whenever its identity changes, and the renderer rewrites that line in
 * place (ToolRenderer.onToolStart, same index). Only the identity: a re-emit for an unchanged row
 * would push an edit through the turn's side-effect chain for nothing.
 */
function upgradeToolRow(st: TurnState, rec: ToolRec): void {
  if (rec.finished) return; // its ✓ is the last word; a redraw would race the finish line
  const evt = toolStartEvent(st, rec);
  if (rec.rendered?.name === evt.name && rec.rendered.preview === evt.inputPreview) return;
  rec.rendered = { name: evt.name, preview: evt.inputPreview };
  st.handlers.onToolStart(evt);
}

function finishTool(st: TurnState, id: string, ok: boolean): void {
  const rec = st.toolLedger.get(id);
  if (!rec || rec.finished) return;
  // Terminal arrived before any bubble was rendered → force a start so the bubble appears.
  if (!rec.started) maybeStartTool(st, id, true);
  rec.finished = true;
  st.handlers.onToolFinish({
    name: toolLabel(rec.kind, rec.title), // same name as onToolStart, so findLine's index fallback stays consistent
    index: rec.index,
    ok,
    durationMs: nowMs() - rec.startAt,
  });
}

/**
 * Whether the harness has a tool call open — rendered as started, not yet reported terminal.
 *
 * The silence watchdog's one piece of evidence that a quiet turn is working rather than wedged.
 * Reads the same ledger flushPendingTools closes out, so "open" means exactly what the tool bubbles
 * on screen mean.
 */
function hasOpenToolCall(st: TurnState): boolean {
  for (const rec of st.toolLedger.values()) {
    if (rec.started && !rec.finished) return true;
  }
  return false;
}

/**
 * Turn end: started-but-unfinished close as success; has-params-but-not-started get start+finish;
 * pure pending shells (never ran) skipped.
 *
 * `ok` is false only when the tools were STOPPED rather than left open by a harness that did not
 * report their end — see stopBackground, where the harness's own "failed" update is about to be
 * dropped as wreckage, so this is the only word the bubble will ever get.
 */
function flushPendingTools(st: TurnState, ok = true): void {
  for (const [id, rec] of st.toolLedger) {
    if (rec.finished) continue;
    if (rec.started || isNonEmptyObject(rec.rawInput)) finishTool(st, id, ok);
  }
  st.toolLedger.clear();
}

/**
 * ACP `kind` → short display name (short, and aligned with default emojiMap keys to reuse emoji).
 * Falls back to the truncated title when kind is absent. This keeps long content (commands/paths) only
 * in the truncated preview, leaving the bubble in the hermes `emoji shortname: "truncated args"` style.
 */
export function toolLabel(kind?: string, title?: string): string {
  // An MCP tool (`mcp__<server>__<tool>`, kind `other`) by its own name — `send_file`, `schedule` —
  // rather than the bare "Tool" every one of them would otherwise share: a column of identical "Tool"
  // rows says nothing about what a turn did.
  const mcp = title ? /^mcp__[^_]+(?:_[^_]+)*?__([A-Za-z0-9_-]+)$/.exec(title.trim()) : null;
  if (mcp?.[1] && (!kind || kind === 'other')) return mcp[1];
  const byKind: Record<string, string> = {
    read: 'Read',
    edit: 'Edit',
    delete: 'Delete',
    move: 'Move',
    search: 'Grep',
    execute: 'Bash',
    fetch: 'WebFetch',
    think: 'Task',
    switch_mode: 'Mode',
    other: 'Tool',
  };
  // `other` is the kind every adapter falls back to, so on its own it names nothing. CodeBuddy Code
  // puts the tool's own name in the title instead — `ToolSearch`, `DeferExecuteTool` — and a bare
  // identifier there is a name, not a sentence, so it beats the generic "Tool". A descriptive title
  // ("Update todos") still reads as `Tool: "…"`, which is what it is.
  const named = stripCode(title);
  if (kind === 'other' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(named)) return truncateToolName(named);
  if (kind && byKind[kind]) return byKind[kind];
  if (title) return truncateToolName(named);
  return 'tool';
}

// ───────────────────────── utilities ─────────────────────────

/** Runtime side-effect boundary that may read the clock directly. */
function nowMs(): number {
  return Date.now();
}
