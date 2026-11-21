import { RequestError } from '@agentclientprotocol/sdk';
import type {
  CreateElicitationRequest,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentElicitation,
  AgentPermissionRequest,
  ElicitOption,
  ElicitQuestion,
  PermissionAnswer,
  ToolEvent,
} from '../types.js';
import type { AgentStreamHandlers } from './agent.js';
import { TurnFailure } from './agent.js';
import { buildInputPreview, isNonEmptyObject, stripCode, truncateToolName } from './agent-common.js';
import { agyAcpToolLabel, agyMcpCall, agyMcpLabel, type AgyTurnWatch } from './agy-acp.js';
import { readPromptRefusal, readSessionFailure, type SessionFailure } from './session-failure.js';
import { customOptionsOf, liveEffortName, liveModelName } from './agent-acp-options.js';

// ───────────────────────── Update classification helpers ─────────────────────────

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
 * Whether an update can put something on screen, as opposed to reporting a fact the gateway
 * records and displays elsewhere (the topic name, `/context`, the footer, the slash menu).
 *
 * The distinction carries three separate rules — the replay gate, the cancel-wreckage filter and
 * whether a burst has begun — so it is named once rather than spelled out three times.
 */
export function isRenderableUpdate(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'tool_call':
    case 'tool_call_update':
      return true;
    default:
      return false;
  }
}

/**
 * Watch whether a turn shows the person anything. It only decides the fate of an UNNAMED refusal
 * (see failIfRefused): claude-agent-acp sends `lastRefusalExplanation` as an ordinary
 * `agent_message_chunk` before reporting `stopReason: "refusal"`, and that explanation is a
 * perfectly good answer. Text counts only when it is not blank; a tool bubble counts as soon as it
 * opens.
 */
export function trackVisibleOutput(handlers: AgentStreamHandlers): {
  handlers: AgentStreamHandlers;
  sawOutput: () => boolean;
} {
  let seen = false;
  return {
    sawOutput: () => seen,
    handlers: {
      ...handlers,
      onText: (delta) => {
        if (delta.trim() !== '') seen = true;
        handlers.onText(delta);
      },
      onToolStart: (evt) => {
        seen = true;
        handlers.onToolStart(evt);
      },
      ...(handlers.onImage
        ? {
            onImage: (image) => {
              seen = true;
              handlers.onImage?.(image);
            },
          }
        : {}),
    },
  };
}

/**
 * Fail a turn whose prompt ended in `stopReason: "refusal"`. A cause CodeBuddy attached always
 * fails, however much the turn had already streamed — a 429 after a tool call is still a rejected
 * turn. Only an unnamed refusal is spared when something was already visible: that is the model
 * declining, and Claude sends its explanation as ordinary text first. Kept out of `runTurn` so its
 * own branch count stays where lint wants it.
 */
export function failIfRefused(response: PromptResponse, visibleOutput: boolean): void {
  const refusal = readPromptRefusal(response);
  if (!refusal) return;
  if (!refusal.named && visibleOutput) return;
  throw new TurnFailure(refusal.message, refusal.reason);
}

// ───────────────────────── Permission & elicitation translation ─────────────────────────

/**
 * The answer to session/request_permission under a level that does not ask (`auto`, `full`, or
 * none set) — what every agent got before `ask` existed: approve, so agents run with full tool
 * access and the only gate is access.allowFrom (who may trigger the agent at all). Picks
 * allow_once when offered, else any allow_*; if the agent somehow offers no allow option, falls
 * back to cancelled (can't fabricate an id).
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

/** How much of a permission request's change preview reaches the chat. */
const PERMISSION_DETAIL_MAX = 1200;

/** How much of a vendor-supplied tool name a title falls back to. */
const PERMISSION_TOOL_NAME_MAX = 40;

/** A string a harness put in `_meta` under a key whose tail is `suffix` (`…/toolName`, `…/plan`). */
function metaString(meta: unknown, suffix: RegExp): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof value !== 'string' || !suffix.test(key)) continue;
    if (value.trim()) return value;
  }
  return undefined;
}

