// Slack PlatformProfile: all Slack-specific logic.
// Import from @satorijs/core (not the koishi umbrella) as in the Discord profile: avoids Context
// nominal friction and the koishi loader's ESM class-extends interop bug. Only
// @satorijs/adapter-slack is installed here (no koishi alias), so use it directly.
//
// Capability summary:
//   - thread (thread_ts): carried via composite channelId `<channel>:<thread_ts>`; sendMessage
//     decodes and uses chatPostMessage({thread_ts}); createThread uses a message ts as thread_ts.
//   - editMessage: true in-place edit via internal.chatUpdate(token,{channel,ts,text}).
//
// ⚠️ interactive / slash receiving (see mountButtonEvents/mountCommandEvents):
//   @satorijs/adapter-slack's Socket Mode WsClient.accept() (adapter-slack/src/ws.ts, 2.5.0) only
//   handles `hello` and `events_api` frames and COMPLETELY IGNORES `interactive` (block_actions)
//   and `slash_commands` -- neither dispatching nor ACKing them. The adapter exposes no interaction
//   events. Without patching node_modules, this profile wraps bot.adapter.accept: after each
//   open/reconnect, it appends our own 'message' listener to the socket, parses and ACKs
//   interactive/slash frames, and re-emits them normalized. Works ONLY in Socket Mode
//   (protocol==='ws'); under 'http' (Events API) the adapter's HttpServer only mounts the /slack
//   events endpoint, so interactive/slash request URLs are unhandled -> not received.
//
// ‼️‼️ Hyrum's Law warning (read before upgrading deps) ‼️‼️
//   interactive/slash receiving relies on UNDOCUMENTED internal behavior of @satorijs/adapter-slack
//   and @satorijs/core:
//     - adapter-slack's WsClient.accept() ignores interactive/slash frames (we wrap accept to catch them);
//     - @satorijs/core's WsClientBase.start() sets `this.socket = socket` in the open callback before
//       calling this.accept(socket), and the WsClient constructor sets bot.adapter = this (we read
//       the underlying socket from these spots).
//   None of this is stable API: any minor upgrade may change it WITHOUT error, silently dropping
//   button/slash reception. Mitigation: frame parse+normalize is extracted into pure functions
//   parseSlackInteractiveFrame / parseSlackSlashFrame, pinned by slack.contract.test.ts (the test
//   goes red if frame shapes change). The contract test covers frame->normalize only, NOT the
//   runtime path of obtaining the underlying socket -- that still needs manual regression.
//   For this, package.json pins both deps to EXACT versions (not ^):
//     @satorijs/adapter-slack 2.5.0 / @satorijs/core 4.6.0.
//   Before upgrading these, MANUALLY regression-test Slack button clicks / slash commands (no CI here).
import SlackAdapter from '@satorijs/adapter-slack';
import type { Bot, Context } from '@satorijs/core';

import type { PlatformCapabilities } from '../adapter.js';
import type {
  PlatformProfile,
  ProfileButtonEvent,
  ResolvedConversation,
} from '../profile.js';
import type { SlackPlatformConfig } from '../config-schemas.js';
import {
  findAtMention,
  installHttpService,
  resolveDefaultPlugin,
} from '../profile-helpers.js';
import { renderSlackMarkdown } from '../slack-markdown.js';

/**
 * Render agent CommonMark to Slack mrkdwn, falling back to the raw text on any converter error.
 *
 * Graceful degradation: the converter runs on every streaming edit, so a bug there must never drop
 * a message — sending the raw `**markdown**` (ugly but readable) is strictly better than throwing.
 * Centralized here so sendMessage / editMessage / reply / sendButtons all render identically (the
 * Telegram lesson: send and edit MUST produce the same output, or the message flickers on edit).
 */
function renderMrkdwn(text: string): string {
  try {
    return renderSlackMarkdown(text);
  } catch (e) {
    console.error('[slack] mrkdwn render failed, sending raw text:', e instanceof Error ? e.message : e);
    return text;
  }
}

/**
 * Best-effort mime/size from a Slack inbound attachment element.
 *
 * adapter-slack/utils.ts adaptMessage routes files[] into image/video/audio/file elements by
 * mimetype prefix, but element attrs carry ONLY `{ id }` -- mimetype picks the element type and is
 * not written into attrs; url is file.url_private (needs botToken auth to download). So this always
 * returns {}; the download/inject layer must fall back to HTTP content-type / extension and supply
 * its own Bearer auth.
 */
function slackAttachmentMeta(): { mime?: string; size?: number } {
  return {};
}

