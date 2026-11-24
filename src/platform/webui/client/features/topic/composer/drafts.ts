import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import type { ComposerAttachment, ComposerDraft } from './types.js';

export const DRAFTS_STORAGE_KEY = 'aa_drafts';
export const DRAFT_MAX = 64 * 1024;
export const DRAFT_IDLE_MS = 1000;

export function parseStoredDrafts(raw: string | null): Record<string, ComposerDraft> {
  const result: Record<string, ComposerDraft> = {};
  if (!raw) return result;
  let saved: unknown = null;
  try {
    saved = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!saved || typeof saved !== 'object') return result;
  for (const [id, value] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof value === 'string' && value) {
      result[id] = { text: value, s: value.length, e: value.length, files: [] };
    }
  }
  return result;
}

export interface DraftStore {
  has(id: string): boolean;
  get(id: string): ComposerDraft | undefined;
  writeDraft(id: string): void;
  stash(id: string, text: string, s: number | null, e: number | null, files: ComposerAttachment[]): void;
  seed(id: string, text: string): void;
  appendText(id: string, text: string): void;
  appendFile(id: string, file: ComposerAttachment): void;
  forget(id: string): void;
  prune(known: Readonly<Record<string, unknown>>): void;
  keepOnly(keep: Readonly<Record<string, unknown>>): void;
  scheduleStash(fn: () => void): void;
  clearTimer(): void;
  attachWindowEvents(doc: Document, win: Window, onStash: () => void): Disposable;
}

export function createDraftStore(storage: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): DraftStore {
  const drafts: Record<string, ComposerDraft> = parseStoredDrafts(readRaw(storage, DRAFTS_STORAGE_KEY));
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  function writeDraft(id: string): void {
    if (!storage) return;
    try {
      const parsed = JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) || 'null') as Record<string, string> | null;
      const all: Record<string, string> = parsed && typeof parsed === 'object' ? parsed : {};
      const d = drafts[id];
      const want = d && d.text && d.text.length <= DRAFT_MAX ? d.text : undefined;
      if (all[id] === want) return;
      if (want === undefined) delete all[id];
      else all[id] = want;
      storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Ignore storage quota or serialization errors.
    }
  }

  function clearTimer(): void {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }

  function stash(
    id: string,
    text: string,
    s: number | null,
    e: number | null,
    files: ComposerAttachment[],
  ): void {
    clearTimer();
    if (!id) return;
    const had = Boolean(drafts[id]);
    if (text || files.length) {
      drafts[id] = { text, s, e, files };
    } else {
      delete drafts[id];
    }
    if (had || drafts[id]) writeDraft(id);
  }

  function seed(id: string, text: string): void {
    drafts[id] = { text, s: text.length, e: text.length, files: [] };
    writeDraft(id);
  }

  function appendText(id: string, text: string): void {
    const d = drafts[id] ?? (drafts[id] = { text: '', s: 0, e: 0, files: [] });
    const join = d.text && !/\s$/.test(d.text) ? ' ' : '';
    d.text = `${d.text}${join}${text}`;
    d.s = d.e = d.text.length;
    writeDraft(id);
  }

  function appendFile(id: string, file: ComposerAttachment): void {
    const d = drafts[id] ?? (drafts[id] = { text: '', s: 0, e: 0, files: [] });
    d.files.push(file);
  }

  function forget(id: string): void {
    if (!drafts[id]) return;
    delete drafts[id];
    writeDraft(id);
  }

  function prune(known: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(drafts)) {
      if (!known[id]) forget(id);
    }
  }

  function keepOnly(keep: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(drafts)) {
      if (!keep[id]) delete drafts[id];
    }
    if (!storage) return;
    try {
      const parsed = JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) || 'null') as Record<string, string> | null;
      const all: Record<string, string> = parsed && typeof parsed === 'object' ? parsed : {};
      let left = 0;
      for (const id of Object.keys(all)) {
        if (!keep[id]) delete all[id];
        else left++;
      }
      if (left) storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(all));
      else storage.removeItem(DRAFTS_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  function scheduleStash(fn: () => void): void {
    clearTimer();
    draftTimer = setTimeout(() => {
      draftTimer = null;
      fn();
    }, DRAFT_IDLE_MS);
  }

  function attachWindowEvents(doc: Document, win: Window, onStash: () => void): Disposable {
    const store = new DisposableStore();
    store.add(
      addDisposableListener(doc, 'visibilitychange', () => {
        if (doc.visibilityState === 'hidden') onStash();
      }),
    );
    store.add(
      addDisposableListener(win, 'pagehide', () => {
        onStash();
      }),
    );
    return store;
  }

  return {
    has: (id) => Boolean(drafts[id]),
    get: (id) => drafts[id],
    writeDraft,
    stash,
    seed,
    appendText,
    appendFile,
    forget,
    prune,
    keepOnly,
    scheduleStash,
    clearTimer,
    attachWindowEvents,
  };
}

function readRaw(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
