// Platform seam interface: everything platform-specific is funneled here.
// The generic Satori core (satori-core.ts) depends only on this interface, never on a
// concrete platform. Adding an IM platform = writing one profile implementing this
// interface and reusing all of core.
//
// Types come from @satorijs/core (Context/Session/Bot/h); outbound operation params use
// this repo's platform-agnostic domain types (ConversationAddress/MessageRef/...).
import type { Context, Session, Bot, h } from '@satorijs/core';

import type { PlatformConfig } from './config-schemas.js';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type { MessageRef, SlashCommandSpec } from '../types.js';
import type { PlatformCapabilities } from './adapter.js';

/**
 * What a profile reports about an inbound event's location: a ConversationRef minus the
 * two fields core fills itself (`platform` is the instance id, which the profile doesn't
 * know; `user` comes from the session uniformly).
 */
export type ResolvedConversation = Omit<ConversationRef, 'platform' | 'user'>;

/**
 * The location half of an interaction event as a PROFILE reports it: the same
 * platform-shaped conversation `resolveConversation` returns, plus the sender. Core adds
 * the instance id, exactly as it does for messages, so an interaction and a message from
 * the same place always produce the same ConversationRef.
 */
export interface ProfileInteractionEvent {
  conversation: ResolvedConversation;
  user: string;
  messageId: string;
}

export type ProfileButtonEvent = ProfileInteractionEvent & { buttonId: string };

export type ProfileCommandEvent = ProfileInteractionEvent & {
  name: string;
  options: Record<string, unknown>;
  reply: (text: string) => Promise<void>;
};

/**
 * Platform seam: a platform's specific points are all implemented here.
 *
 * Design principles:
 * - Satori-generic Bot methods (sendMessage/editMessage/deleteMessage/createReaction/
 *   deleteReaction/getMessageList) are called directly by satori-core, not via profile.
 * - Platform field differences (mention detection, conversation shape, attachment meta
 *   keys) are normalized by the profile.
 * - Platform-specific operations (typing/thread/buttons/reply/slash registration,
 *   interaction event mounting) go through the profile; an unimplemented optional method
 *   means the platform doesn't support it, and core degrades per capabilities or throws clearly.
 * - Every outbound method takes a ConversationAddress, never a channel string. A platform
 *   whose threads need a separate wire parameter (Telegram message_thread_id, Slack
 *   thread_ts) reads `address.thread`; one whose threads are channels ignores it.
 */
export interface PlatformProfile<P extends PlatformConfig = PlatformConfig> {
  /** Platform TYPE (the config discriminator, e.g. 'discord'), written to InboundMessage.platformType. */
  readonly type: string;
  /** Satori bot.platform value, used by ctx.bots.find to get the bot handle. */
  readonly satoriPlatform: string;
  /** Platform capability declaration (daemon gates/degrades by it). */
  readonly capabilities: PlatformCapabilities;

  /**
   * Mount this platform's Satori adapter plugin on ctx. Receives THIS platform's typed
   * config entry (the `platforms.<id>` object, schema in config-schemas.ts) — profiles
   * never see the whole Config. Assembly (platform-factory) guarantees the entry's type
   * matches the profile, so profiles read credentials without narrowing. `id` is the
   * `platforms:` key, for log lines that must say which of several instances they mean.
   */
  install(ctx: Context, platform: P & { id: string }): void;

  // —— Inbound normalization (platform fields differ) ——

  /** Whether this message @-mentions the bot itself. */
  detectMention(session: Session, selfId: string | undefined): boolean;

  /**
   * THE one place a platform describes its conversation model: which channel this event
   * belongs to, whether it sits in a sub-lane, and what kind of place it is.
   *
   * ── Why this is a single method ───────────────────────────────────────────────
   * It used to be four (`isDirect`, `isThread`, `inboundChannelId`, `decodeChannelKey`),
   * derived independently from the same session. They could disagree, and did: a
   * message routed as a thread but replied to as a plain channel. Telegram needed a
   * dedicated test just to police the agreement, and Slack failed it silently
   * (`isThread` hardcoded false while its outbound path emitted thread keys). One
   * method cannot disagree with itself.
   *
   * Called by core on EVERY inbound path — message, button click, slash command — so a
   * profile cannot wire it for messages and forget the interactions. That omission is
   * why buttons clicked inside a Telegram topic used to resolve to the chat root.
   *
   * Contract:
   *  - `channel` MUST be a complete API target on its own (Telegram: the chat id, never
   *    the bare message_thread_id the adapter reports for group topics).
   *  - `thread` is set ONLY when addressing needs an extra wire parameter. A Discord
   *    thread is `kind: 'thread'` with NO `thread`, because its id is already a channel.
   *  - `kind` is the sole thread/DM witness for routing and gating.
   */
  resolveConversation(session: Session): ResolvedConversation;

