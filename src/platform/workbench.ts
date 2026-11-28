import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type {
  AgentCatalog,
  AgentStatus,
  EffortSelector,
  MessageRef,
  OfflineMachine,
  PendingQueueItem,
  SessionOption,
  StatusOption,
  StatusPermissions,
  TopicActivity,
  TopicKillResult,
  WorkdirScreen,
} from '../types.js';

/** Where a conversation works (`useWorkdirLookup`). `host` is `agentPlaceOf` (absent for gateway-local). */
export interface ConversationWorkdir {
  path: string;
  host?: string;
  /** Bound agent and harness; absent while nothing has bound one (path/host fall back to default). */
  agent?: { id: string; harness: string; canFork?: boolean };
}

/** One scheduled task DTO for the web UI side panel (`daemon/schedule-panel.ts`). */
export interface SchedulePanelTask {
  id: string;
  name: string;
  tags: string[];
  createdAt: number;
  state: 'active' | 'paused' | 'expired' | 'done';
  when: string;
  nextAt?: number;
  next?: string;
  run: string;
  target: string;
  targetTopic?: string;
  last?: {
    at: number;
    atText: string;
    status: 'ok' | 'failed' | 'interrupted' | 'skipped' | 'missed';
    durationMs?: number;
    exitCode?: number;
    error?: string;
  };
  runs: number;
  running: boolean;
  detail: string;
  kind: 'agent' | 'bash';
  cwd?: string;
  expires?: string;
}

export type SchedulePanelAction = 'pause' | 'resume' | 'run' | 'remove' | 'tags';

/** Outcome of one schedule action; carries the fresh list so the panel never races a refresh against its own write. */
export type SchedulePanelResult =
  | { ok: true; tasks: SchedulePanelTask[] }
  | { ok: false; error: string };

export type ModelPickerList =
  | {
      ok: true;
      agent: string;
      current?: string;
      configured?: string;
      override?: string;
      options: Array<{ value: string; name: string }>;
    }
  | { ok: false; agent: string; reason: 'none' | 'error'; text: string };

export type ModelPickerResult = { ok: true; model: string; text: string } | { ok: false; text: string };

export interface ModelPicker {
  list(ref: ConversationRef): Promise<ModelPickerList>;
  choose(ref: ConversationRef, value: string): Promise<ModelPickerResult>;
}

/** Actions a platform (WebUI) can invoke on a conversation's pending mid-turn message queue. */
export interface PendingQueueActions {
  recall(ref: ConversationRef, messageId?: string): { ok: boolean; recalled: number; content?: string };
  sendNow(ref: ConversationRef, messageId?: string, opts?: { interrupt?: boolean }): { ok: boolean; sent: number };
}

/**
 * The option id the status line's effort switch is chosen under: `/effort`'s path, not an agent's
 * own setting. Spelled again as EFFORT_OPT_ID in webui/client/features/topic/status/model-pop.ts.
 */
export const EFFORT_OPTION_ID = '__effort__';

/**
 * A status line's switches before any status (`peek`). `effort` is the level a session would be on —
 * the live one's, the conversation's `/effort`, a pin, or a fresh session's — absent when unknown.
 */
export interface SessionOptionPeek {
  agent: string;
  model?: string;
  effort?: string;
  options: StatusOption[];
  permissions?: StatusPermissions;
}

/** `effort`: the current model's levels, on either answer, since an agent with no settings of its own may still have them. */
export type SessionOptionList =
  | { ok: true; agent: string; options: SessionOption[]; permissions?: StatusPermissions; effort?: EffortSelector }
  | { ok: false; agent: string; reason: 'none' | 'error'; text: string; permissions?: StatusPermissions; effort?: EffortSelector };

export type SessionOptionResult =
  | { ok: true; options: SessionOption[]; text: string; effort?: string }
  | { ok: false; text: string };

/** Agent-defined custom session options (`useOptionPicker`). `peek` answers without starting a session; `list` starts it. */
export interface SessionOptionPicker {
  peek(ref: ConversationRef): Promise<SessionOptionPeek>;
  list(ref: ConversationRef): Promise<SessionOptionList>;
  choose(ref: ConversationRef, id: string, value: string): Promise<SessionOptionResult>;
}