/**
 * Slack's conversation shape (pure, for unit testing).
 *
 * -- Inbound thread detection ------------------------------------------------
 * A Slack thread is `thread_ts`, and the adapter exposes no thread flag on the session. What it
 * does do (lib/index.cjs adaptMessage) is:
 *
 *     if (data.thread_ts && data.thread_ts !== data.ts) {
 *       message.quote = await bot.getMessage(payload.channel.id, data.thread_ts);
 *     }
 *
 * — i.e. `quote` is populated ONLY for a genuine thread reply, and `quote.id` is the thread root's
 * ts, which IS the thread_ts. (Slack has no separate "quote a message" primitive that could set it
 * otherwise; quoting in the client posts a link unfurl, which lands in `attachments`.) So the quote
 * is a reliable witness, not a heuristic.
 *
 * This profile used to give up here and hardcode "not a thread", while its OUTBOUND side happily
 * emitted thread addresses — so a reply typed inside a thread was routed as if it were ordinary
 * channel traffic, and answered in the channel.
 */
export function slackConversation(session: {
  channelId?: string;
  guildId?: string;
  isDirect?: boolean;
  quote?: { id?: string };
}): ResolvedConversation {
  const channel = session.channelId ?? '';
  const threadTs = session.quote?.id;
  if (threadTs) {
    return {
      channel,
      thread: threadTs,
      ...(session.guildId ? { space: session.guildId } : {}),
      kind: 'thread',
    };
  }
  return {
    channel,
    ...(session.guildId ? { space: session.guildId } : {}),
    kind: session.isDirect === true ? 'direct' : 'group',
  };
}

/**
 * Build Block Kit outbound blocks (pure, for unit testing).
 *
 * Shape: one section (mrkdwn text) + one actions block (one element per button).
 * - button.action_id and value both carry button.id, so a click round-trips action_id === original id.
 * - style: Slack action buttons accept only 'primary' | 'danger'; anything else (incl. 'secondary'
 *   / none) sets no style, to avoid a Slack 400 on an illegal style.
 * - Slack caps action_id at 255 chars; daemon's `ask:<reqId8>:<index>` is far shorter, no truncation.
 */
export function buildButtonBlocks(
  text: string,
  buttons: Array<{ id: string; label: string; style?: string }>
): unknown[] {
  const blocks: unknown[] = [];
  if (text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }
  // An `actions` block with no elements is rejected by Slack (invalid_blocks), and clearing the
  // buttons off a retired menu is exactly a zero-button call — so the block is omitted, not emptied.
  if (buttons.length === 0) return blocks;
  blocks.push({
    type: 'actions',
    elements: buttons.map((b) => {
      const el: Record<string, unknown> = {
        type: 'button',
        text: { type: 'plain_text', text: b.label, emoji: true },
        action_id: b.id,
        value: b.id,
      };
      if (b.style === 'primary' || b.style === 'danger') el.style = b.style;
      return el;
    }),
  });
  return blocks;
}

/**
 * Parse + normalize one Slack `interactive` (block_actions) raw JSON frame (pure, for unit testing).
 *
 * Hyrum's Law pinning point: this isolates the Socket Mode frame-shape dependency so
 * slack.contract.test.ts can regress it with realistic fake frames. The callback only ACKs + emits.
 *
 * interactive frame shape (Slack Socket Mode):
 *   { type:'interactive', envelope_id, payload:{ type:'block_actions',
 *     user:{id}, channel:{id}, message:{ts}, actions:[{action_id, value}] } }
 *
 * Normalization: one event per action, buttonId === action.action_id (skip if missing).
 * Non-interactive / non-block_actions / parse failure -> null (callback early-returns, no ACK).
 *
 * Structural limitation (not a bug): the click frame carries only the BARE channel in
 * payload.channel.id -- Slack sends no thread_ts with it -- so a button clicked inside a thread
 * resolves to the channel, and a reply to it lands there rather than in the thread. Preserving
 * it would require encoding thread_ts into action_id (the daemon's `ask:<reqId>:<idx>` grammar
 * does not). Reported honestly as kind 'group' rather than guessed.
 */