  /** Extract mime/size from a single media element (keys differ per platform). */
  attachmentMeta(el: h): { mime?: string; size?: number };

  // —— Capability-gated operations (absent = unsupported; satori-core degrades/throws per capabilities) ——

  /** True reply: send a platform-native reply targeting ref. */
  reply?(bot: Bot, ref: MessageRef, text: string): Promise<MessageRef>;
  /**
   * Create a thread from a message. Returns the new thread's address — `{channel: <new
   * channel>}` where threads are channels (Discord), `{channel, thread}` where they are a
   * lane (Telegram topics, Slack thread_ts).
   */
  createThread?(
    bot: Bot,
    ref: MessageRef,
    name: string,
    opts?: { autoArchiveMinutes?: number }
  ): Promise<{ address: ConversationAddress }>;
  /**
   * Rename an existing lane (a Telegram forum topic's title). Absent on a platform whose lanes
   * have no name, or whose API cannot change one after creation — the adapter then reports
   * `renameThread: false` and callers skip it rather than fail.
   */
  renameThread?(bot: Bot, address: ConversationAddress, name: string): Promise<void>;
  /** Send a message with buttons. */
  sendButtons?(
    bot: Bot,
    address: ConversationAddress,
    text: string,
    buttons: Array<{ id: string; label: string; style?: string }>
  ): Promise<MessageRef>;
  /**
   * Replace a sent message's text and buttons in place (paginated menus). Absent on a platform
   * with no message-edit endpoint (LINE, QQ), which then declares capabilities.editButtons: false.
   * An empty button list strips the buttons.
   */
  editButtons?(
    bot: Bot,
    ref: MessageRef,
    text: string,
    buttons: Array<{ id: string; label: string; style?: string }>
  ): Promise<void>;
  /**
   * Register slash commands. getBot lazily fetches the bot (may not be online yet; the
   * profile handles deferral/re-registration). ctx is also passed so the profile can use
   * ctx.on('login-updated') etc. to register after login.
   */
  registerCommands?(
    ctx: Context,
    getBot: () => Bot,
    cmds: SlashCommandSpec[],
    opts?: { guildId?: string }
  ): Promise<void>;
  /** Typing indicator. */
  typing?(bot: Bot, address: ConversationAddress): Promise<void>;
  /**
   * Outbound send override: for platforms whose Satori encoder cannot express the lane.
   * The encoder reads its thread parameter off the INBOUND session, which an
   * outbound-only send doesn't have, so such platforms post via `internal.*` themselves.
   * Absent ⇒ core's generic bot.sendMessage (correct where `address.thread` is never set).
   */
  sendMessage?(bot: Bot, address: ConversationAddress, text: string): Promise<MessageRef>;
  /** Outbound edit override: when the platform adapter doesn't wrap editing as generic
   *  bot.editMessage, the profile implements it (e.g. Slack's internal.chatUpdate). Otherwise
   *  satori-core falls back to generic bot.editMessage. */
  editMessage?(bot: Bot, ref: MessageRef, text: string): Promise<void>;
  /**
   * Outbound file override: same reason as sendMessage — the generic encoder can't attach
   * the lane to an upload, so a file could never reach a Telegram topic through it.
   */
  sendFile?(
    bot: Bot,
    address: ConversationAddress,
    file: { path: string; name?: string; caption?: string }
  ): Promise<MessageRef>;
  /**
   * Rendered length of `text` in the units the platform's message-length limit (capabilities
   * .maxMessageLength) actually counts. talkcode chunks outbound text BEFORE the profile renders
   * it; markdown rendering can change the counted length (e.g. Telegram counts the entity-parsed
   * visible text and table→bullets expands it ~1.4x; WeCom counts UTF-8 bytes, not chars). The
   * StreamBuffer uses this to chunk by the real rendered size instead of raw char count, so a chunk
   * never overflows the platform after rendering. Absent ⇒ identity (text.length), correct for any
   * platform that sends the raw text unchanged. */
  measureRendered?(text: string): number;
  /**
   * Translate this platform's own failure vocabulary into the core's (`core/outbound-errors.ts`).
   *
   * Called by satori-core around EVERY outbound call, so a profile declares its mapping ONCE
   * instead of wrapping method by method. That is not a style preference: Lark's 230072 →
   * `MessageNotEditableError` mapping was applied inside `editMessage` and nowhere else, so the
   * same rejection raised by a send or a card patch stayed an anonymous transient.
   *
   * Return the error unchanged when nothing matches. Returning a DIFFERENT error must be
   * conservative in one direction: a permanent failure wrongly typed as a rate limit merely wastes
   * a retry, while a permanent one typed as transient loses the message (which is the bug the
   * whole vocabulary exists to prevent) — and typing a 400 as either is worse than both.
   */
  classifyError?(e: unknown): unknown;
  /**
   * Inbound attachment fetch override: for a platform whose media elements are NOT public URLs.
   *
   * The daemon's generic downloader speaks http(s) and nothing else (deliberately — every hop of
   * an inbound, user-controlled URL is SSRF-checked there). adapter-lark hands out
   * `internal:lark/<selfId>/im/v1/messages/<id>/resources/<key>` instead, an address only the bot
   * itself can resolve, so a Feishu image or file reached the agent as
   * "[Attachment … failed to download]" and nothing else. A profile implements this to fetch such
   * a URL through its own authenticated client.
   *
   * Returns `undefined` when the URL is not one this profile owns, so the caller falls through to
   * the generic HTTP path — a platform that mixes public CDN links with private ones needs no
   * branch of its own.
   *
   * `name`/`mime` are returned because the platforms that need this hook are exactly the ones
   * whose elements carry neither: Feishu images arrive with no filename at all, and the adapter's
   * binary route drops the response headers. The ingest layer prefers what the element declared
   * and falls back to these.
   */
  fetchAttachment?(
    bot: Bot,
    url: string
  ): Promise<{ bytes: Uint8Array; mime?: string; name?: string } | undefined>;

