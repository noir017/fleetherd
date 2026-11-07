import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type {
  AgentCatalog,
  AgentStatus,
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  MessageRef,
  SettingsScreen,
  SlashCommandSpec,
  TopicActivity,
} from '../types.js';

/**
 * One interactive button, as the daemon describes it before any platform encoding.
 *
 * Named rather than repeated inline because two methods now take the same list and they must not
 * drift: a menu is posted with sendButtons and then advanced with editButtons, so a shape accepted
 * by one and rejected by the other would only surface on the second page.
 */
export interface ButtonSpec {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
}

/**
 * Where a conversation works, as `useWorkdirLookup` answers it.
 *
 * The machine travels with the path because the path alone does not say where it is: two agents of
 * one harness on two hosts usually share a home layout, so their topics all read `workspace`, and
 * the agent id in the title was the only thing telling them apart (2026-10-30). `host` is
 * `core/agent-menu.ts` agentPlaceOf — the agent's group, else its host — and is absent for an agent
 * on the gateway's own machine.
 */
export interface ConversationWorkdir {
  path: string;
  host?: string;
}

/**
 * One scheduled task as the web UI's side panel draws it.
 *
 * A DTO rather than `core/schedule.ts`'s `ScheduleTask`, because this module is the seam every
 * platform implements and it must not import a core module just to name a shape. The daemon
 * builds it (`daemon/schedule-panel.ts`), so the page never sees a cron expression it has to
 * parse and the sentence about a task is written once, where the chat menus write it.
 *
 * `nextAt` travels beside the formatted `next` so the page can turn it into "in 3h 12m" without
 * asking again; every other time is already formatted in the task's own zone, which is what
 * makes a task registered in Shanghai read the same in a browser in Berlin.
 */
export interface SchedulePanelTask {
  id: string;
  name: string;
  state: 'active' | 'paused' | 'expired' | 'done';
  /** `0 8 * * * (Asia/Shanghai)` or `once at 2026-11-05 08:00 (Asia/Shanghai)`. */
  when: string;
  /** Epoch ms of the next run; absent when it will not run again. */
  nextAt?: number;
  /** The next run in the task's own zone, already formatted. */
  next?: string;
  /** `agent cc · fixed session` or `bash · 90s · devbox`. */
  run: string;
  /** Where the output goes, as `targetId` writes it. */
  target: string;
  /** The target's topic id, when the target is a topic of the instance showing the panel. */
  targetTopic?: string;
  last?: {
    at: number;
    /** `at` in the task's own zone, already formatted. */
    atText: string;
    status: 'ok' | 'failed' | 'interrupted' | 'skipped' | 'missed';
    durationMs?: number;
    exitCode?: number;
    error?: string;
  };
  runs: number;
  /** A run of this task is in flight right now. */
  running: boolean;
  /** The full prompt or command, for the expanded row. */
  detail: string;
  kind: 'agent' | 'bash';
  cwd?: string;
  /** When a fixed-session task stops being active, already formatted in its own zone. */
  expires?: string;
}

/** The four things the panel can do to one task. The daemon's `ScheduleService.op` names them. */
export type SchedulePanelAction = 'pause' | 'resume' | 'run' | 'remove';

/**
 * The outcome of one action, with the fresh list when it worked.
 *
 * The list comes back in the response rather than being left for a second read: the panel has
 * just changed what it is showing, and racing a refresh against its own write is the one moment
 * it could show the old state as if it were the new one.
 */
export type SchedulePanelResult =
  | { ok: true; tasks: SchedulePanelTask[] }
  | { ok: false; error: string };

/**
 * What the model switch shows for one conversation (`useModelPicker`, the web UI's status line):
 * the agent answering it, the models it offers right now, which one is in use, the default it
 * starts with (config), and the `/model` override when there is one.
 *
 * `ok: false` says why there is no list, as a sentence for the person: a harness that offers no
 * model choice (`none`), or an agent that would not start (`error`).
 */
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

/** The outcome of a pick, with the sentence `/model` would have answered. */
export type ModelPickerResult = { ok: true; model: string; text: string } | { ok: false; text: string };

/**
 * What `useModelPicker` hands a platform: the list for a conversation, and the switch. The same
 * switch `/model <id>` makes (a runtime override for that conversation, config untouched), so the
 * status line and `/model` cannot disagree about which model is in use.
 */
export interface ModelPicker {
  list(ref: ConversationRef): Promise<ModelPickerList>;
  choose(ref: ConversationRef, value: string): Promise<ModelPickerResult>;
}

/** What `useSchedulePanel` hands a platform: the list, and the four operations. */
export interface SchedulePanel {
  list(): SchedulePanelTask[];
  op(id: string, action: SchedulePanelAction): SchedulePanelResult;
}