/** One changed file of a turn (`path` is relative to the repository root). */
export interface TurnChangeFile {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  binary?: true;
}

export interface TurnChangeRepo {
  root: string;
  branch?: string;
  base?: string;
}

export type TurnChangeStatusResult =
  | { ok: true; repo: TurnChangeRepo; files: TurnChangeFile[]; truncated?: true }
  | { ok: false; reason: 'not-git' | 'missing' | 'error'; text: string };

export type TurnChangeFileResult =
  | {
      ok: true;
      path: string;
      status: 'added' | 'deleted' | 'modified';
      original: string;
      modified: string;
      patch: string;
      binary?: true;
      tooLarge?: true;
    }
  | { ok: false; text: string };

/** Summary attached to a finished turn's reply and persisted in the transcript cache. */
export interface TurnChangeEntry {
  turn: number;
  files: number;
  additions: number;
  deletions: number;
  truncated?: true;
}

export type VoiceTranscribeResult =
  | { ok: true; text: string; cleaned?: string; cleanupError?: string; model: string; latencyMs: number }
  | { ok: false; reason: string; noSpeech?: boolean };

export interface VoiceTranscriber {
  readonly enabled: () => boolean;
  transcribe(bytes: Uint8Array, mime?: string): Promise<VoiceTranscribeResult>;
}

export interface TurnChangesPanel {
  status(ref: ConversationRef, turn: number): Promise<TurnChangeStatusResult>;
  /** `path` must be one of the turn's changed files; anything else is refused. */
  file(ref: ConversationRef, turn: number, path: string): Promise<TurnChangeFileResult>;
  forget?(ref: ConversationRef): void;
}

export type GitMode = 'working' | 'branch' | 'committed';

export interface GitStatusFile {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  binary?: true;
  statsUnknown?: true;
}

export type GitStatusResult =
  | {
      ok: true;
      repo: { root: string; branch?: string; base?: string };
      files: GitStatusFile[];
      truncated?: true;
    }
  | { ok: false; reason: 'not-git' | 'missing' | 'error'; text: string };

export type GitFileResult =
  | {
      ok: true;
      path: string;
      status: 'added' | 'deleted' | 'modified';
      original: string;
      modified: string;
      patch: string;
      binary?: true;
      tooLarge?: true;
      patchTooLarge?: true;
    }
  | { ok: false; text: string };

export type GitBranchesResult =
  | { ok: true; branch?: string; base?: string; branches: string[] }
  | { ok: false; text: string };

export interface GitCommitSummary {
  sha: string;
  short: string;
  subject: string;
  author: string;
  at: number;
  parents: number;
}

export type GitLogResult =
  | { ok: true; repo: { root: string; branch?: string }; commits: GitCommitSummary[]; more: boolean }
  | { ok: false; reason: 'not-git' | 'missing' | 'error'; text: string };

export type GitCommitResult =
  | {
      ok: true;
      repo: { root: string; branch?: string };
      commit: GitCommitSummary & { body: string };
      files: GitStatusFile[];
      truncated?: true;
    }
  | { ok: false; reason: 'not-git' | 'missing' | 'error'; text: string };

/** Read-only git view for a conversation's directory (no stage/commit/checkout, which would race the agent). */
export interface GitPanel {
  status(ref: ConversationRef, mode: GitMode, base?: string): Promise<GitStatusResult>;
  file(ref: ConversationRef, mode: GitMode, base: string | undefined, path: string): Promise<GitFileResult>;
  branches(ref: ConversationRef): Promise<GitBranchesResult>;
  log(ref: ConversationRef, skip: number): Promise<GitLogResult>;
  commit(ref: ConversationRef, sha: string): Promise<GitCommitResult>;
  commitFile(ref: ConversationRef, sha: string, path: string): Promise<GitFileResult>;
}

export interface SchedulePanel {
  list(): SchedulePanelTask[];
  op(id: string, action: SchedulePanelAction, tags?: string[]): SchedulePanelResult;
  detail(id: string): SchedulePanelTaskDetail | undefined;
  form(): SchedulePanelFormContext;
  add(task: SchedulePanelNew): Promise<SchedulePanelDetailResult>;
  edit(id: string, edit: SchedulePanelEdit): Promise<SchedulePanelDetailResult>;
}

