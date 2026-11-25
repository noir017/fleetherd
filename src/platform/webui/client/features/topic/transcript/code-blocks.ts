import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import type {
  CodeViewModule,
  HighlightFn,
  HighlightSpan,
  TranscriptIcons,
  TranscriptTopicLike,
} from './types.js';

const HL_MAX = 20000;
const HL_IDLE_MS = 250;
const HL_CACHE_MAX = 300;
const COPY_RESET_MS = 1500;
const HL_CHUNK_BUDGET_MS = 8;
const HL_CHUNK_YIELD_MS = 16;

export interface CodeBlocksDeps {
  readonly log: HTMLElement;
  readonly getExtraRoots: () => readonly (HTMLElement | null | undefined)[];
  readonly getTopic: () => string;
  readonly getTopics: () => readonly TranscriptTopicLike[];
  readonly codeView: () => Promise<CodeViewModule | null | undefined>;
  readonly getIcons: () => TranscriptIcons;
  readonly copyText: (s: string, cb: (ok: boolean) => void) => void;
  readonly warn?: (msg: string, err: unknown) => void;
}

export interface CodeBlocksController extends Disposable {
  enhance(
    root: Element | null | undefined,
    opts?: { readonly defer?: boolean; readonly skipHighlight?: boolean; readonly liveEl?: Element | null },
  ): void;
  sweep(): void;
  scheduleSweep(): void;
  attachDocumentEvents(doc?: Document): Disposable;
}

export function codeLang(code: Element): string {
  const m = /(?:^|\s)language-(\S+)/.exec(code.className || '');
  return m?.[1] ? m[1].toLowerCase() : '';
}

export function cbKey(frame: Element): string | null {
  const host = frame.closest('[data-k]');
  if (!host) return null;
  const hostKey = host.getAttribute('data-k');
  if (!hostKey) return null;
  const all = host.querySelectorAll('.cb');
  for (let i = 0; i < all.length; i++) {
    if (all[i] === frame) return `${hostKey}#${i}`;
  }
  return null;
}

export function cbWrapSet(frame: Element, on: boolean): void {
  frame.classList.toggle('wrap', on);
  const b = frame.querySelector('.cb-b[data-cb="wrap"]');
  if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
}

export function hlPaint(code: Element, src: string, spans: readonly HighlightSpan[]): void {
  const doc = code.ownerDocument;
  const frag = doc.createDocumentFragment();
  let at = 0;
  for (let i = 0; i < spans.length; i++) {
    const entry = spans[i];
    if (!entry) continue;
    const from = entry[0];
    const to = entry[1];
    if (!(from >= at && to > from && to <= src.length)) continue;
    if (from > at) frag.appendChild(doc.createTextNode(src.slice(at, from)));
    const span = doc.createElement('span');
    span.className = String(entry[2]);
    span.textContent = src.slice(from, to);
    frag.appendChild(span);
    at = to;
  }
  if (at < src.length) frag.appendChild(doc.createTextNode(src.slice(at)));
  code.textContent = '';
  code.appendChild(frag);
  code.setAttribute('data-hl', '');
}