/**
 * One managed skill as the web UI's skills page lists it.
 *
 * A DTO rather than `daemon/skills-store.ts`'s `SkillRecord` for the same reason
 * `SchedulePanelTask` is one: this module is the seam every platform implements, and it must not
 * import a daemon module to name a shape. The record's `source` is deliberately absent — where a
 * skill came from is the daemon's business, and the page has nothing to do with it.
 */
export interface SkillPanelEntry {
  name: string;
  description: string;
  /** The content hash `show` prints and `patch` demands. */
  version: string;
  status: 'active' | 'expired' | 'archived';
  pinned: boolean;
  createdAt: string;
  lastUsedAt?: string;
  restoredAt?: string;
  uses: number;
  agents: string[];
  /** Why the skill is not delivered — a hand-made commit that breaks the store's rules. */
  problem?: string;
  /** Delivered, but a rule a person should know is broken (a resident description too long). */
  warning?: string;
  /** In every agent's skill list (true), or in the library, found through the `skills` tool. */
  resident: boolean;
  category?: string;
}

/** A search of the skill library, as the page lists it (daemon/skill-queries.ts). */
export interface SkillPanelSearch {
  at: string;
  query: string;
  agent?: string;
  hits: string[];
}

/** Where the library falls short: searches that found nothing, and hits nobody opened. */
export interface SkillPanelSearches {
  misses: SkillPanelSearch[];
  unread: SkillPanelSearch[];
}

/** One file a skill is made of, as the page's file list shows it. */
export interface SkillPanelFile {
  path: string;
  size: number;
}

/** One commit in a skill's history, newest first — the gateway's or a person's. */
export interface SkillPanelHistoryEntry {
  /** The commit, 12 hex characters. */
  id: string;
  at: string;
  /** The gateway's action, or `commit` for a change made in the repository by hand. */
  action: string;
  /** The commit's author: `talkcode`, `talkcode-review`, `talkcode-web`, or a person. */
  author?: string;
  beforeVersion?: string;
  afterVersion?: string;
  note?: string;
}

/**
 * A skill opened for editing: its files, the opened file's text, and every recorded change.
 *
 * `file` is always present: `show` refuses a path that does not exist, and the page asks only for
 * paths it was just handed. `version` is the skill's current one and travels with the content,
 * because `patch` is refused unless it names exactly this.
 */
export interface SkillPanelDetail {
  skill: SkillPanelEntry;
  files: SkillPanelFile[];
  file: { path: string; content: string; version: string };
  history: SkillPanelHistoryEntry[];
}

/**
 * One operation on the gateway's skills.
 *
 * A closed union rather than free text, for the same reason `ScheduleOpRequestSchema` is: every
 * verb here reaches a function in `skills-store.ts` that owns the rules, and there is no `delete`
 * — an archive moves a skill and is reversible, and the store has no hard delete to expose.
 */
export type SkillPanelOp =
  | { action: 'show'; name: string; file?: string }
  | { action: 'create'; name: string; description: string; body?: string }
  | { action: 'patch'; name: string; version: string; content: string }
  | { action: 'write-file'; name: string; file: string; content: string }
  | { action: 'remove-file'; name: string; file: string }
  | { action: 'archive'; name: string }
  | { action: 'restore'; name: string }
  | { action: 'pin'; name: string; pinned: boolean }
  /** In every agent's context, or back to the library — a person's call, so only the page has it. */
  | { action: 'resident'; name: string; resident: boolean }
  | { action: 'revert'; name: string; id: string };

/**
 * The outcome of one operation, with the fresh list when it worked.
 *
 * The list comes back in the response for the reason `SchedulePanelResult` carries it: the page
 * has just changed what it is showing, and racing a refresh against its own write is the one
 * moment it could show the old state as the new one. A refusal is the store's own sentence, so
 * the page never re-words a rule it does not own.
 */
export type SkillPanelResult =
  | { ok: true; skills: SkillPanelEntry[]; detail?: SkillPanelDetail }
  | { ok: false; error: string };

/** What `useSkillsPanel` hands a platform: the list, and every operation the store allows. */
export interface SkillsPanel {
  list(): SkillPanelEntry[];
  /** The searches worth a person's look. */
  searches?(): SkillPanelSearches;
  /** Asynchronous: a write waits for the skills repository's pull before it and push after it. */
  op(op: SkillPanelOp): Promise<SkillPanelResult>;
}

/**
 * What one review produced, as the Reviews tab names it.
 *
 * `proposed` only ever describes a review recorded before results were kept: its raw answer lists
 * changes, and whether any landed was never written down. The entry says `inferred` beside it.
 */
export type ReviewPanelOutcome = 'changed' | 'preferences' | 'refused' | 'proposed' | 'nothing' | 'failed';

/** One change a review's answer carried, and what became of it. */
export interface ReviewPanelChange {
  action: 'create' | 'patch' | 'write-file';
  name: string;
  file?: string;
  /** The reviewer's own sentence about why. */
  reason?: string;
  /** Absent on an inferred old review, where the library does not know. */
  applied?: boolean;
  /** Why the store refused it. */
  error?: string;
  /** The command that undoes it, when it landed and can be undone. */
  undo?: string;
}

