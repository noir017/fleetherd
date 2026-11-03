import { describe, expect, it, vi } from 'vitest';
import { InboundMerger, type MergerDeps } from './inbound-merger.js';
import type { InboundMessage, SteerOutcome } from '../types.js';

/**
 * A message arriving while a turn runs never cancels it: it is offered to the running turn (steer),
 * and what the turn does not take waits behind it and runs as a fresh batch. `/stop` is the only
 * thing that cuts a turn short.
 */

function msg(id: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c', kind: 'group', user: 'u' },
    messageId: id,
    content: id,
    timestamp: 0,
  };
}

const reactions = { received: '👀', done: '✅', error: '❌' };

/** Minimal manual scheduler: schedule() records timers; advance() fires those past due. */
function makeClock() {
  let t = 0;
  const timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    advance(ms: number) {
      t += ms;
      for (const e of timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)) {
        const i = timers.indexOf(e);
        if (i >= 0) timers.splice(i, 1);
        e.fn();
      }
    },
  };
}

/** Flush pending microtasks/macrotasks (real timers, separate from the mocked clock). */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A promise the test settles by hand — a steer the harness has not answered yet. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * `steer` absent = a runtime that cannot take input mid-turn; otherwise it answers each offer. The
 * first turn stays pending until resolveFirst(), so a second message lands mid-run.
 */