export interface SchedulePanelRun {
  at: number;
  atText: string;
  status: 'ok' | 'failed' | 'interrupted' | 'skipped' | 'missed';
  durationMs?: number;
  exitCode?: number;
  error?: string;
  topic?: string;
  where?: string;
}

export type SchedulePanelShape = 'bash' | 'fixed' | 'new' | 'daily';

export type SchedulePanelSetting = 'agent' | 'model' | 'cwd' | 'host' | 'timeout' | 'wake' | 'at';

export interface SchedulePanelFormContext {
  agents: string[];
  agentHosts: Record<string, string>;
  hosts: string[];
  channels: Array<{ id: string; title: string }>;
  shapes: Record<SchedulePanelShape, SchedulePanelSetting[]>;
  tz: string;
  agent: string;
}

export interface SchedulePanelTaskDetail extends SchedulePanelFormContext {
  task: SchedulePanelTask;
  fields: {
    name: string;
    cron?: string;
    at?: string;
    tz: string;
    prompt?: string;
    command?: string;
    agent?: string;
    session?: 'fixed' | 'new' | 'daily';
    model?: string;
    cwd?: string;
    timeoutMs?: number;
    host?: string;
    wake?: boolean;
    wakeOn?: string;
    wakeMax?: number;
    target: string;
  };
  locked?: string;
  runs: SchedulePanelRun[];
}

export interface SchedulePanelEdit {
  name?: string;
  cron?: string;
  at?: string;
  tz?: string;
  prompt?: string;
  command?: string;
  agent?: string;
  session?: 'fixed' | 'new' | 'daily';
  model?: string | null;
  cwd?: string | null;
  host?: string | null;
  timeoutMs?: number;
  wake?: boolean;
  wakeOn?: string | null;
  wakeMax?: number;
  tags?: string[];
  target?: string;
}

export type SchedulePanelNew = Omit<SchedulePanelEdit, 'target'> & { target: string };

export type SchedulePanelDetailResult =
  | { ok: true; detail: SchedulePanelTaskDetail; tasks: SchedulePanelTask[] }
  | { ok: false; error: string };

export interface SkillPanelEntry {
  name: string;
  description: string;
  version: string;
  status: 'active' | 'expired' | 'archived';
  pinned: boolean;
  createdAt: string;
  lastUsedAt?: string;
  restoredAt?: string;
  uses: number;
  agents: string[];
  problem?: string;
  warning?: string;
  resident: boolean;
  category?: string;
}

export interface SkillPanelSearch {
  at: string;
  query: string;
  agent?: string;
  hits: string[];
}

export interface SkillPanelSearches {
  misses: SkillPanelSearch[];
  unread: SkillPanelSearch[];
}

export interface SkillPanelFile {
  path: string;
  size: number;
}

export interface SkillPanelHistoryEntry {
  id: string;
  at: string;
  action: string;
  author?: string;
  beforeVersion?: string;
  afterVersion?: string;
  note?: string;
}

export interface SkillPanelDetail {
  skill: SkillPanelEntry;
  files: SkillPanelFile[];
  file: { path: string; content: string; version: string };
  history: SkillPanelHistoryEntry[];
}

/** Closed union matching `skills-store.ts` rules (no hard delete; archive is reversible). */
export type SkillPanelOp =
  | { action: 'show'; name: string; file?: string }
  | { action: 'create'; name: string; description: string; body?: string; category?: string }
  | { action: 'patch'; name: string; version: string; content: string }
  | { action: 'write-file'; name: string; file: string; content: string }
  | { action: 'remove-file'; name: string; file: string }
  | { action: 'archive'; name: string }
  | { action: 'restore'; name: string }
  | { action: 'pin'; name: string; pinned: boolean }
  | { action: 'resident'; name: string; resident: boolean }
  | { action: 'category'; name: string; category: string }
  | { action: 'revert'; name: string; id: string };

export type SkillPanelResult =
  | { ok: true; skills: SkillPanelEntry[]; detail?: SkillPanelDetail }
  | { ok: false; error: string };

export interface SkillsPanel {
  list(): SkillPanelEntry[];
  searches?(): SkillPanelSearches;
  op(op: SkillPanelOp): Promise<SkillPanelResult>;
}

export type ReviewPanelOutcome = 'changed' | 'preferences' | 'refused' | 'proposed' | 'nothing' | 'failed';

