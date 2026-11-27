// QQ platform profile (PlatformProfile). Serves the QQ **guild** bot (qqguild),
// the closest of QQ's bots to Discord. Group/C2C (bot.platform==='qq') is not
// served: group bot lacks createReaction and group buttons need platform-approved
// markdown/button templates, so satoriPlatform is pinned to 'qqguild'.
//
// Adapter facts (verified against @satorijs/adapter-qq@4.13.0 source):
// - One QQAdapter plugin spawns **two** bots: 'qq' (QQBot: group/C2C) and
//   'qqguild' (QQGuildBot: channel events). satoriPlatform='qqguild' makes
//   ctx.bots.find pick only the guild sub-bot.
// - Guild sub-bot has createReaction/deleteReaction and single getMessage, but
//   **no getMessageList** — satori-core's getMessageIter throws
//   'not implemented: getMessageList', so any history call crashes at runtime.
//   This profile exposes no history capability; gate it at daemon/adapter level.
// - No in-place edit ⇒ editMessage=false ⇒ streaming re-sends whole segments.
//
// ★ Passive-reply constraint (the key limitation, see message.ts) ★
//   Most messages must be a "passive reply": carry the trigger message's msg_id,
//   with a time window — MSG_TIMEOUT = 5*60*1000 - 2000 (~5 min).
//   Note: msg_seq increment + per-msg_id segment quota is the **group** encoder's
//   logic; the **guild** encoder (QQGuildMessageEncoder) uses msg_id + optional
//   message_reference, no msg_seq / no segment quota — but is still bound by the
//   5-min MSG_TIMEOUT.
//   Consequences:
//   - editMessage=false collapses output to as few segments as possible (single
//     fits best); StreamBuffer is tuned accordingly.
//   - A turn over 5 min (long agent task) lets the passive window expire, so
//     trailing output may silently fail to send (encoder swallows the error).
//   - No active typing/progress bubble (no typing API) ⇒ typing=false.
import { h } from '@satorijs/core';
import QQAdapter, { QQ } from '@satorijs/adapter-qq';
import type { Bot } from '@satorijs/core';

