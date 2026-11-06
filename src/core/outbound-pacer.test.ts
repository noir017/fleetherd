import { describe, it, expect } from 'vitest';

import { WriteDroppedError } from './outbound-errors.js';
import { IDLE_SWEEP_MS, OutboundPacer, type PacerClock, type PacerOptions } from './outbound-pacer.js';

/** Manual clock: time only moves when a test says so, and timers fire only when it asks. */
interface FakeClock extends PacerClock {
  setNow(t: number): void;
  /** Advance to `t` and fire every timer due at or before it (repeatedly, so chains settle). */
  advanceTo(t: number): Promise<void>;
  /** Let queued microtasks (the pump's awaits) run. */
  settle(): Promise<void>;
}

function makeClock(): FakeClock {
  let nowVal = 0;
  let pending: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  return {
    now: () => nowVal,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: nowVal + ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    setNow(t: number) {
      nowVal = t;
    },
    async advanceTo(t: number) {
      // Settle first: submitting only STARTS the pump, and the timer it parks is armed a few
      // microtasks later. Looking for timers before that finds none, breaks out, and leaves the
      // lane holding a timer nothing will ever fire.
      await settle();
      // Step to each timer's due time in order, the way a real event loop would — not straight to
      // `t`. Jumping would fire only the timers armed BEFORE the jump and leave every timer those
      // armed in turn parked in the future, so a paced queue would deliver two entries and stop.
      for (let guard = 0; guard < 10_000; guard++) {
        pending = pending.filter((e) => !e.cancelled);
        const next = pending
          .filter((e) => e.at <= t)
          .reduce<(typeof pending)[number] | undefined>(
            (best, e) => (best === undefined || e.at < best.at ? e : best),
            undefined
          );
        if (!next) break;
        pending = pending.filter((e) => e !== next);
        nowVal = Math.max(nowVal, next.at);
        next.fn();
        await settle();
      }
      nowVal = Math.max(nowVal, t);
      await settle();
    },
    settle,
  };
}

function makeOpts(over: Partial<PacerOptions> = {}): PacerOptions {
  return {
    ratePerSec: 1,
    burst: 2,
    globalRatePerSec: 100, // effectively off unless a test lowers it
    globalBurst: 100,
    progressMaxWaitMs: 8_000,
    maxRetryAfterMs: 300_000,
    ...over,
  };
}

/** A job that records when it ran, on the shared `log`. */
function job(
  log: string[],
  name: string,
  over: Partial<{ key: string; instance: string; cls: 'reply' | 'progress' | 'typing'; slot: string }> = {}
) {
  return {
    key: over.key ?? 'tg:chat1',
    instance: over.instance ?? 'tg',
    cls: over.cls ?? ('reply' as const),
    ...(over.slot !== undefined ? { slot: over.slot } : {}),
    run: async (): Promise<string> => {
      log.push(name);
      return name;
    },
  };
}

/** Swallow the rejection so an intentionally-dropped job doesn't surface as unhandled. */
function dropped(p: Promise<unknown>): Promise<unknown> {
  return p.catch((e: unknown) => e);
}

describe('OutboundPacer — token bucket', () => {
  it('an idle chat writes immediately: burst tokens are already waiting', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 2 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'a'));
    void pacer.submit(job(log, 'b'));
    await clock.settle();

    expect(log).toEqual(['a', 'b']); // no time passed at all
  });

  it('past the burst, writes are paced at ratePerSec', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 2, ratePerSec: 1 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'a'));
    void pacer.submit(job(log, 'b'));
    void pacer.submit(job(log, 'c'));
    await clock.settle();
    expect(log).toEqual(['a', 'b']); // 'c' has no token yet

    await clock.advanceTo(1_000); // one token refilled
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('the instance-wide ceiling delays a second chat that is within its own rate', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(
      makeOpts({ burst: 5, ratePerSec: 5, globalBurst: 1, globalRatePerSec: 1 }),
      clock
    );
    const log: string[] = [];

    void pacer.submit(job(log, 'chat1', { key: 'tg:1' }));
    void pacer.submit(job(log, 'chat2', { key: 'tg:2' }));
    await clock.settle();
    expect(log).toEqual(['chat1']); // both chats had lane tokens; the instance had one

    await clock.advanceTo(1_000);
    expect(log).toEqual(['chat1', 'chat2']);
  });
});

