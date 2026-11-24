import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { setLocale } from '../../i18n/index.js';
import {
  AGE_TICK_MS,
  ageClock,
  ageHtml,
  ageText,
  createAgeTicker,
  durText,
  schedAgo,
  subtreeRun,
  topicAge,
} from './age.js';
import type { Topic } from './types.js';

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    title: 'Topic',
    lastAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('topics/age', () => {
  beforeEach(() => {
    setLocale('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats durations with floor rounding and zero clamping', () => {
    expect(durText(-5000)).toBe('<1m');
    expect(durText(59_999)).toBe('<1m');
    expect(durText(60_000)).toBe('1m');
    expect(durText(59 * 60_000)).toBe('59m');
    expect(durText(60 * 60_000)).toBe('1h');
    expect(durText(23 * 3600_000)).toBe('23h');
    expect(durText(24 * 3600_000)).toBe('1d');
    expect(durText((24 + 10) * 3600_000)).toBe('1d10h');
  });

  it('formats ageText with ago suffix only when done', () => {
    expect(ageText(5 * 60_000, false)).toBe('5m');
    expect(ageText(5 * 60_000, true)).toBe('5m ago');
  });

  it('formats schedAgo across seconds, minutes, hours, days', () => {
    const now = 1_700_000_000_000;
    expect(schedAgo(0, now)).toBe('');
    expect(schedAgo(now - 15_000, now)).toBe('15s ago');
    expect(schedAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(schedAgo(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(schedAgo(now - 2 * 86400_000, now)).toBe('2d ago');
  });

  it('formats ageClock with time-only for today and month/date for other days', () => {
    const now = new Date(2026, 10, 24, 14, 30);
    const sameDay = new Date(2026, 10, 24, 9, 5).getTime();
    const otherDay = new Date(2026, 9, 3, 8, 7).getTime();
    const otherYear = new Date(2025, 0, 15, 21, 0).getTime();

    expect(ageClock(sameDay, now)).toBe('09:05');
    expect(ageClock(otherDay, now)).toContain('3 08:07');
    expect(ageClock(otherYear, now)).toContain('2025 21:00');
  });

  it('computes subtreeRun earliest runningSince across nested children', () => {
    const topics: Topic[] = [
      makeTopic({ id: 'root' }),
      makeTopic({ id: 'c1', parent: 'root', running: true, runningSince: 5000 }),
      makeTopic({ id: 'c2', parent: 'c1', running: true, runningSince: 3000 }),
    ];
    expect(subtreeRun('root', topics)).toEqual({ busy: true, since: 3000 });
    expect(topicAge(topics[0]!, topics)).toEqual({ at: 3000, run: true });
  });

  it('falls back from outcome.at to lastAt when msgCount > 0 and returns null when empty', () => {
    const empty = makeTopic({ id: 'e', msgCount: 0 });
    expect(topicAge(empty, [empty])).toBeNull();

    const withOutcome = makeTopic({
      id: 'o',
      msgCount: 2,
      lastAt: 1000,
      outcome: { kind: 'done', at: 2000 },
    });
    expect(topicAge(withOutcome, [withOutcome])).toEqual({ at: 2000, run: false });

    const withMsgs = makeTopic({ id: 'm', msgCount: 3, lastAt: 4000 });
    expect(topicAge(withMsgs, [withMsgs])).toEqual({ at: 4000, run: false });
  });

  it('renders ageHtml and updates DOM nodes on tick via createAgeTicker', () => {
    vi.useFakeTimers();
    let now = 1_700_000_120_000;
    const t = makeTopic({ id: 't1', running: true, runningSince: now - 60_000 });
    const html = ageHtml(t, [t], now);
    expect(html).toContain('class="topic-age run"');
    expect(html).toContain('data-age-run="1"');
    expect(html).toContain('>1m</span>');

    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const ticker = createAgeTicker(dom.window.document, () => now);
    ticker.attach();
    ticker.armAgeTick();

    now += 120_000;
    vi.advanceTimersByTime(AGE_TICK_MS);
    expect(dom.window.document.querySelector('.topic-age')?.textContent).toBe('3m');
    ticker.dispose();
  });
});
