import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { createBannersController, type BannersController } from './banners.js';
import { btwAsked, createBtwController, type BtwController } from './btw.js';
import { createCodeBlocksController, type CodeBlocksController } from './code-blocks.js';
import { attachLogEvents, postButton } from './events.js';
import { clock, failedActions, renderMsgMarkup, stuck } from './markup.js';
import { extractMessageMarkdown, formatQuoteReply, polishLabel } from './message-actions.js';
import { createScrollManager, type ScrollManager } from './scroll.js';
import type {
  CodeViewModule,
  LaunchChoice,
  MsgMarkupResult,
  OfflineMachine,
  ToolOpenState,
  TranscriptIcons,
  TranscriptMessage,
  TranscriptTopicLike,
} from './types.js';

export * from './types.js';
export * from './scroll.js';
export * from './code-blocks.js';
export * from './btw.js';
export * from './markup.js';
export * from './banners.js';
export * from './events.js';
export * from './message-actions.js';
export * from './turn-diff.js';

export interface TranscriptDeps {
  readonly log: HTMLElement;
  readonly btwBox: HTMLElement;
  readonly btwQ: HTMLElement;
  readonly btwBody: HTMLElement;
  readonly btwClose: HTMLElement | null;
  readonly machineNoteEl: HTMLElement;
  readonly forkNote: HTMLElement;
  readonly getExtraCodeRoots: () => readonly (HTMLElement | null | undefined)[];
  readonly getData: () => Record<string, TranscriptMessage | undefined>;
  readonly getEls: () => Record<string, HTMLElement | undefined>;
  readonly getTopic: () => string;
  readonly getTopics: () => readonly TranscriptTopicLike[];
  readonly topicById: (id: string) => TranscriptTopicLike | null | undefined;
  readonly getEpoch: () => number;
  readonly isSynced: () => boolean;
  readonly isStale: () => boolean;
  readonly isEntering: () => boolean;
  readonly getLaunch: () => LaunchChoice | null;
  readonly keyOf: (m: TranscriptMessage) => string;
  readonly isHistory: (m: TranscriptMessage | undefined) => boolean;
  readonly getIcons: () => TranscriptIcons;
  readonly formatStatusClock: (ms: number) => string;
  readonly codeView: () => Promise<CodeViewModule | null | undefined>;
  readonly copyText: (s: string, cb: (ok: boolean) => void) => void;
  readonly hasOutbox: (nonce: string) => boolean;
  readonly claim: (m: TranscriptMessage) => void;
  readonly adoptLegacy: (m: TranscriptMessage) => boolean;
  readonly showUnsent: (topicId: string) => void;
  readonly cacheSave: () => void;
  readonly getHistoryMessage: (key: string) => TranscriptMessage | undefined;
  readonly repaintHistoryMessage: (key: string) => void;
  readonly paintTopics: () => void;
  readonly paintStatus: () => void;
  readonly switchTopic: (id: string) => void;
  readonly isNarrow: () => boolean;
  readonly setSidebar: (open: boolean) => void;
  readonly openShot: (img: HTMLImageElement) => void;
  readonly sendCommand: (cmd: string) => void;
  readonly openReader: (link: HTMLAnchorElement) => void;
  readonly deliverLocal: (nonce: string) => void;
  readonly copyLocal: (nonce: string, btn: HTMLElement) => void;
  readonly discardLocal: (nonce: string) => void;
  readonly quoteToComposer?: (text: string) => void;
  readonly openMessageMenu?: (key: string, anchor: HTMLElement) => void;
  readonly openTurnDiffSideBySide?: (turn: number) => Promise<void> | void;
  readonly canOpenSideDiff?: () => boolean;
}

