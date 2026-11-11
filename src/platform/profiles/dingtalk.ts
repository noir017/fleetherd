// DingTalk (钉钉 org-internal robot) platform profile (PlatformProfile).
// Built on @satorijs/adapter-dingtalk (same @satorijs/core family as the rest).
//
// Adapter facts (verified against @satorijs/adapter-dingtalk@2.5.1 source):
// - protocol 'ws' = DingTalk **Stream mode**: the bot opens an outbound WebSocket
//   (/gateway/connections/open) — NO public callback URL needed. This is the
//   default and the recommended deployment. protocol 'http' registers POST
//   '/dingtalk' on the cordis server service (HttpServer inject=['server']) and
//   needs the robot's "message receiving address" pointed at it publicly.
// - Inbound (decodeMessage): text / richText / picture / file, with media pulled
//   via robotMessageFileDownload (a short-lived downloadUrl, no mime/size).
//   conversationType '1' ⇒ DM (channelId = senderStaffId); otherwise group
//   (channelId = openConversationId, starts with 'cid').
// - ★ Group delivery implies @mention: DingTalk only pushes a group message to a
//   robot when the robot is @-ed, and for text messages decodeMessage OVERWRITES
//   session.elements with the plain text (the h.at nodes are lost) — so
//   detectMention cannot scan elements and instead returns `!isDirect`.
// - Outbound: the adapter's encoder escapes markdown-active characters in text
//   (its escape()), which would mangle agent CommonMark — so sendMessage here
//   BYPASSES the encoder and calls internal.batchSendOTO (DM) / orgGroupSend
//   (group) directly with msgKey 'sampleMarkdown' (Hyrum: same internal routes +
//   'cid' channel heuristic the adapter itself uses in its encoder and
//   deleteMessage). CommonMark is pre-rendered by dingtalk-markdown.ts.
// - deleteMessage (recall, this robot's messages only) works via the generic
//   bot.deleteMessage ⇒ no profile method needed.
// - editMessage / reaction / typing / reply / thread / slash: none. Interactive
//   cards (buttons) exist in the API but click callbacks need a separately
//   registered card-callback endpoint the adapter doesn't mount ⇒ buttons=false.
// - sendFile degrades: the encoder ignores h.file elements (its uploadMedia is
//   never reached from visit()), so `send-file` delivers the caption at best —
//   share files as links or ![images](url) with public URLs instead.
import DingtalkAdapter from '@satorijs/adapter-dingtalk';
import type { Bot } from '@satorijs/core';

import type { MessageRef } from '../../types.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformCapabilities } from '../adapter.js';
import { renderDingtalkMarkdown } from '../dingtalk-markdown.js';
import { flattenMarkdown } from '../plaintext-markdown.js';
import type { PlatformProfile } from '../profile.js';
import type { DingtalkPlatformConfig } from '../config-schemas.js';
import {
  installHttpService,
  installServerService,
  plainConversation,
  resolveDefaultPlugin,
} from '../profile-helpers.js';

/**
 * Pre-render agent CommonMark into the DingTalk markdown subset (tables→bullets,
 * block regrouping for DingTalk's "single \n is not a line break" quirk). Wrapped
 * in try/catch so a converter bug degrades gracefully to the raw text rather than
 * dropping the message.
 */
function toDingtalkMarkdown(text: string): string {
  try {
    return renderDingtalkMarkdown(text);
  } catch {
    return text;
  }
}

/**
 * sampleMarkdown requires a `title` (shown in the push notification and the
 * conversation-list preview, not in the bubble). Derive it from the first
 * non-empty line, flattened to plain text so `**` / `#` markers don't surface in
 * the notification. Best-effort: any failure falls back to a static name.
 */
export function deriveNotificationTitle(text: string): string {
  try {
    const line = flattenMarkdown(text)
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim();
    return (line || 'fleetherd').slice(0, 32);
  } catch {
    return 'fleetherd';
  }
}

/** The slice of DingtalkBot this profile's encoder bypass depends on (Hyrum's Law, documented above). */
interface DingtalkSendInternals {
  selfId: string;
  internal: {
    batchSendOTO(data: Record<string, unknown>): Promise<{ processQueryKey?: string }>;
    orgGroupSend(data: Record<string, unknown>): Promise<{ processQueryKey?: string }>;
  };
}

