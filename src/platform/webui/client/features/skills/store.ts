import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelOp,
  SkillPanelSearches,
} from '../../../../adapter.js';
import { Emitter, type Event } from '../../base/event.js';
import type { Disposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import type { SkillListResponse, SkillOpResponse } from './types.js';

const CACHE_KEY = 'skills_cache_v1';
const CACHE_VERSION = 1;

interface CachedSkillsPayload {
  readonly v: number;
  readonly at: number;
  readonly enabled: boolean;
  readonly skills: SkillPanelEntry[];
}

interface SkillQueueEntry {
  chain: Promise<void>;
  pending: number;
  gen: number;
}

export interface SkillsSnapshot {
  readonly enabled: boolean;
  readonly list: readonly SkillPanelEntry[];
  readonly searches: SkillPanelSearches | null;
  readonly loading: boolean;
  readonly fetchedAt: number;
  readonly error: string | null;
}

export interface SkillMutationEvent {
  readonly name: string;
  readonly detail?: SkillPanelDetail;
  readonly action: SkillPanelOp['action'];
}

export interface SkillOpOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: SkillPanelDetail;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return tr('common.networkError');
}

export function isValidSkillEntry(value: unknown): value is SkillPanelEntry {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    r.name !== '' &&
    typeof r.description === 'string' &&
    typeof r.version === 'string' &&
    typeof r.status === 'string' &&
    typeof r.pinned === 'boolean' &&
    typeof r.resident === 'boolean' &&
    typeof r.uses === 'number' &&
    Array.isArray(r.agents)
  );
}

export class SkillsStore implements Disposable {
  private readonly _ctx: PluginContext;
  private readonly _onDidChange = new Emitter<void>();
  private readonly _onDidMutateSkill = new Emitter<SkillMutationEvent>();
  private _enabled = true;
  private _list: SkillPanelEntry[] = [];
  private _searches: SkillPanelSearches | null = null;
  private _loading = false;
  private _fetchedAt = 0;
  private _error: string | null = null;
  // Bumped on every outgoing write so stale reads started earlier are discarded and replayed.
  private _epoch = 0;
  private _refreshPending = false;
  private _refreshPendingManual = false;
  private _inFlightRefresh: Promise<void> | null = null;
  private readonly _queue: Record<string, SkillQueueEntry> = {};
  private readonly _snapshots = new Map<string, string>();
  private _disposed = false;

  readonly onDidChange: Event<void> = this._onDidChange.event;
  readonly onDidMutateSkill: Event<SkillMutationEvent> = this._onDidMutateSkill.event;

  constructor(ctx: PluginContext) {
    this._ctx = ctx;
    this._loadCache();
  }

  snapshot(): SkillsSnapshot {
    return {
      enabled: this._enabled,
      list: this._list,
      searches: this._searches,
      loading: this._loading,
      fetchedAt: this._fetchedAt,
      error: this._error,
    };
  }

  find(name: string): SkillPanelEntry | undefined {
    return this._list.find((s) => s.name === name);
  }

