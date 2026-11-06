import { Context, Universal } from '@satorijs/core';
import type { Bot } from '@satorijs/core';
import TelegramAdapter from '@satorijs/adapter-telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHttpService, resolveDefaultPlugin } from './profile-helpers.js';
import { createTelegramProfile } from './profiles/telegram.js';
import { describeTelegramStartError, isTransientTelegramStartError } from './telegram-start-retry.js';

/**
 * Contract test for telegram-start-retry.ts.
 *
 * Everything here runs the real chain — the Telegram profile's install(), satori's Context and Bot,
 * adapter-telegram's TelegramBot, HttpPolling and Internal, plugin-http — with only the global
 * `fetch` replaced by a fake Bot API. Mocking any layer above that would only restate what
 * telegram-start-retry.ts assumes about it: that `connect()` drops initialize()'s promise, that a
 * Telegram error reaches us flattened into a message, that `bot-added` fires before `connect()`.
 *
 * The first case reproduces the upstream bug with the fix NOT installed. When it goes red, upstream
 * has started handling a failed getMe itself and the wrapper may be deletable.
 *
 * Verified against adapter-telegram 4.5.11, @satorijs/core 4.6.0, @cordisjs/plugin-http 0.6.3
 * (2026-11-06).
 */

const TOKEN = '123456:AAE-secret_token';
const USER = { id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot' };

type Reply = { status: number; body: unknown } | Error | 'hang';
type Script = Partial<Record<string, (call: number) => Reply | undefined>>;

const ok = (result: unknown): Reply => ({ status: 200, body: { ok: true, result } });
/** What a proxy or Telegram's front end sends on a 502: an HTML page, no Bot API envelope. */
const badGateway: Reply = { status: 502, body: '<html><body>502 Bad Gateway</body></html>' };
const unauthorized: Reply = { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
/** undici's shape for a refused connection, which plugin-http wraps as `fetch <url> failed`. */
const refused = (): Error =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 149.154.167.220:443'), { code: 'ECONNREFUSED' }),
  });

/**
 * A fake Bot API on the global fetch. Unscripted calls answer like a healthy bot with no webhook
 * and no pending updates; the second getUpdates is the first long poll and is held open until the
 * request is aborted, so fake timers never spin the poll loop.
 */
function fakeTelegram(script: Script = {}): { calls: string[] } {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const defaults: Record<string, (call: number) => Reply> = {
    getMe: () => ok(USER),
    getUserProfilePhotos: () => ok({ total_count: 0, photos: [] }),
    getWebhookInfo: () => ok({ url: '' }),
    getUpdates: (call) => (call === 1 ? ok([]) : 'hang'),
  };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push(method);
    const call = (counts.get(method) ?? 0) + 1;
    counts.set(method, call);
    const reply = script[method]?.(call) ?? defaults[method]?.(call);
    if (!reply) throw new Error(`unexpected Telegram method ${method}`);
    if (reply instanceof Error) throw reply;
    if (reply === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }
    const json = typeof reply.body !== 'string';
    return new Response(json ? JSON.stringify(reply.body) : (reply.body as string), {
      status: reply.status,
      statusText: reply.status === 502 ? 'Bad Gateway' : reply.status === 401 ? 'Unauthorized' : 'OK',
      headers: { 'content-type': json ? 'application/json' : 'text/html' },
    });
  });
  return { calls };
}

/** A context carrying the Telegram profile exactly as satori-core installs it, started. */
async function startProfile(): Promise<{ ctx: Context; bot: () => Bot }> {
  const ctx = new Context();
  createTelegramProfile().install(ctx, { id: 'tg-main', type: 'telegram', token: TOKEN, slash: false } as never);
  await ctx.start();
  await settle();
  const bot = (): Bot => {
    const found = ctx.bots.find((b) => b.platform === 'telegram');
    if (!found) throw new Error('the Telegram plugin created no bot');
    return found;
  };
  return { ctx, bot };
}

