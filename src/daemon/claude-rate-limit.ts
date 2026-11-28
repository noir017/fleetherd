import type { QuotaPool } from '../types.js';

/**
 * A Claude subscription's quota, as claude itself reports it: claude-agent-acp forwards the SDK's
 * `rate_limit_event` as a `usage_update` carrying `_meta["_claude/rateLimit"]` (acp-agent.js,
 * 0.81.0), the SDK's `SDKRateLimitInfo`. Only a claude.ai login gets one — Claude Code reads the
 * `anthropic-ratelimit-unified-*` response headers only there. Behind a relay the same headers are
 * read off a probe instead (claude-quota-probe.ts), through the same window table.
 *
 * Units, from Claude Code 2.1.280's own schema for this object (the description of its
 * `unifiedWindows`, which says the top-level fields share them; also its `{utilization: 0.9}`
 * warning thresholds and `resetsAt * 1000 <= Date.now()` expiry check):
 *   - `utilization` is the fraction of the window used, 0…1, and can run past 1;
 *   - `resetsAt` is unix epoch SECONDS.
 *
 * Each event names one window at top level (`rateLimitType` + `utilization`: the one limiting right
 * now); Claude Code 2.1.x also sends `unifiedWindows` with the five-hour and weekly windows on every
 * observation. That field is marked `@internal` in the SDK, so it is read when present and never
 * relied on. The pools are named the way a `quotaCommand` row `Claude …` is (agy-meters.ts
 * poolFamily), so a pool is the same pool whichever source reported it.
 */

export const CLAUDE_RATE_LIMIT_META = '_claude/rateLimit';

/**
 * Claude's windows: the name `rate_limit_info` gives one, its spelling in the response headers
 * (`anthropic-ratelimit-unified-<header>-utilization` / `-reset`), and the pool it is shown as.
 * `overage` (usage credits) and `seven_day_overage_included` are left out.
 */
const CLAUDE_WINDOWS: ReadonlyArray<{ name: string; header?: string; pool: string }> = [
  { name: 'five_hour', header: '5h', pool: 'claude-5h' },
  { name: 'seven_day', header: '7d', pool: 'claude-weekly' },
  { name: 'seven_day_opus', pool: 'claude-opus-weekly' },
  { name: 'seven_day_sonnet', pool: 'claude-sonnet-weekly' },
];

/** One window as a pool: `remaining` is what `utilization` leaves, and a missing utilization is only known for a rejected window (none left). */
function windowPool(window: unknown, utilization: unknown, resetsAt: unknown, rejected = false): QuotaPool | undefined {
  const id = CLAUDE_WINDOWS.find((w) => w.name === window)?.pool;
  if (!id) return undefined;
  const used = typeof utilization === 'number' && Number.isFinite(utilization) ? utilization : rejected ? 1 : undefined;
  if (used === undefined) return undefined;
  const pool: QuotaPool = { id, remaining: Math.min(1, Math.max(0, 1 - used)) };
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0) pool.resetsAt = resetsAt * 1000;
  return pool;
}

/**
 * The pools a response's `anthropic-ratelimit-unified-*` headers name, read the way Claude Code reads
 * them into `rate_limit_info`: per window a utilization and a reset, and the overall status with the
 * window it is about (`representative-claim`).
 */
export function claudeHeaderPools(header: (name: string) => string | undefined): QuotaPool[] {
  const num = (v: string | undefined): number | undefined => (v === undefined || v.trim() === '' ? undefined : Number(v));
  const rejected = header('anthropic-ratelimit-unified-status') === 'rejected';
  const claim = header('anthropic-ratelimit-unified-representative-claim');
  const pools: QuotaPool[] = [];
  for (const w of CLAUDE_WINDOWS) {
    if (!w.header) continue;
    const at = `anthropic-ratelimit-unified-${w.header}`;
    const pool = windowPool(w.name, num(header(`${at}-utilization`)), num(header(`${at}-reset`)), rejected && claim === w.name);
    if (pool) pools.push(pool);
  }
  return pools;
}

/**
 * The pools one `_claude/rateLimit` reports, from an ACP update's `_meta`; undefined when it carries
 * none. The top-level window is applied last: it is the one the event is about.
 */
export function claudeRateLimitPools(meta: unknown): QuotaPool[] | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const info = (meta as Record<string, unknown>)[CLAUDE_RATE_LIMIT_META];
  if (!info || typeof info !== 'object') return undefined;
  const { status, rateLimitType, utilization, resetsAt, unifiedWindows } = info as Record<string, unknown>;
  const byId = new Map<string, QuotaPool>();
  if (unifiedWindows && typeof unifiedWindows === 'object') {
    for (const [window, w] of Object.entries(unifiedWindows as Record<string, unknown>)) {
      if (!w || typeof w !== 'object') continue;
      const { utilization: u, resetsAt: r } = w as Record<string, unknown>;
      const pool = windowPool(window, u, r);
      if (pool) byId.set(pool.id, pool);
    }
  }
  const top = windowPool(rateLimitType, utilization, resetsAt, status === 'rejected');
  if (top) byId.set(top.id, top);
  return byId.size ? [...byId.values()] : undefined;
}
