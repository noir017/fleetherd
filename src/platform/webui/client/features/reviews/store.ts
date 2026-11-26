import type {
  ReviewPanelList,
  ReviewPanelPreference,
} from '../../../../adapter.js';
import type { ReviewOpRequest, SkillOpRequest } from '../../../protocol.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import type { ReviewsPluginDeps } from './types.js';

export interface ReviewsStoreSnapshot {
  readonly data: ReviewPanelList | null;
  readonly note: string | null;
  readonly busyKeys: ReadonlySet<string>;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return tr('common.networkError');
}

// Spacing ignored to match the server's preferenceKey normalization.
function carries(sent: string, want: string): boolean {
  const flat = (s: unknown): string => String(s == null ? '' : s).replace(/\s+/g, '');
  const w = flat(want);
  return w.length > 0 && flat(sent).includes(w);
}

export function adoptDraftText(suggestion: string): string {
  return tr('reviews.adoptDraft', { suggestion });
}

export class ReviewsStore implements Disposable {
  private readonly _ctx: PluginContext;
  private readonly _deps: ReviewsPluginDeps;
  private readonly _onDidChange = new Emitter<void>();
  private _data: ReviewPanelList | null = null;
  private _note: string | null = null;
  private _seq = 0;
  private _disposed = false;
  private readonly _busyKeys = new Set<string>();
  private readonly _adopted = new Map<string, { readonly text: string }>();

  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(ctx: PluginContext, deps: ReviewsPluginDeps) {
    this._ctx = ctx;
    this._deps = deps;
  }

  snapshot(): ReviewsStoreSnapshot {
    return {
      data: this._data,
      note: this._note,
      busyKeys: this._busyKeys,
    };
  }

  pendingCount(): number | null {
    if (!this._data) return null;
    const count = this._data.pending?.length ?? 0;
    return count > 0 ? count : null;
  }

  reviewsCount(): number | null {
    return this._data ? this._data.reviews.length : null;
  }

  clearNote(): void {
    if (this._note === null) return;
    this._note = null;
    this._onDidChange.fire();
  }

  rememberAdopted(topicId: string, suggestion: string): void {
    this._adopted.set(topicId, { text: suggestion });
  }

  settleAdopted(topicId: string, typed: string): void {
    const entry = this._adopted.get(topicId);
    if (!entry || !carries(typed, entry.text)) return;
    void this.dismissSuggestion(entry.text);
  }

  async load(): Promise<void> {
    if (this._disposed) return;
    const seq = ++this._seq;
    try {
      const data = await this._ctx.api.get<ReviewPanelList | null>('/api/reviews');
      if (this._disposed || seq !== this._seq) return;
      this._data = data ?? { enabled: false, running: false, reviews: [], pending: [] };
      this._note = null;
      this._onDidChange.fire();
      this._deps.onBadgeChange?.();
    } catch (err) {
      if (this._disposed || seq !== this._seq) return;
      this._note = tr('reviews.refreshFailed', { err: errorMessage(err) });
      this._onDidChange.fire();
    }
  }

  async dismissSuggestion(text: string): Promise<boolean> {
    if (this._disposed) return false;
    const key = `dismiss:${text}`;
    this._busyKeys.add(key);
    this._onDidChange.fire();
    const body: ReviewOpRequest = { action: 'dismiss', text };
    try {
      const next = await this._ctx.api.post<ReviewPanelList | null>('/api/reviews/op', body, );
      if (this._disposed) return false;
      this._seq++;
      this._data = next ?? this._data;
      this._note = null;
      for (const [topicId, entry] of this._adopted) {
        if (entry.text === text) this._adopted.delete(topicId);
      }
      this._deps.onBadgeChange?.();
      return true;
    } catch (err) {
      if (!this._disposed) {
        this._note = tr('reviews.dismissFailed', { err: errorMessage(err) });
      }
      return false;
    } finally {
      this._busyKeys.delete(key);
      if (!this._disposed) this._onDidChange.fire();
    }
  }

  async revertChange(name: string, id: string): Promise<boolean> {
    if (this._disposed) return false;
    const key = `revert:${name}:${id}`;
    this._busyKeys.add(key);
    this._onDidChange.fire();
    const body: ReviewOpRequest = { action: 'revert', name, id };
    try {
      const next = await this._ctx.api.post<ReviewPanelList | null>('/api/reviews/op', body);
      if (this._disposed) return false;
      this._seq++;
      this._data = next ?? this._data;
      this._note = null;
      this._deps.onBadgeChange?.();
      return true;
    } catch (err) {
      if (!this._disposed) {
        this._note = tr('reviews.revertFailed', { name, err: errorMessage(err) });
      }
      return false;
    } finally {
      this._busyKeys.delete(key);
      if (!this._disposed) this._onDidChange.fire();
    }
  }

  async archiveSuggestion(pref: ReviewPanelPreference): Promise<boolean> {
    if (this._disposed || !pref.archive) return false;
    const skillName = pref.archive.name;
    const key = `archive:${skillName}`;
    this._busyKeys.add(key);
    this._onDidChange.fire();
    this._deps.beforeSkillArchive?.();
    const body: SkillOpRequest = { action: 'archive', name: skillName };
    try {
      const res = await this._ctx.api.post<{ readonly ok?: boolean; readonly error?: string }>('/api/skills/op', body);
      if (!res?.ok) throw new Error(res?.error || tr('reviews.archiveRefused'));
      await this.load();
      this._deps.afterSkillArchive?.(true);
      return true;
    } catch (err) {
      if (!this._disposed) {
        this._note = tr('reviews.archiveFailed', { name: skillName, err: errorMessage(err) });
      }
      this._deps.afterSkillArchive?.(false);
      return false;
    } finally {
      this._busyKeys.delete(key);
      if (!this._disposed) this._onDidChange.fire();
    }
  }

  async adoptSuggestion(pref: ReviewPanelPreference): Promise<boolean> {
    if (this._disposed) return false;
    const key = `adopt:${pref.text}`;
    this._busyKeys.add(key);
    this._onDidChange.fire();
    const draft = adoptDraftText(pref.text);
    try {
      if (this._deps.createTopic) {
        return await this._deps.createTopic({ text: pref.text, draft });
      }
      const active = this._ctx.topics.active();
      if (active) {
        this.rememberAdopted(active.id, pref.text);
        this._ctx.topics.insertIntoComposer(active.id, draft);
        return true;
      }
      return false;
    } finally {
      this._busyKeys.delete(key);
      if (!this._disposed) this._onDidChange.fire();
    }
  }

  dispose(): void {
    this._disposed = true;
    this._busyKeys.clear();
    this._adopted.clear();
    this._onDidChange.dispose();
  }
}