function harness(steer?: (batch: InboundMessage[]) => Promise<SteerOutcome>) {
  const clock = makeClock();
  const batches: string[][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let resolveFirst!: () => void;
  let n = 0;
  const abortTurn = vi.fn();
  const onIdle = vi.fn();
  const deps: MergerDeps = {
    now: clock.now,
    schedule: clock.schedule,
    addReaction: vi.fn().mockResolvedValue(undefined),
    runTurn: vi.fn((batch: InboundMessage[], signal?: AbortSignal) => {
      batches.push(batch.map((m) => m.messageId));
      signals.push(signal);
      n += 1;
      if (n === 1) return new Promise<void>((res) => (resolveFirst = res));
      return Promise.resolve();
    }),
    abortTurn,
    onIdle,
    ...(steer ? { steer: vi.fn(steer) } : {}),
  };
  const merger = new InboundMerger({ mergeWindowMs: 1500, maxMergeWindowMs: 5000, reactions }, deps);
  /** [messageId, emoji] for every reaction, in order. */
  const marks = () =>
    vi.mocked(deps.addReaction).mock.calls.map(([ref, emoji]) => [ref.messageId, emoji] as const);
  return { merger, clock, deps, batches, signals, abortTurn, onIdle, marks, resolveFirst: () => resolveFirst() };
}

/** Start the first (held) turn with message m1. */
async function startTurn(h: ReturnType<typeof harness>): Promise<void> {
  await h.merger.ingest(msg('m1'));
  h.clock.advance(1500); // merge window elapses → first turn dispatched (stays pending)
  expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
}

describe('InboundMerger: a message sent mid-turn', () => {
  it('never cancels the running turn: with nothing to take it, it waits and runs next', async () => {
    const h = harness();
    await startTurn(h);

    await h.merger.ingest(msg('m2'));
    await tick();
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.signals[0]?.aborted).toBe(false);
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);

    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2']]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('joins the running turn when the agent takes it: not run again, and marked with that turn', async () => {
    const h = harness(() => Promise.resolve('joined'));
    await startTurn(h);

    await h.merger.ingest(msg('m2'));
    await tick();
    expect(h.deps.steer).toHaveBeenCalledWith([expect.objectContaining({ messageId: 'm2' })]);
    expect(h.abortTurn).not.toHaveBeenCalled();

    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1']]); // answered inside the first turn
    // The turn's ✅ lands on the message it joined too — that reply answers both.
    expect(h.marks()).toEqual([
      ['m1', '👀'],
      ['m2', '👀'],
      ['m1', '✅'],
      ['m2', '✅'],
    ]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('is not run again when the agent answers it outside the turn (detached)', async () => {
    const h = harness(() => Promise.resolve('detached'));
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();
    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1']]);
  });

  it('waits behind the turn when the agent refuses it, and runs as the next batch', async () => {
    const h = harness(() => Promise.resolve('refused'));
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2']]);
  });

  it('treats a steer that throws as refused — the message is still ours to send', async () => {
    const h = harness(() => Promise.reject(new Error('ipc down')));
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();
    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2']]);
  });

  it('keeps arrival order: once one waits behind the turn, later ones are not offered past it', async () => {
    // m2 is refused (say, a slash command); m3 would be taken — but taking it would answer m3
    // before m2, so it queues behind m2 instead.
    const h = harness((batch) => Promise.resolve(batch[0]!.messageId === 'm2' ? 'refused' : 'joined'));
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await h.merger.ingest(msg('m3'));
    await tick();
    expect(h.deps.steer).toHaveBeenCalledTimes(1);
    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2', 'm3']]);
  });

  it('decides offers one at a time, in arrival order', async () => {
    const first = deferred<SteerOutcome>();
    const answers = [first.promise, Promise.resolve<SteerOutcome>('joined')];
    const h = harness(() => answers.shift()!);
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await h.merger.ingest(msg('m3'));
    await tick();
    expect(h.deps.steer).toHaveBeenCalledTimes(1); // m3 waits for m2's answer
    first.resolve('joined');
    await tick();
    expect(vi.mocked(h.deps.steer!).mock.calls.map((c) => c[0][0]!.messageId)).toEqual(['m2', 'm3']);
  });

  it('starts the next turn itself when the turn ended while it was being offered', async () => {
    const answer = deferred<SteerOutcome>();
    const h = harness(() => answer.promise);
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();

    h.resolveFirst(); // the turn ends with the offer still undecided
    await tick();
    // Not idle: the undecided offer is about to become the next turn, and the registry must not
    // reclaim the child that turn needs.
    expect(h.merger.isIdle()).toBe(false);
    expect(h.onIdle).not.toHaveBeenCalled();

    answer.resolve('refused'); // nothing left to join
    await tick();
    h.clock.advance(1500); // it enters a fresh merge window like any idle-time message
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2']]);
    expect(h.merger.isIdle()).toBe(true);
    expect(h.onIdle).toHaveBeenCalledTimes(1);
  });
});

/**
 * runningSince — read by a busy `/usage` to say how long the turn has been going. Collecting is
 * busy but NOT running (nothing has reached the agent yet), so it reports no start time.
 */
describe('InboundMerger runningSince', () => {
  it('is undefined while idle and collecting, the dispatch time while running, and cleared after', async () => {
    const h = harness();
    expect(h.merger.runningSince()).toBeUndefined();

    await h.merger.ingest(msg('m1'));
    expect(h.merger.isIdle()).toBe(false);
    expect(h.merger.runningSince()).toBeUndefined(); // collecting: busy, but not started

    h.clock.advance(1500); // dispatched at t=1500
    expect(h.merger.runningSince()).toBe(1500);
    h.clock.advance(4000);
    expect(h.merger.runningSince()).toBe(1500); // the start, not the latest tick

    h.resolveFirst();
    await tick();
    expect(h.merger.isIdle()).toBe(true);
    expect(h.merger.runningSince()).toBeUndefined();
  });
});

/**
 * Solo turns (enqueueSolo) — a scheduled task firing into a conversation. Every case is about what a
 * timer must NOT do to a person: cancel their turn, merge into their batch, or jump their queue.
 */
describe('InboundMerger enqueueSolo', () => {
  it('waits behind a running turn — never offered to it, never cancelling it', async () => {
    const h = harness(() => Promise.resolve('joined'));
    await h.merger.ingest(msg('user'));
    h.clock.advance(1500); // the user's turn is running (pending)

    const done = h.merger.enqueueSolo(msg('sched'));
    await tick();
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.deps.steer).not.toHaveBeenCalled();
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);

    h.resolveFirst();
    expect(await done).toBe('ok');
    expect(h.batches).toEqual([['user'], ['sched']]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('is never merged into a batch the user is still collecting', async () => {
    const h = harness();
    await h.merger.ingest(msg('typing'));
    const done = h.merger.enqueueSolo(msg('sched'));
    h.clock.advance(1500); // the user's batch dispatches (first turn, pending)
    h.resolveFirst();
    await done;
    expect(h.batches).toEqual([['typing'], ['sched']]);
  });

  it('goes behind the user\'s own queued messages', async () => {
    const h = harness();
    await h.merger.ingest(msg('first'));
    h.clock.advance(1500);
    const done = h.merger.enqueueSolo(msg('sched'));
    await h.merger.ingest(msg('queued'));
    h.resolveFirst();
    await done;
    await tick();
    expect(h.batches).toEqual([['first'], ['queued'], ['sched']]);
  });

  it('runs at once on an idle conversation, with no merge window and no reactions', async () => {
    const h = harness();
    const done = h.merger.enqueueSolo(msg('sched'));
    // First turn in this harness stays pending: it started without the clock advancing.
    await tick();
    expect(h.batches).toEqual([['sched']]);
    h.resolveFirst();
    expect(await done).toBe('ok');
    expect(h.deps.addReaction).not.toHaveBeenCalled();
  });

  it('takes a message typed while it runs, ends ok, and marks only the person\'s message', async () => {
    const h = harness(() => Promise.resolve('joined'));
    const done = h.merger.enqueueSolo(msg('sched'));
    await tick();
    await h.merger.ingest(msg('person'));
    await tick();
    expect(h.abortTurn).not.toHaveBeenCalled();
    h.resolveFirst();
    expect(await done).toBe('ok');
    expect(h.batches).toEqual([['sched']]);
    // The scheduled prompt has no platform message to mark; the person's does.
    expect(h.marks()).toEqual([
      ['person', '👀'],
      ['person', '✅'],
    ]);
  });

  it('reports a failed turn as failed', async () => {
    const clock = makeClock();
    const merger = new InboundMerger(
      { mergeWindowMs: 1, maxMergeWindowMs: 1, reactions },
      { now: clock.now, schedule: clock.schedule, addReaction: vi.fn(), runTurn: () => Promise.reject(new Error('x')) }
    );
    expect(await merger.enqueueSolo(msg('sched'))).toBe('failed');
  });
});

/**
 * Lifecycle reactions (display.reactions.enabled).
 *
 * The emoji land on the USER's own message — 👀 while the turn runs, then ✅/❌ (Telegram maps those
 * into its allow-set as 👌/👎). In a single-operator DM that is pure noise: the reply itself already
 * proves the message was seen. Turning it off must suppress every one of the three, and must not
 * disturb the turn itself.
 */
describe('InboundMerger lifecycle reactions', () => {
  /** Harness with turns that settle immediately, so both the received and done paths are observable. */
  function reactionHarness(reactionsEnabled: boolean | undefined, failTurn = false) {
    const clock = makeClock();
    const reacted: string[] = [];
    const deps: MergerDeps = {
      now: clock.now,
      schedule: clock.schedule,
      addReaction: vi.fn(async (_ref, emoji: string) => void reacted.push(emoji)),
      runTurn: vi.fn(() => (failTurn ? Promise.reject(new Error('boom')) : Promise.resolve())),
    };
    const merger = new InboundMerger(
      {
        mergeWindowMs: 1500,
        maxMergeWindowMs: 5000,
        reactions,
        ...(reactionsEnabled === undefined ? {} : { reactionsEnabled }),
      },
      deps
    );
    return { merger, clock, deps, reacted };
  }

  it('enabled: marks the message 👀 on receipt and ✅ when the turn completes', async () => {
    const h = reactionHarness(true);
    await h.merger.ingest(msg('m1'));
    expect(h.reacted).toEqual(['👀']);
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '✅']);
  });

  it('disabled: sends no reaction at all, and the turn still runs', async () => {
    const h = reactionHarness(false);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    // The actual bug being fixed: the user's message must come back unmarked.
    expect(h.deps.addReaction).not.toHaveBeenCalled();
    expect(h.reacted).toEqual([]);
    // Suppressing the decoration must not suppress the work.
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('disabled: a FAILED turn is also left unmarked (no ❌ either)', async () => {
    // ❌ goes through the same choke point. Losing it costs no information: turn-runner sends a
    // readable "this turn failed" message in-channel regardless.
    const h = reactionHarness(false, true);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual([]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('enabled: a failed turn is marked ❌', async () => {
    const h = reactionHarness(true, true);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '❌']);
  });

  it('omitted: defaults to reacting, so an old caller keeps the previous behavior', async () => {
    const h = reactionHarness(undefined);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '✅']);
  });
});

/**
 * Explicit interrupt (`/stop`) — now the only way a turn is cut short.
 *
 * It must drop the backlog, or "stop" would mean "stop, then immediately start the next thing",
 * which is how a stop command earns a reputation for not stopping anything. That includes messages
 * still being offered to the turn when it lands, and a message that already joined the turn gets no
 * ✅ — the turn it joined did not finish.
 */
describe('InboundMerger.interrupt (/stop)', () => {
  const emojis = (h: ReturnType<typeof harness>) =>
    vi.mocked(h.deps.addReaction).mock.calls.map((c) => c[1]);

  it('running: cancels the turn, drops the backlog, and marks no ✅', async () => {
    const h = harness();

    await startTurn(h);
    await h.merger.ingest(msg('m2')); // queued behind it
    await tick();
    expect(h.abortTurn).not.toHaveBeenCalled();

    expect(h.merger.interrupt()).toBe('running');
    expect(h.abortTurn).toHaveBeenCalledTimes(1);
    expect(h.signals[0]?.aborted).toBe(true);

    h.resolveFirst();
    await tick();
    // The backlog is gone rather than promoted to the next turn.
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(true);
    // 👀 for each of the two messages, and no ✅: the turn was stopped, not completed.
    expect(emojis(h)).toEqual(['👀', '👀']);
  });

  it('running: drops a message still being offered to the turn, whatever the agent then says', async () => {
    const answer = deferred<SteerOutcome>();
    const h = harness(() => answer.promise);
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();

    h.merger.interrupt();
    answer.resolve('refused'); // would have queued it — but the stop dropped it
    h.resolveFirst();
    await tick();
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('running: a message that joined the turn goes down with it — no ✅ for it either', async () => {
    const h = harness(() => Promise.resolve('joined'));
    await startTurn(h);
    await h.merger.ingest(msg('m2'));
    await tick();
    h.merger.interrupt();
    h.resolveFirst();
    await tick();
    expect(emojis(h)).toEqual(['👀', '👀']);
  });

  it('collecting: drops the batch before it ever reaches the agent', async () => {
    const h = harness();

    await h.merger.ingest(msg('m1')); // inside the merge window, nothing dispatched yet
    expect(h.merger.interrupt()).toBe('collecting');

    h.clock.advance(5000); // the window would have elapsed long ago
    await tick();
    expect(h.deps.runTurn).not.toHaveBeenCalled();
    expect(h.abortTurn).not.toHaveBeenCalled(); // there was no turn to abort
    expect(h.merger.isIdle()).toBe(true);
  });

  it('idle: reports idle and touches nothing', async () => {
    const h = harness();
    expect(h.merger.interrupt()).toBe('idle');
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.deps.runTurn).not.toHaveBeenCalled();
  });
});

describe('InboundMerger: queueBehind (task-send --interrupt)', () => {
  it('never offers the message to the turn that was just stopped, even when the harness could take it', async () => {
    const h = harness(() => Promise.resolve('joined'));
    await startTurn(h);

    h.merger.queueBehind(msg('m2'));
    await tick();
    expect(h.deps.steer).not.toHaveBeenCalled();

    h.resolveFirst();
    await tick();
    expect(h.batches).toEqual([['m1'], ['m2']]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('starts a turn as usual when nothing is running', async () => {
    const h = harness();
    h.merger.queueBehind(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.batches).toEqual([['m1']]);
  });
});
