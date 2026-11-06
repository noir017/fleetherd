/**
 * Keep retrying a Telegram bot's startup until it connects, instead of leaving it offline for good.
 *
 * ── The bug this exists to kill ───────────────────────────────────────────────────────────────────
 * One 502 from `getMe` at daemon start left the Telegram instance offline until the next restart,
 * with nothing in the log but an `[unhandledRejection]` line and, a little earlier, the daemon's own
 * `platform instance "…" started`. The chain, in adapter-telegram 4.5.11 (`lib/index.cjs` is what
 * runs; `src/` has the same code at the lines in brackets):
 *
 * 1. `HttpPolling.connect()` calls `bot.initialize(callback)` without awaiting or catching it
 *    (lib/index.cjs:746-747 [src/polling.ts:11-12]), so `connect()` — and with it satori's
 *    `Bot.start()` and our `ctx.start()` — resolves at once, before any request has answered.
 * 2. `TelegramBot.initialize()` awaits `getLogin()` (= `getMe`), then the callback, then `online()`
 *    (lib/index.cjs:870-875 [src/bot.ts:68-73]). A rejected `getMe` skips both, and the rejection has
 *    nowhere to go but `process.on('unhandledRejection')`.
 * 3. The adapter's own retry lives inside the callback's long-poll loop (lib/index.cjs:786-793), so
 *    it never starts either. The bot stays in CONNECT forever: satori thinks it is still connecting,
 *    and nothing ever tries again.
 *
 * The callback can fail the same way: it sends `getWebhookInfo`, maybe `setWebhook`, and a
 * zero-timeout `getUpdates` before the poll loop starts, and a 502 on any of them escapes exactly as
 * one on `getMe` does.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────────
 * Replace each bot's `initialize()` with one that runs the same three steps in a loop: on a
 * transient failure (5xx, 429, a network error or timeout) it logs that the instance is not online
 * and retries after 5 s, doubling to a 60 s ceiling, for as long as the bot is active; on a
 * permanent one (401 bad token, 404, any other 4xx) it logs an error and takes the bot offline. The
 * promise it returns never rejects. Retrying the callback is safe: everything it does before
 * starting the poll loop is idempotent, and once it has started the loop it cannot throw (the loop
 * is not awaited and catches its own errors), so a retry never starts a second poller.
 *
 * Not covered: once the loop runs, upstream gives its FIRST long poll 7 attempts 5 s apart and then
 * sets OFFLINE for good (lib/index.cjs:786-788). That needs getMe and the setup to succeed and then
 * every poll to fail for 35 s; satori-core's startup watch still reports it.
 *
 * The method is replaced on the instance from satori's `bot-added` event, which `Bot`'s constructor
 * emits before `TelegramBot`'s own constructor body runs and long before `start()` can reach
 * `connect()` — so the listener must be installed before the adapter plugin.
 *
 * ⚠️ HYRUM'S LAW: none of this is API. That `connect()` reaches `bot.initialize` through the
 * instance (so an own property shadows the prototype), what `initialize()` does, and the message
 * format `Internal.define` flattens a Telegram error into (lib/index.cjs:66-82, which discards
 * `response` — the status survives only in the text) are all implementation details of 4.5.11.
 * telegram-start-retry.contract.test.ts drives the real `TelegramBot`, `HttpPolling` and `Internal`
 * (verified 2026-11-06): its first case reproduces the upstream bug and goes red once upstream
 * changes it, which is the moment to ask whether this file is still needed; the rest fail if an
 * upgrade moves what this wraps.
 */
import type { Bot, Context } from '@satorijs/core';

const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

type InitializeCallback = (bot: Bot) => Promise<void>;
type TelegramStartBot = Bot & { initialize(callback: InitializeCallback): Promise<void> };

/** The parts of a plugin-http error (or Telegram's flattened one) that say what went wrong. */
interface ErrorShape {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  response?: { status?: unknown; data?: { error_code?: unknown } };
}

