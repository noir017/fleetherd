import { shortModelName } from '../core/runtime-footer.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentStatus, ConversationId, QuotaPool } from '../types.js';
import type { AgentUsage } from './agent.js';
import type { CacheReading } from './claude-transcript.js';

/**
 * The live status of each conversation's agent, pushed to any platform that can show one
 * (`PlatformAdapter.setStatus` — the web UI's strip above its composer).
 *
 * ── What it costs, which is the design constraint ─────────────────────────────
 * Nothing is polled. Every value here arrives on an event the daemon was already handling — an
 * ACP `usage_update`, an agy status-line frame, a turn ending — and the board only decides whether
 * that is worth passing on:
 *
 *  - a status identical to the last one sent is not sent (agy repeats its frame on every render
 *    tick, and claude-agent-acp re-sends the model and effort after every turn);
 *  - a changed one goes out at most once per MIN_INTERVAL_MS per conversation, leading and
 *    trailing, so a turn emitting a `usage_update` per API call costs the page one update every
 *    two seconds at worst and the final state always lands;
 *  - a conversation whose lane is on a platform with no `setStatus` never gets past `target()`, so
 *    a Telegram topic does no work here at all — including the transcript read below.
 *
 * The one piece of IO is claude's cache expiry, which only its transcript knows (see
 * claude-transcript.ts). It is read once per finished model cycle, a moment after it finishes —
 * never per update. Between reads, a request seen live is projected forward with the TTL the last
 * read established, which is arithmetic.
 *
 * ── Why a board and not fields on ConversationState ───────────────────────────
 * The registry already keeps `lastUsage` for `/context`, and could have kept the rest beside it.
 * But a status is assembled from five sources at five moments and owes a throttle, a dedupe and a
 * timer per conversation; folding that into a 3000-line registry would bury the one rule that
 * matters — nothing is sent that was not just reported — under everything else it does.
 */

/** At most one status per conversation per this long. A status bar, not a log. */
export const MIN_INTERVAL_MS = 2_000;

/**
 * How long after a model cycle ends the transcript is read. Claude Code appends its entries as the
 * response streams, but the `result` that ends a cycle can reach the gateway before the last of
 * them is on disk; reading at once would occasionally find the previous request.
 */
export const CACHE_READ_DELAY_MS = 1_500;

export interface StatusBoardDeps {
  /** Where the conversation is answered — the lane its last turn ran in. */
  laneOf(id: ConversationId): { address: ConversationAddress; platformId: string } | undefined;
  platforms: Map<string, PlatformAdapter>;
  /** The agent bound to the conversation (the status names it). */
  agentOf(id: ConversationId): string;
  /** The model to name before the harness has reported one: the `/model` override, else config. */
  configuredModel(id: ConversationId): string | undefined;
  /**
   * The conversation's prompt-cache reading, or undefined when its harness has none to give.
   * Only the claude harness answers; see claude-transcript.ts. Absent = no harness can.
   */
  cacheReading?(id: ConversationId): Promise<CacheReading | undefined>;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
}

/** Everything known about one conversation's agent, plus the board's own bookkeeping for it. */
interface Entry {
  model?: string;
  effort?: string;
  context?: { used: number; size: number };
  cost?: { amount: number; currency: string };
  cacheExpiresAt?: number;
  /** The TTL the last transcript read found, for projecting a live request (see `usage`). */
  cacheTtlMs?: number;
  quota?: QuotaPool[];
  /** The last status actually handed to the platform, serialized — the dedupe key. */
  sent?: string;
  /** Cancels the open throttle window; set while one is. */
  window?: () => void;
  /** A change arrived inside the window and is owed when it closes. */
  owed: boolean;
  /** Cancels a scheduled transcript read. */
  cacheTimer?: () => void;
  /** Bumped per scheduled read, so a slow read cannot overwrite a newer one's answer. */
  cacheSeq: number;
}

export class StatusBoard {
  private readonly entries = new Map<ConversationId, Entry>();

  constructor(private readonly deps: StatusBoardDeps) {}

  /**
   * A context snapshot. Cost is kept from an earlier snapshot when this one has none, for the
   * reason ConversationState.lastCost gives: claude-agent-acp attaches it only to the snapshot
   * that ends a cycle, and the mid-stream ones after it would otherwise erase it.
   *
   * Also the live sign that a request just went out, so a cache TTL already learned is projected
   * from now. The transcript read at the end of the cycle replaces the projection with the exact
   * figure; until then this keeps a long turn from showing a cache as expiring that it is
   * renewing with every call.
   */
  usage(id: ConversationId, usage: AgentUsage): void {
    const e = this.entryOf(id);
    e.context = { used: usage.used, size: usage.size };
    if (usage.cost) e.cost = usage.cost;
    if (e.cacheTtlMs !== undefined) e.cacheExpiresAt = this.deps.clock.now() + e.cacheTtlMs;
    this.publish(id, e);
    // A cost rides only on the snapshot that ends a model cycle (see AgentUsage.cost), which is
    // exactly when the transcript has a finished request to read.
    if (usage.cost) this.settled(id);
  }

  model(id: ConversationId, model: string): void {
    const e = this.entryOf(id);
    e.model = model;
    this.publish(id, e);
  }

