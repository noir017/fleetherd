// Telegram PlatformProfile: all Telegram-specific logic.
// Import from @satorijs/core (not the koishi umbrella) for the same reason as discord.ts:
// the umbrella eagerly pulls in @koishijs/loader (ESM interop bug). adapter-telegram builds
// on @satorijs/core, so using it directly avoids Context nominal friction.
//
// Adapter behaviors relied on (verified against adapter src/.d.ts + lib/index.cjs):
// - TelegramBot.inject=['http'] (even for polling), so install must ctx.plugin(HttpService) first.
// - reply: <quote id=...> -> reply_to_message_id (message.ts 'quote' branch).
// - buttons: an inline keyboard is posted via internal.sendMessage's reply_markup (NOT the Satori
//   <button> encoder, which routes through the adapter and cannot attach message_thread_id);
//   the click arrives as 'interaction/button' with session.event.button.id === callback_data, and
//   the adapter auto-answers the callback query. callback_data is capped at 64 bytes.
// - slash: bot.updateCommands -> internal.setMyCommands (gated by config.slash). Inbound
//   /cmd@bot args arrives as 'interaction/command' with session.content rewritten to
//   `command + rest` and NO structured argv.options -- must split from content ourselves.
// - reaction: adapter does not wrap setMessageReaction, but bot.http is exposed, so the profile
//   POSTs directly; remove sends an empty array. emoji is restricted to a fixed allow-set.
// - topics: decodeMessage only decodes them for groups. Its `chat.type === 'private'` branch
//   returns chat.id and never reads message_thread_id, so Bot API 9.4 private-chat topics lose
//   the thread before we see it; the raw update survives on session.telegram (setInternal), which
//   is where rawTopicFields recovers it. Group topics arrive as a BARE message_thread_id in
//   channel.id with the chat id in guild.id.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TelegramAdapter from '@satorijs/adapter-telegram';
import type { Bot, Session, Universal } from '@satorijs/core';

import type { ConversationAddress } from '../../core/conversation.js';
import { collectErrors, RateLimitedError } from '../../core/outbound-errors.js';
import type { MessageRef, SlashCommandSpec } from '../../types.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile, ResolvedConversation } from '../profile.js';
import type { TelegramPlatformConfig } from '../config-schemas.js';
import { installTelegramStartRetry } from '../telegram-start-retry.js';
import {
  deferUntilLogin,
  installHttpService,
  mountSatoriButtonInteraction,
  resolveDefaultPlugin,
} from '../profile-helpers.js';
import {
  renderTelegramMarkdown,
  fragmentToTelegramHtml,
  telegramVisibleLength,
} from '../telegram-markdown.js';

/**
 * Normalize any command name to a valid Telegram BotCommand name: `[a-z0-9_]`, length 1-32.
 *
 * setMyCommands only accepts `[a-z0-9_]`. adapter.updateCommands does toLowerCase + replace
 * non-\w with `_`, but does NOT dedupe: e.g. `add-dir` and an existing `add_dir` both normalize
 * to `add_dir`, and two duplicate names make the whole setMyCommands batch fail with 400. So we
 * normalize and dedupe up front -- not relying on adapter behavior, and guarding against dupes.
 * Normalization is idempotent (already-valid names pass through unchanged).
 */
function normalizeTelegramCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 32);
}

/**
 * Map SlashCommandSpec[] to Universal.Command[] (pure, for unit testing).
 *
 * Telegram's updateCommands reads only command.name and command.description (for setMyCommands)
 * and does NOT consume options/arguments (Telegram bot commands have no structured params).
 * So options stay empty, purely to satisfy the Universal.Command shape. Description uses the
 * default locale key ''.
 *
 * Names are normalized to `[a-z0-9_]`<=32 then deduped by normalized name (first wins), to avoid
 * add-dir / add_dir colliding and failing the whole batch with 400. Defensively drop entries that
 * normalize to an empty string.
 */
export function specsToTelegramCommands(cmds: SlashCommandSpec[]): Universal.Command[] {
  const seen = new Set<string>();
  const out: Universal.Command[] = [];
  for (const cmd of cmds) {
    const name = normalizeTelegramCommandName(cmd.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: { '': cmd.description },
      arguments: [],
      options: [],
      children: [],
    });
  }
  return out;
}

/**
 * Safely encode a button id into callback_data (Telegram hard-caps it at 64 bytes, UTF-8).
 * Most ids are well under 64; over-long ones fall back to prefix + djb2 hash tail, giving a
 * stable id that fits the limit and round-trips identically on click.
 */