export interface TranscriptController extends Disposable {
  readonly scroll: ScrollManager;
  readonly codeBlocks: CodeBlocksController;
  readonly btw: BtwController;
  readonly banners: BannersController;
  getMessage(key: string): TranscriptMessage | undefined;
  paint(key: string, before?: Node | null): void;
  msgMarkup(key: string, m: TranscriptMessage, hist: boolean): MsgMarkupResult;
  toggleAll(key: string): void;
  toggleLine(line: HTMLElement): void;
  repaintKey(key: string): void;
  forgetOpenedPrefix(prefix: string): void;
  upsert(m: TranscriptMessage): void;
  drop(key: string): void;
  reconcile(list: readonly TranscriptMessage[]): void;
  sinkLocals(): void;
  repaintHistory(): void;
  adopt(list: readonly TranscriptMessage[], current?: boolean): void;
  openTurnChanges(turn: number): void;
  openTurnDiffSideBySide(turn: number, btn?: HTMLButtonElement): Promise<void>;
  postButton(btn: HTMLButtonElement, topicId: string): void;
  resetForTopicSwitch(nextTopicId: string): void;
  transferLocalKey(pk: string, key: string): void;
  retireLocalKey(pk: string): void;
  attachEvents(doc?: Document): Disposable;
  refreshI18n(): void;
  setMachines(list: readonly OfflineMachine[] | null | undefined): void;
  takeMachines(list: readonly OfflineMachine[] | null | undefined): boolean;
  btwAsked(key: string, m: TranscriptMessage | null | undefined): string | null;
}

function getOpenGitWindow(): Window['openGitWindow'] {
  if (typeof window === 'undefined') return undefined;
  return typeof window.openGitWindow === 'function' ? window.openGitWindow : undefined;
}

function areNodesContiguousInParent(parent: Node, nodes: readonly HTMLElement[]): boolean {
  if (nodes.length === 0) return true;
  const first = nodes[0];
  if (!first || first.parentNode !== parent) return false;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i - 1]?.nextSibling !== nodes[i]) return false;
  }
  return true;
}

class TranscriptControllerImpl implements TranscriptController {
  private readonly _deps: TranscriptDeps;
  private _sig: Record<string, string> = {};
  private readonly _opened: Record<string, ToolOpenState> = {};
  private readonly _disposables = new DisposableStore();
  readonly scroll: ScrollManager;
  readonly codeBlocks: CodeBlocksController;
  readonly btw: BtwController;
  readonly banners: BannersController;

  constructor(deps: TranscriptDeps) {
    this._deps = deps;
    this.scroll = createScrollManager(deps.log);
    this.codeBlocks = createCodeBlocksController({
      log: deps.log,
      getExtraRoots: () => [deps.btwBody, ...deps.getExtraCodeRoots()],
      getTopic: deps.getTopic,
      getTopics: deps.getTopics,
      codeView: deps.codeView,
      getIcons: deps.getIcons,
      copyText: deps.copyText,
    });
    this.banners = createBannersController({
      log: deps.log,
      machineNoteEl: deps.machineNoteEl,
      forkNote: deps.forkNote,
      getTopic: deps.getTopic,
      getTopics: deps.getTopics,
      topicById: deps.topicById,
      getData: deps.getData,
      getEls: deps.getEls,
      isSynced: deps.isSynced,
      isStale: deps.isStale,
      getLaunch: deps.getLaunch,
      isHistory: deps.isHistory,
      getIcons: deps.getIcons,
      formatStatusClock: deps.formatStatusClock,
      paintTopics: deps.paintTopics,
      paintStatus: deps.paintStatus,
      switchTopic: deps.switchTopic,
      isNarrow: deps.isNarrow,
      setSidebar: deps.setSidebar,
    });
    this.btw = createBtwController({
      btwBox: deps.btwBox,
      btwQ: deps.btwQ,
      btwBody: deps.btwBody,
      getData: deps.getData,
      getEls: deps.getEls,
      getEpoch: deps.getEpoch,
      isHistory: deps.isHistory,
      isStuck: stuck,
      renderFailedActions: (m) => failedActions(m, Boolean(m._nonce && deps.hasOutbox(m._nonce))),
      formatClock: clock,
      getIcons: deps.getIcons,
      paint: (k) => this.paint(k),
      enhanceCodeBlocks: (root) => this.codeBlocks.enhance(root),
    });
  }

  msgMarkup(key: string, m: TranscriptMessage, hist: boolean): MsgMarkupResult {
    const canOpenSideDiff = this._deps.canOpenSideDiff
      ? this._deps.canOpenSideDiff()
      : Boolean(this._deps.openTurnDiffSideBySide);
    return renderMsgMarkup(key, m, hist, {
      icons: this._deps.getIcons(),
      opened: this._opened,
      canOpenGit: Boolean(getOpenGitWindow()),
      canOpenSideDiff,
      hasOutbox: this._deps.hasOutbox,
      isBtwHeld: (k, msg) => this.btw.isHeld(k, msg),
      btwLineMarkup: (k, msg, asked, h) => this.btw.lineMarkup(k, msg, asked, h),
    });
  }