import type { MessageRef } from '../../types.js';
import type { PlatformCapabilities } from '../adapter.js';
import { flattenMarkdown } from '../plaintext-markdown.js';
import type { PlatformProfile } from '../profile.js';
import type { QQPlatformConfig } from '../../config/platform-schemas.js';
import {
  attrAttachmentMeta,
  buildButtonMessageFragment,
  findAtMention,
  installHttpService,
  mountSatoriButtonInteraction,
  plainConversation,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * Flatten agent CommonMark to clean plain text before delivery. QQ's default
 * (non-sandbox) message rendering treats the body as plain text — native markdown
 * needs platform-approved templates this profile doesn't use — so `**bold**`, table
 * pipes and `#` headings would surface as literal noise. Every outbound text path
 * (sendMessage / reply / sendButtons) routes through this. Wrapped in try/catch so a
 * flattener bug degrades gracefully to the raw text rather than dropping the message.
 */
function toPlainText(text: string): string {
  try {
    return flattenMarkdown(text);
  } catch {
    return text;
  }
}

// Attachment meta (mime/size) shared with Discord — see profile-helpers.ts.
// QQ guild decodeAttachments rarely backfills content_type/mime/size on attrs,
// so it usually falls back to HTTP content-type and extension.

/**
 * unicode emoji → QQ guild reaction emojiId (`type:id`). Pure for testability.
 *
 * Hyrum: qqguild's createReaction splits emojiId via `emojiId.split(':')` into
 * the REST path `/reactions/{type}/{id}`. Passing raw unicode '👀' yields
 * `[type='👀', id=undefined]` ⇒ path `/reactions/👀/undefined`, rejected by QQ,
 * then silently swallowed by inbound-merger's safeReaction. Must map to a valid
 * `type:id` first.
 *
 * QQ Emoji model (types.ts EmojiType/Emoji):
 *   - SYSTEM=1: platform numeric codes, not derivable from unicode ⇒ not mapped.
 *   - DEFAULT=2: id **is the emoji char itself**.
 *   Inbound setupReaction backfills content as `${type}:${id}` too — same shape.
 *
 * Any standard unicode emoji maps safely to `2:<char>`. System emoji (type=1)
 * can't be guessed ⇒ unmapped returns undefined, upper layer safely skips.
 */
export function mapQQReactionEmoji(emoji: string): string | undefined {
  const QQ_REACTION_EMOJI: Record<string, string> = {
    // type=2 (emoji), id = emoji char itself.
    '👀': '2:👀',
    '✅': '2:✅',
    '❌': '2:❌',
    '👍': '2:👍',
    '👎': '2:👎',
    '❤️': '2:❤️',
    '🎉': '2:🎉',
    '🔥': '2:🔥',
    '🙏': '2:🙏',
    '👌': '2:👌',
  };
  return QQ_REACTION_EMOJI[emoji];
}

/**
 * Default gateway intents. The adapter provides no fallback (WsClient IDENTIFY
 * reads config.intents directly); unset ⇒ undefined ⇒ no events received, so
 * these must be explicit. By type:
 * - Common: GUILDS | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | INTERACTIONS
 *   (INTERACTIONS is required for the sendButtons click loop).
 * - Messages: public ⇒ PUBLIC_GUILD_MESSAGES (@-mentions only);
 *   private ⇒ GUILD_MESSAGES (all channel messages, private bots only).
 * User can fully override via options.intents (must include INTERACTIONS to keep
 * receiving button clicks).
 */
function defaultGuildIntents(type: 'public' | 'private'): number {
  const base =
    QQ.Intents.GUILDS |
    QQ.Intents.GUILD_MESSAGE_REACTIONS |
    QQ.Intents.DIRECT_MESSAGES |
    QQ.Intents.INTERACTIONS;
  return type === 'private'
    ? base | QQ.Intents.GUILD_MESSAGES
    : base | QQ.Intents.PUBLIC_GUILD_MESSAGES;
}

/**
 * QQ profile (serves the **qqguild** bot). Selected by createSatoriAdapter via
 * cfg.platform.type.
 *
 * Credentials/params (all from cfg.platform.options to avoid schema changes):
 *   options.id      string                 bot AppID (required)
 *   options.secret  string                 bot AppSecret (required). Used as
 *                                          clientSecret in getAppAccessToken;
 *                                          adapter@4.13.0 Config has no token/
 *                                          authType field, so secret ≠ platform
 *                                          token. Do NOT fall back to
 *                                          cfg.platform.token — that would use a
 *                                          token as clientSecret and fail auth.
 *   options.type    'public' | 'private'   bot type (required)
 *   options.sandbox boolean                sandbox (default false; allows native
 *                                          markdown/buttons without approval)
 *   options.intents number                 override gateway intents bitmask
 *   options.protocol 'websocket'|'webhook' default 'websocket' (no public callback)
 */
export function createQQProfile(): PlatformProfile<QQPlatformConfig> {
  // QQ guild capabilities (true only where the adapter truly supports it):
  // - editMessage=false: no in-place edit ⇒ streaming re-sends whole segments.
  // - reaction=true: only qqguild has createReaction/deleteReaction. Native
  //   methods expect emojiId as `type:id`, not raw unicode, so addReaction/
  //   removeReaction map first via mapQQReactionEmoji — else QQ rejects and the
  //   reaction silently fails.
  // - typing=false: no typing API, and each message costs seq quota.
  // - reply=true: <quote>+<passive> for message_reference passive reply.
  // - thread=false: QQ has no thread concept.
  // - buttons=true: button-group/button → markdown keyboard, click returns
  //   INTERACTION_CREATE with auto-ACK. Outbound sends via the qqguild sub-bot
  //   (satoriPlatform); inbound INTERACTION_CREATE arrives on the **parent qq
  //   bot** (see mountButtonEvents) — outbound/inbound platforms differ.
  // - slashCommands=false: no slash registration.
  // - maxMessageLength: conservative 1000. Adapter doesn't truncate; the limit
  //   is server-side and QQ counts **bytes** (CJK ~3 bytes/char, UTF-8), so 1000
  //   chars leaves CJK byte headroom for StreamBuffer to segment under the cap.
  const capabilities: PlatformCapabilities = {
    editMessage: false,
    reaction: true,
    typing: false,
    maxMessageLength: 1000,
    reply: true,
    thread: false,
    buttons: true,
    // QQ Guild exposes no message-edit endpoint (editMessage above is false), so buttons on a sent
    // message are final. Callers degrade to a text answer.
    editButtons: false,
    slashCommands: false,
  };

  return {
    type: 'qq',
    // Picks the qqguild sub-bot handle (ctx.bots.find by platform).
    satoriPlatform: 'qqguild',
    capabilities,

    // QQ sends the flattened plain text; table→bullets can expand it, so chunk by the flattened
    // length, not the source markdown.
    measureRendered: (text: string) => toPlainText(text).length,

    install(ctx, platform) {
      // QQBot.inject = { required: ['http'] }: http service must exist first, or
      // cordis silently suspends the qq plugin and never instantiates the bot.
      installHttpService(ctx);

      // Typed config (config/platform-schemas.ts): appId/secret/botType all schema-required.
      // secret is AppSecret (clientSecret for access_token), not a platform token.
      // intents: user override if given (must include INTERACTIONS for button
      // clicks), else default by botType.
      const intents = platform.intents ?? defaultGuildIntents(platform.botType);

      // One plugin spawns both qq + qqguild bots; satoriPlatform picks qqguild.
      ctx.plugin(resolveDefaultPlugin(QQAdapter), {
        id: platform.appId,
        secret: platform.secret,
        type: platform.botType,
        sandbox: platform.sandbox,
        intents,
        protocol: platform.protocol,
      });
    },

    detectMention(session, selfId) {
      // Both channel and group/C2C decode paths land mentions as type==='at'
      // nodes with attrs.id===selfId, so findAtMention's traversal suffices.
      return findAtMention(session.elements, selfId);
    },

    resolveConversation(session) {
      // QQ has no thread concept, and the adapter sets session.isDirect (C2C/channel-DM
      // true, group/public false), so the shared thread-less shape is exact.
      return plainConversation(session);
    },

    attachmentMeta(el) {
      // Shared attrs read (mime/size) with Discord — see profile-helpers.ts.
      return attrAttachmentMeta(el.attrs);
    },

    async sendMessage(bot, address, text) {
      // Outbound send override: flatten CommonMark → plain text (QQ renders no
      // markdown by default), then defer to the generic send tail. Without this the
      // generic path would send the raw markdown verbatim.
      return sendForRef(bot, address, toPlainText(text), 'qq', 'sendMessage');
    },

    async reply(bot, ref, text) {
      // Passive reply: satori-core calls reply without the trigger session, so
      // the encoder can't auto-grab the passive msg_id. Inject <passive> (encoder
      // reads it as the msg_id passive credential) + <quote> for native reference.
      // Still bound by the 5-min MSG_TIMEOUT — an expired trigger ⇒ send fails.
      // Flatten the body first: QQ shows markdown markers as literal text.
      return sendForRef(
        bot,
        ref.address,
        [
          h('passive', { messageId: ref.messageId }),
          h('quote', { id: ref.messageId }),
          h.text(toPlainText(text)),
        ],
        'qq',
        'reply'
      );
    },

    async addReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Override seam: the default fallback passes raw unicode to createReaction,
      // but qqguild expects `type:id` (split into the REST path), so unicode is
      // rejected. Map to `2:<emoji>` first. Unmapped ⇒ safe skip (best-effort).
      const emojiId = mapQQReactionEmoji(emoji);
      if (!emojiId) return;
      await bot.createReaction(ref.address.channel, ref.messageId, emojiId);
    },

    async removeReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Same as addReaction: map unicode→`type:id`, then deleteReaction.
      // Unmapped ⇒ safe skip.
      const emojiId = mapQQReactionEmoji(emoji);
      if (!emojiId) return;
      await bot.deleteReaction(ref.address.channel, ref.messageId, emojiId);
    },

    async sendButtons(bot, address, text, buttons) {
      // <button-group> wraps one row (max 5/row, encoder auto-wraps). A <button>
      // without type ⇒ action.type=1 (callback), data=id; click returns
      // INTERACTION_CREATE with button.id===id. class 'primary' ⇒ style=1, else 0.
      // button-group triggers useMarkdown=true.
      // Prod note: guild keyboard is lenient; extending to groups would require
      // platform-approved button templates.
      const group = h(
        'button-group',
        {},
        buttons.map((b) => h('button', { id: b.id, class: b.style ?? 'primary' }, b.label))
      );
      return sendForRef(
        bot,
        address,
        buildButtonMessageFragment(toPlainText(text), group),
        'qq',
        'sendButtons'
      );
    },

    mountButtonEvents(ctx, emit) {
      // Button clicks. The adapter auto-ACKs INTERACTION_CREATE; here we just
      // normalize "who clicked which button". messageId is unavailable
      // (INTERACTION_CREATE sets no session.messageId) ⇒ left as ''.
      // ★ botPlatform='qq' (not 'qqguild'): adaptSession whitelists
      //   INTERACTION_CREATE as "don't switch to guildBot", so the session lands
      //   on the **parent QQBot (platform='qq')**. Using 'qqguild' here would make
      //   every click get dropped. Only one QQ adapter runs in this process, so
      //   'qq' is both precise and safe.
      mountSatoriButtonInteraction(ctx, plainConversation, emit, { botPlatform: 'qq' });
    },

    // —— Omitted optional methods (capability off for each) ——
    // createThread: no thread concept (thread=false).
    // registerCommands/mountCommandEvents: no slash mechanism (slashCommands=false).
    // typing: no typing API, each costs seq quota (typing=false).
    // reaction add/remove are overridden above (mapQQReactionEmoji), since the
    //   default fallback would pass raw unicode and get it rejected/swallowed.
  };
}
