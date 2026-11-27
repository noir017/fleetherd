// Lark/Feishu platform profile (PlatformProfile). Imports from @satorijs/core
// rather than the koishi umbrella (which eagerly pulls a loader with an ESM
// class-extends interop bug); adapter-lark is built on @satorijs/core.
//
// ⚠️ satoriPlatform pinning: LarkBot's `super(ctx, config, 'lark')` sets
//   bot.platform = 'lark' permanently (never overridden by config.platform). The
//   config's platform:'feishu'|'lark' only switches the **endpoint**
//   (open.feishu.cn vs open.larksuite.com). satori-core finds bots by
//   `b.platform === satoriPlatform`, so satoriPlatform **must** stay 'lark'.
//
// ⚠️ Topics (话题) are a lane you cannot address directly. A Feishu topic message
//   carries `thread_id` (`omt_…`), but `im/v1/messages` accepts only
//   open_id/user_id/union_id/email/chat_id as `receive_id_type` — there is no
//   "send to this topic" call (verified against
//   open.feishu.cn/document/server-docs/im-v1/message/create, 2026-09). The one
//   documented way in is `im.message.reply(<any message in the topic>,
//   { reply_in_thread: true })`, so every outbound path below resolves a reply
//   ANCHOR first (see LarkTopicRouter.anchorFor). hermes-agent's Feishu adapter reaches
//   for an undocumented `receive_id_type: 'thread_id'` on create instead; this
//   profile stays on the documented reply route and keeps the anchor cached so it
//   costs no extra round-trip.
//
// ⚠️ The adapter decodes only some inbound message types, and the rest arrive with NO content —
//   which the inbound gate drops as `empty`, so the bot appears to ignore a message that
//   @-mentioned it. Rich text (`msg_type: 'post'`) is the one that matters and is rebuilt here
//   (larkPostElements); inbound media needs an authenticated fetch for the same family of
//   reasons (fetchAttachment).
import { h } from '@satorijs/core';
import LarkAdapter from '@satorijs/adapter-lark';
import type { Bot } from '@satorijs/core';

import type { Context, Session } from '@satorijs/core';

import type { MessageRef } from '../../types.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformCapabilities } from '../adapter.js';
import type { PlatformProfile, ProfileButtonEvent, ResolvedConversation } from '../profile.js';
import type { LarkPlatformConfig } from '../../config/platform-schemas.js';
import { renderLarkMarkdown } from '../lark-markdown.js';
import { collectErrors, MessageNotEditableError } from '../../core/outbound-errors.js';
import {
  findAtMention,
  installHttpService,
  installServerService,
  plainConversation,
  resolveDefaultPlugin,
  sendForRef,
} from '../profile-helpers.js';

/**
 * In-place edits Lark grants one message. The 21st `im.message.update` on the same message returns
 * 230072 and every later one does too — the limit is per message and permanent, not a rate limit.
 */
const LARK_MAX_EDITS_PER_MESSAGE = 20;

/** Lark server error code for "this message has been edited as many times as it can be". */
const LARK_EDIT_LIMIT_CODE = 230072;

/**
 * Lark server error codes carried by a thrown error, including ones nested in an AggregateError.
 *
 * Two places to look, because the adapter reports the same failure two ways: the HTTP error object
 * carries `response.data.code`, and adapter-lark's MessageEncoder additionally appends
 * "(Lark error code NNNNNN: …)" to the message text — while wrapping the whole thing in an
 * AggregateError whose own message is empty. Reading only one of the two misses half the cases.
 */
function larkErrorCodes(e: unknown): number[] {
  const codes: number[] = [];
  for (const err of collectErrors(e)) {
    const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    if (typeof code === 'number') codes.push(code);
    const text = err instanceof Error ? err.message : '';
    const m = /Lark error code (\d+)/.exec(text);
    if (m) codes.push(Number(m[1]));
  }
  return codes;
}

/**
 * Translate Lark's edit-limit rejection into the core's permanent-failure type so the writers seal
 * the message and continue in a new one. Anything else passes through untouched — a transient
 * failure must stay transient, or every rate limit would fragment the reply.
 *
 * Wired as the profile's `classifyError`, so satori-core applies it to EVERY outbound call. It used
 * to be called from `editMessage` alone, which meant the same 230072 raised by a card patch
 * (`editButtons`) reached the writers as an anonymous transient and was retried forever.
 */
function asEditLimitError(e: unknown): unknown {
  if (!larkErrorCodes(e).includes(LARK_EDIT_LIMIT_CODE)) return e;
  return new MessageNotEditableError(
    `Lark accepts no further edits to this message (code ${LARK_EDIT_LIMIT_CODE}: per-message edit limit of ${LARK_MAX_EDITS_PER_MESSAGE} reached)`,
    { cause: e }
  );
}

/**
 * Convert agent CommonMark to the Feishu markdown subset, with graceful
 * degradation: a converter bug must never block message delivery, so any throw
 * falls back to the raw text (which Lark still renders best-effort). Used by every
 * path where agent text becomes Lark markdown content — sendMessage, editMessage,
 * reply, and the button card builder. See lark-markdown.ts for the subset rules
 * (tables→bullets, headings→bold, blockquotes degraded; bold/italic/links/code
 * blocks/lists pass through, since Feishu renders them natively).
 */
function toLarkMarkdown(text: string): string {
  try {
    return renderLarkMarkdown(text);
  } catch {
    return text;
  }
}

/**
 * unicode emoji → Lark emoji_type enum. Pure for testability.
 *
 * Lark reactions reject unicode; they only accept fixed `emoji_type` strings
 * (see open.feishu.cn .../message-reaction/emojis-introduce). Only lifecycle and
 * a few common emoji are mapped, to the closest enum.
 *
 * ⚠️ Casing is NOT guessable — Lark's official enum mixes cases (emoji_type is a
 * raw string, adapter doesn't validate; invalid values get rejected by Lark and
 * silently swallowed by safeReaction). Each value verified char-by-char against
 * the official emojis-introduce table (2026-06): uppercase GLANCE/DONE/THUMBSUP/
 * OK/HEART/THANKS, PascalCase ThumbsDown/Fire/CrossMark. Lark has **no**
 * CELEBRATE — 🎉 maps to PARTY.
 *   ❌ Note: `ERROR` is valid but renders as a distorted face, NOT a red cross;
 *   the red cross is the separate `CrossMark`. Failure must use CrossMark.
 * Unmapped ⇒ undefined ⇒ upper layer safely skips (no crash).
 */
export function mapLarkEmojiType(emoji: string): string | undefined {
  const LARK_EMOJI_TYPE: Record<string, string> = {
    '👀': 'GLANCE',
    '✅': 'DONE',
    '❌': 'CrossMark',
    '👍': 'THUMBSUP',
    '👎': 'ThumbsDown',
    '❤️': 'HEART',
    '🎉': 'PARTY',
    '🔥': 'Fire',
    '🙏': 'THANKS',
    '👌': 'OK',
  };
  return LARK_EMOJI_TYPE[emoji];
}

/**
 * daemon button style → Lark schema 2.0 button `type` enum, allowlisted.
 * Pure for testability.
 *
 * Lark's button `type` is a fixed enum; invalid values are silently ignored
 * (button falls back to default style). Only the core valid values pass;
 * unknown/missing ⇒ 'default' (safe default).
 */
