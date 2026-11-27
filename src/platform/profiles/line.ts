// LINE platform profile (PlatformProfile). Imports from @satorijs/core (same as
// discord) since adapter-line is built on it.
//
// LINE is essentially a push-only one-way channel: no editMessage / reaction /
// history / native reply / thread. Available: push text/image/file/sticker +
// buttons template (postback send+receive loop) + typing (loading bubble, 1:1 DM
// only).
//
// —— Webhook inbound prerequisites (important) ——
// adapter-line is webhook-inbound (LineBot.inject = ['server','http']):
//   1. A `server` service (@cordisjs/plugin-server) must exist first, listening
//      on a port for LINE callbacks.
//   2. server must set `selfUrl` (public-facing address): the adapter registers
//      the webhook as `selfUrl + '/line'` and proxies inbound media as
//      `<selfUrl>/line/assets/...`. If selfUrl is undefined these silently become
//      "undefined/line" (adapter warns, doesn't throw), pointing the webhook at
//      garbage and breaking media proxy ⇒ this profile fail-fasts in install
//      rather than tolerate that silent "undefined/line" degradation.
//   3. Must be publicly reachable (LINE POSTs to it) — unlike Discord's
//      pure-WebSocket outbound, local-only runs receive no inbound.
import { h } from '@satorijs/core';
import LineAdapter from '@satorijs/adapter-line';
import type { Session } from '@satorijs/core';

import type { Bot } from '@satorijs/core';

