import { describe, it, expect } from 'vitest';

import type { ConversationAddress } from '../core/conversation.js';
import { RateLimitedError } from '../core/outbound-errors.js';
import { OutboundPacer, type PacerClock, type PacerOptions } from '../core/outbound-pacer.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { InboundMessage, MessageRef } from '../types.js';
import { outboundLane, withOutboundPacing } from './paced-adapter.js';

function makeClock(): PacerClock & { setNow(t: number): void; settle(): Promise<void> } {
  let nowVal = 0;
  return {
    now: () => nowVal,
    schedule: () => () => undefined, // no test here needs a timer to fire
    setNow: (t: number) => {
      nowVal = t;
    },
    settle: async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

function makeOpts(over: Partial<PacerOptions> = {}): PacerOptions {
  return {
    ratePerSec: 1,
    burst: 50, // generous: these tests are about routing, not about pacing
    globalRatePerSec: 100,
    globalBurst: 100,
    progressMaxWaitMs: 8_000,
    maxRetryAfterMs: 300_000,
    ...over,
  };
}

interface FakeAdapter extends PlatformAdapter {
  calls: string[];
  /** The next call to the named method rejects with `err`. */
  failNext(method: string, err: unknown): void;
}

function makeAdapter(): FakeAdapter {
  const failures = new Map<string, unknown>();
  const record = (name: string) => {
    const err = failures.get(name);
    if (err !== undefined) {
      failures.delete(name);
      return Promise.reject(err);
    }
    return Promise.resolve();
  };

  const adapter: FakeAdapter = {
    calls: [],
    failNext(method, err) {
      failures.set(method, err);
    },
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      editMessage: true,
      reaction: true,
      typing: true,
      maxMessageLength: 4096,
      reply: true,
      thread: true,
      buttons: true,
      editButtons: true,
      slashCommands: true,
    },
    measureRendered: (text: string) => {
      adapter.calls.push('measureRendered');
      return text.length;
    },
    async sendMessage(address: ConversationAddress): Promise<MessageRef> {
      adapter.calls.push(`sendMessage:${address.channel}${address.thread ? `/${address.thread}` : ''}`);
      await record('sendMessage');
      return { address, messageId: 'm1' };
    },
    async editMessage(ref: MessageRef): Promise<void> {
      adapter.calls.push(`editMessage:${ref.messageId}`);
      await record('editMessage');
    },
    async replyMessage(ref: MessageRef): Promise<MessageRef> {
      adapter.calls.push('replyMessage');
      return ref;
    },
    async deleteMessage(): Promise<void> {
      adapter.calls.push('deleteMessage');
    },
    async sendFile(address: ConversationAddress): Promise<MessageRef> {
      adapter.calls.push('sendFile');
      return { address, messageId: 'f1' };
    },
    async addReaction(): Promise<void> {
      adapter.calls.push('addReaction');
    },
    async removeReaction(): Promise<void> {
      adapter.calls.push('removeReaction');
    },
    async startTyping(): Promise<void> {
      adapter.calls.push('startTyping');
    },
    async stopTyping(): Promise<void> {
      adapter.calls.push('stopTyping');
    },
    async fetchHistory(): Promise<InboundMessage[]> {
      adapter.calls.push('fetchHistory');
      return [];
    },
    onMessage() {
      adapter.calls.push('onMessage');
    },
    onButton() {
      adapter.calls.push('onButton');
    },
    onCommand() {
      adapter.calls.push('onCommand');
    },
    async createThread(ref: MessageRef): Promise<{ address: ConversationAddress }> {
      adapter.calls.push('createThread');
      return { address: ref.address };
    },
    async renameThread(): Promise<void> {
      adapter.calls.push('renameThread');
    },
    async sendButtons(address: ConversationAddress): Promise<MessageRef> {
      adapter.calls.push('sendButtons');
      return { address, messageId: 'b1' };
    },
    async editButtons(): Promise<void> {
      adapter.calls.push('editButtons');
    },
    async registerCommands(): Promise<void> {
      adapter.calls.push('registerCommands');
    },
    async start(): Promise<void> {
      adapter.calls.push('start');
    },
    async stop(): Promise<void> {
      adapter.calls.push('stop');
    },
  };
  return adapter;
}

/**
 * What a submitted write has become: `'queued'` when it is still waiting its turn, otherwise the
 * value or error it settled with.
 *
 * "Still queued" is the assertion these tests actually want for a write that must NOT be dropped —
 * awaiting such a promise would simply hang, since the whole point is that it has not resolved.
 */
async function stateOf(p: Promise<unknown>): Promise<unknown> {
  const QUEUED = Symbol('queued');
  // Attach BEFORE draining, and put it first in the race: a `.catch()` added after the drain is
  // itself one microtask behind, so the already-resolved sentinel would win and every settled
  // promise would read as still queued.
  const settled = p.then(
    (v) => ({ v }),
    (e: unknown) => ({ e })
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const race = await Promise.race([settled, Promise.resolve(QUEUED)]);
  if (race === QUEUED) return 'queued';
  const outcome = race as { v?: unknown; e?: unknown };
  return 'e' in outcome ? outcome.e : outcome.v;
}

describe('withOutboundPacing — pass-through fidelity', () => {
  it('forwards the identity and capability fields the daemon gates on', () => {
    const inner = makeAdapter();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts(), makeClock()));

    expect(paced.platform).toBe('tg');
    expect(paced.platformType).toBe('telegram');
    expect(paced.capabilities).toBe(inner.capabilities);
  });

  it('leaves reads, measurement and lifecycle unpaced', async () => {
    const inner = makeAdapter();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 0 }), makeClock()));

    // burst: 0 means nothing paced could run at all — so anything that DOES run is unpaced.
    expect(paced.measureRendered('hello')).toBe(5);
    paced.onMessage(() => undefined);
    await paced.fetchHistory({ channel: 'c1' }, {});
    await paced.start();

    expect(inner.calls).toEqual(['measureRendered', 'onMessage', 'fetchHistory', 'start']);
  });

  it('a write returns the platform’s own result', async () => {
    const inner = makeAdapter();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts(), makeClock()));

    const ref = await paced.sendMessage({ channel: 'c1' }, 'hi');
    expect(ref.messageId).toBe('m1');
  });

  it('a platform failure propagates unchanged', async () => {
    const inner = makeAdapter();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts(), makeClock()));
    const boom = new Error('chat not found');
    inner.failNext('sendMessage', boom);

    await expect(paced.sendMessage({ channel: 'c1' }, 'hi')).rejects.toBe(boom);
  });

  it('forwards topics, presence, and workbench sub-objects verbatim without wrapping or pacing', () => {
    const inner = makeAdapter();
    const topics: NonNullable<PlatformAdapter['topics']> = {
      parentOf: () => undefined,
      childrenOf: () => [],
      hasThread: () => true,
      forkThread: async (source) => ({ address: source, title: 'fork', discard: () => {} }),
    };
    const presence: NonNullable<PlatformAdapter['presence']> = {
      setStatus: () => inner.calls.push('setStatus'),
      setActivity: () => {},
      setPendingQueue: () => {},
      markPendingDelivered: () => {},
      usePendingQueueActions: () => {},
      setOfflineMachines: () => {},
      seenAt: () => undefined,
    };
    const workbench = {
      attachTurnChanges: () => inner.calls.push('attachTurnChanges'),
    } as unknown as NonNullable<PlatformAdapter['workbench']>;
    const withSub = Object.assign(inner, { topics, presence, workbench });
    const paced = withOutboundPacing(withSub, new OutboundPacer(makeOpts({ burst: 0 }), makeClock()));

    expect(paced.topics).toBe(topics);
    expect(paced.presence).toBe(presence);
    expect(paced.workbench).toBe(workbench);
    expect(outboundLane(paced, 'progress').topics).toBe(topics);
    expect(outboundLane(paced, 'progress').presence).toBe(presence);
    expect(outboundLane(paced, 'progress').workbench).toBe(workbench);

    paced.presence?.setStatus({ channel: 'c1' }, { agent: 'cc' });
    paced.workbench?.attachTurnChanges({ channel: 'c1' }, { turn: 1, files: 1, additions: 1, deletions: 0 });
    expect(inner.calls).toEqual(['setStatus', 'attachTurnChanges']);
  });
});