/**
 * The tool's own name, for a request whose tool call carries no title.
 *
 * CodeBuddy Code 2.181.0 sends every `session/request_permission` with nothing but `rawInput` and
 * `_meta["codebuddy.ai/toolName"]` — measured 2026-11-18 — so a Write arrived as a bare file path
 * with no word saying it was a write. ACP reserves `_meta` for exactly this kind of extension, and
 * the key's `…/toolName` tail is read rather than the vendor prefix, so another adapter naming its
 * tool the same way is covered without a second arm.
 */
function metaToolName(meta: unknown): string | undefined {
  const name = metaString(meta, /(^|\/)toolName$/)?.trim();
  if (!name) return undefined;
  return name.length > PERMISSION_TOOL_NAME_MAX ? `${name.slice(0, PERMISSION_TOOL_NAME_MAX - 1)}…` : name;
}

/**
 * The verb for a request that names no tool and has no `_meta` to name it, read off the tool's own
 * arguments: `file_path` beside the text it will put there is a write, beside `old_string`/
 * `new_string` an edit. A `command` needs no verb — the command IS what the user is deciding on —
 * and a file call with neither (a read, a delete) is left as the bare preview rather than guessed
 * at: calling a read an edit is worse than saying nothing about it.
 */
function inferToolName(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const raw = rawInput as Record<string, unknown>;
  if (typeof raw.file_path !== 'string') return undefined;
  if (typeof raw.content === 'string') return 'Write';
  if (typeof raw.old_string === 'string' || typeof raw.new_string === 'string') return 'Edit';
  return undefined;
}

/** Text split into lines, dropping only the empty line a trailing newline leaves behind. */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** One `diff` content item as lines a chat bubble can show; empty when it carries no lines. */
function diffPreview(path: string, oldText: string | null | undefined, newText: string): string {
  const body: string[] = [];
  for (const line of linesOf(oldText ?? '')) body.push(`-${line}`);
  for (const line of linesOf(newText)) body.push(`+${line}`);
  return body.length ? [`--- ${path}`, `+++ ${path}`, ...body].join('\n') : '';
}

/** A detail bounded to a preview, saying how much it left out rather than dropping it silently. */
function boundedDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= PERMISSION_DETAIL_MAX) return trimmed;
  return `${trimmed.slice(0, PERMISSION_DETAIL_MAX)}\n… (${trimmed.length - PERMISSION_DETAIL_MAX} more characters)`;
}

/**
 * The kinds whose `content` is the tool's OUTPUT (what a file holds, what a command printed), not
 * something the user is approving. A read that asks for permission must not offer the file it is
 * about to read as "the change".
 */
const OUTPUT_KINDS = new Set(['read', 'fetch', 'search', 'execute']);

/** The change a harness carries in the tool's own arguments rather than in ACP `content`. */
function rawInputDetail(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const raw = rawInput as Record<string, unknown>;
  const file = typeof raw.file_path === 'string' ? raw.file_path : undefined;
  if (!file) return undefined;
  const oldText = typeof raw.old_string === 'string' ? raw.old_string : undefined;
  const newText = typeof raw.new_string === 'string' ? raw.new_string : undefined;
  if (oldText !== undefined || newText !== undefined) return diffPreview(file, oldText, newText ?? '');
  return typeof raw.content === 'string' && raw.content.trim() ? raw.content.replace(/\n+$/, '') : undefined;
}

/**
 * What the tool will change, for the card's second block: ACP's `content` (a diff for an edit, the
 * text a write will put in the file), or — for a harness that carries the change in the tool's own
 * arguments instead — `rawInput`'s `old_string`/`new_string` or `content` beside a `file_path`
 * (CodeBuddy Code's Edit and Write, 2026-11-18).
 *
 * A shell call's text content is its `description` ("Clean and rebuild"), not a change, and the
 * command is already the title — so it contributes nothing here. Bounded, because a Write of a
 * whole file is pages long and this is a preview, not the editor.
 */
function permissionDetailOf(toolCall: ToolCallUpdate): string | undefined {
  const parts: string[] = [];
  for (const c of toolCall.content ?? []) {
    if (c.type === 'diff') parts.push(diffPreview(c.path, c.oldText, c.newText));
    else if (c.type === 'content' && c.content.type === 'text' && !OUTPUT_KINDS.has(toolCall.kind ?? '')) {
      parts.push(c.content.text);
    }
  }
  if (parts.length === 0) parts.push(rawInputDetail(toolCall.rawInput) ?? '');
  return boundedDetail(parts.filter(Boolean).join('\n\n'));
}

