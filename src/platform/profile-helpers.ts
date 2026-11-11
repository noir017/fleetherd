// Shared pure utilities for platform profiles: collapse the "same decision" repeated across
// profiles (outbound id extraction + error, attachment meta extraction, button message
// fragment, Satori button interaction mounting).
//
// Design principle: collapse only IDENTICAL decisions; where platform SDKs genuinely differ
// (e.g. whether reply carries a quote, ts validation on thread creation), each profile keeps
// its own. Prefer reusing these helpers for new platforms before hand-writing.
import { h } from '@satorijs/core';
import HttpService from '@cordisjs/plugin-http';
import ServerService from '@cordisjs/plugin-server';
import type { Bot, Context, Session } from '@satorijs/core';

import type { ConversationAddress } from '../core/conversation.js';
import type { MessageRef } from '../types.js';
import type { ProfileButtonEvent, ResolvedConversation } from './profile.js';

/**
 * A CJS package imported as ESM default yields the whole module.exports (namespace); the
 * real class/function is on .default. Every profile must unwrap this before installing an
 * adapter / shared service, so it's collapsed here (previously 7 profiles inlined the same
 * lambda). Return type narrowed to what ctx.plugin's first arg accepts.
 */
export function resolveDefaultPlugin(m: unknown): Parameters<Context['plugin']>[0] {
  return ((m as { default?: unknown }).default ?? m) as Parameters<Context['plugin']>[0];
}

/**
 * Install cordis's http service (@cordisjs/plugin-http).
 * Most adapters declare `static inject=['http']`: without the http service provided first,
 * cordis silently suspends the plugin and never instantiates the bot (no bot, no error).
 * Collapses the repeated "unwrap + ctx.plugin(http)" boilerplate across profiles.
 */
export function installHttpService(ctx: Context): void {
  ctx.plugin(resolveDefaultPlugin(HttpService));
}

/**
 * Install the plugin body of cordis's server service (@cordisjs/plugin-server).
 * Note: this helper only collapses the "unwrap + ctx.plugin(server)" shared decision; concrete
 * host/port/selfUrl config is still each profile's call, so config is passed through via the
 * second arg (line/wecom etc. pass config; omitted by default).
 */
export function installServerService(ctx: Context, config?: Record<string, unknown>): void {
  ctx.plugin(resolveDefaultPlugin(ServerService), config);
}

/**
 * Walk Satori elements for a mention node (type==='at' && attrs.id===selfId, i.e. @-mentioned
 * the bot). Collapses the byte-identical 9-line loop in discord/lark/qq/slack. Returns false
 * if selfId or elements is missing.
 */
export function findAtMention(elements: h[] | undefined, selfId: string | undefined): boolean {
  if (!elements || !selfId) return false;
  for (const node of elements) {
    if (node.type === 'at' && (node.attrs?.id as string | undefined) === selfId) return true;
  }
  return false;
}

/**
 * Take the first message id from bot.sendMessage's return; if empty, throw a clear error keyed
 * by platform + op. The error string always contains `did not return a message id` so upper
 * layers / tests can substring-match.
 */
export function firstMessageId(
  ids: string[],
  platform: string,
  op: string,
  channelId: string
): string {
  const id = ids[0];
  if (!id) {
    throw new Error(`[${platform}] ${op} did not return a message id (channel=${channelId})`);
  }
  return id;
}

/**
 * Generic outbound tail: `bot.sendMessage(address.channel, content)` → take first id → build
 * MessageRef. Covers the shared "send then take first id" decision across
 * sendMessage / reply / sendButtons.
 *
 * For profiles whose threads are channels in their own right (Discord) or which have no thread
 * concept at all — a profile that reports a `thread` lane must post via `internal.*` itself,
 * because the Satori encoder has no way to attach it.
 */
export async function sendForRef(
  bot: Bot,
  address: ConversationAddress,
  content: h[] | string,
  platform: string,
  op: string
): Promise<MessageRef> {
  const ids = await bot.sendMessage(address.channel, content);
  return { address, messageId: firstMessageId(ids, platform, op, address.channel) };
}

