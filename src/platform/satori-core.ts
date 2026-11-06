// Generic Satori adapter core: decoupled from concrete platforms, depends only on
// the PlatformProfile seam. Holds all Satori-generic logic (ctx lifecycle, inbound
// normalization, outbound send/edit/delete, reaction, history); platform-specific
// points are delegated to the profile.
//
// Satori-generic (kept here): bot.sendMessage / editMessage / deleteMessage /
//   createReaction / deleteReaction / getMessageList — all provided by
//   @satorijs/protocol's Methods interface, consistent across platforms.
// Platform-specific (delegated to profile): install / mention/direct/thread detection /
//   attachment meta keys / typing / thread creation / buttons / reply / slash
//   registration / interaction event mounting.
import { Context, h } from '@satorijs/core';
import type { Bot, Session, Universal } from '@satorijs/core';

import type { PlatformInstance } from './config-schemas.js';
import type {
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  SlashCommandSpec,
} from '../types.js';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import { addressListed, addressOf, describeConversation, formatAddress } from '../core/conversation.js';
import type { PlatformAdapter } from './adapter.js';
import type { PlatformProfile } from './profile.js';
import { installProxy } from '../core/proxy.js';
import { installRelativeFileUrlFix } from './satori-file-url.js';

/** The attachment type of a non-image media element: audio stays audio, the rest is a file. */
function fileKind(elementType: string): 'audio' | 'file' {
  return elementType === 'audio' ? 'audio' : 'file';
}

const STARTUP_ONLINE_WARN_MS = 60_000;
/** Satori Login.Status by value: OFFLINE=0, ONLINE=1, CONNECT=2, DISCONNECT=3, RECONNECT=4. */
const STATUS_NAMES = ['offline', 'online', 'connecting', 'disconnecting', 'reconnecting'];

/**
 * Say so when an instance is not online a minute after start, and again when it comes online.
 *
 * `ctx.start()` resolving means each adapter was asked to connect, not that it did:
 * adapter-telegram returns before its first request has answered (telegram-start-retry.ts), and
 * LINE and WeCom turn a failed login into a quiet OFFLINE. The daemon's "started" line used to be
 * the last word on an instance that never came up.
 */
function startupWatch(label: string, instanceId: string, bots: () => Bot[]) {
  let timer: NodeJS.Timeout | undefined;
  let warned = false;
  let startedAt = 0;
  const online = (): boolean => bots().some((b) => b.status === 1);
  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    /** After `ctx.start()`; `since` is when it was called. */
    arm(since: number): void {
      startedAt = since;
      if (online()) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (online()) return;
        warned = true;
        const states = bots().length
          ? bots()
              .map((b) => `bot ${b.selfId ?? '?'} ${STATUS_NAMES[b.status] ?? `status=${b.status}`}`)
              .join(', ')
          : 'the adapter created no bot';
        console.warn(
          `${label} platform instance "${instanceId}" is not online ${STARTUP_ONLINE_WARN_MS / 1000}s after start (${states}); nothing is received or sent through it until it is`
        );
      }, STARTUP_ONLINE_WARN_MS);
      // Never the reason a stopping daemon stays up.
      timer.unref();
    },
    /** A bot came online: the line to log instead of the usual one, if the warning went out. */
    cameOnline(selfId: string): string | undefined {
      disarm();
      if (!warned) return undefined;
      warned = false;
      const after = Math.round((Date.now() - startedAt) / 1000);
      return `${label} platform instance "${instanceId}" is online now, ${after}s after start (bot ${selfId})`;
    },
    disarm,
  };
}

/**
 * Assemble a generic PlatformAdapter from a profile + one platform instance
 * (`platforms.<id>` entry + its id). InboundMessage.platform and interaction
 * events carry the INSTANCE id (what routing/allowFrom match); profile.type is
 * exposed separately as platformType.
 *
 * Bot method signatures verified against https://koishi.chat/api/resources/message.html:
 *   bot.sendMessage(channelId, content) => Promise<string[]> (array of message ids)
 *   bot.editMessage(channelId, messageId, content) => Promise<void>
 *   bot.deleteMessage(channelId, messageId) => Promise<void>
 *   bot.createReaction(channelId, messageId, emoji) / bot.deleteReaction(...)
 *   bot.getMessageList(channelId, next?, direction='before', limit?, order='asc')
 *     => { data: Universal.Message[], prev?, next? }
 */