export function mapLarkButtonType(style: string | undefined): string {
  const ALLOWED = new Set(['default', 'primary', 'danger', 'text']);
  return style && ALLOWED.has(style) ? style : 'default';
}

/**
 * Encode button.id into the card's callback value. Pure for testability.
 *
 * ⚠️ Key design (avoids an adapter pitfall): adapter-lark's Satori encoder emits
 * only `behaviors:[{type:'callback',value:{_satori_type:'command',...}}]` for
 * `<button>` and **never reads button.id**; on callback, only
 * `_satori_type==='command'` is normalized. So a satori `<button id=X>` card
 * can't return our id. This profile therefore **bypasses the satori encoder**
 * and hand-builds schema 2.0 card JSON via im.message.create, putting
 * `{ id: button.id }` into `behaviors[].value`. Lark echoes it back verbatim to
 * `body.event.action.value`, so extractCardAction recovers `value.id` and
 * matches daemon pendingAsks' `ask:<reqId>:<index>` exactly.
 *
 * Card uses a top-level markdown (text) + one button per element (tag:'button').
 */
export function buildLarkButtonCard(
  text: string,
  buttons: Array<{ id: string; label: string; style?: string }>
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  if (text) {
    // The card `markdown` element renders the Feishu markdown subset; convert the
    // agent's CommonMark first so tables/headings don't render as raw `|`/`#`.
    elements.push({ tag: 'markdown', content: toLarkMarkdown(text) });
  }
  for (const b of buttons) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      // Allowlist-map style → Lark's fixed button type enum (unknown ignored).
      type: mapLarkButtonType(b.style),
      // Click echoes the whole value to body.event.action.value. No _satori_type
      // ⇒ adapter won't normalize it as a command (we catch it via internal/session).
      behaviors: [{ type: 'callback', value: { id: b.id } }],
    });
  }
  return {
    schema: '2.0',
    config: {},
    body: { elements },
  };
}

/**
 * Extract a card callback interaction from a raw Lark event body. Pure for tests.
 *
 * Only recognizes `body.type === 'card.action.trigger'` carrying our encoded
 * `id` in action.value. channelId ← context.open_chat_id, messageId ←
 * context.open_message_id, userId ← operator.open_id. Missing id or non-card
 * event ⇒ null (ignored, not emitted).
 */
export function extractCardAction(body: unknown): {
  id: string;
  channelId: string;
  messageId: string;
  userId: string;
} | null {
  const b = body as {
    type?: string;
    event?: {
      action?: { value?: unknown };
      context?: { open_message_id?: string; open_chat_id?: string };
      operator?: { open_id?: string };
    };
  };
  if (!b || b.type !== 'card.action.trigger') return null;
  const value = b.event?.action?.value;
  // Lark may serialize value as a JSON string or an object; try both for id.
  let id: string | undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as { id?: unknown };
      if (typeof parsed.id === 'string') id = parsed.id;
    } catch {
      // Non-JSON string: no usable id.
    }
  } else if (value && typeof value === 'object') {
    const v = (value as { id?: unknown }).id;
    if (typeof v === 'string') id = v;
  }
  if (!id) return null;
  const ctx = b.event?.context;
  const channelId = ctx?.open_chat_id ?? '';
  const messageId = ctx?.open_message_id ?? '';
  const userId = b.event?.operator?.open_id ?? '';
  return { id, channelId, messageId, userId };
}

/**
 * Insert into a Map with an insertion-ordered cap, refreshing recency on rewrite.
 *
 * The two caches this profile keeps (topic reply anchors, card→address) are keyed by ids a
 * chat can mint without limit, so an unbounded Map is a slow leak in a daemon that runs for
 * weeks. Map iterates in insertion order, so deleting before setting makes a rewrite count
 * as "recently touched" and `keys().next()` yields the least recently touched entry.
 */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

/** How many topics / interactive cards each cache remembers before evicting the oldest. */
const LARK_CACHE_LIMIT = 500;

/**
 * The topic (话题) id an inbound event belongs to, or undefined outside a topic. Pure, for tests.
 *
 * Feishu sets `thread_id` on a message **iff** that message lives in a topic
 * (open.feishu.cn .../im-v1/message/events/receive, 2026-09: "不返回说明该消息非话题消息").
 * The adapter never surfaces it as a session field — `adaptMessage` assigns both
 * `session.channelId` and `session.guildId` the chat id — so without this every topic in a
 * chat would collapse onto the chat root. That is the same silent mis-routing Telegram's
 * private-chat topics had, and the reason `resolveConversation` exists at all.
 *
 * Two witnesses, in order:
 *  1. `session.event.referrer.event.message.thread_id` — adaptSession explicitly
 *     `pick`s `['message_id','thread_id']` into the referrer for `im.message.receive_v1`.
 *     ⚠️ Hyrum's Law: an adapter internal, contract-tested in lark.contract.test.ts.
 *  2. the raw event body stashed by `setInternal('lark', body)` (reachable as
 *     `session.event._data`), which still carries the field if the referrer shape changes.
 *
 * ⚠️ `root_id` is deliberately NOT a fallback (hermes-agent's Feishu adapter uses one). Feishu
 * sets root_id/parent_id on ANY reply, threaded or not, so a plain quoted reply in a group
 * would be misread as its own conversation — and the "lane" it produced could not be addressed
 * as a topic, since replying in-thread to a non-topic message CREATES a topic rather than
 * continuing one.
 */
export function larkThreadIdOf(session: unknown): string | undefined {
  const event = (
    session as
      | {
          event?: {
            referrer?: { event?: { message?: { thread_id?: unknown } } };
            _data?: unknown;
          };
        }
      | undefined
  )?.event;
  const fromReferrer = event?.referrer?.event?.message?.thread_id;
  if (typeof fromReferrer === 'string' && fromReferrer !== '') return fromReferrer;
  const body = event?._data as { event?: { message?: { thread_id?: unknown } } } | undefined;
  const fromBody = body?.event?.message?.thread_id;
  return typeof fromBody === 'string' && fromBody !== '' ? fromBody : undefined;
}

/**
 * THE single Lark conversation resolver: chat id, optional topic lane, kind.
 *
 * A topic is a `(chat_id, thread_id)` PAIR — the chat id alone is still a complete API
 * target (that is the ConversationRef contract), and the lane rides in `thread`. Outside a
 * topic this is the flat DM/group shape every thread-less profile shares
 * (`plainConversation`), so the two cases cannot drift apart.
 *
 * `space` is deliberately absent in the topic branch for the same reason plainConversation
 * drops it: the adapter sets `guildId === channelId` for every Lark chat, so a "space" equal
 * to the channel carries no information.
 */
export function larkConversation(session: Session): ResolvedConversation {
  const thread = larkThreadIdOf(session);
  if (thread == null) return plainConversation(session);
  return { channel: session.channelId ?? '', thread, kind: 'thread' };
}

/**
 * Pull `{ threadId, messageId }` out of a raw `im.message.receive_v1` body, or null when the
 * event is not a topic message. Pure, for tests.
 *
 * Every inbound topic message is a usable reply anchor for that topic, and it costs nothing
 * to remember — which is what keeps the documented reply route from needing a lookup call
 * before each send (see LarkTopicRouter.anchorFor).
 */