/** One review, as the tab lists it. */
export interface ReviewPanelEntry {
  /** The review session's key — stable across refreshes. */
  id: string;
  /** The reviewed conversation's title at review time. */
  title: string;
  /** Epoch ms of the review. */
  at: number;
  outcome: ReviewPanelOutcome;
  /** One line for the row: what happened. */
  summary: string;
  changes: ReviewPanelChange[];
  preferences: string[];
  /** Changes that did not pass the shape check, one line each. */
  invalid: string[];
  /** Why the whole review failed. */
  error?: string;
  /** The topic to open, when the reviewed conversation is one this instance can show. */
  topic?: string;
  /** Read from a raw answer that predates result records — nothing here says what was applied. */
  inferred?: boolean;
}

/**
 * Everything the Reviews tab draws.
 *
 * `enabled` is the conversation library being open at all; `running` is `review` naming a
 * reviewer — an agent that exists, or an endpoint. They are separate because old reviews remain
 * worth reading after the reviewer is turned off, while an empty tab should say which of the two is
 * the reason it is empty.
 *
 * There is no quota field: the review sweep has no daily limit, so there is no counter to show.
 */
export interface ReviewPanelList {
  enabled: boolean;
  running: boolean;
  reviews: ReviewPanelEntry[];
  /** The preference suggestions waiting for the person, merged across reviews (see ReviewPanelPreference). */
  pending: ReviewPanelPreference[];
}

/**
 * One preference suggestion on the pending list: the same sentence from every review that made it,
 * once. Nothing acts on it — the person reads it and either has it added to the instructions every
 * agent gets or dismisses it — so a wrong suggestion costs a tap, never an agent's behaviour.
 */
export interface ReviewPanelPreference {
  /** The sentence, as the newest review worded it. */
  text: string;
  /** How many reviews suggested it. */
  count: number;
  /** Epoch ms of the newest of them. */
  at: number;
  /** The reviewed conversations it came from, newest first, at most three. */
  from: Array<{ title: string; topic?: string }>;
}

/**
 * What `useReviewPanel` hands a platform: the list, and one write — dismissing a suggestion from
 * the pending list, which touches only `reviews.json`. Nothing here reaches a skill or a review:
 * those are written by the sweep alone.
 */
export interface ReviewPanel {
  list(): ReviewPanelList;
  /** Take one suggestion off the pending list; answers with the fresh list. */
  dismiss(text: string): ReviewPanelList;
}

/**
 * Platform capability interface. One layer above Satori so the core classes depend only on
 * capabilities, not concrete platforms; missing capabilities degrade gracefully in the
 * implementation (see capabilities).
 *
 * Every outbound method addresses a ConversationAddress ({channel, thread?}) rather than a
 * channel string, so a sub-lane (Telegram forum topic, Slack thread_ts) can never be lost in
 * transit or smuggled through as a composite string that some path forgets to decode.
 */
export interface PlatformAdapter {
  /** Platform INSTANCE id (the `platforms:` map key this adapter was built from). */
  readonly platform: string;
  /** Platform type ('discord'/'telegram'/…). */
  readonly platformType: string;
  readonly capabilities: PlatformCapabilities;

  /**
   * First send; the returned MessageRef is later used for editMessage.
   *
   * `opts.kind` says what the message IS, for a platform that draws kinds differently; every
   * other implementation ignores it, and may leave the parameter off its signature entirely.
   * Given on the SEND only: a message's kind does not change, so an implementation that cares
   * records it here and applies it to every later edit of the same message.
   */
  sendMessage(address: ConversationAddress, text: string, opts?: SendOptions): Promise<MessageRef>;

  /** In-place edit. When capabilities.editMessage is false the impl should throw, and the caller degrades to resending the whole segment. */
  editMessage(ref: MessageRef, text: string): Promise<void>;

  /**
   * Rendered length of `text` in the units capabilities.maxMessageLength counts (after the
   * platform's markdown rendering). Used by the StreamBuffer to chunk by real rendered size rather
   * than raw char count, since rendering can expand/shrink/re-unit the text (table→bullets, UTF-8
   * bytes, etc.). Defaults to text.length when the profile declares no measureRendered. */
  measureRendered(text: string): number;

  deleteMessage(ref: MessageRef): Promise<void>;

  sendFile(
    address: ConversationAddress,
    file: { path: string; name?: string; caption?: string }
  ): Promise<MessageRef>;

  /** Lifecycle reaction (👀 / ✅ / ❌). */
  addReaction(ref: MessageRef, emoji: string): Promise<void>;
  removeReaction(ref: MessageRef, emoji: string): Promise<void>;