/**
 * An `ExitPlanMode` request in words: the plan the user is being asked to approve, and the actions
 * the agent wants pre-approved to carry it out.
 *
 * Claude's adapter titles this request "Ready to code?" itself. CodeBuddy Code sends no title and
 * no kind, names the tool in `_meta`, and — measured 2026-11-18 in plan mode — carries the plan
 * under `…/plan`; without this the card read `ExitPlanMode`, or the raw
 * `{"allowedPrompts":…}` JSON, for the one request whose whole subject is a document the user has
 * to read. The shape is what is matched (the tool name, or `allowedPrompts`), not a vendor prefix.
 */
function planExitOf(toolCall: ToolCallUpdate, named: string | undefined): { title: string; detail?: string } | undefined {
  const raw = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? (toolCall.rawInput as Record<string, unknown>) : undefined;
  const prompts = Array.isArray(raw?.allowedPrompts) ? raw.allowedPrompts : [];
  if (named?.toLowerCase() !== 'exitplanmode' && prompts.length === 0) return undefined;
  const asked = prompts
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      const { tool, prompt } = p as { tool?: unknown; prompt?: unknown };
      const what = typeof prompt === 'string' ? prompt.trim() : '';
      const by = typeof tool === 'string' ? tool.trim() : '';
      return what ? (by ? `${by}: ${what}` : what) : '';
    })
    .filter(Boolean)
    .join('\n');
  const detail = boundedDetail([metaString(toolCall._meta, /(^|\/)plan$/)?.trim(), asked].filter(Boolean).join('\n\n'));
  return { title: 'Exit plan mode', ...(detail ? { detail } : {}) };
}

/**
 * A permission request as the user is shown it: what the tool is, what it will change, and the
 * agent's own options.
 *
 * The change matters more than the name: "Edit src/app.ts" alone asks the user to approve an edit
 * they cannot see, which is not a decision. So a diff (or the text a write will put in the file)
 * rides along in `detail`, and the title falls back to the tool's name plus its argument when the
 * harness sends no title at all.
 */
export function permissionRequestOf(req: RequestPermissionRequest): AgentPermissionRequest {
  // agy's generic MCP call is titled `Bash` too, and this card has no preview line for the server,
  // so it is named the way the tool row names it and the server rides in the title.
  const mcp = agyMcpCall(req.toolCall.rawInput);
  const preview = buildInputPreview(req.toolCall.rawInput);
  const named = metaToolName(req.toolCall._meta) ?? inferToolName(req.toolCall.rawInput);
  const plan = planExitOf(req.toolCall, named);
  const title =
    (mcp && `${agyMcpLabel(mcp)} — ${mcp.server}`) ||
    stripCode(req.toolCall.title ?? '') ||
    plan?.title ||
    (named ? (preview ? `${named}: ${preview}` : named) : preview) ||
    'a tool call';
  const detail = plan?.detail ?? permissionDetailOf(req.toolCall);
  return {
    title,
    ...(detail ? { detail } : {}),
    options: req.options.map((o) => ({ optionId: o.optionId, label: o.name || o.optionId })),
  };
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

// ───────────────────────── session/update → handlers translation (core) ─────────────────────────

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
  /** Hand a `current_mode_update` back to the session, for the same reason as onConfigOptions. */
  onModeChanged?(modeId: string): void;
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
  /**
   * agy only: what its text, tools and usage come to, for a harness that writes its own diagnostics
   * into the message stream and measures its context its own way (agy-acp.ts AgyTurnWatch). Its
   * presence also means a `Run <tool>` title names agy's own tool, which labels the bubble
   * (agyAcpToolLabel).
   */
  agy?: AgyTurnWatch;
  /**
   * The turn was stopped (`/stop`) and has not ended: the harness is still producing output for it.
   * While this stands, its tool calls are shown rather than dropped as the cancel's wreckage (see
   * isWreckage), and a call that STARTS now is marked as running after the stop (ToolEvent.afterStop).
   */
  stopped?: boolean;
}