  getMessage(key: string): TranscriptMessage | undefined {
    return this._msgAt(key);
  }

  paint(key: string, before?: Node | null): void {
    const data = this._deps.getData();
    const els = this._deps.getEls();
    const m = data[key];
    if (!m || m.settings || m.wasSettings) return;
    let el = els[key];
    if (!el) {
      this.banners.clearSkeleton();
      el = this._deps.log.ownerDocument.createElement('div');
      el.setAttribute('data-k', key);
      const syncingEl = this.banners.getSyncingEl();
      const at = before && before.parentNode === this._deps.log ? before : syncingEl;
      if (at) this._deps.log.insertBefore(el, at);
      else this._deps.log.appendChild(el);
      els[key] = el;
    }
    const out = this.msgMarkup(key, m, this._deps.isHistory(m));
    if (!this.btw.isNesting()) this.btw.link(key, m);
    if (this._sig[key] === out.h && el.className === out.cls) return;
    el.className = out.cls;
    el.innerHTML = out.h;
    this._sig[key] = out.h;
    this.codeBlocks.enhance(el);
  }

  private _msgAt(key: string): TranscriptMessage | undefined {
    return this._deps.getData()[key] || this._deps.getHistoryMessage(key);
  }

  repaintKey(key: string): void {
    if (this._deps.getHistoryMessage(key)) this._deps.repaintHistoryMessage(key);
    else this.paint(key);
  }

  toggleAll(key: string): void {
    if (!this._msgAt(key)) return;
    const st = this._opened[key];
    this._opened[key] = { all: !(st && st.all), lines: {} };
    this.repaintKey(key);
  }

  toggleLine(line: HTMLElement): void {
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (sel && String(sel)) return;
    const host = line.closest('[data-k]');
    const key = host ? host.getAttribute('data-k') : null;
    if (!key || !this._msgAt(key)) return;
    const i = line.getAttribute('data-i');
    if (i === null) return;
    const st = this._opened[key] || (this._opened[key] = { all: false, lines: {} });
    const prev = st.lines[i] !== undefined ? st.lines[i] : st.all;
    st.lines[i] = !prev;
    this.repaintKey(key);
  }

  forgetOpenedPrefix(prefix: string): void {
    for (const k of Object.keys(this._opened)) {
      if (k.startsWith(prefix)) delete this._opened[k];
    }
  }

  upsert(m: TranscriptMessage): void {
    m._g = m.g || this._deps.getEpoch();
    if (m.settings || m.wasSettings) return;
    const stick = this.scroll.atBottom();
    const key = this._deps.keyOf(m);
    this._deps.getData()[key] = m;
    this.paint(key);
    this.banners.syncEmptyNote();
    if (stick) this.scroll.toBottom();
  }

  drop(key: string): void {
    const data = this._deps.getData();
    const els = this._deps.getEls();
    const m = data[key];
    if (els[key]) {
      els[key].remove();
      delete els[key];
    }
    delete data[key];
    delete this._sig[key];
    delete this._opened[key];
    this.btw.onMessageDropped(key, m);
    this.banners.syncEmptyNote();
  }

  sinkLocals(): void {
    const data = this._deps.getData();
    const syncingEl = this.banners.getSyncingEl();
    const mine: ChildNode[] = [];
    let tail = 0;
    let other = false;
    for (let n: ChildNode | null = this._deps.log.lastChild; n; n = n.previousSibling) {
      if (n === syncingEl) continue;
      const k = n instanceof Element ? n.getAttribute('data-k') : null;
      if (k && data[k] && data[k]._local) {
        mine.unshift(n);
        if (!other) tail++;
      } else {
        other = true;
      }
    }
    if (tail === mine.length) return;
    const at = syncingEl && syncingEl.parentNode === this._deps.log ? syncingEl : null;
    for (let i = 0; i < mine.length; i++) {
      const node = mine[i];
      if (node) this._deps.log.insertBefore(node, at);
    }
  }