  /** Typing indicator; some platforms have no stop, the impl may be a no-op. */
  startTyping(address: ConversationAddress): Promise<void>;
  stopTyping(address: ConversationAddress): Promise<void>;

  fetchHistory(
    address: ConversationAddress,
    opts: { limit?: number; before?: string }
  ): Promise<InboundMessage[]>;

  /**
   * Fetch an inbound attachment the generic HTTP downloader cannot reach (Lark's
   * `internal:` resource URLs). Absent on platforms whose media elements are public URLs;
   * `undefined` from the call itself means "not my URL, use HTTP". See PlatformProfile.fetchAttachment.
   */
  fetchAttachment?(url: string): Promise<{ bytes: Uint8Array; mime?: string; name?: string } | undefined>;

  /** Register the inbound callback, attached when daemon starts. */
  onMessage(handler: (msg: InboundMessage) => void): void;

  // ---- Platform-layer interaction capabilities (vertical slice): true reply / thread / buttons / slash ----

  /** True reply: send a platform-native reply targeting ref (Discord message_reference). */
  replyMessage(ref: MessageRef, text: string): Promise<MessageRef>;

  /**
   * Create a thread from a message; returns the new thread's address, which later sends
   * target directly. `{channel}` where a thread is a channel (Discord); `{channel, thread}`
   * where it is a lane (Telegram topic, Slack thread_ts).
   */
  createThread(
    ref: MessageRef,
    name: string,
    opts?: {
      autoArchiveMinutes?: 60 | 1440 | 4320 | 10080;
      /**
       * The conversation whose agent opened this one (daemon/delegation.ts): a platform that can
       * show the relation (`parentOf`) nests the new lane under it. Ignored by every other.
       */
      under?: ConversationAddress;
      /**
       * A scheduled task's new-session run opened this lane, not a person. The web UI keeps such
       * topics out of the switcher and lists them in its panel's Sessions tab; a chat platform
       * has nowhere else to put a conversation, so every other adapter ignores this.
       */
      scheduled?: boolean;
    }
  ): Promise<{ address: ConversationAddress }>;

  /**
   * Rename the lane an address points at — a Telegram forum topic's title.
   *
   * Distinct from createThread's `name`, which only ever applies at creation: a conversation's
   * subject is not knowable then (the agent has not read anything yet), so the useful name arrives
   * later, from the harness. Without this the lane keeps whatever it was called when it was made,
   * which for a hand-created topic is whatever the user typed before starting.
   *
   * Only call when capabilities.renameThread is true; the implementation throws otherwise. Requires
   * `address.thread` — renaming "the whole channel" is a different and much more dangerous
   * operation, and no caller wants it.
   */
  renameThread(address: ConversationAddress, name: string): Promise<void>;

  /**
   * Hand the platform a way to ask which directory the conversation at one of its addresses is
   * working in, so that it can show it.
   *
   * Optional, and the web UI is the only implementor. A chat app has nowhere to put this — a
   * Telegram forum topic has one title and it is already spent on what the conversation is
   * *about* — while the page's own switcher has room for a second line and, without this,
   * nothing to put in it: several topics open on different projects read identically there.
   *
   * A lookup rather than a value pushed in, because the answer belongs to the daemon and it
   * moves: `/cd` changes it, a rebind changes which agent's root it falls back to, and a
   * restart leaves conversations that have a directory and no in-memory state at all. Pushing
   * would mean finding every one of those moments and would still be blank after the restart.
   *
   * Best-effort decoration, and the implementation must treat it as such: it is called while
   * rendering a list, so it may be called often, and nothing about delivering a message may
   * depend on it.
   */
  useWorkdirLookup?(lookup: (ref: ConversationRef) => ConversationWorkdir | undefined): void;

  /**
   * Hand the platform a way to ask whether the conversation at one of its addresses still has an
   * agent process behind it.
   *
   * Same seam and same caveats as useWorkdirLookup (optional, web-UI-only, a lookup rather than a
   * pushed value, best-effort decoration), answering the question its topic switcher could not:
   * a turn ending does not end the agent, so a topic that just went quiet and a topic whose child
   * was reclaimed an hour ago are two very different things — one answers instantly with its
   * context in memory, the other has to resume from a session id first. Rendered identically they
   * read as the same dead row.
   *
   * Deliberately NOT pushed for the same reason as the directory: nothing announces a reclaim (it
   * happens on a timer, in a conversation by definition nobody is touching) and a child can also
   * exit on its own, so every push would have to be found and none would cover a crash.
   */
  useLivenessLookup?(lookup: (ref: ConversationRef) => boolean): void;

  /**
   * Hand the platform a way to ask whether a scheduled task posts into the conversation at one of
   * its addresses.
   *
   * Same seam as the two above, but not decoration: the web UI evicts its least recently active
   * topic once it holds too many, and a task's target is a plain address that nothing rewrites
   * when the topic behind it goes — so evicting a scheduled task's topic would turn every later
   * run into a failure posted nowhere. A lookup rather than a pushed set because tasks come and
   * go through four entry points (the agent's commands, `/setting schedule`, expiry, completion),
   * and the question is only asked at the moment a topic has to be chosen.
   */
  useScheduleLookup?(lookup: (ref: ConversationRef) => boolean): void;