/**
 * One tool's evolving state. In ACP the first tool_call is often pending with title/rawInput not fully
 * streamed, completed by later tool_call_update (the protocol allows update to replace title/kind/
 * rawInput/status). So accumulate the latest known values and defer onToolStart until ready.
 */
interface ToolRec {
  index: number;
  /** The harness's `toolCallId`, carried on both events so the library keeps one row per call. */
  id: string;
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
  /** The bubble's name when the harness's own tool name says more than `kind` (agy's; see TurnState.agy). */
  label?: string;
  /** First seen after the turn was stopped (TurnState.stopped): the harness started it anyway. */
  afterStop?: boolean;
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
  // The agent's own settings, likewise reported empty too. This is how a setting the agent locks
  // mid-conversation (it starts listing only the current value) reaches the strip.
  st.handlers.onOptions?.(customOptionsOf(u.configOptions));
}

export function translateUpdate(u: SessionUpdate, st: TurnState): void {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (u.content.type === 'image') ingestImage(u, st);
      else ingestText(u, st);
      break;

    // A message the person sent mid-turn, as the harness takes it in (agy echoes each one; so does the
    // opening of every turn, before anything is said). What the agent says next answers it, so it
    // starts a segment of its own — run on, agy's "…provide its output.6 × 7 = 42" was one paragraph.
    case 'user_message_chunk':
      breakBeforeNextText(st);
      break;

    // tool_call and tool_call_update are handled identically: merge this tool's latest fields into the
    // ledger, then render based on status / rawInput readiness. Generic across all ACP agents.
    case 'tool_call':
    case 'tool_call_update':
      if (u.toolCallId) ingestTool(st, u.toolCallId, toolFields(u), u._meta);
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
    // times per turn as full snapshots — the consumer keeps the latest. agy's `size` is the model's
    // window, not where it compacts, so its watch picks the window instead (AgyTurnWatch.usage).
    case 'usage_update': {
      ingestUsage(st, u.used, st.agy ? st.agy.usage(u.size) : u.size, u.cost);
      break;
    }

    // The agent's session config changed (model / mode / effort picker, or a setting of its own).
    // The model, the effort and the agent's own settings interest us: re-read all three so a
    // mid-session change to any of them is reflected in the footer and the status strip.
    case 'config_option_update':
      reportConfigOptions(u, st);
      break;

    // The harness moved its own mode (claude, when the person approves leaving plan). Kept by the
    // session for the permission level's next re-apply; nothing is rendered.
    case 'current_mode_update':
      st.onModeChanged?.(u.currentModeId);
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

/** The fields of a tool call (or of an update to one) the ledger keeps. */
function toolFields(u: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>): ToolFields {
  return { title: u.title, kind: u.kind, rawInput: u.rawInput, status: u.status };
}

interface ToolFields {
  title?: string | null;
  kind?: string | null;
  rawInput?: unknown;
  status?: string | null;
}

/**
 * Forward a text chunk into the reply body. Extracted from translateUpdate to keep that switch's
 * complexity within the lint budget.
 */
function ingestText(u: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>, st: TurnState): void {
  const text = u.content.type === 'text' ? u.content.text : undefined;
  if (typeof text !== 'string' || text.length === 0) return;
  // agy's own diagnostic ("⚠ API error (attempt 1) …"), said as a notice rather than as the agent.
  if (st.agy?.text(text)) return;
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
 * Forward a picture in the reply (an ACP `image` block) to be shown in the chat. Nothing is checked
 * here but that there is data: the bytes are decoded and sniffed where they are sent (agent-files.ts),
 * which is the one place that has to trust them.
 *
 * A subagent's picture is kept out for the reason its text is (see ingestText): the reply is the main
 * agent's.
 */
function ingestImage(u: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>, st: TurnState): void {
  if (u.content.type !== 'image') return;
  const { data, mimeType, uri } = u.content;
  if (typeof data !== 'string' || data.length === 0) return;
  if (claudeAttribution(u._meta).parent) {
    console.debug('[acp] not rendering a subagent picture into the reply');
    return;
  }
  const name = typeof uri === 'string' ? lastPathSegment(uri) : undefined;
  st.handlers.onImage?.({ data, mimeType: typeof mimeType === 'string' ? mimeType : '', ...(name ? { name } : {}) });
}

/** The file name at the end of a URI (`file:///tmp/chart.png` → `chart.png`), if it ends in one. */
function lastPathSegment(uri: string): string | undefined {
  let pathname = uri;
  try {
    pathname = new URL(uri).pathname;
  } catch {
    // Not a URL: a bare path, taken as it is.
  }
  const last = pathname.split('/').pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
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
function ingestTool(st: TurnState, id: string, f: ToolFields, meta?: unknown): void {
  let rec = st.toolLedger.get(id);
  if (!rec) {
    rec = { index: st.toolIndexSeq++, id, startAt: nowMs(), started: false, finished: false };
    if (st.stopped) rec.afterStop = true;
    st.toolLedger.set(id, rec);
    st.agy?.tool();
  }
  // Overwrite only with real values (update's title/kind may be null = unchanged).
  if (typeof f.title === 'string') rec.title = f.title;
  if (typeof f.kind === 'string') rec.kind = f.kind;
  if (f.rawInput !== undefined) rec.rawInput = f.rawInput;
  if (st.agy) {
    rec.label = agyAcpToolLabel(rec.title, rec.kind) ?? rec.label;
    // agy's generic MCP call is kind `execute` / title `Bash`; only its input names the server and
    // the tool (agy-acp.ts agyMcpCall). Named here, once, so finishTool draws the same row.
    const mcp = agyMcpCall(rec.rawInput);
    if (mcp) rec.label = agyMcpLabel(mcp);
  }

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
  // agy's `call_mcp_tool` carries the server in its input, not its title; the label names the tool,
  // so the server and the arguments are the preview (see agyMcpCall).
  const mcp = st.agy ? agyMcpCall(rec.rawInput) : undefined;
  return {
    // name uses the short ACP kind (aligns with emojiMap); command/path detail only in the truncated preview.
    name: rec.label ?? toolLabel(rec.kind, rec.title),
    inputPreview:
      (rec.spawns && subagentDescription(rec)) ||
      (mcp && [mcp.server, buildInputPreview(mcp.args)].filter(Boolean).join(' ')) ||
      buildInputPreview(rec.rawInput) ||
      stripCode(rec.title),
    input: rec.rawInput,
    index: rec.index,
    id: rec.id,
    // The spawning call always precedes its subagent's first tool, so its name is known by now.
    agent: rec.parent ? (st.subagents?.get(rec.parent) ?? UNNAMED_SUBAGENT) : undefined,
    ...(rec.afterStop ? { afterStop: true } : {}),
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
    name: rec.label ?? toolLabel(rec.kind, rec.title), // same name as onToolStart, so findLine's index fallback stays consistent
    index: rec.index,
    id: rec.id,
    input: rec.rawInput,
    ok,
    durationMs: nowMs() - rec.startAt,
  });
  // A call that ends after the agent has spoken — a command agy put in the background, finishing
  // while the turn waits for it (agy-plugin.ts) — puts what comes next in a segment of its own: that
  // text answers the result. Run on after the words before it, it read "…report its
  // output.**Background task completed**".
  breakBeforeNextText(st);
}

/**
 * Something happened after the agent spoke that its next words answer: start them in a new segment.
 * Only the next text breaks, so nothing said afterwards means nothing split.
 */
function breakBeforeNextText(st: TurnState): void {
  if (st.lastSegment === 'text') st.lastSegment = 'tool';
}

/**
 * Whether the harness has a tool call open — rendered as started, not yet reported terminal.
 *
 * The silence watchdog's one piece of evidence that a quiet turn is working rather than wedged.
 * Reads the same ledger flushPendingTools closes out, so "open" means exactly what the tool bubbles
 * on screen mean.
 */
export function hasOpenToolCall(st: TurnState): boolean {
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
export function flushPendingTools(st: TurnState, ok = true): void {
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

/** Runtime side-effect boundary that may read the clock directly. */
function nowMs(): number {
  return Date.now();
}