describe('OutboundPacer — ordering and coalescing', () => {
  it('FIFO per chat is preserved under interleaved submissions', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1000 }), clock);
    const log: string[] = [];

    for (const n of ['1', '2', '3', '4', '5']) void pacer.submit(job(log, n));
    await clock.advanceTo(100);

    expect(log).toEqual(['1', '2', '3', '4', '5']);
  });

  it('a newer edit replaces a queued one: only the newest content is sent', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker')); // spends the only token
    const stale = dropped(pacer.submit(job(log, 'edit-v1', { slot: 'edit:m1' })));
    void pacer.submit(job(log, 'edit-v2', { slot: 'edit:m1' }));
    await clock.settle();

    expect(await stale).toBeInstanceOf(WriteDroppedError);
    expect((await stale as WriteDroppedError).reason).toBe('superseded');

    await clock.advanceTo(2_000);
    expect(log).toEqual(['blocker', 'edit-v2']); // v1 never ran
  });

  it('the replacement keeps the queue position the older version earned', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1000 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker'));
    void dropped(pacer.submit(job(log, 'edit-v1', { slot: 'edit:m1' })));
    void pacer.submit(job(log, 'later'));
    void pacer.submit(job(log, 'edit-v2', { slot: 'edit:m1' }));
    await clock.advanceTo(100);

    // v2 inherits v1's slot in line, so the bubble still lands ABOVE the text submitted after it.
    expect(log).toEqual(['blocker', 'edit-v2', 'later']);
  });

  it('the same slot in a different chat does not coalesce — two chats are independent', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1000 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'block1', { key: 'tg:1' }));
    void pacer.submit(job(log, 'block2', { key: 'tg:2' }));
    void pacer.submit(job(log, 'chat1-edit', { key: 'tg:1', slot: 'edit:m1' }));
    void pacer.submit(job(log, 'chat2-edit', { key: 'tg:2', slot: 'edit:m1' }));
    await clock.advanceTo(100);

    expect(log).toContain('chat1-edit');
    expect(log).toContain('chat2-edit');
  });

  it('sends are never coalesced: each creates its own message', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1000 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker'));
    void pacer.submit(job(log, 'send-a')); // no slot
    void pacer.submit(job(log, 'send-b'));
    await clock.advanceTo(100);

    expect(log).toEqual(['blocker', 'send-a', 'send-b']);
  });
});

describe('OutboundPacer — what may be dropped', () => {
  it('a progress write past progressMaxWaitMs is discarded without ever running', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(
      makeOpts({ burst: 1, ratePerSec: 1, progressMaxWaitMs: 2_000 }),
      clock
    );
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker'));
    const stale = dropped(pacer.submit(job(log, 'bubble', { cls: 'progress' })));
    await clock.settle();

    pacer.penalize('tg:chat1', 10_000); // the lane is stuck well past the progress budget
    await clock.advanceTo(11_000);

    const err = (await stale) as WriteDroppedError;
    expect(err).toBeInstanceOf(WriteDroppedError);
    expect(err.reason).toBe('timeout');
    expect(log).not.toContain('bubble'); // run() was never called
  });

  it('a reply is never dropped, however long the lane is stuck', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(
      makeOpts({ burst: 1, ratePerSec: 1, progressMaxWaitMs: 2_000 }),
      clock
    );
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker'));
    const answer = pacer.submit(job(log, 'the-answer')); // cls defaults to 'reply'
    await clock.settle();

    pacer.penalize('tg:chat1', 30_000);
    await clock.advanceTo(31_000);

    expect(await answer).toBe('the-answer');
    expect(log).toContain('the-answer');
  });

  it('typing is dropped the moment it cannot go out immediately', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker')); // spends the token
    const err = (await dropped(pacer.submit(job(log, 'typing', { cls: 'typing' })))) as WriteDroppedError;

    expect(err).toBeInstanceOf(WriteDroppedError);
    expect(log).not.toContain('typing');
  });

  it('a failure from run() propagates as itself — only the pacer raises WriteDroppedError', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts(), clock);
    const boom = new Error('platform said no');

    const thrown = await pacer
      .submit({ key: 'tg:1', instance: 'tg', cls: 'reply', run: () => Promise.reject(boom) })
      .catch((e: unknown) => e);

    expect(thrown).toBe(boom);
  });
});

describe('OutboundPacer — penalize', () => {
  it('holds its own lane for exactly the stated time, and no other', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 5, ratePerSec: 5 }), clock);
    const log: string[] = [];

    pacer.penalize('tg:1', 229_000);
    void pacer.submit(job(log, 'held', { key: 'tg:1' }));
    void pacer.submit(job(log, 'free', { key: 'tg:2' }));
    await clock.settle();
    expect(log).toEqual(['free']); // a different chat is untouched

    await clock.advanceTo(228_000);
    expect(log).toEqual(['free']);

    await clock.advanceTo(230_000);
    expect(log).toEqual(['free', 'held']);
  });

  it('the longest pause wins, so a second 429 cannot shorten the first', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts(), clock);

    pacer.penalize('tg:1', 60_000);
    pacer.penalize('tg:1', 5_000);
    expect(pacer.pausedForMs('tg:1')).toBe(60_000);
  });

  it('clamps an absurd wait at maxRetryAfterMs', () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ maxRetryAfterMs: 300_000 }), clock);

    pacer.penalize('tg:1', 86_400_000);
    expect(pacer.pausedForMs('tg:1')).toBe(300_000);
  });

  it('ignores a nonsense wait instead of scheduling against it', () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts(), clock);

    pacer.penalize('tg:1', Number.NaN);
    pacer.penalize('tg:1', -1);
    expect(pacer.pausedForMs('tg:1')).toBe(0);
  });

  it('a dropped write reports the lane pause, so a retry can sleep exactly that long', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(
      makeOpts({ burst: 1, ratePerSec: 1, progressMaxWaitMs: 1_000 }),
      clock
    );
    const log: string[] = [];

    void pacer.submit(job(log, 'blocker'));
    const stale = dropped(pacer.submit(job(log, 'bubble', { cls: 'progress' })));
    await clock.settle();

    pacer.penalize('tg:chat1', 30_000);
    // The drop lands on the progress budget (t=1000), NOT at the end of the 30 s pause: the
    // caller has to hear about it while it can still do something.
    await clock.advanceTo(5_000);

    const err = (await stale) as WriteDroppedError;
    expect(err.reason).toBe('timeout');
    expect(err.retryAfterMs).toBe(29_000); // 30 s pause, 1 s of it elapsed
  });
});