export function extractThreadAnchor(
  body: unknown
): { threadId: string; messageId: string } | null {
  const b = body as
    | { type?: string; event?: { message?: { thread_id?: unknown; message_id?: unknown } } }
    | undefined;
  if (!b || b.type !== 'im.message.receive_v1') return null;
  const threadId = b.event?.message?.thread_id;
  const messageId = b.event?.message?.message_id;
  if (typeof threadId !== 'string' || threadId === '') return null;
  if (typeof messageId !== 'string' || messageId === '') return null;
  return { threadId, messageId };
}

/**
 * Rebuild the content of a rich-text (富文本, `msg_type: 'post'`) message as Satori elements, or
 * undefined when the event is not one. Pure — the resource-URL builder is injected.
 *
 * ⚠️ Why this exists: adapter-lark's `adaptMessage` switches on `message_type` and handles
 * text/image/audio/media/file **only** (lib/index.cjs, 2026-09). A `post` falls off the end of
 * that switch, so `session.content` comes out empty — and an empty message is dropped by the
 * inbound gate as `empty` before anything else looks at it. The visible symptom is the worst kind:
 * the bot ignores a message that plainly @-mentioned it, with nothing in the log to say why.
 * Feishu clients send `post` whenever the message mixes formatting or embeds an image, so this is
 * not a rare shape.
 *
 * Element mapping is aimed at what an AGENT reads, not at round-tripping Feishu's model:
 *  - `a` becomes a markdown link, `code_block` a fenced block — an agent reads both natively;
 *  - `at` becomes a real `h.at(open_id)`, which is the load-bearing one. A post's `at` carries a
 *    PLACEHOLDER (`@_user_1`, `@_all`), not an id, and the real open_id sits in the message's
 *    `mentions` array — so a placeholder passed through verbatim would never equal the bot's
 *    selfId and `detectMention` would report no mention (hermes-agent's adapter resolves the same
 *    map for the same reason). `@_all` has no id to carry and degrades to the text `@all`;
 *  - `img`/`media` become media elements addressed exactly like a standalone image message, so
 *    fetchAttachment downloads them by the same route.
 *
 * Still empty on purpose: `sticker` (Feishu's resource API excludes 表情包 outright),
 * `share_chat`, and `merge_forward` (a forwarded bundle needs another API call to read).
 */