/**
 * The HTTP or Telegram status an error carries, if any.
 *
 * plugin-http's error keeps `response.status` (a 502 page from a proxy has no Telegram body, so
 * Internal.define rethrows it unchanged); a Telegram error body is flattened by Internal.define
 * into `Telegram API error <code>. <description>` with nothing else kept — hence the regex.
 */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { response, message } = error as ErrorShape;
  if (typeof response?.status === 'number') return response.status;
  if (typeof response?.data?.error_code === 'number') return response.data.error_code;
  const match = typeof message === 'string' ? /\bTelegram API error (\d{3})\b/.exec(message) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether a startup failure is worth retrying: 5xx, 429, or no status at all (a refused
 * connection, a reset, a DNS failure, a timeout). Every other status — 401 for a revoked token,
 * 404 for a malformed one, 400 — means the request itself is wrong and retrying cannot fix it.
 */
export function isTransientTelegramStartError(error: unknown): boolean {
  const status = statusOf(error) ?? statusOf((error as ErrorShape | undefined)?.cause);
  return status === undefined || status === 429 || status >= 500;
}

/**
 * One line naming what failed, without the bot token.
 *
 * plugin-http names a failed fetch `fetch <url> failed`, and the URL is
 * `https://api.telegram.org/bot<token>/<method>` — logging it as is would put the token in the
 * daemon log. The real reason of a network failure sits in the cause chain (undici's `fetch failed`
 * wrapping `connect ECONNREFUSED …`), so that is walked too.
 */
export function describeTelegramStartError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    const shape = current as ErrorShape;
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    const code = typeof shape.code === 'string' && !message.includes(shape.code) ? shape.code : '';
    const text = [code, message].filter(Boolean).join(' ');
    if (text && !parts.includes(text)) parts.push(text);
    current = typeof current === 'object' ? shape.cause : undefined;
  }
  const status = statusOf(error);
  let line = parts.join(': ') || String(error);
  if (status !== undefined && !line.includes(String(status))) line = `HTTP ${status} ${line}`;
  return line.replace(/\/bot\d+:[\w-]+/g, '/bot<token>');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // A pending retry must not hold a daemon that is shutting down.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Upstream's initialize() — getLogin, callback, online — retried as a whole. `current` is false
 * once a newer initialize() has started for the same bot (a stop and start), so two loops never
 * race each other.
 */
async function initializeWithRetry(
  bot: TelegramStartBot,
  callback: InitializeCallback,
  instanceId: string,
  current: () => boolean
): Promise<void> {
  const active = (): boolean => bot.isActive && current();
  let retryMs = INITIAL_RETRY_MS;
  while (active()) {
    let step = 'getMe';
    try {
      await bot.getLogin();
      if (!active()) return;
      step = 'polling setup';
      await callback(bot);
    } catch (error) {
      if (!active()) return;
      const reason = describeTelegramStartError(error);
      if (!isTransientTelegramStartError(error)) {
        console.error(
          `[telegram] platform instance "${instanceId}" is offline: startup ${step} failed (${reason}); not retrying — fix the cause and restart the daemon`
        );
        bot.offline(asError(error));
        return;
      }
      console.warn(
        `[telegram] platform instance "${instanceId}" is not online: startup ${step} failed (${reason}); retrying in ${retryMs / 1000}s`
      );
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      continue;
    }
    if (active()) bot.online();
    return;
  }
}

/** Install before the Telegram adapter plugin, on the same context. */
export function installTelegramStartRetry(ctx: Context, instanceId: string): void {
  ctx.on('bot-added', (added) => {
    if (added.adapterName !== 'telegram') return;
    const bot = added as TelegramStartBot;
    let generation = 0;
    bot.initialize = (callback) => {
      const mine = ++generation;
      return initializeWithRetry(bot, callback, instanceId, () => mine === generation);
    };
  });
}