export interface ReviewPanelChange {
  action: 'create' | 'patch' | 'write-file' | 'archive';
  name: string;
  file?: string;
  into?: string;
  reason?: string;
  applied?: boolean;
  suggested?: boolean;
  error?: string;
  undo?: string;
  command?: string;
  revertId?: string;
  diff?: string;
}

export interface ReviewPanelEntry {
  id: string;
  title: string;
  at: number;
  outcome: ReviewPanelOutcome;
  summary: string;
  changes: ReviewPanelChange[];
  preferences: string[];
  invalid: string[];
  error?: string;
  topic?: string;
  inferred?: boolean;
  reviewer?: string;
  model?: string;
  messagesRead?: number;
  durationMs?: number;
}

export interface ReviewPanelList {
  enabled: boolean;
  running: boolean;
  reviews: ReviewPanelEntry[];
  pending: ReviewPanelPreference[];
}

export interface ReviewPanelPreference {
  text: string;
  archive?: { name: string; into?: string };
  reason?: string;
  count: number;
  at: number;
  from: Array<{ title: string; topic?: string }>;
}

export interface ReviewPanel {
  list(): ReviewPanelList;
  dismiss(text: string): ReviewPanelList;
  /** Revert one applied skill change through skills-store (security invariant 8). */
  revert?(name: string, id: string): Promise<{ ok: true; list: ReviewPanelList } | { ok: false; error: string }>;
}

export interface HistoryPanel {
  list(opts?: { before?: string; limit?: number }): HistoryPanelPage;
  search(query: string): HistoryPanelSearch;
  read(id: number): HistoryPanelRead;
}

export interface HistoryPanelSession {
  id: number;
  key: string;
  title: string;
  agent: string;
  platform: string;
  lastAt: number;
  messages: number;
  topic?: string;
}

export interface HistoryPanelPage {
  enabled: boolean;
  sessions: HistoryPanelSession[];
  total?: number;
  next?: string;
}

export interface HistoryPanelHit {
  session: number;
  message: number;
  at: number;
  title: string;
  agent: string;
  platform: string;
  role: string;
  excerpt: string;
}

export interface HistoryPanelSearch {
  hits: HistoryPanelHit[];
  more?: boolean;
}

export interface HistoryPanelRead {
  session: HistoryPanelSession;
  messages: Array<{ id: number; at: number; role: string; kind: string; text: string }>;
  note?: string;
}

export type FilesPanelKind = 'text' | 'image' | 'binary' | 'big';

export type FileGitStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?';

export interface FilesPanelEntry {
  name: string;
  dir: boolean;
  gitStatus?: FileGitStatus;
}

export interface FilesPanelListing {
  path: string;
  rel?: string;
  entries: FilesPanelEntry[];
}

export interface FilesPanelFile {
  path: string;
  dir: string;
  rel?: string;
  name: string;
  size: number;
  mtimeMs: number;
  kind: FilesPanelKind;
  text?: string;
  eol?: 'crlf' | 'lf';
  eolWarning?: 'mixed' | 'cr';
  bom?: boolean;
  sha256?: string;
  dataUrl?: string;
  html?: string;
  note?: string;
}

export interface FilesPanelConflict {
  ok: false;
  conflict: true;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  error: string;
}

export type FilesPanelError = { ok: false; error: string };

export type FilesPanelListResult = ({ ok: true } & FilesPanelListing) | FilesPanelError;
export type FilesPanelReadResult = ({ ok: true } & FilesPanelFile) | FilesPanelError;
export type FilesPanelWriteResult =
  | { ok: true; mtimeMs: number; size: number; sha256: string }
  | FilesPanelConflict
  | FilesPanelError;
export type FilesPanelCreateResult = { ok: true; path: string; dir: boolean } | FilesPanelError;
export type FilesPanelRenameResult = { ok: true; path: string } | FilesPanelError;
export type FilesPanelRemoveResult = { ok: true; removed: boolean } | FilesPanelError;

export interface FilesPanelHit {
  path: string;
  rel?: string;
  name: string;
  dir: boolean;
}

export interface FilesPanelSearchResult {
  ok: true;
  hits: FilesPanelHit[];
  truncated: boolean;
}

