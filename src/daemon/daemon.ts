import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef, Config, HostDef } from '../config/schema.js';
import { accessUnrestricted, agentDisplayName, findAgent } from '../config/schema.js';
import { configDir, readConfig, readRawConfigIfExists, UNRESTRICTED_WARNING, type ReadConfig } from '../config/load.js';
import { applyConfig, describeReload, diffConfig } from './config-reload.js';
import type { HistoryStore } from '../history/store.js';
import {
  agentCommandSpecs,
  agentForCommand,
  DAEMON_COMMANDS,
  genericCommandSpecs,
  genericNativeNames,
  harnessCommandName,
  routeCommandSpecs,
  routeCommandAgent,
  SLASH_DESC_MAX,
  SLASH_NAME_RE,
  type CommandSurface,
} from '../core/command-translate.js';
import { parseButtonId, PICK_PREFIX, parsePickButtonId } from '../core/button-id.js';
import {
  buildAgentMenu,
  flatAgents,
  parseAgentButtonId,
  type AgentButtonClick,
  type AgentGroup,
} from '../core/agent-menu.js';
import {
  buildEffortMenu,
  effortChoiceText,
  effortMenuExpiredText,
  effortMenuSupersededText,
  parseEffortButtonId,
  type EffortButtonClick,
  type EffortOption,
} from '../core/effort-menu.js';
import {
  buildModelMenu,
  modelChoiceText,
  modelIndexOf,
  modelMenuExpiredText,
  modelMenuSupersededText,
  modelPageOf,
  parseModelButtonId,
  type ModelButtonClick,
  type ModelOption,
} from '../core/model-menu.js';
import {
  buildWorkdirMenu,
  parseWorkdirButtonId,
  workdirChoiceText,
  workdirIndexOf,
  workdirMenuExpiredText,
  workdirMenuSupersededText,
  workdirPageOf,
  type WorkdirButtonClick,
  type WorkdirOption,
} from '../core/workdir-menu.js';
import {
  buildSettingValueMenu,
  buildSettingsMenu,
  modelListAgent,
  parseSettingButtonId,
  settingNotice,
  settingValuePage,
  settingsMenuExpiredText,
  settingsMenuSupersededText,
  type SettingButtonClick,
  type SettingChoice,
  type SettingOption,
  type SettingRow,
  type SettingsScreenInput,
} from '../core/settings.js';
import type {
  ButtonSpec,
  MessageKind,
  PlatformAdapter,
  ReviewPanel,
  SchedulePanel,
  SchedulePanelTask,
} from '../platform/adapter.js';
import { OutboundPacer } from '../core/outbound-pacer.js';
import { splitIntoChunks } from '../core/stream-buffer.js';
import { formatEmptyCatalog, formatSkillCatalog } from '../core/skills-catalog.js';
import { expandRemoteHome, remoteAgentEnv, remoteAgentHome, resolveConversationCwd } from './agent-common.js';
import { knownHostsFileOf, remoteHosts } from './remote-hosts.js';
import { hostsWithConfiguredAgents, refreshPods } from './pods.js';
import { leaveMesh, peerName, readKnownHosts, syncPeers } from './pod-peers.js';
import { addPod, gatewayKeyLine, removePod } from './pod-admin.js';
import { readPods } from '../config/pods.js';
import {
  agentHome,
  opencodeSkillDirs,
  remoteOpencodeSkillDirs,
  scanRemoteSkillDirs,
  scanSkillDirs,
  skillDirsFor,
} from './skills-scan.js';
import { withOutboundPacing } from './paced-adapter.js';
import type {
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  ButtonInteraction,
  CommandInteraction,
  ConversationId,
  EffortSelector,
  ElicitAnswer,
  PermissionAnswer,
  ElicitQuestion,
  InboundMessage,
  MessageRef,
  ModelSelector,
  SettingsScreen,
  SlashCommandSpec,
} from '../types.js';
import {
  addressOf,
  formatAddress,
  type ConversationAddress,
  type ConversationRef,
} from '../core/conversation.js';
import type { AgentFactory } from './agent.js';
import { ConversationRegistry } from './conversation.js';
import type { ConversationStore } from './conversation-store.js';
import type { WorkdirUsageStore } from './workdir-usage.js';
import { resolvePageSize } from '../core/paging.js';
import { IpcServer } from '../ipc/server.js';
import { startSkillSweep } from './skill-lifecycle.js';
import { ReviewService, reviewCandidatesFrom, type ReviewCandidate, type ReviewLane } from './review.js';
import { ReviewStateStore } from './review-state.js';
import { buildReviewPanel } from './review-panel.js';
import { selfInvocation } from './reverse-cli-shim.js';
import {
  archiveSkill,
  createSkill,
  listSkills,
  patchSkill,
  pinSkill,
  removeSkillFile,
  restoreSkill,
  revertSkill,
  showSkill,
  skillHistory,
  writeSkillFile,
  type SkillRecord,
} from './skills-store.js';
import type { IpcAction, VoiceLogResult } from '../ipc/protocol.js';
import {
  DEFAULT_ASK_TIMEOUT_MS as PROTOCOL_DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_ASK_REMINDER_MS,
  DEFAULT_ASK_REMINDER_TEXT,
  DEFAULT_CHANNEL_LIMIT,
} from '../ipc/protocol.js';
import { VoiceIntake } from './voice.js';
import { ScheduleService } from './schedule-service.js';
import { panelTasks } from './schedule-panel.js';
import { buildSkillsPanel } from './skills-panel.js';
import { commandSurface, Delegation } from './delegation.js';
import type { ScheduleStore } from './schedule-store.js';
import { DRAIN_LIMIT_MS, describeInProgress, nothingInProgress, whenIdle, type InProgress } from './restart-drain.js';
import { taskListText } from '../core/schedule.js';
import {
  buildScheduleDeleteConfirm,
  buildScheduleListMenu,
  buildScheduleTaskMenu,
  parseScheduleButtonId,
  scheduleEntryLabel,
  scheduleMenuExpiredText,
  scheduleOpenButtonId,
  type ScheduleMenuAction,
  type ScheduleMenuClick,
} from '../core/schedule-menu.js';

/** Transcripts `talkcode voice-log` lists when no `--limit` is given. */
const DEFAULT_VOICE_LOG_LIMIT = 10;

/**
 * Daemon-level slash commands are defined in core/command-translate.ts (DAEMON_COMMANDS), so
 * registration and `/help` read the same list. All are intercepted in ConversationRegistry.route
 * (see CONTEXT_CLEAR_RE / HELP_RE there) and never reach an agent.
 */

/**
 * Inbound dedup TTL: on "slash-is-a-normal-message" platforms (e.g. Telegram), one `/cmd` fires
 * both a message event and an interaction/command event with the same messageId — dedup by
 * `platform:channelId:messageId` within this window so it routes once. Discord slash interactions
 * use the interaction's own id, never colliding with a message, so they are unaffected.
 */
const DEDUP_TTL_MS = 15_000;

/**
 * How long reading the pods may take (pods.ts). At startup nothing waits on it; on `/reload` the
 * person does, so it is shorter — a host that does not answer in time keeps what it had, and the
 * answer says so.
 */
const STARTUP_POD_TIMEOUT_MS = 60_000;
const RELOAD_POD_TIMEOUT_MS = 20_000;

/**
 * Default timeout for an unclicked ask/clarify button (fallback when action.timeoutMs is absent).
 *
 * Ten minutes, not the two it used to be, because the person being asked is on a phone rather than
 * at the terminal the agent is running in. Two minutes is well inside the time it takes to read a
 * notification, switch apps and think — and the failure was silent (`ask` prints an empty line on
 * timeout, exactly as it does when nothing was chosen), so a question the user answered three
 * minutes later looked to the agent like a broken command. Observed doing precisely that.
 *
 * The ceiling still exists because an unanswered question must not pin an agent turn forever; an
 * agent that knows its question is urgent can shorten it with `--timeout`.
 *
 * The value itself lives in ipc/protocol.ts: the CLI sizes its socket deadline from the same number
 * and the two must not drift apart.
 */
const DEFAULT_ASK_TIMEOUT_MS = PROTOCOL_DEFAULT_ASK_TIMEOUT_MS;

/**
 * The reverse commands answered by the gateway rather than carried out on a chat (see
 * handleGatewayQuery). A `satisfies`-checked table, so a kind that is not an IpcAction fails to
 * compile — and the chat switch's `never` guard catches a new action that belongs in neither.
 */
const GATEWAY_QUERY_KINDS = {
  'voice-log': true,
  'list-channels': true,
  'schedule-add': true,
  'schedule-list': true,
  'schedule-op': true,
  'reload-config': true,
  'pod-list': true,
  'pod-add': true,
  'pod-remove': true,
  skills: true,
} as const satisfies Partial<Record<IpcAction['kind'], true>>;
type GatewayQuery = Extract<IpcAction, { kind: keyof typeof GATEWAY_QUERY_KINDS }>;
const isGatewayQuery = (a: IpcAction): a is GatewayQuery => a.kind in GATEWAY_QUERY_KINDS;

/**
 * The conversation library's three questions (history/store.ts). Split from GATEWAY_QUERY_KINDS
 * only because they share one subject and one handler — keeping the two switches small enough
 * to stay under the project's complexity bound, and giving the library a single place to grow.
 */
const SESSIONS_QUERY_KINDS = {
  'sessions-search': true,
  'sessions-read': true,
  'sessions-list': true,
} as const satisfies Partial<Record<IpcAction['kind'], true>>;
type SessionsQuery = Extract<IpcAction, { kind: keyof typeof SESSIONS_QUERY_KINDS }>;
const isSessionsQuery = (a: IpcAction): a is SessionsQuery => a.kind in SESSIONS_QUERY_KINDS;

/** The sub-agent commands (daemon/delegation.ts), handled before both switches. */
type TaskAction = Extract<IpcAction, { kind: `task-${string}` }>;
const isTaskAction = (a: IpcAction): a is TaskAction => a.kind.startsWith('task-');

/** The verbs `/setting schedule <verb> <id>` accepts, onto the service's operations. */
const SCHEDULE_TYPED_OPS: Record<string, 'pause' | 'resume' | 'remove' | 'run'> = {
  pause: 'pause',
  resume: 'resume',
  delete: 'remove',
  remove: 'remove',
  rm: 'remove',
  run: 'run',
};

/**
 * Max buttons in a harness-command menu. Discord allows 25 components per message (5 rows × 5);
 * commands beyond this are listed as text instead of dropped. The `claude` harness reports ~39,
 * so this cap is reached in practice, not hypothetically.
 */
const PICKER_BUTTON_MAX = 25;

/** ask button custom_id prefix. Format `ask:<reqId>:<index>` (must not start with `input`). */
const ASK_PREFIX = 'ask:';

/**
 * Longest typed answer echoed back onto the question message; longer ones are elided there.
 *
 * The echo is a receipt ("this is what I recorded for that question"), not a transcript — the
 * user's own message is still in the chat right above it. A pasted stack trace answered into a
 * question would otherwise be repeated in full inside the bubble.
 */
const ASK_ECHO_MAX = 300;

export { parsePickButtonId };

/**
 * Parse a `<prefix><reqId>:<index>` button custom_id (pure, testable). Returns null when the
 * prefix does not match or the shape is invalid. Shared by the ask and picker buttons so both
 * accept exactly the same id grammar — which now lives in core/button-id.ts, because the model
 * menu builds its ids there and this file only parses them.
 */
function parsePrefixedButtonId(
  buttonId: string,
  prefix: string
): { reqId: string; index: number } | null {
  const parsed = parseButtonId(buttonId, prefix);
  return parsed && { reqId: parsed.reqId, index: parsed.n };
}

/**
 * Parse an ask button custom_id (pure, testable). Recognizes only `ask:<reqId>:<index>`;
 * anything else returns null.
 */
export function parseAskButtonId(
  buttonId: string
): { reqId: string; index: number } | null {
  return parsePrefixedButtonId(buttonId, ASK_PREFIX);
}

/**
 * Map AgentCommand → SlashCommandSpec (pure, testable). Returns null on invalid name (caller skips).
 * Commands with a hint carry one optional string param `input` (ACP command input is unstructured text).
 */
export function agentCommandToSpec(cmd: AgentCommand): SlashCommandSpec | null {
  if (!SLASH_NAME_RE.test(cmd.name)) return null;
  const description = (cmd.description || cmd.name).slice(0, SLASH_DESC_MAX);
  const spec: SlashCommandSpec = { name: cmd.name, description };
  if (cmd.hint) {
    spec.options = [
      { name: 'input', description: cmd.hint.slice(0, SLASH_DESC_MAX), type: 'string', required: false },
    ];
  }
  return spec;
}

/**
 * The complete set of slash commands this deployment registers (pure, testable).
 *
 * ONE menu, shared by every agent. It is derived from config alone and computed once at startup;
 * what agents report over ACP does not feed it (that goes to `agentCommands`, which serves only the
 * harness pickers — see onAgentCommands). So a harness's command list can arrive as often as it
 * likes without the menu moving.
 *
 * A menu entry the bound harness has no equivalent for is answered with an explicit "not supported"
 * and no turn — see translateCommand in core/command-translate.ts. That refusal is what lets one
 * menu cover agents with different vocabularies.
 *
 * Why not the union of what agents report: native slash is global (Telegram setMyCommands is
 * per-bot, Discord per-application) while agents are per-session, so a union menu could say neither
 * who owned an entry nor where to send it — an agent-specific command invoked from it fell through
 * to `routing.default`, running opencode's `customize-opencode` on the claude agent. It also had no
 * stable content, since whichever harness last built a session overwrote it.
 *
 * Four layers, in registration order:
 *  - daemon commands (/new, /clear, /help) — intercepted before any agent
 *  - the generic vocabulary — translated per harness at invocation (core/command-translate.ts)
 *  - one agent command per configured harness (/cc, /oc, /agy) — switches the conversation, and
 *    bare is the escape hatch to that agent's own commands, which are not registered globally
 *  - the names `routing.pipeline` gives particular agents (`when: { command: oc2 }`) — the same
 *    thing as an agent command, for an agent the harness table cannot name (a second opencode)
 *
 * `surface` is the one thing a platform changes: a generic command that needs topics nested under
 * one another (`/super`) is registered only where they can be (see CommandSurface). Omitted, the
 * set is the whole vocabulary — what a reload compares to tell whether anything changed.
 */
