// WeCom (custom app) platform profile (PlatformProfile). Imports from
// @satorijs/core (same as discord.ts); adapter-wecom is built on it.
//
// ⚠️ The weakest platform here. Essentially "1:1 plain text (+image/file) +
// 24h recall":
//   - Inbound: always isDirect=true, channelId=userId=FromUserName, guildId=
//     corpId. **No group/multi-party context** (WeCom group bots are a separate
//     webhook this adapter doesn't cover).
//   - Outbound: app message push (app→user) via /cgi-bin/message/send.
//   - Recall (/cgi-bin/message/recall): only within 24h, only this app's
//     messages; reached via generic bot.deleteMessage ⇒ **no profile method needed**.
//   - editMessage / reaction / typing / history / reply / thread / buttons /
//     slash: none.
//
// Webhook inbound (WecomBot static inject = ['server','http']): **needs a public
// callback address**. The profile provides the http base; bot construction does
// ctx.http.extend(config) layering on baseURL 'https://qyapi.weixin.qq.com/', so
// outbound /cgi-bin/* keeps its baseURL. installHttpService is **required** —
// without it cordis silently suspends the wecom plugin (same as line.ts).
// HttpServer registers GET/POST '/wecom' (verify + decrypt) and
// '/wecom/assets/:self_id/:media_id' (media proxy). The WeCom admin "receive
// messages" config needs this callback URL (server.selfUrl + '/wecom'), Token,
// and EncodingAESKey, publicly reachable.
import { h } from '@satorijs/core';
import WecomAdapter from '@satorijs/adapter-wecom';
import type { PlatformCapabilities } from '../adapter.js';
import { flattenMarkdown } from '../plaintext-markdown.js';
import type { PlatformProfile } from '../profile.js';
import type { WecomPlatformConfig } from '../../config/platform-schemas.js';
import {
  installHttpService,
  installServerService,
  plainConversation,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * Flatten agent CommonMark to clean plain text before delivery. WeCom app messages
 * render no markdown — `**bold**`, table pipes and `#` headings would surface as
 * literal noise — so the one outbound path (sendMessage) routes through this.
 * Wrapped in try/catch so a flattener bug degrades gracefully to the raw text rather
 * than dropping the message.
 */
function toPlainText(text: string): string {
  try {
    return flattenMarkdown(text);
  } catch {
    return text;
  }
}

export function createWecomProfile(): PlatformProfile<WecomPlatformConfig> {
  // WeCom is almost fully degraded — declared honestly:
  //   editMessage=false  → no in-place edit; streaming re-sends whole segments.
  //   reaction=false     → no bot-reaction API.
  //   typing=false       → no typing indicator.
  //   reply=false        → app messages have no native "reply to one".
  //   thread=false       → no thread concept.
  //   buttons=false      → encoder has no <button> handling; can't send/receive
  //                        clicks. clarify(ask) therefore throws at the daemon
  //                        (buttons=false ⇒ throw, **no text fallback**); ask just
  //                        fails on WeCom — callers must use a plain question.
  //   slashCommands=false→ no slash.
  // Only sendMessage and deleteMessage (24h recall, generic bot method) work.
  // maxMessageLength: text limit ~2048 bytes, conservative 2000. StreamBuffer
  // should merge aggressively here (ideally 1-2 messages) to avoid rate limits.
  const capabilities: PlatformCapabilities = {
    editMessage: false,
    reaction: false,
    typing: false,
    maxMessageLength: 2000,
    reply: false,
    thread: false,
    buttons: false,
    editButtons: false, // no buttons to edit
    slashCommands: false,
  };

  return {
    type: 'wecom',
    satoriPlatform: 'wecom', // WecomBot fixes platform = 'wecom'.
    capabilities,

    // WeCom's text limit is in UTF-8 BYTES (~2048), not chars — a CJK char is 3 bytes. Measure the
    // flattened text's byte length so maxMessageLength (2000) is enforced as bytes and CJK-heavy
    // messages don't overflow.
    measureRendered: (text: string) => Buffer.byteLength(toPlainText(text), 'utf8'),

    install(ctx, platform) {
      // Typed config (config/platform-schemas.ts): corpId/agentId/secret/token/aesKey/selfUrl
      // are all schema-required. aesKey isn't adapter-Schema-required, but callback
      // decryption needs it — the schema fails early rather than crash at inbound
      // decrypt (stricter than the adapter, same as the old profile check).

      // WecomBot static inject = ['server','http'] → both services must exist
      // first, else cordis silently suspends the wecom plugin. server provides the
      // public callback (selfUrl), also used for media proxy URLs.
      // ⚠️ selfUrl must be publicly reachable by WeCom; callback path is '<selfUrl>/wecom'.
      installServerService(ctx, {
        host: platform.host,
        port: platform.port,
        selfUrl: platform.selfUrl,
      });
      installHttpService(ctx);

      // agentId is also selfId. HTTP baseURL defaults to qyapi.weixin.qq.com via
      // the adapter, layered on at construction — no profile pass-through needed.
      ctx.plugin(resolveDefaultPlugin(WecomAdapter), {
        corpId: platform.corpId,
        agentId: platform.agentId,
        secret: platform.secret,
        token: platform.token,
        aesKey: platform.aesKey,
      });
    },

    detectMention() {
      // 1:1 has no mention concept (always "talking to the bot"). false; gating
      // should treat WeCom as DM (isDirect=true ⇒ respond without mention).
      return false;
    },

    resolveConversation(session) {
      // Always 1:1: the adapter treats everything as a user↔app direct chat, and there is no
      // thread concept. Force 'direct' rather than reading session.isDirect — the adapter does
      // not set it, and the DM gate (respond without a mention) depends on this.
      return { ...plainConversation(session), kind: 'direct' };
    },

    attachmentMeta(_el: h) {
      // Inbound attachments carry no mime/size (PicUrl or proxy url only) ⇒
      // return {}, download layer falls back to HTTP content-type.
      return {};
    },

    async sendMessage(bot, address, text) {
      // Outbound send override: WeCom is the only text path here (no reply/buttons).
      // Flatten CommonMark → plain text first (WeCom shows markup literally), then
      // defer to the generic send tail. Without this the generic path would push the
      // raw markdown verbatim.
      return sendForRef(bot, address, toPlainText(text), 'wecom', 'sendMessage');
    },

    // —— All optional methods omitted (unsupported; satori-core degrades per capabilities) ——
    // deleteMessage (24h recall) uses the generic bot.deleteMessage — no profile method.
    // reply / createThread / sendButtons / registerCommands / typing /
    // mountButtonEvents / mountCommandEvents not implemented:
    //   - clarify(ask): buttons=false ⇒ daemon throws "buttons unsupported", no fallback.
    //   - authorName: webhook gives only FromUserName (userid), no display name;
    //     left undefined (fetching it needs an extra getUser call, skipped).
  };
}