/**
 * Best-effort mime from Satori element attrs (common keys: mime / type / contentType).
 * Undefined if absent — the download/injection layer falls back to HTTP content-type and
 * extension detection.
 */
export function attrMime(attrs: Record<string, unknown> | undefined): string | undefined {
  if (!attrs) return undefined;
  const v = attrs.mime ?? attrs.type ?? attrs.contentType;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Best-effort byte size from Satori element attrs (common keys: size / fileSize / filesize).
 * Numeric strings accepted; non-finite or negative yields undefined.
 */
export function attrSize(attrs: Record<string, unknown> | undefined): number | undefined {
  if (!attrs) return undefined;
  const raw = attrs.size ?? attrs.fileSize ?? attrs.filesize;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Extract `{ mime, size }` from a single media element's attrs — the standard
 * PlatformProfile.attachmentMeta return. Discord and QQ guild attachmentMeta are byte-identical
 * `{ mime: attrMime, size: attrSize }`, collapsed here: both profiles call
 * `attrAttachmentMeta(el.attrs)` directly. Platforms with very different keys (e.g. Slack always
 * empty, Telegram carries no mime/size) keep their own and don't use this helper.
 */
export function attrAttachmentMeta(
  attrs: Record<string, unknown> | undefined
): { mime?: string; size?: number } {
  return { mime: attrMime(attrs), size: attrSize(attrs) };
}

/**
 * Build an outbound fragment of "optional body + component": text first, component (button
 * group etc.) after. Collapses the repeated
 * `const frag = []; if (text) frag.push(h.text(text)); frag.push(group);` boilerplate.
 */
export function buildButtonMessageFragment(text: string | undefined, group: h): h[] {
  const fragment: h[] = [];
  if (text) fragment.push(h.text(text));
  fragment.push(group);
  return fragment;
}

/**
 * Deferred control flow for "can only run after login" (collapses the same re-registration
 * boilerplate hand-written in discord/telegram).
 *
 * Why: many platforms' slash registration can only be called after the bot truly logs in
 * (gateway READY) — at that moment the bot handle may not be instantiated (getBot throws), or
 * the handle exists but selfId isn't ready. Both profiles previously wrote: "try getBot now → on
 * failure attach ctx.on('login-updated'), wait for status===1, then re-fetch via getBot() and
 * run." Unified here:
 * - Try `getBot()`, then use `opts.isReady` to check the handle is truly ready (Discord also
 *   needs bot.selfId; default isReady treats any non-throwing getBot() as ready). Ready ⇒ run
 *   `fn(bot)` immediately.
 * - getBot() throws (bot not instantiated) or isReady false ⇒ attach login-updated once; when
 *   status===1 (Status.ONLINE), re-fetch via getBot(), re-check isReady, then run fn.
 *
 * Dedup: multiple calls to this helper on the same ctx (multiple registerCommands) attach only
 * one login-updated listener — deduped via a WeakSet flag on ctx, avoiding stacking listeners
 * (Discord originally used a persistent loginHookInstalled flag for the same purpose, now
 * guaranteed internally by the helper). Pending fns queue up and run one by one after login.
 *
 * @param ctx     Platform Context (to attach login-updated).
 * @param getBot  Lazily fetch the bot handle; throws by contract when not ready.
 * @param fn      Side effect to run once the bot is ready (registration etc.); sync/async, best-effort on error.
 * @param opts.isReady  Re-check "truly ready" after the handle is fetched (default always true); false defers to login.
 */
const deferHookCtxs = new WeakSet<object>();

export function deferUntilLogin(
  ctx: Context,
  getBot: () => Bot,
  fn: (bot: Bot) => void | Promise<void>,
  opts?: { isReady?: (bot: Bot) => boolean }
): void {
  const isReady = opts?.isReady ?? ((): boolean => true);
  // Different calls run different fns, so queue pending fns on ctx; the login-updated listener
  // is attached only once and, when fired, runs every queued fn that isReady (prevents stacking
  // listeners across calls).
  const store = ctx as unknown as {
    __fleetherdDeferPending?: Array<(bot: Bot) => void | Promise<void>>;
  };
  if (!store.__fleetherdDeferPending) store.__fleetherdDeferPending = [];

  // Try fetch + readiness immediately: on success run synchronously, no listener needed.
  try {
    const bot = getBot();
    if (isReady(bot)) {
      void Promise.resolve(fn(bot)).catch(() => undefined);
      return;
    }
  } catch {
    // Fall through to the deferred branch below.
  }

  // Not ready (getBot threw or isReady false): enqueue for post-login registration.
  store.__fleetherdDeferPending.push(fn);
  if (!deferHookCtxs.has(ctx as object)) {
    deferHookCtxs.add(ctx as object);
    ctx.on('login-updated', (session: Session) => {
      // The login-updated callback receives a Session; the real status is at
      // session.event.login.status (satori attaches bot.toJSON() on event.login; reading
      // session.status directly is always undefined). Status.ONLINE === 1.
      const status = (session as { event?: { login?: { status?: unknown } } })?.event?.login
        ?.status;
      if (status !== 1) return;
      const pending = store.__fleetherdDeferPending ?? [];
      if (pending.length === 0) return;
      store.__fleetherdDeferPending = [];
      for (const pendingFn of pending) {
        // Re-fetch the handle after login (now ready) and run the pending fn; fn is best-effort.
        void Promise.resolve()
          .then(() => pendingFn(getBot()))
          .catch(() => undefined);
      }
    });
  }
}

/**
 * `resolveConversation` for a platform with NO thread concept: the adapter's channel id is
 * already a complete target, and the only distinction is DM vs group.
 *
 * Used by lark / qq / line / wecom / dingtalk. Telegram, Slack and Discord each have a real
 * thread model and implement their own. Sharing this makes the thread-less case a single
 * decision rather than five copies that could drift apart.
 */
export function plainConversation(session: Session): ResolvedConversation {
  const channel = session.channelId ?? '';
  const space = session.guildId;
  return {
    channel,
    // A guild id equal to the channel id carries no information (several adapters set both to
    // the chat id for a flat group), so it is not reported as a space.
    ...(space && space !== channel ? { space } : {}),
    kind: session.isDirect === true ? 'direct' : 'group',
  };
}

/**
 * Mount the Satori-generic button-click interaction ('interaction/button'):
 * `session.event.button.id` is the button id given at send time, normalized and emitted back.
 * For platforms on this event (telegram / line / qq); when opts.botPlatform is given, only that
 * sub-bot's interactions are received (QQ guild sub-bot 'qqguild'). Discord / Slack / Lark have
 * different button paths and implement their own.
 *
 * The location comes from the profile's OWN `resolveConversation`, passed in by the caller, so a
 * button clicked inside a topic resolves to exactly the conversation the message path would give
 * it. When those disagreed, a blocking `ask` could never match its pending request and sat until
 * timeout.
 *
 * `opts.messageIdOf` overrides `session.messageId` for platforms whose adapter puts something else
 * there on a click. ButtonInteraction.messageId is contractually "the message the button is on",
 * and a caller that edits or reacts to it needs exactly that — see the Telegram profile, whose
 * adapter reports the callback_query id instead.
 */
export function mountSatoriButtonInteraction(
  ctx: Context,
  resolveConversation: (session: Session) => ResolvedConversation,
  emit: (ev: ProfileButtonEvent) => void,
  opts?: { botPlatform?: string; messageIdOf?: (session: Session) => string | undefined }
): void {
  ctx.on('interaction/button', (session: Session) => {
    if (opts?.botPlatform && session.bot.platform !== opts.botPlatform) return;
    const buttonId = session.event?.button?.id;
    if (!buttonId) return;
    emit({
      conversation: resolveConversation(session),
      user: session.userId ?? '',
      messageId: opts?.messageIdOf?.(session) ?? session.messageId ?? '',
      buttonId,
    });
  });
}