export function larkPostElements(
  rawBody: unknown,
  resourceUrl: (type: 'image' | 'file', messageId: string, fileKey: string) => string
): h[] | undefined {
  const msg = (
    rawBody as
      | {
          type?: string;
          event?: {
            message?: {
              message_type?: unknown;
              message_id?: unknown;
              content?: unknown;
              mentions?: unknown;
            };
          };
        }
      | undefined
  )?.type === 'im.message.receive_v1'
    ? (rawBody as { event: { message?: Record<string, unknown> } }).event.message
    : undefined;
  if (!msg || msg.message_type !== 'post') return undefined;
  const messageId = typeof msg.message_id === 'string' ? msg.message_id : '';
  if (typeof msg.content !== 'string' || messageId === '') return undefined;

  let post: { title?: unknown; content?: unknown };
  try {
    post = JSON.parse(msg.content) as typeof post;
  } catch {
    // Not our shape after all: leave the session as the adapter left it rather than guessing.
    return undefined;
  }

  // mentions: [{ key: '@_user_1', id: { open_id }, name }] — the placeholder → identity map.
  const mentions = new Map<string, { id: string; name: string }>();
  if (Array.isArray(msg.mentions)) {
    for (const m of msg.mentions as Array<Record<string, unknown>>) {
      const key = m['key'];
      const id = (m['id'] as { open_id?: unknown } | undefined)?.open_id;
      if (typeof key === 'string' && typeof id === 'string') {
        mentions.set(key, { id, name: typeof m['name'] === 'string' ? m['name'] : '' });
      }
    }
  }

  const out: h[] = [];
  const text = (t: string): void => {
    if (t !== '') out.push(h.text(t));
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (typeof post.title === 'string' && post.title !== '') text(`${post.title}\n`);

  // content is an array of PARAGRAPHS, each an array of inline elements.
  const paragraphs = Array.isArray(post.content) ? (post.content as unknown[]) : [];
  paragraphs.forEach((para, i) => {
    if (i > 0) text('\n');
    for (const raw of Array.isArray(para) ? (para as unknown[]) : [para]) {
      if (typeof raw === 'string') {
        text(raw);
        continue;
      }
      const el = raw as Record<string, unknown>;
      switch (str(el['tag']).toLowerCase()) {
        case 'text':
        case 'md':
          text(str(el['text']));
          break;
        case 'a': {
          const href = str(el['href']);
          const label = str(el['text']) || href;
          text(href ? `[${label}](${href})` : label);
          break;
        }
        case 'at': {
          const placeholder = str(el['user_id']);
          const known = mentions.get(placeholder);
          if (known) out.push(h.at(known.id, known.name ? { name: known.name } : {}));
          else if (placeholder === '@_all') text('@all');
          else text(`@${str(el['user_name']) || 'user'}`);
          break;
        }
        case 'img':
        case 'image': {
          const key = str(el['image_key']);
          if (key) out.push(h.image(resourceUrl('image', messageId, key)));
          break;
        }
        case 'media':
        case 'file':
        case 'audio':
        case 'video': {
          const key = str(el['file_key']);
          if (key) out.push(h.file(resourceUrl('file', messageId, key)));
          break;
        }
        case 'emotion':
        case 'emoji':
          text(`:${str(el['emoji_type']) || str(el['text'])}:`);
          break;
        case 'br':
          text('\n');
          break;
        case 'hr':
        case 'divider':
          text('\n---\n');
          break;
        case 'code_block':
          text(`\n\`\`\`${str(el['language'])}\n${str(el['text'])}\n\`\`\`\n`);
          break;
        default:
          // An unknown inline tag contributes nothing rather than a guess at its meaning.
          break;
      }
    }
  });

  return out.length > 0 ? out : undefined;
}

/**
 * Parse an adapter-minted resource URL back into the three things the API call needs. Pure.
 *
 * adapter-lark decodes an inbound image/audio/media/file into
 * `h.image(bot.getResourceUrl(type, message_id, file_key))`, and `getResourceUrl` builds
 * `internal:lark/<selfId>/im/v1/messages/<message_id>/resources/<file_key>?type=<image|file>`
 * (satori's Bot.getInternalUrl). That address is not fetchable by anything but the bot itself,
 * which is why fetchAttachment exists.
 *
 * ⚠️ Both ids come off a user-sent event and are spliced into a request path, so they are
 * validated against Feishu's id alphabet (`om_…`, `img_v2_…`, `file_v2_…`: word chars and
 * hyphens). Anything else — a dot, a slash, an escape — is rejected as unparseable rather than
 * concatenated into some other Feishu endpoint. `type` is likewise an allowlist of the two
 * values the adapter emits, not free text.
 */
export function parseLarkResourceUrl(
  url: string
): { messageId: string; fileKey: string; type: 'image' | 'file' } | null {
  const m = /^internal:lark\/[^/]+\/im\/v1\/messages\/([^/?]+)\/resources\/([^/?]+)(?:\?(.*))?$/.exec(url);
  if (!m) return null;
  const [, messageId = '', fileKey = '', query = ''] = m;
  const ID = /^[A-Za-z0-9_-]+$/;
  if (!ID.test(messageId) || !ID.test(fileKey)) return null;
  // The adapter passes type=image for an image message and type=file for audio/media/file, which
  // is exactly what Feishu's resource endpoint requires — so no retry across types is needed here
  // (hermes-agent's Feishu adapter retries audio/media as 'file' because its type comes from the
  // message rather than from the URL that fetched it).
  const type = new URLSearchParams(query).get('type');
  if (type !== 'image' && type !== 'file') return null;
  return { messageId, fileKey, type };
}

/**
 * Sniff a mime type and file extension from the first bytes of a downloaded resource. Pure.
 *
 * Why sniff at all: the adapter's binary route returns `response.data` and drops the response
 * headers, so the Content-Type Feishu sent is unreachable — and a Feishu IMAGE message carries no
 * filename whatsoever (only an `image_key`). Without this, an inbound screenshot reached the agent
 * as an extension-less blob it could not open. hermes-agent reads the header instead (its SDK
 * exposes it) and falls back to `.jpg`; guessing jpg for a png is worse than looking.
 *
 * Only the formats Feishu actually delivers as message resources are listed. Unknown ⇒ undefined,
 * and the caller falls back to the file's own name (which a `file` message does carry). Text is
 * deliberately NOT sniffed: a name-less text blob is rare, and misreading binary as text would
 * inline garbage into the prompt.
 */
export function sniffLarkMedia(bytes: Uint8Array): { mime: string; ext: string } | undefined {
  const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', ext: '.png' };
  if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: '.jpg' };
  if (ascii(0, 'GIF8')) return { mime: 'image/gif', ext: '.gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { mime: 'image/webp', ext: '.webp' };
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return { mime: 'audio/wav', ext: '.wav' };
  if (starts(0x42, 0x4d)) return { mime: 'image/bmp', ext: '.bmp' };
  if (ascii(0, '%PDF')) return { mime: 'application/pdf', ext: '.pdf' };
  // ZIP container: also every OOXML document (docx/xlsx/pptx). The extension stays .zip because
  // the real one is in the message's own file_name, which the caller prefers over this guess.
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { mime: 'application/zip', ext: '.zip' };
  if (starts(0x1f, 0x8b)) return { mime: 'application/gzip', ext: '.gz' };
  if (ascii(4, 'ftyp')) return { mime: 'video/mp4', ext: '.mp4' };
  // Feishu voice notes are opus in an Ogg container.
  if (ascii(0, 'OggS')) return { mime: 'audio/ogg', ext: '.ogg' };
  if (ascii(0, 'ID3') || starts(0xff, 0xfb)) return { mime: 'audio/mpeg', ext: '.mp3' };
  return undefined;
}

/**
 * The `<file_key, file_name>` pairs a raw inbound event declares. Pure, for tests.
 *
 * A Feishu `file` or `media` message states its real filename in the message content JSON
 * (`{"file_key":"file_v2_…","file_name":"季度报告.pdf"}`), but adapter-lark's decode drops it:
 * `h.file(url)` carries no title. The name is the most useful thing about a document — it is what
 * the agent reads before deciding to open it — so the profile recovers it from the same raw body
 * it already reads `thread_id` off, and fetchAttachment prefers it over any sniffed extension.
 */
export function extractResourceNames(rawBody: unknown): Array<{ key: string; name: string }> {
  const b = rawBody as
    | { type?: string; event?: { message?: { content?: unknown } } }
    | undefined;
  if (!b || b.type !== 'im.message.receive_v1') return [];
  const content = b.event?.message?.content;
  if (typeof content !== 'string') return [];
  let json: { file_key?: unknown; file_name?: unknown; content?: unknown };
  try {
    json = JSON.parse(content) as typeof json;
  } catch {
    return [];
  }

  const found: Array<{ key: string; name: string }> = [];
  const take = (key: unknown, name: unknown): void => {
    if (typeof key === 'string' && key !== '' && typeof name === 'string' && name !== '') {
      found.push({ key, name });
    }
  };
  // A file/media message states its name at the top level.
  take(json.file_key, json.file_name);
  // A rich-text (post) message states it on each embedded element instead — same treatment, since
  // those elements become attachments too (see larkPostElements).
  for (const para of Array.isArray(json.content) ? (json.content as unknown[]) : []) {
    for (const raw of Array.isArray(para) ? (para as unknown[]) : []) {
      if (!raw || typeof raw !== 'object') continue;
      const el = raw as Record<string, unknown>;
      take(el['file_key'] ?? el['image_key'], el['file_name']);
    }
  }
  return found;
}

/**
 * Infer Lark receive_id_type from channelId (matches adapter's extractIdType).
 * ou→open_id / on→union_id / oc→chat_id / contains @→email / else→user_id.
 */
export function larkReceiveIdType(
  id: string
): 'open_id' | 'union_id' | 'chat_id' | 'email' | 'user_id' {
  if (id.startsWith('ou')) return 'open_id';
  if (id.startsWith('on')) return 'union_id';
  if (id.startsWith('oc')) return 'chat_id';
  if (id.includes('@')) return 'email';
  return 'user_id';
}

/**
 * Everything needed to put a message INTO a Feishu topic, plus the two caches that keep it
 * cheap. One instance per profile.
 *
 * Lifted out of `createLarkProfile` deliberately: the profile body should declare behavior,
 * not also implement the trickiest part of it, and a standalone factory is unit-testable
 * without standing up an adapter.
 */
export interface LarkTopicRouter {
  /** Learn an anchor from a raw inbound event body; a non-topic event is ignored. */
  rememberInbound(rawBody: unknown): void;
  /** Record that a message (typically an interactive card) was posted to `address`. */
  rememberCard(messageId: string, address: ConversationAddress): void;
  /** Where a previously sent card lives, if this process sent it. */
  cardAddress(messageId: string): ConversationAddress | undefined;
  /** Record a known-good reply anchor for a topic. */
  rememberAnchor(threadId: string, messageId: string): void;
  /** A message id inside `threadId` that a reply can target. Throws if none can be found. */
  anchorFor(bot: Bot, threadId: string): Promise<string>;
  /** Send into `address`, threading the message when the address carries a topic lane. */
  send(
    bot: Bot,
    address: ConversationAddress,
    build: (anchor: string | undefined) => h[] | string,
    op: string
  ): Promise<MessageRef>;
}

export function createLarkTopicRouter(): LarkTopicRouter {
  // topic id → a message id inside it, usable as a reply anchor. Written from every inbound
  // topic message and from every successful outbound into a topic, so the common case reaches
  // Feishu with no lookup call. A cold miss (fresh daemon, or a reverse command aimed at a
  // topic nobody has spoken in this run) falls back to the messages API.
  const anchors = new Map<string, string>();
  // interactive-card message id → the address it was posted to. A card.action.trigger body
  // reports only open_chat_id, so without this a click inside a topic would resolve to the
  // chat root — the Telegram-topic bug the resolveConversation seam exists to prevent.
  const cards = new Map<string, ConversationAddress>();

  const rememberAnchor = (threadId: string, messageId: string): void => {
    rememberBounded(anchors, threadId, messageId, LARK_CACHE_LIMIT);
  };

  /**
   * Resolve a reply anchor for `threadId`, consulting the cache first.
   *
   * Cold miss ⇒ ask Feishu for the topic's FIRST message (`container_id_type: 'thread'`,
   * documented for exactly this at open.feishu.cn/document/server-docs/im-v1/message/list,
   * 2026-09: "获取话题回复中的所有消息"). Ascending order picks the topic's root: any message
   * in a topic keeps a reply inside it, but the root is the least likely to be recalled.
   *
   * Throws with the topic named when nothing can anchor the send. Falling back to the chat
   * root would put an agent's answer in front of the wrong people, which is exactly the
   * silent mis-delivery the address refactor was written to end.
   */
  const anchorFor = async (bot: Bot, threadId: string): Promise<string> => {
    const cached = anchors.get(threadId);
    if (cached) return cached;
    const api = larkMessageApi(bot);
    if (api) {
      for await (const item of api.list({
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      })) {
        if (item.message_id) {
          rememberAnchor(threadId, item.message_id);
          return item.message_id;
        }
      }
    }
    throw new Error(
      `[lark] cannot address topic ${threadId}: no message in it to reply to (Feishu has no send-to-topic API; a topic is addressed by replying inside it)`
    );
  };

  return {
    rememberInbound(rawBody) {
      const anchor = extractThreadAnchor(rawBody);
      if (anchor) rememberAnchor(anchor.threadId, anchor.messageId);
    },

    rememberCard(messageId, address) {
      rememberBounded(cards, messageId, address, LARK_CACHE_LIMIT);
    },

    cardAddress(messageId) {
      return cards.get(messageId);
    },

    rememberAnchor,
    anchorFor,

    /**
     * The lane is expressed as a leading `<quote id replyInThread>` element: the adapter's
     * encoder turns a quote into `im.message.reply(id, { …, reply_in_thread })`, which is the
     * documented way into a topic. `bot.sendMessage` cannot do it on its own — it has no
     * inbound session to read a lane off, so it falls through to im.message.create and lands
     * in the chat root with ok=true and nothing logged.
     *
     * `build` is a callback, not an array, because sendFile has to re-arm the quote MID
     * fragment (see its comment) and the anchor is only known in here. A `string` body goes
     * to the adapter verbatim outside a topic and through `h.parse` inside one — precisely
     * what the adapter's own `h.normalize` does to a string, so both lanes put identical
     * elements on the wire and prepending the quote is their only difference.
     *
     * A stale anchor (its message was recalled) is not a permanent break: the cache entry is
     * dropped and the send retried once against a freshly listed anchor.
     */
    async send(bot, address, build, op) {
      const thread = address.thread;
      if (thread == null) return sendForRef(bot, address, build(undefined), 'lark', op);

      const attempt = async (anchor: string): Promise<MessageRef> => {
        const body = build(anchor);
        const ref = await sendForRef(
          bot,
          address,
          [
            h('quote', { id: anchor, replyInThread: true }),
            ...(typeof body === 'string' ? h.parse(body) : body),
          ],
          'lark',
          op
        );
        // Keep the anchor fresh: the message just posted is itself in the topic.
        rememberAnchor(thread, ref.messageId);
        return ref;
      };

      const cached = anchors.get(thread);
      try {
        return await attempt(await anchorFor(bot, thread));
      } catch (e) {
        // Only a cached anchor is worth a second try; a freshly listed one that failed will
        // fail the same way, and retrying would just double the latency of a real error.
        if (!cached) throw e;
        anchors.delete(thread);
        return attempt(await anchorFor(bot, thread));
      }
    },
  };
}

/**
 * Lark profile. Selected by createSatoriAdapter via cfg.platform.type.
 *
 * Adapter facts (verified against @satorijs/adapter-lark source):
 * - `static inject = ['http']` (http service required first, else no bot);
 *   `super(ctx, config, 'lark')` ⇒ bot.platform always 'lark' (see file header).
 * - editMessage exists: plain/rich text ⇒ im.message.update, card ⇒
 *   im.message.patch. satori-core sends plain strings ⇒ msg_type:'post' ⇒ update,
 *   crash-free for streaming in-place edit ⇒ editMessage=true.
 * - sendMessage/editMessage are overridden here ONLY to pre-render agent
 *   CommonMark into the Feishu markdown subset (toLarkMarkdown → renderLarkMarkdown):
 *   tables→bullets, headings→bold, blockquotes degraded; bold/italic/links/code
 *   blocks/lists pass through (Feishu renders them). The delivery mechanism is
 *   unchanged — the converted STRING still flows through the adapter's post `md`
 *   segment (send → create, edit → update), so this is a pure content transform.
 * - **LarkBot does NOT implement createReaction/deleteReaction** (no such methods;
 *   Bot base has none either), but internal has im.message.reaction.create/list/
 *   delete. satori-core's addReaction?/removeReaction? override seam lets this
 *   profile use internal directly, avoiding the crashing generic path ⇒
 *   reaction=true.
 * - `<quote id>` ⇒ im.message.reply ⇒ reply=true.
 * - adaptSession sets isDirect=(chat_type==='p2p'); mentions normalize to
 *   h.at(open_id,{name}) ⇒ detectMention scans at elements.
 * - topics (话题): the inbound `thread_id` never reaches a session field, but adaptSession
 *   picks it into `event.referrer` and stashes the whole body via setInternal, so
 *   larkThreadIdOf can recover it. Outbound needs a reply anchor (see the file header),
 *   which is why sendMessage/sendFile/sendButtons all have overrides here.
 * - No typing API, no programmatic slash registration; button clicks normalize as
 *   interaction/command ⇒ typing/slashCommands false (buttons handled specially).
 */
export function createLarkProfile(): PlatformProfile<LarkPlatformConfig> {
  // Lark capabilities: editable (card patch / text update, ideal for streaming),
  //   reply (native quote).
  // reaction=true: via the addReaction override seam over internal
  //   im.message.reaction.* (avoids the crashing generic createReaction). emoji
  //   mapped via mapLarkEmojiType; unmapped safely skipped.
  // typing=false: no typing API. slashCommands=false.
  // thread=true: a Feishu topic (话题) is a `(chat_id, thread_id)` lane, exactly the pair
  //   ConversationRef models. It cannot be addressed directly — see the file header — so
  //   every outbound path resolves a reply anchor and posts with reply_in_thread.
  // buttons=true: interactive-card buttons (send + receive).
  //   ⚠️ Bypasses the satori encoder (it drops button.id, only _satori_type:
  //   'command'); hand-builds schema 2.0 card JSON via im.message.create with
  //   { id } in button.behaviors[].value. Click returns it via card.action.trigger,
  //   recovered through the internal/session hook. See sendButtons /
  //   mountButtonEvents / buildLarkButtonCard / extractCardAction.
  // menuPageSize: deliberately NOT declared, which means menus here stay at core's conservative
  //   PAGE_SIZE. Telegram/Discord/Slack raised theirs against a documented component limit; Lark
  //   publishes no element cap for a card's action module that I could cite, and the cards here are
  //   hand-built rather than encoder-produced, so a bigger page would be a guess about how much a
  //   card will carry — and the way that guess fails is a menu the tenant rejects outright. Declare
  //   it once someone has measured it on a real tenant, the way maxEditsPerMessage was.
  // maxMessageLength≈10000: Lark single-message content JSON is ~10000 chars.
  // maxEditsPerMessage=20: measured on this tenant — the 21st im.message.update on one message
  //   returns 230072 and never succeeds again. Declaring it lets the writers seal a message before
  //   the platform starts refusing, instead of burning a round trip per rejected flush.
  const capabilities: PlatformCapabilities = {
    editMessage: true,
    reaction: true,
    typing: false,
    maxMessageLength: 10000,
    maxEditsPerMessage: LARK_MAX_EDITS_PER_MESSAGE,
    reply: true,
    thread: true,
    buttons: true,
    // im.message.patch ("更新已发送的消息卡片") replaces a card's content in place — the endpoint
    // this capability is named for. NOT reachable through editMessage above, which goes to
    // im.message.update with msg_type:'post' and cannot touch a card; see LarkInternalMessage.
    editButtons: true,
    slashCommands: false,
  };

  const topics = createLarkTopicRouter();
  // file_key → the filename the sending client declared, learned from raw inbound bodies
  // (extractResourceNames) because the adapter's decode drops it. Bounded like the topic caches:
  // the keys are minted by whoever is chatting.
  const resourceNames = new Map<string, string>();

  return {
    type: 'lark',
    // Always 'lark': fixed by LarkBot's super(...,'lark'), independent of config.
    satoriPlatform: 'lark',
    capabilities,

    classifyError: asEditLimitError,

    // Lark counts the markdown content string; table→bullets rendering can expand it, so chunk by the
    // rendered string length, not the source.
    measureRendered: (text: string) => toLarkMarkdown(text).length,

    install(ctx, platform) {
      // LarkBot.inject = ['http']: http service must exist first, else cordis
      // silently suspends the lark plugin and never instantiates the bot.
      installHttpService(ctx);

      // Typed config (config/platform-schemas.ts): appId/appSecret required (adapter
      // auto-exchanges for tenant_access_token, 2h, auto-refreshed);
      // endpoint 'feishu'|'lark' only switches the API endpoint; protocol
      // defaults to 'ws' **intentionally** (adapter default is 'http') to skip
      // public-callback/server setup. selfUrl/path/encryptKey/verificationToken/
      // verifyToken/verifySignature/host/port only matter for protocol:'http'.
      const httpExtra: Record<string, unknown> = {};
      if (platform.protocol === 'http') {
        for (const k of [
          'selfUrl',
          'path',
          'encryptKey',
          'verificationToken',
          'verifyToken',
          'verifySignature',
        ] as const) {
          if (platform[k] != null) httpExtra[k] = platform[k];
        }
        // Under protocol:'http' LarkBot loads HttpServer, whose inject=['server'].
        // Without a cordis 'server' service it would silently suspend and receive
        // no events, so mount the server service alongside (as in line/wecom).
        installServerService(ctx, {
          host: platform.host ?? '127.0.0.1',
          port: platform.port ?? 8080,
          ...(platform.selfUrl ? { selfUrl: platform.selfUrl } : {}),
        });
      }

      ctx.plugin(resolveDefaultPlugin(LarkAdapter), {
        appId: platform.appId,
        appSecret: platform.appSecret,
        platform: platform.endpoint,
        protocol: platform.protocol,
        ...httpExtra,
      });

      // Learn, from every inbound event, the two things the adapter drops on the floor: a reply
      // anchor for the topic the message sits in, and the declared filename of any attachment.
      // Hooked on 'internal/session' (as mountButtonEvents is) rather than folded into
      // resolveConversation: that method's contract is to DESCRIBE a location, it is called for
      // interactions too, and core may call it more than once per event — none of which should
      // imply a cache write.
      ctx.on('internal/session', (session: Session) => {
        const body = (session.event as { _data?: unknown } | undefined)?._data;
        topics.rememberInbound(body);
        for (const { key, name } of extractResourceNames(body)) {
          rememberBounded(resourceNames, key, name, LARK_CACHE_LIMIT);
        }

        // Rich text: the adapter decodes no content for `msg_type: 'post'`, so give the session
        // the elements it should have had (see larkPostElements for what and why).
        //
        // ⚠️ This is the one place this profile WRITES to a session rather than reading it, and it
        // works for one reason: @satorijs/core's `dispatch` emits 'internal/session' BEFORE the
        // typed events (lib/index.cjs, 2026-09 — `emit('internal/session')`, then the `for (const
        // event of events)` loop). `elements` is a Session accessor over `event.message.elements`,
        // exactly where satori-core's inbound normalization reads it from, so the message reaches
        // core as if the adapter had decoded it. Assigning `content` instead would be wrong: that
        // setter clears `event.message.quote`, which adaptMessage may have just filled in.
        const bot = session.bot as unknown as
          | { getResourceUrl?(type: string, messageId: string, fileKey: string): string }
          | undefined;
        if (!bot?.getResourceUrl) return;
        const rebuilt = larkPostElements(body, (type, messageId, fileKey) =>
          bot.getResourceUrl!(type, messageId, fileKey)
        );
        if (rebuilt) session.elements = rebuilt;
      });
    },

    detectMention(session, selfId) {
      // mentions[] normalize to h.at(open_id,{name}); selfId is the bot's open_id.
      // findAtMention scans at elements.
      return findAtMention(session.elements, selfId);
    },

    resolveConversation(session) {
      // adaptSession sets isDirect=true for chat_type==='p2p'; a topic message additionally
      // carries thread_id, which becomes the lane. See larkConversation.
      return larkConversation(session);
    },

    attachmentMeta() {
      // Lark image/audio/media/file elements carry only an internal resource url, no mime and no
      // size ⇒ return {}. Both are recovered at fetch time instead (sniffed from the bytes,
      // filename from the raw body) — see fetchAttachment.
      return {};
    },

    async fetchAttachment(bot, url) {
      // Lark is the only adapter here that hands out an `internal:` media URL (the other seven
      // emit public https links), so this is also the only fetchAttachment override. Anything
      // that is not one of those URLs is not ours: return undefined and let the generic,
      // SSRF-guarded HTTP downloader have it.
      const res = parseLarkResourceUrl(url);
      if (!res) return undefined;
      const resource = larkMessageApi(bot)?.resource;
      if (!resource) {
        throw new Error(
          `[lark] im.message.resource.get is unavailable; cannot fetch attachment ${res.fileKey}`
        );
      }
      // `type` is required by Feishu and is already correct in the URL the adapter minted.
      const raw = await resource.get(res.messageId, res.fileKey, { type: res.type });
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const sniffed = sniffLarkMedia(bytes);
      // Prefer the name the sender's client stated (a `file`/`media` message has one) over a
      // key + sniffed extension (all an `image`/`audio` message can offer).
      const name = resourceNames.get(res.fileKey) ?? `${res.fileKey}${sniffed?.ext ?? ''}`;
      return { bytes, name, ...(sniffed ? { mime: sniffed.mime } : {}) };
    },

    // send/edit are overridden to pre-render CommonMark → the Feishu subset; the same
    // conversion on both sides ⇒ no send-vs-edit drift. See the profile doc-comment.
    async sendMessage(bot: Bot, address: ConversationAddress, text: string): Promise<MessageRef> {
      // send() also carries the topic lane when the address has one (quote + reply_in_thread);
      // without one this stays the plain create path it has always been.
      return topics.send(bot, address, () => toLarkMarkdown(text), 'sendMessage');
    },

    async editMessage(bot: Bot, ref: MessageRef, text: string): Promise<void> {
      // No local try/catch: classifyError (wired below, applied by satori-core to every call) is
      // what turns a 230072 into MessageNotEditableError now.
      await bot.editMessage(ref.address.channel, ref.messageId, toLarkMarkdown(text));
    },

    async reply(bot: Bot, ref: MessageRef, text: string): Promise<MessageRef> {
      // <quote> ⇒ encoder calls im.message.reply (native quote). Convert the text to the
      // Feishu markdown subset (same as send/edit) before quoting.
      //
      // The anchor is ref.messageId itself — the message being replied to — so no lookup is
      // needed even in a topic. `replyInThread` is passed explicitly when the ref carries a
      // lane: Feishu already threads a reply whose target sits in a topic ("若群聊已经是话题
      // 模式，则自动回复该条消息所在的话题"), but saying so is free and keeps the wire call
      // identical to the one LarkTopicRouter.send makes.
      const thread = ref.address.thread;
      const quote = h('quote', thread != null ? { id: ref.messageId, replyInThread: true } : { id: ref.messageId });
      const sent = await sendForRef(
        bot,
        ref.address,
        [quote, h.text(toLarkMarkdown(text))],
        'lark',
        'reply'
      );
      if (thread != null) topics.rememberAnchor(thread, sent.messageId);
      return sent;
    },

    async sendFile(bot, address, file) {
      // Mirrors satori-core's generic file path (a file:// URL the encoder uploads, caption
      // as the message text) with one addition: the topic lane.
      //
      // ⚠️ Why TWO quote elements. The encoder posts the caption and the file as separate
      // messages — its `flush()` runs before the file upload — and it clears `this.quote`
      // after each post. One leading quote would therefore thread the caption and drop the
      // file into the chat root. Re-arming the quote between them threads both, and the
      // resulting id order (caption first) is exactly what the generic path returns.
      const fileUrl = file.path.startsWith('file:') ? file.path : `file://${file.path}`;
      return topics.send(
        bot,
        address,
        (anchor) => {
          const fragment: h[] = [];
          if (file.caption) {
            fragment.push(h.text(file.caption));
            // Re-arm the quote the encoder is about to consume (see the note above).
            if (anchor) fragment.push(h('quote', { id: anchor, replyInThread: true }));
          }
          fragment.push(h.file(fileUrl, file.name ? { title: file.name } : {}));
          return fragment;
        },
        'sendFile'
      );
    },

    async createThread(bot, ref, name) {
      // Feishu has no "create an empty topic" call: a topic comes into being when a message
      // is replied to with reply_in_thread, so `name` is posted as that opening message.
      // This differs from Telegram's createForumTopic (which names a topic without posting)
      // and from Slack (where a thread is just a message ts and nothing is sent) — it is the
      // only shape the API offers, and autoThread's header text is a reasonable thing to say.
      //
      // ⚠️ If `ref` already sits in a topic, Feishu continues THAT topic instead of nesting a
      // new one. Harmless here: autoThread only fires on kind:'group'.
      const api = larkMessageApi(bot);
      if (!api) {
        throw new Error('[lark] im.message.reply is unavailable; cannot open a topic');
      }
      const res = await api.reply(ref.messageId, {
        msg_type: 'text',
        content: JSON.stringify({ text: name }),
        reply_in_thread: true,
      });
      const threadId = res?.thread_id;
      if (!threadId) {
        // No thread_id means the reply landed as a plain quote (a chat whose settings forbid
        // topics). Throw rather than return the bare channel: the caller (autoThread) already
        // falls back to the original channel and logs it, and pretending a lane exists would
        // send every later message of the turn through a lookup that cannot succeed.
        throw new Error(
          `[lark] reply_in_thread did not open a topic (channel=${ref.address.channel}); the chat may have topics disabled`
        );
      }
      if (res.message_id) topics.rememberAnchor(threadId, res.message_id);
      return { address: { channel: ref.address.channel, thread: threadId } };
    },

    async addReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Lark reactions are limited to the emoji_type enum (not unicode). Unmapped
      // ⇒ safe skip (best-effort, no crash).
      const emojiType = mapLarkEmojiType(emoji);
      if (!emojiType) return;
      const reaction = (
        bot.internal as { im?: { message?: { reaction?: LarkInternalReaction } } }
      )?.im?.message?.reaction;
      await reaction?.create(ref.messageId, { reaction_type: { emoji_type: emojiType } });
    },

    async removeReaction(bot: Bot, ref: MessageRef, emoji: string): Promise<void> {
      // Deleting needs a reaction_id: list this message's reactions of this
      // emoji_type and delete **only** the one this app added. Unmapped ⇒ skip.
      const emojiType = mapLarkEmojiType(emoji);
      if (!emojiType) return;
      const reaction = (
        bot.internal as { im?: { message?: { reaction?: LarkInternalReaction } } }
      )?.im?.message?.reaction;
      if (!reaction) return;
      // ⚠️ Mis-delete guards:
      //  1) list returns a Paginated (Promise + AsyncIterableIterator); awaiting
      //     gives only the first page, so for-await **all pages** or this app's
      //     reaction may be missed if it isn't on page one.
      //  2) Lark delete only checks reaction_id, not emoji/operator — a wrong pick
      //     deletes someone else's or another emoji's reaction. So **never** use
      //     items[0]: require both operator_type==='app' and matching emoji_type
      //     (guards against an ineffective reaction_type query). Not found ⇒ return.
      let reactionId: string | undefined;
      for await (const it of reaction.list(ref.messageId, { reaction_type: emojiType })) {
        if (
          it.operator?.operator_type === 'app' &&
          it.reaction_type?.emoji_type === emojiType
        ) {
          reactionId = it.reaction_id;
          break;
        }
      }
      if (reactionId) await reaction.delete(ref.messageId, reactionId);
    },

    async sendButtons(bot, address, text, buttons): Promise<MessageRef> {
      // Hand-built schema 2.0 card (id in button.behaviors[].value) sent via
      // im.message.create as msg_type='interactive'. Bypasses the satori
      // <button> encoder (it drops button.id, see buildLarkButtonCard).
      const card = buildLarkButtonCard(text, buttons);
      const api = larkMessageApi(bot);
      if (!api) {
        throw new Error('[lark] im.message.create is unavailable; cannot send interactive card');
      }
      const content = JSON.stringify(card);
      // A topic takes the reply route like every other outbound; create() cannot express the
      // lane. Sent straight through im.message.reply rather than sendThreaded because the
      // card must stay msg_type:'interactive' — routing it through the satori encoder would
      // re-encode it as a post.
      const res = address.thread != null
        ? await api.reply(await topics.anchorFor(bot, address.thread), {
            msg_type: 'interactive',
            content,
            reply_in_thread: true,
          })
        : await api.create(
            { receive_id: address.channel, msg_type: 'interactive', content },
            { receive_id_type: larkReceiveIdType(address.channel) }
          );
      const messageId = res?.message_id;
      if (!messageId) {
        throw new Error(`[lark] sendButtons did not return a message id (channel=${address.channel})`);
      }
      if (address.thread != null) topics.rememberAnchor(address.thread, messageId);
      // Remember where this card lives so a click on it resolves to the same conversation the
      // message path would give it (see mountButtonEvents).
      topics.rememberCard(messageId, address);
      return { address, messageId };
    },

    async editButtons(bot, ref, text, buttons): Promise<void> {
      // Same card sendButtons built, re-serialized onto the existing message. A card is patched
      // whole — Feishu has no partial element update — so passing an empty button list simply
      // yields a card with only its markdown element, which is how a menu is retired.
      const api = larkMessageApi(bot);
      if (!api) {
        throw new Error('[lark] im.message.patch is unavailable; cannot update the interactive card');
      }
      await api.patch(ref.messageId, { content: JSON.stringify(buildLarkButtonCard(text, buttons)) });
    },

    mountButtonEvents(ctx: Context, emit: (ev: ProfileButtonEvent) => void): void {
      // ⚠️ Receive path (avoids an adapter pitfall): adapter-lark only normalizes
      // card.action.trigger into interaction/command when
      // action.value._satori_type==='command'; our value is { id } (no
      // _satori_type), so that branch never fires. **But** dispatch emits
      // 'internal/session' for **every** session (before type checks), and
      // adaptSession first setInternal('lark', body). So we hook internal/session
      // and pull the raw lark body back out — a reliable, zero-node_modules-patch
      // way to get the callback.
      ctx.on('internal/session', (session: Session) => {
        // setInternal('lark', body) ⇒ session.event._data === body (raw event).
        const body = (session.event as { _data?: unknown } | undefined)?._data;
        const action = extractCardAction(body);
        if (!action) return;
        // A card.action.trigger body reports open_chat_id and nothing about a topic, so the
        // lane comes from what sendButtons recorded when it posted this card. Unknown card
        // (a restart since it was sent, or a card this daemon never sent) ⇒ the chat root,
        // which is where a card without a lane genuinely lives.
        //
        // kind is reported as 'group' outside a topic: the callback body distinguishes no
        // chat type, and gating never re-reads it for a button click (the daemon resolves the
        // conversation the buttons were sent to, and matches the click by button id).
        const sentTo = topics.cardAddress(action.messageId);
        emit({
          conversation:
            sentTo?.thread != null
              ? { channel: sentTo.channel, thread: sentTo.thread, kind: 'thread' }
              : { channel: action.channelId, kind: 'group' },
          user: action.userId,
          messageId: action.messageId,
          buttonId: action.id,
        });
      });
    },

    // typing / slash / thread: unsupported or semantically misaligned (see
    // capabilities), so not implemented ⇒ satori-core degrades per capabilities.
  };
}