describe('withOutboundPacing — one budget per CHAT', () => {
  it('regression: a thread shares its parent chat’s budget, it does not get its own', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    // Exactly one token: the second write can only go through if it is billed to a different lane.
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: '55' }, 'root');
    void paced.sendMessage({ channel: '55', thread: '7353' }, 'in a topic');
    await clock.settle();

    // Keying by lane would let a forum hand every topic a full allowance and flood the chat.
    expect(inner.calls).toEqual(['sendMessage:55']);
  });

  it('two different chats are independent', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: '55' }, 'a');
    void paced.sendMessage({ channel: '66' }, 'b');
    await clock.settle();

    expect(inner.calls).toEqual(['sendMessage:55', 'sendMessage:66']);
  });

  it('a platform that declares paceByLane gives each lane its own budget', async () => {
    // The web UI: every topic is a lane on one channel and nothing at the far end counts writes,
    // so one topic streaming must not hold back a menu tap in another (2026-10-31: 1–7 s).
    const inner = makeAdapter();
    inner.capabilities.paceByLane = true;
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: 'main', thread: 'busy' }, 'spends the topic’s one token');
    void paced.sendMessage({ channel: 'main', thread: 'busy' }, 'queued behind it');
    void paced.sendMessage({ channel: 'main', thread: 'quiet' }, 'a menu');
    await clock.settle();

    expect(inner.calls).toEqual(['sendMessage:main/busy', 'sendMessage:main/quiet']);
  });

  it('paceByLane still bills a lane-less write to the channel', async () => {
    const inner = makeAdapter();
    inner.capabilities.paceByLane = true;
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: 'main' }, 'a');
    void paced.sendMessage({ channel: 'main' }, 'b');
    await clock.settle();

    expect(inner.calls).toEqual(['sendMessage:main']);
  });

  it('a MessageRef argument is resolved to its chat, same as an address', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: '55' }, 'a');
    void paced.editMessage({ address: { channel: '55' }, messageId: 'm1' }, 'b');
    await clock.settle();

    expect(inner.calls).toEqual(['sendMessage:55']); // the edit was billed to the same lane
  });
});