/** Let in-flight fetches and their promise chains finish without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const count = (calls: string[], method: string): number => calls.filter((c) => c === method).length;

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let unhandled: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
});

afterEach(() => {
  process.off('unhandledRejection', unhandled);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upstream, without the fix', () => {
  it('drops the rejected getMe: initialize() rejects, polling never starts, the bot stays CONNECT', async () => {
    const { calls } = fakeTelegram({ getMe: () => badGateway });
    const ctx = new Context();
    // Capture the promise HttpPolling.connect() throws away, and handle it so this test's own
    // process does not see the unhandled rejection the daemon used to.
    let escaped: Promise<void> | undefined;
    ctx.on('bot-added', (added) => {
      const bot = added as Bot & { initialize(cb: unknown): Promise<void> };
      const original = bot.initialize.bind(bot);
      bot.initialize = (cb) => {
        escaped = original(cb);
        escaped.catch(() => undefined);
        return escaped;
      };
    });
    installHttpService(ctx);
    ctx.plugin(resolveDefaultPlugin(TelegramAdapter), { protocol: 'polling', token: TOKEN });

    await ctx.start();
    await settle();

    expect(escaped).toBeDefined();
    await expect(escaped).rejects.toMatchObject({ response: { status: 502 } });
    expect(calls).toEqual(['getMe']);
    expect(ctx.bots[0]?.status).toBe(Universal.Status.CONNECT);
    // And nothing upstream tries again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual(['getMe']);
  });
});

describe('Telegram startup through the profile', () => {
  it('retries a 502 on getMe after 5s and then starts polling', async () => {
    const { calls } = fakeTelegram({ getMe: (n) => (n === 1 ? badGateway : undefined) });
    const { bot } = await startProfile();

    expect(calls).toEqual(['getMe']);
    expect(bot().status).toBe(Universal.Status.CONNECT);
    expect(warn).toHaveBeenCalledWith(
      '[telegram] platform instance "tg-main" is not online: startup getMe failed (HTTP 502 Bad Gateway); retrying in 5s'
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(count(calls, 'getMe')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    // getMe, the avatar lookup, webhook check, the offset-initialising getUpdates, the first long poll.
    expect(calls.slice(1)).toEqual(['getMe', 'getUserProfilePhotos', 'getWebhookInfo', 'getUpdates', 'getUpdates']);
    expect(bot().status).toBe(Universal.Status.ONLINE);
    expect(error).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('retries a 502 in the setup before the first poll, not only on getMe', async () => {
    const { calls } = fakeTelegram({ getWebhookInfo: (n) => (n === 1 ? badGateway : undefined) });
    const { bot } = await startProfile();

    expect(warn).toHaveBeenCalledWith(
      '[telegram] platform instance "tg-main" is not online: startup polling setup failed (HTTP 502 Bad Gateway); retrying in 5s'
    );
    expect(count(calls, 'getUpdates')).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(count(calls, 'getUpdates')).toBe(2);
    expect(bot().status).toBe(Universal.Status.ONLINE);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('stops at a 401: one error line, the bot offline, no polling, no retry', async () => {
    const { calls } = fakeTelegram({ getMe: () => unauthorized });
    const { bot } = await startProfile();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[telegram] platform instance "tg-main" is offline: startup getMe failed (Telegram API error 401. Unauthorized); not retrying — fix the cause and restart the daemon'
    );
    expect(bot().status).toBe(Universal.Status.OFFLINE);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual(['getMe']);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('retrying'));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('backs off 5s doubling to 60s on network errors, and never logs the token', async () => {
    const { calls } = fakeTelegram({ getMe: () => refused() });
    await startProfile();
    // 5 + 10 + 20 + 40 + 60 + 60 = 195 s covers six failures after the first.
    await vi.advanceTimersByTimeAsync(195_000);

    const lines = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(lines.map((l: string) => /retrying in (\d+)s$/.exec(l)?.[1])).toEqual(['5', '10', '20', '40', '60', '60', '60']);
    expect(count(calls, 'getMe')).toBe(7);
    expect(lines[0]).toBe(
      '[telegram] platform instance "tg-main" is not online: startup getMe failed (fetch https://api.telegram.org/bot<token>/getMe failed: fetch failed: connect ECONNREFUSED 149.154.167.220:443); retrying in 5s'
    );
    expect(lines.join('\n')).not.toContain('secret');
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('stops retrying once the bot is stopped', async () => {
    const { calls } = fakeTelegram({ getMe: () => badGateway });
    const { bot } = await startProfile();
    await bot().stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual(['getMe']);
  });
});

describe('isTransientTelegramStartError', () => {
  it.each([
    [401, false],
    [404, false],
    [400, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])('treats a flattened Telegram %i as transient=%s', (status, expected) => {
    expect(isTransientTelegramStartError(new Error(`Telegram API error ${status}. test`))).toBe(expected);
  });

  it('reads the status plugin-http keeps on a non-Telegram error page', () => {
    expect(isTransientTelegramStartError(Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }))).toBe(true);
    expect(isTransientTelegramStartError(Object.assign(new Error('Not Found'), { response: { status: 404 } }))).toBe(false);
  });

  it.each([
    new Error('fetch failed'),
    Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('socket closed'), { cause: new Error('ECONNRESET') }),
  ])('retries an error with no status: %s', (e) => {
    expect(isTransientTelegramStartError(e)).toBe(true);
  });
});

describe('describeTelegramStartError', () => {
  it('names the status and the cause, and redacts the token from a URL', () => {
    expect(describeTelegramStartError(Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }))).toBe(
      'HTTP 502 Bad Gateway'
    );
    expect(
      describeTelegramStartError(
        Object.assign(new Error(`fetch https://api.telegram.org/bot${TOKEN}/getMe failed`), { cause: new Error('fetch failed') })
      )
    ).toBe('fetch https://api.telegram.org/bot<token>/getMe failed: fetch failed');
  });
});