export function encodeCallbackData(id: string): string {
  // callback_data is limited by bytes, not characters.
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');
  if (byteLen(id) <= 64) return id;
  // djb2 hash (deterministic, dependency-free), 8 hex chars.
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  const suffix = '#' + (hash >>> 0).toString(16).padStart(8, '0'); // 9 bytes
  // Trim the prefix byte-by-byte until prefix + suffix fits in 64 bytes.
  let prefix = id;
  while (byteLen(prefix) + byteLen(suffix) > 64) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + suffix;
}

/**
 * Narrowed view of TelegramBot internals (the @satorijs/core Bot base exposes no internal/http).
 * - internal.createForumTopic / internal.sendMessage: adapter-wrapped, already unwrapping the
 *   Telegram envelope's `.result` (returns the ForumTopic / Message body, not `{ ok, result }`).
 * - http.post: adapter does not wrap setMessageReaction (Internal is a fixed allow-list), so
 *   reaction hits raw http; its response is the raw `{ ok, result }` envelope, but we don't read it.
 */
interface TelegramInternal {
  createForumTopic(payload: {
    chat_id: string | number;
    name: string;
  }): Promise<{ message_thread_id: number; name: string }>;
  /**
   * Rename an existing forum topic. `name` is optional in the Bot API (omitting it keeps the
   * current name); we always send it, since renaming is the only reason to call this. Returns
   * `true` on success — the adapter unwraps the envelope, so a failure is a throw, not a `false`.
   */
  editForumTopic(payload: {
    chat_id: string | number;
    message_thread_id: number;
    name: string;
  }): Promise<boolean>;
  sendMessage(payload: {
    chat_id: string | number;
    message_thread_id?: number;
    text: string;
    parse_mode?: string;
    reply_to_message_id?: number;
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }): Promise<{ message_id?: number }>;
  sendDocument(payload: FormData): Promise<{ message_id?: number }>;
  editMessageText(payload: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode?: string;
    // Bot API accepts reply_markup here, which is what makes a paginated menu possible: the
    // keyboard is replaced with the text in one call. Omitting the key LEAVES the old keyboard,
    // so editButtons always sends it — an empty inline_keyboard is how buttons are cleared.
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }): Promise<unknown>;
}

/** bot.http view: used only by reaction (adapter does not wrap setMessageReaction). */
interface TelegramHttp {
  post(url: string, body: unknown): Promise<unknown>;
}

/**
 * Numeric message_thread_id from an address, validated.
 *
 * Telegram's `message_thread_id` is an integer. The previous scheme reached the API with
 * `Number('99:5') === NaN` whenever a malformed composite key slipped through, and Telegram
 * answers that with an opaque 400 far from the cause. Fail here, naming the value.
 */
function topicIdOf(address: ConversationAddress): number {
  const n = Number(address.thread);
  if (!Number.isInteger(n)) {
    throw new Error(
      `[telegram] message_thread_id must be an integer, got ${JSON.stringify(address.thread)} (channel=${address.channel})`
    );
  }
  return n;
}

/** Bot API cap on a forum topic's `name` (documented as "0-128 characters"). */
const TOPIC_NAME_MAX = 128;

/**
 * Collapse whitespace and fit a title into a forum topic's name.
 *
 * Exported for the tests, because both halves have a way of being wrong that no reviewer sees:
 *
 * - Titles come from a harness and can carry newlines; a topic name is one line, and Telegram
 *   silently mangles rather than rejects multi-line input.
 * - The cap is measured in UTF-16 code units, so `slice` on a string of astral characters (emoji,
 *   many CJK extension characters) can cut a surrogate pair in half and produce a lone surrogate.
 *   Telegram answers that with a 400 on a string whose `.length` looked legal. `Array.from` walks
 *   code points, so budgeting per code point cannot split one.
 */
