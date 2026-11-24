import type { HistoryPanelSession } from '../../../../adapter.js';
import type { WebMessage } from '../../../protocol.js';
import { addDisposableListener } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createActionBar,
  createNotice,
  type ActionBarController,
  type ActionItem,
  type NoticeController,
} from '../../components/index.js';
import { getLocale, t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { text } from '../../services/api.js';
import {
  copyWithFallback,
  defaultMsgMarkup,
  errorMessage,
  formatHistoryRef,
  formatHistoryTime,
  type HistoryEditorComponent,
  type HistoryEditorInput,
  type HistoryPanelInitContext,
  type HistoryPluginDeps,
  type HistoryReadResponse,
  normalizeHistoryEditorInput,
  readOnlySentence,
  resolveHistoryIcons,
} from './helpers.js';

export interface HistoryEditorInstance extends HistoryEditorComponent {
  readonly sessionId: string | null;
  refreshReadOnly(): void;
  refreshLocale(): void;
  getMessage(key: string): WebMessage | undefined;
  repaintMessage(key: string): void;
}

const SEARCH_HIT_CLASS = 'fh-search-hit';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'MARK']);

function clearMarks(container: HTMLElement): void {
  const marks = container.querySelectorAll(`mark.${SEARCH_HIT_CLASS}`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(container.ownerDocument.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

function collectHighlightRoots(container: HTMLElement): HTMLElement[] {
  const msgs = Array.from(container.querySelectorAll<HTMLElement>('[data-k]'));
  return msgs.length > 0 ? msgs : [container];
}

function highlightMatches(container: HTMLElement, query: string): HTMLElement[] {
  clearMarks(container);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const doc = container.ownerDocument;
  const textNodes: Text[] = [];
  for (const root of collectHighlightRoots(container)) {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    let node = walker.nextNode();
    while (node) {
      const parentTag = node.parentElement?.tagName;
      if ((!parentTag || !SKIP_TAGS.has(parentTag)) && node.nodeValue && node.nodeValue.toLowerCase().includes(needle)) {
        textNodes.push(node as Text);
      }
      node = walker.nextNode();
    }
  }
  const marks: HTMLElement[] = [];
  for (const textNode of textNodes) {
    const raw = textNode.nodeValue ?? '';
    const lower = raw.toLowerCase();
    let pos = 0;
    const frag = doc.createDocumentFragment();
    while (pos < raw.length) {
      const idx = lower.indexOf(needle, pos);
      if (idx < 0) {
        frag.appendChild(doc.createTextNode(raw.slice(pos)));
        break;
      }
      if (idx > pos) frag.appendChild(doc.createTextNode(raw.slice(pos, idx)));
      const mark = doc.createElement('mark');
      mark.className = SEARCH_HIT_CLASS;
      mark.textContent = raw.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      marks.push(mark);
      pos = idx + needle.length;
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  return marks;
}

function formatMatchCount(current: number, total: number, hasQuery: boolean): string {
  const zh = getLocale() === 'zh-CN';
  if (total === 0) {
    if (!hasQuery) return '';
    return zh ? '0/0 处' : '0 / 0';
  }
  return zh ? `第 ${current}/${total} 处` : `${current} / ${total}`;
}

class HistoryEditorPanel implements HistoryEditorInstance {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly findInput: HTMLInputElement;
  private readonly findCount: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly clearFindBtn: HTMLButtonElement;
  private readonly noteHost: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly roNotice: NoticeController;
  private readonly actionBar: ActionBarController;
  private readonly listeners = new DisposableStore();
  private noteNotice: NoticeController | null = null;
  private panelCtx: HistoryPanelInitContext | null = null;
  private currentInput: HistoryEditorInput | null = null;
  private session: HistoryPanelSession | null = null;
  private msgData: Record<string, WebMessage> = {};
  private msgEls: Record<string, Element> = {};
  private matches: HTMLElement[] = [];
  private matchIndex = -1;
  private seq = 0;
  private disposed = false;
  private copyFeedback: 'idle' | 'ok' | 'err' = 'idle';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: PluginContext,
    private readonly deps: HistoryPluginDeps,
    private readonly onDispose: (inst: HistoryEditorInstance) => void,
  ) {
    this.doc = deps.doc ?? document;
    this.element = this.doc.createElement('div');
    this.element.className = 'wb-history-editor';
    this.element.setAttribute('aria-label', tr('history.recordedAria'));

    const bannerHost = this.doc.createElement('div');
    bannerHost.className = 'wb-history-ro-bar';
    const actionsHost = this.doc.createElement('div');
    actionsHost.className = 'wb-history-ro-actions';
    const topBar = this.doc.createElement('div');
    topBar.className = 'wb-history-top';
    topBar.appendChild(bannerHost);
    topBar.appendChild(actionsHost);

    const findBar = this.doc.createElement('div');
    findBar.className = 'wb-history-find';
    this.findInput = this.doc.createElement('input');
    this.findInput.type = 'text';
    this.findInput.className = 'fh-input wb-history-find-input';
    this.findInput.placeholder = tr('common.search');
    this.findInput.setAttribute('aria-label', tr('common.search'));
    this.findCount = this.doc.createElement('span');
    this.findCount.className = 'wb-history-find-count';

    const icons = resolveHistoryIcons(deps);
    this.prevBtn = this.makeIconBtn('wb-history-find-prev', tr('common.prev'), icons.arrowUp, true);
    this.nextBtn = this.makeIconBtn('wb-history-find-next', tr('common.next'), icons.arrowDown, true);
    this.clearFindBtn = this.makeIconBtn('wb-history-find-clear', tr('common.clearSearch'), icons.cross, false);
    this.clearFindBtn.hidden = true;
    findBar.append(this.findInput, this.findCount, this.prevBtn, this.nextBtn, this.clearFindBtn);

    this.noteHost = this.doc.createElement('div');
    this.noteHost.className = 'wb-history-note';
    this.noteHost.hidden = true;
    this.logEl = this.doc.createElement('div');
    this.logEl.className = 'wb-history-log';
    this.element.append(topBar, findBar, this.noteHost, this.logEl);

    this.roNotice = createNotice(
      { tone: 'info', title: tr('history.readOnlyTag'), message: tr('history.roLibrary') },
      this.doc,
    );
    bannerHost.appendChild(this.roNotice.el);
    this.actionBar = createActionBar(
      { items: this.buildActions(), compact: true, ariaLabel: tr('history.readOnlyTag') },
      this.doc,
    );
    actionsHost.appendChild(this.actionBar.el);
    this.bindEvents();
  }

  get sessionId(): string | null {
    return this.currentInput?.id ?? null;
  }

  private makeIconBtn(cls: string, label: string, iconSvg: string, disabled: boolean): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = `fh-btn fh-btn--ghost fh-btn--icon ${cls}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.disabled = disabled;
    btn.innerHTML = iconSvg;
    return btn;
  }

  private topicExists(topicId: string): boolean {
    return Boolean(topicId) && this.ctx.topics.list().some((t) => t.id === topicId);
  }

  private bindEvents(): void {
    this.listeners.add(addDisposableListener(this.findInput, 'input', () => this.runFind(this.findInput.value)));
    this.listeners.add(
      addDisposableListener(this.findInput, 'keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (this.matches.length) this.focusMatch(e.shiftKey ? this.matchIndex - 1 : this.matchIndex + 1);
          else this.runFind(this.findInput.value);
        } else if (e.key === 'Escape' && this.findInput.value) {
          e.preventDefault();
          this.findInput.value = '';
          this.runFind('');
        }
      }),
    );
    this.listeners.add(addDisposableListener(this.prevBtn, 'click', () => this.focusMatch(this.matchIndex - 1)));
    this.listeners.add(addDisposableListener(this.nextBtn, 'click', () => this.focusMatch(this.matchIndex + 1)));
    this.listeners.add(
      addDisposableListener(this.clearFindBtn, 'click', () => {
        this.findInput.value = '';
        this.runFind('');
        this.findInput.focus();
      }),
    );
    this.listeners.add(
      addDisposableListener(this.element, 'keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          this.findInput.focus();
          this.findInput.select();
        }
      }),
    );
    this.listeners.add(addDisposableListener(this.logEl, 'click', (e) => this.handleLogClick(e)));
  }

  private handleLogClick(e: MouseEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const shot = target.closest('img.shot');
    if (shot) {
      this.deps.openShot?.(shot);
      return;
    }
    const go = target.closest('a[data-goto]');
    if (go) {
      e.preventDefault();
      const goId = go.getAttribute('data-goto');
      if (goId && this.topicExists(goId)) this.ctx.topics.open(goId);
      return;
    }
    const all = target.closest('[data-tl-all]');
    if (all) {
      this.deps.toggleAll?.(all.getAttribute('data-tl-all'));
      return;
    }
    const line = target.closest('.tl');
    if (line) this.deps.toggleLine?.(line);
  }

  private buildActions(): ActionItem[] {
    const ic = resolveHistoryIcons(this.deps);
    const items: ActionItem[] = [];
    if (this.session) {
      const ref = formatHistoryRef(this.session.title, this.session.id);
      const copyLabel =
        this.copyFeedback === 'ok'
          ? tr('common.copied')
          : this.copyFeedback === 'err'
            ? tr('common.copyFailed')
            : tr('topic.copyRef');
      items.push({
        id: 'copy-ref',
        icon: this.copyFeedback === 'ok' ? ic.check : this.copyFeedback === 'err' ? ic.cross : ic.copy,
        label: copyLabel,
        title: tr('topic.copyRefWith', { ref }),
        variant: 'secondary',
        onClick: () => this.copyReference(ref),
      });
      if (this.session.topic && this.topicExists(this.session.topic)) {
        const targetTopic = this.session.topic;
        items.push({
          id: 'open-topic',
          label: tr('history.openTopic'),
          variant: 'primary',
          onClick: () => this.ctx.topics.open(targetTopic),
        });
      }
    }
    items.push({
      id: 'back',
      icon: ic.chevronLeft,
      label: tr('common.back'),
      title: tr('history.closeTitle'),
      variant: 'secondary',
      onClick: () => {
        const closedId = this.currentInput?.id ?? '';
        this.panelCtx?.api.close();
        this.deps.onCloseEditor?.(closedId);
      },
    });
    return items;
  }

  private copyReference(ref: string): void {
    copyWithFallback(ref, this.deps, (ok) => {
      if (this.disposed) return;
      this.copyFeedback = ok ? 'ok' : 'err';
      this.actionBar.update(this.buildActions());
      if (this.copyTimer !== null) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copyTimer = null;
        if (this.disposed) return;
        this.copyFeedback = 'idle';
        this.actionBar.update(this.buildActions());
      }, 1500);
    });
  }

  private setNote(note: string | undefined): void {
    if (!note) {
      this.noteHost.hidden = true;
      this.noteNotice?.dispose();
      this.noteNotice = null;
      return;
    }
    this.noteHost.hidden = false;
    if (!this.noteNotice) {
      this.noteNotice = createNotice({ tone: 'warn', message: note }, this.doc);
      this.noteHost.replaceChildren(this.noteNotice.el);
    } else {
      this.noteNotice.update({ tone: 'warn', message: note });
    }
  }

  private focusMatch(index: number): void {
    for (const m of this.matches) m.classList.remove('is-current');
    if (this.matches.length === 0) {
      this.matchIndex = -1;
      this.findCount.textContent = formatMatchCount(0, 0, Boolean(this.findInput.value.trim()));
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      return;
    }
    this.matchIndex = ((index % this.matches.length) + this.matches.length) % this.matches.length;
    const target = this.matches[this.matchIndex];
    if (target) {
      target.classList.add('is-current');
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    }
    this.findCount.textContent = formatMatchCount(this.matchIndex + 1, this.matches.length, true);
    this.prevBtn.disabled = false;
    this.nextBtn.disabled = false;
  }

  private runFind(query: string): void {
    this.clearFindBtn.hidden = !query;
    this.matches = highlightMatches(this.logEl, query);
    this.focusMatch(0);
  }

  private paintRead(res: HistoryReadResponse, initialQuery?: string): void {
    const s = (res.session ?? {}) as HistoryPanelSession;
    const title = s.title || tr('history.untitled');
    this.session = s;
    this.panelCtx?.api.setTitle(title);

    const count = s.messages || 0;
    const meta = [
      s.agent || tr('history.noAgent'),
      s.platform || tr('history.unknown'),
      tr('history.lastActive', { when: formatHistoryTime(s.lastAt) }),
      tr(count === 1 ? 'sched.msgOne' : 'sched.msgMany', { count }),
    ];
    let h =
      `<div class="lib-head"><div class="hist-meta">${text(meta.join(' · '))}</div>` +
      `<div class="hist-meta hist-key">${text(s.key || '')}</div></div>`;
    const list = res.messages ?? [];
    const renderMsg = this.deps.msgMarkup ?? ((k: string, m: WebMessage) => defaultMsgMarkup(k, m));
    this.msgData = {};
    this.msgEls = {};
    for (const msg of list) {
      const key = `h:${msg.id}`;
      this.msgData[key] = msg;
      const out = renderMsg(key, msg, false);
      h += `<div class="${out.cls}" data-k="${text(key)}">${out.h}</div>`;
    }
    if (!list.length) h += `<div class="empty">${text(tr('history.noMessages'))}</div>`;
    this.logEl.innerHTML = h;
    this.deps.codeBlocks?.(this.logEl);
    for (const node of this.logEl.querySelectorAll('[data-k]')) {
      const k = node.getAttribute('data-k');
      if (k) this.msgEls[k] = node;
    }
    this.setNote(res.note);
    this.refreshReadOnly();

    const searchQ = (initialQuery ?? this.findInput.value).trim();
    if (searchQ) {
      this.findInput.value = searchQ;
      this.runFind(searchQ);
    } else {
      this.matches = [];
      this.matchIndex = -1;
      this.findCount.textContent = '';
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  private paintFailure(msg: string): void {
    this.session = null;
    this.logEl.innerHTML = `<div class="hist-note bad">${text(msg)}</div>`;
    this.roNotice.update({ tone: 'err', title: tr('history.readOnlyTag'), message: tr('history.roFailed') });
    this.actionBar.update(this.buildActions());
  }

  private loadSession(input: HistoryEditorInput): void {
    const mySeq = ++this.seq;
    this.currentInput = input;
    this.session = null;
    this.msgData = {};
    this.msgEls = {};
    this.matches = [];
    this.matchIndex = -1;
    this.deps.forgetOpenedPrefix?.('h:');
    this.setNote(undefined);
    if (input.title) this.panelCtx?.api.setTitle(input.title);
    this.roNotice.update({ tone: 'info', title: tr('history.readOnlyTag'), message: tr('history.roLibrary') });
    this.actionBar.update(this.buildActions());
    this.logEl.innerHTML = `<div class="empty">${text(tr('common.loading'))}</div>`;

    void this.ctx.api.get<HistoryReadResponse>(`/api/history/read?id=${encodeURIComponent(input.id)}`).then(
      (res) => {
        if (this.disposed || mySeq !== this.seq) return;
        if (!res || res.error) {
          this.paintFailure(res?.error || tr('history.readConvDefault'));
          return;
        }
        this.paintRead(res, input.query);
      },
      (err: unknown) => {
        if (this.disposed || mySeq !== this.seq) return;
        this.paintFailure(tr('history.readConvFailed', { err: errorMessage(err) }));
      },
    );
  }

  init(params: unknown, initCtx: HistoryPanelInitContext): void {
    this.panelCtx = initCtx;
    const parsed = normalizeHistoryEditorInput(params);
    if (parsed) this.loadSession(parsed);
    else this.paintFailure(tr('history.readConvDefault'));
  }

  update(params: unknown): void {
    const parsed = normalizeHistoryEditorInput(params);
    if (!parsed) return;
    if (this.currentInput && parsed.id === this.currentInput.id && this.session) {
      if (parsed.query !== undefined) {
        this.findInput.value = parsed.query;
        this.runFind(parsed.query);
      }
      return;
    }
    this.loadSession(parsed);
  }

  focus(): void {
    this.findInput.focus();
  }

  refreshReadOnly(): void {
    if (this.disposed) return;
    if (this.session) {
      const here = Boolean(this.session.topic) && this.topicExists(this.session.topic ?? '');
      this.roNotice.update({
        tone: 'info',
        title: tr('history.readOnlyTag'),
        message: readOnlySentence(this.session, here),
      });
    }
    this.actionBar.update(this.buildActions());
  }

  refreshLocale(): void {
    this.element.setAttribute('aria-label', tr('history.recordedAria'));
    this.findInput.placeholder = tr('common.search');
    this.findInput.setAttribute('aria-label', tr('common.search'));
    this.prevBtn.title = tr('common.prev');
    this.prevBtn.setAttribute('aria-label', tr('common.prev'));
    this.nextBtn.title = tr('common.next');
    this.nextBtn.setAttribute('aria-label', tr('common.next'));
    this.clearFindBtn.title = tr('common.clearSearch');
    this.clearFindBtn.setAttribute('aria-label', tr('common.clearSearch'));
    this.findCount.textContent = formatMatchCount(
      this.matchIndex >= 0 ? this.matchIndex + 1 : 0,
      this.matches.length,
      Boolean(this.findInput.value.trim()),
    );
    this.refreshReadOnly();
  }

  getMessage(key: string): WebMessage | undefined {
    return this.msgData[key];
  }

  repaintMessage(key: string): void {
    const msg = this.msgData[key];
    const el = this.msgEls[key];
    if (!msg || !el) return;
    const renderMsg = this.deps.msgMarkup ?? ((k: string, m: WebMessage) => defaultMsgMarkup(k, m));
    const out = renderMsg(key, msg, false);
    el.className = out.cls;
    el.innerHTML = out.h;
    this.deps.codeBlocks?.(el);
    if (this.findInput.value.trim()) {
      const prevIdx = Math.max(0, this.matchIndex);
      this.matches = highlightMatches(this.logEl, this.findInput.value);
      this.focusMatch(prevIdx);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.seq++;
    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
      this.copyTimer = null;
    }
    this.deps.forgetOpenedPrefix?.('h:');
    this.roNotice.dispose();
    this.noteNotice?.dispose();
    this.actionBar.dispose();
    this.listeners.dispose();
    this.element.remove();
    this.onDispose(this);
  }
}

export function createHistoryEditor(
  ctx: PluginContext,
  deps: HistoryPluginDeps,
  onDispose: (inst: HistoryEditorInstance) => void,
): HistoryEditorInstance {
  return new HistoryEditorPanel(ctx, deps, onDispose);
}