export function parseSlackInteractiveFrame(raw: string): ProfileButtonEvent[] | null {
  let parsed: {
    type?: string;
    payload?: {
      type?: string;
      user?: { id?: string };
      channel?: { id?: string };
      message?: { ts?: string };
      actions?: Array<{ action_id?: string; value?: string }>;
    };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed.type !== 'interactive') return null;
  const payload = parsed.payload;
  if (!payload || payload.type !== 'block_actions') return null;
  const out: ProfileButtonEvent[] = [];
  for (const a of payload.actions ?? []) {
    const buttonId = a.action_id;
    if (!buttonId) continue;
    out.push({
      conversation: { channel: payload.channel?.id ?? '', kind: 'group' },
      user: payload.user?.id ?? '',
      messageId: payload.message?.ts ?? '',
      buttonId,
    });
  }
  return out;
}

/** Normalized result of parseSlackSlashFrame (platform-agnostic core; reply closure added by the callback). */
export interface SlackSlashParsed {
  name: string;
  /**
   * The invoking channel. Slack's slash frame carries no thread_ts either (same limitation as
   * the interactive frame), so a slash typed inside a thread reports the channel.
   */
  channelId: string;
  userId: string;
  options: Record<string, unknown>;
}

/**
 * Parse + normalize one Slack `slash_commands` raw JSON frame (pure, for unit testing).
 *
 * Hyrum's Law pinning point: same as parseSlackInteractiveFrame -- isolates the frame-shape
 * dependency for the contract test.
 *
 * slash_commands frame shape (Slack Socket Mode):
 *   { type:'slash_commands', envelope_id, payload:{ command:'/help', text:'arg1 arg2',
 *     channel_id, user_id, response_url, trigger_id } }
 *
 * Normalization:
 *  - name = command with leading '/' stripped (no command -> null).
 *  - text -> positional params: options.raw = whole string (trimmed); when non-empty, split on
 *    whitespace into arg0/arg1/...; arg0 also maps to options.name (so /model <name> hits daemon's
 *    ev.options.name directly).
 * Non-slash_commands / no command / parse failure -> null (callback early-returns, no ACK).
 */