/**
 * Minimal type for the subset of im.message.reaction internal this profile uses.
 * The adapter's internal is generated at runtime and not precisely typed on
 * LarkBot.internal, so we narrow to these three methods. Signatures verified
 * against @satorijs/adapter-lark lib/types/im.d.ts (Reaction.Methods).
 */
interface LarkReactionItem {
  reaction_id?: string;
  operator?: { operator_id?: string; operator_type?: 'app' | 'user' };
  reaction_type?: { emoji_type?: string };
}

interface LarkInternalReaction {
  create(
    messageId: string,
    body: { reaction_type: { emoji_type: string } }
  ): Promise<{ reaction_id?: string }>;
  // The adapter's list returns a Paginated (Promise + AsyncIterableIterator).
  // Deleting must iterate all pages to reliably find this app's reaction, so we
  // type it as AsyncIterable and use for-await.
  list(
    messageId: string,
    query?: { reaction_type?: string }
  ): AsyncIterable<LarkReactionItem>;
  delete(messageId: string, reactionId: string): Promise<unknown>;
}

/**
 * Minimal type for the im.message internal this profile calls directly (interactive cards,
 * topic replies, topic history). Signatures verified against
 * @satorijs/adapter-lark lib/types/im.d.ts.
 *
 * `create` deliberately has no `thread_id` in its receive_id_type union: Feishu does not
 * accept one there (see the file header), which is why `reply` exists on this interface.
 */