  /**
   * Hand the platform the gateway's scheduled tasks, to list and to act on — the web UI's side
   * panel.
   *
   * Unlike useScheduleLookup, which is a yes/no read taken only when a topic is about to be
   * evicted, this is the whole list and the four operations: a panel needs both, and
   * `ScheduleService.op` is already the one place that validates a transition, so the page can
   * never invent one. Optional and web-UI-only for the reason the lookups above are — a chat app
   * manages tasks through `/setting schedule`, whose menu is a message, not a surface.
   *
   * A pull rather than a push: the panel asks when it opens, after every action, and on a timer
   * while it is visible. Nothing announces a run finishing (the scheduler is the only thing that
   * knows), so a push would have to invent an event the daemon does not otherwise need.
   */
  useSchedulePanel?(panel: SchedulePanel): void;

  /**
   * Hand the platform the gateway's own skills, to list, read, edit, archive and roll back — the
   * web UI's skills page.
   *
   * Every write goes through `daemon/skills-store.ts`, the same functions `talkcode skills` calls:
   * that module owns name and path validation, the version `patch` must carry, the commit each
   * change becomes, and the archive that is the only "delete" there is. The
   * daemon wraps it in `daemon/skills-panel.ts` and also tells the conversation that created a
   * skill when it is archived, exactly as the CLI path does.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app manages skills through
   * `talkcode skills`, whose output is a message; a page has room for a file list and a history.
   */
  useSkillsPanel?(panel: SkillsPanel): void;

  /**
   * Hand the platform the gateway's automatic reviews — the sessions `daemon/review.ts` files and
   * what each one changed, for the web UI's Reviews tab.
   *
   * Read-only on purpose. A review is not a control: the writer is the review sweep, held to the
   * skill store's own validation and history, and nothing a page sends can make one run or undo one.
   * The page shows what happened and names the `talkcode skills revert` / `archive` command, which
   * the person runs as they would any other command.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app already gets the one
   * line a change posts, and has no column to list the quiet reviews that posted nothing.
   */
  useReviewPanel?(panel: ReviewPanel): void;

  /**
   * Hand the platform a way to end the agent process behind a conversation that is idle — what the
   * idle sweeper does on its timer, asked for now. Answers whether a process was ended.
   *
   * The only one of these seams that acts rather than asks, and it acts only within the sweeper's
   * own gates (ConversationRegistry.reclaimIdleForRef): no turn running or collecting, no question
   * pending, and a runtime that can resume the session. So the platform's own idea of "idle" — a
   * dot, possibly seconds stale by the time it is clicked — can never end a turn that has started
   * since. The conversation is kept; its next message starts the agent again where it left off.
   *
   * Optional and web-UI-only for the reason the lookups above are: it is a control for a page that
   * lists its conversations, which no chat app does.
   */
  useIdleReclaim?(reclaim: (ref: ConversationRef) => boolean): void;

  /**
   * Hand the platform a way to ask which agents the conversation at one of its addresses could still
   * be given to — every configured agent, grouped by machine, and which of them answers if nobody
   * picks. `undefined` when the question is closed: the conversation has started with its agent (a
   * session is a binding `/agent` refuses to move), or there is only one agent to choose.
   *
   * Optional and web-UI-only for the reason the lookups above are: a new web UI topic is a blank page
   * with room to lay the choice out, where a chat app has a message box and the `/agent` menu. A
   * lookup rather than a pushed list because `/reload` changes the agents and a session closes the
   * question, and the only moment the answer matters is when an empty topic is drawn.
   */
  useAgentCatalog?(lookup: (ref: ConversationRef) => AgentCatalog | undefined): void;

  /**
   * Hand the platform a model switch for its conversations: what each can switch to, and the switch
   * itself — `/model` without typing it. Optional and web-UI-only for the reason the seams above
   * are: a chat app has `/model` and its menu, and nowhere persistent to put a control.
   */
  useModelPicker?(picker: ModelPicker): void;

  /**
   * Show the agent's live status for the conversation at an address — model, context, cost, cache
   * expiry, quota — somewhere that is not a message. `undefined` clears it.
   *
   * Optional, and the web UI is the only implementor, for the reason useWorkdirLookup gives: a chat
   * app has nowhere persistent to put a status line, and the footer already appends the stable part
   * of it to every reply. The page has a strip above its composer that exists only for this.
   *
   * PUSHED, unlike the three lookups above, and for the opposite reason: every one of these values
   * changes at a moment the daemon already sees — a `usage_update`, a status-line frame, a turn
   * ending — and nothing changes it in between. Polling would mean asking every topic, forever, a
   * question whose answer only moves while its agent is talking. The caller throttles and drops
   * repeats (see daemon/status-board.ts), so an implementation may treat each call as a change.
   *
   * Synchronous and best-effort: the caller swallows a throw, and nothing about a turn may depend on
   * it having been shown.
   */
  setStatus?(address: ConversationAddress, status: AgentStatus | undefined): void;

