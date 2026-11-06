import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSatoriAdapter } from './satori-core.js';
import type { PlatformProfile } from './profile.js';
import type { PlatformInstance } from './config-schemas.js';
import { h } from '@satorijs/core';
import type { Bot, Context, Session } from '@satorijs/core';

/**
 * satori-core's seam: how a profile's conversation model reaches the generic outbound paths.
 *
 * Why this file exists: deleteMessage / fetchHistory / sendFile hand the channel straight to
 * `bot.*`, and a Satori adapter treats whatever it gets as its chat id. Under the retired
 * composite-string scheme a routing key like `<chat>:<topic>` reached the API verbatim and was
 * rejected — and the original topic fix decoded inside each profile METHOD, so precisely the paths
 * that have no profile override kept the bug.
 *
 * The lane is now a separate field, so it cannot be smuggled into a channel id by accident. What
 * these pin instead is the remaining risk: a profile that REPORTS a lane but implements no
 * override to send it must fail loudly rather than post to the channel root (Telegram accepts a
 * truncated chat id in private chats, so that failure used to look like success).
 *
 * No network: the profile is a stub and the bot is pushed onto ctx.bots (a plain array).
 */

/** Records what the generic paths hand to the underlying bot. */
interface Seen {
  deleted: Array<{ channelId: string; messageId: string }>;
  history: string[];
  sent: Array<{ channelId: string }>;
  profileFile: Array<{ channel: string; thread?: string }>;
}

/**
 * Build an adapter over a stub profile. `lane` decides whether resolveConversation reports a
 * sub-lane, so one harness covers both a topic-carrying platform and a plain one.
 */
async function build(
  opts: { lane?: string; profileSendFile?: boolean; channels?: string[] } = {}
): Promise<{
  adapter: Awaited<ReturnType<typeof createSatoriAdapter>>;
  seen: Seen;
  /** The adapter's own Context, captured in install(), so a test can emit an inbound session. */
  ctx: Context;
  bot: Bot;
}> {
  const seen: Seen = { deleted: [], history: [], sent: [], profileFile: [] };
  let captured: Context | undefined;

  const bot = {
    platform: 'stub',
    selfId: 'self',
    sid: 'stub:self',
    status: 2,
    async sendMessage(channelId: string) {
      seen.sent.push({ channelId });
      return ['m1'];
    },
    async deleteMessage(channelId: string, messageId: string) {
      seen.deleted.push({ channelId, messageId });
    },
    async getMessageList(channelId: string) {
      seen.history.push(channelId);
      return { data: [] };
    },
  } as unknown as Bot;

  const profile: PlatformProfile = {
    type: 'stub',
    satoriPlatform: 'stub',
    capabilities: {
      editMessage: true,
      reaction: true,
      typing: false,
      maxMessageLength: 4096,
      reply: true,
      thread: true,
      buttons: true,
      editButtons: false,
      slashCommands: false,
    },
    // Push our fake bot so getBot() resolves without a real connection.
    install(ctx: Context) {
      ctx.bots.push(bot as never);
      captured = ctx;
    },
    detectMention: () => false,
    resolveConversation: (session: Session) => ({
      channel: session.channelId ?? '',
      ...(opts.lane != null ? { thread: opts.lane } : {}),
      kind: opts.lane != null ? ('thread' as const) : ('group' as const),
    }),
    attachmentMeta: () => ({}),
    ...(opts.profileSendFile
      ? {
          async sendFile(_b: Bot, address: { channel: string; thread?: string }) {
            seen.profileFile.push({ channel: address.channel, thread: address.thread });
            return { address, messageId: 'f1' };
          },
        }
      : {}),
  } as PlatformProfile;

  const instance = {
    id: 'stub1',
    type: 'stub',
    chat: {
      channels: opts.channels ?? [],
      requireMention: true,
      freeResponseChannels: [],
      ignoredChannels: [],
      allowBots: 'none',
    },
  } as unknown as PlatformInstance;

  const adapter = await createSatoriAdapter(profile, instance);
  // install() has run by now, so the context is captured.
  return { adapter, seen, ctx: captured!, bot };
}

