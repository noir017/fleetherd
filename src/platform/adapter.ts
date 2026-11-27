import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type {
  AgentCatalog,
  AgentStatus,
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  MessageRef,
  OfflineMachine,
  PendingQueueItem,
  SettingsScreen,
  SlashCommandSpec,
  TopicActivity,
  TopicKillResult,
  WorkdirScreen,
} from '../types.js';
import type {
  ConversationWorkdir,
  FilesPanel,
  GitPanel,
  HistoryPanel,
  InstructionsPanel,
  ModelPicker,
  PendingQueueActions,
  ReviewPanel,
  SchedulePanel,
  SessionOptionPicker,
  SkillsPanel,
  TopicPresence,
  TopicSetupResult,
  TopicTree,
  TurnChangeEntry,
  TurnChangesPanel,
  VoiceTranscriber,
  WorkdirBrowseResult,
  WorkbenchHost,
} from './workbench.js';

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

  /** Optional workbench capabilities (implemented by the built-in web UI). */
  readonly topics?: TopicTree;
  readonly presence?: TopicPresence;
  readonly workbench?: WorkbenchHost;

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

  /**
   * True reply: send a platform-native reply targeting ref (Discord message_reference).
   *
   * `opts.kind` as on sendMessage. The web UI also records which message this answers, so the
   * page can pair a side answer with the `/btw` it replies to.
   */
  replyMessage(ref: MessageRef, text: string, opts?: SendOptions): Promise<MessageRef>;

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
      /**
       * The task whose run opened it, with `scheduled`. The web UI records it on the topic, so a
       * task's page can list every session the task opened rather than only the runs its history
       * still holds. Ignored by every other adapter, for the reason `scheduled` is.
       */
      task?: string;
    }
  ): Promise<{ address: ConversationAddress }>;

  /**
   * Open a lane that is a FORK of the conversation at `source` (`/fork`): its own conversation, which
   * the daemon starts as a copy of the source's agent session. The platform records the relation and
   * shows it — the web UI draws the fork beside its source with a mark of its own, and says at the top
   * of the new topic which topic and turn it was forked from — and names the lane itself, from the
   * title it shows for the source, which is the name the person knows it by. `turn` is the source's
   * last turn number, for that line; absent when the library could not say.
   *
   * Not `createThread`'s `under`: a fork is the person's own conversation, not one an agent opened, so
   * nothing about it is nested, notified or stoppable from the source.
   *
   * Answers `discard` as well, for the daemon to call when the copy cannot be made after all: the lane
   * goes again, rather than staying as a topic that says "forked from" and holds none of it.
   *
   * Optional, and its presence is what `/fork` is answered on: a chat app has no topic list to put a
   * fork beside its source in, so every other platform omits it and `/fork` is refused there by name.
   */
  forkThread?(
    source: ConversationAddress,
    opts: { turn?: number }
  ): Promise<{ address: ConversationAddress; title: string; discard(): void }>;

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
   * Hand the platform a read-only view of the git repository the conversation's directory sits in:
   * the change list for one of three comparisons, one file's two sides and patch, and the branches
   * a base can be chosen from. `daemon/git-panel.ts` runs the git commands on the machine the
   * agent runs on (`ConversationRegistry.workspaceForRef`), so a browser sees a remote host's
   * repository the same way it sees the gateway's own.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app has no window to put a
   * diff in, and the agent already reports what it changed.
   */
  useGitPanel?(panel: GitPanel): void;

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
   * Every write goes through `daemon/skills-store.ts`, the same functions `fleetherd skills` calls:
   * that module owns name and path validation, the version `patch` must carry, the commit each
   * change becomes, and the archive that is the only "delete" there is. The
   * daemon wraps it in `daemon/skills-panel.ts` and also tells the conversation that created a
   * skill when it is archived, exactly as the CLI path does.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app manages skills through
   * `fleetherd skills`, whose output is a message; a page has room for a file list and a history.
   */
  useSkillsPanel?(panel: SkillsPanel): void;

  /**
   * Hand the platform the gateway's automatic reviews — the sessions `daemon/review.ts` files and
   * what each one changed, for the web UI's Reviews tab.
   *
   * Read-only on purpose. A review is not a control: the writer is the review sweep, held to the
   * skill store's own validation and history, and nothing a page sends can make one run or undo one.
   * The page shows what happened and names the `fleetherd skills revert` / `archive` command, which
   * the person runs as they would any other command. An archive suggestion's button posts to the
   * Skills tab's own operation (`useSkillsPanel`), so nothing here gains a write.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app already gets the one
   * line a change posts, and has no column to list the quiet reviews that posted nothing.
   */
  useReviewPanel?(panel: ReviewPanel): void;

  /**
   * Hand the platform the conversation library — every conversation this gateway ever recorded,
   * for the web UI's history page.
   *
   * Read-only by construction: the library is written as turns happen, and nothing here adds,
   * changes or deletes a row. The list leaves out a review's own session (`HistoryStore.list`),
   * because a review is the gateway's background work, not a conversation someone had; the
   * Reviews tab is where those are read.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app already has
   * `fleetherd sessions list/search/read` for this, and no surface to draw a list on.
   */
  useHistoryPanel?(panel: HistoryPanel): void;

  /**
   * Hand the platform the files of the machines topics run on, for the web UI's file window.
   *
   * Web-UI-only for the reason the panels above are, and off unless the operator turned
   * `platforms.<id>.files.enabled` on — writing a file is running commands by another route, so
   * the page's login secret is the only thing in front of it, exactly as for the terminal.
   */
  useFilesPanel?(panel: FilesPanel): void;

  /**
   * Hand the platform the operator's instructions, for the web UI's settings page: the gateway's
   * `instructions/` files and the files each agent's harness references on its machine.
   *
   * Web-UI-only for the reason the panels above are, and off unless the operator turned
   * `platforms.<id>.instructions.enabled` on: with it, the page's login secret guards the standing
   * instructions of every agent on every platform, not one conversation (AGENTS.md, invariant 10).
   */
  useInstructionsPanel?(panel: InstructionsPanel): void;

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
   * Hand the platform a way to end the agent process behind a conversation AND every sub-agent
   * topic nested under it — the web UI's "End agent" in a topic row's menu.
   *
   * The broader sibling of `useIdleReclaim`, and deliberately not built on it: this one is allowed
   * to stop a turn, which is what `/kill` does, so it goes through `killConversation` rather than
   * the idle sweeper's gates. The conversation of every topic is kept — the next message there
   * resumes it where it left off.
   *
   * `confirmed` is the list the page held when the menu item was clicked, and only its
   * intersection with the subtree walked now is ended. That is what keeps a sub-agent that
   * appeared since out of the kill: the newcomer is not in the list, so it is not touched. The
   * walk is still the platform's own `childrenOf` (`Delegation.endTopic`), never a list the page
   * assembled.
   *
   * Answers one row per topic it acted on, root first, so the page can say what became of each
   * rather than a count. An address that names nothing answers no rows.
   *
   * Optional and web-UI-only for the reason the seams above are: a chat app has no topic list to
   * hang a per-row menu on, and `/kill` plus `/stop` are its two commands.
   */
  useTopicKill?(kill: (ref: ConversationRef, confirmed: ReadonlySet<string>) => TopicKillResult[]): void;

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

  /** Bind a new/empty topic's agent and working directory in one step without adding prompt text. */
  useTopicSetup?(
    setup: (ref: ConversationRef, opts: { agent?: string; cwd?: string; dryRun?: boolean }) => TopicSetupResult
  ): void;

  /** Browse one level of directories for a topic's selected agent (inline new-topic folder picker). */
  useWorkdirBrowser?(
    browse: (ref: ConversationRef, opts?: { agent?: string; dir?: string; atRoot?: boolean }) => Promise<WorkdirBrowseResult>
  ): void;

  /**
   * Hand the platform a model switch for its conversations: what each can switch to, and the switch
   * itself — `/model` without typing it. Optional and web-UI-only for the reason the seams above
   * are: a chat app has `/model` and its menu, and nowhere persistent to put a control.
   */
  useModelPicker?(picker: ModelPicker): void;

  /**
   * Hand the platform a switch for the agent's own settings (SessionOptionPicker) — an account a web
   * agent runs on, say. Web-UI-only for the model switch's reason, and with no command behind it:
   * these are the agent's to define, so no chat vocabulary names them.
   */
  useOptionPicker?(picker: SessionOptionPicker): void;

  /**
   * Hand the platform one turn's change list and one changed file — what the page's change entry
   * opens. Optional and web-UI-only for the reason the seams above are: a chat app has no window
   * to show a diff in, and its reply has no room for a control that opens one.
   */
  useTurnChanges?(panel: TurnChangesPanel): void;

  /**
   * Hand the platform an on-demand voice transcription callback so the browser UI can dictate
   * straight into its composer instead of posting an audio message and waiting on a card.
   */
  useVoiceTranscriber?(transcriber: VoiceTranscriber): void;

  /**
   * Hang a finished turn's change summary off the reply it ended — `reply` is the message this turn
   * last posted, captured by the runner at turn end, so a slow snapshot cannot land under a later
   * turn's answer. No reply (a turn that posted nothing) means no entry.
   *
   * Its presence is also the daemon's answer to "does this platform show turn changes at all":
   * the snapshots are only taken where something can show them.
   */
  attachTurnChanges?(address: ConversationAddress, entry: TurnChangeEntry, reply?: MessageRef): void;

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
   * Push the current list of recallable mid-turn pending messages for a conversation (empty clears).
   * Optional and web-UI-only; synchronous and best-effort like `setStatus`.
   */
  setPendingQueue?(address: ConversationAddress, items: readonly PendingQueueItem[]): void;

  /**
   * Notify the platform that previously held pending message(s) were handed to the agent and should
   * now appear in the regular transcript at the current position.
   */
  markPendingDelivered?(address: ConversationAddress, messageIds: readonly string[]): void;

  /** Wire recall / send-now actions from the platform (WebUI) into the daemon's merger. */
  usePendingQueueActions?(actions: PendingQueueActions): void;

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
   * Tell the platform which machines cannot be reached right now — every one, each time the list
   * changes (an empty list: all of them can). Names are the ones the agent menus and
   * `ConversationWorkdir.host` use, so a page can mark the topics and the agents on them.
   *
   * Pushed for the reason setStatus is: the daemon measures it (daemon/host-availability.ts) and
   * knows when it moves. Optional and web-UI-only for the reason the lookups above are: a chat app
   * has nowhere to keep a machine list, and its `/agent` menu says it when drawn. Synchronous and
   * best-effort.
   */
  setOfflineMachines?(machines: readonly OfflineMachine[]): void;

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
    screen?: SettingsScreen,
    opts?: SendOptions
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
 * - `aside` — the answer to a side question (`/btw`, daemon/acp-side-question.ts): asked of a copy
 *   of the conversation and kept out of it, so it must not read as the next step of the work the
 *   messages around it are about — it often arrives in the middle of a reply still streaming.
 *   Sent as a reply to the `/btw` where the platform has replies (turn-runner.ts sendAside); the
 *   web UI then shows it in a card over the composer instead of in the transcript.
 *
 * Every other platform ignores this: a chat app shows the text as sent, so the distinction is
 * the web UI's alone to draw.
 */