describe('OutboundPacer — drain', () => {
  it('delivers what fits in the budget and reports honest counts', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'a'));
    const queued = [
      dropped(pacer.submit(job(log, 'b'))),
      dropped(pacer.submit(job(log, 'c'))),
    ];
    await clock.settle();
    expect(log).toEqual(['a']); // b and c are still queued

    // Draining ignores the buckets: the queue is somebody's answer, and the process is leaving.
    const result = await pacer.drain(5_000);
    expect(result.delivered).toBe(2);
    expect(result.abandoned).toBe(0);
    expect(log).toEqual(['a', 'b', 'c']);
    await Promise.all(queued);
  });

  it('a zero budget abandons the queue rather than hanging the shutdown', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 1, ratePerSec: 1 }), clock);
    const log: string[] = [];

    void pacer.submit(job(log, 'a'));
    const stranded = dropped(pacer.submit(job(log, 'b')));
    await clock.settle();

    const result = await pacer.drain(0);
    expect(result.delivered).toBe(0);
    expect(result.abandoned).toBe(1);
    expect(((await stranded) as WriteDroppedError).reason).toBe('shutdown');
  });

  it('rejects anything submitted after the drain has begun', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts(), clock);
    await pacer.drain(1_000);

    const err = (await dropped(pacer.submit(job([], 'late')))) as WriteDroppedError;
    expect(err.reason).toBe('shutdown');
  });
});

describe('OutboundPacer — idle lanes', () => {
  it('lets go of a finished lane once its bucket is full again', async () => {
    // The web UI paces each topic apart, so every topic ever written to used to keep a lane.
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 2, ratePerSec: 1 }), clock);
    const log: string[] = [];
    for (let i = 0; i < 50; i++) void pacer.submit(job(log, `t${i}`, { key: `web:main/t${i}` }));
    await clock.settle();
    expect(log).toHaveLength(50);
    expect(pacer.laneCount()).toBe(50);

    await clock.advanceTo(IDLE_SWEEP_MS);
    void pacer.submit(job(log, 'next', { key: 'web:main/new' }));
    await clock.settle();
    expect(pacer.laneCount()).toBe(1);
  });

  it('keeps a lane serving out a pause, and the pause still holds', async () => {
    const clock = makeClock();
    const pacer = new OutboundPacer(makeOpts({ burst: 5, ratePerSec: 5 }), clock);
    const log: string[] = [];
    pacer.penalize('tg:1', 229_000);

    await clock.advanceTo(IDLE_SWEEP_MS);
    void pacer.submit(job(log, 'other', { key: 'tg:2' })); // a write elsewhere runs the sweep
    await clock.settle();
    expect(pacer.pausedForMs('tg:1')).toBe(229_000 - IDLE_SWEEP_MS);

    void pacer.submit(job(log, 'held', { key: 'tg:1' }));
    await clock.advanceTo(228_000);
    expect(log).toEqual(['other']);
    await clock.advanceTo(230_000);
    expect(log).toEqual(['other', 'held']);
  });

  it('keeps a lane whose bucket is still refilling, so it is not handed a fresh burst', async () => {
    const clock = makeClock();
    // One token per 20 s: a minute after spending all five, three are back.
    const pacer = new OutboundPacer(makeOpts({ burst: 5, ratePerSec: 0.05 }), clock);
    const log: string[] = [];
    for (let i = 0; i < 5; i++) void pacer.submit(job(log, `a${i}`, { key: 'tg:1' }));
    await clock.settle();
    expect(log).toHaveLength(5);

    await clock.advanceTo(IDLE_SWEEP_MS + 1);
    void pacer.submit(job(log, 'other', { key: 'tg:2' }));
    await clock.settle();
    for (let i = 0; i < 5; i++) void pacer.submit(job(log, `b${i}`, { key: 'tg:1' }));
    await clock.settle();
    // A lane dropped here would have come back full and sent all five at once.
    expect(log.filter((n) => n.startsWith('b'))).toEqual(['b0', 'b1', 'b2']);
  });
});