class CodeBlocksControllerImpl implements CodeBlocksController {
  private readonly _deps: CodeBlocksDeps;
  private readonly _hlCache = new Map<string, readonly HighlightSpan[]>();
  private readonly _hlFns: Record<string, HighlightFn | null | false> = Object.create(null);
  private readonly _cbWrapped: Record<string, 1> = Object.create(null);
  private readonly _copyTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  private readonly _disposables = new DisposableStore();
  private _hlWarned = false;
  private _hlTimer: ReturnType<typeof setTimeout> | undefined;
  private _hlChunkTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: CodeBlocksDeps) {
    this._deps = deps;
  }

  private _hlWarn(e: unknown): void {
    if (this._hlWarned) return;
    this._hlWarned = true;
    if (this._deps.warn) this._deps.warn('a code language failed to load, showing plain text:', e);
    else console.warn('a code language failed to load, showing plain text:', e);
  }

  private _liveEl(): Element | null {
    const curTopic = this._deps.getTopic();
    const topics = this._deps.getTopics();
    let running = false;
    for (let i = 0; i < topics.length; i++) {
      const row = topics[i];
      if (row && row.id === curTopic) {
        running = Boolean(row.running);
        break;
      }
    }
    if (!running) return null;
    for (let n = this._deps.log.lastElementChild; n; n = n.previousElementSibling) {
      if (n.hasAttribute('data-k')) return n;
    }
    return null;
  }

  private _hlLoad(lang: string): void {
    if (lang in this._hlFns) return;
    this._hlFns[lang] = null;
    this._deps
      .codeView()
      .then((cv) => (cv && typeof cv.highlighter === 'function' ? cv.highlighter(lang) : null))
      .then(
        (fn) => {
          this._hlFns[lang] = typeof fn === 'function' ? fn : false;
          if (fn) this.sweep();
        },
        (e: unknown) => {
          this._hlFns[lang] = false;
          this._hlWarn(e);
        },
      );
  }

  private _hlApply(code: Element, live: boolean, cacheOnly = false): boolean {
    if (code.hasAttribute('data-hl') || code.firstElementChild) return false;
    const lang = codeLang(code);
    const src = code.textContent ?? '';
    if (!lang || !src || src.length > HL_MAX) return false;
    const key = `${lang}\n${src}`;
    let spans = this._hlCache.get(key);
    if (spans) {
      this._hlCache.delete(key);
      this._hlCache.set(key, spans);
      hlPaint(code, src, spans);
      return true;
    }
    if (live || cacheOnly) return false;
    const fn = this._hlFns[lang];
    if (fn === false) return false;
    if (!fn) {
      this._hlLoad(lang);
      return false;
    }
    try {
      spans = fn(src);
    } catch (e) {
      this._hlFns[lang] = false;
      this._hlWarn(e);
      return false;
    }
    this._hlCache.set(key, spans);
    if (this._hlCache.size > HL_CACHE_MAX) {
      const oldest = this._hlCache.keys().next().value;
      if (oldest !== undefined) this._hlCache.delete(oldest);
    }
    hlPaint(code, src, spans);
    return true;
  }

  scheduleSweep(): void {
    if (this._hlTimer !== undefined) clearTimeout(this._hlTimer);
    this._hlTimer = setTimeout(() => this.sweep(), HL_IDLE_MS);
  }

  sweep(): void {
    if (this._hlTimer !== undefined) {
      clearTimeout(this._hlTimer);
      this._hlTimer = undefined;
    }
    if (this._hlChunkTimer !== undefined) {
      clearTimeout(this._hlChunkTimer);
      this._hlChunkTimer = undefined;
    }
    const live = this._liveEl();
    const roots: (HTMLElement | null | undefined)[] = [
      this._deps.log,
      ...this._deps.getExtraRoots(),
    ];
    const pending: Element[] = [];
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      if (!root) continue;
      const codes = root.querySelectorAll('.cb pre>code[class*="language-"]:not([data-hl])');
      // Walk bottom-up so visible tail blocks in long transcripts highlight first.
      for (let i = codes.length - 1; i >= 0; i--) {
        const code = codes[i];
        if (code) pending.push(code);
      }
    }
    if (!pending.length) return;
    this._runSweepChunk(pending, 0, live);
  }

  private _runSweepChunk(pending: readonly Element[], startIndex: number, live: Element | null): void {
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    const deadline = now() + HL_CHUNK_BUDGET_MS;
    let i = startIndex;
    while (i < pending.length) {
      const code = pending[i];
      i++;
      if (!code || !code.isConnected) continue;
      const host = code.closest('[data-k]');
      const didWork = this._hlApply(code, Boolean(live) && host === live);
      if (didWork && i < pending.length && now() >= deadline) {
        this._hlChunkTimer = setTimeout(() => {
          this._hlChunkTimer = undefined;
          this._runSweepChunk(pending, i, this._liveEl());
        }, HL_CHUNK_YIELD_MS);
        return;
      }
    }
  }

  enhance(
    root: Element | null | undefined,
    opts?: { readonly defer?: boolean; readonly skipHighlight?: boolean; readonly liveEl?: Element | null },
  ): void {
    if (!root || !root.querySelectorAll) return;
    const defer = Boolean(opts?.defer);
    if (!defer) this.scheduleSweep();
    const frames = root.querySelectorAll('.cb');
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (!frame) continue;
      const k = cbKey(frame);
      if (k && this._cbWrapped[k]) cbWrapSet(frame, true);
    }
    if (opts?.skipHighlight) return;
    const codes = root.querySelectorAll('.cb pre>code[class*="language-"]');
    if (!codes.length) return;
    const live = opts && 'liveEl' in opts ? (opts.liveEl ?? null) : this._liveEl();
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (!code) continue;
      const host = code.closest('[data-k]');
      this._hlApply(code, Boolean(live) && host === live, defer);
    }
  }

  private _cbCopy(btn: HTMLElement, s: string): void {
    this._deps.copyText(s, (ok) => {
      const ic = this._deps.getIcons().icon;
      const say = ok ? tr('common.copied') : tr('msg.copyCodeFailed');
      btn.innerHTML = ok ? (ic.check ?? '') : (ic.cross ?? '');
      btn.title = say;
      btn.setAttribute('aria-label', say);
      const prev = this._copyTimers.get(btn);
      if (prev !== undefined) clearTimeout(prev);
      this._copyTimers.set(
        btn,
        setTimeout(() => {
          btn.innerHTML = ic.copy ?? '';
          btn.title = tr('common.copy');
          btn.setAttribute('aria-label', tr('msg.copyCodeAria'));
          this._copyTimers.delete(btn);
        }, COPY_RESET_MS),
      );
    });
  }

  attachDocumentEvents(doc: Document = document): Disposable {
    const sub = addDisposableListener(doc, 'click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const b = target ? target.closest('.cb-b[data-cb]') : null;
      const frame = b ? b.closest('.cb') : null;
      const code = frame ? frame.querySelector('pre>code') : null;
      if (!b || !frame || !code) return;
      if (b.getAttribute('data-cb') === 'copy') {
        this._cbCopy(b as HTMLElement, code.textContent ?? '');
        return;
      }
      const on = !frame.classList.contains('wrap');
      const k = cbKey(frame);
      cbWrapSet(frame, on);
      if (k) {
        if (on) this._cbWrapped[k] = 1;
        else delete this._cbWrapped[k];
      }
    });
    this._disposables.add(sub);
    return sub;
  }

  dispose(): void {
    if (this._hlTimer !== undefined) {
      clearTimeout(this._hlTimer);
      this._hlTimer = undefined;
    }
    if (this._hlChunkTimer !== undefined) {
      clearTimeout(this._hlChunkTimer);
      this._hlChunkTimer = undefined;
    }
    this._disposables.dispose();
  }
}

export function createCodeBlocksController(deps: CodeBlocksDeps): CodeBlocksController {
  return new CodeBlocksControllerImpl(deps);
}
