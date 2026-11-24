import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { text } from '../../../services/api.js';
import type { MsgMarkupResult, TranscriptIcons, TranscriptMessage } from './types.js';

const BTW_RE = /^\s*\/btw(?:\s+([\s\S]*))?$/;
const BTW_HEAD_RE = /^<p>\u21aa btw: [\s\S]*?<\/p>\s*/;
const BTW_FOOT_RE = /<p>((?:side question|\u65c1\u767d\u63d0\u95ee) \u2014 [^<]*)<\/p>\s*$/;
const BTW_STICK_PX = 40;

export function ownText(m: TranscriptMessage): string | null {
  if (m._local) return m._text ?? null;
  const x = /^<div class="raw">([^<]*)<\/div>/.exec(m.html || '');
  if (!x || x[1] === undefined) return null;
  return x[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function btwAsked(key: string, m: TranscriptMessage | null | undefined): string | null {
  if (!m || !m.own || String(key).startsWith('h:')) return null;
  const raw = ownText(m);
  const x = raw == null ? null : BTW_RE.exec(raw);
  return x ? (x[1] || '').trim() : null;
}

export function btwOf(m: TranscriptMessage | null | undefined, epoch: number): string | null {
  return m && m.kind === 'aside' && m.quote && m.quote.id ? `${m._g || epoch}:${m.quote.id}` : null;
}

export function seqOf(id: string): number {
  const n = parseInt(String(id).slice(1), 10);
  return Number.isNaN(n) ? 0 : n;
}

export function formatBtwPartHtml(html: string): string {
  return String(html || '')
    .replace(BTW_HEAD_RE, '')
    .replace(BTW_FOOT_RE, '<p class="btw-foot">$1</p>');
}

export interface BtwDeps {
  readonly btwBox: HTMLElement;
  readonly btwQ: HTMLElement;
  readonly btwBody: HTMLElement;
  readonly getData: () => Readonly<Record<string, TranscriptMessage | undefined>>;
  readonly getEls: () => Readonly<Record<string, HTMLElement | undefined>>;
  readonly getEpoch: () => number;
  readonly isHistory: (m: TranscriptMessage | undefined) => boolean;
  readonly isStuck: (m: TranscriptMessage) => boolean;
  readonly renderFailedActions: (m: TranscriptMessage) => string;
  readonly formatClock: (ms: number) => string;
  readonly getIcons: () => TranscriptIcons;
  readonly paint: (key: string) => void;
  readonly enhanceCodeBlocks: (root: Element) => void;
}

export interface BtwController extends Disposable {
  isOpen(): boolean;
  getKey(): string | null;
  isNesting(): boolean;
  isHeld(key: string, m: TranscriptMessage): boolean;
  parts(qk: string): string[];
  lineMarkup(key: string, m: TranscriptMessage, asked: string, hist: boolean): MsgMarkupResult;
  link(key: string, m: TranscriptMessage): void;
  open(qk: string): void;
  close(byHand: boolean): void;
  render(top: boolean): void;
  onArrived(m: TranscriptMessage): void;
  onMessageDropped(key: string, m: TranscriptMessage | undefined): void;
  transferKey(fromKey: string, toKey: string): void;
  attachCloseButton(btn: HTMLElement | null): Disposable;
}

class BtwControllerImpl implements BtwController {
  private readonly _deps: BtwDeps;
  private _btwKey: string | null = null;
  private _btwSig = '';
  private readonly _btwShut: Record<string, 1> = {};
  private _btwNest = false;
  private readonly _disposables = new DisposableStore();

  constructor(deps: BtwDeps) {
    this._deps = deps;
  }

  isOpen(): boolean {
    return !this._deps.btwBox.hidden;
  }

  getKey(): string | null {
    return this._btwKey;
  }

  isNesting(): boolean {
    return this._btwNest;
  }

  isHeld(key: string, m: TranscriptMessage): boolean {
    if (String(key).startsWith('h:')) return false;
    const q = btwOf(m, this._deps.getEpoch());
    const data = this._deps.getData();
    return Boolean(q && data[q] && btwAsked(q, data[q]) !== null);
  }

  parts(qk: string): string[] {
    const data = this._deps.getData();
    const epoch = this._deps.getEpoch();
    const out: string[] = [];
    for (const k of Object.keys(data)) {
      if (btwOf(data[k], epoch) === qk) out.push(k);
    }
    out.sort((a, b) => {
      const ma = data[a];
      const mb = data[b];
      if (!ma || !mb) return 0;
      return ma.at - mb.at || seqOf(ma.id) - seqOf(mb.id);
    });
    return out;
  }

  lineMarkup(
    key: string,
    m: TranscriptMessage,
    asked: string,
    hist: boolean,
  ): MsgMarkupResult {
    const answered = !m._local && this.parts(key).length > 0;
    const isStuck = this._deps.isStuck(m);
    const chevron = this._deps.getIcons().icon.chevronRight ?? '';
    const state = answered
      ? tr('btw.answer') + chevron
      : isStuck
        ? ''
        : hist
          ? tr('btw.noAnswer')
          : tr('btw.waiting');
    const shown = this._btwKey === key && !this._deps.btwBox.hidden;
    const cls =
      'm btw-q' +
      (hist ? ' hist' : '') +
      (m._local && m._state === 'sending' ? ' pending' : '') +
      (isStuck ? ' failed' : '');
    let h =
      '<button type="button" class="btw-chip" aria-haspopup="dialog" aria-controls="btw"' +
      ' aria-expanded="' +
      (shown ? 'true' : 'false') +
      '" title="' +
      text(asked ? tr('btw.titleWith', { asked }) : tr('btw.title')) +
      '">' +
      '<span class="btw-tag">btw</span>' +
      '<span class="btw-text">' +
      text(asked || '/btw') +
      '</span>' +
      (state ? '<span class="btw-state' + (answered ? ' ready' : '') + '">' + state + '</span>' : '') +
      '<span class="btw-when">' +
      text(this._deps.formatClock(m.at)) +
      '</span>' +
      '</button>';
    if (isStuck) h += this._deps.renderFailedActions(m);
    return { cls, h };
  }

  link(key: string, m: TranscriptMessage): void {
    const qk = btwOf(m, this._deps.getEpoch());
    const list = qk ? [qk] : btwAsked(key, m) !== null ? this.parts(key) : [];
    if (!list.length) return;
    const els = this._deps.getEls();
    const data = this._deps.getData();
    this._btwNest = true;
    try {
      for (let i = 0; i < list.length; i++) {
        const target = list[i];
        if (target && els[target] && data[target]) this._deps.paint(target);
      }
    } finally {
      this._btwNest = false;
    }
  }

  private _renderBodyHtml(m: TranscriptMessage, key: string): string {
    const data = this._deps.getData();
    const list = m._local ? [] : this.parts(key);
    let h = '';
    for (let i = 0; i < list.length; i++) {
      const pk = list[i];
      const part = pk ? data[pk] : undefined;
      if (!part) continue;
      const body = formatBtwPartHtml(part.html);
      if (body) h += '<div class="b">' + body + '</div>';
    }
    if (h) return h;
    const waitText = this._deps.isStuck(m)
      ? text(tr('btw.notSent'))
      : this._deps.isHistory(m)
        ? text(tr('btw.restarted'))
        : '<span class="set-spin" aria-hidden="true"></span>' + text(tr('btw.asking'));
    return `<div class="btw-wait">${waitText}</div>`;
  }

  render(top: boolean): void {
    const data = this._deps.getData();
    const m = this._btwKey ? data[this._btwKey] : undefined;
    const asked = m && this._btwKey ? btwAsked(this._btwKey, m) : null;
    if (asked === null || !m || !this._btwKey) {
      this.close(false);
      return;
    }
    this._deps.btwQ.textContent = asked || '/btw';
    this._deps.btwQ.title = asked;
    const h = this._renderBodyHtml(m, this._btwKey);
    const bodyEl = this._deps.btwBody;
    const stick = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < BTW_STICK_PX;
    if (h !== this._btwSig) {
      bodyEl.innerHTML = h;
      this._btwSig = h;
      this._deps.enhanceCodeBlocks(bodyEl);
    }
    if (top) bodyEl.scrollTop = 0;
    else if (stick) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  open(qk: string): void {
    const data = this._deps.getData();
    if (!data[qk]) return;
    const was = this._btwKey;
    this._btwKey = qk;
    delete this._btwShut[qk];
    this._deps.btwBox.hidden = false;
    this._btwSig = '';
    this.render(true);
    const els = this._deps.getEls();
    if (was && was !== qk && els[was] && data[was]) this._deps.paint(was);
    if (els[qk]) this._deps.paint(qk);
  }

  close(byHand: boolean): void {
    if (this._deps.btwBox.hidden) return;
    const k = this._btwKey;
    this._deps.btwBox.hidden = true;
    this._btwKey = null;
    this._btwSig = '';
    this._deps.btwBody.innerHTML = '';
    if (!k) return;
    if (byHand) this._btwShut[k] = 1;
    if (this._deps.getEls()[k] && this._deps.getData()[k]) this._deps.paint(k);
  }

  onArrived(m: TranscriptMessage): void {
    const qk = btwOf(m, this._deps.getEpoch());
    const data = this._deps.getData();
    if (!qk || !data[qk] || btwAsked(qk, data[qk]) === null) return;
    if (!this._deps.btwBox.hidden && this._btwKey === qk) this.render(false);
    else if (this._deps.btwBox.hidden && !this._btwShut[qk]) this.open(qk);
  }

  onMessageDropped(key: string, m: TranscriptMessage | undefined): void {
    if (m && btwAsked(key, m) !== null) {
      if (this._btwKey === key) this.close(false);
      const list = this.parts(key);
      for (let i = 0; i < list.length; i++) {
        const pk = list[i];
        if (pk) this._deps.paint(pk);
      }
    }
    const q = btwOf(m, this._deps.getEpoch());
    if (q && q === this._btwKey && !this._deps.btwBox.hidden) this.render(false);
    if (q && this._deps.getEls()[q] && this._deps.getData()[q]) this._deps.paint(q);
  }

  transferKey(fromKey: string, toKey: string): void {
    if (this._btwKey === fromKey) this._btwKey = toKey;
    if (this._btwShut[fromKey]) {
      this._btwShut[toKey] = 1;
      delete this._btwShut[fromKey];
    }
  }

  attachCloseButton(btn: HTMLElement | null): Disposable {
    if (!btn) return { dispose() {} };
    const sub = addDisposableListener(btn, 'click', () => this.close(true));
    this._disposables.add(sub);
    return sub;
  }

  dispose(): void {
    this._disposables.dispose();
  }
}

export function createBtwController(deps: BtwDeps): BtwController {
  return new BtwControllerImpl(deps);
}