describe('generic outbound paths address the channel', () => {
  it('deleteMessage passes the channel, never anything with a lane spliced in', async () => {
    const { adapter, seen } = await build();
    await adapter.deleteMessage({ address: { channel: '-100123' }, messageId: '7' });
    // The old failure mode was the adapter receiving '-100123:99' as a chat id.
    expect(seen.deleted).toEqual([{ channelId: '-100123', messageId: '7' }]);
  });

  it('deleteMessage on a message inside a lane still addresses the plain channel', async () => {
    // Deleting takes no thread parameter on any platform here, so the lane is correctly ignored —
    // but it must not leak into the channel argument either.
    const { adapter, seen } = await build();
    await adapter.deleteMessage({ address: { channel: '-100123', thread: '99' }, messageId: '7' });
    expect(seen.deleted).toEqual([{ channelId: '-100123', messageId: '7' }]);
  });

  it('fetchHistory queries the channel and drops the lane (no API filters by sub-lane)', async () => {
    const { adapter, seen } = await build();
    await adapter.fetchHistory({ channel: '-100123', thread: '99' }, { limit: 10 });
    expect(seen.history).toEqual(['-100123']);
  });

  it('sendFile falls back to the generic encoder when the profile has no override', async () => {
    const { adapter, seen } = await build();
    const ref = await adapter.sendFile({ channel: '-100123' }, { path: '/tmp/x.png' });
    expect(seen.sent).toEqual([{ channelId: '-100123' }]);
    expect(ref.address).toEqual({ channel: '-100123' });
  });

  it('sendFile prefers the profile override and hands it the whole address', async () => {
    const { adapter, seen } = await build({ profileSendFile: true });
    await adapter.sendFile({ channel: '-100123', thread: '99' }, { path: '/tmp/x.png' });
    // The lane is what lets a file reach a topic at all — the generic encoder cannot carry it.
    expect(seen.profileFile).toEqual([{ channel: '-100123', thread: '99' }]);
    expect(seen.sent).toEqual([]); // generic path not used
  });
});

/**
 * The replacement for the old decode-or-corrupt failure mode.
 *
 * A profile that reports a lane but implements no override to send it has a real gap. Silently
 * dropping the lane would post to the channel root and look like success — exactly the shape of
 * the bug this refactor removes — so core refuses instead, naming the operation.
 */
describe('a reported lane with no override fails loudly', () => {
  it('sendMessage refuses rather than posting to the channel root', async () => {
    const { adapter } = await build();
    await expect(
      adapter.sendMessage({ channel: '-100123', thread: '99' }, 'hi')
    ).rejects.toThrow(/sendMessage.*no sendMessage override/);
  });

  it('sendFile refuses rather than uploading to the channel root', async () => {
    const { adapter } = await build();
    await expect(
      adapter.sendFile({ channel: '-100123', thread: '99' }, { path: '/tmp/x.png' })
    ).rejects.toThrow(/sendFile/);
  });

  it('a laneless address takes the generic path unchanged', async () => {
    // Pins that Discord / QQ / Lark / LINE / DingTalk / WeCom keep their exact previous behavior.
    const { adapter, seen } = await build();
    await adapter.sendMessage({ channel: 'C123' }, 'hi');
    expect(seen.sent).toEqual([{ channelId: 'C123' }]);
  });
});

/**
 * The listen allowlist (`chat.channels`).
 *
 * A whole-chat entry has to admit the chat's topics. It did not, deliberately, until a Feishu
 * topic-mode group showed what that costs: there EVERY message carries a freshly minted topic
 * lane, so the chat id — the only thing an operator can write down — matched nothing, and the
 * bot went silent in the chat it had just been allowlisted for.
 */
describe('chat.channels allowlist', () => {
  /** Emit a minimal inbound session through the adapter's own context. */
  async function inboundFrom(opts: { channels?: string[]; lane?: string }): Promise<number> {
    const { adapter, ctx } = await build({ ...opts, profileSendFile: true });
    let received = 0;
    adapter.onMessage(() => {
      received += 1;
    });
    const session = {
      platform: 'stub',
      selfId: 'self',
      userId: 'u1',
      channelId: 'oc_chat',
      messageId: 'm1',
      content: 'hi',
      timestamp: 1,
      elements: [h.text('hi')],
    } as unknown as Session;
    ctx.emit('message', session);
    return received;
  }

  it('an entry naming the chat admits a message from one of its topics', async () => {
    expect(await inboundFrom({ channels: ['oc_chat'], lane: 'omt_1' })).toBe(1);
  });

  it('an entry naming a different chat still drops it', async () => {
    expect(await inboundFrom({ channels: ['oc_other'], lane: 'omt_1' })).toBe(0);
  });

  it('an empty list admits everything, lane or not', async () => {
    expect(await inboundFrom({ lane: 'omt_1' })).toBe(1);
    expect(await inboundFrom({})).toBe(1);
  });

  it('a topic-level entry admits that topic and not the chat root', async () => {
    expect(await inboundFrom({ channels: ['oc_chat/omt_1'], lane: 'omt_1' })).toBe(1);
    expect(await inboundFrom({ channels: ['oc_chat/omt_1'] })).toBe(0);
  });
});

