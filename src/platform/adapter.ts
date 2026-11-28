import type { ConversationAddress } from '../core/conversation.js';
import type {
  AgentHandoffAction,
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  MessageRef,
  SettingsScreen,
  SlashCommandSpec,
  WorkdirScreen,
} from '../types.js';
import type { TopicPresence, TopicTree, WorkbenchHost } from './workbench.js';

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
 * - `subagent` — one subagent's card (daemon/subagent-cards.ts): the same tool lines, all of one
 *   subagent the harness started, under a `↳ {name}` header that takes ✓ / ✗ when it ends. The web
 *   UI draws it as one line in the transcript, its tools in the subagent bar above the status line.
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
export type MessageKind = 'tools' | 'subagent' | 'dispatch' | 'report' | 'aside';

/**
 * `MessageKind`'s values at runtime, for code that has to recognise a kind it was handed as data —
 * a transcript file read back from disk. `satisfies` pins every entry to the type, so a typo or a
 * renamed kind fails to compile rather than silently matching nothing.
 */
export const MESSAGE_KINDS = ['tools', 'subagent', 'dispatch', 'report', 'aside'] as const satisfies readonly MessageKind[];

export interface SendOptions {
  kind?: MessageKind;
  /**
   * Messages sent under one series are one item, continued: a subagent's card (kind `subagent`,
   * keyed by the call that started it) whose tools went on in another message — one that outgrew
   * its bubble, or a later render the subagent was resumed in. The web UI draws a series as one
   * subagent; a platform with no such list ignores it.
   */
  series?: string;
  workdir?: WorkdirScreen;
  handoff?: AgentHandoffAction;
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
  /** Whether the platform can render a one-tap handoff action on a refused agent switch (opening a new topic with an unsent draft). */
  handoffAction?: boolean;
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