  /**
   * Tell the platform how the conversation at an address last ended, and whether a turn is about to
   * be continued automatically (see TopicActivity) — for a platform that lists its conversations and
   * can say which of them need the person (core/topic-stage.ts). `undefined` forgets it (`/new`).
   *
   * Pushed for the reason setStatus is: it changes only at a turn's start and end, which the daemon
   * sees. Optional and web-UI-only for the reason the lookups above are: a chat app's conversation
   * list is the chat app's. Synchronous and best-effort.
   */
  setActivity?(address: ConversationAddress, activity: TopicActivity | undefined): void;

  /**
   * When the person last looked at the conversation at an address (epoch ms), as far as this
   * platform can tell — undefined when it cannot tell at all, which every chat app is: none reports
   * that a bot's message was read. The web UI can, because its page says so (`api/seen`).
   *
   * Read by core/topic-stage.ts's callers: a reply the person has already read is not waiting on
   * them.
   */
  seenAt?(address: ConversationAddress): number | undefined;

  /**
   * The conversation that opened the one at `address` (`createThread`'s `under`), while both are
   * still there — undefined for one nothing opened, or whose opener is gone. With `childrenOf`, the
   * platform's own record of which agent handed work to which (daemon/delegation.ts): the daemon
   * keeps no second copy, so deleting a topic on the page is the one way the relation ends.
   *
   * Optional and web-UI-only: the relation is shown by nesting one lane under another in a list the
   * platform draws itself, and a chat app's topic list is the chat app's. A platform without it
   * cannot hold sub-agents at all — the daemon refuses `task-new` there rather than opening topics
   * nobody could tell apart from the rest.
   */
  parentOf?(address: ConversationAddress): ConversationAddress | undefined;

  /** The conversations the one at `address` opened, most recently active first. See `parentOf`. */
  childrenOf?(address: ConversationAddress): ConversationAddress[];

  /**
   * Whether the lane an address names still exists.
   *
   * A daily-session task keeps its topic for the day, so before a later run joins it the daemon has
   * to know the topic was not deleted — otherwise every run until midnight fails into nothing. A
   * platform that can answer says so; one that cannot leaves this absent and the daemon assumes the
   * lane is there, which is the only honest answer when the platform has no way to ask (a chat app's
   * topic may also be deleted, but nothing in its API reports it).
   *
   * Optional and web-UI-only for the same reason as the lookups above: the page owns its topic list,
   * so deletion is a fact it knows exactly.
   */
  hasThread?(address: ConversationAddress): boolean;

  /**
   * Send a message with buttons (used by clarify).
   *
   * `opts.kind` means the same thing it does on `sendMessage`, and is given on the SEND only: the
   * web UI uses it for the sub-agent confirmation card, which is a dispatch. Every other
   * implementation ignores the parameter, and may leave it off its signature.
   */
  sendButtons(
    address: ConversationAddress,
    text: string,
    buttons: ButtonSpec[],
    /**
     * The same menu as a structured screen, for a platform declaring `settingsScreen` (the web
     * UI). Every other implementation ignores it: its buttons already are the whole screen.
     */
    screen?: SettingsScreen,
    opts?: SendOptions
  ): Promise<MessageRef>;

  /**
   * Replace an existing message's text AND its buttons, in place.
   *
   * Not expressible through editMessage, which carries no component payload: on Discord a
   * text-only PATCH drops the components entirely. That is exactly right for retiring a menu and
   * exactly wrong for advancing one, and a paginated menu needs the message to keep working after
   * the edit — otherwise every page turn is a new message and the old buttons stay live above it.
   *
   * An empty array strips the buttons and leaves plain text. Only call when
   * capabilities.editButtons is true; the implementation throws otherwise.
   *
   * `screen` replaces the structured screen the same way the buttons are replaced: absent means
   * the message is no longer that screen (retired, or handed to another menu), so a stale one
   * cannot outlive the buttons it belonged to.
   */
  editButtons(
    ref: MessageRef,
    text: string,
    buttons: ButtonSpec[],
    screen?: SettingsScreen
  ): Promise<void>;

  /**
   * Register slash commands (called once after the bot logs in).
   * With opts.guildId, guild-level registration (immediate); otherwise global (up to ~1h propagation).
   */
  registerCommands(cmds: SlashCommandSpec[], opts?: { guildId?: string }): Promise<void>;

  /** Receive button clicks. session → ButtonInteraction. Optional: safely ignored if daemon hasn't registered this round. */
  onButton(handler: (ev: ButtonInteraction) => void): void;