/**
 * A message that is only an attachment.
 *
 * Adapters build `session.content` by serializing the elements (adapter-telegram 4.5.11:
 * `message.content = segments.join("")`), so for a voice note it is the whole recording as a
 * `<audio src="data:audio/opus;base64,…"/>` string. The old `text || session.content` fallback made
 * THAT the prompt — a 25 KB voice note reached the agent as 34,000 characters of base64.
 */
describe('an attachment-only message', () => {
  async function inbound(session: Record<string, unknown>) {
    const { adapter, ctx } = await build({ profileSendFile: true });
    const got: Array<Parameters<Parameters<typeof adapter.onMessage>[0]>[0]> = [];
    adapter.onMessage((m) => void got.push(m));
    ctx.emit('message', {
      platform: 'stub',
      selfId: 'self',
      userId: 'u1',
      channelId: 'c1',
      messageId: 'm1',
      timestamp: 1,
      ...session,
    } as unknown as Session);
    return got[0]!;
  }

  const VOICE = 'data:audio/opus;base64,T2dnUwACAAAAAAAAAAA=';

  it('has empty content, not the serialized element markup', async () => {
    const audio = h('audio', { src: VOICE });
    const msg = await inbound({ elements: [audio], content: [audio].join('') });
    expect(msg.content).toBe('');
    expect(msg.attachments).toHaveLength(1);
  });

  it('keeps an audio element typed as audio (the one clue a Feishu voice note carries)', async () => {
    const msg = await inbound({ elements: [h('audio', { src: VOICE })], content: '' });
    expect(msg.attachments?.[0]?.type).toBe('audio');
    const file = await inbound({ elements: [h('file', { src: 'https://x/y.pdf' })], content: '' });
    expect(file.attachments?.[0]?.type).toBe('file');
    const video = await inbound({ elements: [h('video', { src: 'https://x/y.mp4' })], content: '' });
    expect(video.attachments?.[0]?.type).toBe('file');
  });

  it('still falls back to content when the walk finds nothing at all', async () => {
    const msg = await inbound({ elements: [], content: 'plain text the elements did not carry' });
    expect(msg.content).toBe('plain text the elements did not carry');
  });

  it('keeps a caption as the content', async () => {
    const msg = await inbound({ elements: [h.text('trim this'), h('audio', { src: VOICE })], content: 'x' });
    expect(msg.content).toBe('trim this');
  });
});

/**
 * `ctx.start()` resolving is not a bot being online: adapter-telegram returns before getMe has
 * answered, and a failed login elsewhere is a quiet OFFLINE. The adapter warns once if its instance
 * has no bot online a minute after start, and logs again when one comes up.
 */
describe('startup online watch', () => {
  /** What satori dispatches on a status change: a Session carrying the login at event.login. */
  function setStatus(ctx: Context, bot: Bot, status: number): void {
    bot.status = status;
    ctx.emit('login-updated', { bot, selfId: bot.selfId, event: { login: { status } } } as unknown as Session);
  }

  async function started(): Promise<Awaited<ReturnType<typeof build>> & { warn: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> }> {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const built = await build();
    await built.adapter.start();
    return { ...built, warn, log };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('warns once at 60s without a bot online, and says when it comes online after that', async () => {
    const { adapter, ctx, bot, warn, log } = await started();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[stub] platform instance "stub1" is not online 60s after start (bot self connecting); nothing is received or sent through it until it is'
    );

    await vi.advanceTimersByTimeAsync(30_000);
    setStatus(ctx, bot, 1);
    expect(log).toHaveBeenCalledWith('[stub] platform instance "stub1" is online now, 90s after start (bot self)');
    expect(warn).toHaveBeenCalledTimes(1);

    // A later drop and recovery is the ordinary status log, not a second "after start" line.
    setStatus(ctx, bot, 4);
    setStatus(ctx, bot, 1);
    expect(log).toHaveBeenLastCalledWith('[stub] bot self is online');
    await adapter.stop();
  });

  it('stays quiet when the bot comes online within the minute', async () => {
    const { adapter, ctx, bot, warn, log } = await started();
    await vi.advanceTimersByTimeAsync(5_000);
    setStatus(ctx, bot, 1);
    expect(log).toHaveBeenCalledWith('[stub] bot self is online');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(warn).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('does not warn about an instance that was stopped first', async () => {
    const { adapter, warn } = await started();
    await adapter.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(warn).not.toHaveBeenCalled();
  });
});
