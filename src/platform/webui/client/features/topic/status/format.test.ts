import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/index.js';
import {
  hasCountdown,
  modelChip,
  optChip,
  poolLabel,
  renderBareStatus,
  renderQuotaSegments,
  stClock,
  stLeft,
  stTokens,
  stWindow,
  statusSegments,
} from './format.js';
import type { AgentStatus, QuotaPool } from './types.js';

describe('features/topic/status/format', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('formats token counts and context windows identically to the reply footer', () => {
    expect(stTokens(0)).toBe('0k');
    expect(stTokens(12400)).toBe('12k');
    expect(stTokens(12600)).toBe('13k');
    expect(stTokens(1_000_000)).toBe('1M');
    expect(stTokens(1_250_000)).toBe('1.3M');

    expect(stWindow(200_000)).toBe('200k');
    expect(stWindow(1_000_000)).toBe('1M');
    expect(stWindow(1_290_000)).toBe('1.2M');
  });

  it('formats remaining durations in minutes, hours, and days', () => {
    expect(stLeft(-5000)).toBe('<1m');
    expect(stLeft(59_999)).toBe('<1m');
    expect(stLeft(60_000)).toBe('1m');
    expect(stLeft(41 * 60_000)).toBe('41m');
    expect(stLeft(60 * 60_000)).toBe('1h');
    expect(stLeft(95 * 60_000)).toBe('1h 35m');
    expect(stLeft(24 * 60 * 60_000)).toBe('1d');
    expect(stLeft(27 * 60 * 60_000)).toBe('1d 3h');
  });

  it('formats local clock hours and minutes with zero padding', () => {
    const dt = new Date(2026, 0, 1, 7, 5, 0).getTime();
    expect(stClock(dt)).toBe('07:05');
    const pm = new Date(2026, 0, 1, 21, 30, 0).getTime();
    expect(stClock(pm)).toBe('21:30');
  });

  it('normalizes known quota pool labels and preserves unknown shapes', () => {
    expect(poolLabel('gemini-5h')).toBe('Gemini 5h');
    expect(poolLabel('3p-weekly')).toBe('3P wk');
    expect(poolLabel('3p-daily')).toBe('3P day');
    expect(poolLabel('custom-pool-2h')).toBe('custom-pool 2h');
    expect(poolLabel('solo')).toBe('solo');
  });

  it('detects whether an AgentStatus requires a countdown ticker', () => {
    expect(hasCountdown(null)).toBe(false);
    expect(hasCountdown({ agent: 'cc' })).toBe(false);
    expect(hasCountdown({ agent: 'cc', cacheExpiresAt: 1000 })).toBe(true);
    expect(hasCountdown({ agent: 'agy', quota: [{ id: 'gemini-5h', remaining: 0.8 }] })).toBe(false);
    expect(
      hasCountdown({ agent: 'agy', quota: [{ id: 'gemini-5h', remaining: 0.8, resetsAt: 2000 }] }),
    ).toBe(true);
  });

  it('renders model and custom option chips with fixed and expanded states', () => {
    expect(modelChip('claude-sonnet', false)).toContain('aria-expanded="false"');
    expect(modelChip('claude-sonnet', true)).toContain('aria-expanded="true"');

    const fixedHtml = optChip({ id: 'acct', name: 'Account', value: 'work', fixed: true }, null);
    expect(fixedHtml).toContain('class="st-model st-opt fixed" disabled');
    expect(fixedHtml).toContain('data-opt="acct"');

    const openHtml = optChip({ id: 'acct', name: 'Account', value: 'work' }, 'acct');
    expect(openHtml).toContain('aria-expanded="true"');
    expect(openHtml).not.toContain(' disabled');
  });

  it('renders status segments for context thresholds, cost, cache, and quota pools', () => {
    const now = 1_700_000_000_000;
    const status: AgentStatus = {
      agent: 'cc',
      model: 'opus',
      effort: 'high',
      context: { used: 165_000, size: 200_000 },
      cost: { amount: 0.425, currency: 'USD' },
      cacheExpiresAt: now + 3 * 60_000,
      quota: [
        { id: 'gemini-5h', remaining: 0.3, active: true, resetsAt: now + 45 * 60_000, account: 'a@x.com' },
        { id: '3p-weekly', remaining: 0.1, active: false, resetsAt: now + 120 * 60_000, account: 'b@x.com' },
      ],
    };

    const closed = statusSegments(status, now, false, {
      fallbackOptions: [],
      openModel: false,
      openOptId: null,
    });
    expect(closed).toContain('cc');
    expect(closed).toContain('opus');
    expect(closed).toContain('high');
    expect(closed).toContain('class="st bad"');
    expect(closed).toContain('83%');
    expect(closed).toContain('$0.42');
    expect(closed).toContain('cache 3m');
    expect(closed).toContain('a Gemini 5h 30% (45m)');
    expect(closed).not.toContain('3P wk');

    const opened = statusSegments(status, now, true, {
      fallbackOptions: [],
      openModel: false,
      openOptId: null,
    });
    expect(opened).toContain('class="st bad off"');
    expect(opened).toContain('b 3P wk 10% (2h)');
  });

  it('omits quota reset countdown when pool is at 100% and renders expired cache', () => {
    const now = 1_700_000_000_000;
    const pools: QuotaPool[] = [
      { id: 'gemini-5h', remaining: 1, active: true, resetsAt: now + 30 * 60_000 },
    ];
    const segs = renderQuotaSegments(pools, now, false);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toContain('Gemini 5h 100%');
    expect(segs[0]).not.toContain('(30m)');

    const expired = statusSegments(
      { agent: 'cc', cacheExpiresAt: now - 1000 },
      now,
      false,
      { fallbackOptions: [], openModel: false, openOptId: null },
    );
    expect(expired).toContain('cache expired');
  });

  it('renders bare status with peeked agent, model, and options', () => {
    const bare = renderBareStatus({
      agent: 'agy',
      model: 'gemini-2.5',
      options: [{ id: 'acct', name: 'Account', value: 'primary' }],
      openModel: false,
      openOptId: null,
    });
    expect(bare).toContain('agy');
    expect(bare).toContain('gemini-2.5');
    expect(bare).toContain('Account');
    expect(bare).toContain('primary');
  });
});
