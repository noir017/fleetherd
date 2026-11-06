import type { AgentDef, Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { SessionTokenRegistry } from './conversation-token-registry.js';
import { beginSkillTurn, recordToolUse } from './skill-usage.js';
import {
  translateCommand,
  customOptionFor,
  buildHelpText,
  harnessCommandName,
  harnessHasPicker,
  isCliAnsweredCommand,
  isGenericCommand,
  isSessionQuery,
  needsNestedTopics,
  unconfiguredHarnessCommand,
  type CommandTranslation,
} from '../core/command-translate.js';
import { commandSurface } from './delegation.js';
import { kindForTrigger } from '../history/record.js';
import type { HistoryEvent } from '../history/record.js';
import type {
  HistoryMessage,
  HistorySessionMeta,
  HistoryStore,
  HistoryTurnEnd,
  HistoryTurnRef,
  HistoryTurnStart,
} from '../history/store.js';
import {
  parseTextCommand,
  resolveAgent,
  resolveScope,
  routeInputFromMessage,
  routeInputFromRef,
  type AgentChoice,
} from './routing.js';
import {
  addressOf,
  conversationKey,
  describeConversation,
  formatAddress,
  type ConversationAddress,
  type ConversationRef,
} from '../core/conversation.js';
import type {
  AgentCatalog,
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  AgentStatus,
  ConversationId,
  ElicitAnswer,
  PermissionAnswer,
  InboundMessage,
} from '../types.js';
import type { ConversationWorkdir, ModelPickerList, ModelPickerResult, PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentUsage } from './agent.js';
import type { EffortSelector, ModelSelector, ToolEvent, TopicActivity } from '../types.js';
import {
  effortAmbiguousText,
  effortChoiceText,
  effortMenuSurface,
  effortNoMatchText,
  effortNoSelectorText,
  effortStartFailedText,
  effortSummaryText,
  matchEfforts,
  type EffortChoiceResult,
} from '../core/effort-menu.js';
import {
  matchModels,
  modelAmbiguousText,
  modelChoiceText,
  modelMenuSurface,
  modelNoMatchText,
  modelNoSelectorText,
  modelStartFailedText,
  modelSummaryText,
  type ModelChoiceResult,
} from '../core/model-menu.js';
import {
  modelListAgent,
  resolveSettingKey,
  settingAckText,
  settingDetailText,
  settingOptions,
  settingTypedOnlyHint,
  settingUnknownKeyText,
  settingsListText,
  settingsMenuSurface,
  settingsRows,
  type PodModels,
  type SettingApplyResult,
  type SettingOption,
  type SettingRow,
  type SettingsContext,
} from '../core/settings.js';
import { SettingsStore } from './settings-store.js';
import { ModelCatalog } from './model-catalog.js';
import { configDir, readRawConfigIfExists } from '../config/load.js';
import { podAgentModels, readPods } from '../config/pods.js';
import {
  matchWorkdirs,
  workdirAmbiguousText,
  workdirChoiceText,
  workdirMenuSurface,
  workdirNoMatchText,
  workdirSummaryText,
  workdirUnreadableText,
  type WorkdirChoiceResult,
  type WorkdirOption,
} from '../core/workdir-menu.js';
import { scanWorkdirs, isDirectory, workdirScanFrom, type WorkdirScan } from './workdir-scan.js';
import { agentCatalog, agentGroups, agentListText, agentPlaceOf, matchAgent, type AgentGroup } from '../core/agent-menu.js';
import { rankByFrecency } from '../core/frecency.js';
import type { WorkdirUsageStore } from './workdir-usage.js';
import { expandHome, expandRemoteHome, resolveAgentCwd, resolveConversationCwd } from './agent-common.js';
import { join } from 'node:path';
import { formatAgyCliOutput, runAgyCliCommand, runAgyCliFor } from './agy-cli.js';
import { formatRuntimeFooter, formatTokens } from '../core/runtime-footer.js';
import { busyNote, formatUsageSnapshot } from '../core/busy-snapshot.js';
import { InboundMerger, type SoloOutcome } from '../core/inbound-merger.js';
import { fallbackTitle, generateTitle } from '../core/title-namer.js';
import { shouldRespond, type GateConfig } from '../core/inbound-gate.js';
import { CONTINUE_SENDER, DELEGATE_SENDER, SCHEDULED_SENDER, TurnRunner, type PersonWords } from './turn-runner.js';
import { StatusBoard } from './status-board.js';
import { TurnOutcomes, type KeptText } from './turn-outcomes.js';
import { TurnProgressBoard } from './turn-progress.js';
import type { LiveTurn } from './turn-progress.js';
import type { RespawnCounts } from './config-reload.js';
import {
  claudeProjectsDir,
  readCacheExpiry,
  readRemoteCacheExpiry,
  remoteClaudeProjectsDir,
  type CacheReading,
} from './claude-transcript.js';
import { remoteHosts } from './remote-hosts.js';
import type { ConversationStore } from './conversation-store.js';
import { buildChannelList } from '../core/channel-list.js';
import type { ListChannelsResult } from '../ipc/protocol.js';

/** Daemon-level context-control commands (intercepted in route(), never forwarded to the agent). */
const CONTEXT_CLEAR_RE = /^\/(new|clear)(@\S+)?$/;

/** `/help` — answered by the gateway itself (see DAEMON_COMMANDS), never forwarded to the agent. */
const HELP_RE = /^\/help(@\S+)?$/;

/** `/stop` — end the running turn without ending the conversation (the counterpart to `/new`). */
const STOP_RE = /^\/stop(@\S+)?$/;

/** `/kill` — end the agent's process without ending the conversation (see DAEMON_COMMANDS). */
const KILL_RE = /^\/kill(@\S+)?$/;

/** `/reload` — apply an edited config.yaml without a restart (see daemon/config-reload.ts). */
const RELOAD_RE = /^\/reload(@\S+)?$/;

/**
 * Spellings of the settings command the gateway answers.
 *
 * Only `setting` is registered in the platform menu (see DAEMON_COMMANDS); the other two are
 * accepted when typed but cost no menu slot — the same trade HARNESS_COMMANDS.aliases makes. They
 * exist because `/settings` is what half the world types, and `/config` is what the thing is
 * actually called on disk.
 */
const SETTING_NAMES = new Set(['setting', 'settings', 'config']);

/**
 * `/cd` — choose the directory this conversation works in. Answered by the gateway, never
 * forwarded: no harness has a slash command that could move the session it is running in.
 *
 * `cd` and `dir` both accepted, only `cd` registered (the HARNESS_COMMANDS.aliases trade): `cd` is
 * what anyone who has used a shell types, `dir` is what it is called on the button that offers it.
 */
const WORKDIR_NAMES = new Set(['cd', 'dir', 'workdir']);

/**
 * How long a directory menu offered on the side (a bare `/cc`, `/new`) waits for a remote agent's
 * root to be listed for the first time (afterRemoteListing). A listing over a live link takes well
 * under a second (armbox and uniagent, 2026-10-29); the bound is for a host that is down or
 * reconnecting, where waiting longer would only delay the answer the user gets anyway.
 */
export const REMOTE_LISTING_WAIT_MS = 5_000;

/** `/agent` — choose the agent that answers this topic, by id, from a menu grouped by machine. */
const AGENT_NAMES = new Set(['agent', 'agents']);

/**
 * `/title` — rename the chat lane this conversation lives in.
 *
 * The manual half of the automatic naming (nameConversation): the automatic one summarises the
 * opening message, and this one overrides it when the summary is wrong or the user simply wants
 * their own name on the topic. `rename` is accepted too, because that is what the action is called
 * everywhere else in a chat client.
 */
const TITLE_NAMES = new Set(['title', 'rename', 'topic']);

/**
 * `/skills` — list the bound agent's OWN commands, which the gateway menu deliberately does not
 * carry (see buildRegisteredSpecs: one fixed set, not the union of what agents report).
 *
 * Answered by the gateway rather than forwarded because the answer is gateway-held state: the list
 * arrives over ACP into `agentCommands` and the harness has no command that would print it back.
 * `skill` singular is accepted and not registered — the HARNESS_COMMANDS.aliases trade.
 */
const SKILLS_NAMES = new Set(['skills', 'skill']);

/**
 * `/setting schedule` — the scheduled tasks, reached from the settings screen. `schedules`, `tasks`
 * and `cron` are what people type for it; none is a setting key, so none can collide with one.
 */
const SCHEDULE_SETTING_NAMES = new Set(['schedule', 'schedules', 'tasks', 'cron']);

/**
 * Shape a lane name: `[<agent>] <subject>`.
 *
 * Two problems, one function.
 *
 * The tag answers "which agent is this topic": a column of topics all named after their subject
 * says nothing about who is answering in each, and that is the first thing you need when several
 * are running at once. It is the agent id (`cc`, `oc`, `dsh`, `agy`) because that is what the user
 * types to bind one.
 *
 * The stripping keeps a bracket at position zero from meaning two things at once. It was added for
 * a leak that no longer exists — the harness titles the gateway used to follow were summaries of
 * mergePrompt's output, so they carried the `[<authorName>] ` speaker prefix into the name, and a
 * topic was observed renamed to `[no id] 合并到main并重试` after the user's own Telegram name. Names
 * now come from a model given the raw message, or from `/title`, and both can still open with a
 * bracket of their own. Leading bracketed groups are removed repeatedly, which also makes the
 * function idempotent: re-titling an already-tagged name replaces the tag instead of stacking a
 * second one.
 *
 * The risk is a genuine title that opens with a bracket losing it. Accepted: the tag is prepended
 * either way, so the result stays well-formed, and it keeps the tag unambiguous.
 */
export function formatLaneTitle(agentId: string, raw: string): string {
  let subject = raw.replace(/\s+/g, ' ').trim();
  while (subject.startsWith('[')) {
    const close = subject.indexOf(']');
    if (close < 0) break;
    subject = subject.slice(close + 1).trimStart();
  }
  // Nothing but brackets: keep the original rather than emit a bare tag, which would name every
  // such conversation identically.
  if (!subject) subject = raw.replace(/\s+/g, ' ').trim();
  return `[${agentId}] ${subject}`.trim();
}

/**
 * What was running when `/stop` arrived. The first three are read off the merger; `background` is
 * what the merger cannot see — the harness re-invoked itself after a background task finished and
 * is producing output with no turn open (see AgentSession.stopBackground).
 */
type StopOutcome = 'running' | 'collecting' | 'background' | 'idle';

/**
 * What `/stop` answers, per outcome. Three sentences rather than one ack, because the same words
 * for "I stopped a 20-minute task" and "there was nothing to stop" teach the user to distrust the
 * command — and a stop command nobody trusts is worse than none.
 */
const STOP_ACK: Record<StopOutcome, string> = {
  running: '⏹ Stopped. The reply above is as far as it got — the conversation is kept, so just send the next message.',
  collecting: '⏹ Dropped the message that was about to start a turn. Nothing reached the agent.',
  background:
    '⏹ Stopped the background work. The update above is as far as it got — the conversation is kept, so just send the next message.',
  idle: 'Nothing is running here.',
};

/**
 * `/stop` when the only thing waiting here was a question. Its own line because the outcomes above
 * are read off the merger, which knows nothing about a question posted outside a turn.
 */
const STOP_ACK_QUESTION = '⏹ Called off the question above. Nothing else was running.';

/** `/stop` when the only thing here was a voice transcript waiting to be confirmed. */
const STOP_ACK_VOICE = '⏹ Called off the voice transcript — nothing was sent. Nothing else was running.';

/**
 * What `/kill` found. The first three are StopOutcome — the process was ended, and this is what
 * else was going on at the time; the last two are the cases where nothing was ended at all.
 */
type KillOutcome = StopOutcome | 'no-child' | 'unresumable';

/**
 * What `/kill` answers, per outcome. Every "ended" sentence says the conversation survives, because
 * that is the one thing separating this command from `/new` and the one a user about to lose a long
 * session needs to read before they believe it.
 */
const KILL_ACK: Record<KillOutcome, string> = {
  running: '🔌 Stopped the turn and ended the agent process. The conversation is kept — the next message starts a new process that picks up where this one left off.',
  collecting: '🔌 Dropped the message that was about to start a turn, and ended the agent process. The conversation is kept — the next message resumes it.',
  background:
    '🔌 Stopped the background work and ended the agent process. The conversation is kept — the next message starts a new process that picks up where this one left off.',
  idle: '🔌 Ended the agent process. The conversation is kept — the next message starts a new one that picks up where it left off.',
  'no-child': 'No agent process is running here — nothing to end.',
  unresumable:
    'Not ended: this agent cannot resume a stored session, so ending its process would lose the conversation. ' +
    '`/stop` ends the turn; `/new` ends the process and starts fresh.',
};

/**
 * What a refused agent switch says (see ConversationRegistry.refuseAgentSwitch).
 *
 * Carries the session id and the directory because those two are what the NEXT agent needs to find
 * this conversation on disk — the refusal is a handover note, not just a no. Both are in code spans
 * so a tap copies them whole on a phone.
 */
export function agentSwitchRefusalText(p: {
  bound: string;
  wanted: string;
  wantedCommand: string;
  sessionId: string;
  workdir?: string;
}): string {
  return [
    `This topic stays with ${p.bound} — a topic does not switch agents once it has a session.`,
    `• ${p.bound} session id: \`${p.sessionId}\``,
    ...(p.workdir ? [`• Working directory: \`${p.workdir}\``] : []),
    `To continue with ${p.wanted}, open a new topic, start it with \`${p.wantedCommand}\` and give it that session id — it can find the earlier conversation itself. (\`/new\` here clears this topic, and then any agent can take it.)`,
  ].join('\n');
}

/**
 * How often the idle sweeper looks for conversations to reclaim.
 *
 * Independent of session.idleTimeoutMs, and deliberately coarse: the deadline it enforces is
 * measured in tens of minutes, so a minute of slack on either side is invisible, while a tighter
 * interval would just wake the process up more often to find nothing.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * One live conversation as the review sweep sees it (see `reviewFacts`). Kept out of
 * `daemon/review.ts` so the registry does not import the reviewer, and out of `types.ts` because
 * it is not a domain shape any platform or store shares.
 */
export interface ReviewFacts {
  key: ConversationId;
  agentId: string;
  idleMs: number;
  busyTurn: boolean;
  pendingWork: boolean;
  stopped: boolean;
  unresumable: boolean;
  /**
   * Where the conversation lives, when this process has answered a turn there. The stored record
   * carries the same lane, except after `/new` — which clears the record — so this is what keeps
   * a `/new`ed topic reviewable (and its notice postable) without waiting for its next message.
   */
  lane?: { platform: string; channel: string; thread?: string };
}

/**
 * All per-conversation runtime state in one object. Consolidated so creation sets one object (no
 * half-init), release is one delete (no leak), and adding a field touches only this interface.
 *
 * Note: the stable token is not here — it's encapsulated by SessionTokenRegistry (with its own
 * token↔conversation map) as a separate member, released via tokens.release(id).
 */
interface ConversationState {
  /** This conversation's inbound merger (state machine: idle/collecting/running). */
  merger: InboundMerger;
  /**
   * When this conversation last did anything, as the injected clock sees it. Drives idle reclaim.
   *
   * Bumped by an accepted inbound message, by the end of a turn (the merger's onIdle), and by a
   * reverse command arriving over IPC. That third source is the one that is easy to miss and the
   * reason the field is not simply "time of last message": an agent that finished its turn and left
   * a background job reporting through `talkcode send` is still working here, and reclaiming
   * its child would cut the job off from the chat it is talking to.
   *
   * Ignored while the merger is busy — a turn in flight is not idle no matter what this says.
   */
  lastActivityAt: number;
  /**
   * The agent currently answering this conversation — the STICKY binding.
   *
   * Set when the conversation is first seen (from routing.pipeline / routing.default) and changed
   * only when the user explicitly names another agent (`/oc …`). Plain messages read it; they do
   * NOT re-resolve the pipeline. That is the fix for the reported bug: previously the agent led
   * the session key, so a `/oc hi` and the plain message after it were two different sessions in
   * one topic, and the second silently fell back to routing.default.
   */
  agentId: string;
  /** Model override (/model); undefined means use agent.model. */
  modelOverride?: string;
  /** If set, reclaim this conversation's agent child as soon as the merger becomes idle. */
  reclaimOnIdle?: boolean;
  /**
   * If set, a config reload changed this conversation's agent while a turn was running: drop the
   * session when the merger becomes idle, so the next turn is built from the new definition (see
   * respawnAgents). Unlike reclaimOnIdle it is NOT cancelled by a new message — the definition is
   * still stale however busy the conversation stays.
   */
  respawnOnIdle?: boolean;
  /** Platform instance of the most recently routed message (a shared-scope conversation may hop instances). */
  platform: string;
  /**
   * The lane this conversation is answered in: the address the last turn ran at, kept for the life
   * of the conversation. Undefined until its first turn.
   *
   * This used to be an ACTIVE address, cleared the moment a turn ended, and three separate things
   * were silently dropped as a result — all of them things that by nature happen after a turn:
   *
   *  - background output the harness produces once the turn has settled (TurnRunner.followUpSink);
   *  - a harness title, which claude-agent-acp generates in a background task and reports from its
   *    turn-end idle handler;
   *  - a reverse command from a job the agent left running (`talkcode send-message`), which
   *    was refused outright with "this conversation has no active turn right now".
   *
   * So it is no longer cleared: a conversation does not stop being in a place just because nothing
   * is running there. Nothing reads "is a turn running" off an address — the merger's phase is the
   * authority on that (see InboundMerger.isIdle).
   *
   * KNOWN LIMITATION under `scope: shared` / `per_user`, where one conversation deliberately spans
   * channels: between turns this names whichever lane ran last, so an out-of-turn answer can land
   * in the previous lane rather than the one the user is now writing in. The default `per_thread`
   * scope makes a conversation and a lane the same thing, and under the sharing scopes a
   * single-lane answer was already ill-defined.
   */
  lane?: ConversationAddress;
  /** Platform instance of `lane` (set with it, never cleared). */
  lanePlatform?: string;
  /**
   * Whether this conversation already announced itself with the header bubble
   * (display.header.enabled). Once per conversation, so a long exchange isn't punctuated by a
   * banner on every turn; re-armed by /new and by an agent rebind (the answerer changed, which is
   * exactly what the header reports).
   */
  headerSent?: boolean;
  /**
   * Latest context-usage snapshot the agent reported (ACP `usage_update`), kept past the turn.
   *
   * `/context` is asked BETWEEN turns, and the footer's copy lives on the per-turn ref, so without
   * this the answer would have to guess a window size — the one thing the footer refuses to do.
   */
  lastUsage?: AgentUsage;
  /**
   * The last cumulative session cost the agent reported, kept apart from `lastUsage` because most
   * snapshots carry none: claude-agent-acp attaches it only to the one tied to a finished result, so
   * the mid-stream snapshot that follows would otherwise overwrite it with nothing. Read by a busy
   * `/usage` (see answerBusyQuery). Cleared with `lastUsage`: a new session starts its own total.
   */
  lastCost?: { amount: number; currency: string };
  /**
   * Whether a turn has ended normally under the CURRENT binding since the last reset.
   *
   * Only `/context` reads it, and only to choose between two different empty answers: before the
   * first turn the numbers are merely late, while after one they are not coming at all (the harness
   * reports usage only for a model whose context window it knows). Cleared wherever `lastUsage` is,
   * so the pair always describes the same agent and the same context.
   */
  turnCompleted?: boolean;
}

/**
 * Conversation registry: per-conversation state + routing. Conversation key → ConversationState.
 *
 * - route(msg): identify the conversation, resolve/keep its agent, gate, deliver to the merger.
 * - Single-turn orchestration is extracted to TurnRunner; buildMerger's runTurn delegates to it.
 * - Lifetime: a CONVERSATION lives until shutdown or an explicit /new. Its resident agent
 *   subprocess does not — after session.idleTimeoutMs of silence the sweeper stops the child and
 *   keeps everything that identifies the conversation, so the next message respawns it and resumes
 *   through the harness's own reload. See reclaimIdleSessions.
 */
export class ConversationRegistry {
  /** The single per-conversation state table. */
  private conversations = new Map<ConversationId, ConversationState>();
  /**
   * Auto-created thread → the conversation that opened it.
   *
   * Only autoThread writes here. When the daemon opens a thread for a turn, the reply moves into
   * it — so the user's next message arrives from a place that would otherwise identify as a brand
   * new conversation, and the agent would answer its own follow-up with no context. The alias makes
   * the thread continue the conversation that created it.
   *
   * In-memory only: a restart loses the aliases, after which such a thread becomes a conversation
   * in its own right. That degradation is acceptable (and self-correcting) in a way that silently
   * discarding the agent's context is not.
   */
  private threadAliases = new Map<ConversationId, ConversationId>();
  /**
   * Suffix for the throwaway conversation `schedule add --model` uses to read another agent's
   * model list. Unique per call: two adds for the same agent can overlap (two conversations, or a
   * retry), and a shared key would let the first call's cleanup dispose the session the second is
   * still reading.
   */
  private modelProbeSeq = 0;
  /** stable token ↔ conversationId registry (reverse-command auth + locate). */
  private tokens = new SessionTokenRegistry();
  /** Single-turn orchestrator; buildMerger's runTurn delegates to it (see class doc). */
  private readonly turnRunner: TurnRunner;
  /**
   * Each conversation's live agent status, for a platform that shows one (the web UI's status
   * strip). Fed by the same reports as `lastUsage`, from the same TurnRunner deps — see
   * status-board.ts for why it is its own object.
   */
  private readonly status: StatusBoard;
  /** Every agent's model list, as far as can be told without a turn (model-catalog.ts). */
  private readonly modelCatalog: ModelCatalog;
  /**
   * What each conversation's turn is doing right now — the tool it is running, how many steps in.
   * `outcomes` below only knows a turn once it has ended; a sub-agent 150 tool calls deep is
   * exactly when its parent needs this. See turn-progress.ts.
   */
  private readonly progress: TurnProgressBoard;
  /**
   * What each conversation's last turn left for the person, and what happens after a failed one
   * (`hooks.turnFailed`, interrupted turns). See turn-outcomes.ts.
   */
  private readonly outcomes: TurnOutcomes;
  /**
   * The `/setting` writer: validates a value, patches config.yaml, applies it to this live Config.
   *
   * Owned here rather than by the daemon because the registry is the side that holds the Config and
   * the agent sessions — the same reason applyModelChoice lives here. The daemon owns the buttons.
   */
  private readonly settings: SettingsStore;
  /**
   * Per-instance gating rules (lazy cache): the deployment-facing half comes from that
   * instance's `chat` block (requireMention/freeResponseChannels/ignoredChannels/allowBots),
   * the frozen half (respondInDirect/threadParticipationExempt) from EXPERIENCE.
   */
  private readonly gateConfigs = new Map<string, GateConfig>();
  /** Cancels the idle sweeper's pending tick. Null when reclaim is disabled, or after dispose. */
  private cancelSweep: (() => void) | null = null;
  /**
   * Conversations already reported as un-reclaimable, so the sweeper says it once instead of every
   * minute for the life of the daemon. Cleared with the rest of the conversation's state.
   */
  private unresumableWarned = new Set<ConversationId>();
  /**
   * Conversations with a naming call in flight.
   *
   * The store gate ("has this been named") cannot cover the window on its own: nothing is recorded
   * until the platform accepts the rename, and the model call in front of that takes a second or
   * two — long enough for a second turn to finish underneath it and start a duplicate.
   */
  private namingInFlight = new Set<ConversationId>();
  /**
   * The gateway is waiting for the turns in progress before it restarts (beginDrain): a message that
   * would start a turn in an idle conversation is answered here instead (refuseWhileDraining).
   */
  private draining = false;

  constructor(
    private readonly config: Config,
    /** Platform adapters keyed by instance id. */
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    /**
     * Optional callback hooks. onAvailableCommands: fired when a conversation's agent reports its command
     * list (daemon aggregates and dynamically registers native slash). Absent = don't care (test/no-slash).
     * onPickerRequest: fired when a bare agent command (`/cc`, `/oc`) is invoked for a conversation
     * whose harness reports a command list; the daemon owns the button UI, the registry only
     * resolves who it is for.
     * onModelMenuRequest: same division for a bare `/model` on a platform that can carry a menu —
     * the registry hands over the live selector (it is the only side holding the AgentSession) and
     * the daemon posts, pages and acks the buttons.
     * onSkillsRequest: fired by `/skills`. Same split again — the reported command lists live on
     * the daemon (agentCommands), so the registry can only say which agent the question is about.
     */
    private readonly hooks?: {
      onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
      /**
       * The agent asked the user a question mid-turn and is blocked on it (ACP elicitation).
       * Passed straight through to TurnRunner, which supplies the turn's own lane — the registry
       * never sees one of these, it only carries the hook.
       */
      onElicitRequest?(
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: AgentElicitation
      ): Promise<ElicitAnswer>;
      /** A `permissions: ask` agent asking leave to run a tool; carried through like onElicitRequest. */
      onPermissionRequest?(
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: AgentPermissionRequest
      ): Promise<PermissionAnswer>;
      onPickerRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
      onSkillsRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
      onModelMenuRequest?(
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        selector: ModelSelector
      ): void;
      /** A bare `/effort` on a platform that can carry a menu. Same division as the model menu. */
      onEffortMenuRequest?(
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        selector: EffortSelector
      ): void;
      /**
       * A person changed this conversation's model with `/model` (typed or clicked) and the harness
       * accepted it. The daemon uses it for a daily task's topic: that choice must outlive a
       * restart, when the in-memory override is gone, so the task stops applying its own model for
       * the rest of the day.
       */
      onModelSet?(id: ConversationId): void;
      /**
       * A `/setting` on a platform that can carry a menu. Same division of labour as the model
       * menu: the registry resolves what the rows ARE (it holds the Config and the live sessions),
       * the daemon posts, pages and acks the buttons.
       *
       * `open` is set when the user named a key (`/setting idle`), so the menu skips the list level
       * and lands on that setting's values.
       */
      /**
       * `/reload`: re-read config.yaml and apply it. The daemon does it — it owns the files, the
       * platforms and the slash registration — and answers with the sentence to post, once the
       * hosts' pods have been read again (daemon.ts reloadAll), which is why it can take a while.
       */
      onReloadRequest?(): Promise<string>;
      onSettingMenuRequest?(
        id: ConversationId,
        msg: InboundMessage,
        menu: {
          rows: SettingRow[];
          open?: { row: SettingRow; options: SettingOption[]; hint?: string };
          /** The open model row's list is being asked for; redraw the level when this settles. */
          asking?: Promise<unknown>;
        }
      ): void;
      /**
       * A directory menu is wanted here (`/cd`, a bare agent command in a conversation with no
       * history yet, a `/new` that just cleared one, or an `/agent` pick before the first turn).
       * Same division of labour as the model menu: the registry decides WHAT is on offer — it holds
       * the config, the store and the filesystem root — and the daemon posts, pages and acks the
       * buttons. The conversation rather than the message that asked, because an `/agent` menu
       * pick is a click, and has none.
       *
       * `truncated` is how many directories did not fit the scan cap; the daemon says so on the
       * menu rather than showing a list that looks complete.
       */
      onWorkdirMenuRequest?(
        id: ConversationId,
        agentId: string,
        conv: ConversationRef,
        menu: { options: WorkdirOption[]; current: string; truncated: number }
      ): void;
      /**
       * An agent menu is wanted here (`/agent` with no argument). The registry says what is on
       * offer — every configured agent, grouped (core/agent-menu.ts) — and the daemon posts the
       * buttons and hands a pick back through chooseAgent.
       */
      onAgentMenuRequest?(id: ConversationId, msg: InboundMessage, menu: { groups: AgentGroup[]; current: string | undefined }): void;
      /**
       * Whether the daemon is holding work for this conversation that lives OUTSIDE a turn — today,
       * a pending `ask` whose IPC caller is blocked on a button click. The idle sweeper asks before
       * reclaiming, because such a conversation looks idle from here (no turn, no messages) while
       * something is very much waiting on it.
       *
       * A query rather than a pin/unpin pair on purpose: a leaked pin would keep one child resident
       * forever, and nothing would ever notice.
       */
      hasPendingWork?(id: ConversationId): boolean;
      /**
       * A message arrived while this conversation has a question on screen: record it as the
       * answer to that question. Returns true when it was consumed, in which case no turn runs.
       *
       * The registry asks rather than decides because the questions live on the daemon
       * (pendingAsks) — same split as every other hook here. What the registry owns is the
       * PLACEMENT of the call in route(): past the access check and the gate (an answer has to come
       * from someone allowed to talk to the bot, and in a guild channel it still has to be
       * addressed at us), and past the daemon commands (so `/stop` can still call the question
       * off), but before the merger — because reaching the merger is precisely the bug.
       */
      answerPendingAsk?(id: ConversationId, text: string): boolean;
      /**
       * Abandon the questions this conversation has on screen, returning how many were retired.
       * Called when the user cancels the work they belong to (`/stop`, `/new`); the reason is shown
       * on the retired bubble. The count is what lets `/stop` avoid answering "nothing is running"
       * to someone who just called off a question.
       */
      cancelPendingAsks?(id: ConversationId, reason: string): number;
      /**
       * A voice message: take it for transcription (true), in which case route() does nothing more
       * with it — the transcript comes back later through route() itself, as text, once the user
       * has confirmed it. See daemon/voice.ts for why the placement in route() is what it is.
       */
      takeVoice?(id: ConversationId, msg: InboundMessage): boolean;
      /** A typed message is about to reach the agent here: drop any transcript still waiting. */
      supersedeVoice?(id: ConversationId): number;
      /**
       * A message is about to reach the agent here: drop the sub-agent card still waiting for a tap
       * (Delegation.personSpoke). The person writing instead of tapping is how a proposal is changed,
       * and the agent's next `task-new` must start a fresh card rather than add to the one it meant
       * to replace. Placed beside `supersedeVoice` in route(): past every gate, before the merger.
       */
      supersedeProposals?(id: ConversationId): void;
      /** `/stop` / `/new`: call off every transcript here, returning how many there were. */
      cancelPendingVoice?(id: ConversationId, reason: string): number;
      /**
       * `/stop`: stop the sub-agents this conversation opened that are still at work (and theirs),
       * returning how many were stopped — Delegation.stopOpened.
       */
      stopSubAgents?(id: ConversationId): number;
      /**
       * `/setting schedule [pause|resume|delete <id>]`. The tasks live on the daemon (schedule-service),
       * so the registry only recognises the key and says whether this platform can carry a menu.
       */
      onScheduleSetting?(id: ConversationId, msg: InboundMessage, args: string[], canMenu: boolean): void;
      /** One line for the text `/setting` list pointing at the scheduled tasks; absent = no line. */
      scheduleSummary?(): string | undefined;
      /**
       * `/setting delegation` landed on a different tier: Delegation's memory of which agents this
       * conversation already confirmed is void (Delegation.forgetConfirmations). Routed through the
       * daemon because the registry does not own that memory.
       */
      onDelegationSettingChanged?(): void;
      /**
       * A conversation has something for the person now — a finished reply, a failure that will not
       * be continued (TurnOutcomes). Delegation listens: a sub-agent's topic tells the agent that
       * opened it (daemon/delegation.ts).
       */
      onNeedsPerson?(id: ConversationId): void;
      /**
       * A person's own messages reached the agent here, as a turn or merged into one
       * (TurnRunnerDeps.recordPersonWords). Delegation listens: in a sub-agent's topic, the agent that
       * opened it is told what the person wrote there, with how that turn ended.
       */
      onPersonWords?(id: ConversationId, words: PersonWords): void;
    },
    /** Persistent conversation state (agent binding + each agent's own session id). */
    private readonly store?: ConversationStore,
    /**
     * How often each directory has been chosen with `/cd`, used to order the menu.
     *
     * Optional, and absence is a supported deployment rather than a degraded one: with no usage
     * store the directory list stays in the scan's alphabetical order, which is what it was before
     * ranking existed. Tests construct registries without one for exactly that reason.
     */
    private readonly workdirUsage?: WorkdirUsageStore,
    /**
     * Runs one of the bound harness's OWN slash commands as a separate process (agy's, today).
     *
     * Injected rather than called directly so a test can pin the decision this class actually
     * makes — that such a name is answered here and never reaches the agent — without spawning a
     * CLI it does not control. The default is the real thing, so the daemon wires nothing.
     */
    private readonly runHarnessCli: typeof runAgyCliCommand = runAgyCliCommand,
    /**
     * The conversation library (`<configDir>/history.db`). Optional, and absence is a supported
     * deployment: a test registry records nothing, and a gateway whose library failed to open
     * still answers. See daemon/turn-runner.ts `recordHistory` for why every write is best-effort.
     */
    private readonly history?: HistoryStore
  ) {
    // Inject only the capabilities TurnRunner needs (read-only views + activeAddress write entry),
    // rather than passing the whole registry and creating a circular dependency.
    this.progress = new TurnProgressBoard(this.clock);
    this.modelCatalog = this.makeModelCatalog();
    this.status = new StatusBoard({
      laneOf: (id) => this.laneOf(id),
      platforms: this.platforms,
      agentOf: (id) => this.agentIdOf(id),
      configuredModel: (id) =>
        this.conversations.get(id)?.modelOverride ?? findAgent(this.config, this.agentIdOf(id))?.model,
      cacheReading: (id) => this.claudeCacheReading(id),
      clock: this.clock,
    });
    this.turnRunner = new TurnRunner(
      this.config,
      this.platforms,
      this.agents,
      this.clock,
      {
        tokenFor: (id) => this.tokens.tokenFor(id),
        agentIdOf: (id) => this.agentIdOf(id),
        getModelOverride: (id) => this.conversations.get(id)?.modelOverride,
        getWorkdir: (id) => this.workdirOf(id),
        recordUsage: (id, usage) => {
          const state = this.conversations.get(id);
          if (!state) return;
          state.lastUsage = usage;
          if (usage.cost) state.lastCost = usage.cost;
          this.status.usage(id, usage);
        },
        recordModel: (id, model) => this.status.model(id, model),
        recordEffort: (id, effort) => this.status.effort(id, effort),
        recordQuota: (id, pools) => this.status.quota(id, pools),
        recordTool: (id, evt) => this.recordTool(id, evt),
        recordTurnComplete: (id) => {
          const state = this.conversations.get(id);
          if (state) state.turnCompleted = true;
          this.status.settled(id);
        },
        // During an active turn the state must exist, but handle absence robustly anyway.
        setLane: (id, address, platformId) => {
          const state = this.conversations.get(id);
          if (state) {
            state.lane = address;
            state.lanePlatform = platformId;
          }
          // Persisted too, once per turn: it is what `talkcode channels` lists (see
          // ConversationRecord.lane), and the in-memory copy dies with the process.
          this.store?.recordLane?.(id, this.agentIdOf(id), platformId, address, this.clock.now());
        },
        followUpTarget: (id) => this.laneOf(id),
        touch: (id) => this.touch(id),
        // autoThread opened a thread mid-turn: alias its key to this conversation so the user's
        // reply inside it continues here instead of starting an empty one (see adoptThread).
        adoptThread: (id, address, platformId) => this.adoptThread(id, address, platformId),
        nameConversation: (id, seed) => this.nameConversation(id, seed),
        recordTurnStart: (id) => {
          this.progress.started(id);
          this.outcomes.turnStarted(id);
        },
        recordTurnEnd: (id, end) => this.outcomes.turnEnded(id, end),
        recordPersonWords: (id, words) => this.hooks?.onPersonWords?.(id, words),
        recordHistory: (id, event) => this.recordHistory(id, event),
        beginHistoryTurn: (id, start) => this.beginHistoryTurn(id, start),
        endHistoryTurn: (turnId, end) => this.endHistoryTurn(turnId, end),
      },
      this.hooks
    );
    this.outcomes = new TurnOutcomes({
      config: this.config,
      clock: this.clock,
      platforms: this.platforms,
      store: this.store,
      // laneFor, not laneOf: after a restart a conversation has no in-memory lane until its next turn,
      // and an interrupted turn's notice and outcome are exactly what has to reach it before then.
      laneOf: (id) => this.laneFor(id),
      agentIdOf: (id) => this.boundAgentOf(id) ?? this.agentIdOf(id),
      runContinue: (id, text) => this.runContinue(id, text),
      onNeedsPerson: (id) => this.hooks?.onNeedsPerson?.(id),
    });

    // `/setting idle` has to re-arm the sweeper, not just change the number (see setIdleTimeout).
    // A delegation change takes effect live too, but has to invalidate what Delegation remembered.
    this.settings = new SettingsStore(this.config, {
      onIdleTimeout: () => this.rearmIdleSweeper(),
      onDelegationChanged: () => this.hooks?.onDelegationSettingChanged?.(),
    });

    this.startIdleSweeper();
  }

  /**
   * Arm the idle sweeper: one self-rescheduling tick (the injected clock's schedule is one-shot,
   * like the typing keep-alive in TurnRunner). Disabled entirely when idleTimeoutMs is 0, so a
   * deployment that turns reclaim off pays no timer at all.
   */
  private startIdleSweeper(): void {
    // Written as a positive test rather than `<= 0`: a hand-assembled Config that omits the field
    // (tests, an older config object) then leaves reclaim OFF, which is the safe direction — the
    // negative form would arm a sweeper that compares every conversation against NaN.
    if (!(this.config.session.idleTimeoutMs > 0)) return;
    const tick = (): void => {
      this.reclaimIdleSessions();
      this.cancelSweep = this.clock.schedule(tick, SWEEP_INTERVAL_MS);
    };
    this.cancelSweep = this.clock.schedule(tick, SWEEP_INTERVAL_MS);
  }

  /**
   * Re-arm the sweeper after `session.idleTimeoutMs` changed under it (`/setting idle`).
   *
   * Both directions need this, and neither is served by the value alone: when the timeout starts at
   * 0 no timer is armed at all (startIdleSweeper returns early), so raising it from `off` would
   * otherwise take a restart; and when it becomes 0 the armed timer keeps waking the process up to
   * find reclaim disabled. Cancel-then-arm covers both, and the value itself is already written by
   * the time this runs (SettingsStore.applyToConfig).
   */
  private rearmIdleSweeper(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    this.startIdleSweeper();
  }

  /**
   * Stop the resident agent child of every conversation that has gone quiet for longer than
   * session.idleTimeoutMs, keeping the conversation itself intact.
   *
   * ── What reclaim is ───────────────────────────────────────────────────────────────────────────
   * The restart path, applied to one conversation instead of all of them. A daemon restart already
   * kills every child and resumes each conversation from the session id in conversations.json
   * (ACP `session/load`, agy `--conversation`) — this does the same thing to one idle conversation,
   * on purpose, to get its memory back. Nothing that identifies the conversation is touched: the
   * binding, the state, the reverse-command token and the stored session ids all stay, and the
   * session HANDLE stays too (so the runtime model choice a user made survives the respawn).
   *
   * ── The four gates, and what each is protecting ───────────────────────────────────────────────
   * 1. quiet longer than the deadline — the clock only starts when the last turn ENDED, so a task
   *    that runs for hours (subagents included) is never a candidate;
   * 2. the merger is idle — no turn running, no batch collecting;
   * 3. the daemon holds no out-of-turn work (a pending `ask`) for it;
   * 4. the session says it can resume. A runtime that cannot say so keeps its child: silently
   *    restarting someone's task is the one degradation this gateway refuses to make.
   *
   * Public because the timer is not the interesting part — the decision is, and the sweep is tested
   * by calling it against a controlled clock.
   */
  /**
   * Stop an idle resident agent child, preserving conversation state and session ID for later resumption.
   * Returns true when the session child was actually disposed.
   */
  private reclaimSession(id: ConversationId, reason: string): boolean {
    if (this.hooks?.hasPendingWork?.(id)) return false;
    const session = this.agents.peek(id);
    if (!session) return false; // never started here: nothing resident to reclaim
    const reclaim = session.reclaimState?.() ?? 'unresumable';
    if (reclaim === 'no-child') return false; // already down (an earlier sweep, or a crash)
    if (reclaim === 'unresumable') {
      if (!this.unresumableWarned.has(id)) {
        this.unresumableWarned.add(id);
        console.warn(
          `[reclaim] ${id} is idle but its agent cannot resume a stored session; leaving the child ` +
            `resident (stopping it would silently restart the conversation)`
        );
      }
      return false;
    }

    // dispose() on the SESSION, not on the factory: the factory would drop the handle as well,
    // and with it this conversation's runtime /model choice. Both runtimes reset their handles
    // and respawn on the next turn — the same self-healing path a crashed child takes.
    session.dispose();
    console.log(`[reclaim] ${id} ${reason} — agent child stopped; the next message resumes it`);
    return true;
  }

  /**
   * A config reload changed or removed these agents: move every conversation running one of them
   * onto what config says now. Returns how each was handled, for the reply (see describeReload).
   *
   * A session captures its agent definition when it is created, so "onto the new definition" means
   * dropping the session — through the factory, so the handle goes too and the next getOrCreate
   * builds one from the current config. When:
   *  - no child running (never started, reclaimed, crashed): now; it costs nothing;
   *  - idle, with a child that can resume: now. The next message respawns it and session/load puts
   *    the context back — the path an idle reclaim takes;
   *  - mid-turn, or holding a pending ask: when the merger goes idle (respawnOnIdle). A reload never
   *    cuts a turn short;
   *  - a harness that cannot resume a session: not at all. Restarting it would restart the user's
   *    task blank, the degradation idle reclaim refuses too; it moves at the next /new. Except for
   *    an agent that was REMOVED — nothing is left to protect, and route() rebinds the
   *    conversation on its next message anyway.
   */
  respawnAgents(agentIds: ReadonlySet<string>): RespawnCounts {
    const counts: RespawnCounts = { now: 0, afterTurn: 0, kept: 0 };
    for (const [id, state] of this.conversations) {
      if (!agentIds.has(state.agentId)) continue;
      const session = this.agents.peek(id);
      if (!session) continue;
      const removed = !findAgent(this.config, state.agentId);
      const reclaim = session.reclaimState?.() ?? 'unresumable';
      if (reclaim === 'no-child') {
        this.agents.dispose(id);
        continue;
      }
      if (reclaim === 'unresumable' && !removed) {
        counts.kept++;
        continue;
      }
      if (!state.merger.isIdle() || this.hooks?.hasPendingWork?.(id)) {
        state.respawnOnIdle = true;
        counts.afterTurn++;
        continue;
      }
      this.agents.dispose(id);
      counts.now++;
    }
    return counts;
  }

  /** `session.idleTimeoutMs` was replaced by a config reload: the sweeper's timer has to follow. */
  idleTimeoutChanged(): void {
    this.rearmIdleSweeper();
  }

  reclaimIdleSessions(): void {
    const idleMs = this.config.session.idleTimeoutMs;
    if (!(idleMs > 0)) return; // disabled, or absent from a hand-built config (see startIdleSweeper)
    const now = this.clock.now();
    for (const [id, state] of this.conversations) {
      if (now - state.lastActivityAt <= idleMs) continue;
      if (!state.merger.isIdle()) continue;
      const idleMin = Math.round((now - state.lastActivityAt) / 60_000);
      this.reclaimSession(id, `idle for ${idleMin}m`);
    }
  }

  /**
   * Every conversation this process holds state for, as the review sweep decides on it
   * (daemon/review.ts `eligible`).
   *
   * Only LIVE conversations: after a restart there is no state until a message arrives, and the
   * daemon fills those in from `conversations.json` and the library. `stopped` and `unresumable`
   * come from the session's own `reclaimState` — the same answer the idle sweeper acts on — so a
   * conversation whose child is up is never reviewed behind a running agent's back.
   */
  reviewFacts(now = this.clock.now()): ReviewFacts[] {
    const out: ReviewFacts[] = [];
    for (const [id, state] of this.conversations) {
      const session = this.agents.peek(id);
      const reclaim = session ? (session.reclaimState?.() ?? 'unresumable') : 'no-child';
      const lane = this.laneOf(id);
      out.push({
        key: id,
        agentId: state.agentId,
        idleMs: now - state.lastActivityAt,
        busyTurn: !state.merger.isIdle(),
        pendingWork: this.hooks?.hasPendingWork?.(id) ?? false,
        stopped: reclaim === 'no-child',
        unresumable: reclaim === 'unresumable',
        ...(lane ? { lane: { platform: lane.platformId, ...lane.address } } : {}),
      });
    }
    return out;
  }

  /**
   * Called when an ask timed out after 1h with no response from the user.
   * Reclaims the agent child process (session.dispose()) as soon as the conversation is idle,
   * so that memory is freed while the stored session ID is preserved for later resumption.
   */
  reclaimAfterAskTimeout(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (!state) return;
    if (state.merger.isIdle()) {
      this.reclaimSession(id, 'ask timed out (1h)');
    } else {
      state.reclaimOnIdle = true;
    }
  }

  /**
   * Mark a conversation as active now. Anything that means "work is happening here" calls this:
   * an accepted message, the end of a turn, a reverse command arriving over IPC.
   *
   * A no-op for a conversation that has no state yet — creation stamps its own timestamp.
   */
  touch(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.lastActivityAt = this.clock.now();
  }

  /** Conversations with a turn running, or a batch inside its merge window about to start one. */
  turnsInProgress(): number {
    let n = 0;
    for (const state of this.conversations.values()) if (!state.merger.isIdle()) n++;
    return n;
  }

  /**
   * The gateway is going to restart once the turns in progress are over (the daemon's SIGTERM, see
   * restart-drain.ts). From now on a message that would start a turn in an idle conversation is
   * refused (refuseWhileDraining); each conversation at work is told, once, that the restart waits
   * for it — so a reply that comes late, or the silence after it, has an explanation in the chat.
   */
  beginDrain(): void {
    this.draining = true;
    for (const [id, state] of this.conversations) {
      if (state.merger.isIdle()) continue;
      // No lane yet means a first batch still inside its merge window: it is about to run, and the
      // refusal is not what it will get, so there is nothing to explain to it.
      const lane = this.laneOf(id);
      if (!lane) continue;
      void this.platforms
        .get(lane.platformId)
        ?.sendMessage(lane.address, '⏳ The gateway restarts when this turn is done — it is waiting for it to finish.')
        .catch((e) => console.warn('[drain] failed to tell a conversation about the restart:', e instanceof Error ? e.message : e));
    }
  }

  /**
   * The lane this conversation writes to: the running turn's, else the last one a turn ran in.
   *
   * The single answer to "where does this conversation live", used by everything that happens
   * BETWEEN turns — background output, a late harness title, a reverse command from a job the agent
   * left behind. Each of those used to read `activeAddress` directly and get undefined, which is
   * how a conversation that had merely finished replying became indistinguishable from one that had
   * never existed. Undefined only before this conversation's first turn: until then there genuinely
   * is no lane, only the address of whatever message is being handled right now.
   */
  private laneOf(
    id: ConversationId
  ): { address: ConversationAddress; platformId: string } | undefined {
    const state = this.conversations.get(id);
    if (!state?.lane) return undefined;
    return { address: state.lane, platformId: state.lanePlatform ?? state.platform };
  }

  /** Gating rules for one platform instance (built on first use; config is immutable at runtime). */
  private gateFor(platformId: string): GateConfig {
    let gate = this.gateConfigs.get(platformId);
    if (!gate) {
      // An unknown instance id (synthesized message?) falls back to safe defaults: mention required.
      const chat = this.config.platforms[platformId]?.chat;
      gate = {
        requireMentionInGuild: chat?.requireMention ?? true,
        freeResponseChannels: chat?.freeResponseChannels ?? [],
        ignoredChannels: chat?.ignoredChannels ?? [],
        allowBots: chat?.allowBots ?? 'none',
        respondInDirect: this.config.inbound.gating.respondInDirect,
        threadParticipationExempt: this.config.inbound.gating.threadParticipationExempt,
      };
      this.gateConfigs.set(platformId, gate);
    }
    return gate;
  }

  /**
   * Platform instance owning a conversation's OUTBOUND right now: the lane a turn is running (or
   * last ran) in, else the last routed message's instance. Used by the daemon to pick the adapter
   * for reverse commands, including `--channel` override sends on an idle conversation.
   *
   * Reads the lane rather than the last inbound instance because a reverse command is answered
   * into the lane — `resolveAddress` returns that lane's address, and pairing it with a different
   * instance's adapter would send one platform's channel id to another platform.
   */
  platformFor(id: ConversationId): string | undefined {
    const state = this.conversations.get(id);
    return state?.lanePlatform ?? state?.platform;
  }

  /**
   * Adapter for the instance a conversation's INBOUND messages are arriving on; clear error if
   * unresolvable.
   *
   * Deliberately `state.platform` and not `platformFor`. Its only caller is the merger's
   * lifecycle-reaction sink, which marks the user's own messages — under `scope: shared` (a
   * platform-free conversation key) one conversation genuinely spans instances, and `route` keeps
   * `state.platform` pointed at the message being handled precisely so a 👀 lands on the platform
   * that sent it. Resolving that through the lane would address a Discord message id to Telegram.
   */
  private adapterFor(id: ConversationId): PlatformAdapter {
    const pid = this.conversations.get(id)?.platform;
    const adapter = pid ? this.platforms.get(pid) : undefined;
    if (!adapter) {
      throw new Error(`cannot resolve a platform adapter for conversation ${id} (platform=${pid ?? 'unknown'})`);
    }
    return adapter;
  }

  /** Inbound entry (daemon wires platform.onMessage here). */
  route(
    msg: InboundMessage,
    /**
     * `transcript`: this is a confirmed voice transcript re-entering (daemon/voice.ts). It is
     * answered as a typed message in every respect but two — it is not offered for transcription
     * again, and it does not supersede the OTHER transcripts still waiting here (confirming one of
     * two voice notes must not drop the second).
     */
    opts?: { transcript?: boolean }
  ): void {
    const conv = msg.conversation;
    const address = addressOf(conv);
    // Access control (decoupled from routing): when allowFrom is non-empty, ignore identities
    // `platform:userId` not in the allowlist.
    if (!this.isAllowed(msg)) {
      console.log(`[access] denied identity ${conv.platform}:${conv.user} ${describeConversation(conv)}`);
      return;
    }

    // Identify the conversation. The key is agent-free: which agent answers is a property OF the
    // conversation, resolved below, not part of its name.
    const input = routeInputFromMessage(msg);
    const scope = resolveScope(this.config, input);
    // An auto-created thread continues the conversation that opened it (see threadAliases).
    const rawKey = conversationKey(scope, conv);
    const key = this.threadAliases.get(rawKey) ?? rawKey;

    // Which agent does this message ASK for, and did it ask explicitly (`/oc …`)?
    const choice = resolveAgent(this.config, input);
    // An explicit `/name` is consumed: strip it so the target agent gets a clean prompt instead of
    // trying to run /name as one of its own slash commands. Plain text parsing, so this works on
    // every platform, native slash support or not.
    let bareCommand: string | undefined;
    if (choice.explicit) {
      const parsed = parseTextCommand(msg.content);
      if (parsed && !parsed.rest && !(msg.attachments?.length ?? 0)) bareCommand = parsed.name;
      msg = { ...msg, content: parsed?.rest ?? '' };
    }

    // Inbound response gating (a second gate over the adapter's self/channelAllowed filter:
    // bot/mention/dm/thread/ignored/empty). Read hasActiveSession before any buildMerger, else once
    // a merger exists this boolean is always true and the "already in a thread" exemption is
    // distorted.
    //
    // Gated on the ORIGINAL content, not the prefix-stripped one: a bare `/oc` strips to empty and
    // would trip the empty-message gate, losing the rebind ack below. The gate's job is to reject
    // messages that arrived with nothing in them (a native slash command's phantom empty message),
    // not ones this method just emptied.
    const hasActiveSession = this.conversations.has(key);
    const gateMsg = bareCommand !== undefined ? { ...msg, content: `/${bareCommand}` } : msg;
    const decision = shouldRespond(gateMsg, this.gateFor(conv.platform), { hasActiveSession });
    if (!decision.respond) {
      // Ignored messages create no merger, don't ingest, and don't bump lastActivity (no keep-alive).
      console.log(`[gate] ignoring message (${decision.reason}) ${describeConversation(conv)}`);
      return;
    }

    // Past every gate, so this message is one the gateway is answering: the conversation is alive,
    // whatever it turns out to say. Placed before the daemon-command interceptions below so that
    // typing /help or /stop keeps a conversation warm too — a user in the middle of driving one is
    // the last person whose agent should be reclaimed out from under them.
    this.touch(key);
    // …and the person is driving it: a continue waiting to be sent after a failure is called off
    // (hooks.turnFailed — "send anything to call it off" is what its notice says).
    this.outcomes.personActed(key);

    // Commands the gateway answers itself, before any agent sees them.
    if (this.answerDaemonCommand(key, msg, address, choice.agentId)) return;

    // A topic keeps the agent it started with (see refuseAgentSwitch). After the daemon commands,
    // so `/oc /new` still clears the topic — the one route to choosing again — and before the
    // pending-question check, so a `/oc …` typed while a question is on screen is refused rather
    // than filed away as its answer with the prefix silently eaten.
    if (this.refuseAgentSwitch(key, choice, address, msg)) return;

    // A question is on screen and this message is the answer to it (see answersPendingQuestion).
    // Placed here deliberately:
    //
    //  - after the daemon commands, so `/stop` and `/new` still reach the user's own escape hatch
    //    rather than being filed away as an answer to a question they are trying to get out of;
    //  - before the merger, because the merger would hand it to the running turn as a new message —
    //    and that turn is the one blocked on the question, waiting for exactly this answer. Before
    //    this check existed, typing an answer to question 2 of a 3-question form killed the agent
    //    mid-form (the merger then cancelled the turn), so questions 1 and 2 were answered for
    //    nothing and question 3 was never asked.
    if (this.answersPendingQuestion(key, msg)) return;

    // An agent command naming a harness this deployment doesn't run (`/agy` with no agy agent):
    // answered here, never forwarded. Only reachable when resolveAgent declined the name, so a
    // configured harness or a `when.command` rule always wins.
    if (this.reportUnconfiguredHarness(choice, msg, address)) return;

    let state = this.conversations.get(key);
    if (!state) {
      // First sight of this conversation in THIS daemon run. Precedence:
      //  1. an explicit `/oc` — the user just said who they want, and that outranks everything;
      //  2. a binding persisted by a previous run — a restart must not silently move the
      //     conversation to routing.default and strand the agent that was mid-task;
      //  3. the pipeline / routing.default.
      // Order matters: reading the store first would make the first message after a restart
      // ignore its own `/cc` prefix and answer as whoever was bound before.
      const agentId = choice.explicit ? choice.agentId : (this.storedBinding(key) ?? choice.agentId);
      state = {
        merger: this.buildMerger(key),
        agentId,
        platform: conv.platform,
        lastActivityAt: this.clock.now(),
        ...this.restoredModel(key, agentId),
      };
      this.conversations.set(key, state);
      this.store?.bind(key, agentId);
      console.log(`[conversation] ${key} bound to agent "${agentId}"`);
    } else {
      state.platform = conv.platform; // shared-scope conversations may hop platform instances
      // Rebind ONLY on an explicit `/name`. A plain message keeps the bound agent — the whole point
      // of the sticky binding, and the fix for "first message answered by oc, second by claude".
      // Note what is NOT done here: the outgoing agent's own session id stays in the store, so
      // switching back resumes its thread instead of restarting the task.
      if (this.mustRebind(key, state, choice)) this.rebind(key, state, choice.agentId, conv.platform, address);
    }

    // A bare `/oc` with nothing to say: it is a binding instruction, not a prompt — the binding is
    // already applied above, so no turn runs.
    if (bareCommand !== undefined) {
      this.answerBareCommand(key, state, conv.platform, address, msg);
      return;
    }

    // Before the voice step, so a message that is going to be refused spends no transcription.
    if (this.refuseWhileDraining(key, state, address, msg)) return;

    // A voice message is transcribed and shown to the user before anything else happens to it. Past
    // the gate and the daemon commands (a stranger must not spend transcription quota, and `/stop`
    // stays `/stop`), past the binding (so the conversation exists when the transcript returns), and
    // before the merger — which would hand words nobody has approved yet to the running turn. The
    // transcript re-enters through route() once confirmed.
    if (this.takesVoice(key, msg, opts)) return;

    // Generic-command translation. Must sit here: it is the first point that knows WHICH agent
    // will answer, and the last point at which the message can still be refused. Returns the
    // message to forward, or undefined when the command was rejected (already answered).
    const forward = (m: InboundMessage): void => this.forwardToAgent(key, state, m, opts);
    const forwarded = this.applyCommandTranslation(key, state, msg, forward);
    if (!forwarded) return;
    forward(forwarded);
  }

  /** The end of route(): the message goes to the agent. Also where a deferred passthrough lands. */
  private forwardToAgent(key: ConversationId, state: ConversationState, msg: InboundMessage, opts?: { transcript?: boolean }): void {
    // Announce which agent is about to answer, before the turn starts (see sendHeader). Placed after
    // every gate in route() so it can't become a probe: a message that isn't going to be answered
    // gets no acknowledgement of any kind.
    this.sendHeader(state, msg);
    // Typing is how a transcript is corrected (its card says so): a typed message reaching the agent
    // drops whatever transcript is still waiting here, rather than leaving it to be sent as well.
    this.supersedeTranscripts(key, opts);
    // Same for a sub-agent card: the words that just arrived are the person changing the proposal,
    // and the card they did not tap must not be confirmed later.
    this.hooks?.supersedeProposals?.(key);
    state.reclaimOnIdle = false;
    void state.merger.ingest(msg);
  }

  /** Offer a message for transcription (see the call in route()); never a transcript itself. */
  private takesVoice(key: ConversationId, msg: InboundMessage, opts?: { transcript?: boolean }): boolean {
    if (opts?.transcript) return false;
    return this.hooks?.takeVoice?.(key, msg) ?? false;
  }

  /** A typed message is going to the agent: drop transcripts still waiting (see the call in route()). */
  private supersedeTranscripts(key: ConversationId, opts?: { transcript?: boolean }): void {
    if (!opts?.transcript) this.hooks?.supersedeVoice?.(key);
  }

  /** Call off everything waiting on the user here — questions and voice transcripts alike. */
  private callOffPending(key: ConversationId, reason: string): void {
    this.hooks?.cancelPendingAsks?.(key, reason);
    this.hooks?.cancelPendingVoice?.(key, reason);
  }

  /**
   * `/title` — show this conversation's name, set it, or have it named afresh.
   *
   * Bare, it reports what the lane was last renamed to, which is the only thing knowable: Telegram
   * offers no way to read a topic's current name back, so a name typed into the Telegram UI is
   * invisible here. The wording says "last set by me" rather than "the title" for exactly that
   * reason — claiming to know the topic's name would be a lie roughly half the time.
   *
   * `/title auto` forgets the recorded name, which is what re-arms the automatic naming: a
   * conversation is named once and only while it has no name on record, so releasing the record is
   * the only way to ask for another. The lane keeps its current name until the next message
   * produces one, because clearing it to nothing in the meantime would be strictly worse than a
   * stale name.
   *
   * Unlike the automatic path this is never silently skipped: an explicit command gets an explicit
   * answer, including the reason it failed. The address is the incoming message's own, not
   * `activeAddress` — `/title` is answered between turns, when there is no active one.
   */
  private async applyTitleCommand(
    key: ConversationId,
    fallbackAgent: string,
    rest: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): Promise<string> {
    const wanted = rest.trim();
    const platformId = msg.conversation.platform;
    const current = this.store?.conversationTitle(key);

    if (wanted.toLowerCase() === 'auto') {
      if (!current) {
        return 'I have not named this topic yet — it gets a name after the next message.';
      }
      this.store?.releaseConversationTitle(key);
      return `Forgot the name I gave this topic ("${current}"). It keeps that name until the next message, which will name it afresh.`;
    }

    if (!wanted) {
      if (!current) {
        return 'I have not named this topic. `/title <name>` to name it now, or it gets named automatically after the next message.';
      }
      return this.store?.titlePinned(key)
        ? `This topic is named "${current}" — you set it, and it will not be renamed. \`/title auto\` to have it named afresh.`
        : `I named this topic "${current}" from its opening message, and will not rename it again. \`/title <name>\` to set your own.`;
    }

    const agentId = this.boundAgentFor(key, fallbackAgent);
    // Tagged like the automatic path, so a hand-named topic still says which agent answers in it —
    // the tag is the part that has to be uniform to be worth reading down a topic list. Idempotent,
    // so `/title [cc] foo` does not end up double-tagged.
    const failure = await this.retitleLane(
      key,
      agentId,
      address,
      platformId,
      formatLaneTitle(agentId, wanted),
      true
    );
    if (failure) return `Could not rename this topic: ${failure}`;
    return `Renamed this topic to "${wanted}". \`/title auto\` to have it named automatically again.`;
  }

  // ───────────────────────── conversation title (thread/topic rename) ─────────────────────────

  /**
   * Name this conversation's chat lane after its opening message — once, and then never again.
   *
   * Why this exists at all: a Telegram forum topic keeps whatever name it was created with for as
   * long as it exists, so a topic-per-task workflow ends up as a column of names typed before any
   * of the work happened.
   *
   * ── Once ────────────────────────────────────────────────────────────────────────────────────
   * Called at the start of every turn, and acts on the first one only. The predecessor followed
   * the harness's ACP `session_info_update` instead, which re-reports as a session moves on: topics
   * drifted to whatever had been discussed most recently, which is not what a name is for. The user
   * navigates the topic column by memory of where things are, so a name that keeps moving costs
   * more than one that is slightly off. `/title` and `/new` are the ways to get a different one.
   *
   * ── Beside the turn, not after it ───────────────────────────────────────────────────────────
   * Nothing here reads the answer, so nothing here has to wait for one: the whole body runs off the
   * turn's thread and the lane is renamed the moment the model replies, seconds into a turn that
   * may run for minutes. That is the point of the split — the topic column is how the user finds
   * the work that is currently happening, and it is least useful when it is stale.
   *
   * ── Best-effort, every early return a decision ──────────────────────────────────────────────
   * - no lane on record — the conversation has never run a turn, so there is nothing to point at.
   * - no `thread` (checked in retitleLane) — the address IS the chat. Renaming a whole Telegram
   *   group because an agent summarised one conversation in it would be indefensible.
   * - already named — the once rule. Also what makes this safe to call unconditionally.
   * - naming in flight — the model call is slow enough (a second or two) for a fast follow-up turn
   *   to arrive underneath it, and the store gate cannot catch that because nothing is recorded
   *   until the platform accepts the rename.
   * - `autoRenameThread: false` — the user curates lane names by hand (see the setting).
   * - the API refused — a non-forum chat, a revoked admin right, a rate limit. Nothing is recorded,
   *   so the next turn tries again.
   *
   * Reads the lane rather than `activeAddress`: the naming call outlives the turn that triggered
   * it, by which time the turn's address has been cleared.
   *
   * NOT guarded on "did a human rename this in the Telegram UI": Telegram exposes no way to read a
   * topic's current name, so that question is unanswerable and pretending otherwise would just
   * move the failure somewhere less obvious. `/title` and the setting are the ways to opt out.
   */
  private nameConversation(id: ConversationId, seed: string): void {
    try {
      const lane = this.laneOf(id);
      if (!this.conversations.has(id) || !lane || !seed.trim()) return;
      if (this.config.platforms[lane.platformId]?.autoRenameThread === false) return;
      // Ask whether the rename could land BEFORE paying for the name.
      //
      // `retitleLane` below already refuses on both counts, but it refuses at the END — after
      // `summarizeTitle` has spent a model call on a subject nothing will ever use. Every
      // thread-less platform was paying that once per conversation, forever: QQ, LINE, WeCom and
      // DingTalk declare no rename at all, and a plain channel on the four that do has no lane to
      // rename. The two conditions are retitleLane's own first two gates; it stays the authority
      // on what they mean, and it keeps them because `/title` needs to SAY which one fired.
      if (!this.canRetitle(lane.platformId, lane.address)) return;
      if (this.store?.conversationTitle(id) !== undefined) return;
      if (this.namingInFlight.has(id)) return;
      this.namingInFlight.add(id);
      void (async () => {
        try {
          const subject = await this.summarizeTitle(seed);
          if (!subject) return;
          // Re-read rather than close over what was true when the call started. `/title` may have
          // pinned a name of the user's own while the model was thinking — silently reverting a
          // command the user just typed is a bug under any naming policy — and a `/oc` in the same
          // window would leave the tag naming the agent that has just stopped answering here.
          if (this.store?.conversationTitle(id) !== undefined) return;
          const state = this.conversations.get(id);
          const target = this.laneOf(id);
          if (!state || !target) return;
          await this.retitleLane(
            id,
            state.agentId,
            target.address,
            target.platformId,
            formatLaneTitle(state.agentId, subject)
          );
        } finally {
          this.namingInFlight.delete(id);
        }
      })();
    } catch (e) {
      // The gates above run on the turn's own thread, one line before the agent is asked anything.
      // Anything they throw would cost the user their answer to buy a topic name — the wrong trade
      // in every case, so it is logged and the turn proceeds unnamed.
      console.warn(`[title] could not start naming ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * The subject half of a lane name: a summary of the opening message when `title.llm` is
   * configured and answers, else the message itself cut to length.
   *
   * The fallback is deliberately taken on failure rather than leaving the conversation unnamed. A
   * poor name that gets recorded ends the naming attempt; no name means every subsequent turn
   * re-runs the call, which against a misconfigured endpoint is an unbounded stream of them.
   */
  private async summarizeTitle(seed: string): Promise<string> {
    const llm = this.config.title.llm;
    if (!llm) return fallbackTitle(seed);
    return (await generateTitle(llm, seed)) ?? fallbackTitle(seed);
  }

  /**
   * Rename one conversation's lane and remember what it was renamed to.
   *
   * Shared by the automatic path and `/title`, so the two cannot disagree about what a successful
   * rename means. Returns why it did not happen, or undefined on success — the automatic caller
   * ignores that and `/title` reports it, which is the only difference between them.
   *
   * Deliberately NOT where the once-only rule lives: this renames whatever it is told to. The
   * caller decides whether a conversation may be named (see nameConversation), because `/title` is
   * allowed to rename one that already has a name and the automatic path is not.
   */
  /**
   * Whether a rename of this lane could succeed at all, ignoring what it would be renamed to.
   *
   * Exists so the automatic namer can check cheaply before spending a model call; see the call
   * site. `retitleLane` deliberately re-checks rather than calling this and trusting it, because
   * it owes the user a sentence naming WHICH condition failed.
   */
  private canRetitle(platformId: string, address: ConversationAddress): boolean {
    // Only the declaration is consulted; `renameThread` itself is a required member of
    // PlatformAdapter that throws when unsupported, so its presence says nothing.
    return Boolean(this.platforms.get(platformId)?.capabilities.renameThread && address.thread);
  }

  private async retitleLane(
    id: ConversationId,
    agentId: string,
    address: ConversationAddress,
    platformId: string,
    title: string,
    /** A name the user typed. Recorded as such, so `/title` can say who named the topic. */
    pinned = false
  ): Promise<string | undefined> {
    const platform = this.platforms.get(platformId);
    if (!platform?.capabilities.renameThread || !platform.renameThread) {
      return 'this platform cannot rename a conversation lane';
    }
    if (!address.thread) {
      return 'this conversation is not in a thread or topic, so there is no name to change';
    }
    const wanted = title.trim();
    if (!wanted) return 'that is an empty title';
    try {
      await platform.renameThread(address, wanted);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[title] could not rename ${id} to "${wanted}": ${reason}`);
      return reason;
    }
    // Recorded only AFTER the platform accepted it, so a failed rename is retried next time rather
    // than remembered as done.
    this.store?.setConversationTitle(id, agentId, wanted, pinned);
    // The library already holds this conversation's turns; give them the name it just took, so a
    // search hit is a title rather than an id. Guarded like every other library write.
    this.history?.setTitle(id, wanted);
    console.log(`[title] ${id} renamed to "${wanted}"${pinned ? ' (pinned)' : ''}`);
    return undefined;
  }

  /**
   * Point an auto-created thread's key at the conversation that opened it.
   *
   * Called by TurnRunner right after autoThread creates a thread and moves the turn into it. The
   * alias is registered under the key that a message ARRIVING in that thread will compute, so the
   * lookup in route() is a plain map hit with no re-derivation.
   *
   * Only location-dependent scopes need it. Under per_user and shared the key ignores where the
   * message was written, so the thread already resolves to this same conversation — and building a
   * key there would need the sender, which an outbound thread creation has no business inventing.
   */
  private adoptThread(
    id: ConversationId,
    address: ConversationAddress,
    platformId: string
  ): void {
    if (!this.conversations.has(id)) return;
    const ref = {
      platform: platformId,
      channel: address.channel,
      ...(address.thread != null ? { thread: address.thread } : {}),
      kind: 'thread' as const,
      // Not part of a per_thread/per_channel key; the guard below keeps the other scopes out.
      user: '',
    };
    const scope = resolveScope(this.config, ref);
    if (scope !== 'per_thread' && scope !== 'per_channel') return;
    const threadKey = conversationKey(scope, ref);
    if (threadKey === id) return; // e.g. per_channel on a lane-style platform: same channel
    this.threadAliases.set(threadKey, id);
    console.log(`[conversation] auto-thread ${formatAddress(address)} adopted by ${id}`);
  }

  /**
   * Refuse to move a topic that already has a session to a different agent, and hand the user what
   * they need to carry the work elsewhere. Returns true when it refused (no turn runs, nothing binds).
   *
   * ── Why a topic does not switch ─────────────────────────────────────────────────────────────
   * A topic is one piece of work with one agent's context behind it. Switching in place used to be
   * supported (the store keeps a session id per agent so `/oc` → `/cc` → `/oc` could resume), and
   * on 2026-09-30 none of the 335 conversations on the live deployment had ever held more than one
   * agent's session: the feature was unused, while its cost was real — the topic's `[cc]` tag, its
   * header and its history all describe an answerer who is no longer there, and the new agent
   * starts blind in a place that looks like it has context. So the rule is now the operator's: to
   * continue with another agent, open another topic and give that agent the session id — it can
   * read the earlier conversation off disk itself (a claude session id is literally the file name,
   * `~/.claude/projects/<dir>/<id>.jsonl`), which is a better handover than a context-free rebind.
   *
   * ── What still switches ─────────────────────────────────────────────────────────────────────
   * Only a topic whose bound agent has a session id on record is locked. Before that there is
   * nothing to strand — a new topic, one whose first turn never got a session up, or one that
   * `/new` (or `/cd`, which also drops the ids) has just emptied — so naming an agent there is
   * CHOOSING one, and rebind() still does it. Naming the agent already bound is not a switch at all.
   *
   * The id is read from the store rather than from in-memory state so the first message after a
   * restart is held to the same rule: in-memory state is gone then, the session is not.
   */
  /**
   * The agent a previous run bound this conversation to, if it is still configured. A binding to an
   * agent since removed (then reloaded or restarted) counts as none: there is nothing left to
   * resume, and keeping it would fail every turn.
   */
  private storedBinding(key: ConversationId): string | undefined {
    const stored = this.store?.boundAgent(key);
    return stored !== undefined && findAgent(this.config, stored) ? stored : undefined;
  }

  /**
   * Whether an existing conversation moves to `choice.agentId`: on an explicit `/name` for another
   * agent, or when the agent it is bound to was removed by a config reload — then it moves on to
   * whoever routing picks now.
   */
  private mustRebind(key: ConversationId, state: ConversationState, choice: AgentChoice): boolean {
    if (choice.explicit && choice.agentId !== state.agentId) return true;
    if (findAgent(this.config, state.agentId)) return false;
    console.log(`[reload] ${key}: agent "${state.agentId}" is no longer configured; rebinding to "${choice.agentId}"`);
    return true;
  }

  /**
   * Why an explicit switch to `agentId` is refused here — the topic already has a session with
   * another agent — or undefined when it is not. `wantedCommand` is how the user would ask for that
   * agent in a new topic: its harness command, or `/agent <id>` where that is how they asked.
   */
  private switchRefusal(key: ConversationId, agentId: string, wantedCommand?: string): string | undefined {
    const bound = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
    if (!bound || bound === agentId) return undefined;
    // Removed from config since: its session cannot be resumed any more, so there is nothing to lose.
    if (!findAgent(this.config, bound)) return undefined;
    const sessionId = this.store?.agentSession(key, bound);
    if (sessionId === undefined) return undefined;
    console.log(`[conversation] ${key} is bound to "${bound}" with a session; refused a switch to "${agentId}"`);
    return agentSwitchRefusalText({
      bound: agentDisplayName(findAgent(this.config, bound), bound),
      wanted: agentDisplayName(findAgent(this.config, agentId), agentId),
      wantedCommand: wantedCommand ?? `/${harnessCommandName(findAgent(this.config, agentId)?.harness) ?? agentId}`,
      sessionId,
      workdir: this.workdirOf(key, bound),
    });
  }

  private refuseAgentSwitch(
    key: ConversationId,
    choice: AgentChoice,
    address: ConversationAddress,
    msg: InboundMessage
  ): boolean {
    if (!choice.explicit) return false;
    const text = this.switchRefusal(key, choice.agentId);
    if (text === undefined) return false;
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(address, text)
      .catch((e) => console.warn('[conversation] failed to refuse an agent switch:', e instanceof Error ? e.message : e));
    return true;
  }

  /**
   * Move a conversation to a different agent, on an explicit `/name` — reached only while the
   * conversation has no session to lose (see refuseAgentSwitch, which answers everything else).
   *
   * What is disposed and what is NOT:
   *  - the OUTGOING agent's subprocess is disposed, because leaving it resident would keep
   *    streaming into a conversation it no longer owns;
   *  - any session id the INCOMING agent already has here is kept and resumed. With the switch
   *    lock that only happens on a conversation that held two agents before the lock existed.
   *
   * The header is re-armed because the answerer changed — that is exactly what it reports.
   */
  private rebind(
    key: ConversationId,
    state: ConversationState,
    agentId: string,
    platformId: string,
    address: ConversationAddress,
    /** Say it here (the default), or leave the announcement to the caller, which gets it back. */
    announce = true
  ): string {
    const previous = state.agentId;
    this.agents.dispose(key);
    state.agentId = agentId;
    state.headerSent = false;
    // The model override belonged to the previous agent's model list; carrying it over would hand
    // the new harness a name it may not know.
    state.modelOverride = undefined;
    // Same reasoning for the context snapshot, and it matters more: `/context` labels the numbers
    // with the bound agent's name, so keeping the outgoing agent's usage would attribute one
    // harness's context to another. The incoming agent reports its own on its next turn.
    this.forgetUsage(key, state);
    this.store?.bind(key, agentId);
    const name = agentDisplayName(findAgent(this.config, agentId), agentId);
    const resuming = this.store?.agentSession(key, agentId) != null;
    console.log(
      `[conversation] ${key} rebound ${previous} → ${agentId}${resuming ? ' (resuming its existing session)' : ''}`
    );
    const text = resuming ? `▸ back to ${name} — resuming where you left off` : `▸ ${name} is answering this conversation now`;
    if (announce) {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, text)
        .catch((e) => console.warn('[conversation] failed to ack the rebind:', e instanceof Error ? e.message : e));
    }
    return text;
  }

  /**
   * `/agent <id>`, typed or picked from the menu: bind this conversation to that agent — by id, so
   * any agent is reachable, including a second one of the same harness on another machine, which
   * the harness commands (`/cc`) cannot name. The same rules as `/cc`: a topic with a session keeps
   * its agent (switchRefusal says what to do instead), and one without simply moves.
   *
   * Returns what to tell the user; the caller decides where (a reply, or the menu edited in place).
   */
  chooseAgent(key: ConversationId, agentId: string, conv: ConversationRef): string {
    const def = findAgent(this.config, agentId);
    if (!def) return `No agent "${agentId}" is configured.`;
    const refused = this.switchRefusal(key, agentId, `/agent ${agentId}`);
    if (refused !== undefined) return refused;
    const name = agentDisplayName(def, agentId);
    const state = this.conversations.get(key);
    if (state?.agentId === agentId) return `${name} is already answering this topic.`;
    if (state) return this.rebind(key, state, agentId, conv.platform, addressOf(conv), false);
    // First sight of this conversation: bind it now, so the next message is answered by the choice.
    this.conversations.set(key, {
      merger: this.buildMerger(key),
      agentId,
      platform: conv.platform,
      lastActivityAt: this.clock.now(),
      ...this.restoredModel(key, agentId),
    });
    this.store?.bind(key, agentId);
    console.log(`[conversation] ${key} bound to agent "${agentId}" (chosen with /agent)`);
    return `▸ ${name} is answering this conversation now`;
  }

  /**
   * `/agent` (which agent answers, chosen by id rather than by harness — see chooseAgent) and `/cd`
   * (where the agent works, as opposed to `/setting`, which is how it is configured). Answered here
   * for the same reason `/new` is: each is the gateway's own decision, recorded per conversation,
   * and neither asks the agent anything. True when `setting` was one of them.
   */
  private answerPlacementCommand(
    key: ConversationId,
    setting: { name: string; rest?: string },
    fallbackAgent: string,
    msg: InboundMessage,
    ack: (what: string, text: string) => void
  ): boolean {
    const name = setting.name.toLowerCase();
    if (AGENT_NAMES.has(name)) {
      const answer = this.applyAgentCommand(key, setting.rest, fallbackAgent, msg);
      if (answer.text !== undefined) ack('/agent', answer.text);
      // After the ack, so the menu lands under the line saying who it is for.
      if (answer.chosen) this.offerPlacement(key, answer.chosen, msg.conversation);
      return true;
    }
    if (!WORKDIR_NAMES.has(name)) return false;
    const agentId = this.boundAgentFor(key, fallbackAgent);
    const answer = (): void => {
      const text = this.applyWorkdirCommand(key, agentId, setting.rest, msg);
      // undefined = answered on another surface (the daemon posted a menu), the same
      // "already answered, say nothing" idiom applyCommandTranslation uses.
      if (text !== undefined) ack('/cd', text);
    };
    // An agent on a remote host: list its directory over there first — an asked-for `/cd` should
    // show what is there now, not what was there the last time somebody looked.
    const def = findAgent(this.config, agentId);
    if (def?.host) void this.refreshRemoteScan(def).then(answer);
    else answer();
    return true;
  }

  /**
   * `/agent`: the grouped menu where buttons exist, the grouped list otherwise, or — with an
   * argument — the agent it names. `text` is what to send (absent when a menu went out); `chosen`
   * is the agent a named pick resolved to, whether or not the binding took (offerPlacement checks).
   */
  private applyAgentCommand(
    key: ConversationId,
    rest: string | undefined,
    fallbackAgent: string,
    msg: InboundMessage
  ): { text?: string; chosen?: string } {
    const groups = agentGroups(this.config.agents);
    const current = this.boundAgentFor(key, fallbackAgent);
    const query = rest?.trim();
    if (!query) {
      const caps = this.platforms.get(msg.conversation.platform)?.capabilities;
      if (caps?.buttons && this.hooks?.onAgentMenuRequest && this.config.agents.length > 1) {
        this.hooks.onAgentMenuRequest(key, msg, { groups, current });
        return {};
      }
      return { text: agentListText(groups, current) };
    }
    const match = matchAgent(this.config.agents, query);
    if (match.kind === 'none') return { text: `No agent matches "${query}".\n${agentListText(groups, current)}` };
    if (match.kind === 'many') return { text: `"${query}" matches ${match.ids.join(', ')} — which one?` };
    return { text: this.chooseAgent(key, match.def.id, msg.conversation), chosen: match.def.id };
  }

  /**
   * After `/agent` chose an agent — typed, or picked from its menu — ask where it should work, the
   * way a bare `/cc` does in a conversation that has never run. Without this, choosing by id was the
   * one way into a new topic that skipped the question, and the web UI's new topic, which chooses by
   * id, would have had every agent start in its root.
   *
   * Asked only while the answer is free: the choice took (a refused switch leaves another agent
   * bound) and that agent has no session here, because a session is pinned to its directory and
   * moving would discard it. Declined silently when there is nothing to choose between, as after
   * `/new` (see offerWorkdirMenu).
   */
  offerPlacement(key: ConversationId, agentId: string, conv: ConversationRef): void {
    if (this.boundAgentFor(key, '') !== agentId) return;
    if (this.store?.agentSession(key, agentId) !== undefined) return;
    this.afterRemoteListing(findAgent(this.config, agentId), () => this.offerWorkdirMenu(key, agentId, conv));
  }

  /**
   * Answer an agent command whose harness this deployment configures no agent for, and say so.
   *
   * Returns true when it did (the caller then runs no turn).
   *
   * Why this is not a fall-through: resolveAgent declined the name, so the `/agy` prefix was NOT
   * consumed, and the message would reach whichever agent is bound still spelled `/agy hi`. That
   * agent reads it as one of ITS own slash commands, finds nothing, and emits nothing — the user
   * gets "ran a command, no output to display" and no hint that the command was never wired to
   * anything. Naming the missing agent is the same trade the generic vocabulary already makes:
   * an honest refusal beats a turn spent on a prompt the agent will misread.
   *
   * Scoped to agent commands only. A name outside that vocabulary may well be a harness's own
   * command (`/customize-opencode`) or a user skill, and those must still pass through.
   */
  private reportUnconfiguredHarness(
    choice: AgentChoice,
    msg: InboundMessage,
    address: ConversationAddress
  ): boolean {
    if (choice.explicit) return false; // something claimed the name: a rule, or a configured harness
    const name = parseTextCommand(msg.content)?.name;
    const missing = name ? unconfiguredHarnessCommand(this.config, name) : undefined;
    if (!missing) return false;
    console.log(`[command] /${name} names the unconfigured harness "${missing}"; not forwarded`);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(
        address,
        `No ${missing} agent is configured here, so /${missing} selects nothing. Add one under \`agents:\` in config.yaml (\`harness: ${missing}\`) and send /reload; /help lists the agents this gateway does have.`
      )
      .catch((e) => console.warn('[conversation] failed to report an unconfigured harness:', e instanceof Error ? e.message : e));
    return true;
  }

  /**
   * The commands this gateway answers itself (DAEMON_COMMANDS in core/command-translate.ts), all
   * intercepted before the merger and none ever forwarded to an agent. Returns true when one of
   * them answered, in which case no turn runs.
   *
   * Before the merger matters: it is what makes `/new` and `/stop` work MID-TURN, where a queued
   * message would be useless. Every one of them is tested on the already-STRIPPED content, so
   * `/cc /new` composes — the agent prefix is consumed upstream and the rest is still a command.
   *
   * `fallbackAgent` is the agent this message would route to, and is only consulted by the commands
   * that need to name one for a conversation with no binding yet.
   */
  private answerDaemonCommand(
    key: ConversationId,
    msg: InboundMessage,
    address: ConversationAddress,
    fallbackAgent: string
  ): boolean {
    const text = msg.content.trim();
    const conv = msg.conversation;
    const ack = (what: string, body: string): void => {
      void this.platforms
        .get(conv.platform)
        ?.sendMessage(address, body)
        .catch((e) => console.warn(`[conversation] failed to ack ${what}:`, e instanceof Error ? e.message : e));
    };

    // /new (alias /clear) discards this conversation's context — dispose the resident agent AND
    // drop every agent's persisted session id (else it resurrects on restart) — then ack.
    // Deliberately not forwarded: this is the one place the gateway is allowed to reset an agent,
    // and only because the user asked in so many words.
    if (CONTEXT_CLEAR_RE.test(text)) {
      const agentId = this.boundAgentFor(key, fallbackAgent);
      // Before the reset: a question still waiting on this conversation belongs to the context
      // being discarded, and its caller is blocked until somebody answers it. A transcript waiting
      // for its tap belongs to it too.
      this.callOffPending(key, 'context cleared');
      this.resetConversation(key);
      console.log(`[conversation] ${key} context cleared by ${conv.platform}:${conv.user}`);
      ack('context clear', 'Context cleared — the next message starts a fresh conversation.');
      // Then ask where that fresh conversation should happen. A reset is the one moment the
      // question costs nothing: there is no context to strand, and the previous topic's directory
      // is the least likely answer to still be right. Declined silently when there is nothing to
      // choose between (see offerWorkdirMenu) — a menu of one is not a question.
      this.afterRemoteListing(findAgent(this.config, agentId), () => this.offerWorkdirMenu(key, agentId, conv));
      return true;
    }

    // /stop ends the RUNNING TURN and nothing else — the counterpart to /new, which ends the
    // conversation. Never forwarded either: no harness has a slash command that could cancel the
    // very turn carrying it.
    if (STOP_RE.test(text)) {
      ack('/stop', this.stopAndReport(key, conv));
      return true;
    }

    // /kill ends the agent's PROCESS and keeps the conversation — the manual form of idle reclaim,
    // for the harness that /stop's cooperative cancel cannot reach. Intercepted here for the same
    // reason as /stop: it has to work mid-turn, which is exactly when a wedged agent is noticed.
    if (KILL_RE.test(text)) {
      ack('/kill', this.killAndReport(key, conv));
      return true;
    }

    // `/help` and `/reload`: about the gateway, not this conversation's agent.
    if (this.answerGatewayCommand(key, text, fallbackAgent, conv, address, ack)) return true;

    // `/setting` — the only one of these whose effect outlives the conversation: it writes
    // config.yaml. Parsed rather than regex-matched because, unlike the rest, it takes arguments.
    const setting = parseTextCommand(text);
    if (setting && SETTING_NAMES.has(setting.name.toLowerCase())) {
      this.handleSetting(key, setting.rest, fallbackAgent, address, msg);
      return true;
    }

    // `/agent` and `/cd`: who answers and where it works — both the gateway's own decisions.
    if (setting && this.answerPlacementCommand(key, setting, fallbackAgent, msg, ack)) return true;

    // `/title` — the manual counterpart to the automatic rename. Answered here because the lane
    // and the record of what it was last called both belong to the gateway; the harness has no
    // idea it is being displayed inside a Telegram topic at all.
    if (setting && TITLE_NAMES.has(setting.name.toLowerCase())) {
      void this.applyTitleCommand(key, fallbackAgent, setting.rest, address, msg).then((answer) =>
        ack('/title', answer)
      );
      return true;
    }
    // `/skills` — the agent's own vocabulary, as opposed to `/help`, which is the gateway's. The
    // two are disjoint on purpose and neither can show the other's: the gateway cannot enumerate a
    // harness's commands from config, and the harness has never heard of /new or /cd.
    if (setting && SKILLS_NAMES.has(setting.name.toLowerCase())) {
      const agentId = this.boundAgentFor(key, fallbackAgent);
      // Posted by the daemon, which is where the reported lists live (agentCommands). Same hook
      // shape as onPickerRequest, and the same reason: this registry holds no ACP state.
      this.hooks?.onSkillsRequest?.(key, agentId, msg);
      return true;
    }

    return false;
  }

  /**
   * The daemon commands about the gateway itself rather than this conversation's agent: `/help`
   * and `/reload`. Split out of answerDaemonCommand only to keep that one readable.
   */
  private answerGatewayCommand(
    key: ConversationId,
    text: string,
    fallbackAgent: string,
    conv: ConversationRef,
    address: ConversationAddress,
    ack: (what: string, body: string) => void
  ): boolean {
    // `/help` lists what THIS gateway understands, which is the vocabulary a chat user has no other
    // way to discover — the platform menu shows names without saying who answers them, and the
    // harness's own /help knows nothing about /new, /oc or the generic translation.
    if (HELP_RE.test(text)) {
      this.sendHelp(key, fallbackAgent, conv.platform, address);
      return true;
    }
    // `/reload` applies config.yaml to the running daemon. About the whole deployment rather than
    // this conversation, but asked from one, so the answer goes back to it.
    if (!RELOAD_RE.test(text)) return false;
    console.log(`[conversation] /reload by ${conv.platform}:${conv.user}`);
    const reload = this.hooks?.onReloadRequest;
    if (!reload) ack('/reload', 'Reloading the config is not available in this daemon.');
    else void reload().then((summary) => ack('/reload', summary));
    return true;
  }

  /**
   * `/stop`: end what is running here and say what that was.
   *
   * A question on screen is part of what is being stopped — the turn holding it is about to be
   * cancelled — so it is retired first, rather than left live for the rest of its ten-minute
   * timeout, where it would also read the next message as its answer. And it counts as work even
   * when the merger reads idle: a reverse `ask` from a background process blocks outside any turn,
   * so answering "nothing is running" to the person who just called one off would be flatly untrue.
   */
  private stopAndReport(key: ConversationId, conv: ConversationRef): string {
    const { outcome, calledOff, transcripts } = this.stopWithPending(key, 'stopped');
    // A /super job's turn ends once it has handed the work out, so stopping "this" while its
    // sub-agents work used to stop nothing at all — and the person had to open each of them.
    const subs = this.hooks?.stopSubAgents?.(key) ?? 0;
    console.log(`[conversation] ${key} /stop by ${conv.platform}:${conv.user} → ${outcome}${subs ? ` (+${subs} sub-agent(s))` : ''}`);
    const also = subs ? `${subs} sub-agent${subs === 1 ? '' : 's'} it started` : '';
    if (outcome === 'idle' && calledOff > 0) return also ? `${STOP_ACK_QUESTION}\n⏹ Stopped ${also}.` : STOP_ACK_QUESTION;
    if (outcome === 'idle' && transcripts > 0) return also ? `${STOP_ACK_VOICE}\n⏹ Stopped ${also}.` : STOP_ACK_VOICE;
    if (outcome === 'idle' && also) return `⏹ Stopped the ${also}. Their conversations are kept — a message in one carries on from it.`;
    return also ? `${STOP_ACK[outcome]}\n⏹ Also stopped the ${also}.` : STOP_ACK[outcome];
  }

  /**
   * What `/stop` does to a conversation, without saying so: the questions and transcripts waiting
   * there are called off, then the turn or background work is stopped. Public for the sub-agents a
   * `/stop` reaches from the topic that opened them (Delegation.stopOpened), which must leave no
   * question live either.
   */
  stopWithPending(key: ConversationId, reason: string): { outcome: StopOutcome; calledOff: number; transcripts: number } {
    const calledOff = this.hooks?.cancelPendingAsks?.(key, reason) ?? 0;
    // A transcript waiting for its tap is queued input like any other, and /stop drops the queue.
    const transcripts = this.hooks?.cancelPendingVoice?.(key, reason) ?? 0;
    return { outcome: this.stopConversation(key), calledOff, transcripts };
  }

  /** `/kill`: end the agent process here and say what that did (see killConversation). */
  private killAndReport(key: ConversationId, conv: ConversationRef): string {
    const outcome = this.killConversation(key);
    console.log(`[conversation] ${key} /kill by ${conv.platform}:${conv.user} → ${outcome}`);
    return KILL_ACK[outcome];
  }

  /**
   * Whether this message is the answer to a question the daemon has on screen here, in which case
   * it has been recorded as one and no turn runs (see the hook's doc for why the placement in
   * route() is the load-bearing part).
   *
   * Attachments are NOT an answer: the wire field a typed answer travels in takes a string, so an
   * image sent here could only be silently dropped. Such a message is an ordinary new message —
   * offered to the running turn or queued behind it — and `/stop` stays the way out of a question
   * whose options are all wrong on a harness that offers no free-text field.
   *
   * Nor is a command from the generic vocabulary (`/usage`, `/model`, `/compact`, …). Those are
   * menu entries the gateway registered itself, so a user tapping one is asking the gateway, not
   * answering the agent — and filing `/usage` away as the answer to "which approach?" both loses the
   * question and answers it with nonsense. Only the registered names, not anything with a leading
   * slash: a path like `/srv/data` is a perfectly good answer to "where should it go?".
   */
  private answersPendingQuestion(key: ConversationId, msg: InboundMessage): boolean {
    if ((msg.attachments?.length ?? 0) > 0) return false;
    const answer = msg.content.trim();
    if (answer.length === 0) return false;
    const command = parseTextCommand(answer);
    if (command && isGenericCommand(command.name)) return false;
    return this.hooks?.answerPendingAsk?.(key, answer) ?? false;
  }

  /**
   * Answer `/help` with this deployment's whole registered vocabulary.
   *
   * Built from the same tables that drive registration (core/command-translate.ts), so a command
   * cannot appear in the platform menu without appearing here — the drift that makes a help text
   * worse than none. Reported against the agent bound right now, because the generic half is
   * harness-dependent: `/compact` is real on claude and a dead entry on opencode.
   *
   * `fallback` is the agent this message would route to, used only when the conversation has no
   * binding yet (a `/help` as the very first thing said in a channel).
   */
  private sendHelp(
    key: ConversationId,
    fallback: string,
    platformId: string,
    address: ConversationAddress
  ): void {
    const agentId = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key) ?? fallback;
    const def = findAgent(this.config, agentId);
    const adapter = this.platforms.get(platformId);
    console.log(`[command] /help answered for ${key} (agent ${agentId})`);
    void adapter
      ?.sendMessage(address, buildHelpText(this.config, { agent: agentId, harness: def?.harness }, commandSurface(adapter)))
      .catch((e) => console.warn('[conversation] failed to send help:', e instanceof Error ? e.message : e));
  }

  /**
   * Answer `/setting`, in one of four shapes:
   *
   *   `/setting`                    → the whole screen (menu where buttons work, text otherwise)
   *   `/setting <key>`              → that setting's values (menu) or what it accepts (text)
   *   `/setting <key> <value>`      → write it, and say what took effect when
   *   `/setting <not a setting>`    → refuse by name, pointing at the file
   *
   * The value form works identically on all eight platforms, which is why it exists alongside the
   * menu rather than under it: a menu is the right answer to "what are my options" on a phone, and
   * useless for setting a model name a harness never advertised.
   *
   * `fallbackAgent` is the agent this message would route to, used only when the conversation has
   * no binding yet (a `/setting` as the very first thing said in a channel) — same as sendHelp.
   */
  private handleSetting(
    key: ConversationId,
    rest: string,
    fallbackAgent: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    const platformId = msg.conversation.platform;
    const reply = (text: string): void => {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, text)
        .catch((e) => console.warn('[setting] failed to answer:', e instanceof Error ? e.message : e));
    };
    // NOT warmed, unlike `/model` (see warmModelSelector). A settings screen is mostly rows that
    // have nothing to do with the agent, and it is reached by `/setting` with no argument and by
    // clicking rows afterwards — so warming here would spawn a child to answer `/setting banana`,
    // and warming at the click instead would mean making the daemon's whole sync menu path async.
    // The model row keeps its own "no models offered" sentence until the session is up; `/model` is
    // the surface that actually needed to work cold, and does.
    const ctx = this.settingsContext(key, fallbackAgent);
    const caps = this.platforms.get(platformId)?.capabilities;
    const canMenu =
      caps !== undefined &&
      settingsMenuSurface(caps) === 'menu' &&
      this.hooks?.onSettingMenuRequest !== undefined;

    const [rawKey = '', ...valueParts] = rest.trim().split(/\s+/);
    if (!rawKey) {
      console.log(`[setting] listing settings for ${key}`);
      if (canMenu) this.hooks!.onSettingMenuRequest!(key, msg, { rows: this.settingRows() });
      else reply([settingsListText(this.config), this.hooks?.scheduleSummary?.()].filter(Boolean).join('\n'));
      return;
    }

    // Scheduled tasks are reached from the settings screen but are not settings: no config path, no
    // parser, no ack of their own (see core/schedule-menu.ts). Handed to the daemon, which holds them.
    if (SCHEDULE_SETTING_NAMES.has(rawKey.toLowerCase())) {
      if (this.hooks?.onScheduleSetting) this.hooks.onScheduleSetting(key, msg, valueParts, canMenu);
      else reply('Scheduled tasks are not enabled in this gateway.');
      return;
    }

    const resolved = resolveSettingKey(rawKey, this.config, ctx);
    if (resolved.kind === 'refused') {
      console.log(`[setting] refused "${rawKey}" for ${key}`);
      reply(resolved.text);
      return;
    }
    if (resolved.kind === 'unknown') {
      reply(settingUnknownKeyText(rawKey));
      return;
    }

    const row = resolved.row;
    const value = valueParts.join(' ').trim();
    if (!value) {
      this.answerSettingKey(key, row, msg, canMenu, fallbackAgent, reply);
      return;
    }
    reply(settingAckText(this.applySetting(key, row, value)));
  }

  /** `/setting <key>` alone: that setting's value menu, or its detail text where there is no menu. */
  private answerSettingKey(
    key: ConversationId,
    row: SettingRow,
    msg: InboundMessage,
    canMenu: boolean,
    fallbackAgent: string,
    reply: (text: string) => void
  ): void {
    if (canMenu) {
      const { options, hint, asking } = this.settingOptionsFor(key, row);
      this.hooks!.onSettingMenuRequest!(key, msg, {
        rows: this.settingRows(),
        open: { row, options, ...(hint ? { hint } : {}) },
        ...(asking ? { asking } : {}),
      });
      return;
    }
    const detail = (): void => reply(settingDetailText(row, this.config, this.settingsContext(key, fallbackAgent)));
    // The text answer waits for the list, since it cannot be redrawn once sent.
    if (row.id === 'model' && row.target && this.modelCatalog.shouldAsk(row.target)) {
      void this.modelCatalog.ask(row.target).then(detail);
      return;
    }
    detail();
  }

  /**
   * What the settings module needs to know about this conversation.
   *
   * The model list comes from `peek`, never `getOrCreate`: a settings screen must not spawn an
   * agent child just to fill a menu — the same trade onPickerRequest makes, and the reason an
   * absent list has its own sentence instead of a blank menu. `/model` makes the opposite trade
   * (warmModelSelector) because there the model list IS the answer being asked for.
   */
  private settingsContext(key: ConversationId, fallbackAgent: string): SettingsContext {
    const boundAgent =
      this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key) ?? fallbackAgent;
    return {
      boundAgent,
      models: this.agents.peek(key)?.modelSelector?.()?.options ?? [],
      lists: (agentId) => this.modelCatalog.get(agentId),
      pods: this.podModels(),
    };
  }

  /** The catalog of every agent's model list (model-catalog.ts), over this registry's sessions. */
  private makeModelCatalog(): ModelCatalog {
    return new ModelCatalog({
      agents: this.agents,
      defOf: (agentId) => findAgent(this.config, agentId),
      liveSelector: (agentId) => {
        for (const [id, state] of this.conversations) {
          if (state.agentId !== agentId) continue;
          const selector = this.agents.peek(id)?.modelSelector?.();
          if (selector && selector.options.length > 0) return selector;
        }
        return undefined;
      },
      tokenFor: (sid) => this.tokens.tokenFor(sid as ConversationId),
      forget: (sid) => {
        this.store?.clear(sid);
        this.tokens.release(sid as ConversationId);
      },
    });
  }

  /**
   * The pods' agents and what each pod.yaml says of its model (config/pods.ts podAgentModels): what
   * a model row needs to write to `podModels` and to say whose value it shows. Read from the files
   * each time a menu is drawn — the merged Config holds only the answer.
   */
  private podModels(): PodModels {
    try {
      return podAgentModels(readRawConfigIfExists() ?? {}, readPods(configDir()));
    } catch (e) {
      console.warn('[setting] could not read the pods\' agents:', e instanceof Error ? e.message : e);
      return new Map();
    }
  }

  /** Every row of the settings screen, read fresh from the live Config (the daemon rebuilds menus with this). */
  settingRows(): SettingRow[] {
    return settingsRows(this.config, this.podModels());
  }

  /** The agent answering a conversation, as the settings screen names it ("this topic"). */
  settingsBoundAgent(id: ConversationId): string {
    return this.settingsContext(id, this.config.routing.default).boundAgent;
  }

  /**
   * The values one row can offer right now, or the sentence explaining why it offers none.
   *
   * A model row whose list is not known yet starts asking for it (ModelCatalog) and says so —
   * `asking` settles when there is an answer, and the caller redraws with it. Any agent, cold or
   * not: the answer comes from a session brought up just to ask, never from this conversation's
   * own, which would close a new topic's choice of agent (agentCatalogForRef) as a side effect.
   */
  settingOptionsFor(
    id: ConversationId,
    row: SettingRow,
    /** False for the redraw that an answer triggers: a failed ask is shown, not asked again. */
    ask = true
  ): { options: SettingOption[]; hint?: string; asking?: Promise<unknown> } {
    let ctx = this.settingsContext(id, this.config.routing.default);
    let asking: Promise<unknown> | undefined;
    // The review model's list belongs to the reviewer (modelListAgent), not to the row's target:
    // asking the same agent the list screen will name keeps the two from disagreeing.
    const listAgent = modelListAgent(row, this.config);
    if (ask && listAgent && !(listAgent === ctx.boundAgent && ctx.models.length > 0)) {
      if (this.modelCatalog.shouldAsk(listAgent)) {
        asking = this.modelCatalog.ask(listAgent);
        ctx = this.settingsContext(id, this.config.routing.default);
      }
    }
    const hint = settingTypedOnlyHint(row, this.config, ctx);
    return { options: settingOptions(row, this.config, ctx), ...(hint ? { hint } : {}), ...(asking ? { asking } : {}) };
  }

  /** Whether an agent's model list is being asked for right now (the settings screen's spinner). */
  modelListLoading(agentId: string): boolean {
    return this.modelCatalog.get(agentId)?.kind === 'loading';
  }

  /**
   * Write one setting, from either surface.
   *
   * Public because the daemon calls it on a button click, exactly as it calls applyModelChoice —
   * and for the same reason both live here: the registry is the only side holding the Config that
   * has to be mutated and the sessions whose model list validates the value.
   */
  applySetting(id: ConversationId, row: SettingRow, raw: string): SettingApplyResult {
    const state = this.conversations.get(id);
    // A `/model` override outranks agents[].model (see agent-acp applyModelPreference), so writing
    // the default while one is in force would look like it did nothing here. The ack says so.
    const overridden =
      row.id === 'model' && row.target === state?.agentId && state?.modelOverride !== undefined;
    return this.settings.apply(
      row,
      raw,
      this.settingsContext(id, this.config.routing.default),
      overridden
    );
  }

  /**
   * Answer a bare agent command (`/oc` with no prompt), whose binding route() has already applied.
   *
   * What it answers WITH depends on how far along the conversation is, and that ordering is the
   * point:
   *  - a conversation this agent has never run in gets the DIRECTORY menu, because "which project"
   *    is the question that has to be answered before any other one matters — and it is the only
   *    moment the answer is free, since there is no context yet to throw away;
   *  - one already under way gets the harness's own command list, which is the ONLY way those
   *    commands are reachable (core/command-translate.ts), or the binding ack for a harness that
   *    reports none (agy).
   *
   * "Already under way" is read off the STORE, not off anything in memory, and that is deliberate:
   * an idle-reclaimed conversation has no child and no live session, yet its agent's session id is
   * still recorded and its next turn resumes it (see reclaimIdleSessions). Asking a returning user
   * to re-pick a directory would be both wrong and destructive — the reclaim is invisible to them,
   * and the answer would reset the very context that was just carefully preserved.
   *
   * A rebind, when there was one, already announced itself in rebind(); this adds what was asked
   * for rather than repeating who is answering.
   */
  private answerBareCommand(
    key: ConversationId,
    state: ConversationState,
    platformId: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    // No store means no place to record a directory, so `/cd` cannot work at all here — fall
    // straight through to the behaviour this command has always had.
    const started = this.store?.agentSession(key, state.agentId) !== undefined;
    if (started) {
      this.answerBareCommandNow(key, state, platformId, address, msg, false);
      return;
    }
    this.afterRemoteListing(findAgent(this.config, state.agentId), () =>
      this.answerBareCommandNow(key, state, platformId, address, msg, true)
    );
  }

  /** answerBareCommand once any remote listing it needed is in: the menu, else the picker, else the ack. */
  private answerBareCommandNow(
    key: ConversationId,
    state: ConversationState,
    platformId: string,
    address: ConversationAddress,
    msg: InboundMessage,
    offerMenu: boolean
  ): void {
    if (offerMenu && this.offerWorkdirMenu(key, state.agentId, msg.conversation)) return;

    const def = findAgent(this.config, state.agentId);
    if (harnessHasPicker(def?.harness) && this.hooks?.onPickerRequest) {
      this.hooks.onPickerRequest(key, state.agentId, msg);
      return;
    }
    const name = agentDisplayName(def, state.agentId);
    void this.platforms
      .get(platformId)
      ?.sendMessage(address, `▸ this conversation is now answered by ${name} — just type to continue`)
      .catch((e) => console.warn('[route] failed to ack the binding:', e instanceof Error ? e.message : e));
  }

  /**
   * Rewrite a leading generic command into the target harness's native spelling, or refuse it.
   *
   * Native platform slash is global while agents are bound per conversation, so the registered menu is a
   * fixed generic vocabulary (see core/command-translate.ts) rather than the union of what each
   * agent reports — a union cannot say who owns an entry, and an entry invoked from it routes to
   * `routing.default` rather than to the agent that offered it.
   *
   * Agent commands (`/cc`, `/oc`, `/agy`) never reach here: resolveAgent answers them explicitly,
   * which consumes the prefix upstream — with a prompt they become that prompt, and bare they are
   * handled as a binding + picker in route().
   *
   * Returns the message to forward, or undefined when the command was rejected — in which case the
   * user has been told why and NO turn runs. Refusing here (rather than forwarding and letting the
   * agent puzzle over it) is the point: `/compact` on a harness with no compact is a mistake worth
   * naming, not a prompt worth spending a turn on.
   */
  private applyCommandTranslation(
    key: ConversationId,
    state: ConversationState,
    msg: InboundMessage,
    /** Where a message goes when the decision to forward it is made later (deferCustomCommand). */
    forward: (m: InboundMessage) => void
  ): InboundMessage | undefined {
    const parsed = parseTextCommand(msg.content);
    if (!parsed) return msg;
    const def = findAgent(this.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);
    if (this.refusedForNesting(parsed.name, msg)) return undefined;

    if (this.deferredForCustom(key, state, def, parsed, msg, forward)) return undefined;
    const result = translateCommand(parsed.name, def?.harness, (opt) => this.declaresOption(key, state.agentId, opt) === true);
    if (this.answersWhileBusy(state, parsed.name, result)) {
      this.answerBusyQuery(key, state, parsed.name, msg);
      return undefined;
    }
    if (result.kind === 'passthrough') {
      // Passthrough is what lets a skill name reach the agent untouched — and it is also how a
      // command the HARNESS's own CLI answers would get there, which on agy kills the session
      // outright (see isCliAnsweredCommand). Same choke point, opposite handling: run it as its
      // own process and reply with what it printed.
      if (isCliAnsweredCommand(parsed.name, def?.harness)) {
        void this.answerHarnessCliCommand(key, state, parsed.name, msg);
        return undefined;
      }
      return msg;
    }

    if (result.kind === 'local') {
      // No native spelling on this harness, but the gateway can answer from the live ACP session.
      // Never a turn: these are questions about the session, not work for the model.
      void this.answerLocalCommand(key, state, parsed.name, parsed.rest, msg);
      return undefined;
    }

    if (result.kind === 'unsupported') {
      // Point at the agent command rather than the harness name: the menu registers `/oc`, not
      // `/opencode`, and a harness that reports no list (agy) has nothing to point at at all.
      const own = harnessCommandName(def?.harness);
      const hint = harnessHasPicker(def?.harness) && own
        ? `\nIts own commands are available under /${own}.`
        : '';
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), `${name} does not support /${parsed.name}.${hint}`)
        .catch((e) => console.warn('[conversation] failed to report an unsupported command:', e instanceof Error ? e.message : e));
      console.log(`[command] /${parsed.name} unsupported by ${state.agentId} (${name}); not forwarded`);
      return undefined;
    }

    // Translated: rebuild the text with the native name, preserving any argument.
    if (result.native === parsed.name) return msg;
    const content = parsed.rest ? `/${result.native} ${parsed.rest}` : `/${result.native}`;
    console.log(`[command] /${parsed.name} → /${result.native} for ${state.agentId} (${name})`);
    return { ...msg, content };
  }

  /**
   * A custom harness that may have declared the option this command is answered from, when nothing
   * here knows yet whether it has: find out first (deferCustomCommand), and say the message is taken.
   */
  private deferredForCustom(
    key: ConversationId,
    state: ConversationState,
    def: AgentDef | undefined,
    parsed: { name: string; rest?: string },
    msg: InboundMessage,
    forward: (m: InboundMessage) => void
  ): boolean {
    const option = def?.harness === 'custom' ? customOptionFor(parsed.name) : undefined;
    if (!option || this.declaresOption(key, state.agentId, option) !== undefined) return false;
    void this.deferCustomCommand(key, state, parsed, msg, forward);
    return true;
  }

  /**
   * Whether an agent has declared an ACP config option (only `model` is asked about): yes when this
   * conversation's session reports its selector, or what the gateway learned of the agent says it has
   * a list; no when that says it offers none; undefined when nothing has been seen — a cold session
   * of an agent nobody has asked yet.
   */
  private declaresOption(key: ConversationId, agentId: string, option: string): boolean | undefined {
    if (option !== 'model') return undefined;
    if (this.agents.peek(key)?.modelSelector?.()) return true;
    const known = this.modelCatalog.get(agentId);
    if (known?.kind === 'list') return true;
    if (known?.kind === 'none') return false;
    return undefined;
  }

  /**
   * A command a custom harness may or may not let the gateway answer, before anything has said which.
   *
   * The session is brought up — the same child the forwarded message would start, so nothing is
   * spent that passing it through would not have spent — and its own report decides: the option is
   * there, and the gateway answers as it does for a preset (a `/model` menu); it is not, and the
   * message goes on to the agent exactly as it always did. The answer is kept (ModelCatalog.note),
   * so the next time is decided at once. A session that will not start is forwarded too: the turn
   * reports the same failure it always would have.
   */
  private async deferCustomCommand(
    key: ConversationId,
    state: ConversationState,
    parsed: { name: string; rest?: string },
    msg: InboundMessage,
    forward: (m: InboundMessage) => void
  ): Promise<void> {
    const warm = await this.warmModelSelector(key, state.agentId);
    if (warm.selector) {
      await this.answerLocalCommand(key, state, parsed.name, parsed.rest, msg);
      return;
    }
    if (!warm.error) this.modelCatalog.note(state.agentId, { kind: 'none' });
    console.log(
      `[command] /${parsed.name}: ${state.agentId} ${warm.error ? 'did not start' : 'declares no model option'}; forwarded as before`
    );
    forward(msg);
  }

  /**
   * Refuse a command that needs topics nested under one another (`/super`) on a platform without
   * them, saying so; true when refused. Ahead of the translation because it holds for every
   * harness: forwarded, the agent would read the skill, propose, and be refused by `task-new`
   * (delegation.ts) — a turn spent arriving at this sentence.
   */
  private refusedForNesting(command: string, msg: InboundMessage): boolean {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter || !needsNestedTopics(command) || commandSurface(adapter).nested) return false;
    void adapter
      .sendMessage(
        addressOf(msg.conversation),
        `/${command} works in the web UI only: its sub-agents open as topics nested under this one, and only the web UI can show them.`
      )
      .catch((e) => console.warn('[conversation] failed to report an unsupported command:', e instanceof Error ? e.message : e));
    console.log(`[command] /${command} needs nested topics, which "${msg.conversation.platform}" has not; not forwarded`);
    return true;
  }

  /**
   * Whether a command is a session query that must be answered here because the conversation is
   * busy (see GenericCommand.query for why forwarding it is the bug).
   *
   * "Busy" is anything but idle, and both non-idle phases earn it: a RUNNING turn is what a
   * forwarded command would wait behind for as long as the turn runs (a command is never handed into
   * a running turn — see TurnRunner.steer), and a batch still inside its merge window is what it would be
   * glued onto — `hello\n/usage` is one prompt, and the harness no longer sees a command in it.
   *
   * Only where the command would otherwise be FORWARDED (translated, or passed through to a
   * `custom` harness). A `local` answer never touches the session anyway, and an unsupported one
   * keeps its refusal: a snapshot of a harness that has no such command would answer a question
   * nobody could have asked it.
   */
  private answersWhileBusy(state: ConversationState, name: string, result: CommandTranslation): boolean {
    if (result.kind === 'local' || result.kind === 'unsupported') return false;
    return isSessionQuery(name) && !state.merger.isIdle();
  }

  /**
   * Answer a session query from what the gateway already holds, while the session is busy.
   *
   * `/context` reuses describeContext — the answer the `local` harnesses always get. `/usage` adds
   * the last cumulative cost and how long the running turn has been going. The note on the end is
   * the part that must not be dropped: this answer is less than the harness's own (claude's adds
   * per-model tokens, cache and API time), and it says so, along with how to get the full one.
   */
  private answerBusyQuery(
    key: ConversationId,
    state: ConversationState,
    name: string,
    msg: InboundMessage
  ): void {
    const command = name.toLowerCase();
    const label = agentDisplayName(findAgent(this.config, state.agentId), state.agentId);
    const since = state.merger.runningSince();
    const body =
      command === 'context'
        ? this.describeContext(state)
        : formatUsageSnapshot({
            agent: label,
            ...(state.lastUsage ? { usage: state.lastUsage } : {}),
            ...(state.lastCost ? { cost: state.lastCost } : {}),
            ...(since !== undefined ? { runningForMs: this.clock.now() - since } : {}),
          });
    console.log(`[command] /${command} answered by the gateway for ${key} (${state.agentId}): busy, not forwarded`);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(addressOf(msg.conversation), `${body}\n\n${busyNote(command, label)}`)
      .catch((e) =>
        console.warn('[command] failed to answer a busy query:', e instanceof Error ? e.message : e)
      );
  }

  /**
   * Answer a generic command the bound harness has no native spelling for, from what the gateway
   * already knows about the live ACP session.
   *
   * These exist because the translation table's only mechanism is TEXT: it rewrites `/x` and hands
   * it to the agent as a prompt, so a capability the harness exposes over the protocol rather than
   * as a slash command reads as "not supported". Usage and the model selector are both like that on
   * opencode — the numbers already reach the footer, and `agents[].model` is already enforced
   * through `session/set_config_option` — so answering here costs one message and no turn.
   */
  private async answerLocalCommand(
    key: ConversationId,
    state: ConversationState,
    name: string,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<void> {
    const reply = (text: string): void => {
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), text)
        .catch((e) =>
          console.warn('[command] failed to answer locally:', e instanceof Error ? e.message : e)
        );
    };
    console.log(`[command] /${name} answered locally for ${key} (${state.agentId})`);
    try {
      if (name === 'context') return reply(this.describeContext(state));
      if (name === 'usage') return await this.answerHarnessCliCommand(key, state, name, msg);
      if (name === 'model') {
        // undefined means the answer went out on another surface — the daemon posted a button
        // menu — so saying anything here would duplicate it.
        const text = await this.applyModelCommand(state, key, rest, msg);
        if (text !== undefined) reply(text);
        return;
      }
      if (name === 'effort') {
        const text = await this.applyEffortCommand(state, key, rest, msg);
        if (text !== undefined) reply(text);
        return;
      }
      reply(`/${name} has no local handler.`); // unreachable unless GENERIC_COMMANDS gains a `local` without one
    } catch (e) {
      reply(`Could not answer /${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Answer a command the bound harness's own CLI owns, by running that CLI as its own process.
   *
   * Two different routes arrive here and they mean the same thing: `/usage`, which the generic
   * vocabulary marks `local` for agy, and any other name in HARNESS_CLI_ANSWERED, which would
   * otherwise pass through to the agent. Both must stay out of the session — `agy acp` hands such a
   * name to the model as a question it can only guess at.
   *
   * No turn runs and no model is invoked: these commands are answered by the CLI from local state,
   * so the cost is one short-lived process. The conversation's directory is passed through because
   * some answers are workspace-scoped, and the agent's own environment because a `HOME` override
   * decides which account's config the CLI reads.
   *
   * Arguments are deliberately dropped rather than forwarded. Every one of these commands answers a
   * question in print mode; the forms that TAKE an argument are the interactive ones (`/model
   * <name>` sets a model), and this gateway offers a menu for that. Passing user text into a
   * subprocess argv to reach a setter nobody asked for is not a trade worth making.
   */
  private async answerHarnessCliCommand(
    key: ConversationId,
    state: ConversationState,
    name: string,
    msg: InboundMessage
  ): Promise<void> {
    const def = findAgent(this.config, state.agentId);
    const label = agentDisplayName(def, state.agentId);
    const reply = (text: string): void => {
      void this.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), text)
        .catch((e) =>
          console.warn('[command] failed to deliver a harness CLI answer:', e instanceof Error ? e.message : e)
        );
    };
    if (!def || def.harness !== 'agy') {
      // Unreachable: agy is the only harness in HARNESS_CLI_ANSWERED, and the only one whose
      // /usage is local. Answered rather than thrown so a future entry fails visibly, not silently.
      reply(`${label} has no way to answer /${name} outside a turn.`);
      return;
    }
    console.log(`[command] /${name} run as a one-shot agy process for ${key} (${state.agentId})`);
    const result = await runAgyCliFor(def, name, resolveConversationCwd(def, key, this.store), this.runHarnessCli);
    if (!result.ok) {
      reply(`Could not ask ${label} for /${name}: ${result.error}`);
      return;
    }
    reply(formatAgyCliOutput(name, result.output));
  }

  /**
   * Drop this conversation's context snapshot; the pair moves together or the answer lies. The
   * status strip goes with it, for the same reason: it describes the context just discarded.
   */
  private forgetUsage(id: ConversationId, state: ConversationState): void {
    state.lastUsage = undefined;
    state.lastCost = undefined;
    state.turnCompleted = false;
    this.status.reset(id);
  }

  /**
   * The prompt-cache reading for a conversation whose agent runs on the claude harness, from that
   * session's transcript (see claude-transcript.ts) — undefined for every other harness, and for a
   * conversation with no session yet. Read on the agent's own home and directory, since that is
   * where its Claude Code wrote it.
   */
  private async claudeCacheReading(id: ConversationId): Promise<CacheReading | undefined> {
    const agentId = this.agentIdOf(id);
    const def = findAgent(this.config, agentId);
    if (def?.harness !== 'claude') return undefined;
    const sessionId = this.store?.agentSession(id, agentId);
    const cwd = this.workdirOf(id, agentId);
    if (!sessionId || !cwd) return undefined;
    const host = remoteHosts.hostFor(def);
    const w = host?.conn.welcome;
    if (host) return w ? readRemoteCacheExpiry(host, remoteClaudeProjectsDir(def, w), expandRemoteHome(cwd, w.home), sessionId) : undefined;
    return readCacheExpiry(claudeProjectsDir(def), cwd, sessionId);
  }

  /**
   * `/context`: the last usage snapshot, rendered exactly as the footer renders it.
   *
   * The two EMPTY answers are deliberately different sentences, and that is most of what this
   * function is for. Context reaches the gateway only as ACP `usage_update`, and a harness sends one
   * only for a model whose window it knows — so silence before the first turn means the numbers are
   * late, while silence after one means they are not coming.
   *
   * Probed on opencode 1.18.27, same container and same session: `opencode/big-pickle` reports
   * `{used, size: 200000}`, a model from a custom provider reports NOTHING (not a zero window — no
   * notification at all), and giving that model a `limit.context` in opencode.json makes the numbers
   * appear. So the second answer names the fix instead of repeating "send a message, then /context",
   * which was the one thing that could never help.
   */
  private describeContext(state: ConversationState): string {
    const def = findAgent(this.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);
    const usage = state.lastUsage;
    if (!usage) {
      if (!state.turnCompleted) {
        return 'No context numbers yet — they arrive with the first reply. Send a message, then /context.';
      }
      const fix =
        def?.harness === 'opencode'
          ? ' On opencode that means a model from a custom provider: give it a `limit` block in opencode.json (e.g. `"limit": { "context": 128000 }`) and the numbers appear.'
          : def?.harness === 'agy'
            ? ' agy reports usage once per turn, summed over every model call in it, so the count is known only after a turn that ran no tool; and agy never says how big the window is, so the daemon only knows it for the models it was measured on (Gemini, Claude Sonnet/Opus 4.6, GPT-OSS 120B) — any other model shows no numbers.'
            : '';
      return (
        `Context: not reported. ${name} finished a turn without sending any usage numbers, and ` +
        `another message will not change that — a harness reports context only for a model whose ` +
        `window it knows.${fix}`
      );
    }
    const line = formatRuntimeFooter(
      { contextTokens: usage.used, contextLength: usage.size },
      ['context']
    );
    const left = Math.max(0, usage.size - usage.used);
    return `Context: ${line}
${formatTokens(left)} left before compaction — ${name}`;
  }

  /**
   * The session's model selector, starting the session first if that is what it takes to have one.
   *
   * The single place that answers "what models can this conversation choose from", so `/model`, a
   * clicked menu and the `/setting` model row cannot disagree about it — they used to, because each
   * read `modelSelector()` directly and got undefined in exactly the situations a user hits first:
   *
   *  - a conversation that has never run a turn (under ACP the list arrives with `session/new`);
   *  - a conversation that just answered `/cd`, since setWorkdir disposes the session to move it.
   *
   * Both produced "No model selector on this session yet — send a message, then /model", which is
   * wrong twice over: it blames the user for the gateway's laziness, and it is unactionable right
   * after picking a directory, when choosing a model is the obvious next step.
   *
   * Returns the selector, or an `error` string when the session could not be brought up at all.
   * That distinction is the point: a missing harness or an un-logged-in agent has a real reason,
   * and reporting it beats the old guess. `selector: undefined` with no error keeps its old
   * meaning — the harness genuinely offers no model choice.
   */
  private async warmModelSelector(
    key: ConversationId,
    agentId: string
  ): Promise<{ session: AgentSession; selector?: ModelSelector; error?: string }> {
    return this.warmSelector(key, agentId, (s) => s.modelSelector?.());
  }

  /**
   * warmModelSelector's body, for any selector read off a live session — `/model` and `/effort`
   * both need "start the session if that is what it takes to have an answer", and the second copy
   * of that is where the two would start disagreeing about which situations deserve a warm-up.
   */
  private async warmSelector<T>(
    key: ConversationId,
    agentId: string,
    read: (session: AgentSession) => T | undefined
  ): Promise<{ session: AgentSession; selector?: T; error?: string }> {
    const session = this.agents.getOrCreate(key, agentId);
    const known = read(session);
    if (known) return { session, selector: known };
    // Nothing to warm up with (a runtime that does not implement it): keep the old answer.
    if (!session.ensureSession) return { session };
    try {
      await session.ensureSession(this.tokens.tokenFor(key));
    } catch (e) {
      return { session, error: e instanceof Error ? e.message : String(e) };
    }
    return { session, selector: read(session) };
  }

  /**
   * `/model`: open the menu, show the live selector, or switch to a model named by id or substring.
   *
   * Returns the text to send, or undefined when the answer went out another way (a button menu the
   * daemon posted) — the same "already answered, say nothing" idiom applyCommandTranslation uses.
   *
   * The three outcomes are deliberately ordered by how much the user already knows. A bare `/model`
   * on a platform that can carry one gets the menu, because "what are my options" is the question
   * a phone user actually has. A bare `/model` anywhere else gets the summary line it always got.
   * And a query still resolves by substring without any menu at all: `/model glm` is one thumb-typed
   * token, and it works identically on all eight platforms.
   */
  private async applyModelCommand(
    state: ConversationState,
    key: ConversationId,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<string | undefined> {
    // Bringing a session up takes a second or two of child spawn, and a silent gap is
    // indistinguishable from a dropped command — so say something is happening, best-effort.
    const typing = this.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmModelSelector(key, state.agentId);
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return modelStartFailedText(warm.error);
    const selector = warm.selector;
    if (!selector) return modelNoSelectorText();

    const query = rest?.trim();
    if (!query) {
      const caps = this.platforms.get(msg.conversation.platform)?.capabilities;
      if (
        caps &&
        modelMenuSurface(caps, selector.options.length) === 'menu' &&
        this.hooks?.onModelMenuRequest
      ) {
        this.hooks.onModelMenuRequest(key, state.agentId, msg, selector);
        return undefined;
      }
      return modelSummaryText(selector);
    }

    const match = matchModels(selector.options, query);
    if (match.kind === 'none') return modelNoMatchText(query);
    if (match.kind === 'many') return modelAmbiguousText(query, match.matches);
    return modelChoiceText(await this.setModelOn(warm.session, state, match.option.value));
  }

  /**
   * Switch a live session's model and mirror the result onto the conversation.
   *
   * Shared by the typed path and the clicked one so they cannot answer differently. The mirror is
   * what lets the footer name the new model on the very next turn, before the harness's own
   * `config_option_update` arrives.
   *
   * Failures become a value rather than an exception: the click path has no user to re-prompt, and
   * a swallowed error on a button is indistinguishable from a dead button.
   */
  private async setModelOn(
    session: AgentSession,
    state: ConversationState,
    value: string
  ): Promise<ModelChoiceResult> {
    if (!session.setModel) {
      return { kind: 'failed', reason: 'this agent cannot switch models at runtime' };
    }
    try {
      const applied = await session.setModel(value);
      state.modelOverride = applied;
      // Only the person's paths reach here, never applyScheduledModel (which sets the field
      // directly): this is what tells a daily task the topic is now set by hand.
      this.hooks?.onModelSet?.(session.conversationId);
      // And what makes the choice outlive the session object holding it — `/new`, `/cd`, a restart
      // (see ConversationRecord.model). The value as offered, not `applied`: that can be the
      // harness's display name, which its selector would not take back.
      this.store?.setConversationChoice?.(session.conversationId, state.agentId, 'model', value);
      return { kind: 'applied', model: applied };
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Apply a model chosen by clicking a menu the daemon posted.
   *
   * Lives here rather than in the daemon because the registry is the sole holder of the
   * AgentFactory and of ConversationState — the daemon does not even retain the factory it was
   * constructed with. The daemon owns the buttons; the registry owns the session.
   *
   * Everything a menu can outlive is re-checked, because a menu is a snapshot and a click is a
   * later event:
   *
   * - the conversation may be gone (a restart, a release);
   * - `expectAgentId` may no longer answer here (a `/cc` between opening and clicking), in which
   *   case the menu belongs to a harness that has nothing to do with this conversation any more;
   * - there may be no live selector, which now means the harness offers no model choice at all
   *   rather than "nothing has started yet" — warmModelSelector brings the session up first;
   * - **the value may no longer be offered.** This is the load-bearing one: the harness can rebuild
   *   its list mid-session, and a button whose index still resolves against a stale snapshot would
   *   otherwise switch to a model the user never saw, silently.
   */
  async applyModelChoice(
    id: ConversationId,
    expectAgentId: string,
    value: string
  ): Promise<ModelChoiceResult> {
    const state = this.conversations.get(id);
    if (!state) return { kind: 'gone' };
    if (state.agentId !== expectAgentId) {
      const def = findAgent(this.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    const warm = await this.warmModelSelector(id, state.agentId);
    const selector = warm.selector;
    if (!selector) return { kind: 'unavailable' };
    if (!selector.options.some((o) => o.value === value)) return { kind: 'missing', value };
    return this.setModelOn(warm.session, state, value);
  }

  // ───────────────────────────── reasoning effort (`/effort`) ─────────────────────────────

  /**
   * `/effort`: open the menu, show the levels, or switch to a level named in full or by prefix.
   *
   * `/model`'s three outcomes in `/model`'s order (see applyModelCommand), with one difference in
   * the empty case. "No levels" is an answer about the current MODEL rather than the harness —
   * codex and opencode both have levels for some models and none for others — so the reply names
   * the model and says what would change it, which is why it is handed the live model name.
   */
  private async applyEffortCommand(
    state: ConversationState,
    key: ConversationId,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<string | undefined> {
    // Same reason as /model: a cold session takes a second or two to come up.
    const typing = this.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmSelector(key, state.agentId, (s) => s.effortSelector?.());
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return effortStartFailedText(warm.error);
    const selector = warm.selector;
    if (!selector) {
      const def = findAgent(this.config, state.agentId);
      return effortNoSelectorText(def?.harness, warm.session.modelSelector?.()?.current);
    }

    const query = rest?.trim();
    if (!query) return this.answerBareEffort(state, key, msg, selector);

    const match = matchEfforts(selector.options, query);
    if (match.kind === 'none') return effortNoMatchText(query, selector.options);
    if (match.kind === 'many') return effortAmbiguousText(query, match.matches);
    return effortChoiceText(await this.setEffortOn(warm.session, state.agentId, match.option.value));
  }

  /** A bare `/effort`: the menu where the platform can carry one, the one-line summary elsewhere. */
  private answerBareEffort(
    state: ConversationState,
    key: ConversationId,
    msg: InboundMessage,
    selector: EffortSelector
  ): string | undefined {
    const caps = this.platforms.get(msg.conversation.platform)?.capabilities;
    if (
      caps &&
      effortMenuSurface(caps, selector.options.length) === 'menu' &&
      this.hooks?.onEffortMenuRequest
    ) {
      this.hooks.onEffortMenuRequest(key, state.agentId, msg, selector);
      return undefined;
    }
    return effortSummaryText(selector);
  }

  /**
   * Switch a live session's effort. Shared by the typed and clicked paths, like setModelOn.
   *
   * Nothing is mirrored onto ConversationState, unlike the model: the footer reads the level fresh
   * off the session's option list at the start of every turn, and setEffort has already written the
   * harness's answer there.
   */
  private async setEffortOn(session: AgentSession, agentId: string, value: string): Promise<EffortChoiceResult> {
    if (!session.setEffort) {
      return { kind: 'failed', reason: 'this agent cannot switch effort at runtime' };
    }
    try {
      const effort = await session.setEffort(value);
      // Persisted for the reason the model is (setModelOn): the runtime's own copy dies with the
      // session object on `/new`, `/cd` and a restart.
      this.store?.setConversationChoice?.(session.conversationId, agentId, 'effort', value);
      return { kind: 'applied', effort };
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Apply a level chosen by clicking a menu the daemon posted.
   *
   * Re-checks everything applyModelChoice re-checks, for its reasons. The last one bites harder
   * here than there: a `/model` between opening the menu and tapping it can reshape or remove the
   * whole effort list, so a stale level is a normal event rather than a rare one.
   */
  async applyEffortChoice(
    id: ConversationId,
    expectAgentId: string,
    value: string
  ): Promise<EffortChoiceResult> {
    const state = this.conversations.get(id);
    if (!state) return { kind: 'gone' };
    if (state.agentId !== expectAgentId) {
      const def = findAgent(this.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    const warm = await this.warmSelector(id, state.agentId, (s) => s.effortSelector?.());
    const selector = warm.selector;
    if (!selector) return { kind: 'unavailable' };
    if (!selector.options.some((o) => o.value === value)) return { kind: 'missing', value };
    return this.setEffortOn(warm.session, state.agentId, value);
  }

  // ───────────────────────────── working directory (`/cd`) ─────────────────────────────

  /**
   * The directory this conversation's next turn will run in.
   *
   * The same call the runtimes make at spawn (resolveConversationCwd), so the footer, the menu's
   * ● marker and the process actually launched can never disagree — including about a recorded
   * directory that has since been deleted, which resolves back to the agent's root in one place
   * rather than three.
   */
  workdirOf(id: ConversationId, agentId?: string): string | undefined {
    const def = findAgent(this.config, agentId ?? this.agentIdOf(id));
    return def ? resolveConversationCwd(def, id, this.store) : undefined;
  }

  /**
   * A tool call starting in a turn: the live status line reads it, and so does the managed skills'
   * use count (skill-usage.ts). A method rather than an inline arrow only to keep the constructor
   * that wires the turn runner within the lint's function length.
   */
  private recordTool(id: ConversationId, evt: ToolEvent): void {
    this.progress.tool(id, evt);
    recordToolUse(id, this.agentIdOf(id), evt);
  }

  /**
   * File one fact of a turn in the conversation library, enriched with what only the registry
   * knows: the lane's platform, the name the topic was given, the agent and the machine and
   * directory its turn runs in.
   *
   * Every write is guarded. The library is an index of the gateway's conversations, not part of
   * running one: a full disk or a locked database must never cost an answer. `HistoryStore`'s
   * writes are guarded too — this is the second wall, for a recorder that throws.
   */
  private recordHistory(id: ConversationId, event: HistoryEvent): void {
    const history = this.history;
    if (!history) return;
    try {
      const session = history.session(this.historyMeta(id, event.kind, event.at));
      const row = historyRow(event);
      if (row) history.message(session, row);
    } catch (e) {
      console.error('[history] could not record:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Open the library's row for a turn, returning the id its messages carry and the number the
   * parent's card will quote it by.
   *
   * The session row is written first, because a turn belongs to one and the first turn of a
   * conversation is what creates it. The generation read here is the one in force when the turn
   * STARTS — a `/new` during the turn cannot retroactively change what this turn belonged to,
   * and the next turn reads the new number.
   */
  private beginHistoryTurn(id: ConversationId, start: HistoryTurnStart): HistoryTurnRef | undefined {
    const history = this.history;
    if (!history) return undefined;
    try {
      const session = history.session(this.historyMeta(id, kindForTrigger(start.trigger), start.at));
      if (session === undefined) return undefined;
      const turnId = history.startTurn(session, {
        ...start,
        generation: this.store?.conversationGeneration?.(id) ?? 0,
      });
      if (turnId === undefined) return undefined;
      const seq = history.turnSeq(turnId);
      return { id: turnId, ...(seq !== undefined ? { seq } : {}) };
    } catch (e) {
      console.error('[history] could not open a turn:', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  /** Close the library's row for a turn. Every write is best-effort, like the record above. */
  private endHistoryTurn(turnId: number | undefined, end: HistoryTurnEnd): void {
    if (turnId === undefined) return;
    try {
      this.history?.endTurn(turnId, end);
    } catch (e) {
      console.error('[history] could not close a turn:', e instanceof Error ? e.message : e);
    }
  }

  /** What only the registry knows about a conversation, for one library row. */
  private historyMeta(id: ConversationId, kind: HistoryEvent['kind'], at: number): HistorySessionMeta {
    const lane = this.laneOf(id);
    const agentId = this.agentIdOf(id);
    const def = findAgent(this.config, agentId);
    return {
      key: id,
      platform: lane?.platformId ?? this.conversations.get(id)?.platform ?? '',
      title: this.store?.conversationTitle(id),
      agent: agentId,
      host: def?.host ?? '',
      cwd: this.workdirOf(id, agentId) ?? def?.cwd ?? '',
      // The conversation's kind is the kind of its first turn; a later scheduled run in a
      // normal topic is marked on its messages, not by relabelling the topic.
      kind,
      at,
    };
  }

  /**
   * Where the conversation at an ADDRESS works — the lookup handed to any platform that can
   * display it (`PlatformAdapter.useWorkdirLookup`): the directory, and the machine it is on.
   *
   * `boundAgentFor` rather than `agentIdOf` for the reason a `/cd` typed as the opening message
   * uses it: after a restart a topic has a persisted binding and no state, and falling through
   * to `routing.default` would report the wrong agent's root for every topic on the list.
   *
   * The machine is read off the agent's definition as it stands now, not recorded with the
   * conversation: moving an agent to another host (`/reload`) moves where its next turn runs, so
   * a label that remembered the old one would be naming a machine the topic no longer reaches.
   */
  workdirForRef(ref: ConversationRef): ConversationWorkdir | undefined {
    const id = this.idForRef(ref);
    const def = findAgent(this.config, this.boundAgentFor(id, this.config.routing.default));
    if (!def) return undefined;
    const host = agentPlaceOf(def);
    return { path: resolveConversationCwd(def, id, this.store), ...(host ? { host } : {}) };
  }

  /**
   * Which agents the conversation at an ADDRESS could still be given to — the lookup handed to a
   * platform that lays the choice out (`PlatformAdapter.useAgentCatalog`, the web UI's new topic).
   *
   * `current` is the agent a first message would reach: the binding, else the route's default for
   * this address — resolveAgent rather than `routing.default`, since a rule matching the platform or
   * channel is what decides that for an unbound conversation, and the page labels it "default".
   *
   * Closed (undefined) once that agent has a session here, because chooseAgent would refuse to move
   * it, and when there is a single agent, because a choice of one is not a choice. Read off config
   * as it stands, so a `/reload` that adds an agent shows it on the next empty topic drawn.
   */
  agentCatalogForRef(ref: ConversationRef): AgentCatalog | undefined {
    if (this.config.agents.length < 2) return undefined;
    const id = this.idForRef(ref);
    const current = this.boundAgentFor(id, resolveAgent(this.config, routeInputFromRef(ref)).agentId);
    if (this.store?.agentSession(id, current) !== undefined) return undefined;
    return agentCatalog(agentGroups(this.config.agents), current);
  }

  /**
   * Whether the conversation at an ADDRESS still has an agent child resident — the lookup handed
   * to a platform that can show it (`PlatformAdapter.useLivenessLookup`).
   *
   * The same question the idle sweeper asks before reclaiming, which is why it is answered from
   * the same place: `reclaimState` is each runtime's own statement about its child, and a session
   * HANDLE outliving that child is the normal state after a reclaim (see `reclaimSession`), so
   * `peek` alone would report every conversation this process has ever run as still alive.
   *
   * A runtime that does not implement `reclaimState` reports not-live rather than live: the
   * sweeper reads that absence conservatively too, and of the two possible lies "the agent is
   * already up" is the one that would be believed.
   */
  liveForRef(ref: ConversationRef): boolean {
    const session = this.agents.peek(this.idForRef(ref));
    return (session?.reclaimState?.() ?? 'no-child') !== 'no-child';
  }

  /**
   * End the agent process of the conversation at an ADDRESS if it is idle — the idle sweeper's
   * reclaim without its timer, handed to a platform that can ask for it
   * (`PlatformAdapter.useIdleReclaim`, the web UI's "Close idle agents"). Returns whether a
   * process was ended.
   *
   * Through reclaimSession, never killConversation, and that is the whole safety of it: the page
   * decides what is idle from flags that can be seconds old, and `/kill` stops a running turn on
   * purpose. Here a turn running or collecting (the merger), a question pending, or a runtime that
   * cannot resume each leave the process alone — so a topic that started working after the list was
   * drawn is skipped, not cut off. `lastActivityAt` is not consulted: being asked is the deadline.
   */
  reclaimIdleForRef(ref: ConversationRef): boolean {
    const id = this.idForRef(ref);
    const state = this.conversations.get(id);
    if (!state || !state.merger.isIdle()) return false;
    return this.reclaimSession(id, 'closed as idle from the web UI');
  }

  /**
   * What the conversation at an ADDRESS can switch its model to — the list handed to a platform
   * that draws a switch (`PlatformAdapter.useModelPicker`, the web UI's status line).
   *
   * The same warm-up `/model` does (warmModelSelector): the child the next message would start is
   * started now, because a model list exists only on a live session.
   * A conversation this daemon has not seen yet is bound to the agent its first message would
   * reach — the binding, else the route's default — as that message would have bound it.
   */
  async modelPickerForRef(ref: ConversationRef): Promise<ModelPickerList> {
    const id = this.idForRef(ref);
    const agentId =
      this.conversations.get(id)?.agentId ?? this.boundAgentFor(id, resolveAgent(this.config, routeInputFromRef(ref)).agentId);
    const state = this.ensureState(id, ref.platform, agentId, { opener: 'the model switch' });
    const warm = await this.warmModelSelector(id, state.agentId);
    if (warm.error) return { ok: false, agent: state.agentId, reason: 'error', text: modelStartFailedText(warm.error) };
    if (!warm.selector || warm.selector.options.length === 0) {
      return { ok: false, agent: state.agentId, reason: 'none', text: modelNoSelectorText() };
    }
    const configured = findAgent(this.config, state.agentId)?.model;
    return {
      ok: true,
      agent: state.agentId,
      ...(warm.selector.current ? { current: warm.selector.current } : {}),
      ...(configured ? { configured } : {}),
      ...(state.modelOverride ? { override: state.modelOverride } : {}),
      options: warm.selector.options.map((o) => ({ value: o.value, name: o.name })),
    };
  }

  /**
   * Switch the model of the conversation at an ADDRESS, as `/model <id>` does — applyModelChoice,
   * so the value is checked against the list the agent offers now and the override is the one
   * `/model` reads. The status line hears the new model at once rather than at the next turn.
   */
  async chooseModelForRef(ref: ConversationRef, value: string): Promise<ModelPickerResult> {
    const id = this.idForRef(ref);
    const state = this.conversations.get(id);
    const result = state ? await this.applyModelChoice(id, state.agentId, value) : ({ kind: 'gone' } as const);
    const text = modelChoiceText(result);
    if (result.kind !== 'applied') return { ok: false, text };
    this.status.model(id, result.model);
    console.log(`[model] ${id}: switched to ${result.model} from the model switch`);
    return { ok: true, model: result.model, text };
  }

  /**
   * The conversation an address belongs to, taking the long way round through the scope and the
   * alias table rather than letting the caller build a key — because neither is a platform's
   * business to know: under `per_channel` every lane shares one conversation, under `shared` all
   * of them do, and an auto-threaded lane answers under the key of the conversation that opened
   * it. A platform that formed the key itself would be right about the default scope and quietly
   * wrong about the rest.
   */
  private idForRef(ref: ConversationRef): ConversationId {
    const scope = resolveScope(this.config, {
      platform: ref.platform,
      channel: ref.channel,
      ...(ref.thread != null ? { thread: ref.thread } : {}),
      ...(ref.space != null ? { space: ref.space } : {}),
      user: ref.user,
      kind: ref.kind,
      isBot: false,
    });
    const raw = conversationKey(scope, ref);
    return this.threadAliases.get(raw) ?? raw;
  }

  /**
   * The `/cd` option list for this agent: what is on disk, in the order this machine actually uses.
   *
   * The one place scanning and ranking are combined, so the menu and the typed text list cannot
   * disagree about which directory comes first — the same reason both surfaces are built from
   * core/workdir-menu.ts's functions.
   *
   * The agent's own root keeps the first slot rather than competing for it. It is not a project:
   * it is the way back out of one (marked ⌂ on the menu), and an escape hatch that moves around
   * as the ranking shifts is worse than one that is always in the same place. Everything below it
   * is ordered by frecency, which for a never-used workspace is exactly the scan's alphabetical
   * order.
   */
  /**
   * The `/cd` listing of a remote agent's root, as last read from its host.
   *
   * Kept because the menu code is synchronous — it decides on the spot whether a menu goes out —
   * while a remote directory can only be listed asynchronously. An explicit `/cd` refreshes it first
   * (and so always shows what is there now); the menus offered on the side of `/new` or a bare agent
   * command wait for it when nothing usable is known yet (afterRemoteListing), and it is read for
   * every remote agent as the daemon starts and after a `/reload` (warmRemoteScans).
   */
  private readonly remoteScans = new Map<string, WorkdirScan>();

  private remoteScanOf(def: AgentDef, root: string): WorkdirScan {
    return (
      this.remoteScans.get(`${def.host}\0${root}`) ?? { ok: false, reason: `the directory list on host "${def.host}" has not been read yet` }
    );
  }

  /**
   * Read every remote agent's root into remoteScans, without waiting for any of it.
   *
   * So that the first bare `/cc` after a start finds the list already there. Before this, the menus
   * on the side read ahead only when asked and declined meanwhile — and since this cache lives in the
   * process, every restart left each host's first new conversation answering `/cc` with Claude's
   * own command list instead of the directory menu (2026-10-29, the first day all agents ran on
   * hosts). The daemon calls it at start and after a `/reload`; a host that is down simply leaves
   * its entry as a failed scan, which the next menu waits to have read again (afterRemoteListing).
   */
  warmRemoteScans(): void {
    const seen = new Set<string>();
    for (const def of this.config.agents) {
      if (!def.host) continue;
      const k = `${def.host}\0${resolveAgentCwd(def)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      void this.refreshRemoteScan(def);
    }
  }

  /**
   * Run `then` — which offers a directory menu from what is known — once a remote agent's listing
   * is in. A local agent, or one listed fine before, goes straight on; one never listed, or whose
   * last listing failed, waits for its host, but at most REMOTE_LISTING_WAIT_MS, after which `then`
   * runs anyway and answers the way it would without a list (the picker, or nothing). A listed one
   * is read again behind the menu, so a project created since shows up next time without waiting on
   * anyone now.
   *
   * A failed listing waits like a missing one because answering from it is answering without a menu:
   * the reread behind it fixed only the NEXT `/cc`, so a host that once failed to answer (a link that
   * came back to a restarted talkcode-remote, 2026-10-30) cost the user one command list per failure.
   */
  private afterRemoteListing(def: AgentDef | undefined, then: () => void): void {
    if (!def?.host) {
      then();
      return;
    }
    if (this.remoteScans.get(`${def.host}\0${resolveAgentCwd(def)}`)?.ok) {
      then();
      void this.refreshRemoteScan(def);
      return;
    }
    let done = false;
    let cancel: () => void = () => {};
    const go = (): void => {
      if (done) return;
      done = true;
      cancel();
      then();
    };
    cancel = this.clock.schedule(go, REMOTE_LISTING_WAIT_MS);
    void this.refreshRemoteScan(def).then(go);
  }

  /** List a remote agent's root on its host into remoteScans. Never rejects: a failure is the scan. */
  private async refreshRemoteScan(def: AgentDef): Promise<void> {
    const host = remoteHosts.hostFor(def);
    if (!host) return;
    let scan: WorkdirScan;
    let root = resolveAgentCwd(def);
    try {
      await host.ready();
      root = resolveAgentCwd(def); // `~` resolves once the host has been reached
      scan = workdirScanFrom(root, await host.listDir(root, 15_000), true);
    } catch (e) {
      scan = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    this.remoteScans.set(`${def.host}\0${root}`, scan);
  }

  private rankedWorkdirs(def: AgentDef, root: string): WorkdirScan {
    const scan = def.host ? this.remoteScanOf(def, root) : scanWorkdirs(root);
    if (!scan.ok || !this.workdirUsage) return scan;
    const [first, ...rest] = scan.options;
    if (!first) return scan;
    return {
      ...scan,
      options: [
        first,
        ...rankByFrecency(rest, (o) => o.path, this.workdirUsage.statOf, this.clock.now()),
      ],
    };
  }

  /**
   * Post a directory menu for this conversation, and say whether one went out.
   *
   * Returns false — silently — whenever there is nothing to ask: no platform buttons, no
   * conversation store to record an answer in, an unreadable root, or a root with no
   * sub-directories. Callers use that to fall through to whatever they would otherwise have said
   * (the harness command list, or nothing at all), because a menu offering one directory is not a
   * question, and an error about `agents[].cwd` is not an answer to `/cc`.
   */
  private offerWorkdirMenu(id: ConversationId, agentId: string, conv: ConversationRef): boolean {
    const caps = this.platforms.get(conv.platform)?.capabilities;
    const def = findAgent(this.config, agentId);
    if (!this.store || !this.hooks?.onWorkdirMenuRequest || !caps || !def) return false;

    const root = resolveAgentCwd(def);
    if (def.host && !this.remoteScans.has(`${def.host}\0${root}`)) {
      // Never listed yet: read it now for next time, and stay quiet this time rather than hold up
      // whatever the caller says instead (see the remoteScans field).
      void this.refreshRemoteScan(def);
      return false;
    }
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok || workdirMenuSurface(caps, scan.options.length) !== 'menu') return false;

    this.hooks.onWorkdirMenuRequest(id, agentId, conv, {
      options: scan.options,
      current: this.workdirOf(id, agentId) ?? scan.options[0]!.path,
      truncated: scan.truncated,
    });
    return true;
  }

  /**
   * `/cd`: open the menu, list what is on offer, or move to a directory named by path or substring.
   *
   * Returns the text to send, or undefined when the answer went out another way (a button menu the
   * daemon posted) — the same idiom applyModelCommand uses.
   *
   * The three shapes mirror `/model` deliberately: a bare `/cd` on a platform that can carry a menu
   * gets one, because "where can I work" is a question a phone user cannot answer by typing; a bare
   * `/cd` anywhere else gets the same list as text; and `/cd quantlab` resolves by substring on
   * every platform, buttons or not.
   */
  private applyWorkdirCommand(
    id: ConversationId,
    agentId: string,
    rest: string | undefined,
    msg: InboundMessage
  ): string | undefined {
    const def = findAgent(this.config, agentId);
    if (!def) return `No agent "${agentId}" is configured, so there is no directory to change.`;
    const root = resolveAgentCwd(def);
    const scan = this.rankedWorkdirs(def, root);
    // Reported rather than swallowed: an unreadable root means `agents[].cwd` names something that
    // is not there, and that is a config bug the operator can only fix if they hear about it.
    if (!scan.ok) return workdirUnreadableText(root, scan.reason);

    const current = this.workdirOf(id, agentId) ?? root;
    const query = rest?.trim();
    if (!query) {
      if (this.offerWorkdirMenu(id, agentId, msg.conversation)) return undefined;
      const text = workdirSummaryText(current, scan.options);
      return scan.truncated > 0
        ? `${text}\n(+${scan.truncated} more not shown — type part of a name to reach one.)`
        : text;
    }

    const match = matchWorkdirs(scan.options, query);
    if (match.kind === 'none') return workdirNoMatchText(query);
    if (match.kind === 'many') return workdirAmbiguousText(query, match.matches);
    return workdirChoiceText(this.setWorkdir(id, agentId, match.option.path));
  }

  /**
   * Move a conversation to a directory: record it, drop what cannot follow it, stop the child.
   *
   * Shared by the typed path and the clicked one so they cannot answer differently — the same
   * reason setModelOn is shared, and with the same consequence: failures are VALUES here, because
   * the click path has no user to re-prompt and a swallowed error on a button is indistinguishable
   * from a dead one.
   *
   * What gets destroyed, and why each piece has to:
   *  - every agent's persisted session id, because a session is pinned to the directory it was
   *    created in (see ConversationStore.clearAgentSessions);
   *  - the resident child, because it is *standing* in the old directory — both runtimes take their
   *    cwd at spawn, so the move cannot reach a process that is already running;
   *  - the context snapshot and the header flag, because both describe the conversation that just
   *    ended, and `/context` reporting the old numbers would contradict the reset.
   *
   * Picking the directory already in use is answered as `unchanged` and destroys NOTHING. Not a
   * micro-optimisation: the menu marks the current directory with ●, so tapping it is the obvious
   * way to dismiss a menu, and wiping a conversation for that would be indefensible.
   */
  private setWorkdir(id: ConversationId, agentId: string, path: string): WorkdirChoiceResult {
    const store = this.store;
    if (!store) {
      return {
        kind: 'failed',
        reason: 'this deployment keeps no conversation store, so a directory cannot be remembered',
      };
    }
    const def = findAgent(this.config, agentId);
    const root = def ? resolveAgentCwd(def) : undefined;
    if ((this.workdirOf(id, agentId) ?? root) === path) return { kind: 'unchanged', path };
    // Re-checked against the filesystem rather than trusted from the menu that offered it: a menu
    // is a snapshot, and a directory can be renamed between opening one and tapping it. A remote
    // directory is checked by the spawn instead (prepareRemoteSpawn), with the same fallback.
    if (!def?.host && !isDirectory(path)) return { kind: 'missing', path };

    // Recorded as an override only while it differs from the agent's own root: going back to the
    // root clears the field instead of pinning it, so a later edit to `agents[].cwd` still moves
    // the conversations that never chose anything else.
    store.setConversationCwd(id, agentId, path === root ? undefined : path);
    store.clearAgentSessions(id);
    // A new directory means a new agent session; turns on either side must not look continuous.
    store.bumpGeneration?.(id);
    this.agents.dispose(id);
    // Counted here rather than at the menu, so only a directory actually MOVED TO scores: a `/cd`
    // that resolved to the current directory returned `unchanged` above without reaching this line,
    // and that path is how a user dismisses the menu (tap the ● entry). Recorded after the move
    // rather than before it, so a `missing` directory never earns a place in the ranking.
    this.workdirUsage?.record(path, this.clock.now());

    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      this.forgetUsage(id, state);
    }
    console.log(`[workdir] ${id} → ${path} (agent ${agentId}; every session id dropped)`);
    return { kind: 'applied', path };
  }

  /**
   * Apply a directory chosen by clicking a menu the daemon posted.
   *
   * Lives here rather than in the daemon for the reason applyModelChoice does: the registry holds
   * the store, the config and the AgentFactory, and the daemon holds only the buttons.
   *
   * The rebind check is the one thing a `/cd` menu can outlive that matters. The option list was
   * scanned from ONE agent's root, so after a `/cc` → `/oc` in between, a click would apply a path
   * the new agent may have no relationship to; answering `rebound` and asking for a fresh menu is
   * the only honest outcome. A conversation with no in-memory state, by contrast, is NOT an error:
   * the directory lives in the store, so recording one for a conversation whose state has not been
   * built yet (a `/cd` as the opening message) works exactly as intended.
   */
  applyWorkdirChoice(
    id: ConversationId,
    expectAgentId: string,
    path: string
  ): WorkdirChoiceResult {
    const state = this.conversations.get(id);
    if (state && state.agentId !== expectAgentId) {
      const def = findAgent(this.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    return this.setWorkdir(id, expectAgentId, path);
  }

  /**
   * While the gateway waits to restart (beginDrain), answer a message that would start a turn in an
   * idle conversation here, instead of handing it to the agent.
   *
   * A turn started now is one the restart would either wait for — and every message makes the wait
   * longer, so an update on a busy gateway might never land — or cut off halfway. A conversation
   * already at work takes the message as usual (offered to its turn, or queued behind it): that is the
   * user steering the very work the restart is waiting for, and refusing it would only strand it.
   */
  private refuseWhileDraining(
    key: ConversationId,
    state: ConversationState,
    address: ConversationAddress,
    msg: InboundMessage
  ): boolean {
    if (!this.draining || !state.merger.isIdle()) return false;
    console.log(`[route] ${key}: not started — the gateway is waiting to restart`);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(
        address,
        '⏳ Not sent to the agent: the gateway is about to restart, once the turns already running are done. Send this again when it is back.'
      )
      .catch((e) => console.warn('[drain] failed to answer a message:', e instanceof Error ? e.message : e));
    return true;
  }

  /**
   * Send the once-per-conversation header bubble (`🤖 opencode`) and mark it announced.
   *
   * Sent on receipt rather than with the reply, so it doubles as an immediate "got it, working on
   * it" — the agent subprocess may take seconds to spawn on the first turn.
   *
   * Names the harness, not the config id: `oc` is an operator's typing shorthand and means nothing
   * to a reader. Deliberately shows no model — at receipt time no agent session exists, so the
   * model that will serve the turn is unknowable, and the configured value is not a safe stand-in
   * (a harness may substitute its own). The model belongs in the footer, reported after the fact.
   *
   * Best-effort: a send failure must never block the turn, so it's logged and dropped.
   */
  private sendHeader(state: ConversationState, msg: InboundMessage): void {
    if (!this.config.display.header.enabled || state.headerSent) return;
    // Mark before awaiting: two messages arriving inside the merge window would otherwise both see
    // headerSent=false and send twice.
    state.headerSent = true;
    const name = agentDisplayName(findAgent(this.config, state.agentId), state.agentId);
    void this.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(addressOf(msg.conversation), `🤖 ${name}`)
      .catch((e) => console.warn('[conversation] failed to send header:', e instanceof Error ? e.message : e));
  }

  /** allowFrom access gate: empty = unrestricted; non-empty allows only allowlisted identities. */
  private isAllowed(msg: InboundMessage): boolean {
    const allow = this.config.access.allowFrom;
    if (allow.length === 0) return true;
    return allow.includes(`${msg.conversation.platform}:${msg.conversation.user}`);
  }

  /**
   * Reverse command: validate the token, return the address this conversation writes to.
   * token→conversation is always valid; an address exists once the conversation has run a turn
   * (override can push cross-channel).
   *
   * Resolved through the LANE (see laneOf), not the running turn's address, and that difference is
   * load-bearing: an agent that finished its turn and left a background job reporting through
   * `talkcode send-message` is the normal case, not an error. It used to be refused with
   * "this conversation has no active turn right now", which meant the job's whole report went
   * nowhere — the same class of bug as background output being dropped by the update reader.
   *
   * ⚠️ That widened the token from a turn-scoped capability to a conversation-scoped one, and the
   * cost is worth naming: the token has no expiry and is released only when the conversation is
   * (daemon shutdown), so a process that escaped the agent's tree — `nohup ... &` — keeps every
   * reverse command working indefinitely, `touch`ing the conversation as it goes and so holding
   * off idle reclaim. Accepted deliberately, because refusing it is refusing the feature: "report
   * back when the long job finishes" is precisely what a background job is for, and a gateway that
   * answers `send-message` but not `ask` would be arbitrary. The mitigation is the same one the
   * boundary below names — access.allowFrom — plus the fact that anything holding the token was
   * started by an agent the operator already trusts with full tool access.
   *
   * ⚠️ Security boundary (deliberate capability + its cost): override (`--channel <any id>`) has no
   * channel-level authorization — a conversation holding a valid token can send/delete/fetch-history
   * on any channel, not just its triggering one. This is the intentional "agent proactively posts
   * cross-channel" design (e.g. reporting results elsewhere). Cost: the token is conversation-level
   * proof of identity, not channel-level authorization; once agent behavior can be steered by
   * low-trust input (and agents always run with full tool access, so an empty access.allowFrom means
   * anyone can drive a fully autonomous agent), the floor on the abusable target is "any address the
   * token holder can construct". Mitigation (deployment side, not this function): set
   * access.allowFrom. No channel allowlist here, to preserve the cross-channel capability; if
   * tightening later, prefer per-command-class gating (read/destructive first) over banning override.
   */
  resolveAddress(token: string, override?: ConversationAddress): ConversationAddress {
    const id = this.tokens.conversationFor(token);
    if (!id) throw new Error('invalid session token');
    if (override) return override; // allow cross-channel proactive send; see security boundary above
    const lane = this.laneOf(id);
    if (!lane) {
      throw new Error('this conversation has not run a turn yet; cannot locate a channel');
    }
    return lane.address;
  }

  /**
   * Reverse-lookup the conversation owning a reverse-command token (undefined if unregistered).
   * Lets the daemon anchor a pending ask to its issuing conversation — the token is a stable
   * identity, more reliable than address lookup (override-ask / cross-channel new turns don't move
   * the binding).
   */
  conversationForToken(token: string): ConversationId | undefined {
    return this.tokens.conversationFor(token);
  }

  /**
   * `talkcode channels`: every place this deployment has answered in, as `--channel` ids.
   *
   * Read from the store, not from `conversations`: the map holds only what THIS process has seen,
   * and a list that forgot every topic on each restart would be no list at all. The shaping is
   * core/channel-list.ts; this only supplies the records and the configured instances. An
   * unknown `--platform` is refused by name rather than answered with an empty list, which would
   * read as "that platform has no chats".
   */
  listChannels(opts: { platform?: string; query?: string; limit: number; currentKey?: ConversationId }): ListChannelsResult {
    const instances = new Map(Object.entries(this.config.platforms).map(([id, p]) => [id, p.type as string]));
    if (opts.platform !== undefined && !instances.has(opts.platform)) {
      throw new Error(
        `unknown platform instance "${opts.platform}"; configured: ${[...instances.keys()].join(', ')}`
      );
    }
    const sources = (this.store?.entries?.() ?? []).map(([key, rec]) => ({
      key,
      agent: rec.agent,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ...(rec.lane !== undefined ? { lane: rec.lane } : {}),
      ...(rec.lastAt !== undefined ? { lastAt: rec.lastAt } : {}),
    }));
    const list = buildChannelList(sources, { instances, ...opts });
    return { channels: list.rows, totalTopics: list.totalTopics, limit: opts.limit };
  }

  /**
   * Deliver a message straight to a known conversation, bypassing routing.
   *
   * For input whose owning conversation is already established — a harness picker click, where it
   * was recorded when the menu was sent. Re-routing would be wrong: a bare `/init` carries no agent
   * prefix, so it would resolve against the pipeline rather than the conversation's bound agent, and
   * land on whichever agent config prefers instead of the one whose menu offered it.
   *
   * Returns false when the conversation no longer exists (daemon restarted, or the menu outlived
   * it), letting the caller say so rather than silently dropping the click.
   */
  dispatchTo(id: ConversationId, msg: InboundMessage): boolean {
    const state = this.conversations.get(id);
    if (!state) return false;
    state.platform = msg.conversation.platform;
    state.reclaimOnIdle = false;
    void state.merger.ingest(msg);
    return true;
  }

  /** The agent currently bound to a conversation (falls back to routing.default). */
  private agentIdOf(id: ConversationId): string {
    return this.conversations.get(id)?.agentId ?? this.config.routing.default;
  }

  /**
   * The name recorded for a conversation's lane, if one was ever given — including one written a
   * moment ago, which `channels` cannot answer for yet (it lists the newest 200 topics and a topic
   * with no turn has no `lastAt`, so it sorts last and is cut).
   */
  conversationTitle(key: ConversationId): string | undefined {
    return this.store?.conversationTitle(key);
  }

  // ───────────────────────────── scheduled runs (daemon/scheduler.ts) ─────────────────────────────

  /** The agent bound to a conversation, in memory or on disk; undefined when it has none yet. */
  boundAgentOf(key: ConversationId): string | undefined {
    return this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
  }

  /**
   * Where this conversation is answered — the lane its last turn ran at. Falls back to what the
   * store recorded, so a card for a task deleted from `/setting` after a restart still has somewhere
   * to go.
   */
  laneFor(key: ConversationId): { address: ConversationAddress; platformId: string } | undefined {
    const live = this.laneOf(key);
    if (live) return live;
    const rec = this.store?.entries?.().find(([k]) => k === key)?.[1].lane;
    if (!rec) return undefined;
    return {
      platformId: rec.platform,
      address: rec.thread ? { channel: rec.channel, thread: rec.thread } : { channel: rec.channel },
    };
  }

  /**
   * The conversation an address belongs to, and the agent bound there — what a fixed-session task
   * registered against that address will run in. Undefined under `per_user`, where an address names
   * no single conversation (it is keyed by whoever is writing).
   *
   * The ref is built as `direct`: a scheduled run has no sender, and `direct` is the kind that
   * neither prefixes speaker names nor opens a thread per turn — neither of which a timer wants.
   */
  conversationAt(platform: string, address: ConversationAddress): { key: ConversationId; agent?: string } | undefined {
    const ref: ConversationRef = {
      platform,
      channel: address.channel,
      ...(address.thread ? { thread: address.thread } : {}),
      kind: 'direct',
      user: '',
    };
    if (resolveScope(this.config, { ...ref, isBot: false }) === 'per_user') return undefined;
    const key = this.idForRef(ref);
    const agent = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
    return agent !== undefined ? { key, agent } : { key };
  }

  /**
   * Run one scheduled prompt as a turn in a conversation — its own turn, queued behind anything
   * running there and interrupting nothing (InboundMerger.enqueueSolo). Resolves when the turn ends.
   *
   * Creates the conversation's state if this process has none (a restart, or a topic nobody has
   * written in since), bound to what the store remembers. It REFUSES rather than rebinds when the
   * conversation is answered by a different agent: a topic keeps its agent (refuseAgentSwitch), and
   * after `/new` the user may have chosen another on purpose — a schedule must not undo that.
   *
   * `user` is who it counts as coming from: SCHEDULED_SENDER (unattended) unless the caller knows
   * the person is there — delegation's sub-agent updates, which land in the topic the person
   * started the sub-agents from (UPDATE_SENDER).
   */
  runScheduledPrompt(opts: {
    key: ConversationId;
    platform: string;
    address: ConversationAddress;
    agentId: string;
    prompt: string;
    user?: string;
  }): Promise<SoloOutcome | { refused: string }> {
    const state = this.ensureState(opts.key, opts.platform, opts.agentId);
    if (state.agentId !== opts.agentId) {
      return Promise.resolve({ refused: `this topic is now answered by ${state.agentId}, not ${opts.agentId}` });
    }
    state.reclaimOnIdle = false;
    this.touch(opts.key);
    const msg: InboundMessage = {
      conversation: {
        platform: opts.platform,
        channel: opts.address.channel,
        ...(opts.address.thread ? { thread: opts.address.thread } : {}),
        kind: 'direct',
        user: opts.user ?? SCHEDULED_SENDER,
      },
      // No platform message behind it: the merger puts no reactions on a solo turn.
      messageId: '',
      content: opts.prompt,
      timestamp: this.clock.now(),
    };
    return state.merger.enqueueSolo(msg);
  }

  /**
   * Whether `agentId` offers `model`, for `schedule add --model` and `task-new --model` — the same
   * list `/model` shows, resolved the same way (refresh, then warm the session if that is what it
   * takes to learn it).
   *
   * The registering conversation already has a session for its own agent, so that agent's list is
   * read there. Another agent's is not: a conversation belongs to one agent, and building a
   * second handle under the caller's key would collide with the topic it is actually answering.
   * A throwaway key keeps them apart, with a suffix per call so two adds for the same agent cannot
   * dispose each other's session; it is disposed before returning, and nothing runs in it.
   *
   * Returns undefined when the model is offered, else a sentence naming the fix — including the
   * whole list, because the reader is the agent that just typed the wrong id and can retry in the
   * same turn.
   */
  async scheduledModelProblem(agentId: string, model: string, from: ConversationId): Promise<string | undefined> {
    const same = this.boundAgentOf(from) === agentId;
    const key = same ? from : `__schedule-model__#${agentId}#${++this.modelProbeSeq}`;
    const session = this.agents.getOrCreate(key, agentId);
    try {
      let selector = session.modelSelector?.();
      if (!selector && session.ensureSession) {
        try {
          await session.ensureSession(this.tokens.tokenFor(key));
        } catch (e) {
          return `could not ask agent "${agentId}" for its models: ${e instanceof Error ? e.message : String(e)}`;
        }
        selector = session.modelSelector?.();
      }
      if (!selector) {
        return `agent "${agentId}" has no model list (its harness has no model selector), so --model cannot be used with it; drop --model to use the agent's configured model`;
      }
      if (!selector.options.some((o) => o.value === model)) {
        return `unknown model "${model}" for agent "${agentId}"; choose one of: ${selector.options.map((o) => o.value).join(', ')}`;
      }
      return undefined;
    } finally {
      if (!same) {
        this.agents.dispose(key);
        this.tokens.release(key);
      }
    }
  }

  /**
   * Put a scheduled or delegated task's model on the conversation it is about to run in, before
   * the turn — the same `session.setModel` path `/model` takes, because the ACP runtime does not
   * read a model off the turn input.
   *
   * An override already on the conversation wins: it is either the task's own earlier application
   * (a daily topic's first run) or a person typing `/model` in the topic, and the person's choice
   * must not be undone by a timer.
   *
   * Strict, unlike `applyModelPreference` at spawn: that one keeps the harness's default rather
   * than fail a turn, which is right for an operator's config mistake but wrong for an explicit
   * `--model`. The session is brought up first so `setModel` reaches a live child and the harness
   * answers now; a refusal is the run's failure, never a silent switch to another model.
   * Returns a sentence for the chat when it cannot be applied, undefined on success or when the
   * conversation's existing choice is left alone.
   */
  async applyScheduledModel(key: ConversationId, platform: string, agentId: string, model: string): Promise<string | undefined> {
    const state = this.ensureState(key, platform, agentId);
    if (state.agentId !== agentId) return `this topic is now answered by ${state.agentId}, not ${agentId}`;
    if (state.modelOverride !== undefined) return undefined;
    const session = this.agents.getOrCreate(key, agentId);
    if (!session.setModel) return `agent "${agentId}" cannot switch models at runtime`;
    if (session.ensureSession) {
      try {
        await session.ensureSession(this.tokens.tokenFor(key));
      } catch (e) {
        return `could not start the session to set model "${model}": ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    try {
      state.modelOverride = await session.setModel(model);
      return undefined;
    } catch (e) {
      return `could not set model "${model}": ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── Sub-agents' topics (daemon/delegation.ts) ──────────────────────────────────────────────

  /**
   * Open a conversation of its own for a piece of work (`task-new`, once the person confirmed it): a
   * new topic on `platform` nested under `parent`, bound to `agentId`, started in `cwd`, and handed
   * `text` as its first message under `header` (handTo). An explicit `model` is applied first;
   * if it cannot be, the topic says so, no turn starts, and this throws the reason.
   *
   * Throws a sentence for the agent that asked when it cannot: a platform that cannot open topics (it
   * would have to post into the chat itself, which is not a conversation of its own), an unknown
   * agent, a directory that is not there.
   *
   * Answers the name it gave the topic as well, because the card about to be posted needs it before
   * the conversation store can supply it: `channels` lists the newest 200 topics, a topic opened a
   * moment ago has no `lastAt` yet and sorts last, so a lookup by key there finds nothing and the
   * card fell back to the conversation id (`web#main#5e94945d`) instead of the title. It is the
   * lane title (`[agent] …`), exactly what a later lookup would return.
   */
  async openTask(opts: {
    platform: string;
    parent: ConversationAddress;
    agentId: string;
    text: string;
    header: string;
    cwd?: string;
    title?: string;
    model?: string;
  }): Promise<{ key: ConversationId; address: ConversationAddress; title: string }> {
    const adapter = this.platforms.get(opts.platform);
    if (!adapter?.capabilities.thread) {
      throw new Error(`platform instance "${opts.platform}" cannot open a conversation of its own here`);
    }
    const def = findAgent(this.config, opts.agentId);
    if (!def) {
      throw new Error(`no agent "${opts.agentId}" is configured; task-agents lists them: ${this.config.agents.map((a) => a.id).join(', ')}`);
    }
    if (this.draining) throw new Error('the gateway is restarting; open the task again in a minute');
    const cwd = opts.cwd ? this.taskDirectory(def, opts.cwd) : undefined;
    // Named now from the request when no title was given; the namer renames it from the same text
    // once the turn starts (it names a conversation once, and nothing has named this one yet).
    const bare = opts.title ?? fallbackTitle(opts.text);
    const name = formatLaneTitle(opts.agentId, bare);
    const opened = (await adapter.createThread({ address: { channel: opts.parent.channel }, messageId: '' }, name, { under: opts.parent }))
      .address;
    const conv = this.conversationAt(opts.platform, opened);
    if (!conv) throw new Error('the new topic does not map to a conversation of its own under this deployment\'s scope');
    this.ensureState(conv.key, opts.platform, opts.agentId, { fresh: true });
    if (opts.title) this.store?.setConversationTitle(conv.key, opts.agentId, name);
    if (cwd) {
      const moved = this.setWorkdir(conv.key, opts.agentId, cwd);
      if (moved.kind === 'missing') throw new Error(`no directory ${cwd} on the machine "${opts.agentId}" runs on`);
      if (moved.kind === 'failed') throw new Error(moved.reason);
    }
    if (opts.model) {
      // Strict, as a scheduled run's is: the card named this model, and the first turn must not
      // start on the configured one. The topic is already open, so it says why nothing happens in
      // it; the caller reports the sub-task as not started, with the same reason.
      const why = await this.applyScheduledModel(conv.key, opts.platform, opts.agentId, opts.model);
      if (why) {
        await adapter
          .sendMessage(opened, `Not started — ${why}.`)
          .catch((e) => console.warn(`[conversation] ${conv.key}: could not say why the task did not start:`, e instanceof Error ? e.message : e));
        throw new Error(why);
      }
      // Recorded as the topic's model, unlike a scheduled run's: a schedule re-applies its model at
      // every run, while this topic has no next run to do it at. A task-send or the person's own
      // message after a restart or `/new` would otherwise run on the configured model.
      this.store?.setConversationChoice?.(conv.key, opts.agentId, 'model', opts.model);
    }
    await this.handTo(conv.key, opts.platform, opened, opts.text, opts.header);
    // `name`, not the bare title: formatLaneTitle collapses whitespace and drops leading bracketed
    // groups, so a `--title` with a newline or `[a][b] x` would otherwise put a different string on
    // the card than on the topic.
    return { key: conv.key, address: opened, title: name };
  }

  /**
   * A task's directory as the asking agent named it: absolute, `~`-relative, or a name inside the
   * agent's own root (`talkcode` for `<root>/talkcode` — what task-agents lists).
   */
  private taskDirectory(def: AgentDef, given: string): string {
    if (given.startsWith('/') || given === '~' || given.startsWith('~/')) {
      return def.host ? given : expandHome(given);
    }
    const root = resolveAgentCwd(def);
    return def.host ? `${root.replace(/\/$/, '')}/${given}` : join(root, given);
  }

  /**
   * Hand `text` to a sub-agent's conversation — `task-new` (once confirmed) and `task-send`. It is
   * shown there first under `header`, which says whose words these are (the reactions land on that
   * bubble), then goes in like a message typed there: into the running turn when the harness takes
   * one, else as the next turn. The agent receives `text` alone. Answers which of the three.
   *
   * `queued` is not a failure: the message is delivered, just after the turn it could not join.
   * It is a separate answer because the harness's ability to take input mid-turn is not knowable
   * from `isBusy` alone — agy has none, and calling that "joined" tells the caller its correction
   * was seen when it was not (reported 2026-11-03).
   *
   * Counts as the person acting (TurnOutcomes.personActed): a continue waiting after a failure is
   * called off, because someone is driving that conversation again.
   *
   * `opts.queue` skips the offer entirely: the caller has just stopped the turn (task-send
   * --interrupt) and the message must wait for the new turn, not be handed to the dying one.
   */
  async handTo(
    key: ConversationId,
    platformId: string,
    address: ConversationAddress,
    text: string,
    header: string,
    opts: { queue?: boolean } = {}
  ): Promise<'started' | 'joined' | 'queued'> {
    const agentId = this.boundAgentOf(key);
    if (!agentId || !findAgent(this.config, agentId)) throw new Error('nobody answers that conversation yet; open it with task-new');
    const adapter = this.platforms.get(platformId);
    if (!adapter) throw new Error(`platform instance "${platformId}" is not running`);
    const state = this.ensureState(key, platformId, agentId);
    if (this.draining && state.merger.isIdle()) throw new Error('the gateway is restarting; send it again in a minute');
    // Marked a dispatch: this is the `↳ From …` line (or a later task-send) a sub-agent's topic
    // receives, and the web UI draws it apart from the agent's own replies. Every chat platform
    // ignores the kind.
    const posted = await adapter.sendMessage(address, `${header}\n\n${text}`, { kind: 'dispatch' });
    const busy = !state.merger.isIdle();
    const joins = !opts.queue && busy && this.turnRunner.canSteer(key);
    this.outcomes.personActed(key);
    this.touch(key);
    state.reclaimOnIdle = false;
    const msg = {
      conversation: {
        platform: platformId,
        channel: address.channel,
        ...(address.thread ? { thread: address.thread } : {}),
        kind: 'direct' as const,
        user: DELEGATE_SENDER,
      },
      messageId: posted.messageId,
      content: text,
      timestamp: this.clock.now(),
    };
    // `queue` is --interrupt's: never offer it to the turn that is being stopped (see
    // InboundMerger.queueBehind).
    if (opts.queue) state.merger.queueBehind(msg);
    else void state.merger.ingest(msg);
    return !busy ? 'started' : joins ? 'joined' : 'queued';
  }

  /** Whether a turn is running (or about to) in a conversation. */
  isBusy(key: ConversationId): boolean {
    const state = this.conversations.get(key);
    return state !== undefined && !state.merger.isIdle();
  }

  /** Whether a question is waiting on the person in a conversation (an ask, an elicitation, a permission). */
  isAsking(key: ConversationId): boolean {
    return this.hooks?.hasPendingWork?.(key) ?? false;
  }

  /** What the conversation's turn is doing now, while one runs (turn-progress.ts). */
  progressOf(id: ConversationId): LiveTurn | undefined {
    return this.progress.progressOf(id);
  }

  /** When the turn now running began, epoch ms; undefined while idle or still collecting a batch. */
  runningSince(id: ConversationId): number | undefined {
    return this.conversations.get(id)?.merger.runningSince();
  }

  /** The live agent status the web UI's strip shows, for a list built on the daemon's side. */
  statusOf(id: ConversationId): AgentStatus | undefined {
    return this.status.statusOf(id);
  }

  /** Whether a message sent now joins the running turn instead of queueing behind it. */
  canSteer(id: ConversationId): boolean {
    return this.turnRunner.canSteer(id);
  }

  /**
   * One agent's directory choices, as `/cd` would offer them: its root first, then the projects in
   * it, most used first. A remote agent's comes from the last listing of its host (warmRemoteScans).
   */
  workdirChoices(agentId: string): { root: string; dirs: string[] } | undefined {
    const def = findAgent(this.config, agentId);
    if (!def) return undefined;
    const root = resolveAgentCwd(def);
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok) return { root, dirs: [] };
    return { root, dirs: scan.options.slice(1).map((o) => o.path) };
  }

  /**
   * Send `hooks.turnFailed.continue.message` to the agent as a turn of its own (TurnOutcomes): queued
   * behind anything running and interrupting nothing, like a scheduled prompt, but ATTENDED — it
   * carries CONTINUE_SENDER rather than SCHEDULED_SENDER, so a `permissions: ask` agent still asks
   * the person. False when it cannot run here: no lane to answer in, or the conversation is now
   * answered by an agent that no longer exists.
   */
  private runContinue(id: ConversationId, text: string): boolean {
    const lane = this.laneFor(id);
    const agentId = this.boundAgentOf(id);
    if (!lane || !agentId || !findAgent(this.config, agentId)) return false;
    const state = this.ensureState(id, lane.platformId, agentId);
    state.reclaimOnIdle = false;
    this.touch(id);
    void state.merger.enqueueSolo({
      conversation: {
        platform: lane.platformId,
        channel: lane.address.channel,
        ...(lane.address.thread ? { thread: lane.address.thread } : {}),
        kind: 'direct',
        user: CONTINUE_SENDER,
      },
      messageId: '',
      content: text,
      timestamp: this.clock.now(),
    });
    return true;
  }

  /**
   * Turns the last daemon never finished (see TurnOutcomes.recoverInterrupted). Called once by the
   * daemon after its platforms are up. Returns how many were found.
   */
  recoverInterruptedTurns(): number {
    return this.outcomes.recoverInterrupted((id, platform, agentId) => {
      if (!findAgent(this.config, agentId)) return false;
      this.ensureState(id, platform, agentId);
      return true;
    });
  }

  /** What a conversation's last turn left (TurnOutcomes), for a list built on this side. */
  activityOf(id: ConversationId): TopicActivity | undefined {
    return this.outcomes.activityOf(id);
  }

  /** The conversation's last finished reply, while it is the last thing that happened there. */
  replyOf(id: ConversationId): KeptText | undefined {
    return this.outcomes.replyOf(id);
  }

  /** The last failed turn's error, for a sub-agent update. */
  failureOf(id: ConversationId): KeptText | undefined {
    return this.outcomes.failureOf(id);
  }

  /**
   * Where a new-session run happens: a new topic in the target when the platform can open one — so
   * the run is a conversation the user can carry on in — else a throwaway conversation that posts
   * into the target and is forgotten after the run (`ephemeral`, see releaseScheduled). A daily
   * session passes `mustOpen` instead: it has no acceptable throwaway, so the failure is raised to
   * the caller, which fails the run and says why in the chat.
   *
   * The topic is created with its name already in the gateway's `[agent] subject` form and that name
   * is recorded, so the automatic namer leaves it alone instead of renaming it after the prompt.
   */
  async openScheduledConversation(opts: {
    platform: string;
    address: ConversationAddress;
    agentId: string;
    title: string;
    cwd?: string;
    ephemeralKey: ConversationId;
    /**
     * The caller cannot use a throwaway conversation: a daily session must be a topic the user can
     * reply into, so a platform without one, or a failed create, is an error rather than a silent
     * downgrade to a conversation that disappears after the run.
     */
    mustOpen?: boolean;
  }): Promise<{ key: ConversationId; address: ConversationAddress; ephemeral: boolean }> {
    const adapter = this.platforms.get(opts.platform);
    if (!adapter) throw new Error(`platform instance "${opts.platform}" is not running`);
    // Under `per_user` a new topic would map to no conversation of its own, so the run would have
    // nowhere to post. Asked BEFORE createThread: the check used to sit after it, and a daily run
    // then left an empty topic behind every time it was refused.
    if (opts.mustOpen && !this.conversationAt(opts.platform, opts.address)) {
      throw new Error('the target does not map to a conversation of its own under this deployment\'s scope; a daily-session task needs one');
    }
    const title = formatLaneTitle(opts.agentId, opts.title);
    const opened = await this.openScheduledTopic(adapter, opts.address, title, opts.mustOpen === true);
    const conv = opened ? this.conversationAt(opts.platform, opened) : undefined;
    if (opts.mustOpen && !conv) {
      throw new Error('the new topic does not map to a conversation of its own under this deployment\'s scope');
    }
    const key = conv?.key ?? opts.ephemeralKey;
    const address = opened && conv ? opened : opts.address;
    this.ensureState(key, opts.platform, opts.agentId, { fresh: true });
    if (opts.cwd) this.store?.setConversationCwd(key, opts.agentId, opts.cwd);
    if (key !== opts.ephemeralKey) this.store?.setConversationTitle(key, opts.agentId, title);
    return { key, address, ephemeral: key === opts.ephemeralKey };
  }

  /**
   * Ask a platform for a topic with no message to hang it on, or undefined when it cannot be had
   * and the caller may fall back to the chat. `mustOpen` turns both "no thread support" and a
   * failed create into the throw.
   *
   * An empty `thread` in the answer is a failure, not a lane: Slack's `createThread` returns the
   * `messageId` it was given, and a scheduled run has none. That address names the CHANNEL —
   * posting there would put the run into the person's conversation, and a daily task would
   * persist a thread the store's schema rejects on the next start, dropping the whole task.
   */
  private async openScheduledTopic(
    adapter: PlatformAdapter,
    address: ConversationAddress,
    title: string,
    mustOpen: boolean
  ): Promise<ConversationAddress | undefined> {
    if (!adapter.capabilities.thread) {
      if (mustOpen) throw new Error(`platform instance "${adapter.platform}" cannot open a topic`);
      return undefined;
    }
    try {
      // `scheduled` is the web UI's: it keeps these lanes out of the topic switcher and lists
      // them in the panel's Sessions tab. A chat platform has nowhere else to put a
      // conversation and ignores it.
      const opened = (await adapter.createThread({ address, messageId: '' }, title, { scheduled: true })).address;
      // A topic is a lane of its own; an answer without one names the channel instead. Slack does
      // this by returning the `messageId` it was given (empty here), and a channel is not a new
      // conversation: posting there would put the run into the person's own topic, and a daily
      // task would persist a thread the store's schema rejects on the next start, dropping the
      // whole task.
      if (!opened.thread) {
        throw new Error(`platform instance "${adapter.platform}" did not open a topic of its own (it needs a message to reply to)`);
      }
      return opened;
    } catch (e) {
      if (mustOpen) throw e;
      console.warn(`[schedule] could not open a topic on ${adapter.platform}; posting into the chat instead: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** Forget a throwaway scheduled conversation entirely: its child, its state, its record. */
  releaseScheduled(key: ConversationId): void {
    this.agents.dispose(key);
    this.releaseState(key);
    this.store?.clear(key);
  }

  /**
   * This conversation's state, created if absent. `fresh` binds the given agent regardless of what
   * the store remembers — for a conversation that was created a moment ago for exactly that agent.
   */
  private ensureState(
    key: ConversationId,
    platform: string,
    agentId: string,
    opts: { fresh?: boolean; opener?: string } = {}
  ): ConversationState {
    let state = this.conversations.get(key);
    if (!state) {
      const bound = opts.fresh ? agentId : (this.store?.boundAgent(key) ?? agentId);
      state = {
        merger: this.buildMerger(key),
        agentId: bound,
        platform,
        lastActivityAt: this.clock.now(),
        ...this.restoredModel(key, bound),
      };
      this.conversations.set(key, state);
      this.store?.bind(key, bound);
      console.log(`[conversation] ${key} bound to agent "${bound}" (${opts.opener ?? 'scheduled run'})`);
    }
    return state;
  }

  /**
   * The model a previous run recorded as the person's choice here, for a ConversationState being
   * created — at every one of the three places that create one, so the status line, `/model` and
   * agy's per-turn model name it after a restart rather than the configured one. (The ACP runtime
   * reads the same record itself.) Asked by agent, so a binding about to change finds nothing.
   */
  private restoredModel(key: ConversationId, agentId: string): Pick<ConversationState, 'modelOverride'> {
    const model = this.store?.conversationChoice?.(key, agentId, 'model');
    return model === undefined ? {} : { modelOverride: model };
  }

  /**
   * The agent answering this conversation, for a command that may arrive BEFORE it has any state.
   *
   * agentIdOf falls straight through to routing.default, which is wrong for the first message after
   * a restart: the binding a previous run persisted is the honest answer, and `/cd` or `/new` typed
   * as the opening message would otherwise scan (and reset) whichever agent config happens to lead
   * the pipeline. Same precedence sendHelp uses.
   */
  private boundAgentFor(id: ConversationId, fallback: string): string {
    return this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id) ?? fallback;
  }

  /** Set this conversation's model override (effective next turn). */
  setModelOverride(id: ConversationId, model: string): void {
    // Ignore if no state (not yet created / already reclaimed): the override rides on state.
    const state = this.conversations.get(id);
    if (state) state.modelOverride = model;
  }

  /** Clear this conversation's model override (revert to config default). */
  clearModelOverride(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.modelOverride = undefined;
  }

  /**
   * Reset a conversation (/new, /clear): dispose the resident agent and forget EVERY agent's
   * persisted session id, so the next message starts genuinely fresh — including after a restart.
   *
   * This is the only place the gateway destroys an agent's context, and it exists solely because
   * the user asked in so many words. Every agent's id is cleared, not just the bound one: the topic
   * IS the conversation, so a reset that let another agent's history resurface on the next `/oc`
   * would be a surprise rather than a reset.
   *
   * Keeps merger and binding (the same agent still answers here), clears headerSent so the fresh
   * conversation announces itself again.
   */
  resetConversation(id: ConversationId): void {
    // Not read off in-memory state alone: `/cd` and `/new` are both answered before a conversation
    // has any (route intercepts daemon commands first), so a topic driven entirely by commands
    // would otherwise lose its binding and its directory here.
    const agentId = this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id);
    // Read before clear(), which drops the whole record: the counter must survive the reset it is
    // counting, or every `/new` would label its turns generation 1 and tell them apart from nothing.
    const generation = (this.store?.conversationGeneration?.(id) ?? 0) + 1;
    const putSetupBack = this.keepSetup(id, agentId);
    this.agents.dispose(id);
    this.store?.clear(id);
    // What the last turn left is part of the context just thrown away.
    this.outcomes.forget(id);
    this.progress.forget(id);
    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      // The context this snapshot measured is exactly what was just destroyed; reporting it back
      // would make /context contradict the reset the user just asked for.
      this.forgetUsage(id, state);
    }
    if (agentId) {
      this.store?.bind(id, agentId);
      // The next turn is on the other side of this reset; the history library says so by number.
      this.store?.setGeneration?.(id, agentId, generation);
      putSetupBack();
    }
  }

  /**
   * How a conversation is set up, as opposed to what was said in it — read before `/new` clears the
   * record, and written back by the function returned.
   *
   * The working directory is a property of the PLACE this conversation happens, not of the context
   * just thrown away: a reset that also moved the topic back to the agent's root would silently undo
   * a `/cd` nobody asked to undo — and the menu `/new` offers next is how you change it on purpose.
   * The model and effort the person chose are kept for the same reason (and the in-memory
   * modelOverride is left as it is): the session object holding them is being disposed, so without
   * the record the next one would start on the configured model while the status line named theirs.
   */
  private keepSetup(id: ConversationId, agentId: string | undefined): () => void {
    const store = this.store;
    if (!store || !agentId) return () => {};
    const cwd = store.conversationCwd(id);
    const model = store.conversationChoice?.(id, agentId, 'model');
    const effort = store.conversationChoice?.(id, agentId, 'effort');
    return () => {
      if (cwd) store.setConversationCwd(id, agentId, cwd);
      if (model) store.setConversationChoice?.(id, agentId, 'model', model);
      if (effort) store.setConversationChoice?.(id, agentId, 'effort', effort);
    };
  }


  /**
   * Stop what a conversation is doing (`/stop`), and report what that was.
   *
   * The narrow sibling of resetConversation: the running turn is cancelled and the queued backlog
   * dropped, while the agent's context, its session ids, the binding and the child process are all
   * left exactly as they are. Stopping a task and losing the conversation it belongs to are
   * different asks, and until this existed only the second one had a command.
   *
   * No state means nothing has ever run here, so the answer is 'idle'. Deliberately NOT routed
   * through agents.getOrCreate: building a session handle for a conversation that has none, in the
   * name of stopping it, is exactly backwards. The abort reaches the agent through the merger,
   * which only fires it in the `running` phase — where a session necessarily exists.
   *
   * Only when the merger has nothing does the session get asked about background output, and
   * through `peek` for the same reason. Not the other way round: while a turn runs the harness's
   * output belongs to the turn, so there is no burst to stop and asking would only race the abort.
   */
  stopConversation(id: ConversationId): StopOutcome {
    this.outcomes.personActed(id);
    const state = this.conversations.get(id);
    if (!state) return 'idle';
    const outcome = state.merger.interrupt();
    if (outcome !== 'idle') return outcome;
    return this.agents.peek(id)?.stopBackground?.() ? 'background' : 'idle';
  }

  /**
   * End a conversation's agent process (`/kill`), keeping everything that identifies the
   * conversation — the idle sweeper's reclaim, asked for by name and applied mid-turn if need be.
   *
   * The order is the point:
   *
   *  1. The child is examined FIRST, and a refusal touches nothing. A runtime that cannot resume a
   *     stored session keeps its child, for the reason reclaimSession gives — ending it would
   *     silently restart the conversation, which is `/new`, and the user asked for the other one.
   *     Stopping the turn on the way to that refusal would do half of what was asked and say none.
   *  2. Questions still on screen are called off: they belong to the process being ended, and one
   *     left live would pin the conversation (hasPendingWork) and read the next message as its answer.
   *  3. The merger is interrupted BEFORE the child goes. Disposing alone would end the turn too — the
   *     runtime's own abort flag makes the dead prompt resolve quietly — but the merger would not
   *     know it was stopped, so it would mark the turn ✅ and then start the queued backlog, which
   *     spawns a fresh child and undoes the kill a moment after acking it.
   *  4. dispose() on the SESSION, not on the factory, exactly as reclaim does: the handle survives,
   *     and with it the runtime `/model` choice. It does not wait for the turn to unwind, unlike
   *     reclaimAfterAskTimeout's reclaimOnIdle — a turn that never unwinds is the case this exists for.
   *
   * No session means nothing ever ran here; answered without agents.getOrCreate for the reason
   * stopConversation gives.
   */
  killConversation(id: ConversationId): KillOutcome {
    const session = this.agents.peek(id);
    const reclaim = session?.reclaimState?.() ?? 'no-child';
    if (!session || reclaim === 'no-child') return 'no-child';
    if (reclaim === 'unresumable') return 'unresumable';
    this.hooks?.cancelPendingAsks?.(id, 'agent process ended');
    const outcome = this.stopConversation(id);
    session.dispose();
    console.log(`[reclaim] ${id} ended by /kill — agent child stopped; the next message resumes it`);
    return outcome;
  }

  /** Shutdown: stop the sweeper, release all mergers and agent sessions. */
  dispose(): void {
    this.cancelSweep?.();
    this.cancelSweep = null;
    this.status.dispose();
    this.outcomes.dispose();
    this.progress.dispose();
    for (const key of [...this.conversations.keys()]) {
      this.releaseState(key);
      this.agents.dispose(key);
    }
  }

  /**
   * Clear all runtime state for one conversation: delete the state and release the token registry
   * (tokens is a separate component). Does not call agents.dispose (caller's responsibility).
   */
  private releaseState(id: ConversationId): void {
    this.conversations.delete(id);
    this.tokens.release(id);
    this.unresumableWarned.delete(id);
    this.progress.forget(id);
    // Only releaseScheduled and dispose call this; idle reclaim keeps the conversation and its
    // outcome, so this is not where a quiet conversation's reply is dropped. A released scheduled
    // conversation can produce no sub-agent card, and shutdown produces none at all.
    this.outcomes.dropTexts(id);
  }

  private buildMerger(conversationId: ConversationId): InboundMerger {
    return new InboundMerger(
      {
        mergeWindowMs: this.config.inbound.mergeWindowMs,
        maxMergeWindowMs: this.config.inbound.maxMergeWindowMs,
        reactions: this.config.inbound.reactions,
        reactionsEnabled: this.config.display.reactions.enabled,
      },
      {
        now: this.clock.now,
        schedule: this.clock.schedule,
        // Reactions target inbound messages of this conversation; resolve the adapter at call time
        // (a shared-scope conversation's platform may have changed since the merger was built).
        addReaction: (ref, emoji) => this.adapterFor(conversationId).addReaction(ref, emoji),
        runTurn: (batch, signal) => {
          // A `/skill-name` message is a use of that managed skill; the rest of the signals come
          // from tool events (recordTool above). One turn counts a skill once.
          beginSkillTurn(conversationId, this.agentIdOf(conversationId), batch);
          return this.turnRunner.runTurn(conversationId, batch, signal);
        },
        // A message sent mid-turn is handed to the turn that is running, for a harness that can take
        // it there (see TurnRunner.steer); otherwise the merger queues it behind the turn.
        steer: (batch) => this.turnRunner.steer(conversationId, batch),
        abortTurn: () => {
          // A turn can be blocked on a question when it is cancelled — the agent is waiting on an
          // elicitation nobody has answered. The buttons have to go with the turn: left behind they
          // stay clickable against a request that no longer exists, keep the child pinned by
          // hasPendingWork for the rest of the ask timeout, and (since a typed reply now answers
          // the newest pending question) would read the NEXT message as their answer. This is the
          // one choke point every cancel of a turn passes through (`/stop`), so it is where they
          // are retired.
          this.hooks?.cancelPendingAsks?.(conversationId, 'interrupted');
          this.agents.getOrCreate(conversationId, this.agentIdOf(conversationId)).abort();
        },
        // The turn ended and nothing is queued behind it: that instant, not the moment the message
        // arrived, is when this conversation started being idle. Reclaim measures from here, which
        // is why a task that runs for hours is never a candidate while it runs.
        onIdle: () => {
          this.touch(conversationId);
          const state = this.conversations.get(conversationId);
          if (state?.reclaimOnIdle) {
            state.reclaimOnIdle = false;
            this.reclaimSession(conversationId, 'ask timed out (1h)');
          }
          if (state?.respawnOnIdle) {
            state.respawnOnIdle = false;
            this.agents.dispose(conversationId);
            console.log(`[reload] ${conversationId}: turn over — agent "${state.agentId}" restarts on its new definition with the next message`);
          }
        },
      }
    );
  }
}

/**
 * One library row from a turn event. Kept outside the registry because it is a pure mapping:
 * a prompt gains its attachment names (never their contents), a tool event is already its text
 * and carries its call id (one row per call, see HistoryStore.message), and a reply with no text
 * adds nothing at all.
 */
function historyRow(event: HistoryEvent): HistoryMessage | undefined {
  if (event.type === 'prompt') {
    const attachments = event.attachments?.filter(Boolean) ?? [];
    const text = attachments.length > 0 ? `${event.text}\n[attachments: ${attachments.join(', ')}]` : event.text;
    return text.trim() ? { ts: event.at, role: 'user', kind: event.kind, text, turn: event.turn } : undefined;
  }
  if (event.type === 'tool') {
    return {
      ts: event.at,
      role: 'tool',
      kind: event.kind,
      text: event.title,
      turn: event.turn,
      ...(event.call !== undefined ? { call: event.call } : {}),
    };
  }
  return event.text.trim()
    ? { ts: event.at, role: 'agent', kind: event.kind, text: event.text, turn: event.turn }
    : undefined;
}