export async function createSatoriAdapter(
  profile: PlatformProfile,
  instance: PlatformInstance
): Promise<PlatformAdapter> {
  // Channel allowlist (empty = allow all). Matched with addressSelects, so an operator can
  // allowlist a whole chat (`5865716608`, its topics included) or one topic in it
  // (`5865716608/7353`).
  //
  // ⚠️ A whole-chat entry USED to exclude the chat's topics, deliberately, on the grounds that
  // each topic is its own conversation. In a Feishu topic-mode group that made the entry match
  // nothing at all — every message there carries a fresh topic lane — so the bot went silent in
  // the very chat the operator had just allowlisted, with only the (debug-level) drop to show
  // for it. See addressSelects in core/conversation.ts.
  const allow = instance.chat.channels;
  const channelAllowed = (ref: ConversationRef): boolean =>
    allow.length === 0 || addressListed(allow, addressOf(ref));

  /**
   * Guard for the Satori-GENERIC outbound paths: they hand the channel straight to `bot.*`,
   * which cannot express a sub-lane. A lane reaching here means a profile declared a `thread`
   * in resolveConversation but implemented no override to send it — previously that produced a
   * message silently posted to the channel root (Telegram truncates a malformed chat_id
   * leniently in private chats), which is the failure mode this refactor exists to end.
   * Fail loudly instead.
   */
  const assertNoLane = (address: ConversationAddress, op: string): void => {
    if (address.thread != null) {
      throw new Error(
        `[${profile.type}] ${op}: this profile reports a thread lane (${formatAddress(address)}) but implements no ${op} override to address it`
      );
    }
  };

  let onMsg: ((m: InboundMessage) => void) | null = null;
  // Interaction callbacks may not be registered yet this round; safely ignore events until then.
  let onBtn: ((ev: ButtonInteraction) => void) | null = null;
  let onCmd: ((ev: CommandInteraction) => void) | null = null;

  const ctx = new Context();
  // Teach http.file() to accept relative paths before any adapter can call it: without this, every
  // inbound Telegram photo dies in satori's own `http/file` listener. See satori-file-url.ts.
  installRelativeFileUrlFix(ctx);
  // Install outbound proxy first (reads HTTP(S)_PROXY): undici fetch and ws don't honor
  // the proxy automatically, so without this, connecting to Discord/Telegram etc. from
  // behind a firewall ETIMEDOUTs (bot can't connect, sends go nowhere).
  installProxy(ctx);
  profile.install(ctx, instance);

  /**
   * Get an available bot. Inbound events use session.bot; active outbound uses the
   * first bot in ctx.bots matching this platform.
   */
  const getBot = (): Bot => {
    const bot = ctx.bots.find((b) => b.platform === profile.satoriPlatform);
    if (!bot) {
      throw new Error(`satori adapter: no available ${profile.type} bot (not connected?)`);
    }
    return bot;
  };

  /**
   * Normalize session/history elements into { plain text, attachment list }.
   * Images are img/image, audio is audio, files and video are file.
   * Attachment mime/size go through profile.attachmentMeta (keys differ per platform).
   */
  const normalizeElements = (
    elements: h[] | undefined
  ): { text: string; attachments: InboundMessage['attachments'] } => {
    const attachments: NonNullable<InboundMessage['attachments']> = [];
    let text = '';
    const walk = (nodes: h[] | undefined): void => {
      if (!nodes) return;
      for (const node of nodes) {
        switch (node.type) {
          case 'text':
            text += (node.attrs?.content as string | undefined) ?? '';
            break;
          case 'img':
          case 'image': {
            const url = (node.attrs?.src ?? node.attrs?.url) as string | undefined;
            if (url) {
              const meta = profile.attachmentMeta(node);
              attachments.push({
                type: 'image',
                url,
                name: node.attrs?.file as string | undefined,
                // Fill mime/size if the element carries them; otherwise leave undefined.
                mime: meta.mime,
                size: meta.size,
              });
            }
            break;
          }
          case 'file':
          case 'audio':
          case 'video': {
            const url = (node.attrs?.src ?? node.attrs?.url) as string | undefined;
            if (url) {
              const meta = profile.attachmentMeta(node);
              attachments.push({
                // Audio keeps its own type: it is the only evidence a Feishu voice note is audio
                // before it is downloaded (see InboundMessage.attachments).
                type: fileKind(node.type),
                url,
                name: node.attrs?.file as string | undefined,
                mime: meta.mime,
                size: meta.size,
              });
            }
            break;
          }
          case 'quote':
            // Defensive no-op: current adapters never emit quote element nodes — quoted
            // body is extracted via the session.quote → flattenQuote → quotedContent side
            // path. This break guards future adapters: if a platform ever embeds the quoted
            // body in the element tree, skipping it here avoids double-counting it in both
            // this message's text and quotedContent. Quote info isn't lost: quotedContent
            // reads the independent session.quote object.
            break;
          default:
            // Other composite elements (e.g. at-mention): recurse to collect child text.
            if (node.children?.length) walk(node.children);
            break;
        }
      }
    };
    walk(elements);
    return { text: text.trim(), attachments: attachments.length ? attachments : undefined };
  };

  /**
   * Flatten a quoted message (Universal.Message) to plain text for quotedContent.
   * Prefers normalized elements, falls back to content.
   *
   * Known limitation: text-only (normalizeElements().text / content), drops the quoted
   * message's attachments. A quoted message that is pure image/file (no text) returns
   * undefined and quotedContent gets no context. This "quoting an image" context loss is
   * minor; attachment backfill is deferred.
   */
  const flattenQuote = (quote: Universal.Message | undefined): string | undefined => {
    if (!quote) return undefined;
    const text = normalizeElements(quote.elements as h[] | undefined).text;
    return text || quote.content || undefined;
  };

  /** Display name of the quoted message's author. */
  const quoteAuthorName = (quote: Universal.Message | undefined): string | undefined =>
    quote?.user?.name ?? quote?.member?.name ?? quote?.member?.nick ?? undefined;

  /**
   * The message's text: what the element walk found, falling back to the adapter's own `content`
   * only when the walk found NOTHING — no text and no attachment.
   *
   * The fallback is for a message whose elements the walk cannot read. It must not fire for one
   * that is only an attachment, because adapters build `content` by serializing the elements
   * (adapter-telegram 4.5.11: `message.content = segments.join("")`) — for a voice note that is
   * `<audio src="data:audio/opus;base64,…"/>`, the whole recording as base64. That string used to
   * become the prompt: a 25 KB voice note reached the agent as 34,000 characters of base64
   * (observed 2026-09-18), on top of the attachment line that already pointed at the saved file.
   */
  const contentOf = (
    text: string,
    attachments: InboundMessage['attachments'],
    raw: string | undefined
  ): string => text || (attachments ? '' : (raw ?? ''));

  /**
   * Resolve an inbound session to a full ConversationRef.
   *
   * The profile answers the platform-shaped half (channel / thread / space / kind) and core
   * stamps the two fields it owns: the platform INSTANCE id (which the profile doesn't know —
   * `platforms:` may hold the same type twice) and the sender.
   *
   * Applied to EVERY inbound path (message / button / command), so one event's routing key and
   * its reply target can never disagree — the bug that made buttons clicked inside a Telegram
   * topic resolve to the chat root.
   */
  const inboundConversation = (session: Session): ConversationRef => ({
    ...profile.resolveConversation(session),
    platform: instance.id,
    user: session.userId ?? '',
  });

  /** session → InboundMessage. */
  const toInbound = (session: Session): InboundMessage => {
    const { text, attachments } = normalizeElements(session.elements);
    // author is a merged GuildMember & User view; take name/nick whichever is available.
    const author = session.author as
      | { name?: string; nick?: string; isBot?: boolean }
      | undefined;
    return {
      conversation: inboundConversation(session),
      platformType: profile.type,
      messageId: session.messageId ?? '',
      content: contentOf(text, attachments, session.content),
      // session.quote is the quoted message object (with id), present on replies.
      quoteId: session.quote?.id,
      timestamp: session.timestamp ?? Date.now(),
      attachments,
      // ---- Platform-normalized fields (via profile) ----
      authorName: author?.name ?? author?.nick,
      authorIsBot: author?.isBot,
      mentionedSelf: profile.detectMention(session, session.selfId),
      quotedContent: flattenQuote(session.quote),
      quotedAuthor: quoteAuthorName(session.quote),
    };
  };

  /**
   * Universal.Message (from history) → InboundMessage.
   *
   * Replayed messages carry the address they were fetched for. History is per-channel on every
   * platform here (no API filters by sub-lane), so a replayed message's conversation reports the
   * kind of the place it was fetched from rather than guessing per message.
   */
  const messageToInbound = (
    address: ConversationAddress,
    kind: ConversationRef['kind'],
    msg: Universal.Message
  ): InboundMessage => {
    const { text, attachments } = normalizeElements(msg.elements as h[] | undefined);
    return {
      conversation: {
        platform: instance.id,
        channel: address.channel,
        ...(address.thread != null ? { thread: address.thread } : {}),
        kind,
        user: msg.user?.id ?? '',
      },
      platformType: profile.type,
      messageId: msg.id ?? '',
      content: contentOf(text, attachments, msg.content),
      quoteId: msg.quote?.id,
      timestamp: msg.createdAt ?? msg.timestamp ?? Date.now(),
      attachments,
      // Fill what history allows; mentionedSelf has no session context on replay.
      authorName: msg.user?.name ?? msg.user?.nick ?? msg.member?.name ?? msg.member?.nick,
      authorIsBot: msg.user?.isBot,
      quotedContent: flattenQuote(msg.quote),
      quotedAuthor: quoteAuthorName(msg.quote),
    };
  };

  const watch = startupWatch(
    `[${profile.type}]`,
    instance.id,
    () => ctx.bots.filter((b) => b.platform === profile.satoriPlatform)
  );

  // Bot connection-status log. Beyond confirming "online", surface offline/disconnect/reconnect so
  // a silently-dropped gateway (bot can't deliver, turns produce nothing) is visible in the logs
  // instead of looking healthy. Satori Login.Status: OFFLINE=0, ONLINE=1, CONNECT=2, DISCONNECT=3,
  // RECONNECT=4.
  //
  // The listener receives a Session, not a Login: satori's Bot.dispatchLoginEvent puts the login at
  // `session.event.login` (core 4.6.0, lib/index.mjs:356-361). This read `login.status` off the
  // session until 2026-11-06 — always undefined — so every status change, "online" included, went to
  // the debug line below and none of these lines was ever printed.
  ctx.on('login-updated', (session: Session) => {
    const status = session.event.login?.status;
    const selfId = session.selfId ?? '?';
    switch (status) {
      case 1:
        console.log(watch.cameOnline(selfId) ?? `[${profile.type}] bot ${selfId} is online`);
        break;
      case 0:
      case 3:
        console.warn(`[${profile.type}] bot ${selfId} went offline (status=${status}); outbound delivery will fail until it reconnects`);
        break;
      case 4:
        console.warn(`[${profile.type}] bot ${selfId} is reconnecting…`);
        break;
      default:
        // CONNECT (2) and any future status: low-signal, logged at debug only.
        console.debug(`[${profile.type}] bot ${selfId} status=${status}`);
        break;
    }
  });

  // Subscribe to inbound messages: 'message' fires on every received message.
  ctx.on('message', (session: Session) => {
    if (session.userId === session.selfId) return; // ignore own messages
    const inbound = toInbound(session);
    // Allowlist against the SAME address routing uses, rendered in the documented textual
    // form (`<channel>` or `<channel>/<thread>`), so an operator can allowlist a single
    // Telegram topic and it keeps matching.
    if (!channelAllowed(inbound.conversation)) return; // allowlist filter
    const preview = inbound.content.slice(0, 50).replace(/\n/g, ' ');
    console.log(`[in] ${describeConversation(inbound.conversation)} @${inbound.conversation.user}: ${preview}`);
    onMsg?.(inbound);
  });

  // Interaction events mount via profile (event names/payloads differ per platform);
  // no mount = platform has no such interaction. Safely ignored if callback unregistered.
  // Profiles report the platform-shaped conversation via the same resolveConversation as the
  // message path; core stamps the instance id, so downstream identity checks (allowFrom
  // `platform:userId`) and routing see one namespace.
  profile.mountButtonEvents?.(ctx, (ev) => {
    onBtn?.({
      conversation: { ...ev.conversation, platform: instance.id, user: ev.user },
      messageId: ev.messageId,
      buttonId: ev.buttonId,
    });
  });
  profile.mountCommandEvents?.(ctx, (ev) => {
    onCmd?.({
      conversation: { ...ev.conversation, platform: instance.id, user: ev.user },
      messageId: ev.messageId,
      name: ev.name,
      options: ev.options,
      reply: ev.reply,
    });
  });

  // Clear error on missing capability (second line of defense; daemon already gates via
  // capabilities).
  const unsupported = (op: string): never => {
    throw new Error(`[${profile.type}] unsupported operation: ${op}`);
  };

  const adapter: PlatformAdapter = {
    platform: instance.id,
    platformType: profile.type,
    capabilities: profile.capabilities,

    // Rendered-length measure for chunking: delegate to the profile when it renders markdown to a
    // different length/unit (Telegram visible text, WeCom bytes, …); identity otherwise.
    measureRendered(text) {
      return profile.measureRendered ? profile.measureRendered(text) : text.length;
    },

    onMessage(handler) {
      onMsg = handler;
    },

    onButton(handler) {
      onBtn = handler;
    },

    onCommand(handler) {
      onCmd = handler;
    },

    async replyMessage(ref, text) {
      if (!profile.reply) return unsupported('reply');
      return profile.reply(getBot(), ref, text);
    },

    async createThread(ref, name, opts) {
      if (!profile.createThread) return unsupported('createThread');
      return profile.createThread(getBot(), ref, name, opts);
    },

    async renameThread(address, name) {
      if (!profile.renameThread) return unsupported('renameThread');
      return profile.renameThread(getBot(), address, name);
    },

    async sendButtons(address, text, buttons) {
      if (!profile.sendButtons) return unsupported('sendButtons');
      return profile.sendButtons(getBot(), address, text, buttons);
    },

    async editButtons(ref, text, buttons) {
      // No generic fallback to offer, unlike editMessage below: no Satori Bot method carries a
      // component payload, so a platform without its own implementation genuinely cannot do this.
      if (!profile.editButtons) return unsupported('editButtons');
      return profile.editButtons(getBot(), ref, text, buttons);
    },

    async registerCommands(cmds: SlashCommandSpec[], opts) {
      if (!profile.registerCommands) return unsupported('registerCommands');
      await profile.registerCommands(ctx, getBot, cmds, opts);
    },

    async sendMessage(address, text) {
      // Outbound send override takes precedence: a platform whose Satori encoder reads its
      // thread parameter off the inbound session can't address a lane on an outbound-only
      // send, so it posts via internal.* itself. Otherwise the generic bot.sendMessage is
      // correct — those platforms never set address.thread.
      if (profile.sendMessage) {
        return profile.sendMessage(getBot(), address, text);
      }
      assertNoLane(address, 'sendMessage');
      // bot.sendMessage returns string[] (all message ids from this send); take the first.
      const ids = await getBot().sendMessage(address.channel, text);
      const messageId = ids[0];
      if (!messageId) {
        throw new Error(`[${profile.type}] sendMessage did not return a message id (channel=${address.channel})`);
      }
      return { address, messageId };
    },

    async editMessage(ref, text) {
      // Edit override takes precedence: when the platform adapter doesn't wrap editing as
      // generic bot.editMessage (e.g. Slack uses internal.chatUpdate), profile.editMessage
      // implements it; otherwise fall back to generic
      // bot.editMessage(channelId, messageId, content). Editing addresses a message, not a
      // lane, on every platform here — so the channel alone is the right argument.
      if (profile.editMessage) {
        await profile.editMessage(getBot(), ref, text);
      } else {
        await getBot().editMessage(ref.address.channel, ref.messageId, text);
      }
    },

    async deleteMessage(ref) {
      await getBot().deleteMessage(ref.address.channel, ref.messageId);
    },

    async sendFile(address, file) {
      // Profile override takes precedence: a sub-lane (Telegram forum topic) can't be expressed
      // through the generic encoder, which reads the thread only off an inbound session.
      if (profile.sendFile) {
        return profile.sendFile(getBot(), address, file);
      }
      assertNoLane(address, 'sendFile');
      // Send a local file via Satori elements: a file:// URL points at a local path and the
      // encoder uploads it as an attachment. caption becomes the message text.
      const fileUrl = file.path.startsWith('file:') ? file.path : `file://${file.path}`;
      const fragment: h[] = [];
      if (file.caption) fragment.push(h.text(file.caption));
      // h.file(url, attrs): title controls the displayed file name.
      fragment.push(h.file(fileUrl, file.name ? { title: file.name } : {}));
      const ids = await getBot().sendMessage(address.channel, fragment);
      const messageId = ids[0];
      if (!messageId) {
        throw new Error(`[${profile.type}] sendFile did not return a message id (channel=${address.channel})`);
      }
      return { address, messageId };
    },

    async addReaction(ref, emoji) {
      // Reaction override takes precedence: when the adapter doesn't wrap reacting as generic
      // bot.createReaction (e.g. Telegram uses http setMessageReaction, Lark uses
      // internal.im.message.reaction.create), profile.addReaction implements it; otherwise fall
      // back to generic createReaction(channelId, messageId, emoji).
      if (profile.addReaction) {
        await profile.addReaction(getBot(), ref, emoji);
      } else {
        await getBot().createReaction(ref.address.channel, ref.messageId, emoji);
      }
    },

    async removeReaction(ref, emoji) {
      // Override as above; otherwise fall back to generic deleteReaction (no userId => removes
      // own reaction).
      if (profile.removeReaction) {
        await profile.removeReaction(getBot(), ref, emoji);
      } else {
        await getBot().deleteReaction(ref.address.channel, ref.messageId, emoji);
      }
    },

    // Only mounted when the profile implements it, so `adapter.fetchAttachment` being absent is
    // the honest signal that this platform's attachments are plain URLs.
    ...(profile.fetchAttachment
      ? {
          fetchAttachment: (url: string) => profile.fetchAttachment!(getBot(), url),
        }
      : {}),

    async startTyping(address) {
      // typing goes through profile (platform-specific); no-op if not implemented.
      if (profile.typing) await profile.typing(getBot(), address);
    },

    async stopTyping() {
      // typing usually auto-expires; no explicit stop API, so no-op.
    },

    async fetchHistory(address, opts) {
      // bot.getMessageList(channelId, next?/messageId?, direction, limit?, order):
      // 2nd arg is the pagination anchor messageId; direction='before' fetches older history,
      // order='asc' returns data in chronological order. Returns { data: Universal.Message[], ... }.
      // History is per-channel on every platform here — no API filters by sub-lane — so the lane
      // is dropped for the fetch and the replayed messages report the channel they came from.
      const res = await getBot().getMessageList(address.channel, opts.before, 'before', opts.limit, 'asc');
      return res.data.map((m) => messageToInbound({ channel: address.channel }, 'group', m));
    },

    async start() {
      // Start context: connect gateway, the 'message' listener takes effect. Started is not
      // online, so the watch reports an instance that does not come up (startupWatch).
      const since = Date.now();
      await ctx.start();
      watch.arm(since);
    },

    async stop() {
      watch.disarm();
      await ctx.stop();
    },
  };

  return classifying(adapter, profile.classifyError);
}

/**
 * Apply the profile's error classification (see `PlatformProfile.classifyError`) to every call the
 * adapter makes, so the core's failure vocabulary is spoken by ALL of them and not just the one
 * method whose author happened to think of it.
 *
 * Wraps by reflection rather than method by method deliberately: a per-method list is a second
 * copy of the adapter surface, and the copy is what rots. The Lark edit-limit mapping lived inside
 * `editMessage` and nowhere else for exactly that reason.
 *
 * Only a rejected promise is intercepted — a synchronous member (`measureRendered`, `onMessage`,
 * the capability fields) is passed through untouched rather than being promoted to a promise.
 */
function classifying(adapter: PlatformAdapter, classify?: (e: unknown) => unknown): PlatformAdapter {
  if (!classify) return adapter;
  const out: Record<string, unknown> = { ...adapter };
  for (const [name, member] of Object.entries(adapter)) {
    if (typeof member !== 'function') continue;
    out[name] = (...args: unknown[]): unknown => {
      const result = (member as (...a: unknown[]) => unknown).apply(adapter, args);
      if (!(result instanceof Promise)) return result;
      return result.catch((e: unknown) => {
        throw classify(e);
      });
    };
  }
  return out as unknown as PlatformAdapter;
}