export function parseSlackSlashFrame(raw: string): SlackSlashParsed | null {
  let parsed: {
    type?: string;
    payload?: {
      command?: string;
      text?: string;
      channel_id?: string;
      user_id?: string;
    };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed.type !== 'slash_commands') return null;
  const payload = parsed.payload;
  if (!payload || !payload.command) return null;
  const name = payload.command.replace(/^\//, '');
  const rawText = (payload.text ?? '').trim();
  const options: Record<string, unknown> = { raw: rawText };
  if (rawText) {
    rawText.split(/\s+/).forEach((v, i) => {
      options[`arg${i}`] = v;
    });
  }
  if (options.arg0 != null) options.name = options.arg0;
  return {
    name,
    channelId: payload.channel_id ?? '',
    userId: payload.user_id ?? '',
    options,
  };
}

/**
 * unicode emoji -> Slack shortname mapping (pure, for unit testing).
 *
 * Slack `reactions.add` / `reactions.remove` `name` accepts ONLY shortnames (no colons, no unicode):
 * adapter-slack's createReaction/clearReaction pass the string straight as reactionsAdd's `name`
 * (bot.ts, 2.5.0); a unicode codepoint triggers `invalid_name` -> silent failure. But daemon's
 * lifecycle feedback defaults to unicode (👀/✅/❌), so passing it through would silently drop the
 * received/done/error reactions.
 *
 * Normalization (replace on hit, else pass through):
 *  - already `:eyes:`: strip surrounding colons -> `eyes`.
 *  - unicode in the table: replace with its shortname.
 *  - otherwise (unknown unicode / already a bare shortname): pass through (let Slack decide).
 *
 * Table covers daemon defaults + a few common ones; not exhaustive (Slack's shortname list is huge).
 */
const UNICODE_TO_SLACK_SHORTNAME: Record<string, string> = {
  '👀': 'eyes',
  '✅': 'white_check_mark',
  '❌': 'x',
  '👍': '+1',
  '👎': '-1',
  '🎉': 'tada',
  '🔥': 'fire',
  '❤️': 'heart',
  '⚠️': 'warning',
  '🤔': 'thinking_face',
};

export function toSlackReactionName(emoji: string): string {
  // Strip surrounding colons (`:eyes:` -> `eyes`) for callers passing colon-wrapped shortnames.
  const stripped = emoji.replace(/^:+|:+$/g, '');
  // Non-empty and changed (colons removed) means it was already a shortname; use it.
  if (stripped !== emoji && stripped) return stripped;
  // No colons: look up the unicode->shortname table; pass through on miss.
  return UNICODE_TO_SLACK_SHORTNAME[emoji] ?? emoji;
}

/** Minimal SlackBot.internal shape (narrowed to the chat.* methods this profile uses). */
interface SlackInternal {
  chatPostMessage(
    token: string,
    params: Record<string, unknown>
  ): Promise<{ channel: string; ts: string; ok: boolean }>;
  chatUpdate(token: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Narrowed SlackBot view: internal + config.botToken (Bot OAuth Token for Web API auth). */
type SlackBot = Bot & {
  internal: SlackInternal;
  config: { botToken: string };
};

const asSlackBot = (bot: Bot): SlackBot => bot as SlackBot;

/**
 * Append a raw-frame dispatcher to the bot's Socket Mode socket (runtime hook, no node_modules patch).
 *
 * Background: the adapter's WsClient.accept() only handles events_api, ignoring
 * interactive/slash_commands. @satorijs/core's WsClientBase.start() sets `this.socket = socket` in
 * the socket `open` callback before calling `this.accept(socket)` (core 4.6.0), and bot.adapter is
 * that WsClient instance. (The open callback stores the socket, not accept itself, which only
 * processes frames.)
 *
 * Strategy: wrap `adapter.accept` -- after each accept (open/reconnect), append our own 'message'
 * listener to the current `adapter.socket`, so the listener follows whatever socket a reconnect uses.
 *
 * ‼️ Dedup (finding #2): button and slash share ONE SlackSocketHook instance (its attached WeakSet
 *   + wrap flag hoisted to createSlackProfile closure scope), so each socket gets exactly ONE
 *   message listener that runs both handlers in turn. Separate WeakSets would attach the listener
 *   twice per socket and stack pairs on every reconnect (previously avoiding double-ACK was just
 *   a fragile coincidence).
 *
 * Only protocol==='ws' has a WsClient with a socket; under http there's no socket -> hook never
 * fires. Entirely best-effort and try/catch-wrapped: a hook failure only warns, never affecting
 * the adapter's main flow.
 */
class SlackSocketHook {
  /** Sockets already listened to (shared by button/slash, ensuring one listener per socket). */
  private readonly attached = new WeakSet<object>();
  /** Registered raw-frame handlers (one button, one slash); invoked in turn within one listener. */
  private readonly handlers: Array<(raw: string) => void> = [];
  private installed = false;

  constructor(
    private readonly ctx: Context,
    private readonly satoriPlatform: string
  ) {}

  /** Register one handler; on first registration install the bot wrap + login-updated retry (once). */
  register(handle: (raw: string) => void): void {
    this.handlers.push(handle);
    if (this.installed) {
      // Already installed: re-wrap existing bots (covers sockets opened before this handler registered).
      for (const bot of this.ctx.bots) this.wrapBotAccept(bot);
      return;
    }
    this.installed = true;
    // The bot may not exist yet: try existing bots now, and retry on login-updated (online/reconnect).
    for (const bot of this.ctx.bots) this.wrapBotAccept(bot);
    this.ctx.on('login-updated', (session) => {
      // The callback receives a Session with the bot on session.bot; also sweep ctx.bots as a fallback.
      this.wrapBotAccept((session as { bot?: Bot }).bot);
      for (const bot of this.ctx.bots) this.wrapBotAccept(bot);
    });
  }

  /** Dispatch each raw frame to all registered handlers (each try/catch'd, isolated). */
  private dispatch(raw: string): void {
    for (const handle of this.handlers) {
      try {
        handle(raw);
      } catch (e) {
        console.error('[slack] failed to handle interactive/slash frame:', e instanceof Error ? e.message : e);
      }
    }
  }

  /** Attach a single message listener to a socket (deduped via the shared WeakSet). */
  private attachFrameListener(socket: unknown): void {
    if (!socket || typeof socket !== 'object') return;
    if (this.attached.has(socket as object)) return;
    const s = socket as {
      addEventListener?: (type: string, cb: (ev: { data: unknown }) => void) => void;
    };
    if (typeof s.addEventListener !== 'function') return;
    this.attached.add(socket as object);
    s.addEventListener('message', (ev: { data: unknown }) => this.dispatch(String(ev.data)));
  }

  /** Wrap a bot's adapter.accept (flag guards against double-wrapping) and attach any existing socket. */
  private wrapBotAccept(bot: Bot | undefined): void {
    if (!bot || bot.platform !== this.satoriPlatform) return;
    const adapter = (bot as unknown as { adapter?: Record<string, unknown> }).adapter;
    if (!adapter) return;
    // Already wrapped: skip wrapping but still attach the current socket (a reconnect may have swapped it).
    if ((adapter as { __fleetherdHooked?: boolean }).__fleetherdHooked) {
      this.attachFrameListener((adapter as { socket?: unknown }).socket);
      return;
    }
    (adapter as { __fleetherdHooked?: boolean }).__fleetherdHooked = true;
    const origAccept = (adapter as { accept?: (...a: unknown[]) => unknown }).accept;
    if (typeof origAccept === 'function') {
      // Capture the profile instance: the replacement `accept` is a classic function whose own
      // `this` must stay bound to the adapter (we call origAccept.apply(this)), so we can't use an
      // arrow here and need the alias to reach attachFrameListener.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const hook = this;
      (adapter as { accept: (...a: unknown[]) => unknown }).accept = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const ret = origAccept.apply(this, args);
        // core's open callback stored the socket on this.socket and passes it as arg0; use either.
        hook.attachFrameListener((this as { socket?: unknown })?.socket ?? args[0]);
        return ret;
      };
    }
    // If already open at wrap time (socket exists), attach once now.
    this.attachFrameListener((adapter as { socket?: unknown }).socket);
  }
}

/**
 * Slack profile instance. Selected by createSatoriAdapter per cfg.platform.type.
 *
 * API signatures verified against:
 * - Satori generic Bot methods: https://koishi.chat/api/resources/message.html
 *   bot.sendMessage(channelId, content) => Promise<string[]> (message ts array);
 *   deleteMessage / createReaction / clearReaction (all implemented by the Slack adapter).
 * - adapter-slack source:
 *   message.ts visit('quote') => encodes <quote id=ts> to thread_ts (reply = send into thread).
 *   utils.ts adaptMessage => channel_type==='im' sets isDirect; at elements from <@U...>.
 *   bot.ts Config => needs protocol + token (App-Level xapp-) + botToken (OAuth xoxb-).
 *   bot.ts inject=['http'] => http service required first or the bot never instantiates.
 *   types/chat.ts internal.chatPostMessage / chatUpdate (both supportJson=true, whole body JSON).
 */
export function createSlackProfile(): PlatformProfile<SlackPlatformConfig> {
  const capabilities: PlatformCapabilities = {
    // No generic editMessage, but internal.chatUpdate exists (types/chat.ts); the editMessage()
    // override below wraps it for true in-place edits. Note: chat.update is rate-limited (~Tier 3
    // ~50/min), so high-frequency streaming edits may throttle -- StreamBuffer's flood backoff covers it.
    editMessage: true,
    // createReaction -> reactions.add; name must be a shortname (no colons, no unicode). daemon
    // defaults to unicode, so addReaction/removeReaction normalize via toSlackReactionName first.
    reaction: true,
    // No typing in the Slack Web API (only legacy RTM had it) -> false, startTyping is a no-op.
    typing: false,
    // ~3000-char soft limit per block/text (text hard limit is 40000 but >~3000 gets truncated/split).
    maxMessageLength: 3000,
    // Native reply = thread: <quote id=ts> -> thread_ts. Implemented by reply() below.
    reply: true,
    // thread = thread_ts, carried via composite channelId `<channel>:<thread_ts>` (see decodeChannel
    // / sendMessage override). createThread uses a message ts as thread_ts.
    thread: true,
    // Block Kit buttons: send via chatPostMessage({blocks}) (see sendButtons). Receiving wraps the
    // socket to read interactive frames (adapter ignores them by default; see file header). Only
    // Socket Mode receives them, but the send side always works, so true.
    buttons: true,
    // chat.update takes the same `blocks` payload as chatPostMessage, so a posted menu can be
    // advanced in place (see editButtons). Same Tier-3 rate limit as editMessage above; page
    // clicks are nowhere near it.
    editButtons: true,
    // An actions block holds up to 25 elements, so 12 items plus the two page buttons fit in one.
    // Same number as Telegram and Discord on purpose: the page size a user sees should not depend
    // on which chat app they happen to be reading from.
    menuPageSize: 12,
    // slash: registerCommands is a no-op (Slack slash must be registered in the App panel, no
    // runtime API); receiving wraps the socket for slash_commands frames. Like buttons, Socket Mode only.
    slashCommands: true,
    // No runtime slash registration API (must register out-of-band via App panel / manifest) -> false.
    // daemon uses this to skip runtime registerCommands for Slack (which would hit a no-op). Kept
    // separate from slashCommands:true (slash can still be received); the two fields are orthogonal.
    canRegisterSlashAtRuntime: false,
  };

  // button/slash share one socket hook (one raw-frame listener per socket, both handlers run in
  // turn). Closure-scoped per finding #2 -- otherwise separate WeakSets attach twice per socket and
  // stack on reconnect. Instantiated lazily on the first mount* call, bound to ctx.
  let socketHook: SlackSocketHook | undefined;
  const ensureSocketHook = (ctx: Context): SlackSocketHook => {
    socketHook ??= new SlackSocketHook(ctx, 'slack');
    return socketHook;
  };

  return {
    type: 'slack',
    satoriPlatform: 'slack',
    capabilities,

    // Slack counts the mrkdwn string we send; table→bullets / link rewriting can expand it, so chunk
    // by the rendered string length, not the source.
    measureRendered: (text: string) => renderMrkdwn(text).length,

    install(ctx, platform) {
      // SlackBot.inject = ['http']: http service must be provided first, or cordis silently stalls
      // the slack plugin and never instantiates the bot (no bot, no error).
      installHttpService(ctx);

      // Typed credentials (config-schemas.ts): appToken (xapp-, Socket Mode) + botToken
      // (xoxb-, send/reaction); protocol defaults to 'ws'. signing is schema-enforced
      // when protocol==='http' (ConfigSchema.superRefine).
      const config: Record<string, unknown> = {
        protocol: platform.protocol,
        token: platform.appToken,
        botToken: platform.botToken,
      };
      if (platform.protocol === 'http' && platform.signing) {
        config.signing = platform.signing;
      }

      ctx.plugin(resolveDefaultPlugin(SlackAdapter), config);
    },

    detectMention(session, selfId) {
      // Slack has no app_mention normalization (ws.ts only dispatches message events). An @-mention
      // text contains <@U_botid>, normalized into an at element by adaptMarkdown (utils.ts), so scan
      // elements for type==='at' with attrs.id===selfId via findAtMention.
      return findAtMention(session.elements, selfId);
    },

    resolveConversation(session) {
      return slackConversation(session as Parameters<typeof slackConversation>[0]);
    },

    attachmentMeta() {
      return slackAttachmentMeta();
    },

    async reply(bot, ref, text) {
      // Slack native reply = send into thread (thread_ts = ref.messageId). We post via raw
      // internal.chatPostMessage with PRE-RENDERED mrkdwn, NOT bot.sendMessage + <quote>: the Satori
      // encoder maps <quote id> to thread_ts (good) but its escape() would zero-width-space every
      // `*`/`_`/`~` and rewrite our `<url|text>` links as `&lt;...&gt;` (bad). Bypassing keeps reply
      // formatting consistent with sendMessage/editMessage.
      const channel = ref.address.channel;
      const sb = asSlackBot(bot);
      const res = await sb.internal.chatPostMessage(sb.config.botToken, {
        channel,
        thread_ts: ref.messageId,
        text: renderMrkdwn(text),
      });
      const messageId = res.ts;
      if (!messageId) {
        throw new Error(`[slack] reply did not return a message ts (channel=${channel})`);
      }
      // Replying starts (or continues) the target message's thread, so the resulting message lives
      // in that thread -- the ref must say so, or a follow-up on it would leave the thread.
      return { address: { channel, thread: ref.messageId }, messageId };
    },

    async createThread(bot, ref, _name) {
      // Slack has no "create sub-thread" concept: a thread is just "use a message's ts as
      // thread_ts", so no API call is needed (and `name` is unusable). ref.address.channel is
      // always the real channel -- the lane has its own field, so an already-threaded ref can no
      // longer be double-encoded.
      return { address: { channel: ref.address.channel, thread: ref.messageId } };
    },

    async sendMessage(bot, address, text) {
      // Outbound override: post via raw internal.chatPostMessage with PRE-RENDERED mrkdwn (text →
      // renderMrkdwn), deliberately bypassing the Satori MessageEncoder for BOTH composite and
      // non-composite channelIds. Two reasons:
      //  1. mrkdwn correctness: the adapter's escape() zero-width-spaces every `*`/`_`/`~` and
      //     rewrites `<...>` → `&lt;...&gt;`, which would neutralize our `*bold*` and mangle our
      //     `<url|text>` links — so a converted string MUST NOT go back through the encoder.
      //  2. send/edit consistency: editMessage below has no Satori-generic path at all (it must use
      //     chatUpdate), so routing send through chatPostMessage too guarantees both produce
      //     byte-identical mrkdwn — no flicker when a streaming edit replaces the first send.
      // An address carrying a thread posts into it (thread_ts).
      const { channel, thread } = address;
      const sb = asSlackBot(bot);
      const params: Record<string, unknown> = { channel, text: renderMrkdwn(text) };
      if (thread) params.thread_ts = thread;
      const res = await sb.internal.chatPostMessage(sb.config.botToken, params);
      const messageId = res.ts;
      if (!messageId) {
        throw new Error(`[slack] sendMessage did not return a message ts (channel=${channel})`);
      }
      return { address, messageId };
    },

    async editMessage(bot, ref, text) {
      // True in-place edit via internal.chatUpdate (chat.update API) with PRE-RENDERED mrkdwn,
      // mirroring sendMessage so send and edit deliver identical formatting. token = Bot OAuth Token
      // (xoxb-); ts = ref.messageId. chat.update takes no thread parameter -- a message is
      // identified by channel + ts wherever it lives.
      // Let failures throw: StreamBuffer's flood backoff covers it and core's edit sink try/catches.
      const sb = asSlackBot(bot);
      await sb.internal.chatUpdate(sb.config.botToken, {
        channel: ref.address.channel,
        ts: ref.messageId,
        text: renderMrkdwn(text),
      });
    },

    async editButtons(bot, ref, text, buttons) {
      // editMessage's chat.update call plus the Block Kit payload sendButtons builds — the two are
      // deliberately assembled from the same helpers so a page turn cannot render differently from
      // the page it replaces. chat.update takes no thread parameter: channel + ts locate a message
      // wherever it lives, including inside a thread.
      const sb = asSlackBot(bot);
      const rendered = renderMrkdwn(text);
      await sb.internal.chatUpdate(sb.config.botToken, {
        channel: ref.address.channel,
        ts: ref.messageId,
        text: rendered || ' ', // notification/fallback string; Slack requires it non-empty
        blocks: buildButtonBlocks(rendered, buttons),
      });
    },

    async addReaction(bot, ref, emoji) {
      // Decode the real channel, then use Satori's generic createReaction.
      // ‼️ reactions.add's name accepts only shortnames (no colons, no unicode); the adapter passes
      //   the string straight to reactionsAdd. daemon defaults to unicode (👀/✅/❌), which would
      //   trigger invalid_name -> silent failure, so normalize via toSlackReactionName first.
      await bot.createReaction(ref.address.channel, ref.messageId, toSlackReactionName(emoji));
    },

    async removeReaction(bot, ref, emoji) {
      // Same decode + shortname normalization; clearReaction matches by reaction.name (Slack stores
      // shortnames), so emoji must also be a shortname.
      const sb = bot as Bot & {
        clearReaction: (channel: string, ts: string, emoji?: string) => Promise<void>;
      };
      await sb.clearReaction(ref.address.channel, ref.messageId, toSlackReactionName(emoji));
    },

    async sendButtons(bot, address, text, buttons) {
      // Block Kit buttons: section(text) + actions(button elements). Decode the real channel +
      // thread_ts (buttons can be posted inside a thread).
      // ⚠️ Structural limitation (not a bug): even when posted in a thread, Slack's interactive
      //   click frame carries only the BARE channel in payload.channel.id (no thread_ts), so the
      //   channelId from parseSlackInteractiveFrame loses the thread root -- a downstream reply lands
      //   in the channel, not the thread. Preserving the thread would require encoding thread_ts into
      //   action_id/value (daemon's `ask:<reqId>:<idx>` doesn't, so as-is).
      // chatPostMessage blocks go through the supportJson path (whole body JSON), so pass the real
      // array (the .d.ts string type is a form-path leftover; the JSON path wants an array; hence cast).
      // Render the leading text to mrkdwn: the section block is {type:'mrkdwn'} (buildButtonBlocks),
      // so `**bold**` must be converted to `*bold*` exactly like a normal message. The top-level
      // `text` field is only the notification/fallback string, but we reuse the rendered form for
      // consistency.
      const { channel, thread } = address;
      const rendered = renderMrkdwn(text);
      const blocks = buildButtonBlocks(rendered, buttons);
      const sb = asSlackBot(bot);
      const params: Record<string, unknown> = {
        channel,
        text: rendered || ' ', // fallback for notification / no-blocks render; Slack requires non-empty.
        blocks,
      };
      if (thread) params.thread_ts = thread;
      const res = await sb.internal.chatPostMessage(sb.config.botToken, params);
      const messageId = res.ts;
      if (!messageId) {
        throw new Error(`[slack] sendButtons did not return a message ts (channel=${channel})`);
      }
      return { address, messageId };
    },

    async registerCommands(_ctx, _getBot, _cmds) {
      // Slack slash commands must be pre-registered in the App config panel (or manifest) with a
      // Request URL / Socket Mode enabled -- there is NO runtime registration API (unlike Discord's
      // bulkOverwrite or Telegram's setMyCommands). So this is a no-op that just logs. Receiving is
      // handled by mountCommandEvents reading slash_commands frames, provided the command is registered.
      console.log(
        '[slack] slash commands must be pre-registered in the Slack App configuration panel (Slash Commands / app manifest); ' +
          'registerCommands is a runtime no-op, see mountCommandEvents for the receiving side.'
      );
    },

    mountButtonEvents(ctx, emit) {
      // Block Kit button-click receiving.
      //
      // ⚠️ Feasibility: adapter-slack's Socket Mode accept() only handles events_api, ignoring
      //   `interactive` (block_actions) frames and exposing no interaction events. This wraps
      //   adapter.accept via the shared SlackSocketHook, appends a listener on the underlying socket,
      //   and parses + ACKs interactive frames. ONLY Socket Mode (protocol==='ws'); under http the
      //   adapter's HttpServer doesn't handle the interactive endpoint -> not received (hook idle, send still works).
      //
      // Each frame must be ACKed with `{ envelope_id }`, or Slack treats it as failed and resends.
      // Parse+normalize lives in parseSlackInteractiveFrame (contract test: slack.contract.test.ts);
      // this callback only ACKs + emits, early-returning (no ACK) when parse returns null.
      // Registered on the shared socketHook (same hook as mountCommandEvents).
      ensureSocketHook(ctx).register((raw) => {
        const interactions = parseSlackInteractiveFrame(raw);
        if (interactions === null) return;
        // The wrapped listener can't directly reach the socket, so ACK via the slack bot's
        // adapter.socket in ctx.bots. envelope_id is only needed for the ACK, extracted inline here.
        const envelopeId = (JSON.parse(raw) as { envelope_id?: string }).envelope_id;
        ackEnvelope(ctx, envelopeId);
        for (const ev of interactions) emit(ev);
      });
    },

    mountCommandEvents(ctx, emit) {
      // slash command receiving. Feasibility same as mountButtonEvents (Socket Mode only, and the
      // command must already be registered in the panel).
      //
      // Parse+normalize (strip leading '/', split text into arg/raw/name) lives in
      // parseSlackSlashFrame (contract test: slack.contract.test.ts); this callback only ACKs,
      // adds the reply closure, and emits. Registered on the shared socketHook.
      ensureSocketHook(ctx).register((raw) => {
        const parsed = parseSlackSlashFrame(raw);
        if (parsed === null) return;
        const envelopeId = (JSON.parse(raw) as { envelope_id?: string }).envelope_id;
        ackEnvelope(ctx, envelopeId);
        const { name, channelId, userId, options } = parsed;
        emit({
          // The slash frame carries no thread_ts (see SlackSlashParsed), so the command is
          // reported as invoked in the channel itself.
          conversation: { channel: channelId, kind: 'group' },
          user: userId,
          messageId: '',
          name,
          options,
          // The envelope ACK already confirms receipt; the actual user-facing reply goes via
          // chatPostMessage to the same channel (no followup token under Socket Mode; response_url
          // would work but is http-post and rate-limited 5/30min, so chatPostMessage is steadier). best-effort.
          reply: async (text: string) => {
            try {
              const bot = ctx.bots.find((b) => b.platform === 'slack');
              if (!bot) return;
              const sb = asSlackBot(bot);
              await sb.internal.chatPostMessage(sb.config.botToken, { channel: channelId, text });
            } catch (e) {
              console.error('[slack] slash reply failed:', e instanceof Error ? e.message : e);
            }
          },
        });
      });
    },
  };
}

/**
 * ACK a Slack Socket Mode frame (`{ envelope_id }`).
 * Sent via the slack bot's adapter.socket in ctx.bots; if the socket is unavailable, silently skip
 * (Slack resends, but a missed ACK isn't fatal, and this path only fires when a socket exists). best-effort.
 */
function ackEnvelope(ctx: Context, envelopeId: string | undefined): void {
  if (!envelopeId) return;
  try {
    const bot = ctx.bots.find((b) => b.platform === 'slack');
    const adapter = (bot as unknown as { adapter?: { socket?: { send?: (d: string) => void } } })
      ?.adapter;
    const socket = adapter?.socket;
    if (socket && typeof socket.send === 'function') {
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    }
  } catch (e) {
    console.error('[slack] envelope ACK failed:', e instanceof Error ? e.message : e);
  }
}