export interface FilesPanelExpect {
  mtimeMs?: number;
  size?: number;
  sha256?: string;
  missing?: boolean;
  force?: boolean;
}

export interface FilesPanel {
  list(ref: ConversationRef, path: string): Promise<FilesPanelListResult>;
  read(ref: ConversationRef, path: string, opts?: { preview?: boolean }): Promise<FilesPanelReadResult>;
  write(ref: ConversationRef, path: string, text: string, expect: FilesPanelExpect): Promise<FilesPanelWriteResult>;
  create(ref: ConversationRef, path: string, dir: boolean): Promise<FilesPanelCreateResult>;
  rename(ref: ConversationRef, from: string, to: string): Promise<FilesPanelRenameResult>;
  remove(ref: ConversationRef, path: string): Promise<FilesPanelRemoveResult>;
  search(ref: ConversationRef, query: string): Promise<FilesPanelSearchResult | FilesPanelError>;
}

/** Closed target for instruction files (never a free path — security invariant 10). */
export type InstructionsTarget = { scope: 'global'; name: string } | { scope: 'agent'; agent: string; path: string };

export interface InstructionsGlobalFile {
  name: string;
  layer: string;
  exists: boolean;
  size?: number;
  agents: string[];
  reach: string;
}

export interface InstructionsAgent {
  id: string;
  harness: string;
  host: string;
  file?: string;
  notDelivered?: true;
  own?: string;
}

export interface InstructionsPanelList {
  dir: string;
  on: boolean;
  global: InstructionsGlobalFile[];
  agents: InstructionsAgent[];
}

export interface InstructionsRef {
  path: string;
  shown: string;
  exists: boolean;
  depth: number;
  kind: 'file' | 'rule' | 'reference' | 'listed';
  via?: string;
  note?: string;
  editable: boolean;
}

export type InstructionsRefsResult =
  | {
      ok: true;
      agent: string;
      host: string;
      root: string;
      rootState: 'managed' | 'own' | 'missing';
      summary: string;
      refs: InstructionsRef[];
    }
  | FilesPanelError;

export type InstructionsReadResult = ({ ok: true; missing?: boolean } & FilesPanelFile) | FilesPanelError;

export interface InstructionsDelivery {
  host: string;
  agents: string[];
  link?: string;
  outcome: string;
  detail?: string;
}

export type InstructionsWriteResult =
  | { ok: true; mtimeMs: number; size: number; sha256: string; delivery?: InstructionsDelivery[] }
  | FilesPanelConflict
  | FilesPanelError;

export interface InstructionsPanel {
  list(): Promise<InstructionsPanelList>;
  refs(agent: string): Promise<InstructionsRefsResult>;
  read(target: InstructionsTarget, opts?: { preview?: boolean }): Promise<InstructionsReadResult>;
  write(target: InstructionsTarget, text: string, expect: FilesPanelExpect): Promise<InstructionsWriteResult>;
}

export type TopicSetupResult = { ok: true; agent: string; cwd: string } | { ok: false; error: string };
export type WorkdirBrowseResult = { ok: true; screen: WorkdirScreen } | { ok: false; error: string };

/**
 * Topic tree & lifecycle capability (web UI). Presence of `adapter.topics` gates sub-agent
 * nesting (`commandSurface`), `/fork`, and daily-session topic existence checks.
 */
export interface TopicTree {
  /** Platform's sole record of which conversation opened `address`; must not throw on deleted topics. */
  parentOf: (address: ConversationAddress) => ConversationAddress | undefined;
  /** Conversations opened under `address`, most recently active first; must not throw on deleted topics. */
  childrenOf: (address: ConversationAddress) => ConversationAddress[];
  /** Whether the lane still exists. When `adapter.topics` is absent, the daemon assumes the lane is still there. */
  hasThread: (address: ConversationAddress) => boolean;
  forkThread: (
    source: ConversationAddress,
    opts: { turn?: number }
  ) => Promise<{ address: ConversationAddress; title: string; discard: () => void }>;
}

/**
 * Live presence & queue state pushed to or read from a workbench UI (status strip, topic activity,
 * offline machines, read watermark, and mid-turn pending queue).
 *
 * Forwarded verbatim by `paced-adapter.ts` (`unpaced`): members here bypass `OutboundPacer` and
 * MUST NOT generate chat traffic. Anything that sends/edits chat messages belongs on `PlatformAdapter`
 * so `PACING` enforces an explicit pacing decision.
 */