import type { PlatformCapabilities } from '../adapter.js';
import { flattenMarkdown } from '../plaintext-markdown.js';
import type { PlatformProfile } from '../profile.js';
import type { LinePlatformConfig } from '../../config/platform-schemas.js';
import {
  buildButtonMessageFragment,
  installHttpService,
  installServerService,
  mountSatoriButtonInteraction,
  plainConversation,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * Flatten agent CommonMark to clean plain text before delivery. LINE renders no
 * markdown — `**bold**`, table pipes and `#` headings would show as literal noise —
 * so every outbound text path (sendMessage / reply / sendButtons) routes through
 * this. Wrapped in try/catch: a flattener bug must never drop the message, so on any
 * error we degrade gracefully to the raw text (worst case: the user sees the markers,
 * same as before this flattener existed).
 */
function toPlainText(text: string): string {
  try {
    return flattenMarkdown(text);
  } catch {
    return text;
  }
}

/**
 * replyToken cache TTL. LINE replyToken is single-use + ~1 min validity; use 55s
 * for margin. Like qq.ts's MSG_TIMEOUT: passive reply has a time window.
 */
const REPLY_TOKEN_TTL_MS = 55 * 1000;

/** A cached replyToken: token text + write timestamp (for expiry). */
interface CachedReplyToken {
  token: string;
  ts: number;
}

/**
 * Minimal LINE replyMessage request body (POST /v2/bot/message/reply). Hand-typed
 * + narrowed on bot.internal to avoid a hard dependency on adapter internal types
 * (we only consume sentMessages[0].id).
 */
interface LineReplyMessageRequest {
  replyToken: string;
  messages: Array<{ type: 'text'; text: string }>;
}
interface LineInternal {
  replyMessage(body: LineReplyMessageRequest): Promise<{ sentMessages?: Array<{ id?: string }> }>;
}

/**
 * LINE profile. Selected by createSatoriAdapter via cfg.platform.type.
 *
 * Adapter facts (verified against @satorijs/adapter-line@2.5.0 source):
 * - bot.platform = 'line'.
 * - Config: token (channel access token, required), secret (channel secret for
 *   webhook signature, required), api/content (HTTP base, optional).
 * - Encoder only uses pushMessage (max 5 messages/request); buttons get bundled
 *   4-per-template/buttons. No editMessage/deleteMessage/createReaction/history.
 * - Inbound: source.type==='user' ⇒ isDirect=true; postback ⇒
 *   session.type='interaction/button', button={id: postback.data}.
 * - Default <button id> ⇒ {type:'postback',data:id}; click returns postback with
 *   button.id===data ⇒ id loop closes ⇒ buttons=true.
 */
export function createLineProfile(): PlatformProfile<LinePlatformConfig> {
  // LINE one-way-channel capabilities:
  // - editMessage=false: no edit ⇒ streaming re-sends whole segments. push is
  //   billed per message, so core's noEdit collapses output toward 1 message;
  //   StreamBuffer should use much larger chunks on LINE (not controlled here).
  // - reaction=false: no bot-reaction API.
  // - typing=true: adapter doesn't wrap LINE's loading API, but bot.http is
  //   public so the profile calls it directly. 1:1 DM only (group/room no-op).
  // - reply=true (★constrained★): LINE passive reply uses the webhook event's
  //   replyToken (single-use, ~1 min, only for the just-received context). The
  //   outbound encoder only uses pushMessage and can't see replyToken, so install
  //   hooks ctx.on('message') to cache channelId→replyToken in an instance Map;
  //   reply() looks up a valid token and uses internal.replyMessage, deleting it
  //   after. Outside the window / no token ⇒ fall back to push (billed, quota).
  //   That's the point of caching: passive reply is free, push costs quota (same
  //   idea as qq.ts caching the passive msg_id).
  // - thread=false: LINE has no threads.
  // - buttons=true: buttons template / quick reply postback, id=postback.data.
  // - slashCommands=false: no slash (rich menu not normalized).
  // - maxMessageLength=5000: LINE text limit.
  const capabilities: PlatformCapabilities = {
    editMessage: false,
    reaction: false,
    typing: true,
    maxMessageLength: 5000,
    reply: true, // passive reply on replyToken hit, else push fallback (see reply())
    thread: false,
    buttons: true,
    // LINE has no message-edit API at all (editMessage above is false for the same reason), so a
    // posted menu can never be advanced in place — and unlike QQ there is no delete to fall back
    // on either. Callers degrade to a text answer.
    editButtons: false,
    slashCommands: false,
  };

  // replyToken cache (held in this profile instance's closure).
  // key = channelId (1:1 == userId; group/room == group/room id), value={token,ts}.
  // Single-use + ~1min TTL: used only if present and fresh, deleted after use.
  // A new message in the same context overwrites the old token (safe to drop).
  const replyTokens = new Map<string, CachedReplyToken>();

  /** Take a still-fresh replyToken; on expiry clear it and return undefined. */
  const takeReplyToken = (channelId: string): string | undefined => {
    const hit = replyTokens.get(channelId);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > REPLY_TOKEN_TTL_MS) {
      replyTokens.delete(channelId); // expired: clean up to bound Map growth
      return undefined;
    }
    return hit.token;
  };

  return {
    type: 'line',
    satoriPlatform: 'line',
    capabilities,

    // LINE sends the flattened plain text; table→bullets can expand it, so chunk by the flattened
    // length, not the source markdown.
    measureRendered: (text: string) => toPlainText(text).length,

    install(ctx, platform) {
      // Typed config (config/platform-schemas.ts): token (channel access token), secret
      // (channel secret, webhook signature) and selfUrl are all schema-required —
      // the adapter only warns on a missing selfUrl but registers "undefined/line"
      // and breaks media, so the schema fails fast instead.
      // Webhook server (adapter-line inject=['server','http']): provide server
      // first or cordis silently suspends the line plugin. selfUrl must be public
      // (LINE POSTs to <selfUrl>/line; also used for media proxy).
      installServerService(ctx, {
        host: platform.host,
        port: platform.port,
        selfUrl: platform.selfUrl,
      });

      // LineBot.inject also needs 'http' (outbound pushMessage / bot info).
      installHttpService(ctx);

      // token + secret required; api/content use adapter defaults.
      ctx.plugin(resolveDefaultPlugin(LineAdapter), {
        token: platform.token,
        secret: platform.secret,
      });

      // Inbound hook: cache replyToken for passive reply. The adapter stores the
      // raw webhook event at session.event._data; message events carry replyToken
      // at the body's top level. Only message events are cached (postback/follow
      // have no usable reply token / wrong semantics).
      ctx.on('message', (session: Session) => {
        if (session.platform !== 'line') return;
        const channelId = session.channelId;
        if (!channelId) return;
        const data = session.event?._data as { replyToken?: string } | undefined;
        const token = data?.replyToken;
        if (typeof token !== 'string' || token.length === 0) return;
        replyTokens.set(channelId, { token, ts: Date.now() });
      });
    },

    detectMention() {
      // LINE @-normalization only carries a display-name fragment (no userId/
      // botId), so there's no selfId to compare ⇒ can't reliably tell if the bot
      // was mentioned. Always false (prefer missing over false positives).
      return false;
    },

    resolveConversation(session) {
      // LINE has no thread concept; isDirect = (source.type==='user'), group/room otherwise.
      return plainConversation(session);
    },

    attachmentMeta() {
      // Inbound media becomes a `<selfUrl>/line/assets/...` proxy URL; attrs carry
      // only url, no mime/size ⇒ return {}, download layer uses HTTP content-type.
      return {};
    },

    async sendMessage(bot, address, text) {
      // Outbound send override: flatten CommonMark → plain text first (LINE shows
      // markup literally), then defer to the generic push tail. Without this the
      // generic path would push the raw markdown verbatim.
      return sendForRef(bot, address, toPlainText(text), 'line', 'sendMessage');
    },

    async reply(bot, ref, text) {
      // Flatten once: LINE renders no markdown, so both the passive-reply and the
      // push-fallback branch below must send clean plain text.
      const plain = toPlainText(text);
      // Passive reply: look up a still-valid replyToken for ref.channelId.
      // - Hit: internal.replyMessage (free, off-quota). Single-use ⇒ delete after,
      //   even on error (the token is consumed/stale, retrying only fails again).
      // - Miss (no/expired/used token): LINE has no native reply to an arbitrary
      //   context, so fall back to push (bot.sendMessage, billed + quota). Chosen
      //   over throwing: semantically still delivers the text; cost is push quota
      //   (the very reason replyToken is preferred).
      //
      // Both paths tolerate a missing message id (empty string). LINE downstream
      // doesn't consume messageId (no edit/reaction), so the fallback also skips
      // sendForRef's "no id ⇒ throw", matching the hit path's leniency.
      const token = takeReplyToken(ref.address.channel);
      if (token) {
        replyTokens.delete(ref.address.channel); // single-use: consume regardless of outcome
        const internal = (bot as Bot & { internal: LineInternal }).internal;
        const res = await internal.replyMessage({
          replyToken: token,
          messages: [{ type: 'text', text: plain }],
        });
        // LINE occasionally omits the id ⇒ fall back to empty string.
        const messageId = res?.sentMessages?.[0]?.id ?? '';
        return { address: ref.address, messageId };
      }
      // Fallback: push to the context. Not via sendForRef (which throws on missing
      // first id); take first id manually, empty on miss, matching the hit path.
      const ids = await bot.sendMessage(ref.address.channel, plain);
      return { address: ref.address, messageId: ids[0] ?? '' };
    },

    async sendButtons(bot, address, text, buttons) {
      // buttons template (degraded form): default <button> ⇒
      // {type:'postback', data:id}, click returns postback. On flush, buttons are
      // bundled into a separate "template/buttons" message (text fixed
      // 'Please select', 4-per-group), so the text arg becomes a separate text
      // block — no compact "text + same-message buttons" like Discord. Acceptable.
      // Each segment = 1 push (billed); text + button template ⇒ ≥2 pushes.
      const group = h(
        'button-group',
        {},
        buttons.map((b) => h('button', { id: b.id }, b.label))
      );
      return sendForRef(
        bot,
        address,
        buildButtonMessageFragment(toPlainText(text), group),
        'line',
        'sendButtons'
      );
    },

    async typing(bot, address) {
      // LINE loading animation accepts only a 1:1 user id; group/room always get
      // rejected. channelId comes from source id: 1:1 == userId ('U'), group 'C',
      // room 'R'. Cheap guard: only POST when channelId starts with 'U', else
      // return — avoids a doomed HTTP POST every typing interval. capabilities.
      // typing stays true (DM works); group/room is a no-op.
      if (!address.channel.startsWith('U')) return;
      // Adapter doesn't define this route ⇒ use raw bot.http. Failures are
      // swallowed (pure UX, must not break the turn).
      const http = (bot as { http?: { post?: (url: string, body: unknown) => Promise<unknown> } })
        .http;
      try {
        await http?.post?.('/v2/bot/chat/loading/start', {
          chatId: address.channel,
          loadingSeconds: 5,
        });
      } catch {
        // Transient/network error: pure UX, safely swallowed.
      }
    },

    mountButtonEvents(ctx, emit) {
      // postback click: session.type='interaction/button', button={id: postback.
      // data}, messageId = body.webhookEventId (LINE has no original message id).
      // No reply-token for postback ⇒ acks go via push. See
      // profile-helpers.ts mountSatoriButtonInteraction.
      mountSatoriButtonInteraction(ctx, plainConversation, emit);
    },
  };
}
