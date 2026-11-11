import fs from 'node:fs';
import path from 'node:path';
import { bumpedScore, type FrecencyStat } from '../core/frecency.js';

/**
 * How often each directory has been chosen with `/cd` (`<configDir>/workdir-usage.json`).
 *
 * ── Why a file of its own ─────────────────────────────────────────────────────
 * This is the one piece of state here that is NOT per conversation. "shop-api is where I spend my
 * days" is a fact about the machine, and a brand-new topic should benefit from it on its very first
 * menu — which is exactly what folding it into conversations.json would prevent. That file is also
 * literally a map of conversation key → record, validated entry by entry, so a usage table living
 * at its top level would be read back as one more malformed conversation and dropped on load.
 *
 * ── What is stored ────────────────────────────────────────────────────────────
 * Two numbers per absolute path, `{score, last}` — a complete stand-in for an unbounded visit
 * history, for the reason core/frecency.ts derives. Nothing else: no titles, no contents, no record
 * of WHICH conversation went where (that is in conversations.json and is nobody else's business).
 *
 * Directories are never pruned when they disappear from disk. A stale entry costs one JSON key and
 * ranks nothing (the menu only ever ranks paths the scan just found), while pruning would quietly
 * forget a project that happens to live on an unmounted volume the day the daemon restarted.
 *
 * Write-through on every change; a missing or corrupt file degrades to empty, because the worst
 * case of losing this is a menu in alphabetical order — the ordering it had before any of this
 * existed. It is never worth a crash, and never worth blocking a `/cd` on.
 */
export class WorkdirUsageStore {
  private map = new Map<string, FrecencyStat>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        const stat = toStat(value);
        if (stat) this.map.set(key, stat);
      }
    } catch {
      /* first run or corrupt file: start with no history, i.e. alphabetical order */
    }
  }

  /** This path's recorded usage, or undefined if it has never been chosen. */
  stat(dir: string): FrecencyStat | undefined {
    return this.map.get(dir);
  }

  /** Bound method, so it can be handed to rankByFrecency without the caller capturing `this`. */
  readonly statOf = (dir: string): FrecencyStat | undefined => this.stat(dir);

  /**
   * Count one use of `dir` at `now`.
   *
   * Called only where a directory was actually MOVED TO — not when the menu re-picks the directory
   * already in use, which is how a user dismisses it (see setWorkdir's `unchanged`). Counting that
   * would let closing a menu promote whatever it happened to be open on.
   */
  record(dir: string, now: number): void {
    this.map.set(dir, bumpedScore(this.map.get(dir), now));
    this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2) + '\n');
    } catch (e) {
      // Warn, never throw: this is a ranking hint, and failing a directory change over one would
      // trade a working feature for a cosmetic one.
      console.warn('[workdir] failed to persist usage:', e instanceof Error ? e.message : e);
    }
  }
}

/** Validate one on-disk entry; anything malformed is dropped rather than trusted. */
function toStat(value: unknown): FrecencyStat | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as { score?: unknown; last?: unknown };
  if (typeof o.score !== 'number' || !Number.isFinite(o.score) || o.score < 0) return null;
  if (typeof o.last !== 'number' || !Number.isFinite(o.last) || o.last < 0) return null;
  return { score: o.score, last: o.last };
}