describe('withOutboundPacing — coalescing', () => {
  it('two queued edits to one message collapse to the newer', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock);
    const paced = withOutboundPacing(inner, pacer);
    const ref = { address: { channel: '55' }, messageId: 'm1' };

    void paced.sendMessage({ channel: '55' }, 'blocker'); // spends the token
    const first = paced.editMessage(ref, 'v1').catch((e: unknown) => e);
    void paced.editMessage(ref, 'v2');
    await clock.settle();

    expect((await first as Error).name).toBe('WriteDroppedError');
  });

  it('edits to DIFFERENT messages in one chat do not collapse into each other', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock);
    const paced = withOutboundPacing(inner, pacer);

    void paced.sendMessage({ channel: '55' }, 'blocker');
    const a = paced.editMessage({ address: { channel: '55' }, messageId: 'm1' }, 'a');
    const b = paced.editMessage({ address: { channel: '55' }, messageId: 'm2' }, 'b');

    // Neither was superseded; both are simply waiting their turn behind the spent token.
    expect(await stateOf(a)).toBe('queued');
    expect(await stateOf(b)).toBe('queued');
  });

  it('sends are never coalesced — each one creates its own message', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock);
    const paced = withOutboundPacing(inner, pacer);

    void paced.sendMessage({ channel: '55' }, 'blocker');
    const a = paced.sendMessage({ channel: '55' }, 'a');
    const b = paced.sendMessage({ channel: '55' }, 'b');

    expect(await stateOf(a)).toBe('queued');
    expect(await stateOf(b)).toBe('queued');
  });
});