  effort(id: ConversationId, effort: string | undefined): void {
    const e = this.entryOf(id);
    e.effort = effort;
    this.publish(id, e);
  }

  quota(id: ConversationId, pools: QuotaPool[]): void {
    const e = this.entryOf(id);
    e.quota = pools;
    this.publish(id, e);
  }

  /**
   * A model cycle finished, so the cache was last touched now-ish: schedule the transcript read.
   * Debounced — a turn's result and its completion arrive together, and one read answers both.
   */
  settled(id: ConversationId): void {
    const read = this.deps.cacheReading;
    if (!read || !this.target(id)) return;
    const e = this.entryOf(id);
    e.cacheTimer?.();
    const seq = ++e.cacheSeq;
    e.cacheTimer = this.deps.clock.schedule(() => {
      e.cacheTimer = undefined;
      void read(id)
        .then((reading) => {
          // Reset (`/new`, a rebind) or overtaken by a later read while this one was on disk.
          if (this.entries.get(id) !== e || e.cacheSeq !== seq || !reading) return;
          e.cacheExpiresAt = reading.expiresAt;
          e.cacheTtlMs = reading.ttlMs;
          this.publish(id, e);
        })
        .catch((err) => console.debug('[status] cache read failed:', err instanceof Error ? err.message : err));
    }, CACHE_READ_DELAY_MS);
  }

  /**
   * Forget the conversation and clear its status where it is shown — the context it described is
   * gone (`/new`, `/cd`, a rebind). The next report starts a fresh one. Not throttled: a stale
   * status left up after a reset is exactly the lie this exists to avoid.
   */
  reset(id: ConversationId): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.cancel(e);
    this.entries.delete(id);
    if (e.sent !== undefined) this.send(id, undefined);
  }

  /** Cancel every timer. The daemon is going away; nothing owed is worth delivering to it. */
  dispose(): void {
    for (const e of this.entries.values()) this.cancel(e);
    this.entries.clear();
  }

  /**
   * Drop a conversation the registry has let go of (ConversationRegistry.releaseState: a throwaway
   * scheduled run when it ends, or shutdown), timers and all. Nothing is sent, unlike reset: such a
   * run shows its status on the lane it posted into, which is the person's own conversation, and
   * blanking that strip is not the run's to do. Without this every such run left its entry here for
   * the life of the process.
   */
  forget(id: ConversationId): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.cancel(e);
    this.entries.delete(id);
  }

  /** What would be shown for a conversation right now, throttle aside. For tests. */
  statusOf(id: ConversationId): AgentStatus | undefined {
    const e = this.entries.get(id);
    return e ? this.compose(id, e) : undefined;
  }

  private entryOf(id: ConversationId): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { owed: false, cacheSeq: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  private cancel(e: Entry): void {
    e.window?.();
    e.window = undefined;
    e.cacheTimer?.();
    e.cacheTimer = undefined;
    e.cacheSeq++;
  }

  /**
   * Send now if no window is open, else owe it to the window's end. Leading and trailing: the first
   * change in a quiet stretch shows at once, and the last one in a busy stretch is never lost.
   */
  private publish(id: ConversationId, e: Entry): void {
    if (e.window) {
      e.owed = true;
      return;
    }
    this.flush(id, e);
    e.window = this.deps.clock.schedule(() => {
      e.window = undefined;
      if (!e.owed) return;
      e.owed = false;
      // Only if the entry is still the live one: a reset in the window already cleared the bar.
      if (this.entries.get(id) === e) this.publish(id, e);
    }, MIN_INTERVAL_MS);
  }

  private flush(id: ConversationId, e: Entry): void {
    const status = this.compose(id, e);
    const key = JSON.stringify(status);
    if (key === e.sent) return;
    if (this.send(id, status)) e.sent = key;
  }

  private compose(id: ConversationId, e: Entry): AgentStatus {
    const model = e.model ?? this.deps.configuredModel(id);
    const short = model ? shortModelName(model) : undefined;
    return {
      agent: this.deps.agentOf(id),
      ...(short ? { model: short } : {}),
      ...(e.effort ? { effort: e.effort } : {}),
      ...(e.context ? { context: e.context } : {}),
      ...(e.cost ? { cost: e.cost } : {}),
      ...(e.cacheExpiresAt !== undefined ? { cacheExpiresAt: e.cacheExpiresAt } : {}),
      ...(e.quota?.length ? { quota: e.quota } : {}),
    };
  }

  /** The adapter and address a status for this conversation goes to, if any platform can show it. */
  private target(id: ConversationId): { platform: PlatformAdapter; address: ConversationAddress } | undefined {
    const lane = this.deps.laneOf(id);
    if (!lane) return undefined;
    const platform = this.deps.platforms.get(lane.platformId);
    return platform?.setStatus ? { platform, address: lane.address } : undefined;
  }

  /** Hand a status to the platform. Swallows a throw (best-effort, see setStatus); false if not shown. */
  private send(id: ConversationId, status: AgentStatus | undefined): boolean {
    const t = this.target(id);
    if (!t) return false;
    try {
      t.platform.setStatus!(t.address, status);
      return true;
    } catch (err) {
      console.warn(`[status] ${id}: could not show the agent status:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}