export function buildRegisteredSpecs(cfg: Pick<Config, 'agents' | 'routing'>, surface?: CommandSurface): SlashCommandSpec[] {
  const specs = [...DAEMON_COMMANDS, ...genericCommandSpecs(surface), ...agentCommandSpecs(cfg), ...routeCommandSpecs(cfg)];
  // Dedup defensively: a harness named like a generic command (or a future daemon command) must not
  // register twice — Telegram rejects the whole setMyCommands batch on a duplicate name.
  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/**
 * The message body posted above one elicitation round's buttons (pure, testable).
 *
 * Two things a button row cannot carry, so they go here:
 *  - the option rationales, which are often the most useful part of the question ("you already
 *    run pgvector here, so reusing it costs nothing") and are why asking with buttons beats
 *    asking in prose;
 *  - a position marker, so a multi-question form reads as 2-of-3 rather than as three unrelated
 *    questions arriving in a row.
 *
 * Options with no rationale contribute no line at all, rather than a label followed by an empty
 * dash — a form where none of them has one then renders as a bare question, which is right.
 *
 * `note` is for something about the QUESTION that outlives the answer (today: that this platform
 * cannot collect the several answers it asked for). The live "tap Done when you're finished"
 * affordance is deliberately NOT here — it belongs to the buttons and has to disappear with them,
 * so askButtons appends it and retireAsk drops it.
 */
export function composeElicitPrompt(
  q: ElicitQuestion,
  index: number,
  total: number,
  note?: string
): string {
  const heading = total > 1 ? `(${index + 1}/${total}) ${q.prompt}` : q.prompt;
  const detail = q.options
    .filter((o) => o.description)
    .map((o) => `**${o.label}** — ${o.description}`)
    .join('\n');
  const body = detail ? `${heading}\n\n${detail}` : heading;
  return note ? `${body}\n\n${note}` : body;
}

/** How much of a tool call's title a permission bubble shows; a heredoc can run to pages. */
const PERMISSION_TITLE_MAX = 600;

/**
 * The bubble a `permissions: ask` request is posted as: what the agent wants to run, in a code
 * block because it usually is code (a shell command, a path), and what happens if nobody answers —
 * said up front, since the answer decides whether the turn can go on.
 */
export function composePermissionPrompt(title: string, timeoutMs: number): string {
  const shown = title.length > PERMISSION_TITLE_MAX ? `${title.slice(0, PERMISSION_TITLE_MAX)}…` : title;
  const minutes = Math.round(timeoutMs / 60_000);
  return `🔐 The agent asks to run:\n\`\`\`\n${shown}\n\`\`\`\nNo answer within ${minutes} min declines it.`;
}

/**
 * Affordance line under a live multi-select question.
 *
 * Buttons do not say how many of them you may press, and every other question in this system is
 * answered by the first tap — so without this the ticks read as a bug ("I pressed it and nothing
 * happened") rather than as a selection.
 */
const MULTI_HINT = '_Tap to select as many as apply, then tap Done._';

/** Shown when Done is pressed with nothing ticked: a silent no-op reads as the bot ignoring you. */
const MULTI_EMPTY_NOTE = '_Nothing selected yet — tick at least one option, or type your own answer._';

/**
 * What a multi-select question says where its buttons cannot be redrawn in place (LINE, QQ).
 *
 * The tick lives in the button label, so a platform without editButtons could offer a multi-select
 * that never visibly changes. It gets the ordinary one-tap question instead, plus this — because
 * typing genuinely does work here: a typed answer travels under the question's own free-text field
 * and the harness prefers it over the enum, so several answers in one sentence arrive intact.
 */
const MULTI_DEGRADED_NOTE =
  '_This question takes more than one answer, which this platform cannot offer as buttons — tap the most important one, or type them all as a reply._';

/**
 * Whether a question that wants several answers can actually collect them here.
 *
 * One predicate, two readers (the note above and the buttons themselves), because a round that
 * degrades silently is exactly the failure this is meant to avoid.
 */
function canMultiSelect(platform: PlatformAdapter, q: ElicitQuestion): boolean {
  return q.multi && platform.capabilities.editButtons;
}

/**
 * The buttons of one posted question (pure, testable).
 *
 * Single-select (`selected` absent): one button per option, and the first tap is the answer.
 *
 * Multi-select: the same buttons, each prefixed with its own checkbox, plus a Done button sitting
 * at index `labels.length` — one past the options, which is what lets the click handler tell "end
 * the round" from "toggle option n" without a second id grammar. The tick has to live in the
 * LABEL because no platform here exposes a pressed/selected style the daemon can drive, and the
 * only way to repaint a posted button at all is to replace the whole row (editButtons).
 */
export function buildAskButtons(
  reqId: string,
  labels: string[],
  selected?: ReadonlySet<number>
): ButtonSpec[] {
  const buttons: ButtonSpec[] = labels.map((label, i) => ({
    // custom_id: `ask:` prefix + index (≤100 chars; must not start with `input`).
    id: `${ASK_PREFIX}${reqId}:${i}`,
    label: selected ? `${selected.has(i) ? '☑' : '☐'} ${label}` : label,
  }));
  if (selected) {
    buttons.push({
      id: `${ASK_PREFIX}${reqId}:${labels.length}`,
      label: selected.size > 0 ? `✅ Done (${selected.size})` : '✅ Done',
      style: 'primary',
    });
  }
  return buttons;
}


/**
 * What a pending question resolved to.
 *
 * Two shapes, because the answer travels back differently: tapped options carry the labels the
 * buttons were drawn with (mapped to the options' own `value`s before they reach the agent), while
 * a typed answer is whatever the user wrote and goes back through the question's free-text field.
 * Collapsing them into a bare string is what would let a typed answer be mistaken for an option
 * the agent listed.
 *
 * `labels` is a list rather than one string because a multi-select round resolves with everything
 * that was ticked; a single-select round always carries exactly one, and neither is ever empty.
 */
export type AskOutcome =
  | { kind: 'option'; labels: string[] }
  | { kind: 'text'; text: string }
  /**
   * Nobody answered in time. Apart from null (called off) because a permission request has to
   * tell the agent which of the two happened; the other callers read both as "no answer".
   */
  | { kind: 'timeout' };

/**
 * What happened to a conversation while the next round of its form was still being posted.
 *
 * See Daemon.elicitGaps for why this window exists and what is held in it.
 */
interface ElicitGap {
  /** Whether every question in this form declared a free-text field (so a typed answer has a home). */
  acceptsText: boolean;
  /** An answer typed in the gap, handed to the next question the instant it registers. */
  parked?: string;
  /** Why the form was called off in the gap; shown on the next question, which is retired at birth. */
  cancelled?: string;
}

/** A pending ask request (IPC response blocked, awaiting a button click, a typed reply, or timeout). */
interface PendingAsk {
  resolve: (outcome: AskOutcome | null) => void;
  timer: NodeJS.Timeout;
  reminderTimer?: NodeJS.Timeout;
  ref: MessageRef;
  labels: string[];
  prompt: string;
  /** Adapter the ask was sent on (button edits on click/timeout must go back to the same instance). */
  adapter: PlatformAdapter;
  /**
   * Whether a message typed into the chat can answer this question instead of a tap.
   *
   * False only for an elicitation whose form declared no free-text field (see
   * ElicitQuestion.customKey): there is nowhere to put the words, so a typed message keeps its old
   * meaning — it interrupts the turn — rather than being swallowed by a question that cannot
   * carry it.
   */
  acceptsText: boolean;
  /**
   * Session that issued this ask (eviction-guard anchor, and what a typed reply is matched
   * against). May be undefined when the sessionId can't be resolved (token expired / test stub):
   * the guard then doesn't apply to this ask, matching legacy behavior when no hook is injected —
   * never locks a session on resolve failure. Such an ask is also unreachable by typed reply,
   * since there is no conversation to attribute one to.
   */
  conversationId?: ConversationId;
  /**
   * Ticked option indices — present only on a multi-select round, absent on every other question.
   *
   * Its presence is also what makes a tap toggle instead of answer, so the two kinds of question
   * cannot be confused at click time. Mutated in place as taps arrive; read once, on Done.
   */
  selected?: Set<number>;
}

/**
 * A posted harness-command menu, awaiting a click.
 *
 * `names` holds the real command names because the button id cannot: Telegram caps callback_data
 * at 64 bytes and encodeCallbackData degrades to a lossy hash above it, so a name encoded into the
 * id would not survive the round trip. The id carries only an index into this list.
 *
 * `conversation` is the conversation the menu was opened for. The click is delivered straight back
 * to it — re-routing a bare `/init` would resolve against the pipeline instead of the conversation's
 * bound agent, landing on whichever agent config prefers rather than the one that offered the menu.
 */
interface PendingPick {
  conversationId: ConversationId;
  /** Native command names, positionally matching the button indices. */
  names: string[];
  /** Where the menu was posted (origin of the click's synthesized message). */
  conversation: ConversationRef;
  /**
   * The menu message itself, captured from the send.
   *
   * The click ack edits THIS, never the click event's messageId: a platform is free to report
   * something other than the message on a click (Telegram reports the callback_query id), and the
   * ask path has always used its own captured ref for the same reason.
   */
  ref?: MessageRef;
}

/**
 * A posted model menu, awaiting clicks — plural, unlike every other menu here.
 *
 * `options` is a FROZEN snapshot taken when the menu was opened, and a pick id carries an index
 * into it. Re-snapshotting on a page turn would let an index printed on an earlier page point at a
 * different model in a rebuilt list, and re-validating the value could not catch it because the
 * wrong value would still be a valid one. So: freeze here, and re-check the resolved VALUE against
 * the live selector at click time (ConversationRegistry.applyModelChoice does).
 *
 * There is no page cursor. The page a button targets is absolute and lives in its id, so a failed
 * edit cannot leave the daemon's idea of the current page disagreeing with what is on screen.
 */
interface PendingModelMenu {
  conversationId: ConversationId;
  /** The agent that offered this list; a rebind since then invalidates the menu. */
  agentId: string;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The option list as it stood when the menu opened. Indices in button ids point into THIS. */
  options: ModelOption[];
  /** The model marked ● when the menu was drawn. Display only; never used to decide a switch. */
  current?: string;
  /**
   * Items per page, resolved from the posting platform's capabilities when the menu opened.
   *
   * Frozen alongside the options, and for the same reason: a click arrives later, and re-deriving
   * the size then would compute page boundaries the message on screen was never drawn with — so
   * `Next ▶` would skip or repeat entries. It also means a config reload cannot resize a menu that
   * is already up.
   */
  pageSize: number;
  /** The menu message itself, captured from the send — page turns and the ack both edit it. */
  ref?: MessageRef;
}

/**
 * A posted effort menu, awaiting a click.
 *
 * PendingModelMenu minus the page size: the frozen snapshot, the rebind check and the value
 * re-validated at click time are all kept for the model menu's reasons, and the effort list is one
 * page by construction (effortMenuSurface falls back to text otherwise), so nothing is paged.
 */
interface PendingEffortMenu {
  conversationId: ConversationId;
  /** The agent that offered these levels; a rebind since then invalidates the menu. */
  agentId: string;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The levels as they stood when the menu opened. Indices in button ids point into THIS. */
  options: EffortOption[];
  /** The level marked ● when the menu was drawn. Display only; never used to decide a switch. */
  current?: string;
  /** The menu message itself, captured from the send — the ack edits it. */
  ref?: MessageRef;
}

/**
 * A posted settings menu, awaiting clicks.
 *
 * Two levels in one message: `rows` is the list, `open` is the setting whose values are on screen
 * right now (absent = the list is). Both lists are FROZEN snapshots that button indices point into,
 * for the reason PendingModelMenu records — an index printed on one screen must not resolve against
 * a rebuilt list. Identity comes from the snapshot; the VALUE shown is re-read from the live config
 * every time the menu is redrawn, so a change made from the other surface is never stale here.
 *
 * Not one-shot, and not retired after a successful write: changing two settings in a row is the
 * normal case, so a pick returns to the list with the new value visible on it. Bounded, like the
 * model menus, by "at most one per conversation" rather than by a TTL — expiry should be caused by
 * something the user did.
 */
/**
 * The line a redrawn settings menu carries above itself: what the last tap did. A chat app reads it
 * as the first paragraph of the text; a screen gets it as a banner with its tone.
 */
type SettingsAck = { tone: 'ok' | 'info' | 'error'; text: string };

/** A click that no longer matches the menu it landed on. */
function expiredAck(): SettingsAck {
  return { tone: 'error', text: settingsMenuExpiredText() };
}

interface PendingSettingsMenu {
  conversationId: ConversationId;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The settings list as it stood when the menu opened; a `stg:` index points into THIS. */
  rows: SettingRow[];
  /** The open setting, with the frozen option list its `stv:` indices point into. */
  open?: { row: SettingRow; options: SettingOption[]; hint?: string };
  /**
   * What each `sts:` id on the list screen writes (core/settings.ts SettingChoice), from the last
   * time the list was drawn. Only a platform that draws a screen has any.
   */
  choices?: SettingChoice[];
  /** Items per page on the value level; frozen for the reason PendingModelMenu.pageSize records. */
  pageSize: number;
  /** The menu message itself, captured from the send — every level change edits it. */
  ref?: MessageRef;
}

/**
 * A posted scheduled-task menu (core/schedule-menu.ts), awaiting clicks. Usually the settings menu's
 * own message, edited in place: the entry button hands the message over from one map to the other,
 * and "◀ Settings" hands it back.
 */
interface PendingScheduleMenu {
  conversationId: ConversationId;
  conversation: ConversationRef;
  ref?: MessageRef;
  /** Task ids as the list last showed them; an `sct:` index points into THIS. */
  ids: string[];
  /** The task on screen, and whether its delete is awaiting the second tap. */
  open?: { id: string; confirm: boolean };
  /** Carried so "◀ Settings" can rebuild the settings menu on this message. */
  pageSize: number;
}

/**
 * A posted directory menu, awaiting clicks.
 *
 * Shaped like PendingModelMenu and for the same reasons — a frozen option snapshot that pick
 * indices point into, no page cursor (the target page lives in the button id), and the resolved
 * value re-checked at click time rather than the index trusted.
 *
 * It differs in what a click COSTS, which is why the two are not one type: applying a model is a
 * live call on the running session, while applying a directory ends that session. So this menu is
 * retired on any successful pick — including `unchanged`, where nothing happened and the menu has
 * simply been answered — rather than left up for a second choice.
 */
interface PendingWorkdirMenu {
  conversationId: ConversationId;
  /** The agent whose root was scanned; a rebind since then invalidates the list (see applyWorkdirChoice). */
  agentId: string;
  /** Where the menu was posted (the ack and any error go back here). */
  conversation: ConversationRef;
  /** The directory list as it stood when the menu opened. Indices in button ids point into THIS. */
  options: WorkdirOption[];
  /** The directory marked ● when the menu was drawn. Display only. */
  current: string;
  /** Items per page; frozen for the reason PendingModelMenu.pageSize records. */
  pageSize: number;
  /** The menu message itself, captured from the send — page turns and the ack both edit it. */
  ref?: MessageRef;
}

/** An `/agent` menu on screen (see onAgentMenuRequest). */
interface PendingAgentMenu {
  conversationId: ConversationId;
  conversation: ConversationRef;
  /** The groups as they stood when the menu opened; a pick's index points into their flat list. */
  groups: AgentGroup[];
  current: string | undefined;
  pageSize: number;
  ref?: MessageRef;
}

/** Main daemon: wires platform, session registry, and IPC server together. `talkcode start` constructs and run()s it. */
export class Daemon {
  private registry: ConversationRegistry;
  private ipc: IpcServer;
  /** Pending ask requests: reqId → wait handle. Resolved and deleted on click, typed reply or timeout. */
  private pendingAsks = new Map<string, PendingAsk>();
  /**
   * Conversations inside a multi-round elicitation, and the answer that landed in the gap.
   *
   * The gap is real: between two rounds the previous question has already resolved and the next one
   * is still being posted, so for one network round trip the conversation has nothing pending. A
   * message arriving exactly then would fall through to the merger and interrupt the very turn the
   * form belongs to — the bug this whole path exists to fix, reappearing in a window of a few
   * hundred milliseconds. So it is parked here and handed to the next round the moment it registers.
   *
   * `acceptsText` is decided for the WHOLE form (every question declaring a free-text field) rather
   * than per round, because in the gap the next question is not yet known — parking on a form whose
   * next question cannot carry words would consume a message with nowhere to put it. `cancelled`
   * holds a `/stop` that landed in the same window, for the same reason in reverse: there was no
   * question on screen to call off yet.
   */
  private elicitGaps = new Map<ConversationId, ElicitGap>();
  /**
   * Latest command list reported per AGENT (not per session): the set is a property of the harness
   * and its config, so every session of one agent reports the same list. Feeds the harness pickers;
   * no longer drives registration, which is now fixed at startup (see buildRegisteredSpecs).
   */
  private agentCommands = new Map<string, AgentCommand[]>();
  /** Pending harness-picker menus: reqId → the session and command names it was built for. */
  private pendingPicks = new Map<string, PendingPick>();
  /**
   * Live model menus: reqId → the conversation and option snapshot it was built for.
   *
   * Held to the invariant "at most one per conversation": opening a menu retires whichever one that
   * conversation already had. That is what bounds this map — by live conversations, which
   * access.allowFrom already bounds — with no TTL and no LRU. Both were considered and rejected:
   * a TTL expires a menu that is still on screen because a clock ran out while the user read it,
   * and an LRU lets one user's traffic kill another's open menu. Expiry should be caused by
   * something the user did.
   *
   * Unlike pendingPicks these are NOT one-shot — paging is the point. A successful pick deletes the
   * entry; a failed one keeps it, so a retry is one tap rather than retyping /model.
   */
  private pendingModelMenus = new Map<string, PendingModelMenu>();
  /** Live effort menus, bounded the same way: at most one per conversation (see pendingModelMenus). */
  private pendingEffortMenus = new Map<string, PendingEffortMenu>();
  /** Live settings menus: reqId → the conversation, row snapshot and open level it was built for. */
  private pendingSettingsMenus = new Map<string, PendingSettingsMenu>();
  /** Scheduled-task menus, by reqId (often a settings menu's own, handed over — see PendingScheduleMenu). */
  private pendingScheduleMenus = new Map<string, PendingScheduleMenu>();
  /**
   * Live directory menus: reqId → the conversation and directory snapshot it was built for.
   *
   * Same "at most one per conversation" bound as the model menus, and the same reasoning about why
   * that is the right bound rather than a TTL or an LRU (see pendingModelMenus).
   */
  private pendingWorkdirMenus = new Map<string, PendingWorkdirMenu>();
  /** Live `/agent` menus, by reqId; one per conversation (a new one retires the old). */
  private pendingAgentMenus = new Map<string, PendingAgentMenu>();
  /** Instances whose "slash must be registered out-of-band" skip notice was printed (log once each). */
  private skipRuntimeRegisterLogged = new Set<string>();
  /** Inbound dedup: `platform:channelId:messageId` → timestamp (see DEDUP_TTL_MS). */
  private recentRouted = new Map<string, number>();
  /** Graceful stop runs once: signals may repeat (e.g. double Ctrl-C); guards stop() reentry. */
  private stopping = false;
  /** The daily managed-skill sweep, cleared on stop. */
  private skillSweepStop: (() => void) | undefined;
  /** Cancel handle for installed signal handlers (removed on stop to avoid leak + test cross-talk). */
  private signalCleanup: (() => void) | null = null;
  /** Set while a SIGTERM waits for the work in progress (beginDrain); cancels that wait. */
  private drainCancel: (() => void) | null = null;
  private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /**
   * Scratch slot for the session owning the current reverse command (written by resolveChannel,
   * read by handleReverse). Only ask needs the sessionId anchor, but IPC's handle(action, channelId)
   * signature omits it (we don't touch ipc/). Safe because within IpcServer.dispatch there is no
   * await between resolveChannel (sync) and handle(...); handleReverse runs synchronously up to its
   * first await, and handleAsk reads this value before its first await (sendButtons) — so within one
   * dispatch it can't be clobbered by another connection (Node single-threaded, no interleaving).
   */
  private lastResolvedConversationId: ConversationId | undefined;
  /**
   * The platform instance a qualified `--channel <instance>:<address>` named, for the command being
   * dispatched right now — undefined when the value was unqualified or absent. Same scratch-slot
   * contract as lastResolvedConversationId, and written beside it: the IPC handler signature carries
   * an address, and an address alone cannot say which platform it is on.
   */
  private lastResolvedPlatform: string | undefined;

  /**
   * Platform adapters keyed by instance id (one daemon drives all configured instances), each
   * wrapped in the shared outbound pacer.
   *
   * Wrapped HERE, once, rather than at the call sites: `ConversationRegistry`, `TurnRunner` and
   * `handleReverse` all read this map, so one wrap puts the reply, the tool bubbles, the reactions,
   * the menus and the agent's own reverse commands on the single per-chat budget the platform
   * actually enforces. Adapters given to the constructor are not mutated; this is a new map.
   */
  private readonly platforms: Map<string, PlatformAdapter>;

  /** The budget itself. Held so `stop()` can drain what is still queued. */
  private readonly pacer: OutboundPacer;

  /** Voice messages → confirmed text (see daemon/voice.ts). Inert when config has no `voice:`. */
  private readonly voice: VoiceIntake;

  /** Scheduled tasks (see daemon/schedule-service.ts). Absent when started without a task store. */
  private readonly schedules?: ScheduleService;

  /**
   * Automatic review of quiet conversations (daemon/review.ts). Present whenever the library is:
   * the sweep itself is a no-op until `review.agent` names a reviewer, so a `/reload` that adds or
   * removes one needs no re-wiring.
   */
  private readonly reviews?: ReviewService;

  /**
   * The review sweep's store (`reviews.json`). It is constructed here because `configDir()` is
   * only known here; the service holds it from then on, and the sweep is its only reader and
   * writer now that the Reviews tab no longer shows a counter.
   */
  private readonly reviewState?: ReviewStateStore;

  /** The IPC socket, which an agent on a remote host reaches through remoteHosts' CLI bridge. */
  private readonly socketPath: string;
  /** The last read of the pods, so the next one waits for it (refreshPods). */
  private podsRead: Promise<unknown> = Promise.resolve();
  /** How each host's last read went, for `talkcode pods`: when, and why it kept its old entry. */
  private readonly podReads = new Map<string, { at: Date; note?: string }>();

  /** Sub-agents: the task commands, their confirmation cards, and the updates (daemon/delegation.ts). */
  private readonly delegation: Delegation;

  constructor(
    private readonly config: Config,
    platforms: Map<string, PlatformAdapter>,
    agents: AgentFactory,
    socketPath: string,
    /** Persistent conversation state (agent binding + each agent's own session id). */
    private readonly store?: ConversationStore,
    /** `/cd` usage history, used to order the directory menu. Absent = alphabetical. */
    workdirUsage?: WorkdirUsageStore,
    /**
     * Scheduled tasks: the task file, and the directory bash runs log into. Optional so the many
     * tests that build a daemon for something else need not; `start` always passes it.
     */
    schedules?: { store: ScheduleStore; runsDir: string },
    /**
     * The conversation library (`<configDir>/history.db`): the `talkcode sessions` commands read
     * it, and the registry writes every turn into it. Optional so a test daemon need not open a
     * file; absent means the command answers that there is no library.
     */
    private readonly history?: HistoryStore
  ) {
    // Real runtime clock; core classes never read the system clock directly (for testability).
    const clock = {
      now: () => Date.now(),
      schedule: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };
    this.clock = clock;
    this.pacer = new OutboundPacer(config.outbound, clock);
    this.platforms = new Map(
      [...platforms].map(([id, adapter]) => [id, withOutboundPacing(adapter, this.pacer)])
    );

    // Built on the PACED adapters, so a transcript card waits its turn on the chat's budget like
    // every other write. A confirmed transcript re-enters the registry as a typed message, marked so
    // it is neither transcribed again nor treated as a correction of the other transcripts waiting.
    this.voice = new VoiceIntake(config, {
      platforms: this.platforms,
      deliver: (msg) => this.registry.route(msg, { transcript: true }),
      clock,
    });

    this.registry = new ConversationRegistry(config, this.platforms, agents, clock, {
      // A conversation's agent reported its command list → record it under that AGENT (feeds pickers).
      onAvailableCommands: (_id, agentId, cmds) => this.onAgentCommands(agentId, cmds),
      // A harness picker (/claude, /opencode) was invoked in a conversation of that harness.
      onPickerRequest: (id, agentId, msg) => this.onPickerRequest(id, agentId, msg),
      onSkillsRequest: (id, agentId, msg) => this.onSkillsRequest(id, agentId, msg),
      // The agent stopped mid-turn to ask the user something (ACP elicitation) → buttons.
      onElicitRequest: (id, platform, address, request) =>
        this.onElicitRequest(id, platform, address, request),
      // An agent configured `permissions: ask` wants to run a tool → buttons, same lane.
      onPermissionRequest: (id, platform, address, request) =>
        this.onPermissionRequest(id, platform, address, request),
      // Idle reclaim asks before stopping a child: a pending `ask` is the daemon holding work for a
      // conversation from OUTSIDE any turn, so the merger looks idle while a CLI process sits
      // blocked on a button nobody has pressed yet. (This is the guard PendingAsk.conversationId is
      // recorded for.)
      hasPendingWork: (id) => {
        for (const pending of this.pendingAsks.values()) {
          if (pending.conversationId === id) return true;
        }
        return false;
      },
      // A message typed while a question is on screen answers the question instead of going to the
      // agent as a new message (the turn it would join is the one blocked on the question).
      answerPendingAsk: (id, text) => this.answerPendingAskWithText(id, text),
      // `/stop` and `/new` abandon whatever is still being asked here, so nothing is left pinned,
      // clickable, or able to swallow the next message.
      cancelPendingAsks: (id, reason) => this.cancelPendingAsks(id, reason),
      // A message that reaches the agent here replaces a sub-agent card still waiting for a tap: the
      // person writing is how they change the proposal, and the agent proposes again from scratch.
      supersedeProposals: (id) => this.delegation.personSpoke(id),
      // `/setting delegation` moved to another tier: what the delegation remembered about agents
      // already confirmed in a conversation no longer counts, even if the tier changes back later.
      onDelegationSettingChanged: () => this.delegation.forgetConfirmations(),
      // A bare `/model` on a platform that can carry (and later edit) buttons.
      onModelMenuRequest: (id, agentId, msg, selector) =>
        this.onModelMenuRequest(id, agentId, msg, selector),
      // A bare `/effort`, same conditions.
      onEffortMenuRequest: (id, agentId, msg, selector) =>
        this.onEffortMenuRequest(id, agentId, msg, selector),
      // A person set this topic's model with `/model`. If it is a daily task's topic, the task
      // records it so a restart does not let the timer put its own model back.
      onModelSet: (id) => this.schedules?.notePersonModel(id),
      // A `/setting` on a platform that can carry (and later edit) buttons.
      onSettingMenuRequest: (id, msg, menu) => this.onSettingMenuRequest(id, msg, menu),
      // `/reload`: the same entry `talkcode reload` uses, answered with the same sentence.
      onReloadRequest: async () => (await this.reloadAll()).summary,
      // `/setting schedule …` — the tasks live here, not in the registry.
      onScheduleSetting: (id, msg, args, canMenu) => this.onScheduleSetting(id, msg, args, canMenu),
      scheduleSummary: () =>
        this.schedules ? `⏰ \`/setting schedule\` — ${this.schedules.tasks().length} scheduled task(s)` : undefined,
      // A directory menu is wanted: `/cd`, a bare agent command in a conversation with no history,
      // a `/new` that just cleared one, or an `/agent` pick before the first turn.
      onWorkdirMenuRequest: (id, agentId, conv, menu) =>
        this.onWorkdirMenuRequest(id, agentId, conv, menu),
      onAgentMenuRequest: (id, msg, menu) => this.onAgentMenuRequest(id, msg, menu),
      // A voice message is transcribed and confirmed before it becomes a prompt; typing drops a
      // transcript still waiting, and /stop and /new call them off.
      takeVoice: (id, msg) => this.voice.take(id, msg),
      supersedeVoice: (id) => this.voice.supersede(id),
      cancelPendingVoice: (id, reason) => this.voice.cancel(id, reason),
      // What a turn left for the person (and a question asked, see askButtons): in a sub-agent's
      // topic, the agent that opened it is told.
      onNeedsPerson: (id) => this.delegation.childChanged(id),
      // What the person wrote in a turn there goes with it: the agent that opened the topic is told.
      onPersonWords: (id, words) => this.delegation.personWrote(id, words),
      // `/stop` in a topic that opened sub-agents stops them too.
      stopSubAgents: (id) => this.delegation.stopOpened(id),
    }, store, workdirUsage, undefined, history);
    this.delegation = new Delegation({
      config,
      platforms: this.platforms,
      registry: this.registry,
      clock,
      history: this.history,
      // The same live context `sessions read --turn done` is answered with: the binding now and the
      // generation `/new`/`/cd` last set, which the library cannot infer from its own rows.
      currentContext: (id) => {
        const agent = this.store?.boundAgent(id);
        if (!agent) return undefined;
        return { agent, generation: this.store?.conversationGeneration(id) ?? 0 };
      },
      questionOf: (id) => this.questionOf(id),
      // Buttons only, like a permission request: a sentence typed instead ("use cx for the second")
      // is the person's next message to the agent, which proposes again — not a guess at a button.
      confirm: async ({ adapter, address, conversation, text, labels, timeoutMs, signal }) => {
        const outcome = await this.askButtons(adapter, address, text, labels, timeoutMs, conversation, {
          acceptsText: false,
          timeoutNote: '(expired — nothing was started)',
          signal,
          kind: 'dispatch',
        });
        return outcome?.kind === 'option' ? (outcome.labels[0] ?? null) : null;
      },
    });
    if (schedules) {
      // On the PACED adapters, like everything else: a scheduled run's notice and output wait their
      // turn on the chat's write budget.
      this.schedules = new ScheduleService(config, this.platforms, this.registry, clock, schedules.store, schedules.runsDir);
    }
    if (history) {
      // Constructed even when `review:` is absent: the sweep is what checks that, so a `/reload`
      // that adds or removes the reviewer takes effect without restarting the daemon.
      this.reviewState = new ReviewStateStore(path.join(configDir(), 'reviews.json'));
      this.reviews = new ReviewService({
        config,
        history,
        state: this.reviewState,
        clock,
        candidates: () => this.reviewCandidates(),
        notify: (lane, text) => this.notifyReview(lane, text),
      });
    }
    // Before anything can start an agent: an agent with `host:` reaches its machine through this.
    this.socketPath = socketPath;
    remoteHosts.configure(config, socketPath);
    this.ipc = new IpcServer(
      socketPath,
      {
        // resolveAddress is also the sole capture point for the conversation owning this reverse
        // command: IPC only forwards the address to handle. So reverse-lookup by token and stash it
        // for the synchronously-following handleReverse (see lastResolvedConversationId). The
        // platform a qualified `--channel` named rides in the same kind of slot, for the same reason.
        resolveAddress: (token, override) => {
          this.lastResolvedConversationId = this.registry.conversationForToken(token);
          this.lastResolvedPlatform = override?.platform;
          return this.registry.resolveAddress(token, override?.address);
        },
        handle: (action, address) => this.handleReverse(action, address),
      },
      new Set(Object.keys(config.platforms))
    );
  }

  async run(): Promise<void> {
    // Wire + start every configured platform instance; they all converge on the same
    // inbound entry (messages carry their instance id, so routing/outbound stay separable).
    for (const [id, adapter] of this.platforms) {
      adapter.onMessage((msg) => this.onInbound(msg));
      // Button clicks: blocking ask resolves on these (safely ignored if non-ask prefix / no match).
      adapter.onButton((ev) => this.onButton(ev));
      // Native slash commands: not interpreted; synthesized into a `/<name> <input>` message for the agent.
      adapter.onCommand((ev) => this.onCommand(ev));
      // A platform that can show where a conversation is working gets a way to ask (the web
      // UI's topic list). Here rather than at construction because the registry that answers it
      // does not exist when the adapters are built, and best-effort because it is decoration:
      // an adapter that does not implement it simply shows nothing.
      adapter.useWorkdirLookup?.((ref) => this.registry.workdirForRef(ref));
      // …and one that can show whether the agent behind a conversation is still up. Same seam,
      // same best-effort reading: a turn ending is not the agent ending, and nothing else tells
      // the topic switcher that apart from a conversation whose child was reclaimed hours ago.
      adapter.useLivenessLookup?.((ref) => this.registry.liveForRef(ref));
      // …and one that lists those agents gets a way to end the idle ones (the web UI's "Close idle
      // agents"), within the idle sweeper's gates — see reclaimIdleForRef.
      adapter.useIdleReclaim?.((ref) => this.registry.reclaimIdleForRef(ref));
      // …and one that can throw its own topics away (the web UI evicts past its cap) gets a way to
      // ask which of them a scheduled task still posts into. Not decoration, unlike the two above:
      // a task whose topic was evicted fails every run after it.
      adapter.useScheduleLookup?.((ref) => this.schedules?.targets(ref) ?? false);
      // …and one that can draw the tasks themselves gets the list and the four operations (the
      // web UI's side panel). Same service the agent's commands and `/setting schedule` use, so
      // a change made in the panel is a change made everywhere.
      const panel = this.schedulePanel(id);
      if (panel) adapter.useSchedulePanel?.(panel);
      // …and one with room for a skills page gets the gateway's managed skills and every write
      // the store allows (the web UI). `talkcode skills` is the same store, so the two cannot
      // disagree; archiving here tells the creating conversation exactly as the CLI path does.
      adapter.useSkillsPanel?.(buildSkillsPanel({ notifyArchived: (skill) => this.notifySkillArchived(skill, 'manual') }));
      // …and the automatic reviews, read-only: what each quiet conversation taught the skill
      // library, including the reviews that changed nothing and so posted no line anywhere.
      const reviewPanel = this.reviewPanel(id);
      if (reviewPanel) adapter.useReviewPanel?.(reviewPanel);
      // …and one with room to lay out the agents a new conversation could be given to (the web UI's
      // empty topic) gets a way to ask which, and who answers if nobody picks.
      adapter.useAgentCatalog?.((ref) => this.registry.agentCatalogForRef(ref));
      // The status line's model switch: `/model` as a control (ConversationRegistry.modelPickerForRef).
      adapter.useModelPicker?.({
        list: (ref) => this.registry.modelPickerForRef(ref),
        choose: (ref, value) => this.registry.chooseModelForRef(ref, value),
      });
      await adapter.start();
      console.log(`[daemon] platform instance "${id}" (${adapter.platformType}) started`);
    }
    // The registered set is fixed and derived from config (see buildRegisteredSpecs), so it is
    // registered once here rather than re-derived whenever an agent reports its commands.
    await this.registerCommands();
    // Each remote agent's directory list, read now so the first bare `/cc` has a menu to offer.
    this.registry.warmRemoteScans();
    await this.ipc.start();
    // Turns the last daemon never finished — a drain that ran out of time, or a crash. After the
    // platforms are up (each gets a line where it ran) and after IPC (a continue it schedules needs
    // its agent's reverse commands to work).
    const interrupted = this.registry.recoverInterruptedTurns();
    if (interrupted > 0) console.log(`[daemon] ${interrupted} turn(s) were cut off by the last shutdown`);
    // After the platforms and IPC are up: a run that is due right away (a catch-up after the update
    // that restarted us) needs somewhere to post, and an agent run needs its reverse commands.
    this.schedules?.scheduler.start();
    // The review sweep's first pass is the backfill after a restart: every agent child is gone and
    // the idle clock comes from the library, so conversations that went quiet during the update are
    // reviewed now rather than waiting for a reclaim that will never come for them.
    this.reviews?.start();
    // The managed skills' daily check: 14 days marks one expired, 30 archives it. Not from a test
    // worker, which is not the CLI and must not touch the operator's config directory.
    if (selfInvocation() && !process.env.TALKCODE_NO_SKILL_LINK) {
      this.skillSweepStop = startSkillSweep((skill, reason) => this.notifySkillArchived(skill, reason));
    }
    // What the hosts' pods declare now (pods.ts). Not awaited: until it answers, every pod keeps the
    // agents pods.json remembers, which is what routing and conversations were loaded against.
    void this.refreshPods(STARTUP_POD_TIMEOUT_MS)
      .then((r) => {
        for (const n of r.notes) console.warn(`[pods] ${n}`);
        if (r.changed) this.reloadConfig();
      })
      .catch((e: Error) => console.warn(`[pods] not read at startup: ${e.message}`));
    // Graceful stop on SIGINT (Ctrl-C) / SIGTERM (kill / container stop); otherwise resident ACP
    // child processes are orphaned and the socket file lingers. Removed again in stop().
    this.installSignalHandlers();
  }

  /**
   * Install SIGINT/SIGTERM → one-shot graceful stop, then exit 128+signo per convention.
   *
   * A SIGTERM that finds work in progress waits for it first (beginDrain): it is what stopping or
   * recreating the container sends, so it is how the gateway is updated, and stopping at once would
   * cut off every turn in progress. A second SIGTERM, or SIGINT (Ctrl-C, or `docker stop -s SIGINT`
   * for an update that should not wait), stops at once.
   */
  private installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      if (signal === 'SIGTERM' && !this.drainCancel && this.beginDrain()) return;
      console.log(`[daemon] received ${signal}, shutting down gracefully…`);
      this.exitAfterStop(signal === 'SIGINT' ? 130 : 143);
    };
    const onSigint = (): void => onSignal('SIGINT');
    const onSigterm = (): void => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    this.signalCleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
  }

  /** Exit codes follow shell convention (SIGINT=130 / SIGTERM=143); exit even if stop fails. */
  private exitAfterStop(code: number): void {
    void this.stop()
      .catch((e) => console.error('[daemon] shutdown failed:', e instanceof Error ? e.message : e))
      .finally(() => process.exit(code));
  }

  private inProgress(): InProgress {
    return { turns: this.registry.turnsInProgress(), runs: this.schedules?.scheduler.inFlight ?? 0 };
  }

  /**
   * Wait for the turns and scheduled runs in progress, then stop (restart-drain.ts). Returns false,
   * doing nothing, when there are none — the stop then happens at once, as it always did.
   *
   * Meanwhile nothing new starts: a message that would start a turn in an idle conversation is
   * refused (ConversationRegistry.beginDrain), and the scheduler starts no run. What is already at
   * work carries on whole — messages to a busy conversation still reach its turn, `/stop` still stops
   * it, a question still takes its answer, and the agents' reverse commands still work.
   */
  private beginDrain(): boolean {
    const now = this.inProgress();
    if (nothingInProgress(now)) return false;
    this.registry.beginDrain();
    this.schedules?.scheduler.hold();
    console.log(
      `[daemon] received SIGTERM with ${describeInProgress(now)} in progress: stopping once ${now.turns + now.runs === 1 ? 'it finishes' : 'they finish'}, at most ${DRAIN_LIMIT_MS / 60_000} min. Another SIGTERM, or SIGINT, stops now.`
    );
    this.drainCancel = whenIdle(
      () => this.inProgress(),
      this.clock,
      (left) => {
        if (nothingInProgress(left)) console.log('[daemon] nothing in progress any more, shutting down gracefully…');
        else console.warn(`[daemon] ${describeInProgress(left)} still in progress after ${DRAIN_LIMIT_MS / 60_000} min; shutting down anyway…`);
        this.exitAfterStop(143);
      }
    );
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopping) return; // run once when signals repeat / explicit stop races a signal
    this.stopping = true;
    this.drainCancel?.();
    this.signalCleanup?.();
    this.signalCleanup = null;
    this.skillSweepStop?.();
    this.skillSweepStop = undefined;
    // Before the platforms: a review that is mid-run when the gateway stops is left to finish its
    // process (it is short and bounded), but no new one starts and no notice is posted to a lane
    // that is about to go down.
    this.reviews?.stop();
    // First, so nothing new starts while the rest goes down. Bash runs in flight are signalled and
    // record themselves as interrupted; agent runs end with the registry below.
    this.schedules?.scheduler.stop();
    await this.ipc.stop();
    // Deliver what the pacer is still holding BEFORE the adapters go down: a queued write is
    // somebody's reply, and a lane that was paced or paused at the wrong moment must not lose it
    // just because the process is leaving. Bounded by outbound.drainMs so a chat the platform has
    // silenced for minutes cannot hold the shutdown for the same minutes.
    const drained = await this.pacer
      .drain(this.config.outbound.drainMs)
      .catch(() => ({ delivered: 0, abandoned: 0 }));
    if (drained.delivered > 0 || drained.abandoned > 0) {
      console.log(
        `[daemon] outbound drain: ${drained.delivered} delivered, ${drained.abandoned} abandoned`
      );
    }
    for (const [id, adapter] of this.platforms) {
      await adapter.stop().catch((e) =>
        console.error(`[daemon] failed to stop platform instance "${id}":`, e instanceof Error ? e.message : e)
      );
    }
    this.pendingPicks.clear();
    this.pendingModelMenus.clear();
    this.pendingEffortMenus.clear();
    this.pendingSettingsMenus.clear();
    this.pendingScheduleMenus.clear();
    this.pendingAgentMenus.clear();
    this.voice.dispose();
    // Clear pending asks after ipc/platform are down: no new clicks or asks can arrive now. Clear each
    // timer and resolve null ("no selection") so any caller still blocked on ask IPC gets a result
    // rather than hanging forever. Best-effort: never throw.
    for (const pending of this.pendingAsks.values()) {
      try {
        clearTimeout(pending.timer);
        if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
        pending.resolve(null);
      } catch {
        // Cleanup must not block exit; swallow and continue to the next item.
      }
    }
    this.pendingAsks.clear();
    this.delegation.dispose();
    this.registry.dispose(); // release all mergers + agent sessions
    // After the registry: a turn unwinding on the way out may still be recording its last row.
    // Closing flushes the WAL, so the next start finds a complete database.
    this.history?.close();
    // The stop signals the line above sent to agents on other machines are still in their links;
    // give them a moment to leave before the connections go. A host this misses stops those agents
    // anyway when the next gateway connects (a new epoch), or after its orphan timeout.
    await remoteHosts.flushAll(2_000);
    remoteHosts.closeAll();
  }

  /**
   * Adapter for the current reverse command: the instance a qualified `--channel` named, else the
   * one the calling conversation is on. Reads the scratch slots (see lastResolvedConversationId:
   * valid because this runs synchronously after resolveAddress within one dispatch).
   *
   * An unqualified override still goes to the conversation's own instance, as it always has — an
   * address alone can't identify a platform. The qualified form (`tg:5865716608/8068`, what
   * `talkcode channels` prints) is how an agent answering on the web UI posts to Telegram.
   * The instance was already checked against config when IPC parsed the value, so a miss here means
   * the conversation expired, not that the agent named a platform that does not exist.
   */
  private reverseAdapter(): PlatformAdapter {
    const id = this.lastResolvedConversationId;
    const pid = this.lastResolvedPlatform ?? (id ? this.registry.platformFor(id) : undefined);
    if (!pid) throw new Error('cannot resolve the platform instance for this reverse command (conversation expired?)');
    const adapter = this.platforms.get(pid);
    // A platform named by a qualified `--channel` is in the config (IPC checked) but may not have
    // started — a bad token, a host that refused it. Saying so is the useful answer; "cannot
    // resolve" reads as an expired conversation, and "cannot open a topic" would send the agent
    // looking for a `--session` workaround for what is really an outage.
    if (!adapter) throw new Error(`platform instance "${pid}" is not running`);
    return adapter;
  }

  /**
   * `send-file`. The path is the AGENT's: for an agent on a remote host, a path on that host — so the
   * file is fetched from there into a private temporary file first, sent from it, and removed. Capped
   * like an inbound download (attachments.maxDownloadBytes): the platforms refuse far less anyway.
   */
  private async sendAgentFile(
    conversation: ConversationId | undefined,
    platform: PlatformAdapter,
    address: ConversationAddress,
    action: Extract<IpcAction, { kind: 'send-file' }>
  ): Promise<unknown> {
    const agentId = conversation ? (this.registry.boundAgentOf(conversation) ?? this.config.routing.default) : undefined;
    const host = remoteHosts.hostFor(agentId ? findAgent(this.config, agentId) : undefined);
    if (!host) return platform.sendFile(address, { path: action.path, name: action.name, caption: action.caption });
    const base = path.posix.basename(action.path) || 'file';
    const data = await host.readFile(action.path, this.config.attachments.maxDownloadBytes);
    console.log(`[remote] ${host.id}: fetched ${action.path} (${data.length} bytes) to send`);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'talkcode-file-'));
    try {
      const local = path.join(dir, base);
      await fs.promises.writeFile(local, data, { mode: 0o600 });
      return await platform.sendFile(address, { path: local, name: action.name ?? base, caption: action.caption });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  /** Execute one reverse command (address already resolved and validated by IPC). */
  private async handleReverse(action: IpcAction, address: ConversationAddress): Promise<unknown> {
    // Resolve BEFORE any await: the conversation scratch slot is only synchronously valid.
    const platform = this.reverseAdapter();
    const conversation = this.lastResolvedConversationId;
    // A reverse command means the agent is still working for this conversation — even between turns,
    // which is the case idle reclaim would otherwise get wrong: a turn that ended after starting a
    // background job leaves that job reporting through this socket, into a conversation that from
    // the registry's side looks like nobody has said anything in an hour.
    if (this.lastResolvedConversationId) this.registry.touch(this.lastResolvedConversationId);
    // Sub-agents: acted on from the asking conversation, on the topics it opened (Delegation.handle).
    if (isTaskAction(action)) return this.delegation.handle(conversation, action);
    // The conversation library: searches every conversation, not a chat — see handleSessionsQuery.
    if (isSessionsQuery(action)) return this.handleSessionsQuery(action);
    // Questions for the gateway itself, not actions on a chat — answered before the chat switch.
    if (isGatewayQuery(action)) return this.handleGatewayQuery(action, address);
    switch (action.kind) {
      case 'send-message':
        return platform.sendMessage(address, action.text);
      case 'reply':
        // Capability gate: platforms without native reply degrade to a plain send (closest semantics,
        // message still reaches the channel, no low-level error).
        if (!platform.capabilities.reply) {
          return platform.sendMessage(address, action.text);
        }
        // True reply: native platform reply (Discord message_reference).
        return platform.replyMessage({ address, messageId: action.messageId }, action.text);
      case 'edit-message':
        // Capability gate: editing can't be degraded to a fresh send (different message, wrong
        // semantics), so throw a clear error instead of silently doing the wrong thing.
        if (!platform.capabilities.editMessage) {
          throw new Error('unsupported operation: this platform does not support editing messages');
        }
        return platform.editMessage({ address, messageId: action.messageId }, action.text);
      case 'send-file':
        return this.sendAgentFile(conversation, platform, address, action);
      case 'react':
        return platform.addReaction({ address, messageId: action.messageId }, action.emoji);
      case 'delete':
        return platform.deleteMessage({ address, messageId: action.messageId });
      case 'fetch-messages':
        return {
          messages: await platform.fetchHistory(address, {
            limit: action.limit,
            before: action.before,
          }),
        };
      case 'create-thread':
        // Capability gate: clear error instead of a low-level adapter stack when threads are unsupported.
        if (!platform.capabilities.thread) {
          throw new Error('unsupported operation: this platform does not support creating threads');
        }
        // Answer in the shape the protocol declares (`CreateThreadResult`) rather than handing
        // the adapter's `{address}` straight back: the CLI reads `data.threadId` and prints
        // "send into this thread by passing --channel <threadId>", so returning the raw address
        // made that line read `--channel <threadId>` with an empty id — on every platform, ever
        // since the command existed. `formatAddress` produces exactly what `--channel` parses
        // back (`<channel>` where a thread is a channel of its own, `<channel>/<lane>` where it
        // is a lane), so the help line is now true wherever it is printed.
        return {
          threadId: formatAddress(
            (await platform.createThread({ address, messageId: action.messageId }, action.name)).address
          ),
        };
      case 'ask':
        // Capability gate: throw (not return { chosen: null }) when buttons are unsupported. ask means
        // "let the user choose"; silently returning null would mask the problem, while throwing gives
        // the CLI ok:false with a clear message instead of a low-level adapter stack.
        if (!platform.capabilities.buttons) {
          throw new Error('unsupported operation: this platform does not support interactive buttons (ask)');
        }
        return this.handleAsk(platform, action, address);
      default: {
        // Exhaustiveness guard: a new IpcAction variant missed here fails to compile.
        const _exhaustive: never = action;
        throw new Error(`unknown reverse command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * The reverse commands that ask the GATEWAY something rather than act on a chat: they never touch
   * the adapter handleReverse resolved, and read the caller's conversation only to scope or mark
   * their answer. Split out so the chat-action switch stays about chat actions. Async for
   * `schedule-add` alone, which waits on the agent's model list — every scratch slot it needs is
   * read before that await, exactly as the synchronous ones read theirs.
   *
   * `address` is only read by `schedule-add`, where it is the task's target: the `--channel` the
   * agent named, else its own lane (resolveAddress already chose). The platform comes the same way.
   */
  private async handleGatewayQuery(
    action: GatewayQuery,
    address: ConversationAddress
  ): Promise<unknown> {
    const id = this.lastResolvedConversationId;
    switch (action.kind) {
      case 'voice-log': {
        const result: VoiceLogResult = {
          enabled: this.config.voice !== undefined,
          entries: id ? this.voice.history(id, action.limit ?? DEFAULT_VOICE_LOG_LIMIT) : [],
        };
        return result;
      }
      case 'list-channels':
        // About the whole deployment rather than the caller's lane; the caller only marks its row.
        return this.registry.listChannels({
          platform: action.platform,
          query: action.query,
          limit: action.limit ?? DEFAULT_CHANNEL_LIMIT,
          currentKey: id,
        });
      case 'schedule-add': {
        const schedules = this.requireSchedules();
        if (!id) throw new Error('cannot tell which conversation this came from (conversation expired?)');
        const platform = this.lastResolvedPlatform ?? this.registry.platformFor(id);
        if (!platform) throw new Error('cannot resolve the platform for this conversation');
        const { kind: _kind, channelId: _channel, ...input } = action;
        return { task: await schedules.add(input, id, { platform, address }) };
      }
      case 'schedule-list':
        return this.requireSchedules().list(id, action.id);
      case 'schedule-op':
        return { task: this.requireSchedules().op(action.id, action.op, id) };
      case 'reload-config':
        // A file that did not load is an error to the CLI (non-zero exit), not a printed result.
        return this.reloadAll().then((reload) => {
          if (!reload.ok) throw new Error(reload.summary);
          return reload;
        });
      case 'pod-list':
        return this.podList();
      case 'pod-add':
        // Throws, before anything is written, what is wrong with the request (pod-admin.ts).
        addPod(action.name, action.ssh, action.hostKey);
        return this.reloadAll().then((r) => ({
          summary: [
            `Added ${action.name} (${action.ssh}); its host key is pinned in the gateway's known_hosts.`,
            `If it was not reached below, put this line in ~/.ssh/authorized_keys on ${action.name}, then \`talkcode reload\`:`,
            gatewayKeyLine(),
            r.summary,
          ].join('\n'),
        }));
      case 'pod-remove': {
        removePod(action.name);
        // Still reachable through the old host table until the reload replaces it.
        const leaving = remoteHosts.get(action.name);
        return (leaving ? leaveMesh(leaving, RELOAD_POD_TIMEOUT_MS) : Promise.resolve(undefined))
          .then(async (note) => ({ note, reload: await this.reloadAll() }))
          .then(({ note, reload }) => ({
            summary: [`Removed ${action.name}.`, ...(note ? [`⚠️ ${note}`] : []), reload.summary].join('\n'),
          }));
      }
      case 'skills':
        return this.handleSkills(action, id, address);
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown gateway query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * `talkcode sessions …`: the gateway's own library, not a chat. Every one is answered from
   * `<configDir>/history.db` — search is BM25 over the tokenised text, read is one conversation,
   * list is the recent ones. None takes a channel (there is nothing to target), and a daemon
   * started without a library says so rather than pretending the history is empty.
   */
  private handleSessionsQuery(action: SessionsQuery): unknown {
    switch (action.kind) {
      case 'sessions-search':
        // Scheduled runs sort after ordinary conversations — see HistoryStore.search.
        return {
          hits: this.requireHistory().search(action.query, {
            agent: action.agent,
            days: action.days,
            limit: action.limit,
          }),
        };
      case 'sessions-read':
        return this.requireHistory().read(action.session, {
          around: action.around,
          window: action.window,
          role: action.role,
          turn: action.turn,
          turns: action.turns,
          since: action.since,
          grep: action.grep,
          tail: action.tail,
          // The live context, not the newest turn row: after `/new` the library's newest turn
          // is still the generation the person discarded, and `--turn done` must not answer
          // with it. Only conversations.json knows the reset has happened.
          current: (key) => {
            const agent = this.store?.boundAgent(key);
            if (!agent) return undefined;
            return { agent, generation: this.store?.conversationGeneration(key) ?? 0 };
          },
        });
      case 'sessions-list':
        return {
          sessions: this.requireHistory().list({ days: action.days, limit: action.limit }),
          days: action.days ?? 7,
        };
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown sessions query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * `talkcode skills …` — the gateway's own skills (skills-store.ts). The store owns every rule
   * and throws a message written for the agent; this only supplies what the request cannot: the
   * conversation that created a skill, so an archive notice has somewhere to go.
   */
  private handleSkills(
    action: Extract<IpcAction, { kind: 'skills' }>,
    conversationId: ConversationId | undefined,
    address: ConversationAddress
  ): unknown {
    const need = (value: string | undefined, what: string): string => {
      if (value === undefined || value === '') throw new Error(`skills ${action.action} needs ${what}`);
      return value;
    };
    const name = (): string => need(action.name, 'a <name>');
    switch (action.action) {
      case 'list':
        return { skills: listSkills() };
      case 'show':
        return showSkill(name(), action.file);
      case 'create': {
        const source = conversationId
          ? {
              conversation: conversationId,
              platform: this.lastResolvedPlatform ?? this.registry.platformFor(conversationId),
              address,
              agent: this.registry.boundAgentOf(conversationId) ?? this.config.routing.default,
            }
          : undefined;
        return createSkill({ name: name(), description: action.description ?? '', body: action.body, source });
      }
      case 'patch':
        return patchSkill({ name: name(), version: need(action.version, '--version'), content: need(action.content, '--content') });
      case 'write-file':
        if (action.content === undefined) throw new Error('skills write-file needs --content');
        return writeSkillFile({ name: name(), file: need(action.file, 'a <file>'), content: action.content });
      case 'remove-file':
        return removeSkillFile({ name: name(), file: need(action.file, 'a <file>') });
      case 'archive': {
        const record = archiveSkill(name());
        this.notifySkillArchived(record, 'manual');
        return record;
      }
      case 'restore':
        return restoreSkill(name());
      case 'pin':
        return pinSkill(name(), true);
      case 'unpin':
        return pinSkill(name(), false);
      case 'history':
        return { history: skillHistory(name()) };
      case 'revert':
        return revertSkill(name(), need(action.id, 'a history <id>'));
      default: {
        const _exhaustive: never = action.action;
        throw new Error(`unknown skills action: ${_exhaustive}`);
      }
    }
  }

  /** Tell the conversation a skill came from that it was archived; no source means a log line only. */
  private notifySkillArchived(skill: SkillRecord, reason: 'unused' | 'manual'): void {
    const source = skill.source;
    if (!source?.platform || !source.address) {
      console.log(`[skills] archived "${skill.name}" (no source conversation to tell)`);
      return;
    }
    const adapter = this.platforms.get(source.platform);
    if (!adapter) {
      console.log(`[skills] archived "${skill.name}" (its conversation was on ${source.platform}, which is no longer configured)`);
      return;
    }
    const why = reason === 'unused' ? 'was archived after 30 days unused' : 'was archived';
    void adapter
      .sendMessage(source.address, `Skill "${skill.name}" ${why}. Restore it with \`talkcode skills restore ${skill.name}\`.`)
      .catch((e: unknown) =>
        console.warn(`[skills] could not tell ${source.platform} about "${skill.name}":`, e instanceof Error ? e.message : e)
      );
  }

  /**
   * `/reload` as a person or an agent asks for it: the pods are read again first (pods.ts), so an
   * edited `~/.talkcode/pod.yaml` takes effect with the same command that applies config.yaml. The
   * hosts are those of the file about to be applied — a host added with this reload is read too.
   * A file that does not load skips the pods and is reported by reloadConfig, as before.
   */
  async reloadAll(): Promise<{ ok: boolean; summary: string }> {
    let notes: string[] = [];
    try {
      const next = readConfig().config;
      remoteHosts.configure(next, this.socketPath);
      notes = (await this.refreshPods(RELOAD_POD_TIMEOUT_MS, next.hosts)).notes;
    } catch (e) {
      // A file that does not load: reloadConfig reads it again and says what is wrong.
      console.warn(`[pods] not read before this reload: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
    const reload = this.reloadConfig();
    if (!reload.ok || notes.length === 0) return reload;
    return { ok: true, summary: [reload.summary, ...notes.map((n) => `- ⚠️ pods: ${n}`)].join('\n') };
  }

  /**
   * Read every host's pod into pods.json, then put the pod-to-pod ssh files on the ones that answered
   * (pod-peers.ts). Serialized, as the startup read and a reload can meet. `hosts`: the table about
   * to apply — a reload's, before it is the live one.
   */
  private refreshPods(timeoutMs: number, hosts: Record<string, HostDef> = this.config.hosts ?? {}): Promise<{ changed: boolean; notes: string[] }> {
    const run = async (): Promise<{ changed: boolean; notes: string[] }> => {
      const r = await refreshPods({
        dir: configDir(),
        hostIds: remoteHosts.ids(),
        host: (id) => remoteHosts.get(id),
        configured: hostsWithConfiguredAgents(readRawConfigIfExists()),
        timeoutMs,
      });
      const at = new Date();
      for (const id of r.read) this.podReads.set(id, { at });
      for (const note of r.notes) this.podReads.set(note.slice(0, note.indexOf(':')), { at, note });
      const meshNotes = await syncPeers({
        pods: readPods(configDir()),
        hosts,
        reachable: r.read,
        host: (id) => remoteHosts.get(id),
        knownHostsText: (def) => readKnownHosts(knownHostsFileOf(def)),
      });
      return { changed: r.changed, notes: [...r.notes, ...meshNotes] };
    };
    const next = this.podsRead.then(run, run);
    this.podsRead = next.catch(() => undefined);
    return next;
  }

  /**
   * `/reload` and `talkcode reload`: re-read config.yaml and `.env` and apply what a running daemon
   * can take (see daemon/config-reload.ts for what that is and why it is done in place).
   *
   * Never throws: a file that does not load becomes the answer, and in that case NOTHING has
   * changed — readConfig validates against a candidate environment, so even process.env is only
   * written once the new config is known to be good.
   */
  reloadConfig(): { ok: boolean; summary: string } {
    let read: ReadConfig;
    try {
      read = readConfig();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[reload] config.yaml not reloaded: ${why}`);
      return { ok: false, summary: `config.yaml was not reloaded — nothing changed.\n${why}` };
    }
    const next = read.config;
    const diff = diffConfig(this.config, next);
    const commandsBefore = JSON.stringify(buildRegisteredSpecs(this.config));
    const wasRestricted = !accessUnrestricted(this.config);

    read.commitEnv();
    applyConfig(this.config, next);
    remoteHosts.configure(this.config, this.socketPath);
    // A new host or a moved `cwd` has no directory list yet; already-listed ones are just reread.
    this.registry.warmRemoteScans();

    if (diff.sections.includes('session')) this.registry.idleTimeoutChanged();
    // A tier change voids what Delegation remembered. This is the `/reload` half: a change away and
    // back across two reloads, with no `task-new` in between, is invisible to a read at propose time.
    if (diff.sections.includes('delegation')) this.delegation.forgetConfirmations();
    const respawn = this.registry.respawnAgents(new Set([...diff.agentsChanged, ...diff.agentsRemoved]));
    // Only when the set changed: re-registering is a platform API call per instance, and Telegram
    // and Discord rate-limit it.
    if (JSON.stringify(buildRegisteredSpecs(this.config)) !== commandsBefore) void this.registerCommands();

    const warnings: string[] = [];
    if (wasRestricted && accessUnrestricted(this.config)) {
      console.warn(UNRESTRICTED_WARNING);
      warnings.push('access.allowFrom is now empty: anyone who can message the bot can run an agent with full tool access');
    }
    // A task pinned to a removed agent fails each time it comes due; say so now rather than then.
    const orphaned = (this.schedules?.tasks() ?? []).filter(
      (t) => t.run.kind === 'agent' && diff.agentsRemoved.includes(t.run.agent)
    );
    if (orphaned.length) {
      warnings.push(`scheduled task(s) ${orphaned.map((t) => t.id).join(', ')} run a removed agent; they will fail until changed or removed`);
    }

    const summary = describeReload(diff, respawn, read.envChanges, warnings);
    console.log(`[reload] ${summary.replace(/\n/g, ' | ')}`);
    return { ok: true, summary };
  }

  /**
   * `talkcode pods`: every host, the agents it has and where they were read from, whether it is in
   * the ssh mesh, and how its last read went — plus the line a new host needs to let the gateway in.
   */
  private podList(): { gatewayKey: string; pods: Array<Record<string, string>> } {
    const pods = readPods(configDir());
    const explicit = hostsWithConfiguredAgents(readRawConfigIfExists());
    const rows = Object.entries(this.config.hosts ?? {}).map(([id, def]) => {
      const read = this.podReads.get(id);
      const from = explicit.has(id) ? 'config.yaml' : pods[id]?.source === 'file' ? 'pod.yaml' : pods[id]?.source === 'probe' ? 'PATH' : '-';
      return {
        pod: id,
        ssh: def.ssh,
        agents: this.config.agents.filter((a) => a.host === id).map((a) => a.id).join(' ') || '-',
        from,
        peer: pods[id]?.peer ? peerName(id) : '-',
        lastRead: !read ? 'not yet' : `${read.at.toISOString().slice(0, 19)}Z ${read.note ? `kept old: ${read.note.slice(id.length + 2)}` : 'ok'}`,
      };
    });
    return { gatewayKey: gatewayKeyLine(), pods: rows };
  }

  /** The schedule service, or a sentence saying this daemon was started without one. */
  private requireSchedules(): ScheduleService {
    if (!this.schedules) throw new Error('scheduled tasks are not enabled in this daemon');
    return this.schedules;
  }

  /** The conversation library; a daemon started without one answers `sessions` with this. */
  private requireHistory(): HistoryStore {
    if (!this.history) throw new Error('the conversation history is not enabled in this daemon');
    return this.history;
  }

  /**
   * Every conversation the review sweep may look at, as one list.
   *
   * Two sources, because neither is complete. `conversations.json` survives a restart and carries
   * the lane a notice goes to; the registry knows only conversations this process has seen, but
   * knows the things a stored record cannot — whether a turn is running, whether a child is
   * resident, whether the daemon is holding a pending question. The merge itself is
   * `reviewCandidatesFrom`, where it can be tested without a daemon.
   */
  private reviewCandidates(): ReviewCandidate[] {
    const now = Date.now();
    const live = this.registry.reviewFacts(now);
    return reviewCandidatesFrom(this.store?.entries() ?? [], live, (key) => this.history?.sessionOf(key), now);
  }

  /** The review's one-line notice, in the conversation it reviewed. */
  private async notifyReview(lane: ReviewLane, text: string): Promise<void> {
    const adapter = this.platforms.get(lane.platform);
    if (!adapter) throw new Error(`platform "${lane.platform}" is not configured any more`);
    await adapter.sendMessage(lane.thread ? { channel: lane.channel, thread: lane.thread } : { channel: lane.channel }, text);
  }

  /**
   * The web UI's scheduled-task panel, bound to one platform instance: the list, and the four
   * operations, both answered from the same service the agent's `schedule` commands and
   * `/setting schedule` use. `announce: false` because the panel is the acknowledgement — posting
   * a card into a conversation the operator may not be looking at would say it twice.
   *
   * The instance id is only for `targetTopic`: a task may post to another platform, and a topic id
   * from another instance would point the page at a lane it does not have.
   */
  private schedulePanel(instance: string): SchedulePanel | undefined {
    const schedules = this.schedules;
    if (!schedules) return undefined;
    const list = (): SchedulePanelTask[] =>
      panelTasks(schedules.tasks(), schedules.now(), (id) => schedules.scheduler.isRunning(id), instance);
    return {
      list,
      op: (id, action) => {
        try {
          schedules.op(id, action, undefined, false);
          return { ok: true, tasks: list() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    };
  }

  /**
   * The web UI's Reviews tab, bound to one platform instance: the review sessions in `history.db`.
   * Read-only by construction — see `useReviewPanel`.
   *
   * The instance id is only for the link back to the reviewed topic: a review of a Telegram
   * conversation has no topic here, and a topic id from another instance would point the page at a
   * lane it does not have.
   */
  private reviewPanel(instance: string): ReviewPanel | undefined {
    const history = this.history;
    const reviews = this.reviews;
    if (!history || !reviews) return undefined;
    return buildReviewPanel({
      history,
      instance,
      enabled: () => reviews.enabled(),
    });
  }

  /**
   * Blocking clarify: send a button message, suspend the IPC response, await a click or timeout.
   * On resolve, dispatch returns { chosen } to the blocked CLI process.
   */
  private async handleAsk(
    platform: PlatformAdapter,
    action: Extract<IpcAction, { kind: 'ask' }>,
    address: ConversationAddress
  ): Promise<{ chosen: string | null }> {
    const labels = action.options;
    // Anchor the conversation: read the stash before any await (later awaits yield, allowing a
    // subsequent dispatch to overwrite the value).
    const conversationId = this.lastResolvedConversationId;
    // Empty-options fast path: protocol options has no min(1), so an empty array would post a
    // "no buttons" message and idle until timeoutMs. With nothing to pick, return "no selection" now.
    if (labels.length === 0) {
      return { chosen: null };
    }
    const chosen = await this.askButtons(
      platform,
      address,
      action.prompt,
      labels,
      action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
      conversationId
    );
    // The reverse `ask` speaks in labels, and a typed answer is simply the label the user wrote —
    // the CLI's contract is "what the human answered", not "which of your options they picked", and
    // the prompt came from the agent itself rather than from a schema it has to validate against.
    // The join is a formality: `ask` never requests a multi-select, so there is always one label.
    return {
      chosen:
        chosen === null || chosen.kind === 'timeout'
          ? null
          : chosen.kind === 'option'
            ? chosen.labels.join(', ')
            : chosen.text,
    };
  }

  /**
   * Post one question as buttons and resolve with what the user answered (null on timeout).
   *
   * Shared by the two ways a question reaches the user: the `ask` reverse command, and the agent's
   * own ACP elicitation. One implementation because the mechanics are identical down to the
   * eviction guard — the difference is only who asked and how the answer travels back — and two
   * copies would inevitably drift on the details that took a bug each to get right (keeping the
   * posted message's own ref for the ack edit, stripping the buttons on resolve, re-checking the
   * clicker against the allowlist).
   *
   * `opts.multi` turns the bubble into a stateful one — ticks in the labels, Done to finish. It is
   * the caller's job to have checked `canMultiSelect` first: this redraws through `editButtons`,
   * and on a platform that cannot do that the user would tap at ticks that never move.
   */
  private askButtons(
    platform: PlatformAdapter,
    address: ConversationAddress,
    prompt: string,
    labels: string[],
    timeoutMs: number,
    conversationId?: ConversationId,
    opts: {
      acceptsText?: boolean;
      multi?: boolean;
      timeoutNote?: string;
      signal?: AbortSignal;
      /** What the message IS, for a platform that draws kinds differently (SendOptions.kind). */
      kind?: MessageKind;
    } = {}
  ): Promise<AskOutcome | null> {
    const reqId = randomUUID().slice(0, 8);
    const acceptsText = opts.acceptsText ?? true;
    const selected = opts.multi ? new Set<number>() : undefined;
    const buttons = buildAskButtons(reqId, labels, selected);
    // The Done affordance is appended here rather than baked into `prompt`, because `prompt` is
    // what retireAsk reprints under the answer — and "tap Done when you're finished" under a
    // question that is already answered is stale instruction, not a record of what happened.
    return platform.sendButtons(
      address,
      selected ? `${prompt}\n\n${MULTI_HINT}` : prompt,
      buttons,
      undefined,
      opts.kind ? { kind: opts.kind } : undefined
    ).then(
      (ref) =>
        new Promise<AskOutcome | null>((resolve) => {
          const timer = setTimeout(() => {
            if (this.settleAsk(reqId, { kind: 'timeout' }, opts.timeoutNote ?? '(timed out)')) {
              if (conversationId !== undefined && timeoutMs >= DEFAULT_ASK_TIMEOUT_MS) {
                this.registry.reclaimAfterAskTimeout(conversationId);
              }
            }
          }, timeoutMs);
          const reminderTimer =
            timeoutMs > DEFAULT_ASK_REMINDER_MS
              ? setTimeout(() => {
                  void platform
                    .sendMessage(address, DEFAULT_ASK_REMINDER_TEXT)
                    .catch((err) =>
                      console.warn(
                        `[ask] ${conversationId ?? reqId}: failed to send reminder notice:`,
                        err instanceof Error ? err.message : err
                      )
                    );
                }, DEFAULT_ASK_REMINDER_MS)
              : undefined;
          this.pendingAsks.set(reqId, {
            resolve,
            timer,
            reminderTimer,
            ref,
            labels,
            prompt,
            adapter: platform,
            acceptsText,
            conversationId,
            ...(selected ? { selected } : {}),
          });
          // Called off by its caller (a sub-agent card replaced by a newer one): settled like a /stop.
          opts.signal?.addEventListener('abort', () => this.settleAsk(reqId, null, '(replaced)'), { once: true });
          if (opts.signal?.aborted) this.settleAsk(reqId, null, '(replaced)');
          if (conversationId !== undefined) {
            this.settleFromGap(reqId, conversationId, acceptsText);
            // A sub-agent asking the person something: the agent that opened it is told it is waiting.
            if (this.pendingAsks.has(reqId)) this.delegation.childChanged(conversationId);
          }
        })
    );
  }

  /** The question waiting on the person in a conversation, whole — for sub-agent updates. */
  private questionOf(conversationId: ConversationId): string | undefined {
    for (const pending of this.pendingAsks.values()) {
      if (pending.conversationId !== conversationId) continue;
      return pending.prompt.trim() || undefined;
    }
    return undefined;
  }

  /**
   * Settle one pending question: unblock whoever is waiting on it and take it off the screen.
   *
   * Every exit goes through here — tapped, typed, timed out, called off — because each of its three
   * steps has been forgotten on this path at least once: a timer left running fires against a
   * request that is gone, an unresolved promise parks an agent turn forever, and an un-retired
   * bubble keeps live buttons under an answered question. Returns false when the question was
   * already settled, which is the normal race (a tap landing just after a timeout).
   */
  private settleAsk(reqId: string, outcome: AskOutcome | null, shown: string): boolean {
    const pending = this.pendingAsks.get(reqId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    if (pending.reminderTimer) clearTimeout(pending.reminderTimer);
    this.pendingAsks.delete(reqId);
    pending.resolve(outcome);
    this.retireAsk(pending, shown);
    return true;
  }

  /**
   * Replay onto a just-posted question whatever happened to its conversation while it was in flight
   * (see elicitGaps): an answer typed in the gap, or a cancellation that arrived when there was
   * nothing on screen to cancel. Both address a question that did not exist yet, so they wait on the
   * gap and are applied here, the instant one does.
   */
  private settleFromGap(reqId: string, conversationId: ConversationId, acceptsText: boolean): void {
    const gap = this.elicitGaps.get(conversationId);
    if (!gap) return;
    if (gap.cancelled !== undefined) {
      this.settleAsk(reqId, null, `(${gap.cancelled})`);
      return;
    }
    if (acceptsText && gap.parked !== undefined) {
      const parked = gap.parked;
      gap.parked = undefined;
      this.answerPendingAskWithText(conversationId, parked);
    }
  }

  /**
   * Take a question off the screen: strip its buttons and record what became of it, best-effort.
   *
   * `editButtons` with an EMPTY array rather than a text-only `editMessage`, for the reason spelled
   * out on editModelMenu: only Discord and Telegram drop components when a message is edited to
   * plain text — on Slack and Lark the buttons of an already-answered question stayed live, and a
   * second tap on them hits a `pendingAsks` entry that is gone (silently doing nothing, which reads
   * as the bot ignoring you). Platforms without editButtons degrade to the text-only edit, which is
   * the best they can do.
   */
  private retireAsk(pending: PendingAsk, outcome: string): void {
    const text = `${pending.prompt}\n\n${outcome}`;
    const edit = pending.adapter.capabilities.editButtons
      ? pending.adapter.editButtons(pending.ref, text, [])
      : pending.adapter.editMessage(pending.ref, text);
    void edit.catch(() => undefined);
  }

  /**
   * A message typed into a conversation that has a question on screen: record it as the answer.
   *
   * Returns true when it was consumed, in which case no turn runs — which is the whole point. A
   * typed reply used to reach the merger, and the merger's job is to interrupt the running turn:
   * the agent was killed mid-question, so on a multi-question form every question after the one
   * being answered was lost. Answering here instead keeps the form going: the elicitation loop
   * resolves this round and posts the next one.
   *
   * The NEWEST matching question wins. Rounds are asked one at a time, so the newest is the one on
   * screen; the only way to have two is a reverse `ask` from a background process arriving while an
   * elicitation is up, and there the later bubble is still the one the user is looking at.
   */
  private answerPendingAskWithText(conversationId: ConversationId, text: string): boolean {
    let match: string | undefined;
    for (const [reqId, pending] of this.pendingAsks) {
      if (pending.conversationId === conversationId && pending.acceptsText) match = reqId;
    }
    if (match === undefined) {
      // Nothing on screen — but a form may be mid-flight, with its next question still being
      // posted. Park the answer for it rather than letting the message interrupt the form (see
      // elicitGaps). A second message in the same gap is not parked: one parked answer belongs to
      // one question, and guessing which of two it was is worse than the old behavior.
      const gap = this.elicitGaps.get(conversationId);
      if (!gap?.acceptsText || gap.parked !== undefined || gap.cancelled !== undefined) return false;
      gap.parked = text;
      console.log(`[ask] ${conversationId}: answer parked for the question being posted`);
      return true;
    }
    const echo = text.length > ASK_ECHO_MAX ? `${text.slice(0, ASK_ECHO_MAX)}…` : text;
    this.settleAsk(match, { kind: 'text', text }, `→ Answered: ${echo}`);
    console.log(`[ask] ${conversationId}: question answered by a typed reply`);
    return true;
  }

  /**
   * Abandon every question this conversation has on screen (`/stop`, `/new`), and report how many.
   *
   * Without this a stopped turn leaves its question behind: the buttons stay live, `hasPendingWork`
   * keeps the agent pinned for the rest of the ten-minute timeout, and — since a typed reply now
   * answers the newest pending question — the user's NEXT message would be swallowed as an answer
   * to a question whose turn no longer exists. Resolving null is the same thing a timeout does, so
   * the caller blocked on it (an elicitation, or an `ask` over IPC) unblocks normally.
   *
   * A form mid-round has nothing on screen to cancel, so the cancellation is recorded on the gap and
   * applied to the question the moment it appears — otherwise `/stop` timed exactly between two
   * rounds left the next one posted and clickable for the rest of its timeout.
   */
  private cancelPendingAsks(conversationId: ConversationId, reason: string): number {
    const gap = this.elicitGaps.get(conversationId);
    if (gap && gap.cancelled === undefined) {
      // First reason wins: `/stop` cancels, and the turn abort it triggers cancels again a moment
      // later. What the user did is the useful half of that pair, and it is the one that arrives
      // first.
      gap.cancelled = reason;
      gap.parked = undefined; // an answer to a form nobody is waiting on any more
    }
    let cancelled = 0;
    for (const [reqId, pending] of [...this.pendingAsks]) {
      if (pending.conversationId !== conversationId) continue;
      if (this.settleAsk(reqId, null, `(${reason})`)) cancelled++;
    }
    if (cancelled > 0) console.log(`[ask] ${conversationId}: ${cancelled} question(s) called off (${reason})`);
    return cancelled;
  }

  /**
   * A `permissions: ask` agent wants to run a tool: post its options as buttons and wait.
   *
   * Buttons only — a typed reply is not taken as an answer. Unlike a question, nothing typed maps
   * cleanly onto "allow once" or "always allow", and a sentence like "no, use the other file"
   * belongs to the agent as the user's next message, not to this bubble as a guess at an option.
   * A platform that cannot show buttons cannot ask at all, and says so (`unavailable`) rather than
   * approving.
   *
   * The timeout is the `ask` one (an hour, with the half-hour reminder): a permission request is the
   * same "the agent is blocked until you answer" as a question, and two clocks for one kind of wait
   * would be a difference nobody could see the reason for.
   */
  private async onPermissionRequest(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentPermissionRequest
  ): Promise<PermissionAnswer> {
    if (!platform.capabilities.buttons) {
      return { kind: 'unavailable', why: `${platform.platformType} cannot show buttons` };
    }
    const answer = await this.askButtons(
      platform,
      address,
      composePermissionPrompt(request.title, DEFAULT_ASK_TIMEOUT_MS),
      request.options.map((o) => o.label),
      DEFAULT_ASK_TIMEOUT_MS,
      conversationId,
      {
        acceptsText: false,
        timeoutNote: '⏱ Nobody answered — declined. The agent was told no one answered, not that you refused.',
      }
    );
    if (answer === null) return { kind: 'cancelled' };
    if (answer.kind === 'timeout') return { kind: 'unanswered', waitedMs: DEFAULT_ASK_TIMEOUT_MS };
    if (answer.kind !== 'option') return { kind: 'cancelled' }; // unreachable: acceptsText is false
    const picked = request.options.find((o) => o.label === answer.labels[0]);
    return picked ? { kind: 'selected', optionId: picked.optionId } : { kind: 'cancelled' };
  }

  /**
   * The agent stopped mid-turn to ask the user something (ACP elicitation) — put each question to
   * them as buttons, in order, and hand back what they picked.
   *
   * ── Why this exists at all ────────────────────────────────────────────────────────────────────
   * Because the alternative is the model guessing. The `claude` harness keeps its AskUserQuestion
   * tool disabled unless the client advertises `elicitation.form` (see agent-acp's initialize), so
   * before this hook a model that needed a decision either picked for you or asked in prose and
   * ended its turn. Now it asks, and waits.
   *
   * Rounds are sequential and abandoned on the first unanswered one: a form is a set of questions
   * the agent needs ALL of, so carrying on to ask question three after question two timed out
   * would collect an answer it cannot use, having already made the user tap twice for nothing.
   *
   * A round can be answered by typing instead of tapping — which is the only usable answer when
   * none of the options fit, and the reason the question carries an "Other" field at all. The typed
   * words go back under that field (ElicitQuestion.customKey), where the harness gives them
   * precedence over the enum; crucially, the turn is NOT interrupted, so the remaining questions
   * are still asked. Before this, typing at question 2 of 3 killed the turn and lost question 3.
   *
   * Option rationales go in the message body rather than on the buttons. They are frequently the
   * most useful part of the question ("you already run pgvector here, so reusing it costs
   * nothing") and a button label cannot hold a sentence on any of the eight platforms.
   */
  private async onElicitRequest(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentElicitation
  ): Promise<ElicitAnswer> {
    // Open the between-rounds window for this form (see elicitGaps), and close it whatever happens:
    // a leaked entry would park a later message against a form that is long over.
    const gap: ElicitGap = {
      acceptsText: request.questions.every((q) => q.customKey !== undefined),
    };
    this.elicitGaps.set(conversationId, gap);
    try {
      return await this.askRounds(conversationId, platform, address, request);
    } finally {
      this.elicitGaps.delete(conversationId);
      // Only reachable when the round that would have taken it never got posted (the send failed,
      // so askButtons rejected). Said out loud rather than dropped in silence — it is the user's
      // sentence that is going nowhere.
      if (gap.parked !== undefined) {
        console.warn(`[ask] ${conversationId}: a parked answer was never delivered: ${gap.parked}`);
      }
    }
  }

  /** The rounds themselves; split out of onElicitRequest so the gap window has a `finally` to close in. */
  private async askRounds(
    conversationId: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentElicitation
  ): Promise<ElicitAnswer> {
    const content: Record<string, string | string[]> = {};
    for (const [i, q] of request.questions.entries()) {
      const multi = canMultiSelect(platform, q);
      const answer = await this.askButtons(
        platform,
        address,
        composeElicitPrompt(
          q,
          i,
          request.questions.length,
          q.multi && !multi ? MULTI_DEGRADED_NOTE : undefined
        ),
        q.options.map((o) => o.label),
        DEFAULT_ASK_TIMEOUT_MS,
        conversationId,
        { acceptsText: q.customKey !== undefined, multi }
      );
      if (answer === null || answer.kind === 'timeout') {
        console.log(`[elicit] ${conversationId}: question ${i + 1} went unanswered; cancelling`);
        return { action: 'cancel' };
      }
      if (answer.kind === 'text') {
        // Only reachable when the question declared a free-text field (askButtons was told so
        // above), so the key is present; the enum field is left unset on purpose, since sending
        // both would make the harness pick between two answers for one question.
        content[q.customKey!] = answer.text;
        continue;
      }
      // Send back the options' `value`s, not the labels the buttons carried: ACP separates display
      // text from the answer, and an MCP server that made them differ must get what it offered.
      const picked = answer.labels.map((l) => q.options.find((o) => o.label === l)?.value);
      // Unreachable: labels come from these very options. Cancelling rather than filtering the
      // misses out, because a multi-select answer with a hole in it is not the answer that was given.
      if (picked.some((v) => v === undefined)) return { action: 'cancel' };
      const values = picked as string[];
      // An array field takes an array even when one option was ticked — the schema says `type:
      // 'array'`, and the harness joins whatever it gets (applyAskElicitationResponse).
      content[q.key] = q.multi ? values : values[0]!;
    }
    return { action: 'accept', content };
  }

  /** Button click: resolve the matching model menu, effort menu, directory menu, settings menu, pending ask, or picker; otherwise ignore. */
  private onButton(ev: ButtonInteraction): void {
    // Prefixes are pairwise non-prefixing (`vtx:`/`mdl:`/`mpg:`/`eff:`/`wdr:`/`wdp:`/`stg:`/`stv:`/
    // `stp:`/`stb:`/`cmd:`/`ask:`), so this order is for readability, not correctness.
    if (this.voice.onClick(ev)) return;
    const model = parseModelButtonId(ev.buttonId);
    if (model) {
      this.onModelClick(ev, model);
      return;
    }
    const effort = parseEffortButtonId(ev.buttonId);
    if (effort) {
      void this.onEffortClick(ev, effort);
      return;
    }
    const workdir = parseWorkdirButtonId(ev.buttonId);
    if (workdir) {
      this.onWorkdirClick(ev, workdir);
      return;
    }
    const agentClick = parseAgentButtonId(ev.buttonId);
    if (agentClick) {
      this.onAgentClick(ev, agentClick);
      return;
    }
    const setting = parseSettingButtonId(ev.buttonId);
    if (setting) {
      this.onSettingClick(ev, setting);
      return;
    }
    const schedule = parseScheduleButtonId(ev.buttonId);
    if (schedule) {
      this.onScheduleClick(ev, schedule);
      return;
    }
    const pick = parsePickButtonId(ev.buttonId);
    if (pick) {
      this.onPickClick(ev, pick);
      return;
    }
    const parsed = parseAskButtonId(ev.buttonId);
    if (!parsed) return;
    const pending = this.pendingAsks.get(parsed.reqId);
    if (!pending) return;
    this.onAskClick(parsed.reqId, parsed.index, pending);
  }

  /**
   * A tap on a question's own buttons — the answer, or one tick of a multi-select round.
   *
   * The index decides which, and `pending.selected` decides how to read it: on a single-select
   * question the first tap IS the answer, while on a multi-select one every option toggles and
   * only the Done button (the one index past the options) resolves. Out-of-range indices are
   * ignored rather than clamped — they can only come from a button this question never drew.
   */
  private onAskClick(reqId: string, index: number, pending: PendingAsk): void {
    const { labels, selected } = pending;
    if (!selected) {
      if (index >= labels.length) return;
      const label = labels[index]!; // bounds-checked above (index < labels.length)
      this.settleAsk(reqId, { kind: 'option', labels: [label] }, `→ Selected: ${label}`);
      return;
    }
    if (index > labels.length) return;
    if (index < labels.length) {
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      this.redrawAsk(reqId, pending);
      return;
    }
    if (selected.size === 0) {
      // Done with nothing ticked has no answer to give, and doing nothing at all would read as the
      // bot ignoring the tap — so say what is missing and leave the question up.
      this.redrawAsk(reqId, pending, MULTI_EMPTY_NOTE);
      return;
    }
    // Tick ORDER is not the answer's order: the options' own order is what the agent listed and
    // what its rationales read in, so a user who tapped bottom-up gets the same answer as one who
    // tapped top-down.
    const chosen = [...selected].sort((a, b) => a - b).map((i) => labels[i]!);
    this.settleAsk(reqId, { kind: 'option', labels: chosen }, `→ Selected: ${chosen.join(', ')}`);
  }

  /**
   * Repaint a live multi-select question after a tick moved (best-effort, like every other
   * cosmetic edit here).
   *
   * A failed repaint leaves the ticks stale on screen but costs no answer: the selection itself
   * lives in `pending.selected`, which the click handler owns, so Done still resolves with what was
   * actually tapped.
   */
  private redrawAsk(reqId: string, pending: PendingAsk, note?: string): void {
    const body = `${pending.prompt}\n\n${MULTI_HINT}${note ? `\n${note}` : ''}`;
    void pending.adapter
      .editButtons(pending.ref, body, buildAskButtons(reqId, pending.labels, pending.selected))
      .catch((err) =>
        console.warn(
          `[ask] ${pending.conversationId ?? reqId}: failed to repaint the selection:`,
          err instanceof Error ? err.message : err
        )
      );
  }

  /**
   * Unified inbound entry (platform message events + onCommand-synthesized command messages).
   * Cross-event dedup here (see DEDUP_TTL_MS), then hand off to the registry.
   */
  private onInbound(msg: InboundMessage): void {
    // Dedup only applies with a real messageId: it relies on the message and interaction events of one
    // `/cmd` sharing a messageId. When messageId is empty (e.g. Slack slash), distinct events would
    // collide on the empty-string key, so pass through without dedup (those platforms have no
    // message/interaction double-fire anyway).
    if (msg.messageId) {
      const now = Date.now();
      // Sweep expired dedup entries inline (count is tiny).
      for (const [k, t] of this.recentRouted) {
        if (now - t > DEDUP_TTL_MS) this.recentRouted.delete(k);
      }
      const key = `${msg.conversation.platform}:${formatAddress(addressOf(msg.conversation))}:${msg.messageId}`;
      if (this.recentRouted.has(key)) return; // same source message already routed (slash≡message platforms)
      this.recentRouted.set(key, now);
    }
    this.registry.route(msg);
  }

  /**
   * Native slash command: the daemon doesn't interpret it; it synthesizes a `/<name> <input>` inbound
   * message for the agent (command semantics, /help, etc. are the agent's job). The real answer
   * streams back via the normal channel.
   */
  private onCommand(ev: CommandInteraction): void {
    console.log(
      `[slash] received native command /${ev.name} (${ev.conversation.platform} ${formatAddress(addressOf(ev.conversation))})`
    );
    // Reconstruct the raw slash text: input (our registered named param) or raw (platforms without
    // structured params, e.g. Telegram).
    const input = String(ev.options.input ?? ev.options.raw ?? '').trim();
    const content = input ? `/${ev.name} ${input}` : `/${ev.name}`;
    // The interaction carries a full ConversationRef, resolved by the same profile method as the
    // message path. That matters: the synthesized message used to be built from a bare channel id
    // with no kind and no space, so `when.chat` always read 'group' and `when.serverId` could never
    // match — a rule could route a typed message and its slash equivalent to different places.
    const msg: InboundMessage = {
      conversation: ev.conversation,
      messageId: ev.messageId,
      content,
      timestamp: Date.now(),
      // An explicit command invocation is a directed trigger: set mentionedSelf to bypass the
      // "server channel needs @" gate.
      mentionedSelf: true,
    };
    this.onInbound(msg);
    // Acknowledge only where the platform requires it to close out the interaction (Discord's
    // auto-DEFERRED response needs a followup or the UI reads "the application did not respond").
    // Where slash arrives as an ordinary message the receipt is pure noise — the agent's own reply
    // is already on its way — so it is skipped. Best-effort; failures only logged.
    if (this.platforms.get(ev.conversation.platform)?.capabilities.slashNeedsAck) {
      void ev.reply(`▸ /${ev.name}`).catch((e) =>
        console.error('[slash] interaction acknowledgement failed:', e instanceof Error ? e.message : e)
      );
    }
  }

  /**
   * An agent reported its command list: record it under that agent (empty clears the entry).
   *
   * Keyed by agent rather than by session because the list is a property of the harness and its
   * configuration — every session of one agent reports the same set, and the previous per-session
   * keying made the newest report look like a change to the menu. Registration no longer depends on
   * this at all; it only feeds the harness pickers.
   */
  private onAgentCommands(agentId: string, cmds: AgentCommand[]): void {
    if (cmds.length === 0) this.agentCommands.delete(agentId);
    else this.agentCommands.set(agentId, cmds);
  }

  /**
   * `/skills` — post the skills installed for the bound agent, read off disk.
   *
   * Disk rather than the agent's own ACP report, because the report only exists once a session has
   * been built and the daemon holds it in memory: every restart emptied it, so the first `/skills`
   * after an update answered "has not reported any commands" (seen 2026-09-11, on the deploy of
   * this very feature). See skills-scan.ts for what is read and the coupling that buys.
   *
   * The conversation's own directory is used, not the agent's root, so a `/cd`-ed conversation sees
   * that project's skills — the same directory its next session will start in.
   */
  private onSkillsRequest(conversationId: ConversationId, agentId: string, msg: InboundMessage): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const address = addressOf(msg.conversation);

    const def = findAgent(this.config, agentId);
    const label = agentDisplayName(def, agentId);

    void (async () => {
      const { dirs, found } = await this.findSkills(def, conversationId);

      const body = found.length === 0 ? formatEmptyCatalog(label, dirs) : formatSkillCatalog(label, found);
      console.log(`[skills] ${label}: ${found.length} from ${dirs.length} dir(s)`);

      // The one gateway reply whose length scales with somebody else's config, so the one that has
      // to chunk. splitIntoChunks is what the stream path uses, so a long list breaks the same way
      // a long answer does rather than inventing a second rule.
      const limit = adapter.capabilities.maxMessageLength;
      const parts = limit > 0 ? splitIntoChunks(body, limit) : [body];
      for (const part of parts) await adapter.sendMessage(address, part);
    })().catch((e) => console.error('[skills] reply failed:', e instanceof Error ? e.message : e));
  }

  /** The skill directories `/skills` reads for an agent, and what is in them — on its host, if remote. */
  private async findSkills(
    def: AgentDef | undefined,
    conversationId: ConversationId
  ): Promise<{ dirs: string[]; found: Awaited<ReturnType<typeof scanSkillDirs>> }> {
    const host = remoteHosts.hostFor(def);
    if (def && host) {
      const w = await host.ready();
      const home = remoteAgentHome(def, w);
      const cwd = expandRemoteHome(resolveConversationCwd(def, conversationId, this.store), w.home);
      const env = remoteAgentEnv(def);
      const configured = def.harness === 'opencode' ? await remoteOpencodeSkillDirs(host, home, env) : [];
      const dirs = skillDirsFor(def, { home, cwd, configured });
      return { dirs, found: await scanRemoteSkillDirs(host, dirs) };
    }
    const home = agentHome(def);
    const cwd = def ? resolveConversationCwd(def, conversationId, this.store) : home;
    const configured = def?.harness === 'opencode' ? await opencodeSkillDirs(home, process.env) : [];
    const dirs = skillDirsFor(def, { home, cwd, configured });
    return { dirs, found: await scanSkillDirs(dirs) };
  }

  /**
   * A bare agent command (`/cc`, `/oc`) was invoked: post that agent's own commands as buttons.
   *
   * Only the commands the agent actually reported are offered — no guessed list. Ones already
   * reachable through the generic vocabulary are filtered out, since they have a top-level entry.
   */
  private onPickerRequest(conversationId: ConversationId, agentId: string, msg: InboundMessage): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const address = addressOf(msg.conversation);
    const send = (text: string): void => {
      void adapter
        .sendMessage(address, text)
        .catch((e) => console.error('[picker] reply failed:', e instanceof Error ? e.message : e));
    };

    const def = findAgent(this.config, agentId);
    const label = agentDisplayName(def, agentId);
    // The command to name in a "try again" hint is the registered one, not the harness name.
    const cmd = harnessCommandName(def?.harness) ?? label;
    const reported = this.agentCommands.get(agentId);
    if (!reported || reported.length === 0) {
      // Truthful about the cause rather than showing an empty menu: the list arrives over ACP once a
      // session exists, and spawning an agent subprocess merely to populate a menu is a worse trade.
      // Names the binding too, since a bare `/oc` is also how a user switches agents.
      send(
        `▸ this conversation is now answered by ${label}.\nNo command list from it yet — send it a message first, then /${cmd} again.`
      );
      return;
    }

    // Drop names already reachable generically (a second entry for the same thing is noise), and
    // any the platform would reject.
    const generic = genericNativeNames(def?.harness);
    const offered = reported.filter((c) => !generic.has(c.name) && agentCommandToSpec(c) !== null);
    if (offered.length === 0) {
      send(`${label} reports no commands beyond the ones already in the menu.`);
      return;
    }

    // Buttons are capped (Discord allows 25 per message); the remainder is listed as text rather
    // than silently dropped, and stays invokable by typing.
    const shown = offered.slice(0, PICKER_BUTTON_MAX);
    const overflow = offered.slice(PICKER_BUTTON_MAX);
    const reqId = randomUUID().slice(0, 8);
    this.pendingPicks.set(reqId, {
      conversationId,
      names: shown.map((c) => c.name),
      conversation: msg.conversation,
    });

    let prompt = `${label} commands:`;
    if (overflow.length > 0) {
      prompt += `\n\n${overflow.length} more (type them directly): ${overflow.map((c) => `/${c.name}`).join(', ')}`;
    }
    const buttons = shown.map((c, i) => ({ id: `${PICK_PREFIX}${reqId}:${i}`, label: `/${c.name}` }));
    void adapter
      .sendButtons(address, prompt, buttons)
      .then((ref) => {
        // Keep the menu's own ref: the click ack edits this message, and the click event's
        // messageId is not a reliable stand-in on every platform.
        const pending = this.pendingPicks.get(reqId);
        if (pending) pending.ref = ref;
      })
      .catch((e) => {
        this.pendingPicks.delete(reqId);
        console.error('[picker] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /**
   * A picker button was clicked: run that command in the session the menu was opened for.
   *
   * Delivered straight to the recorded session, NOT re-routed: a bare `/init` carries no agent
   * prefix, so routing would send it to `routing.default` — the exact misdelivery this design
   * removes. The clicker is re-checked against the allowlist because a button in a shared channel
   * can be pressed by someone other than the person who opened the menu.
   */
  private onPickClick(ev: ButtonInteraction, parsed: { reqId: string; index: number }): void {
    const pick = this.pendingPicks.get(parsed.reqId);
    if (!pick) {
      // A menu the daemon no longer knows about: it was already used (one-shot), or the daemon
      // restarted since it was posted (pendingPicks is in-memory). Say so — returning silently is
      // indistinguishable from a broken button, which is how this surfaced as "I click and nothing
      // happens". Answered where the click happened, since the recorded conversation is gone too.
      console.log(`[picker] click on an expired menu (${parsed.reqId})`);
      void this.platforms
        .get(ev.conversation.platform)
        ?.sendMessage(
          addressOf(ev.conversation),
          'That menu has expired (already used, or the gateway restarted). Re-open it with the agent command (`/oc`, `/cc`, …), or /help for the full list.'
        )
        .catch(() => undefined);
      return;
    }
    const name = pick.names[parsed.index];
    if (name === undefined) return;

    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied picker click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    // One-shot: a menu button runs once, so drop it rather than let a stale menu be re-clicked.
    this.pendingPicks.delete(parsed.reqId);
    const platformId = pick.conversation.platform;
    const address = addressOf(pick.conversation);
    const delivered = this.registry.dispatchTo(pick.conversationId, {
      // The menu's own conversation, with the clicker as sender: the command must run where the
      // menu was posted, by whoever pressed it.
      conversation: { ...pick.conversation, user: clicker.user },
      messageId: ev.messageId,
      content: `/${name}`,
      timestamp: Date.now(),
      // A click is an explicit, directed invocation: bypass the "server channel needs @" gate.
      mentionedSelf: true,
    });
    if (!delivered) {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, `That conversation is gone — send a message first, then run /${name}.`)
        .catch(() => undefined);
      return;
    }
    // Ack on the menu message itself (captured at send). Falls back to the click's own messageId
    // only when the send never reported one.
    const ackRef = pick.ref ?? { address, messageId: ev.messageId };
    void this.platforms
      .get(platformId)
      ?.editMessage(ackRef, `→ /${name}`)
      .catch((e) => console.warn('[picker] click ack edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A bare `/model` on a platform that can carry a menu: post the first page of the model list.
   *
   * Opened on the page holding the CURRENT model rather than always page one — the question behind
   * `/model` is usually "what am I on, and what else is there", and answering the first half by
   * making the user page to it is a poor trade for one line of arithmetic.
   */
  private onModelMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    msg: InboundMessage,
    selector: ModelSelector
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;

    // One live menu per conversation (see pendingModelMenus): retire the previous one before
    // posting, so its buttons cannot keep answering for a list the user has moved on from.
    this.retireModelMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    // Copied, not referenced: the harness owns that array and may rebuild it mid-session.
    const options = [...selector.options];
    const pageSize = resolvePageSize(adapter.capabilities.menuPageSize);
    const pending: PendingModelMenu = {
      conversationId,
      agentId,
      conversation: msg.conversation,
      options,
      current: selector.current,
      pageSize,
    };
    this.pendingModelMenus.set(reqId, pending);

    const index = modelIndexOf(options, selector.current);
    const view = buildModelMenu({
      reqId,
      options,
      current: selector.current,
      page: index >= 0 ? modelPageOf(index, pageSize) : 0,
      pageSize,
    });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        // Keep the menu's own ref: page turns and the ack both edit THIS message, and the click
        // event's messageId is not a reliable stand-in on every platform (Telegram reports the
        // callback_query id there).
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingModelMenus.delete(reqId);
        console.error('[model] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** Retire every live menu of one conversation, saying so on the message rather than going quiet. */
  private retireModelMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingModelMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, modelMenuSupersededText(menu.current), []);
    }
  }

  /**
   * Best-effort in-place edit of a menu message. Menu edits are `void`-and-`catch` like every other
   * cosmetic side effect here — a failed edit must never take down the click that caused it.
   *
   * An EMPTY button array is how a menu is retired: `editMessage` would leave the buttons on Slack
   * and Lark (only Discord and Telegram drop components on a text-only edit), which is the whole
   * reason editButtons exists.
   */
  private editModelMenu(
    menu: PendingModelMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      // The send has not resolved yet — a microsecond window, but editing ev.messageId instead
      // would address the wrong thing on Telegram. Say nothing on the message, log the cause.
      console.warn('[model] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[model] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A model-menu button was clicked: turn the page, or switch the model.
   *
   * The clicker is re-checked against the allowlist first, because a menu in a shared channel can
   * be pressed by someone other than the person who opened it — and unlike a picker click, this one
   * changes which model answers for everyone in that conversation.
   */
  private onModelClick(ev: ButtonInteraction, click: ModelButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied model-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingModelMenus.get(click.reqId);
    if (!menu) {
      // Superseded, already used, or the daemon restarted (this map is in-memory). Answered where
      // the click happened, since the recorded conversation may be gone too — a silent return is
      // indistinguishable, from the chat, from a broken button.
      console.log(`[model] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    if (click.kind === 'page') {
      const view = buildModelMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: click.page,
        pageSize: menu.pageSize,
      });
      this.editModelMenu(menu, view.text, view.buttons);
      return;
    }
    void this.onModelPickClick(ev, click.reqId, menu, click.index);
  }

  /** A model button was clicked: apply it, then say what happened on the menu itself. */
  private async onModelPickClick(
    ev: ButtonInteraction,
    reqId: string,
    menu: PendingModelMenu,
    index: number
  ): Promise<void> {
    const option = menu.options[index];
    if (!option) {
      // Only reachable from a mangled id (Telegram hashes callback_data over 64 bytes). Our ids are
      // ~16, so this is defence, not an expected path — and it still gets an answer.
      console.warn(`[model] click index ${index} is outside the menu's ${menu.options.length} options`);
      this.replyToClick(ev, modelMenuExpiredText());
      return;
    }

    const result = await this.registry.applyModelChoice(menu.conversationId, menu.agentId, option.value);
    const text = modelChoiceText(result);
    console.log(`[model] ${menu.conversationId}: ${option.value} → ${result.kind}`);

    // Retire the menu when it can no longer be trusted or is no longer wanted: a successful switch
    // moves the ● marker, and gone/rebound/missing all mean the snapshot no longer describes
    // anything real. A transient refusal keeps the menu, so retrying is one tap.
    const retire =
      result.kind === 'applied' ||
      result.kind === 'gone' ||
      result.kind === 'rebound' ||
      result.kind === 'missing';
    if (retire) {
      this.pendingModelMenus.delete(reqId);
      this.editModelMenu(menu, text, []);
      return;
    }
    const view = buildModelMenu({
      reqId,
      options: menu.options,
      current: menu.current,
      page: modelPageOf(index, menu.pageSize),
      pageSize: menu.pageSize,
    });
    this.editModelMenu(menu, `${view.text}\n\n${text}`, view.buttons);
  }

  /** Answer where a click happened (not where the menu lives) — used when the menu is gone. */
  private replyToClick(ev: ButtonInteraction, text: string): void {
    void this.platforms
      .get(ev.conversation.platform)
      ?.sendMessage(addressOf(ev.conversation), text)
      .catch((e) => console.warn('[menu] failed to answer a click:', e instanceof Error ? e.message : e));
  }

  /**
   * A bare `/effort` on a platform that can carry a menu: post the levels, ● on the current one.
   *
   * The model menu's shape without its paging (see PendingEffortMenu) — including "one live menu
   * per conversation", so a second `/effort` retires the first rather than leaving two sets of live
   * buttons that disagree about where the ● is.
   */
  private onEffortMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    msg: InboundMessage,
    selector: EffortSelector
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    this.retireEffortMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    // Copied, not referenced: the list is the harness's, and a `/model` rebuilds it.
    const options = [...selector.options];
    const pending: PendingEffortMenu = {
      conversationId,
      agentId,
      conversation: msg.conversation,
      options,
      current: selector.current,
    };
    this.pendingEffortMenus.set(reqId, pending);

    const view = buildEffortMenu({ reqId, options, current: selector.current });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        // The menu's own ref, for the reason onModelMenuRequest keeps one: the click's messageId
        // is the callback_query id on Telegram, not the message.
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingEffortMenus.delete(reqId);
        console.error('[effort] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** Retire every live effort menu of one conversation, saying so on the message. */
  private retireEffortMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingEffortMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingEffortMenus.delete(reqId);
      this.editEffortMenu(menu, effortMenuSupersededText(menu.current), []);
    }
  }

  /** Best-effort in-place edit of an effort menu; an empty button array retires it (see editModelMenu). */
  private editEffortMenu(
    menu: PendingEffortMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[effort] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[effort] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * An effort button was clicked: apply it, then say what happened on the menu itself.
   *
   * The clicker is re-checked against the allowlist first, as for the model menu: a menu in a shared
   * channel can be pressed by anyone in it, and this changes how every later turn there is run.
   */
  private async onEffortClick(ev: ButtonInteraction, click: EffortButtonClick): Promise<void> {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied effort-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingEffortMenus.get(click.reqId);
    const option = menu?.options[click.index];
    if (!menu || !option) {
      // Superseded, already used, restarted — or a mangled index, which can only come from an id
      // this menu never drew. Answered where the click happened, never silently.
      console.log(`[effort] click on an expired menu (${click.reqId}:${click.index})`);
      this.replyToClick(ev, effortMenuExpiredText());
      return;
    }

    const result = await this.registry.applyEffortChoice(menu.conversationId, menu.agentId, option.value);
    const text = effortChoiceText(result);
    console.log(`[effort] ${menu.conversationId}: ${option.value} → ${result.kind}`);

    // Only a refusal keeps the menu up, so a retry is one tap. Every other outcome either moved the
    // ● or means the snapshot describes nothing real any more — including `unavailable`, which here
    // is not the model menu's transient "no session yet" but "this model has no levels at all".
    if (result.kind !== 'failed') {
      this.pendingEffortMenus.delete(click.reqId);
      this.editEffortMenu(menu, text, []);
      return;
    }
    const view = buildEffortMenu({ reqId: click.reqId, options: menu.options, current: menu.current });
    this.editEffortMenu(menu, `${view.text}\n\n${text}`, view.buttons);
  }

  /**
   * A directory menu is wanted here: post the page holding the CURRENT directory.
   *
   * Opened on that page rather than page one for the reason onModelMenuRequest is: half the question
   * is "where am I", and answering it by making the user page to the ● marker is a poor trade for
   * one line of arithmetic.
   *
   * The truncation notice is appended rather than folded into the menu text, because a scan that hit
   * the cap is an unusual state and the sentence describing it should not be paid for on every
   * normal menu (core/workdir-menu.ts owns the normal one).
   */
  private onWorkdirMenuRequest(
    conversationId: ConversationId,
    agentId: string,
    conv: ConversationRef,
    menu: { options: WorkdirOption[]; current: string; truncated: number }
  ): void {
    const adapter = this.platforms.get(conv.platform);
    if (!adapter) return;

    // One live menu per conversation: retire the previous one before posting, so its buttons cannot
    // keep answering for a list the user has moved on from.
    this.retireWorkdirMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    // Copied, not referenced: the scan's array must not be shared with a later scan's.
    const options = [...menu.options];
    const pageSize = resolvePageSize(adapter.capabilities.menuPageSize);
    const pending: PendingWorkdirMenu = {
      conversationId,
      agentId,
      conversation: conv,
      options,
      current: menu.current,
      pageSize,
    };
    this.pendingWorkdirMenus.set(reqId, pending);

    const index = workdirIndexOf(options, menu.current);
    const view = buildWorkdirMenu({
      reqId,
      options,
      current: menu.current,
      page: index >= 0 ? workdirPageOf(index, pageSize) : 0,
      pageSize,
    });
    const text =
      menu.truncated > 0
        ? `${view.text}\n(+${menu.truncated} more not shown — type part of a name instead.)`
        : view.text;
    void adapter
      .sendButtons(addressOf(conv), text, view.buttons)
      .then((ref) => {
        // Keep the menu's own ref: page turns and the ack both edit THIS message, and the click
        // event's messageId is not a reliable stand-in on every platform.
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingWorkdirMenus.delete(reqId);
        console.error('[workdir] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** Retire every live directory menu of one conversation, saying so rather than going quiet. */
  private retireWorkdirMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingWorkdirMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingWorkdirMenus.delete(reqId);
      this.editWorkdirMenu(menu, workdirMenuSupersededText(menu.current), []);
    }
  }

  /** Best-effort in-place edit of a directory menu; an empty button array retires it (see editModelMenu). */
  private editWorkdirMenu(
    menu: PendingWorkdirMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[workdir] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[workdir] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A directory-menu button was clicked: turn the page, or move the conversation.
   *
   * The clicker is re-checked against the allowlist first, for the reason onModelClick is — a menu
   * in a shared channel can be pressed by someone other than whoever opened it, and this one does
   * more than change an answer: it ends the session everyone in that conversation was using.
   */
  private onWorkdirClick(ev: ButtonInteraction, click: WorkdirButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied workdir-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingWorkdirMenus.get(click.reqId);
    if (!menu) {
      // Superseded, already used, or the daemon restarted (this map is in-memory). Answered where
      // the click happened: a silent return is indistinguishable, from the chat, from a dead button.
      console.log(`[workdir] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, workdirMenuExpiredText());
      return;
    }

    if (click.kind === 'page') {
      const view = buildWorkdirMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: click.page,
        pageSize: menu.pageSize,
      });
      this.editWorkdirMenu(menu, view.text, view.buttons);
      return;
    }

    const option = menu.options[click.index];
    if (!option) {
      // Only reachable from a mangled id (Telegram hashes callback_data over 64 bytes); ours are
      // ~16, so this is defence rather than an expected path — and it still gets an answer.
      console.warn(`[workdir] click index ${click.index} is outside the menu's ${menu.options.length} options`);
      this.replyToClick(ev, workdirMenuExpiredText());
      return;
    }

    const result = this.registry.applyWorkdirChoice(menu.conversationId, menu.agentId, option.path);
    const text = workdirChoiceText(result);
    console.log(`[workdir] ${menu.conversationId}: ${option.path} → ${result.kind}`);

    // Every outcome except a failed write retires the menu. `applied` ended the session the menu
    // described; `unchanged` answered it; `rebound` and `missing` mean the snapshot no longer
    // describes anything real. Only a `failed` write is worth a second tap.
    if (result.kind === 'failed') {
      const view = buildWorkdirMenu({
        reqId: click.reqId,
        options: menu.options,
        current: menu.current,
        page: workdirPageOf(click.index, menu.pageSize),
        pageSize: menu.pageSize,
      });
      this.editWorkdirMenu(menu, `${view.text}\n\n${text}`, view.buttons);
      return;
    }
    this.pendingWorkdirMenus.delete(click.reqId);
    this.editWorkdirMenu(menu, text, []);
  }

  /** `/agent` on a platform with buttons: post the grouped menu (core/agent-menu.ts). */
  private onAgentMenuRequest(
    conversationId: ConversationId,
    msg: InboundMessage,
    menu: { groups: AgentGroup[]; current: string | undefined }
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    for (const [reqId, old] of this.pendingAgentMenus) {
      if (old.conversationId !== conversationId) continue;
      this.pendingAgentMenus.delete(reqId);
      this.editAgentMenu(old, 'This menu was replaced by a newer one.', []);
    }
    const reqId = randomUUID().slice(0, 8);
    const pending: PendingAgentMenu = {
      conversationId,
      conversation: msg.conversation,
      groups: menu.groups.map((g) => ({ ...g, agents: [...g.agents] })),
      current: menu.current,
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
    };
    this.pendingAgentMenus.set(reqId, pending);
    const view = buildAgentMenu({ reqId, groups: pending.groups, current: pending.current, pageSize: pending.pageSize });
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        pending.ref = ref;
      })
      .catch((e) => {
        this.pendingAgentMenus.delete(reqId);
        console.error('[agent] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  private editAgentMenu(menu: PendingAgentMenu, text: string, buttons: Array<{ id: string; label: string }>): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter || !menu.ref) return;
    void adapter
      .editButtons(menu.ref, text, buttons)
      .catch((e) => console.warn('[agent] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * An `/agent` button: move between the machine and agent levels, or choose. The clicker is
   * checked against the allowlist like every menu that changes who answers (see onWorkdirClick).
   */
  private onAgentClick(ev: ButtonInteraction, click: AgentButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied agent-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }
    const menu = this.pendingAgentMenus.get(click.reqId);
    if (!menu) {
      this.replyToClick(ev, 'That menu has expired — send /agent again.');
      return;
    }
    const render = (group?: number, page?: number): void => {
      const view = buildAgentMenu({ reqId: click.reqId, groups: menu.groups, current: menu.current, group, page, pageSize: menu.pageSize });
      this.editAgentMenu(menu, view.text, view.buttons);
    };
    if (click.kind === 'group') return render(click.group);
    if (click.kind === 'back') return render();
    if (click.kind === 'page') return render(click.group, click.page);
    const def = flatAgents(menu.groups)[click.index];
    this.pendingAgentMenus.delete(click.reqId);
    const text = def ? this.registry.chooseAgent(menu.conversationId, def.id, menu.conversation) : 'That agent is no longer configured.';
    this.editAgentMenu(menu, text, []);
    // Then where it should work, as a typed `/agent <id>` asks — a pick from the menu is the same choice.
    if (def) this.registry.offerPlacement(menu.conversationId, def.id, menu.conversation);
  }

  /**
   * A `/setting` on a platform that can carry a menu: post the settings screen.
   *
   * `menu.open` lands straight on one setting's values, because `/setting idle` already said which
   * one — making the user tap through a list to the thing they just named is a step for nothing.
   */
  private onSettingMenuRequest(
    conversationId: ConversationId,
    msg: InboundMessage,
    menu: {
      rows: SettingRow[];
      open?: { row: SettingRow; options: SettingOption[]; hint?: string };
      asking?: Promise<unknown>;
    }
  ): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;

    // One live menu per conversation: retire the previous one before posting, so its buttons cannot
    // keep writing config.yaml on behalf of a screen the user has moved on from.
    this.retireSettingsMenusFor(conversationId);

    const reqId = randomUUID().slice(0, 8);
    const pending: PendingSettingsMenu = {
      conversationId,
      conversation: msg.conversation,
      // Copied, not referenced: the caller built these from the live config and may rebuild them.
      rows: [...menu.rows],
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
      ...(menu.open ? { open: { ...menu.open, options: [...menu.open.options] } } : {}),
    };
    this.pendingSettingsMenus.set(reqId, pending);

    const view = this.renderSettingsMenu(reqId, pending);
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons, view.screen)
      .then((ref) => {
        // Keep the menu's own ref: every level change edits THIS message, and the click event's
        // messageId is not a reliable stand-in on every platform (Telegram reports the
        // callback_query id there).
        pending.ref = ref;
        // After the ref, since the redraw is an edit of this message.
        if (menu.asking) this.whenModelsArrive(reqId, pending, menu.asking);
      })
      .catch((e) => {
        this.pendingSettingsMenus.delete(reqId);
        console.error('[setting] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /** The view for whichever level a settings menu is on, plus an optional line above it. */
  private renderSettingsMenu(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    ack?: SettingsAck
  ): { text: string; buttons: Array<{ id: string; label: string }>; screen?: SettingsScreen } {
    // Only a platform that draws a screen asks for the structured form; every chat platform gets
    // exactly the text and buttons it has always had (adapter.ts settingsScreen).
    const wantsScreen =
      this.platforms.get(menu.conversation.platform)?.capabilities.settingsScreen === true;
    const notice = ack ? { tone: ack.tone, text: ack.text } : undefined;
    const open = menu.open;
    const view = open
      ? buildSettingValueMenu({
          reqId,
          row: open.row,
          options: open.options,
          // A screen is one list the page filters as it is typed into (opencode offers ~90 models),
          // not pages of 24: paging is a chat app's answer to a message's button cap.
          page: wantsScreen ? 0 : page,
          pageSize: wantsScreen ? Math.max(1, open.options.length) : menu.pageSize,
          ...(open.hint ? { hint: open.hint } : {}),
          ...(wantsScreen ? { screen: this.valueScreenInput(open.row, notice) } : {}),
        })
      : buildSettingsMenu({
          reqId,
          rows: menu.rows,
          // The way into the scheduled tasks, after the settings themselves (core/schedule-menu.ts).
          ...(this.schedules ? { extra: { id: scheduleOpenButtonId(reqId), label: scheduleEntryLabel(this.schedules.tasks()) } } : {}),
          ...(wantsScreen ? { screen: this.listScreenInput(menu, notice) } : {}),
        });
    // The list just drawn is the one its `sts:` ids index; a value level draws none.
    if (!menu.open) {
      if (view.choices) menu.choices = view.choices;
      else delete menu.choices;
    }
    return {
      text: ack ? `${ack.text}\n\n${view.text}` : view.text,
      buttons: view.buttons,
      ...(view.screen ? { screen: view.screen } : {}),
    };
  }

  /** What the list screen needs beyond the rows (core/settings.ts SettingsScreenInput). */
  private listScreenInput(menu: PendingSettingsMenu, notice?: SettingsAck): SettingsScreenInput {
    return {
      cfg: this.config,
      options: (row: SettingRow) => this.registry.settingOptionsFor(menu.conversationId, row, false).options,
      here: this.registry.settingsBoundAgent(menu.conversationId),
      ...(notice ? { notice } : {}),
    };
  }

  /** What a value screen needs beyond the options: the config, the ack, and whether it is still asking. */
  private valueScreenInput(row: SettingRow, notice?: SettingsAck): { cfg: Config; notice?: SettingsAck; loading?: boolean } {
    // The review model asks the reviewer's list (modelListAgent), so its screen must spin for the
    // same reason a per-agent row does — otherwise it says "no list" while the ask is still running.
    const listAgent = modelListAgent(row, this.config);
    const loading = listAgent !== undefined && this.registry.modelListLoading(listAgent);
    return { cfg: this.config, ...(notice ? { notice } : {}), ...(loading ? { loading } : {}) };
  }

  /** Retire every live settings menu of one conversation, saying so rather than going quiet. */
  private retireSettingsMenusFor(conversationId: ConversationId): void {
    for (const [reqId, menu] of this.pendingSettingsMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingSettingsMenus.delete(reqId);
      this.editSettingsMenu(menu, settingsMenuSupersededText(), []);
    }
    // A task menu is the same screen one level down: the one-live-menu rule covers it too.
    for (const [reqId, menu] of this.pendingScheduleMenus) {
      if (menu.conversationId !== conversationId) continue;
      this.pendingScheduleMenus.delete(reqId);
      this.editMenuMessage(menu, settingsMenuSupersededText(), []);
    }
  }

  /**
   * Best-effort in-place edit of a settings menu. `void`-and-`catch` like every other cosmetic side
   * effect here — a failed edit must never take down the click that caused it, and least of all
   * after the write it was reporting already succeeded.
   */
  private editSettingsMenu(
    menu: PendingSettingsMenu,
    text: string,
    buttons: Array<{ id: string; label: string }>,
    screen?: SettingsScreen
  ): void {
    this.editMenuMessage(menu, text, buttons, screen);
  }

  /** The in-place edit both the settings menu and the task menu use (they share a message). */
  private editMenuMessage(
    menu: { conversation: ConversationRef; ref?: MessageRef },
    text: string,
    buttons: Array<{ id: string; label: string }>,
    screen?: SettingsScreen
  ): void {
    const adapter = this.platforms.get(menu.conversation.platform);
    if (!adapter) return;
    if (!menu.ref) {
      console.warn('[setting] menu has no message ref yet; skipping the edit');
      return;
    }
    void adapter
      .editButtons(menu.ref, text, buttons, screen)
      .catch((e) => console.warn('[setting] menu edit failed:', e instanceof Error ? e.message : e));
  }

  /**
   * A settings-menu button was clicked: open a setting, write a value, turn a page, or go back.
   *
   * The clicker is re-checked against the allowlist first — a menu in a shared channel can be
   * pressed by someone other than whoever opened it, and this one does not merely change what
   * answers a conversation: it edits the operator's config.yaml.
   *
   * (Where `allowFrom` is empty there is nothing to check, and nothing new is granted either:
   * agents already run with full tool access, so anyone who can message the bot can already edit
   * that file directly. See AGENTS.md security invariant #1.)
   */
  private onSettingClick(ev: ButtonInteraction, click: SettingButtonClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied settings-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }

    const menu = this.pendingSettingsMenus.get(click.reqId);
    if (!menu) {
      // Superseded, or the daemon restarted (this map is in-memory). Answered where the click
      // happened, since the recorded conversation may be gone too — a silent return is
      // indistinguishable, from the chat, from a broken button.
      console.log(`[setting] click on an expired menu (${click.reqId})`);
      this.replyToClick(ev, settingsMenuExpiredText());
      return;
    }

    switch (click.kind) {
      case 'open':
        this.openSettingLevel(click.reqId, menu, click.index);
        return;
      case 'choose':
        this.chooseSettingValue(click.reqId, menu, click.index);
        return;
      case 'set':
        this.setSettingFromList(click.reqId, menu, click.index);
        return;
      case 'type':
        this.typeSettingValue(click.reqId, menu, ev.value);
        return;
      case 'page':
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu, click.page));
        return;
      case 'back':
        delete menu.open;
        menu.rows = this.registry.settingRows(); // values may have changed while the level was open
        this.editSettingsMenu(menu, ...this.viewParts(click.reqId, menu));
        return;
      default: {
        // Exhaustiveness guard: a new click kind missed here fails to compile.
        const _exhaustive: never = click;
        throw new Error(`unknown settings click: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** renderSettingsMenu as positional args, so editSettingsMenu can be spread-called. */
  private viewParts(
    reqId: string,
    menu: PendingSettingsMenu,
    page = 0,
    ack?: SettingsAck
  ): [string, Array<{ id: string; label: string }>, SettingsScreen?] {
    const view = this.renderSettingsMenu(reqId, menu, page, ack);
    return [view.text, view.buttons, view.screen];
  }

  /**
   * Descend to one setting's values.
   *
   * Identity comes from the frozen row list (so a button always means the setting it was drawn for)
   * while the value and the option list are read fresh — the same freeze-identity / re-read-value
   * split the model menu uses, and the reason a menu left open across a change never shows a stale
   * number.
   */
  private openSettingLevel(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const frozen = menu.rows[index];
    if (!frozen) {
      // Only reachable from a mangled id (Telegram hashes callback_data over 64 bytes). Ours are
      // ~16 bytes, so this is defence, not an expected path — and it still gets an answer.
      console.warn(`[setting] click index ${index} is outside the menu's ${menu.rows.length} rows`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const rows = this.registry.settingRows();
    const row = rows.find((r) => r.id === frozen.id && r.target === frozen.target) ?? frozen;
    const { options, hint, asking } = this.registry.settingOptionsFor(menu.conversationId, row);
    menu.rows = rows;
    menu.open = { row, options, ...(hint ? { hint } : {}) };
    this.editSettingsMenu(
      menu,
      ...this.viewParts(reqId, menu, settingValuePage(row, options, menu.pageSize))
    );
    if (asking) this.whenModelsArrive(reqId, menu, asking);
  }

  /**
   * A model level opened before its list was known: redraw it once the list has been asked for —
   * if the same menu is still on the same row by then. A menu that moved on (Back, another row, a
   * newer /setting) is left as it is; the answer is kept and the next opening shows it at once.
   */
  private whenModelsArrive(reqId: string, menu: PendingSettingsMenu, asking: Promise<unknown>): void {
    const row = menu.open?.row;
    void asking.then(() => {
      const open = menu.open;
      if (this.pendingSettingsMenus.get(reqId) !== menu || !open || !row) return;
      if (open.row.id !== row.id || open.row.target !== row.target) return;
      const { options, hint } = this.registry.settingOptionsFor(menu.conversationId, open.row, false);
      menu.open = { row: open.row, options, ...(hint ? { hint } : {}) };
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, settingValuePage(open.row, options, menu.pageSize)));
    });
  }

  /**
   * A value typed on a value screen (`stt:`, the click's text): written exactly as a typed
   * `/setting <key> <value>` would be — the same parser, so a model name the list has resolves to
   * it and one it has not is taken as typed — and answered on the screen like a tapped value.
   */
  private typeSettingValue(reqId: string, menu: PendingSettingsMenu, value: string | undefined): void {
    const open = menu.open;
    if (!open) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }
    const typed = value?.trim();
    if (!typed) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, { tone: 'error', text: 'Type a value first.' }));
      return;
    }
    const result = this.registry.applySetting(menu.conversationId, open.row, typed);
    console.log(`[setting] ${menu.conversationId}: ${open.row.label} ← typed "${typed}" → ${result.kind}`);
    if (result.kind !== 'saved') {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
      return;
    }
    delete menu.open;
    menu.rows = this.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
  }

  /**
   * A value was clicked: write it, then say what happened.
   *
   * A successful write returns to the LIST level with the ack above it, so the new value is visible
   * on the row that was just changed — a settings screen that keeps working is the point, and
   * changing two things in a row is the normal case. Anything that did NOT write stays on the value
   * level instead: retrying is one tap, and a level change would suggest something happened.
   */
  private chooseSettingValue(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const open = menu.open;
    if (!open) {
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu));
      return;
    }
    const option = open.options[index];
    if (!option) {
      console.warn(`[setting] value index ${index} is outside ${open.options.length} options`);
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }

    const result = this.registry.applySetting(menu.conversationId, open.row, option.raw);
    const ack = settingNotice(result);
    console.log(`[setting] ${menu.conversationId}: ${open.row.label} ← ${option.raw} → ${result.kind}`);

    if (result.kind !== 'saved') {
      this.editSettingsMenu(
        menu,
        ...this.viewParts(reqId, menu, settingValuePage(open.row, open.options, menu.pageSize), ack)
      );
      return;
    }
    delete menu.open;
    menu.rows = this.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, ack));
  }

  /**
   * A switch or a choice on the list screen: write the value it names without opening the setting.
   *
   * The same freeze-identity / re-read-value split as openSettingLevel — the row is the one the id
   * was drawn for, read fresh — and the same write as a tapped value, so the two ways of setting
   * one cannot disagree. Whatever the outcome, the answer is the list again with the ack above it:
   * there is no value level to stay on, and the row shows what is in force either way.
   */
  private setSettingFromList(reqId: string, menu: PendingSettingsMenu, index: number): void {
    const choice = menu.open ? undefined : menu.choices?.[index];
    const frozen = choice ? menu.rows[choice.row] : undefined;
    if (!choice || !frozen) {
      console.warn(`[setting] list choice ${index} does not match the screen on this menu`);
      delete menu.open;
      this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, expiredAck()));
      return;
    }
    const row =
      this.registry.settingRows().find((r) => r.id === frozen.id && r.target === frozen.target) ?? frozen;
    const result = this.registry.applySetting(menu.conversationId, row, choice.raw);
    console.log(`[setting] ${menu.conversationId}: ${row.label} ← ${choice.raw} → ${result.kind}`);
    menu.rows = this.registry.settingRows();
    this.editSettingsMenu(menu, ...this.viewParts(reqId, menu, 0, settingNotice(result)));
  }

  // ───────────────────── scheduled tasks under /setting (core/schedule-menu.ts) ─────────────────────

  /**
   * `/setting schedule [pause|resume|delete|run <id>]`, typed. Bare, it is the task list — a menu
   * where buttons work, text elsewhere; with a verb it acts, and the task's card is the answer (the
   * same card the agent's commands post), so a text-only platform manages tasks as fully as any.
   */
  private onScheduleSetting(id: ConversationId, msg: InboundMessage, args: string[], canMenu: boolean): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const reply = (text: string): void =>
      void adapter.sendMessage(addressOf(msg.conversation), text).catch((e) => console.warn('[schedule] reply failed:', e instanceof Error ? e.message : e));
    if (!this.schedules) {
      reply('Scheduled tasks are not enabled in this gateway.');
      return;
    }
    const [verb, rawId] = args;
    if (!verb) {
      if (canMenu) this.postScheduleMenu(id, msg, adapter);
      else reply(`${taskListText(this.schedules.tasks(), this.schedules.now())}\n\nManage one with \`/setting schedule pause|resume|delete|run <id>\`.`);
      return;
    }
    const op = SCHEDULE_TYPED_OPS[verb.toLowerCase()];
    if (!op || !rawId) {
      reply('Usage: `/setting schedule` to list, or `/setting schedule pause|resume|delete|run <id>`.');
      return;
    }
    try {
      const view = this.schedules.op(rawId.replace(/^#/, ''), op, id);
      if (op === 'run') reply(`⏰ Running \`#${view.id}\` **${view.name}** now.`);
    } catch (e) {
      reply(e instanceof Error ? e.message : String(e));
    }
  }

  /** Post the task list as its own menu message (the typed route; the button route edits in place). */
  private postScheduleMenu(conversationId: ConversationId, msg: InboundMessage, adapter: PlatformAdapter): void {
    this.retireSettingsMenusFor(conversationId);
    const reqId = randomUUID().slice(0, 8);
    const menu: PendingScheduleMenu = {
      conversationId,
      conversation: msg.conversation,
      ids: [],
      pageSize: resolvePageSize(adapter.capabilities.menuPageSize),
    };
    this.pendingScheduleMenus.set(reqId, menu);
    const view = this.renderScheduleMenu(reqId, menu);
    void adapter
      .sendButtons(addressOf(msg.conversation), view.text, view.buttons)
      .then((ref) => {
        menu.ref = ref;
      })
      .catch((e) => {
        this.pendingScheduleMenus.delete(reqId);
        console.error('[schedule] failed to post the menu:', e instanceof Error ? e.message : e);
      });
  }

  /**
   * The level a task menu is on. The task is re-read on every render, so a task deleted or changed
   * elsewhere (by the agent, or a second menu) is shown as it is now — or said to be gone.
   */
  private renderScheduleMenu(reqId: string, menu: PendingScheduleMenu, prefix?: string): { text: string; buttons: Array<{ id: string; label: string }> } {
    const schedules = this.schedules!;
    const now = schedules.now();
    const withPrefix = (v: { text: string; buttons: Array<{ id: string; label: string }> }) => ({
      text: prefix ? `${prefix}\n\n${v.text}` : v.text,
      buttons: v.buttons,
    });
    if (menu.open) {
      const task = schedules.get(menu.open.id);
      if (task) {
        return withPrefix(menu.open.confirm ? buildScheduleDeleteConfirm(reqId, task) : buildScheduleTaskMenu(reqId, task, now));
      }
      prefix = `\`#${menu.open.id}\` no longer exists.${prefix ? ` ${prefix}` : ''}`;
      delete menu.open;
    }
    const list = buildScheduleListMenu(reqId, schedules.tasks(), now);
    menu.ids = list.ids;
    return withPrefix(list);
  }

  /** A task-menu button: open the list (from settings), open a task, or act on the open one. */
  private onScheduleClick(ev: ButtonInteraction, click: ScheduleMenuClick): void {
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    // Re-checked for the reason onSettingClick gives: a shared channel's menu can be tapped by anyone.
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied schedule-menu click from ${clicker.platform}:${clicker.user}`);
      return;
    }
    if (!this.schedules) return;

    if (click.kind === 'open') {
      // Handed over from the settings menu: same message, same reqId, the other map.
      const settings = this.pendingSettingsMenus.get(click.reqId);
      if (!settings) {
        this.replyToClick(ev, scheduleMenuExpiredText());
        return;
      }
      this.pendingSettingsMenus.delete(click.reqId);
      const menu: PendingScheduleMenu = {
        conversationId: settings.conversationId,
        conversation: settings.conversation,
        ids: [],
        pageSize: settings.pageSize,
        ...(settings.ref ? { ref: settings.ref } : {}),
      };
      this.pendingScheduleMenus.set(click.reqId, menu);
      this.editMenuMessage(menu, ...this.scheduleParts(click.reqId, menu));
      return;
    }

    const menu = this.pendingScheduleMenus.get(click.reqId);
    if (!menu) {
      this.replyToClick(ev, scheduleMenuExpiredText());
      return;
    }
    if (click.kind === 'task') {
      const id = menu.ids[click.index];
      if (id) menu.open = { id, confirm: false };
      this.editMenuMessage(menu, ...this.scheduleParts(click.reqId, menu));
      return;
    }
    this.onScheduleAction(click.reqId, menu, click.action);
  }

  private onScheduleAction(reqId: string, menu: PendingScheduleMenu, action: ScheduleMenuAction): void {
    const schedules = this.schedules!;
    const open = menu.open;
    let ack: string | undefined;
    switch (action) {
      case 'settings': {
        // Back up to the settings screen, on this same message.
        this.pendingScheduleMenus.delete(reqId);
        const settings: PendingSettingsMenu = {
          conversationId: menu.conversationId,
          conversation: menu.conversation,
          rows: this.registry.settingRows(),
          pageSize: menu.pageSize,
          ...(menu.ref ? { ref: menu.ref } : {}),
        };
        this.pendingSettingsMenus.set(reqId, settings);
        this.editSettingsMenu(settings, ...this.viewParts(reqId, settings));
        return;
      }
      case 'back':
        if (open?.confirm) open.confirm = false;
        else delete menu.open;
        break;
      case 'delete':
        if (open) open.confirm = true;
        break;
      case 'pause':
      case 'resume':
      case 'confirm-delete': {
        if (!open) break;
        const op = action === 'confirm-delete' ? 'remove' : action;
        try {
          // No card: this message is the answer, and posting one beside it would say it twice.
          const view = schedules.op(open.id, op, menu.conversationId, false);
          ack = `${op === 'remove' ? '🗑 Deleted' : op === 'pause' ? '⏸ Paused' : '▶ Resumed'} \`#${view.id}\` **${view.name}**.`;
          if (op === 'remove') delete menu.open;
        } catch (e) {
          ack = e instanceof Error ? e.message : String(e);
          open.confirm = false;
        }
        console.log(`[schedule] ${menu.conversationId}: ${op} #${open.id} from the menu`);
        break;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown schedule action: ${JSON.stringify(_exhaustive)}`);
      }
    }
    this.editMenuMessage(menu, ...this.scheduleParts(reqId, menu, ack));
  }

  private scheduleParts(reqId: string, menu: PendingScheduleMenu, prefix?: string): [string, Array<{ id: string; label: string }>] {
    const view = this.renderScheduleMenu(reqId, menu, prefix);
    return [view.text, view.buttons];
  }

  /**
   * Register this deployment's fixed command set on every slash-capable instance.
   *
   * Called at startup, and again by a config reload that changes the set: it derives from config
   * alone (see buildRegisteredSpecs), so unlike the previous agent-reported union nothing else can
   * change it while running. Best-effort — a failure is logged and never throws, since slash is a
   * convenience over plain-text commands.
   */
  private async registerCommands(): Promise<void> {
    // Say which agent commands exist and who each one selects. Without this the only way to tell a
    // harness apart from a missing one was to try it in chat: an unconfigured `/agy` is not
    // registered, so it reaches the bound agent as plain text and dies as an unknown command of
    // that agent's own (route() now answers it, but the log is where the cause is visible).
    const agentCmds = [
      ...agentCommandSpecs(this.config).map((s) => `/${s.name}→${agentForCommand(this.config, s.name) ?? '?'}`),
      ...routeCommandSpecs(this.config).map((s) => `/${s.name}→${routeCommandAgent(this.config, s.name) ?? '?'}`),
    ].join(' ');
    console.log(`[slash] agent commands from config: ${agentCmds || '(none)'}`);
    for (const [id, adapter] of this.platforms) {
      if (!adapter.capabilities.slashCommands) continue; // no registration support: plain-text passthrough still works
      // slashCommands=true only means "can receive slash", not "can register at runtime". Platforms with
      // canRegisterSlashAtRuntime===false (e.g. Slack: slash registered out-of-band via App panel/manifest)
      // have a no-op registerCommands, so skip it.
      if (adapter.capabilities.canRegisterSlashAtRuntime === false) {
        if (!this.skipRuntimeRegisterLogged.has(id)) {
          this.skipRuntimeRegisterLogged.add(id);
          console.log(
            `[slash] instance "${id}" requires out-of-band slash registration (App panel/manifest); skipping runtime registration; the receiving side still works.`
          );
        }
        continue;
      }
      // Per instance, because what a platform can show decides part of it (`/super`).
      const all = buildRegisteredSpecs(this.config, commandSurface(adapter));
      // Instance count cap (per-IM capability; unset = unlimited). The fixed set is far below every
      // real cap, but truncation is reported rather than silent if that ever stops being true.
      const cap = adapter.capabilities.maxSlashCommands ?? Infinity;
      let specs = all;
      if (all.length > cap) {
        const over = all.slice(cap).map((s) => s.name);
        specs = all.slice(0, cap);
        console.warn(
          `[slash] instance "${id}": command count ${all.length} exceeds the cap ${cap}; registering only the first ${cap}; ` +
            `not registered (still invokable as /cmd text): ${over.join(', ')}`
        );
      }
      try {
        // commandGuildId is discord-only (instant guild-level registration); other types register globally.
        const cfg = this.config.platforms[id];
        const guildId = cfg?.type === 'discord' ? cfg.commandGuildId : undefined;
        await adapter.registerCommands(specs, guildId ? { guildId } : undefined);
        console.log(`[slash] instance "${id}": registered ${specs.length} command(s)`);
      } catch (e) {
        console.error(`[slash] instance "${id}": registration failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}