export interface TopicPresence {
  setStatus: (address: ConversationAddress, status: AgentStatus | undefined) => void;
  setActivity: (address: ConversationAddress, activity: TopicActivity | undefined) => void;
  setPendingQueue: (address: ConversationAddress, items: readonly PendingQueueItem[]) => void;
  markPendingDelivered: (address: ConversationAddress, messageIds: readonly string[]) => void;
  usePendingQueueActions: (actions: PendingQueueActions) => void;
  setOfflineMachines: (machines: readonly OfflineMachine[]) => void;
  /** Epoch ms when the operator last viewed `address`; must return `undefined` (not throw) for deleted topics. */
  seenAt: (address: ConversationAddress) => number | undefined;
}

/**
 * Workbench panel & lookup hooks wired at daemon startup (`daemon/workbench-wiring.ts`), plus
 * `attachTurnChanges` whose presence gates turn-change snapshotting.
 *
 * Forwarded verbatim by `paced-adapter.ts` (`unpaced`): members here bypass `OutboundPacer` and
 * MUST NOT generate chat traffic. Before adding a member, verify it belongs on the workbench
 * rather than on `PlatformAdapter` itself.
 */
export interface WorkbenchHost {
  useWorkdirLookup: (lookup: (ref: ConversationRef) => ConversationWorkdir | undefined) => void;
  /** Drops any cached workdir/agent entry for `address` and re-announces the topic row (e.g. after daemon-side bind/cwd setup). */
  refreshWorkdir: (address: ConversationAddress) => void;
  useLivenessLookup: (lookup: (ref: ConversationRef) => boolean) => void;
  useGitPanel: (panel: GitPanel) => void;
  useScheduleLookup: (lookup: (ref: ConversationRef) => boolean) => void;
  useSchedulePanel: (panel: SchedulePanel) => void;
  useSkillsPanel: (panel: SkillsPanel) => void;
  /** No write of its own: never runs or edits reviews; only dismisses pending suggestions (`reviews.json`) or reverts applied skill changes via `skills-store` (security invariant 8). */
  useReviewPanel: (panel: ReviewPanel) => void;
  /** Read-only by construction; lists recorded conversations and excludes background review sessions. */
  useHistoryPanel: (panel: HistoryPanel) => void;
  /** Opt-in write panel: only wired when `platforms.<id>.files.enabled` is true (security invariant 9). */
  useFilesPanel: (panel: FilesPanel) => void;
  /** Opt-in write panel: only wired when `platforms.<id>.instructions.enabled` is true (security invariant 10). */
  useInstructionsPanel: (panel: InstructionsPanel) => void;
  /** Ends an idle agent process only within the idle sweeper's own gates (no active turn/pending question, resumable runtime). */
  useIdleReclaim: (reclaim: (ref: ConversationRef) => boolean) => void;
  /** Ends a topic's agent and its subtree via the platform's own `childrenOf`, intersecting with `confirmed` so newcomers since the click are untouched. */
  useTopicKill: (kill: (ref: ConversationRef, confirmed: ReadonlySet<string>) => TopicKillResult[]) => void;
  useAgentCatalog: (lookup: (ref: ConversationRef) => AgentCatalog | undefined) => void;
  useTopicSetup: (
    setup: (ref: ConversationRef, opts: { agent?: string; cwd?: string; dryRun?: boolean }) => TopicSetupResult
  ) => void;
  useWorkdirBrowser: (
    browse: (
      ref: ConversationRef,
      opts?: { agent?: string; dir?: string; atRoot?: boolean; cachedOnly?: boolean }
    ) => Promise<WorkdirBrowseResult>
  ) => void;
  useModelPicker: (picker: ModelPicker) => void;
  useOptionPicker: (picker: SessionOptionPicker) => void;
  useTurnChanges: (panel: TurnChangesPanel) => void;
  useVoiceTranscriber: (transcriber: VoiceTranscriber) => void;
  /** Hangs a turn's change summary off `reply` captured at turn end so a slow snapshot never lands under a later turn's answer. */
  attachTurnChanges: (address: ConversationAddress, entry: TurnChangeEntry, reply?: MessageRef) => void;
}