  /** Receive slash invocations. Optional: safely ignored if daemon hasn't registered this round. */
  onCommand(handler: (ev: CommandInteraction) => void): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What a sent message is, beyond its text.
 *
 * - `tools` — a tool-progress bubble (core/tool-renderer.ts): one `{emoji} {tool}: "{preview}"`
 *   line per tool call, edited in place as they finish. The web UI draws each line folded to one
 *   row and lets the reader open it, which is only possible if it knows the lines are tool lines
 *   and not prose — by the time it reaches an adapter, a bubble is otherwise just text.
 * - `dispatch` — work handed to a sub-agent (`daemon/delegation.ts`): the confirmation card and
 *   the "started" card in the parent topic, and the task text a sub-agent's topic is handed
 *   (whose first message opens with `↳ From …`). The web UI marks these so a hand-off does not
 *   read as an ordinary reply.
 * - `report` — a `[sub-agent updates]` card: what the sub-agents did, shown to the parent. The
 *   web UI keeps its lines folded the way it folds a tool bubble, and marks it apart from a
 *   dispatch.
 *
 * Every other platform ignores this: a chat app shows the text as sent, so the distinction is
 * the web UI's alone to draw.
 */
export type MessageKind = 'tools' | 'dispatch' | 'report';

/**
 * `MessageKind`'s values at runtime, for code that has to recognise a kind it was handed as data —
 * a transcript file read back from disk. `satisfies` pins every entry to the type, so a typo or a
 * renamed kind fails to compile rather than silently matching nothing.
 */
export const MESSAGE_KINDS = ['tools', 'dispatch', 'report'] as const satisfies readonly MessageKind[];

export interface SendOptions {
  kind?: MessageKind;
}

export interface PlatformCapabilities {
  editMessage: boolean;
  reaction: boolean;
  typing: boolean;
  /** Per-message text limit; StreamBuffer chunks by it. */
  maxMessageLength: number;
  /**
   * How many characters of a tool call's argument preview a tool-bubble line carries here, when
   * that is MORE than the operator's `tools.previewLimit`. Omit to use that setting as it is,
   * which is what every chat app should do: the line arrives as plain text there and stays as
   * long as it is sent, so a short preview is the only way to keep a run of tools readable.
   *
   * Declared by the web UI, which folds a long line itself (see SendOptions `tools`) and so can
   * afford to receive the whole command — the 40 characters a phone needs cut most commands off
   * before the part that tells two of them apart.
   */
  toolPreviewLimit?: number;
  /**
   * How many in-place edits ONE message accepts over its lifetime. Omit when the platform only
   * rate-limits edits (Telegram/Discord/Slack) — that is the common case and means "unbounded".
   *
   * Lark declares 20: past that `im.message.update` answers 230072 permanently. StreamBuffer and
   * ToolRenderer spend this budget deliberately and seal the message when it runs out, continuing
   * in a fresh one. Declaring it is strictly better than waiting for the rejection — every rejected
   * edit is a wasted round trip and a visibly frozen message — but the rejection path
   * (MessageNotEditableError) still backs it up if a platform tightens the cap.
   */
  maxEditsPerMessage?: number;
  /** True reply (message_reference). */
  reply: boolean;
  /** Thread creation. */
  thread: boolean;
  /**
   * Whether a topic can be opened with NO message to hang it on.
   *
   * Its own flag rather than something read off `thread`, for the reason renameThread is: `thread`
   * is true on platforms whose topic IS a message. Slack's thread is a `thread_ts`, Discord's
   * startThreadFromMessage and Lark's reply_in_thread all need a real message; a scheduled run has
   * none, and asking them anyway either fails or names the channel instead of a new lane. Telegram's
   * createForumTopic and the web UI's topics need nothing, so they declare this.
   *
   * Telegram is the reason this is a capability and not a hard list: createForumTopic works only in
   * a topic-enabled supergroup, which the registration cannot know. It declares the capability, and
   * a run in an ordinary group fails and says so.
   *
   * Absent/undefined treated as false, so a profile that has not thought about it is never asked.
   */
  standaloneThread?: boolean;
  /**
   * Whether an existing lane can be RENAMED (renameThread).
   *
   * Its own flag rather than something read off `thread`, for the reason editButtons is: `thread`
   * is true on platforms where the operation does not exist. Slack threads have no name to change
   * at all, and Telegram's `editForumTopic` works only in a topic-enabled supergroup — the same
   * `thread: true` covers both a Telegram forum, a Telegram DM topic, a Discord thread and a Slack
   * `thread_ts`, which are four different answers to "can this be renamed".
   *
   * Absent/undefined treated as false, so a profile that has not thought about it is never asked.
   */
  renameThread?: boolean;
  /** Interactive buttons (send + receive). */
  buttons: boolean;
  /**
   * Whether an already-sent message's buttons can be REPLACED in place (editButtons).
   *
   * Deliberately its own flag rather than `editMessage && buttons`. Lark has both of those true
   * and still needs a different endpoint here — its editMessage posts `msg_type:'post'` through
   * `im.message.update`, which cannot touch a card, while buttons live on a card and are updated
   * through `im.message.patch`. A derived predicate would be right about Lark by accident and
   * wrong about the mechanism, and wrong about LINE/QQ for a third reason (no edit endpoint at
   * all). Same reasoning as canRegisterSlashAtRuntime below.
   */
  editButtons: boolean;
  /**
   * Whether `/setting` is drawn as a screen of its own rather than as the button grid every menu
   * shares.
   *
   * A chat app can only offer buttons, so its settings rows have to squeeze a label and a value
   * into one 40-character string; a page has a message's width and can put them on separate lines,
   * group the rows, and show the whole value. Declaring this asks the daemon to attach the
   * structured `SettingsScreen` to the menu message (see `sendButtons`), which the web UI is the
   * only implementation to draw. Absent/undefined treated as false.
   */
  settingsScreen?: boolean;
  /**
   * How many items one page of a button menu may hold here (`/cd`, `/model`, `/setting`).
   *
   * Declared per platform rather than shared, because the limits are not close to each other:
   * Discord allows 25 components per message, Telegram's inline keyboard is effectively unbounded
   * but costs one screen ROW per button (its profile puts one per row — a shared row squeezes long
   * labels into unreadable slivers), LINE bundles at most 4 per template and QQ 5 per row. One
   * number for all of them has to be the smallest, and the smallest made `/cd` page through a
   * ten-project workspace two items at a time.
   *
   * Absent means "nobody has checked this platform's limits", which core reads as the conservative
   * PAGE_SIZE rather than as no limit (core/paging.ts `resolvePageSize`, which also clamps a
   * declared number to what Discord can physically carry). Meaningless when buttons=false.
   */
  menuPageSize?: number;
  /** Slash commands (register + receive). */
  slashCommands: boolean;
  /**
   * Max slash commands registerable at once (platform constraint). Excess is truncated by
   * priority, registering only the first N. Discord/Telegram are both 100; platforms without
   * registration leave 0. Meaningless when slashCommands=false.
   */
  maxSlashCommands?: number;
  /**
   * Whether a received slash command MUST be answered to close out the platform's interaction
   * (Discord: the adapter auto-emits a DEFERRED response and the UI shows "the application did not
   * respond" until a followup lands, so the daemon sends a short receipt). Telegram-style platforms
   * deliver slash as an ordinary message with nothing to close, where that receipt is pure noise —
   * the real reply is already coming. Absent/undefined treated as false.
   */
  slashNeedsAck?: boolean;
  /**
   * Whether the platform supports purely-runtime slash registration (no manual out-of-band step).
   * Absent/undefined treated as true, compatible with all existing profiles (Discord
   * bulkOverwrite, Telegram setMyCommands are both runtime). Slack explicitly false: its slash
   * commands must be registered out-of-band via the App config panel / app manifest, so
   * registerCommands is a runtime no-op — daemon skips the pointless registration call.
   * Orthogonal to slashCommands: slashCommands=true means "can receive slash", this field means
   * "can register at runtime".
   */
  canRegisterSlashAtRuntime?: boolean;
  /**
   * Whether the outbound pacer budgets each lane (thread) on its own instead of the channel as one
   * (daemon/paced-adapter.ts). Absent/undefined treated as false, which is right for every chat
   * service: a Telegram forum topic shares its chat's flood limit, and a budget per topic would
   * hand a busy forum N times what the platform takes.
   *
   * The web UI is the platform this is for. Nothing at its far end counts writes, and its topics
   * are lanes on ONE channel — so under the default every topic queued behind every other topic's
   * streaming, at the shared 1 write/s. A menu tap in a quiet topic waited 1.1 s with one other
   * topic busy and 5.1 s with three (the real OutboundPacer on a fake clock, 2026-10-31). Per lane,
   * a topic waits only for its own writes; the instance-wide ceiling still bounds the whole page.
   */
  paceByLane?: boolean;
  /**
   * Whether `startTyping` switches on something that stays on until `stopTyping`, instead of an
   * indicator the platform expires by itself a few seconds later. Absent/undefined treated as
   * false, which is true of every chat service.
   *
   * It decides how the outbound pacer treats `startTyping` (daemon/paced-adapter.ts). An expiring
   * indicator is a beat that may be DROPPED when the chat has no budget: it would arrive late, and
   * the next beat 8 s on carries it anyway. A switch is not a beat. On the web UI a dropped start
   * is the topic's dot left dim, its "running" label and Stop button missing, for as long as the
   * chat stays busy — and the turn's own tool bubbles are what keep it busy. Reported 2026-10-31,
   * on a topic whose agent was visibly working while three others streamed beside it.
   */
  typingUntilStopped?: boolean;
}
