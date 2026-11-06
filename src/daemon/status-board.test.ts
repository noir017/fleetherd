import { describe, expect, it, vi } from 'vitest';

import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentStatus } from '../types.js';
import type { CacheReading } from './claude-transcript.js';
import { CACHE_READ_DELAY_MS, MIN_INTERVAL_MS, StatusBoard, type StatusBoardDeps } from './status-board.js';

const T0 = 1_791_000_000_000;
const HOUR = 60 * 60 * 1000;
const LANE: ConversationAddress = { channel: 'main', thread: 't1' };

/** A clock whose timers fire only when the test advances it — the throttle is the thing under test. */
function makeClock() {
  let t = T0;
  let timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => {
        timers = timers.filter((e) => e !== entry);
      };
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        timers = timers.filter((e) => e !== due);
        due.fn();
        // Let a transcript read's promise chain land before the next timer.
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

function rig(opts: { canShow?: boolean; lane?: boolean; reading?: CacheReading | undefined; agent?: string } = {}) {
  const clock = makeClock();
  const shown: Array<AgentStatus | undefined> = [];
  const platform = {
    platform: 'web',
    ...(opts.canShow === false ? {} : { setStatus: (_a: ConversationAddress, s: AgentStatus | undefined) => shown.push(s) }),
  } as unknown as PlatformAdapter;
  const cacheReading = vi.fn(async () => opts.reading);
  const deps: StatusBoardDeps = {
    laneOf: () => (opts.lane === false ? undefined : { address: LANE, platformId: 'web' }),
    platforms: new Map([['web', platform]]),
    agentOf: () => opts.agent ?? 'cc',
    configuredModel: () => 'anthropic/claude-opus-5-5',
    cacheReading,
    clock,
  };
  return { board: new StatusBoard(deps), clock, shown, cacheReading };
}

describe('StatusBoard', () => {
  it('shows the first report at once, and names the configured model until the harness names one', () => {
    const { board, shown } = rig();
    board.usage('c1', { used: 1000, size: 200_000 });
    // Short name, as the footer prints it.
    expect(shown).toEqual([{ agent: 'cc', model: 'claude-opus-5-5', context: { used: 1000, size: 200_000 } }]);
  });

  it('sends at most one status per window, and the last change in it is never lost', async () => {
    // A turn emits a usage_update per API call; the page should see a few, ending on the latest.
    const { board, clock, shown } = rig();
    board.usage('c1', { used: 1, size: 100 });
    board.usage('c1', { used: 2, size: 100 });
    board.usage('c1', { used: 3, size: 100 });
    expect(shown.map((s) => s?.context?.used)).toEqual([1]);
    await clock.advance(MIN_INTERVAL_MS);
    expect(shown.map((s) => s?.context?.used)).toEqual([1, 3]);
    // Quiet now: the window that trailing send opened closes with nothing owed.
    await clock.advance(MIN_INTERVAL_MS * 3);
    expect(shown).toHaveLength(2);
  });

  it('does not repeat a status that has not changed', async () => {
    // agy re-sends the same frame every render tick; claude re-reports model and effort per turn.
    const { board, clock, shown } = rig();
    board.model('c1', 'claude-opus-5-5');
    await clock.advance(MIN_INTERVAL_MS);
    board.model('c1', 'claude-opus-5-5');
    board.effort('c1', undefined);
    await clock.advance(MIN_INTERVAL_MS * 2);
    expect(shown).toHaveLength(1);
  });

  it('keeps the last cost through the mid-stream snapshots that carry none', () => {
    const { board, shown } = rig({ reading: undefined });
    board.usage('c1', { used: 1, size: 100, cost: { amount: 0.42, currency: 'USD' } });
    board.usage('c1', { used: 2, size: 100 });
    expect(board.statusOf('c1')?.cost).toEqual({ amount: 0.42, currency: 'USD' });
    expect(shown[0]?.cost).toEqual({ amount: 0.42, currency: 'USD' });
  });

  it('does no work at all for a conversation on a platform that cannot show a status', async () => {
    const { board, clock, shown, cacheReading } = rig({ canShow: false });
    board.usage('c1', { used: 1, size: 100, cost: { amount: 1, currency: 'USD' } });
    board.settled('c1');
    await clock.advance(CACHE_READ_DELAY_MS * 2);
    expect(shown).toEqual([]);
    // In particular no transcript read: a Telegram topic must not cost a file read per turn.
    expect(cacheReading).not.toHaveBeenCalled();
  });

  it('reads the cache once, a moment after a cycle ends, however many signals said so', async () => {
    const reading = { expiresAt: T0 + HOUR, ttlMs: HOUR };
    const { board, clock, cacheReading } = rig({ reading });
    // A result-tied usage (with cost) and the turn completing arrive together.
    board.usage('c1', { used: 1, size: 100, cost: { amount: 1, currency: 'USD' } });
    board.settled('c1');
    expect(cacheReading).not.toHaveBeenCalled();
    await clock.advance(CACHE_READ_DELAY_MS);
    expect(cacheReading).toHaveBeenCalledTimes(1);
    await clock.advance(MIN_INTERVAL_MS);
    expect(board.statusOf('c1')?.cacheExpiresAt).toBe(T0 + HOUR);
  });

  it('projects a request seen live with the TTL already learned, instead of reading again', async () => {
    const { board, clock, cacheReading } = rig({ reading: { expiresAt: T0 + HOUR, ttlMs: HOUR } });
    board.settled('c1');
    await clock.advance(CACHE_READ_DELAY_MS);
    // Ten minutes later a new turn's first API call reports usage: the cache was just renewed.
    await clock.advance(10 * 60 * 1000);
    board.usage('c1', { used: 5, size: 100 });
    expect(board.statusOf('c1')?.cacheExpiresAt).toBe(clock.now() + HOUR);
    expect(cacheReading).toHaveBeenCalledTimes(1);
  });

  it('clears the strip on reset, at once, and drops a read that was in flight', async () => {
    const { board, clock, shown } = rig({ reading: { expiresAt: T0 + HOUR, ttlMs: HOUR } });
    board.usage('c1', { used: 1, size: 100 });
    board.settled('c1');
    board.reset('c1');
    expect(shown.at(-1)).toBeUndefined();
    await clock.advance(CACHE_READ_DELAY_MS + MIN_INTERVAL_MS);
    // Nothing from the conversation that was reset comes back afterwards.
    expect(shown).toHaveLength(2);
    expect(board.statusOf('c1')).toBeUndefined();
  });

  it('drops a read that was already on disk when the reset landed', async () => {
    // `/new` while the transcript of the session it just ended is being read: that answer
    // describes a cache the conversation no longer has.
    const { board, clock, shown, cacheReading } = rig();
    let finish: (r: CacheReading) => void = () => {};
    cacheReading.mockImplementation(() => new Promise<CacheReading | undefined>((resolve) => (finish = resolve)));
    board.usage('c1', { used: 1, size: 100 });
    board.settled('c1');
    await clock.advance(CACHE_READ_DELAY_MS);
    expect(cacheReading).toHaveBeenCalledTimes(1);
    board.reset('c1');
    finish({ expiresAt: T0 + HOUR, ttlMs: HOUR });
    await clock.advance(MIN_INTERVAL_MS * 2);
    expect(shown.at(-1)).toBeUndefined();
    expect(board.statusOf('c1')).toBeUndefined();
  });

  it('carries agy’s quota and leaves out every field nobody reported', () => {
    const { board, shown } = rig({ agent: 'agy' });
    board.quota('c1', [{ id: '3p-5h', remaining: 0.5, active: true }]);
    expect(shown).toEqual([
      { agent: 'agy', model: 'claude-opus-5-5', quota: [{ id: '3p-5h', remaining: 0.5, active: true }] },
    ]);
  });

  it('swallows a platform that throws — a status is never worth a turn', () => {
    const { board } = rig();
    const deps = (board as unknown as { deps: StatusBoardDeps }).deps;
    const platform = deps.platforms.get('web') as PlatformAdapter;
    platform.setStatus = () => {
      throw new Error('topic gone');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => board.usage('c1', { used: 1, size: 100 })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('forgets a conversation without sending anything, and nothing owed arrives later', async () => {
    const { board, clock, shown, cacheReading } = rig({ reading: { expiresAt: T0 + HOUR, ttlMs: HOUR } });
    board.usage('c1', { used: 1, size: 100 });
    board.usage('c1', { used: 2, size: 100 }); // owed to the window's end
    board.settled('c1'); // a transcript read armed
    board.forget('c1');
    expect(board.statusOf('c1')).toBeUndefined();
    await clock.advance(CACHE_READ_DELAY_MS + MIN_INTERVAL_MS * 2);
    // Unlike reset, the strip is left as it was: the first report, and nothing after it.
    expect(shown.map((s) => s?.context?.used)).toEqual([1]);
    expect(cacheReading).not.toHaveBeenCalled();
  });
});