describe('withOutboundPacing — lanes', () => {
  it('lane("progress") writes are droppable; the default lane’s are not', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(
      makeOpts({ burst: 1, ratePerSec: 0.001, progressMaxWaitMs: 1_000 }),
      clock
    );
    const paced = withOutboundPacing(inner, pacer);

    void paced.sendMessage({ channel: '55' }, 'blocker');
    const bubble = outboundLane(paced, 'progress').sendMessage({ channel: '55' }, 'tool progress');
    const answer = paced.sendMessage({ channel: '55' }, 'the answer');
    await clock.settle();

    // Move past the progress budget, then kick the lane so it sweeps.
    clock.setNow(5_000);
    void paced.sendMessage({ channel: '55' }, 'kick').catch(() => undefined);

    expect(((await stateOf(bubble)) as Error).name).toBe('WriteDroppedError');
    expect(await stateOf(answer)).toBe('queued'); // the reply is still going out, however late
  });

  it('typing is dropped rather than queued', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock);
    const paced = withOutboundPacing(inner, pacer);

    void paced.sendMessage({ channel: '55' }, 'blocker');
    const typing = await paced.startTyping({ channel: '55' }).catch((e: unknown) => e);

    expect((typing as Error).name).toBe('WriteDroppedError');
    expect(inner.calls).not.toContain('startTyping');
  });

  it('typing that stays on until stopped is never dropped, however busy the chat', async () => {
    // The web UI: a dropped start is not a missed beat but a topic marked idle while its agent works,
    // and the turn's own tool bubbles are what keep its lane busy (2026-10-31).
    const inner = makeAdapter();
    inner.capabilities.typingUntilStopped = true;
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void paced.sendMessage({ channel: 'main', thread: 't' }, 'spends the one token');
    void paced.sendMessage({ channel: 'main', thread: 't' }, 'queued behind it');
    await outboundLane(paced, 'typing').startTyping({ channel: 'main', thread: 't' });

    expect(inner.calls).toEqual(['sendMessage:main/t', 'startTyping']);
  });

  it('outboundLane on an unpaced adapter returns it unchanged', () => {
    const inner = makeAdapter();
    expect(outboundLane(inner, 'progress')).toBe(inner);
  });

  it('lane views of one adapter share the same pacer, so they share the budget', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const paced = withOutboundPacing(inner, new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 0.001 }), clock));

    void outboundLane(paced, 'progress').sendMessage({ channel: '55' }, 'bubble');
    void paced.sendMessage({ channel: '55' }, 'reply');
    await clock.settle();

    expect(inner.calls).toEqual(['sendMessage:55']); // one token, two lanes, one write
  });
});

describe('withOutboundPacing — a stated wait pauses the whole chat', () => {
  it('a RateLimitedError penalizes the lane and still reaches the caller', async () => {
    const inner = makeAdapter();
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts(), clock);
    const paced = withOutboundPacing(inner, pacer);
    const flood = new RateLimitedError('Too Many Requests', { retryAfterMs: 229_000 });
    inner.failNext('editMessage', flood);

    const thrown = await paced
      .editMessage({ address: { channel: '55' }, messageId: 'm1' }, 'x')
      .catch((e: unknown) => e);

    // The caller still learns what happened — the pacer does not swallow it.
    expect(thrown).toBe(flood);
    // ...and every other writer to this chat is held for the same time.
    expect(pacer.pausedForMs('tg:55')).toBe(229_000);
    expect(pacer.pausedForMs('tg:66')).toBe(0);
  });

  it('an ordinary failure does not pause anything', async () => {
    const inner = makeAdapter();
    const pacer = new OutboundPacer(makeOpts(), makeClock());
    const paced = withOutboundPacing(inner, pacer);
    inner.failNext('sendMessage', new Error('socket hang up'));

    await paced.sendMessage({ channel: '55' }, 'x').catch(() => undefined);
    expect(pacer.pausedForMs('tg:55')).toBe(0);
  });
});