  /** Reaction override: when the adapter doesn't wrap generic bot.createReaction, the profile
   *  implements it via internal. emoji is unicode (e.g. 👀/✅/❌); the profile maps it to the
   *  platform-accepted form and safely skips unsupported ones (may throw; upper safeReaction
   *  swallows it). Otherwise satori-core falls back to generic bot.createReaction. */
  addReaction?(bot: Bot, ref: MessageRef, emoji: string): Promise<void>;
  removeReaction?(bot: Bot, ref: MessageRef, emoji: string): Promise<void>;

  // —— Interaction event mounting (event names/payloads differ; unimplemented = no such interaction) ——

  /**
   * Receive button-click events, normalize, and emit back.
   *
   * The emitted event carries only the platform-specific parts; core stamps the instance
   * id and resolves the conversation via resolveConversation, so a profile cannot derive
   * the location differently here than it does for messages.
   *
   * Button-mount strategy decision table for new platforms (pick one, top-down priority):
   * 1) Adapter exposes the Satori-generic 'interaction/button' event ⇒ use the
   *    `mountSatoriButtonInteraction` helper directly. Discord/Telegram/QQ take this path (QQ's
   *    multi-bot uses opts.botPlatform='qqguild' to filter).
   * 2) Adapter does NOT expose that event ⇒ only then hand-write a socket/internal hook to parse
   *    raw frames (see Slack wrapping adapter.accept, Lark via internal callback). This is the
   *    last resort; honestly document the internal behavior depended upon (Hyrum's Law).
   */
  mountButtonEvents?(ctx: Context, emit: (ev: ProfileButtonEvent) => void): void;
  /** Receive slash invocation events, normalize, and emit back. */
  mountCommandEvents?(ctx: Context, emit: (ev: ProfileCommandEvent) => void): void;
}