  reconcile(list: readonly TranscriptMessage[]): void {
    this.banners.clearSkeleton();
    this.banners.clearSyncing();
    const data = this._deps.getData();
    const els = this._deps.getEls();
    const epoch = this._deps.getEpoch();
    const keep: Record<string, 1> = {};
    const orderedEls: HTMLElement[] = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m) continue;
      m._g = m.g || epoch;
      if (m.settings || m.wasSettings) continue;
      this._deps.claim(m);
      const key = this._deps.keyOf(m);
      keep[key] = 1;
      data[key] = m;
      this.paint(key);
      const el = els[key];
      if (el) orderedEls.push(el);
    }
    const gone: string[] = [];
    for (const k of Object.keys(els)) {
      if (keep[k]) continue;
      const held = data[k];
      if (!held || held._local || held._g !== epoch) continue;
      gone.push(k);
    }
    for (let j = 0; j < gone.length; j++) {
      const k = gone[j];
      if (k) this.drop(k);
    }
    if (!areNodesContiguousInParent(this._deps.log, orderedEls)) {
      for (let i = 0; i < orderedEls.length; i++) {
        const el = orderedEls[i];
        if (el) this._deps.log.appendChild(el);
      }
    }
    this.sinkLocals();
  }

  repaintHistory(): void {
    const data = this._deps.getData();
    const els = this._deps.getEls();
    for (const k of Object.keys(els)) {
      if (this._deps.isHistory(data[k])) this.paint(k);
    }
    this.banners.placeDivider();
  }

  private _adoptOne(
    m: TranscriptMessage,
    synced: boolean,
    anchor: ChildNode | null,
  ): boolean {
    if (m._local) return this._deps.adoptLegacy(m);
    if (m.settings || m.wasSettings) return false;
    const data = this._deps.getData();
    const els = this._deps.getEls();
    const key = this._deps.keyOf(m);
    if (data[key] || els[key]) return false;
    if (synced && !this._deps.isHistory(m)) return false;
    data[key] = m;
    this.paint(key, synced ? anchor : null);
    return false;
  }

  adopt(list: readonly TranscriptMessage[], current?: boolean): void {
    this.banners.clearSkeleton();
    const entering = this._deps.isEntering();
    const synced = this._deps.isSynced();
    const stick = !entering && this.scroll.atBottom();
    const anchor = synced ? this._deps.log.firstChild : null;
    const els = this._deps.getEls();
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || !m.id) continue;
      moved = this._adoptOne(m, synced, anchor) || moved;
    }
    if (moved) {
      this._deps.showUnsent(this._deps.getTopic());
      this._deps.cacheSave();
    }
    this.sinkLocals();
    this.banners.placeDivider();
    this.banners.syncEmptyNote();
    if (!current) this.banners.showSyncing();
    if (entering) this.scroll.land(els);
    else if (stick) this.scroll.toBottom();
  }

  openTurnChanges(turn: number): void {
    const openGitWindow = getOpenGitWindow();
    if (!openGitWindow || !turn) return;
    const q = `?t=${encodeURIComponent(this._deps.getTopic())}&turn=${encodeURIComponent(String(turn))}`;
    openGitWindow({
      title: tr('msg.turnChangesTitle', { turn }),
      statusUrl: `api/turn-changes/status${q}`,
      fileUrl: `api/turn-changes/file${q}`,
    });
  }

  async openTurnDiffSideBySide(turn: number, btn?: HTMLButtonElement): Promise<void> {
    const openSideDiff = this._deps.openTurnDiffSideBySide;
    if (!openSideDiff || !Number.isFinite(turn) || turn <= 0) return;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('busy');
    }
    try {
      await openSideDiff(turn);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    }
  }

  private _handleMessageAction(action: string, key: string, btn: HTMLButtonElement): void {
    const m = this._msgAt(key);
    const el = this._deps.getEls()[key] ?? btn.closest<HTMLElement>('[data-k]');
    if (action === 'copy') {
      const md = extractMessageMarkdown(m, el);
      if (!md) return;
      const icons = this._deps.getIcons().icon;
      this._deps.copyText(md, (ok) => {
        if (!ok) return;
        const doneLabel = tr('common.copied');
        btn.classList.add('is-done');
        btn.setAttribute('aria-label', doneLabel);
        btn.title = doneLabel;
        if (icons.check) btn.innerHTML = icons.check;
        setTimeout(() => {
          if (!btn.isConnected) return;
          const origLabel = polishLabel('msg.copyMarkdown');
          btn.classList.remove('is-done');
          btn.setAttribute('aria-label', origLabel);
          btn.title = origLabel;
          if (icons.copy) btn.innerHTML = icons.copy;
        }, 1500);
      });
      return;
    }
    if (action === 'quote') {
      const md = extractMessageMarkdown(m, el);
      const quoted = formatQuoteReply(md);
      if (quoted) this._deps.quoteToComposer?.(quoted);
      return;
    }
    if (action === 'btw') {
      this._deps.quoteToComposer?.('/btw ');
      return;
    }
    if (action === 'more') {
      this._deps.openMessageMenu?.(key, btn);
    }
  }

  postButton(btn: HTMLButtonElement, topicId: string): void {
    postButton(btn, topicId);
  }

  resetForTopicSwitch(nextTopicId: string): void {
    this._deps.log.innerHTML = '';
    this._sig = {};
    this.banners.resetForTopicSwitch();
    this.btw.close(false);
    this.scroll.prepareEnter(nextTopicId);
  }

  transferLocalKey(pk: string, key: string): void {
    const data = this._deps.getData();
    const els = this._deps.getEls();
    const localEl = els[pk];
    if (!localEl) return;
    if (els[key]) {
      localEl.remove();
    } else {
      els[key] = localEl;
      if (this._sig[pk] !== undefined) this._sig[key] = this._sig[pk];
      localEl.setAttribute('data-k', key);
    }
    delete els[pk];
    delete this._sig[pk];
    delete data[pk];
    this.btw.transferKey(pk, key);
  }

  retireLocalKey(pk: string): void {
    const data = this._deps.getData();
    const els = this._deps.getEls();
    if (els[pk]) {
      els[pk].remove();
      delete els[pk];
    }
    delete this._sig[pk];
    delete data[pk];
  }

  attachEvents(doc: Document = document): Disposable {
    const store = new DisposableStore();
    store.add(this.codeBlocks.attachDocumentEvents(doc));
    store.add(this.btw.attachCloseButton(this._deps.btwClose));
    store.add(this.banners.attachForkNoteClick());
    store.add(
      attachLogEvents(this._deps.log, {
        getTopic: this._deps.getTopic,
        getTopics: this._deps.getTopics,
        isNarrow: this._deps.isNarrow,
        setSidebar: this._deps.setSidebar,
        switchTopic: this._deps.switchTopic,
        openShot: this._deps.openShot,
        sendCommand: this._deps.sendCommand,
        toggleBtw: (qk) => {
          if (this.btw.isOpen() && this.btw.getKey() === qk) this.btw.close(true);
          else this.btw.open(qk);
        },
        openReader: this._deps.openReader,
        deliverLocal: this._deps.deliverLocal,
        copyLocal: this._deps.copyLocal,
        discardLocal: this._deps.discardLocal,
        toggleAll: (key) => this.toggleAll(key),
        toggleLine: (line) => this.toggleLine(line),
        openTurnChanges: (turn) => this.openTurnChanges(turn),
        openTurnDiffSideBySide: (turn, btn) => {
          void this.openTurnDiffSideBySide(turn, btn);
        },
        onMessageAction: (action, key, btn) => this._handleMessageAction(action, key, btn),
      }),
    );
    this._disposables.add(store);
    return store;
  }

  refreshI18n(): void {
    this.banners.refreshI18n();
  }

  setMachines(list: readonly OfflineMachine[] | null | undefined): void {
    this.banners.setMachines(list);
  }

  takeMachines(list: readonly OfflineMachine[] | null | undefined): boolean {
    return this.banners.takeMachines(list);
  }

  btwAsked(key: string, m: TranscriptMessage | null | undefined): string | null {
    return btwAsked(key, m);
  }

  dispose(): void {
    this.codeBlocks.dispose();
    this.btw.dispose();
    this.banners.dispose();
    this._disposables.dispose();
  }
}

export function createTranscriptController(deps: TranscriptDeps): TranscriptController {
  return new TranscriptControllerImpl(deps);
}
