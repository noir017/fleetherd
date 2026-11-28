import { describe, expect, it } from 'vitest';
import { CLAUDE_RATE_LIMIT_META, claudeRateLimitPools } from './claude-rate-limit.js';

const meta = (info: unknown) => ({ [CLAUDE_RATE_LIMIT_META]: info });
// 2026-11-28T15:00:00Z, in seconds as Claude Code sends it.
const RESET_S = 1_795_878_000;

describe('claudeRateLimitPools: contract with claude-agent-acp / Claude Code', () => {
  it('reads the key claude-agent-acp puts the SDK’s rate_limit_info under', () => {
    // acp-agent.js 0.81.0: `_meta: { "_claude/rateLimit": message.rate_limit_info }` on a usage_update.
    expect(CLAUDE_RATE_LIMIT_META).toBe('_claude/rateLimit');
  });

  it('takes utilization as the fraction used (0…1) and resetsAt as epoch seconds', () => {
    // Claude Code 2.1.280's schema: "utilization is the fraction of the window used (usually 0-1 …);
    // resetsAt is unix epoch seconds".
    expect(
      claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.27, resetsAt: RESET_S })),
    ).toEqual([{ id: 'claude-5h', remaining: 0.73, resetsAt: RESET_S * 1000 }]);
  });

  it('names each plan window the way a quotaCommand row names it', () => {
    const ids = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].map(
      (w) => claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: w, utilization: 0.5 }))?.[0]?.id,
    );
    expect(ids).toEqual(['claude-5h', 'claude-weekly', 'claude-opus-weekly', 'claude-sonnet-weekly']);
  });

  it('clamps utilization past the cap to none left', () => {
    expect(claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: 'five_hour', utilization: 1.08 }))).toEqual([
      { id: 'claude-5h', remaining: 0 },
    ]);
  });

  it('reads a rejected window with no utilization as spent, and an allowed one as unknown', () => {
    expect(claudeRateLimitPools(meta({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: RESET_S }))).toEqual([
      { id: 'claude-weekly', remaining: 0, resetsAt: RESET_S * 1000 },
    ]);
    expect(claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: 'seven_day' }))).toBeUndefined();
  });

  it('reads every window in unifiedWindows, with the top-level one taking precedence', () => {
    const pools = claudeRateLimitPools(
      meta({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.75,
        resetsAt: RESET_S,
        unifiedWindows: {
          five_hour: { utilization: 0.9, resetsAt: RESET_S },
          seven_day: { utilization: 0.4, resetsAt: RESET_S + 86_400 },
          seven_day_overage_included: { utilization: 0.1, resetsAt: RESET_S },
        },
      }),
    );
    expect(pools).toEqual([
      { id: 'claude-5h', remaining: 0.25, resetsAt: RESET_S * 1000 },
      { id: 'claude-weekly', remaining: 0.6, resetsAt: (RESET_S + 86_400) * 1000 },
    ]);
  });

  it('has nothing for usage credits, an unknown window, or an update without the key', () => {
    expect(claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: 'overage', utilization: 0.2 }))).toBeUndefined();
    expect(claudeRateLimitPools(meta({ status: 'allowed', rateLimitType: 'ten_day', utilization: 0.2 }))).toBeUndefined();
    expect(claudeRateLimitPools({ other: 1 })).toBeUndefined();
    expect(claudeRateLimitPools(undefined)).toBeUndefined();
    expect(claudeRateLimitPools(meta('nonsense'))).toBeUndefined();
  });
});