export type MessageKind = 'tools' | 'dispatch' | 'report' | 'aside';

/**
 * `MessageKind`'s values at runtime, for code that has to recognise a kind it was handed as data —
 * a transcript file read back from disk. `satisfies` pins every entry to the type, so a typo or a
 * renamed kind fails to compile rather than silently matching nothing.
 */
export const MESSAGE_KINDS = ['tools', 'dispatch', 'report', 'aside'] as const satisfies readonly MessageKind[];

export interface SendOptions {
  kind?: MessageKind;
  workdir?: WorkdirScreen;
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
  /** Whether `/cd` is drawn as an interactive directory browser (`WorkdirScreen`) instead of flat buttons. */
  workdirScreen?: boolean;
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
  /**
   * How many directories one page of `/cd` may hold, when that differs from `menuPageSize`.
   *
   * The two menus are bounded by different things. `menuPageSize` is sized so a page of long model
   * ids still fits one phone screen; a page of short directory names has no such cost, and its
   * only real bound is the scan (`daemon/workdir-scan.ts` stops at 60 sub-directories and always
   * prepends the root). The web UI declares the whole scan here (2026-11-11): a browser scrolls,
   * so paging a workspace it could show at once was cost with no cause. Absent means "same as
   * `menuPageSize`"; clamped to core/paging.ts WORKDIR_PAGE_SIZE_MAX. Meaningless when
   * buttons=false.
   */
  workdirPageSize?: number;
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