export function createDingtalkProfile(): PlatformProfile<DingtalkPlatformConfig> {
  // DingTalk robot capabilities — declared honestly:
  //   editMessage=false  → no edit API for robot messages; streaming re-sends
  //                        whole segments (StreamBuffer merges aggressively).
  //   reaction=false     → no bot-reaction API.
  //   typing=false       → no typing indicator.
  //   reply=false        → robot sends can't target a message natively.
  //   thread=false       → no thread concept.
  //   buttons=false      → interactive-card clicks need a separately registered
  //                        callback the adapter doesn't mount; clarify(ask)
  //                        therefore throws at the daemon — callers must use a
  //                        plain question.
  //   slashCommands=false→ no slash registration (text command routing still
  //                        works, it's plain-text parsing).
  // maxMessageLength: official markdown text cap is ~5000 chars; 3500 leaves
  // headroom for the \n\n block regrouping and CJK-heavy content.
  const capabilities: PlatformCapabilities = {
    editMessage: false,
    reaction: false,
    typing: false,
    maxMessageLength: 3500,
    reply: false,
    thread: false,
    buttons: false,
    editButtons: false, // no buttons to edit
    slashCommands: false,
  };

  return {
    type: 'dingtalk',
    satoriPlatform: 'dingtalk', // DingtalkBot fixes platform = 'dingtalk'.
    capabilities,

    // The block regrouping (\n→\n\n) and table→bullets expand the text, so chunk
    // by the rendered string length, not the source markdown.
    measureRendered: (text: string) => toDingtalkMarkdown(text).length,

    install(ctx, platform) {
      // DingtalkBot.inject = ['http']: http service must exist first, else cordis
      // silently suspends the dingtalk plugin and never instantiates the bot.
      installHttpService(ctx);

      // protocol 'http' loads the adapter's HttpServer (inject=['server']) —
      // mount the server service alongside (as in lark/line/wecom) or inbound
      // silently hangs. Callback path is fixed at '<public host>/dingtalk'.
      if (platform.protocol === 'http') {
        installServerService(ctx, {
          host: platform.host ?? '127.0.0.1',
          port: platform.port ?? 8080,
        });
      }

      // Typed config (config-schemas.ts): appkey/secret schema-required; the
      // adapter exchanges them for an access token (auto-refreshed). agentId is
      // optional and only resolves the bot's display name/avatar in getLogin.
      ctx.plugin(resolveDefaultPlugin(DingtalkAdapter), {
        protocol: platform.protocol,
        appkey: platform.appkey,
        secret: platform.secret,
        ...(platform.agentId != null ? { agentId: platform.agentId } : {}),
      });
    },

    detectMention(session) {
      // Group messages reach a DingTalk robot ONLY when it is @-ed, and
      // decodeMessage overwrites session.elements for text messages (the h.at
      // nodes are lost) — so scanning elements would miss real mentions. Group ⇒
      // mentioned, by platform guarantee.
      return !(session.isDirect ?? false);
    },

    resolveConversation(session) {
      // No thread concept; decodeMessage sets isDirect=true for conversationType '1'
      // (channel = senderStaffId), group otherwise (channel = openConversationId, 'cid…').
      return plainConversation(session);
    },

    attachmentMeta() {
      // Inbound media carries only a short-lived downloadUrl (no mime/size) ⇒
      // return {}, download layer falls back to HTTP content-type.
      return {};
    },

    async sendMessage(bot: Bot, address: ConversationAddress, text: string): Promise<MessageRef> {
      // Encoder bypass (see profile doc-comment): the adapter's encoder escapes
      // markdown-active characters, so agent CommonMark would surface mangled.
      // Send msgKey 'sampleMarkdown' directly via the same internal routes the
      // encoder uses; 'cid' prefix ⇒ group (adapter's own deleteMessage heuristic).
      const { internal, selfId } = bot as unknown as DingtalkSendInternals;
      const base = {
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({
          title: deriveNotificationTitle(text),
          text: toDingtalkMarkdown(text),
        }),
        robotCode: selfId, // selfId = appkey (set in the bot constructor)
      };
      const { channel } = address;
      const { processQueryKey } = channel.startsWith('cid')
        ? await internal.orgGroupSend({ ...base, openConversationId: channel })
        : await internal.batchSendOTO({ ...base, userIds: [channel] });
      if (!processQueryKey) {
        throw new Error(
          `[dingtalk] sendMessage did not return a message id (channel=${address.channel})`
        );
      }
      return { address, messageId: processQueryKey };
    },

    // —— All other optional methods omitted (unsupported; satori-core degrades per capabilities) ——
    // deleteMessage (recall) uses the generic bot.deleteMessage — no profile method.
    // reply / createThread / sendButtons / registerCommands / typing /
    // mountButtonEvents / mountCommandEvents not implemented:
    //   - clarify(ask): buttons=false ⇒ daemon throws "buttons unsupported", no fallback.
    //   - authorName comes from senderNick (decodeMessage), no extra lookup needed.
  };
}