interface LarkInternalMessage {
  create(
    body: { receive_id: string; msg_type: string; content: string },
    query: { receive_id_type: 'open_id' | 'union_id' | 'chat_id' | 'email' | 'user_id' }
  ): Promise<{ message_id?: string }>;
  reply(
    messageId: string,
    body: { msg_type: string; content: string; reply_in_thread?: boolean }
  ): Promise<{ message_id?: string; thread_id?: string }>;
  /**
   * 更新已发送的消息卡片 (im-v1/message/patch). The ONLY endpoint that can change a card in place.
   *
   * Not `update`: that one is what `bot.editMessage` reaches, it posts `msg_type:'post'`, and it
   * cannot touch an interactive card — so a card edited through the normal edit path either fails
   * or replaces the card with a post, losing the buttons. Verified signature against
   * @satorijs/adapter-lark lib/types/im.d.ts (Message.Methods.patch, PatchRequest = { content }).
   */
  patch(messageId: string, body: { content: string }): Promise<void>;
  /**
   * GET /im/v1/messages/{message_id}/resources/{file_key}?type=image|file — download an inbound
   * image or file (获取消息中的资源文件). Signature verified against @satorijs/adapter-lark
   * lib/types/im.d.ts (Message.Resource.Methods: `get(message_id, file_key, query?)`), where it is
   * a declared, documented route rather than an internal guess.
   *
   * ⚠️ What is NOT in the types: the route table marks it `type: 'binary'`, so the call sets
   * `responseType: 'arraybuffer'`, returns the RAW body instead of the usual `data.data` unwrap,
   * and — the part that shapes the caller — DISCARDS the response headers, Content-Type included
   * (adapter-lark lib/index.cjs, Internal.define's binary branch, 2026-09). That is why mime and
   * extension are sniffed from the bytes; hermes-agent reads the header, which its SDK exposes.
   *
   * Optional because `internal` is assembled at runtime: a bot without the route must fail with a
   * written message, not a TypeError.
   */
  resource?: {
    get(
      messageId: string,
      fileKey: string,
      query: { type: 'image' | 'file' }
    ): Promise<ArrayBuffer | Uint8Array>;
  };
  // Paginated<T> is a Promise AND an AsyncIterableIterator; only the iteration side is used.
  list(query: {
    container_id_type: 'chat' | 'thread';
    container_id: string;
    sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc';
    page_size?: number;
  }): AsyncIterable<{ message_id?: string }>;
}

/**
 * Narrow bot.internal to the im.message methods above. The adapter builds `internal` at
 * runtime from a route table and LarkBot.internal is typed as `any`-ish, so every call site
 * would otherwise repeat this cast.
 */
function larkMessageApi(bot: Bot): LarkInternalMessage | undefined {
  return (bot.internal as { im?: { message?: LarkInternalMessage } } | undefined)?.im?.message;
}

// authorName note: inbound carries only sender_id.open_id, no display name. Fetching
// it would need an extra blocking getUser(userId) that slows the turn, so this
// profile skips it and leaves authorName undefined (best-effort).