  categories(): string[] {
    const set = new Set<string>();
    for (const s of this._list) {
      const cat = s.category?.trim();
      if (cat) set.add(cat);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  recordSnapshot(name: string, filePath: string, versionOrId: string, content: string): void {
    if (!name || !filePath || !versionOrId) return;
    this._snapshots.set(`${name}\0${filePath}\0${versionOrId}`, content);
  }

  getSnapshot(name: string, filePath: string, versionOrId: string): string | undefined {
    if (!name || !filePath || !versionOrId) return undefined;
    return this._snapshots.get(`${name}\0${filePath}\0${versionOrId}`);
  }

  hasPendingWrites(): boolean {
    return Object.values(this._queue).some((q) => q.pending > 0);
  }

  clearError(): void {
    if (this._error === null) return;
    this._error = null;
    this._emit();
  }

  async refresh(manual = false): Promise<void> {
    if (this._disposed) return;
    if (this._inFlightRefresh) {
      if (manual) this._refreshPendingManual = true;
      return this._inFlightRefresh;
    }
    this._loading = true;
    if (manual) this._error = null;
    this._emit();

    const epoch = this._epoch;
    const task = this._ctx.api
      .get<SkillListResponse>('/api/skills')
      .then((res) => {
        if (this._disposed) return;
        this._loading = false;
        this._inFlightRefresh = null;
        if (epoch !== this._epoch) {
          this._scheduleReplayRefresh(manual);
          return;
        }
        this._enabled = res.enabled !== false;
        this._list = Array.isArray(res.skills) ? res.skills.filter(isValidSkillEntry) : [];
        this._searches = res.searches ?? null;
        this._fetchedAt = Date.now();
        this._error = null;
        this._saveCache();
        this._emit();
      })
      .catch((err: unknown) => {
        if (this._disposed) return;
        this._loading = false;
        this._inFlightRefresh = null;
        if (epoch !== this._epoch) {
          this._scheduleReplayRefresh(manual);
          return;
        }
        if (manual || !this._fetchedAt) {
          this._error = tr(this._fetchedAt ? 'skills.refreshFailed' : 'skills.loadFailed', {
            err: errorMessage(err),
          });
        }
        this._emit();
      });

    this._inFlightRefresh = task;
    return task;
  }

  async show(name: string, file?: string): Promise<SkillOpOutcome> {
    const op: SkillPanelOp = file ? { action: 'show', name, file } : { action: 'show', name };
    try {
      const res = await this._ctx.api.post<SkillOpResponse>('/api/skills/op', op);
      if (this._disposed) return { ok: false, error: tr('skills.openFailed') };
      if (!res || !res.ok || !res.detail) {
        return { ok: false, error: (res && res.error) || tr('skills.openFailed') };
      }
      if (Array.isArray(res.skills)) {
        this._list = res.skills;
        this._saveCache();
        this._emit();
      }
      return { ok: true, detail: res.detail };
    } catch (err: unknown) {
      return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
    }
  }

  async execOp(op: SkillPanelOp): Promise<SkillOpOutcome> {
    if (this._disposed) return { ok: false, error: tr('common.didNotWork') };
    // Security invariant #8: every mutation goes through server /api/skills/op validation.
    this._epoch++;
    try {
      const res = await this._ctx.api.post<SkillOpResponse>('/api/skills/op', op);
      if (this._disposed) return { ok: false, error: tr('common.didNotWork') };
      if (!res || !res.ok) {
        this._replayIfIdle();
        return { ok: false, error: (res && res.error) || tr('common.didNotWork') };
      }
      if (Array.isArray(res.skills)) {
        this._list = res.skills;
        this._saveCache();
      }
      this._error = null;
      this._emit();
      this._onDidMutateSkill.fire({ name: op.name, detail: res.detail, action: op.action });
      this._replayIfIdle();
      return { ok: true, detail: res.detail };
    } catch (err: unknown) {
      this._replayIfIdle();
      return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
    }
  }

  enqueueToggle(name: string, op: SkillPanelOp, optimistic: Partial<SkillPanelEntry>): Promise<SkillOpOutcome> {
    const q = this._queue[name] ?? (this._queue[name] = { chain: Promise.resolve(), pending: 0, gen: 0 });
    const gen = q.gen;
    q.pending++;
    this._epoch++;
    this._applyOptimistic(name, optimistic);

    let outcome: SkillOpOutcome = { ok: true };
    const next = q.chain
      .then(async (): Promise<SkillOpResponse | null> => {
        if (this._disposed || q.gen !== gen) return null;
        try {
          return await this._ctx.api.post<SkillOpResponse>('/api/skills/op', op);
        } catch (err: unknown) {
          return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
        }
      })
      .then(async (res) => {
        q.pending--;
        if (this._disposed || res === null) {
          this._replayIfIdle();
          return;
        }
        if (!res.ok) {
          q.gen++;
          const errMsg = res.error || tr('common.didNotWork');
          this._error = errMsg;
          outcome = { ok: false, error: errMsg };
          this._emit();
          await this._resyncSkill(name);
          return;
        }
        if (Array.isArray(res.skills)) {
          const updated = res.skills.find((s) => s.name === name);
          if (updated) this._replaceEntry(name, updated);
          else this._list = res.skills;
          this._saveCache();
        }
        this._error = null;
        this._emit();
        if (q.pending === 0) {
          this._onDidMutateSkill.fire({ name, detail: res.detail, action: op.action });
          this._replayIfIdle();
        }
        outcome = { ok: true, detail: res.detail };
      });

    q.chain = next;
    return next.then(() => outcome);
  }

  setEnabled(name: string, enabled: boolean): Promise<SkillOpOutcome> {
    const op: SkillPanelOp = { action: enabled ? 'restore' : 'archive', name };
    return this.enqueueToggle(name, op, { status: enabled ? 'active' : 'archived' });
  }

  setResident(name: string, resident: boolean): Promise<SkillOpOutcome> {
    const op: SkillPanelOp = { action: 'resident', name, resident };
    return this.enqueueToggle(name, op, { resident });
  }

  setPinned(name: string, pinned: boolean): Promise<SkillOpOutcome> {
    return this.execOp({ action: 'pin', name, pinned });
  }

  setCategory(name: string, category: string): Promise<SkillOpOutcome> {
    return this.execOp({ action: 'category', name, category });
  }

  create(params: { name: string; description: string; body?: string; category?: string }): Promise<SkillOpOutcome> {
    const category = params.category?.trim();
    const op: SkillPanelOp = params.body
      ? {
          action: 'create',
          name: params.name,
          description: params.description,
          body: params.body,
          ...(category ? { category } : {}),
        }
      : {
          action: 'create',
          name: params.name,
          description: params.description,
          ...(category ? { category } : {}),
        };
    return this.execOp(op);
  }

  patchSkillMd(name: string, version: string, content: string): Promise<SkillOpOutcome> {
    // Security invariant #8: patch MUST carry the exact version returned by show.
    return this.execOp({ action: 'patch', name, version, content });
  }

  writeFile(name: string, file: string, content: string): Promise<SkillOpOutcome> {
    return this.execOp({ action: 'write-file', name, file, content });
  }

  removeFile(name: string, file: string): Promise<SkillOpOutcome> {
    return this.execOp({ action: 'remove-file', name, file });
  }

  revert(name: string, id: string): Promise<SkillOpOutcome> {
    return this.execOp({ action: 'revert', name, id });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._onDidChange.dispose();
    this._onDidMutateSkill.dispose();
  }

  private _applyOptimistic(name: string, patch: Partial<SkillPanelEntry>): void {
    const idx = this._list.findIndex((s) => s.name === name);
    if (idx < 0) return;
    const prev = this._list[idx];
    if (!prev) return;
    this._list = this._list.slice();
    this._list[idx] = { ...prev, ...patch };
    this._emit();
  }

  private _replaceEntry(name: string, entry: SkillPanelEntry): void {
    const idx = this._list.findIndex((s) => s.name === name);
    if (idx < 0) return;
    this._list = this._list.slice();
    this._list[idx] = entry;
  }

  private async _resyncSkill(name: string): Promise<void> {
    const epoch = this._epoch;
    try {
      const res = await this._ctx.api.get<SkillListResponse>('/api/skills');
      if (this._disposed || epoch !== this._epoch) return;
      const fresh = res.skills?.find((s) => s.name === name);
      if (fresh) {
        this._replaceEntry(name, fresh);
        this._saveCache();
        this._emit();
      }
    } catch {
      // Keep error notice visible; next manual refresh will recover.
    } finally {
      this._replayIfIdle();
    }
  }

  private _scheduleReplayRefresh(manual: boolean): void {
    this._refreshPending = true;
    this._refreshPendingManual = this._refreshPendingManual || manual;
    this._replayIfIdle();
  }

  private _replayIfIdle(): void {
    if (this._disposed || !this._refreshPending || this._loading || this.hasPendingWrites()) return;
    const manual = this._refreshPendingManual;
    this._refreshPending = false;
    this._refreshPendingManual = false;
    void this.refresh(manual);
  }

  private _loadCache(): void {
    try {
      const raw = this._ctx.storage.get<CachedSkillsPayload>(CACHE_KEY);
      if (!raw || typeof raw !== 'object' || raw.v !== CACHE_VERSION || raw.enabled === false) return;
      if (!Array.isArray(raw.skills) || !raw.skills.every(isValidSkillEntry)) return;
      this._enabled = true;
      this._list = raw.skills;
      this._fetchedAt = Number(raw.at) || 0;
    } catch {
      // Ignore malformed cache.
    }
  }

  private _saveCache(): void {
    try {
      if (!this._enabled) {
        this._ctx.storage.set(CACHE_KEY, undefined);
        return;
      }
      const payload: CachedSkillsPayload = {
        v: CACHE_VERSION,
        at: this._fetchedAt,
        enabled: true,
        skills: this._list,
      };
      this._ctx.storage.set(CACHE_KEY, payload);
    } catch {
      // Ignore storage quota errors.
    }
  }

  private _emit(): void {
    if (!this._disposed) this._onDidChange.fire();
  }
}