export function truncateForTopicName(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= TOPIC_NAME_MAX) return flat;
  let used = 0;
  let out = '';
  // Leave room for the ellipsis, so the result is always within budget INCLUDING the marker.
  const budget = TOPIC_NAME_MAX - 1;
  for (const ch of flat) {
    if (used + ch.length > budget) break;
    out += ch;
    used += ch.length;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Composite-aware raw send — THE single outbound text path for this profile (sendMessage,
 * reply, sendButtons and the slash-command receipt all go through it).
 *
 * MUST be used instead of `bot.sendMessage` / `sendForRef` for anything that may carry a
 * topic: those call the adapter, whose encoder computes `chat_id = session.guildId ||
 * channelId` and reads `message_thread_id` off the INBOUND session — which an outbound-only
 * send does not have. So through the adapter a topic-bound message either loses its lane or,
 * back when the lane was smuggled inside the channel string, handed Telegram a malformed
 * chat_id. Verified live, that failed two different ways:
 *   - private chat: Telegram parses the id LENIENTLY, truncating at the ':' — the send SUCCEEDS
 *     (ok=true) but lands in the chat ROOT with no message_thread_id. Silently wrong place.
 *   - group/supergroup: hard 400 `chat not found`.
 * That is how `ask` buttons went missing from a topic: in a group the send threw and the daemon
 * sat on the pending ask until timeout, while in a DM the buttons appeared — just outside the
 * topic that asked.
 *
 * `extra` carries the per-caller payload (reply_to_message_id, reply_markup) so that adding a new
 * outbound kind means passing a field here, not writing a fresh send path that can forget the
 * lane — the omission this function exists to prevent.
 */
async function sendComposite(
  bot: Bot,
  address: ConversationAddress,
  text: string,
  extra: {
    replyToMessageId?: string;
    buttons?: Array<{ id: string; label: string }>;
  } = {}
): Promise<MessageRef> {
  const internal = bot.internal as unknown as TelegramInternal;
  const msg = await internal.sendMessage({
    chat_id: address.channel,
    ...(address.thread != null ? { message_thread_id: topicIdOf(address) } : {}),
    text: fragmentToTelegramHtml(renderTelegramMarkdown(text)),
    parse_mode: 'HTML',
    ...(extra.replyToMessageId != null
      ? { reply_to_message_id: Number(extra.replyToMessageId) }
      : {}),
    // One button per row: labels are agent-authored and can be long, and Telegram squeezes a
    // shared row into unreadable slivers. callback_data is capped at 64 bytes (encodeCallbackData).
    ...(extra.buttons?.length
      ? {
          reply_markup: {
            inline_keyboard: extra.buttons.map((b) => [
              { text: b.label, callback_data: encodeCallbackData(b.id) },
            ]),
          },
        }
      : {}),
  });
  const messageId = msg?.message_id;
  if (messageId == null) {
    throw new Error(`[telegram] sendMessage did not return a message id (channel=${address.channel})`);
  }
  // The ref keeps the full address (lane included) so a later reply into this message stays
  // in its topic. Edits and reactions read only address.channel, which the Bot API is happy
  // with — those two endpoints take no thread parameter.
  return { address, messageId: String(messageId) };
}

/**
 * Raw inbound topic fields, read off the Satori session (pure, for unit testing).
 *
 * Why this is needed at all: the adapter's decodeMessage assigns channel.id from a
 * `chat.type === 'private'` branch that returns `chat.id` and NEVER looks at
 * message_thread_id — the topic branch exists only for groups (lib/index.cjs). So for
 * Bot API 9.4 private-chat topics (Feb 2026: forum topics inside a 1-on-1 DM), every
 * topic collapses onto the same bare chat id and the thread is lost before talkcode
 * sees it. Telegram does send the fields — verified against live getUpdates:
 *
 *   {"chat":{"id":5865716608,"type":"private"},
 *    "message_thread_id":7353,"is_topic_message":true}
 *
 * The adapter stashes the whole update via session.setInternal('telegram', update), which
 * merges it onto `session.telegram` — so the dropped fields are still reachable here.
 * This mirrors how hermes reads them (`chat_type == 'dm' and is_topic_message`).
 */
export function rawTopicFields(session: unknown): {
  threadId?: string;
  isTopicMessage: boolean;
} {
  const tg = (session as { telegram?: Record<string, unknown> } | undefined)?.telegram;
  // The internal payload is the Update; the message may sit under any of these keys.
  const msg = (tg?.message ??
    tg?.edited_message ??
    tg?.channel_post ??
    tg?.edited_channel_post ??
    // A callback_query (button click) carries its own nested message.
    (tg?.callback_query as { message?: Record<string, unknown> } | undefined)?.message) as
    | Record<string, unknown>
    | undefined;
  if (!msg) return { isTopicMessage: false };
  const rawThread = msg.message_thread_id;
  const threadId =
    typeof rawThread === 'number' || typeof rawThread === 'string'
      ? String(rawThread)
      : undefined;
  return { threadId, isTopicMessage: msg.is_topic_message === true };
}

/**
 * The id of the message a clicked button sits on, read off the raw update.
 *
 * Why this is needed: the Satori adapter sets `session.messageId = callback_query.id` on a click
 * (lib/index.cjs) — the id of the CALLBACK QUERY, not of any message. ButtonInteraction.messageId
 * is contractually the message the button is on, and every caller that edits or reacts to it needs
 * that. Feeding it a callback_query id makes editMessageText / setMessageReaction fail with a 400
 * the callers swallow, so a picker click produced no visible change at all — the exact "I clicked
 * and nothing happened" symptom. The real id is one level down in the update Satori stashes via
 * setInternal('telegram', update).
 *
 * Returns undefined when the nested message is absent (very old callbacks, inline-mode queries),
 * so the caller falls back to whatever the session carried.
 */
export function rawCallbackMessageId(session: unknown): string | undefined {
  const tg = (session as { telegram?: Record<string, unknown> } | undefined)?.telegram;
  const cq = tg?.callback_query as { message?: { message_id?: unknown } } | undefined;
  const id = cq?.message?.message_id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
}

/**
 * Telegram's General/root topic id. A message in the root (outside any real topic) either
 * omits message_thread_id entirely or reports the General lane; treating General as a topic
 * would give the root its own conversation separate from the plain chat, splitting one
 * conversation in two. Applied to BOTH shapes below — it used to guard only the private-chat
 * branch, which was correct by accident (the adapter happens to report group General as
 * channel.id === chat.id) rather than by intent.
 */
const TELEGRAM_GENERAL_TOPIC_ID = '1';

/**
 * THE single Telegram conversation resolver: chat id, optional topic lane, kind.
 *
 * Replaces the previous quartet (isDirect / isThread / inboundChannelId / decodeChannelKey)
 * plus the `<chatId>:<topicId>` composite string they passed between them. Those could
 * disagree — and the topic id had to be re-derived at five encode sites and seventeen decode
 * sites, of which every one that was forgotten sent to the wrong place.
 *
 * Two inbound shapes, because the adapter reports them differently:
 *  - group forum: `guild.id` is the chat and `channel.id` is the BARE message_thread_id, so
 *    the chat must be recovered from guildId — echoing channel.id back would address a
 *    nonexistent chat.
 *  - private-chat topic (Bot API 9.4): `channel.id` is the chat and there is no guild at all;
 *    the raw update (rawTopicFields) is the only witness that a topic exists.
 */
export function telegramConversation(session: {
  guildId?: string;
  channelId?: string;
  isDirect?: boolean;
}): ResolvedConversation {
  const { threadId, isTopicMessage } = rawTopicFields(session);
  const inTopic = isTopicMessage && threadId != null && threadId !== TELEGRAM_GENERAL_TOPIC_ID;

  // Group forum topic: guildId holds the chat, channelId the bare topic id.
  if (session.guildId && session.channelId && session.guildId !== session.channelId && !session.isDirect) {
    return {
      channel: session.guildId,
      thread: session.channelId,
      space: session.guildId,
      kind: 'thread',
    };
  }

  const channel = session.channelId ?? '';
  // Private-chat topic: the chat id is already channelId; the lane comes off the raw update.
  if (inTopic && session.guildId == null) {
    return { channel, thread: threadId, kind: 'thread' };
  }
  // Plain group or chat root.
  return {
    channel,
    ...(session.guildId ? { space: session.guildId } : {}),
    kind: session.isDirect === true ? 'direct' : 'group',
  };
}

/**
 * Telegram reactions are limited to a fixed allow-set (setMessageReaction's reaction[].emoji only
 * accepts the emoji listed in the Bot API docs). Lifecycle ✅/❌ are not in the set, so map them
 * to the nearest allowed emoji. Unmapped emoji pass through and are rejected by the Bot API
 * (swallowed by inbound-merger's safeReaction try/catch, no crash). Pure, for unit testing.
 */
export function mapTelegramReactionEmoji(emoji: string): string {
  const TG_REACTION_FALLBACK: Record<string, string> = {
    '✅': '👌', // lifecycle "done" -> nearest allowed emoji
    '❌': '👎', // lifecycle "fail" -> nearest allowed emoji
    // 👀 is already in Telegram's allow-set, so it passes through unmapped.
  };
  return TG_REACTION_FALLBACK[emoji] ?? emoji;
}

/**
 * Telegram's 429, as the core understands it.
 *
 * Telegram answers a flood with `{ok:false, error_code:429, description:"Too Many Requests: retry
 * after 229", parameters:{retry_after:229}}`. The structured field is the one you would want — and
 * it is exactly the one that does not survive.
 *
 * HYRUM'S LAW. `@satorijs/adapter-telegram/lib/index.cjs:74-78` (v3.x, read 2026-09-09) rethrows a
 * BRAND-NEW `Error` with no `cause`:
 *
 *   throw new Error(`Telegram API error ${response.data.error_code}. ${response.data.description}`)
 *
 * `parameters.retry_after` is discarded there, so the only surviving witness to the number is the
 * description text Telegram happens to repeat it in. Hence the regex over `.message`, which is
 * parsing a string no one promised to keep stable. `telegram.contract.test.ts` drives the real
 * adapter wrapper against Telegram's actual 429 envelope so an upgrade that reformats the message
 * (or, better, starts preserving the field) fails loudly instead of silently reverting the daemon
 * to a blind 10 s backoff against a 229 s wait.
 *
 * Only 429 maps. A 400 (MESSAGE_TOO_LONG, "chat not found") must pass through untouched: typing a
 * permanent failure as a rate limit turns a loud one-time error into a silent retry loop.
 */
function classifyTelegramError(e: unknown): unknown {
  for (const err of collectErrors(e)) {
    const text = err instanceof Error ? err.message : '';
    if (!/Telegram API error 429\b/.test(text)) continue;
    // Seconds in the description; absent on the rare 429 that states no wait, which still maps —
    // "this is a rate limit" is actionable on its own, and the caller falls back to its backoff.
    const m = /retry after (\d+)/i.exec(text);
    return new RateLimitedError(text, {
      retryAfterMs: m ? Number(m[1]) * 1000 : undefined,
      cause: e,
    });
  }
  return e;
}

/**
 * Telegram profile instance. Selected by createSatoriAdapter per cfg.platform.type.
 */
export function createTelegramProfile(): PlatformProfile<TelegramPlatformConfig> {
  // reaction: adapter doesn't wrap setMessageReaction, but bot.http is exposed, so the profile
  //   POSTs raw http; emoji are mapped to the allow-set via mapTelegramReactionEmoji.
  // thread: Telegram topic (group forum or private chat). A topic isn't a standalone channelId
  //   but a `chat + message_thread_id` pair, carried in talkcode's single-channelId model
  //   via the composite `<chatId>:<topicId>` (built by topicAwareChannelId, read by decodeChannel).
  // maxMessageLength=4096 (Telegram's real limit, counted on the ENTITY-PARSED visible text; HTML
  // tags do NOT count). renderTelegramMarkdown can expand the visible length (table -> bullets,
  // ~1.4x), which previously overflowed because chunking ran on raw chars. measureRendered (below)
  // reports the true visible length so the StreamBuffer chunks against the real 4096 with no headroom hack.
  const capabilities: PlatformCapabilities = {
    editMessage: true,
    reaction: true,
    typing: true,
    maxMessageLength: 4096,
    reply: true,
    thread: true,
    // createForumTopic names a topic without posting, so a scheduled run with no message can use
    // one — in a forum supergroup. An ordinary group or a DM refuses at run time, which is the
    // only place that is knowable; see PlatformCapabilities.standaloneThread.
    standaloneThread: true,
    // editForumTopic is in the adapter's Internal allow-list, and the bot is already a forum admin
    // wherever it can create topics. Renaming still fails in a non-forum chat — renameThread
    // refuses a thread-less address before the API call, and the caller treats any rejection as
    // "leave the name alone" rather than an error worth surfacing.
    renameThread: true,
    buttons: true,
    editButtons: true, // editMessageText carries reply_markup, so a menu can advance in place
    // One button per row (see sendComposite), so a page costs `size + 2` rows of screen — the
    // inline keyboard itself has no limit worth reaching. Twelve keeps a menu to fourteen rows,
    // about one phone screen with a flick, and puts a workspace of ten projects on a single page:
    // `/cd` exists to answer "which project is this topic about", and paging to find the answer is
    // the thing that made it tiresome.
    menuPageSize: 12,
    slashCommands: true,
    maxSlashCommands: 100, // Telegram setMyCommands limit (names allow only [a-z0-9_], see registerCommands)
  };

  return {
    type: 'telegram',
    satoriPlatform: 'telegram',
    capabilities,

    classifyError: classifyTelegramError,

    // Telegram counts the entity-parsed visible text; table→bullets rendering can expand it, so the
    // chunker must measure the rendered visible length, not the raw markdown char count.
    measureRendered: telegramVisibleLength,

    install(ctx, platform) {
      // TelegramBot.inject=['http'] (even for polling): http service must be provided first, or
      // cordis silently stalls the telegram plugin and never instantiates the bot (no bot, no error).
      installHttpService(ctx);
      // Before the adapter plugin, whose bot it hooks as it is created: without it one failed getMe
      // at startup leaves this instance offline until the next restart (telegram-start-retry.ts).
      installTelegramStartRetry(ctx, platform.id);

      // protocol 'polling' avoids needing a public selfUrl. slash forwards platform.slash;
      // when false, updateCommands returns immediately.
      ctx.plugin(resolveDefaultPlugin(TelegramAdapter), {
        protocol: 'polling',
        token: platform.token,
        slash: platform.slash,
      });
    },

    detectMention(session, selfId) {
      // Telegram has two mention forms (see adapter utils decodeMessage/parseText):
      //  1) @botusername (mention entity) -> h('at',{name}) with no id; match at.name === bot.user.name.
      //  2) text_mention entity -> h('at',{id,name}); match id===selfId.
      // Replying to the bot's own message (session.quote.user.id === selfId) also counts.
      // selfId is the numeric prefix of the token (bot.selfId); bot.user.name is the username.
      const botName = (session.bot?.user as { name?: string } | undefined)?.name;

      const quoteUserId = (session.quote?.user as { id?: string } | undefined)?.id;
      if (selfId && quoteUserId && quoteUserId === selfId) return true;

      const elements = session.elements;
      if (!elements) return false;
      for (const node of elements) {
        if (node.type !== 'at') continue;
        const atId = node.attrs?.id as string | undefined;
        const atName = node.attrs?.name as string | undefined;
        if (selfId && atId && atId === selfId) return true; // text_mention path
        if (botName && atName && atName === botName) return true; // @username path
      }
      return false;
    },

    resolveConversation(session) {
      return telegramConversation(session);
    },

    attachmentMeta() {
      // Telegram element attrs come from $getFileFromId, which gives only a temporary src
      // (+ document filename) with NO mime/size. Return empty; the download/inject layer falls
      // back to HTTP content-type and extension.
      return {};
    },

    async reply(bot, ref, text) {
      // reply_to_message_id = Telegram's native quoted reply. Routed through sendComposite (not
      // sendForRef) so a reply inside a forum topic keeps its message_thread_id — via the adapter
      // the composite key would land as chat_id and be rejected.
      return sendComposite(bot, ref.address, text, { replyToMessageId: ref.messageId });
    },

    async createThread(bot, ref, name) {
      // createForumTopic returns an already-unwrapped ForumTopic { message_thread_id, ... }.
      // Forum topics work ONLY in topic-enabled supergroups; normal groups/DMs are rejected by the
      // Bot API (throws), and the upstream autoThread catches and falls back. There is no
      // startThreadFromMessage semantics, so the topic is built from chat_id alone.
      //
      // `ref.address.channel` is always the real chat, even when the caller is already inside a
      // topic — the lane lives in its own field now. Under the old composite scheme this method
      // was the one path that never decoded, so an agent running `create-thread` from inside a
      // topic sent `chat_id: "-100123:99"` (400 in a group, silent truncation in a DM) and
      // returned the malformed triple `-100123:99:5`.
      const internal = bot.internal as unknown as TelegramInternal;
      const topic = await internal.createForumTopic({ chat_id: ref.address.channel, name });
      const topicId = topic?.message_thread_id;
      if (topicId == null) {
        throw new Error(`[telegram] createForumTopic did not return a message_thread_id (chat=${ref.address.channel})`);
      }
      return { address: { channel: ref.address.channel, thread: String(topicId) } };
    },

    async renameThread(bot, address, name) {
      // Only a real topic lane has a name. The General/root lane is not a topic the Bot API will
      // rename (and the resolver never reports it as one — see TELEGRAM_GENERAL_TOPIC_ID), and a
      // thread-less address is the chat itself, whose title is emphatically not ours to change.
      if (!address.thread || address.thread === TELEGRAM_GENERAL_TOPIC_ID) {
        throw new Error(
          `[telegram] renameThread needs a forum topic; got thread=${JSON.stringify(address.thread)} (channel=${address.channel})`
        );
      }
      const trimmed = truncateForTopicName(name);
      if (!trimmed) {
        // The Bot API reads an empty `name` as "keep the current one", so sending it would report
        // success while changing nothing — a silent no-op is worse than a refusal here.
        throw new Error(`[telegram] renameThread was given a blank name (channel=${address.channel})`);
      }
      const internal = bot.internal as unknown as TelegramInternal;
      await internal.editForumTopic({
        chat_id: address.channel,
        message_thread_id: topicIdOf(address),
        name: trimmed,
      });
    },

    async sendMessage(bot, address, text) {
      // Outbound override: special handling only when channelId is composite `<chatId>:<topicId>` --
      // decode message_thread_id and send into the topic via internal.sendMessage (which returns an
      // already-unwrapped Message). The returned ref uses the REAL chatId (non-composite), so later
      // edit/react on topic messages (which only need chat_id+message_id) take the generic path.
      // Non-composite channelId falls back to the generic bot.sendMessage, taking the first id.
      // Both the plain and forum-topic paths post via raw internal.sendMessage with a pre-rendered
      // Telegram-HTML string + parse_mode=HTML. We deliberately bypass the Satori MessageEncoder here
      // so that send and edit produce byte-identical output: the adapter's editMessage stringifies the
      // fragment (h.normalize(content).join('')) instead of visiting it — that path leaks Satori-only
      // tags (<br/>, <code-block>) as literal HTML and drops newlines after a closing tag, both of
      // which Telegram rejects/garbles. Rendering to HTML ourselves (fragmentToTelegramHtml) and editing
      // via internal.editMessageText keeps the streaming first-send and subsequent-edits consistent.
      return sendComposite(bot, address, text);
    },

    async sendFile(bot, address, file) {
      // Override exists because the generic encoder reads message_thread_id off the INBOUND
      // session, which an outbound-only send has none of — so a file could never reach a topic
      // that way. Upload multipart exactly as the adapter does (internal.sendDocument with an
      // `attach://` reference), adding the lane explicitly.
      //
      // Fields are appended only when present: FormData stringifies undefined to the literal
      // "undefined", which Telegram rejects.
      const internal = bot.internal as unknown as TelegramInternal;
      const name = file.name ?? path.basename(file.path);
      const data = await readFile(file.path);
      const form = new FormData();
      form.append('chat_id', address.channel);
      if (address.thread != null) form.append('message_thread_id', String(topicIdOf(address)));
      if (file.caption) {
        form.append('caption', fragmentToTelegramHtml(renderTelegramMarkdown(file.caption)));
        form.append('parse_mode', 'HTML');
      }
      form.append('document', `attach://${name}`);
      form.append(name, new Blob([new Uint8Array(data)]), name);
      const msg = await internal.sendDocument(form);
      const messageId = msg?.message_id;
      if (messageId == null) {
        throw new Error(`[telegram] sendFile did not return a message id (channel=${address.channel})`);
      }
      return { address, messageId: String(messageId) };
    },

    async addReaction(bot, ref, emoji) {
      // adapter doesn't define setMessageReaction (internal is a fixed allow-list), so hit raw http.
      // bot.http's base is already the Bot API root, hence the '/setMessageReaction' path. emoji is
      // mapped to the allow-set; anything still unaccepted is rejected by the API (swallowed by the
      // upstream safeReaction). message_id must be numeric. Defensive decode: ref.channelId should
      // already be the real chatId, but decoding is safe if a composite key arrives.
      const mapped = mapTelegramReactionEmoji(emoji);
      const http = (bot as unknown as { http: TelegramHttp }).http;
      await http.post('/setMessageReaction', {
        chat_id: ref.address.channel,
        message_id: Number(ref.messageId),
        reaction: [{ type: 'emoji', emoji: mapped }],
      });
    },

    async removeReaction(bot, ref, _emoji) {
      // Telegram has no "remove by emoji" semantics: setMessageReaction with an empty array clears
      // all of this bot's reactions. Hence _emoji is ignored (signature matches profile.ts / lark).
      const http = (bot as unknown as { http: TelegramHttp }).http;
      await http.post('/setMessageReaction', {
        chat_id: ref.address.channel,
        message_id: Number(ref.messageId),
        reaction: [],
      });
    },

    async editMessage(bot, ref, text) {
      // Edit via raw internal.editMessageText with a pre-rendered Telegram-HTML string, mirroring
      // sendMessage. We avoid bot.editMessage (Satori's generic edit) because it stringifies the
      // fragment without visiting it, leaking Satori-only tags (<br/>, <code-block>) and dropping
      // newlines after closing tags. Defensive decode in case ref.channelId is a composite key
      // (normally sendMessage already returns the real chatId).
      const internal = bot.internal as unknown as TelegramInternal;
      await internal.editMessageText({
        chat_id: ref.address.channel,
        message_id: Number(ref.messageId),
        text: fragmentToTelegramHtml(renderTelegramMarkdown(text)),
        parse_mode: 'HTML',
      });
    },

    async sendButtons(bot, address, text, buttons) {
      // THE reported bug: this used sendForRef -> bot.sendMessage, so the composite key reached
      // the adapter as a literal chat_id (see sendComposite for the two ways Telegram then
      // mishandles it — silent chat-root delivery in a DM, hard 400 in a group). Either way the
      // options never appeared in the topic that asked for them. Now posted through the same
      // decoding path as every other send, with the inline keyboard attached.
      return sendComposite(bot, address, text, { buttons });
    },

    async editButtons(bot, ref, text, buttons) {
      // Same payload as sendComposite's keyboard, on the edit endpoint. Deliberately NOT routed
      // through sendComposite: editing addresses a message, and the Bot API's edit endpoints take
      // no message_thread_id — the lane is already fixed by the message being edited.
      const internal = bot.internal as unknown as TelegramInternal;
      await internal.editMessageText({
        chat_id: ref.address.channel,
        message_id: Number(ref.messageId),
        text: fragmentToTelegramHtml(renderTelegramMarkdown(text)),
        parse_mode: 'HTML',
        reply_markup: {
          // One button per row, matching sendComposite: labels are long and Telegram squeezes a
          // shared row into unreadable slivers. Sent even when empty — that is what clears them.
          inline_keyboard: buttons.map((b) => [
            { text: b.label, callback_data: encodeCallbackData(b.id) },
          ]),
        },
      });
    },

    async typing(bot, address) {
      // internal.sendChatAction auto-expires after ~5s with no stop (core's stopTyping is a no-op).
      // channelId may be composite (topic case), so decode and use the real chatId plus
      // message_thread_id; otherwise typing lands on the wrong chat or misses the topic.
      const internal = bot.internal as
        | {
            sendChatAction?: (payload: {
              chat_id: string;
              action: string;
              message_thread_id?: number;
            }) => Promise<unknown>;
          }
        | undefined;
      await internal?.sendChatAction?.({
        chat_id: address.channel,
        action: 'typing',
        ...(address.thread != null ? { message_thread_id: topicIdOf(address) } : {}),
      });
    },

    async registerCommands(ctx, getBot, cmds) {
      // setMyCommands registration (global; Telegram commands have no guild-level scope, so
      // opts.guildId is ignored). Defer until login via deferUntilLogin. Telegram has no selfId
      // prerequisite (updateCommands doesn't need application_id), so the default isReady applies.
      const universalCmds = specsToTelegramCommands(cmds);
      deferUntilLogin(ctx, getBot, async (bot) => {
        try {
          // bot.updateCommands -> internal.setMyCommands (gated by config.slash).
          await bot.updateCommands(universalCmds);
        } catch (e) {
          console.error('[slash] telegram registration failed:', e instanceof Error ? e.message : e);
        }
      });
    },

    mountButtonEvents(ctx, emit) {
      // callback_query -> 'interaction/button'; adapter auto-answers the callback query.
      // session.event.button.id === callback_data (the encodeCallbackData'd id from send).
      // The SAME resolver as the message path, so a click inside a forum topic resolves to the
      // conversation that posted the buttons — otherwise a blocking `ask` never matches its
      // pending request and sits until timeout.
      // messageIdOf: the adapter puts the CALLBACK QUERY id in session.messageId, which is not a
      // message id at all — see rawCallbackMessageId.
      mountSatoriButtonInteraction(ctx, telegramConversation, emit, {
        messageIdOf: rawCallbackMessageId,
      });
    },

    mountCommandEvents(ctx, emit) {
      // /cmd@bot args -> 'interaction/command'; the adapter rewrites session.content to
      // `command + rest` with NO structured argv.options. So split from content ourselves:
      // first token is the command name, the rest become positional { arg0, arg1, ... } (no
      // named schema available).
      ctx.on('interaction/command', (session: Session) => {
        const content = (session.content ?? '').trim();
        if (!content) return;
        const parts = content.split(/\s+/);
        const name = parts[0];
        if (!name) return;
        const rest = parts.slice(1);
        const options: Record<string, unknown> = {};
        rest.forEach((v, i) => {
          options[`arg${i}`] = v;
        });
        // raw text after the command name, for upstream whole-string parsing.
        options.raw = content.slice(name.length).trim();

        // Telegram slash is just a normal message, no followup token, so reply straight to the
        // channel. (This Satori version's Session has no .send; use bot.sendMessage.)
        const bot = session.bot;
        // Same resolver as the message path: a `/cmd` sent inside a forum topic arrives with the
        // bare topic_id in channel.id, so without this the receipt (and the routed message) would
        // land in the group's General channel instead of the topic.
        const conversation = telegramConversation(session);
        emit({
          conversation,
          user: session.userId ?? '',
          messageId: session.messageId ?? '',
          name,
          options,
          reply: (text: string) =>
            sendComposite(bot, { channel: conversation.channel, ...(conversation.thread != null ? { thread: conversation.thread } : {}) }, text).then(() => undefined),
        });
      });
    },
  };
}
