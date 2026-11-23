import type { Config } from '../config/schema.js';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type { InboundMerger } from '../core/inbound-merger.js';
import type { SettingOption, SettingRow } from '../core/settings.js';
import type { WorkdirOption } from '../core/workdir-menu.js';
import type { AgentGroup } from '../core/agent-menu.js';
import type { HistoryStore } from '../history/store.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type {
  AgentCommand,
  AgentElicitation,
  AgentPermissionRequest,
  ConversationId,
  EffortSelector,
  ElicitAnswer,
  InboundMessage,
  ModelSelector,
  PermissionAnswer,
} from '../types.js';
import type { AgentFactory, AgentUsage } from './agent.js';
import type { runAgyCliCommand } from './agy-cli.js';
import type { ConversationStore } from './conversation-store.js';
import type { SessionTokenRegistry } from './conversation-token-registry.js';
import type { ModelCatalog } from './model-catalog.js';
import type { StatusBoard } from './status-board.js';
import type { TurnChanges } from './turn-changes.js';
import type { TurnProgressBoard } from './turn-progress.js';
import type { PersonWords } from './turn-runner.js';
import type { WorkdirUsageStore } from './workdir-usage.js';

/** All per-conversation runtime state; the reverse-command token lives in SessionTokenRegistry. */
export interface ConversationState {
  merger: InboundMerger;
  /** Bumped by an accepted message, a turn's end and a reverse command (a background job reporting in). */
  lastActivityAt: number;
  /** The sticky binding: changed only by an explicit `/name`, never re-resolved by a plain message. */
  agentId: string;
  modelOverride?: string;
  reclaimOnIdle?: boolean;
  /** A reload changed this agent mid-turn: drop the session once idle. Unlike reclaimOnIdle, a new message does not cancel it. */
  respawnOnIdle?: boolean;
  /** Instance of the most recently routed message (a shared-scope conversation may hop instances). */
  platform: string;
  /** Where the last turn ran; never cleared, so between-turn output, titles and reverse commands still land. */
  lane?: ConversationAddress;
  lanePlatform?: string;
  headerSent?: boolean;
  lastUsage?: AgentUsage;
  /** Kept apart from lastUsage: only the snapshot tied to a finished result carries a cost. */
  lastCost?: { amount: number; currency: string };
  /** A turn ended normally under the current binding: tells `/context`'s "not yet" from "never". */
  turnCompleted?: boolean;
}

export interface ConversationClock {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
}

export interface ConversationLane {
  address: ConversationAddress;
  platformId: string;
}

/**
 * What the registry asks of the daemon. The registry resolves WHAT is on offer; the daemon owns
 * buttons, pending questions, voice and sub-agents. Every hook is optional (tests wire none).
 */
export interface ConversationHooks {
  onAvailableCommands?(id: ConversationId, agentId: string, cmds: AgentCommand[]): void;
  onElicitRequest?(
    id: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentElicitation
  ): Promise<ElicitAnswer>;
  onPermissionRequest?(
    id: ConversationId,
    platform: PlatformAdapter,
    address: ConversationAddress,
    request: AgentPermissionRequest
  ): Promise<PermissionAnswer>;
  onPickerRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
  onSkillsRequest?(id: ConversationId, agentId: string, msg: InboundMessage): void;
  onModelMenuRequest?(id: ConversationId, agentId: string, msg: InboundMessage, selector: ModelSelector): void;
  onEffortMenuRequest?(id: ConversationId, agentId: string, msg: InboundMessage, selector: EffortSelector): void;
  /** A person's `/model` took: a daily task's topic stops applying its own model (survives a restart). */
  onModelSet?(id: ConversationId): void;
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
  onWorkdirMenuRequest?(
    id: ConversationId,
    agentId: string,
    conv: ConversationRef,
    menu: {
      options: WorkdirOption[];
      current: string;
      truncated: number;
      root?: string;
      browsing?: string;
      host?: string;
      posixPaths?: boolean;
    }
  ): void;
  onAgentMenuRequest?(id: ConversationId, msg: InboundMessage, menu: { groups: AgentGroup[]; current: string | undefined }): void;
  offlinePlaces?(): ReadonlySet<string>;
  /** Work held outside a turn (a blocked `ask`). A query, not pin/unpin: a leaked pin would keep a child forever. */
  hasPendingWork?(id: ConversationId): boolean;
  /** Placed in route() past access, gate and daemon commands but before the merger, which would cancel the asking turn. */
  answerPendingAsk?(id: ConversationId, text: string): boolean;
  cancelPendingAsks?(id: ConversationId, reason: string): number;
  takeVoice?(id: ConversationId, msg: InboundMessage): boolean;
  supersedeVoice?(id: ConversationId): number;
  supersedeProposals?(id: ConversationId): void;
  cancelPendingVoice?(id: ConversationId, reason: string): number;
  stopSubAgents?(id: ConversationId): number;
  onScheduleSetting?(id: ConversationId, msg: InboundMessage, args: string[], canMenu: boolean): void;
  scheduleSummary?(): string | undefined;
  onDelegationSettingChanged?(): void;
  onNeedsPerson?(id: ConversationId): void;
  onPersonWords?(id: ConversationId, words: PersonWords): void;
  onCooldownOver?(agentId: string): void;
}

/**
 * The registry's view handed to each collaborator: its dependencies, the one state table, and the
 * lookups over it. Collaborators reach each other only through this or through the peers they are
 * constructed with, never through ConversationRegistry itself.
 */
export interface ConversationContext {
  readonly config: Config;
  readonly platforms: Map<string, PlatformAdapter>;
  readonly agents: AgentFactory;
  readonly clock: ConversationClock;
  readonly hooks: ConversationHooks | undefined;
  readonly store: ConversationStore | undefined;
  readonly history: HistoryStore | undefined;
  readonly workdirUsage: WorkdirUsageStore | undefined;
  readonly runHarnessCli: typeof runAgyCliCommand;
  readonly conversations: Map<ConversationId, ConversationState>;
  readonly tokens: SessionTokenRegistry;
  readonly status: StatusBoard;
  readonly progress: TurnProgressBoard;
  readonly modelCatalog: ModelCatalog;
  readonly turnChanges: TurnChanges;
  laneOf(id: ConversationId): ConversationLane | undefined;
  laneFor(id: ConversationId): ConversationLane | undefined;
  agentIdOf(id: ConversationId): string;
  boundAgentOf(id: ConversationId): string | undefined;
  boundAgentFor(id: ConversationId, fallback: string): string;
  workdirOf(id: ConversationId, agentId?: string): string | undefined;
  idForRef(ref: ConversationRef): ConversationId;
  conversationAt(platform: string, address: ConversationAddress): { key: ConversationId; agent?: string } | undefined;
  ensureState(key: ConversationId, platform: string, agentId: string, opts?: { fresh?: boolean; opener?: string }): ConversationState;
  releaseState(id: ConversationId): void;
  touch(id: ConversationId): void;
  forgetUsage(id: ConversationId, state: ConversationState): void;
  isBusy(key: ConversationId): boolean;
  adoptThread(id: ConversationId, address: ConversationAddress, platformId: string): void;
  switchRefusal(key: ConversationId, agentId: string, wantedCommand?: string): string | undefined;
  rebind(
    key: ConversationId,
    state: ConversationState,
    agentId: string,
    platformId: string,
    address: ConversationAddress,
    announce?: boolean
  ): string;
  chooseAgent(key: ConversationId, agentId: string, conv: ConversationRef): string;
  resetConversation(id: ConversationId): void;
}
