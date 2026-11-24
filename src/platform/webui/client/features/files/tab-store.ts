import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, toDisposable } from '../../base/lifecycle.js';
import { canonicalFileKey } from './helpers.js';
import type { FeaturePanelRef, FileEditorInput, RevealInTreeRequest } from './types.js';

export interface FileTabRecord {
  readonly key: string;
  readonly panelId: string;
  input: FileEditorInput;
  title: string;
  dirty: boolean;
  readonly panelApi: FeaturePanelRef | null;
  readonly focus: () => void;
  readonly requestClose: () => Promise<boolean>;
}

export interface OpenOrFocusResult {
  readonly reused: boolean;
  readonly key: string;
  readonly tab?: FileTabRecord;
}

export class FileTabStore implements Disposable {
  private readonly _tabs = new Map<string, FileTabRecord>();
  private _activeKey: string | null = null;
  private _pendingReveal: RevealInTreeRequest | null = null;
  private _disposed = false;

  private readonly _onDidChange = new Emitter<void>();
  private readonly _onReveal = new Emitter<RevealInTreeRequest>();

  readonly onDidChange: Event<void> = this._onDidChange.event;
  readonly onReveal: Event<RevealInTreeRequest> = this._onReveal.event;

  register(record: FileTabRecord): Disposable {
    if (this._disposed) return toDisposable(() => undefined);
    this._tabs.set(record.key, record);
    this._activeKey = record.key;
    this._onDidChange.fire();
    return toDisposable(() => {
      if (this._tabs.get(record.key) === record) {
        this._tabs.delete(record.key);
        if (this._activeKey === record.key) {
          const remaining = [...this._tabs.keys()];
          this._activeKey = remaining[remaining.length - 1] ?? null;
        }
        this._onDidChange.fire();
      }
    });
  }

  get(key: string): FileTabRecord | undefined {
    return this._tabs.get(key);
  }

  getByInput(input: Pick<FileEditorInput, 'topicId' | 'root' | 'path' | 'rel'>): FileTabRecord | undefined {
    return this._tabs.get(canonicalFileKey(input));
  }

  list(): readonly FileTabRecord[] {
    return [...this._tabs.values()];
  }

  getActive(): FileTabRecord | undefined {
    if (!this._activeKey) return undefined;
    return this._tabs.get(this._activeKey);
  }

  setActive(key: string | null): void {
    if (this._disposed) return;
    if (key !== null && !this._tabs.has(key)) return;
    if (this._activeKey === key) return;
    this._activeKey = key;
    this._onDidChange.fire();
  }

  setDirty(key: string, dirty: boolean): void {
    if (this._disposed) return;
    const rec = this._tabs.get(key);
    if (!rec || rec.dirty === dirty) return;
    rec.dirty = dirty;
    this._onDidChange.fire();
  }

  hasDirtyTabs(): boolean {
    for (const tab of this._tabs.values()) {
      if (tab.dirty) return true;
    }
    return false;
  }

  openOrFocus(
    input: FileEditorInput,
    openNew: (input: FileEditorInput) => void,
  ): OpenOrFocusResult {
    const key = canonicalFileKey(input);
    const existing = this._tabs.get(key);
    if (existing) {
      this._activeKey = key;
      existing.focus();
      this._onDidChange.fire();
      return { reused: true, key, tab: existing };
    }
    openNew(input);
    return { reused: false, key };
  }

  async requestClose(key: string): Promise<boolean> {
    const tab = this._tabs.get(key);
    if (!tab) return false;
    return tab.requestClose();
  }

  requestReveal(req: RevealInTreeRequest): void {
    if (this._disposed) return;
    this._pendingReveal = req;
    this._onReveal.fire(req);
  }

  consumePendingReveal(topicId?: string): RevealInTreeRequest | null {
    const pending = this._pendingReveal;
    if (!pending) return null;
    if (topicId && pending.topicId !== topicId) return null;
    this._pendingReveal = null;
    return pending;
  }

  clearPendingReveal(req: RevealInTreeRequest): void {
    if (
      this._pendingReveal &&
      this._pendingReveal.topicId === req.topicId &&
      this._pendingReveal.path === req.path
    ) {
      this._pendingReveal = null;
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._tabs.clear();
    this._activeKey = null;
    this._pendingReveal = null;
    this._onDidChange.dispose();
    this._onReveal.dispose();
  }
}
