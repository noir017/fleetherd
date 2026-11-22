import type {
  HistoryPanelHit,
  HistoryPanelPage,
  HistoryPanelSession,
} from '../../../adapter.js';
import type { WebMessage } from '../../protocol.js';
import type { WebHistoryRead } from '../../room.js';
import { t } from '../i18n/index.js';

export interface HistoryPanelDeps {
  sidebar: HTMLElement;
  bar: HTMLElement;
  topicsFilterHost: HTMLElement;
  sbTabTopics: HTMLElement;
  sbTabHistory: HTMLElement;
  historyPane: HTMLElement;
  historyCountEl: HTMLElement;
  historyBody: HTMLElement;
  historyQ: HTMLInputElement;
  historyGo: HTMLButtonElement;
  historyErr: HTMLElement;
  historyListEl: HTMLElement;
  historyMore: HTMLButtonElement;
  chat: HTMLElement;
  log: HTMLElement;
  hints: HTMLElement;
  libLog: HTMLElement;
  libTitle: HTMLElement;
  libNote: HTMLElement;
  libWhy: HTMLElement;
  libTopicBtn: HTMLButtonElement;
  libCloseBtn: HTMLButtonElement;
  text: (s: unknown) => string;
  atBottom: () => boolean;
  firstVisible: () => Element | null;
  toBottom: () => void;
  getLogEl: (key: string) => Element | undefined;
  closeModelPop: () => void;
  paintFrames: () => void;
  paintTermHeightIfOpen: () => void;
  reportSeen: () => void;
  topicExists: (id: string) => boolean;
  switchTopic: (id: string) => void;
  narrow: () => boolean;
  setSidebar: (open: boolean) => void;
  msgMarkup: (key: string, msg: WebMessage, isHist: boolean) => { cls: string; h: string };
  codeBlocks: (root: Element) => void;
  forgetOpenedPrefix: (prefix: string) => void;
  openShot: (img: Element) => void;
  toggleAll: (key: string | null) => void;
  toggleLine: (line: Element) => void;
  icons: () => Record<string, string>;
  copyText: (s: string, done: (ok: boolean) => void) => void;
  onLibStateChange: () => void;
}

export interface HistoryPanel {
  setTab: (tab: 'topics' | 'history') => void;
  isOpen: () => boolean;
  close: () => void;
  currentRef: () => string | null;
  getMessage: (key: string) => WebMessage | undefined;
  repaintMessage: (key: string) => void;
  refreshReadOnly: () => void;
  repaint: () => void;
}

interface HistorySearchResponse {
  enabled?: boolean;
  hits?: HistoryPanelHit[];
  more?: boolean;
  error?: string;
}

type HistoryReadResponse = Partial<WebHistoryRead> & { error?: string };

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return t('common.networkError');
}

function histWhen(at: number): string {
  try {
    const d = new Date(at);
    const o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleString(undefined, o);
  } catch {
    return '';
  }
}

function historyRef(title: string | undefined, id: string | number): string {
  return (title || t('history.untitled')) + ' (#' + id + ')';
}

function histCopyBtn(title: string | undefined, id: string | number, deps: HistoryPanelDeps): string {
  const ref = historyRef(title, id);
  return (
    '<button type="button" class="btn-icon hist-copy" data-hist-copy="' +
    deps.text(id) +
    '" data-hist-title="' +
    deps.text(title || '') +
    '" title="' +
    deps.text(t('topic.copyRefWith', { ref })) +
    '" aria-label="' +
    deps.text(t('topic.copyRefBtn')) +
    '">' +
    (deps.icons().copy || '') +
    '</button>'
  );
}

function renderHistoryRow(s: HistoryPanelSession, activeId: string | null, deps: HistoryPanelDeps): string {
  const count = s.messages || 0;
  const meta = [
    s.agent || t('history.noAgent'),
    s.platform || t('history.unknown'),
    histWhen(s.lastAt),
    t(count === 1 ? 'sched.msgOne' : 'sched.msgMany', { count }),
  ];
  return (
    '<div class="hist-item' +
    (activeId !== null && String(s.id) === activeId ? ' on' : '') +
    '" data-hist="' +
    deps.text(s.id) +
    '" role="button" tabindex="0">' +
    '<div class="hist-top">' +
    '<div class="hist-title">' +
    deps.text(s.title || t('history.untitled')) +
    '</div>' +
    histCopyBtn(s.title, s.id, deps) +
    '</div>' +
    '<div class="hist-meta">' +
    deps.text(meta.join(' · ')) +
    '</div></div>'
  );
}

function renderHistoryHit(h: HistoryPanelHit, activeId: string | null, deps: HistoryPanelDeps): string {
  const meta = [h.agent || t('history.noAgent'), h.platform || t('history.unknown'), histWhen(h.at)];
  return (
    '<div class="hist-item' +
    (activeId !== null && String(h.session) === activeId ? ' on' : '') +
    '" data-hist="' +
    deps.text(h.session) +
    '" role="button" tabindex="0">' +
    '<div class="hist-top">' +
    '<div class="hist-title">' +
    deps.text(h.title || t('history.untitled')) +
    '</div>' +
    histCopyBtn(h.title, h.session, deps) +
    '</div>' +
    '<div class="hist-excerpt">' +
    deps.text(h.excerpt) +
    '</div>' +
    '<div class="hist-meta">' +
    deps.text(meta.join(' · ')) +
    '</div></div>'
  );
}

function readOnlySentence(s: HistoryPanelSession, here: boolean): string {
  if (here) return t('history.roHere');
  if (s.topic) return t('history.roCleared');
  return t('history.roOther', { platform: s.platform || t('history.anotherPlatform') });
}

interface HistoryState {
  sessions: HistoryPanelSession[];
  next: string | null;
  query: string;
  seq: number;
  tab: 'topics' | 'history';
  libId: string | null;
  libSession: HistoryPanelSession | null;
  libData: Record<string, WebMessage>;
  libEls: Record<string, Element>;
  libSeq: number;
  libSaved: { key: string; off: number } | null;
  copyTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>>;
}

function isLibOpen(deps: HistoryPanelDeps): boolean {
  return deps.chat.classList.contains('lib');
}

function logPlace(deps: HistoryPanelDeps): { key: string; off: number } | null {
  const el = deps.log.clientHeight && !deps.atBottom() ? deps.firstVisible() : null;
  const key = el?.getAttribute('data-k');
  return el && key
    ? { key, off: el.getBoundingClientRect().top - deps.log.getBoundingClientRect().top }
    : null;
}

function markLibRow(state: HistoryState, deps: HistoryPanelDeps): void {
  const rows = deps.historyListEl.querySelectorAll('[data-hist]');
  for (const row of rows) {
    row.classList.toggle('on', state.libId !== null && row.getAttribute('data-hist') === state.libId);
  }
}

function refreshReadOnly(state: HistoryState, deps: HistoryPanelDeps): void {
  const s = state.libSession;
  if (!s) return;
  const here = Boolean(s.topic) && deps.topicExists(s.topic ?? '');
  deps.libTopicBtn.hidden = !here;
  deps.libWhy.textContent = readOnlySentence(s, here);
}

function renderHistory(state: HistoryState, deps: HistoryPanelDeps): void {
  state.query = '';
  deps.historyErr.hidden = true;
  deps.historyErr.textContent = '';
  let h = '';
  if (!state.sessions.length) {
    h = '<div class="skills-empty">' + deps.text(t('history.empty')) + '</div>';
  }
  for (const s of state.sessions) h += renderHistoryRow(s, state.libId, deps);
  deps.historyListEl.innerHTML = h;
  const n = state.sessions.length;
  const countStr = n + (state.next ? '+' : '');
  deps.historyCountEl.textContent = n
    ? t(n === 1 && !state.next ? 'history.convOne' : 'history.convMany', { count: countStr })
    : '';
  deps.historyMore.hidden = !state.next;
  deps.historyMore.disabled = false;
}

function loadHistory(state: HistoryState, deps: HistoryPanelDeps, before?: string): void {
  const seq = ++state.seq;
  deps.historyMore.disabled = true;
  deps.historyErr.hidden = true;
  deps.historyErr.textContent = '';
  if (!before && (!state.sessions.length || state.query)) {
    deps.historyListEl.innerHTML = '<div class="skills-empty">' + deps.text(t('common.loading')) + '</div>';
    deps.historyCountEl.textContent = '';
  }
  fetch('api/history' + (before ? '?before=' + encodeURIComponent(before) : ''), { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json() as Promise<Partial<HistoryPanelPage> | null>;
    })
    .then((d) => {
      if (seq !== state.seq) return;
      const page = d || {};
      if (page.enabled === false) {
        deps.historyListEl.innerHTML = '<div class="skills-empty">' + deps.text(t('history.noLibrary')) + '</div>';
        deps.historyMore.hidden = true;
        return;
      }
      const rows = page.sessions || [];
      state.sessions = before ? state.sessions.concat(rows) : rows;
      state.next = page.next || null;
      renderHistory(state, deps);
    })
    .catch((e: unknown) => {
      if (seq !== state.seq) return;
      deps.historyErr.textContent = t('history.readLibraryFailed', { err: errorMessage(e) });
      deps.historyErr.hidden = false;
      if (!state.sessions.length || state.query) deps.historyListEl.innerHTML = '';
      deps.historyMore.hidden = !state.next;
      deps.historyMore.disabled = false;
      if (before) deps.historyBody.scrollTop = deps.historyBody.scrollHeight;
    });
}

function showHistoryList(state: HistoryState, deps: HistoryPanelDeps): void {
  state.seq++;
  if (state.sessions.length) renderHistory(state, deps);
  else loadHistory(state, deps);
}

function runHistorySearch(state: HistoryState, deps: HistoryPanelDeps): void {
  const q = deps.historyQ.value.trim();
  if (!q) {
    showHistoryList(state, deps);
    return;
  }
  const seq = ++state.seq;
  deps.historyMore.hidden = true;
  deps.historyErr.hidden = true;
  deps.historyErr.textContent = '';
  deps.historyCountEl.textContent = '';
  deps.historyListEl.innerHTML = '<div class="skills-empty">' + deps.text(t('common.searching')) + '</div>';
  fetch('api/history/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
    .then((r) => r.json().then((d: HistorySearchResponse) => ({ ok: r.ok, d })))
    .then((a) => {
      if (seq !== state.seq) return;
      if (!a.ok || !a.d || a.d.error) {
        deps.historyListEl.innerHTML =
          '<div class="skills-empty">' + deps.text((a.d && a.d.error) || t('history.searchFailedDefault')) + '</div>';
        return;
      }
      if (a.d.enabled === false) {
        deps.historyListEl.innerHTML = '<div class="skills-empty">' + deps.text(t('history.noLibrary')) + '</div>';
        return;
      }
      state.query = q;
      const hits = a.d.hits || [];
      if (!hits.length) {
        deps.historyListEl.innerHTML = '<div class="skills-empty">' + deps.text(t('history.noMatches', { query: q })) + '</div>';
        return;
      }
      let h = '';
      for (const hit of hits) h += renderHistoryHit(hit, state.libId, deps);
      deps.historyListEl.innerHTML = h;
      const countStr = hits.length + (a.d.more ? '+' : '');
      deps.historyCountEl.textContent =
        t(hits.length === 1 && !a.d.more ? 'history.matchOne' : 'history.matchMany', { count: countStr });
    })
    .catch((e: unknown) => {
      if (seq !== state.seq) return;
      deps.historyListEl.innerHTML =
        '<div class="skills-empty">' + deps.text(t('history.searchFailed', { err: errorMessage(e) })) + '</div>';
    });
}

function libFailed(deps: HistoryPanelDeps, msg: string): void {
  deps.libTitle.textContent = t('sidebar.history');
  deps.libLog.innerHTML = '<div class="hist-note bad">' + deps.text(msg) + '</div>';
  deps.libWhy.textContent = t('history.roFailed');
  deps.onLibStateChange();
}

function paintLibRead(state: HistoryState, deps: HistoryPanelDeps, d: HistoryReadResponse): void {
  const s = (d.session || {}) as HistoryPanelSession;
  const title = s.title || t('history.untitled');
  state.libSession = s;
  deps.libTitle.textContent = title;
  deps.libTitle.title = title;
  const count = s.messages || 0;
  const meta = [
    s.agent || t('history.noAgent'),
    s.platform || t('history.unknown'),
    t('history.lastActive', { when: histWhen(s.lastAt) }),
    t(count === 1 ? 'sched.msgOne' : 'sched.msgMany', { count }),
  ];
  let h =
    '<div class="lib-head"><div class="hist-meta">' +
    deps.text(meta.join(' · ')) +
    '</div><div class="hist-meta hist-key">' +
    deps.text(s.key || '') +
    '</div></div>';
  const list = d.messages || [];
  for (const msg of list) {
    const key = 'h:' + msg.id;
    state.libData[key] = msg;
    const out = deps.msgMarkup(key, msg, false);
    h += '<div class="' + out.cls + '" data-k="' + deps.text(key) + '">' + out.h + '</div>';
  }
  if (!list.length) h += '<div class="empty">' + deps.text(t('history.noMessages')) + '</div>';
  deps.libLog.innerHTML = h;
  deps.codeBlocks(deps.libLog);
  const nodes = deps.libLog.querySelectorAll('[data-k]');
  for (const node of nodes) {
    const k = node.getAttribute('data-k');
    if (k) state.libEls[k] = node;
  }
  deps.libNote.hidden = !d.note;
  deps.libNote.textContent = d.note || '';
  refreshReadOnly(state, deps);
  deps.onLibStateChange();
  deps.libLog.scrollTop = deps.libLog.scrollHeight;
}

function openLib(state: HistoryState, deps: HistoryPanelDeps, rawId: string): void {
  const id = String(rawId);
  const seq = ++state.libSeq;
  if (!isLibOpen(deps)) {
    state.libSaved = logPlace(deps);
    deps.closeModelPop();
    if (!deps.hints.hidden) {
      deps.hints.hidden = true;
      deps.hints.innerHTML = '';
    }
    deps.chat.classList.add('lib');
    deps.paintFrames();
  }
  state.libId = id;
  state.libSession = null;
  state.libData = {};
  state.libEls = {};
  deps.forgetOpenedPrefix('h:');
  deps.libTitle.textContent = t('common.loading');
  deps.libTitle.title = '';
  deps.libNote.hidden = true;
  deps.libNote.textContent = '';
  deps.libWhy.textContent = t('history.roLibrary');
  deps.libTopicBtn.hidden = true;
  deps.libLog.innerHTML = '<div class="empty">' + deps.text(t('common.loading')) + '</div>';
  markLibRow(state, deps);
  deps.onLibStateChange();
  fetch('api/history/read?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
    .then((r) => r.json().then((d: HistoryReadResponse) => ({ ok: r.ok, d })))
    .then((a) => {
      if (seq !== state.libSeq || !isLibOpen(deps)) return;
      if (!a.ok || !a.d || a.d.error) {
        libFailed(deps, (a.d && a.d.error) || t('history.readConvDefault'));
        return;
      }
      paintLibRead(state, deps, a.d);
    })
    .catch((e: unknown) => {
      if (seq !== state.libSeq || !isLibOpen(deps)) return;
      libFailed(deps, t('history.readConvFailed', { err: errorMessage(e) }));
    });
}

function closeLib(state: HistoryState, deps: HistoryPanelDeps): void {
  if (!isLibOpen(deps)) return;
  state.libSeq++;
  deps.chat.classList.remove('lib');
  deps.paintFrames();
  deps.paintTermHeightIfOpen();
  state.libId = null;
  state.libSession = null;
  deps.forgetOpenedPrefix('h:');
  state.libData = {};
  state.libEls = {};
  deps.libLog.innerHTML = '';
  deps.libTitle.textContent = '';
  markLibRow(state, deps);
  deps.onLibStateChange();
  const v = state.libSaved;
  const el = v ? deps.getLogEl(v.key) : undefined;
  state.libSaved = null;
  if (el && v) deps.log.scrollTop += el.getBoundingClientRect().top - deps.log.getBoundingClientRect().top - v.off;
  else deps.toBottom();
  deps.reportSeen();
}

function setHistoryTab(state: HistoryState, deps: HistoryPanelDeps, tab: 'topics' | 'history'): void {
  const hist = tab === 'history';
  const was = state.tab;
  state.tab = hist ? 'history' : 'topics';
  deps.sbTabTopics.classList.toggle('on', !hist);
  deps.sbTabHistory.classList.toggle('on', hist);
  deps.sbTabTopics.setAttribute('aria-selected', hist ? 'false' : 'true');
  deps.sbTabHistory.setAttribute('aria-selected', hist ? 'true' : 'false');
  deps.sidebar.classList.toggle('on-history', hist);
  deps.bar.hidden = hist;
  deps.topicsFilterHost.hidden = hist;
  deps.historyPane.hidden = !hist;
  if (!hist) {
    state.seq++;
    closeLib(state, deps);
    return;
  }
  if (was === 'history') return;
  if (deps.historyQ.value.trim()) runHistorySearch(state, deps);
  else loadHistory(state, deps);
}

function bindHistoryEvents(state: HistoryState, deps: HistoryPanelDeps): void {
  const pickLib = (row: Element): void => {
    const id = row.getAttribute('data-hist');
    if (id !== null) openLib(state, deps, id);
    if (deps.narrow()) deps.setSidebar(false);
  };
  const copyRow = (btn: HTMLElement): void => {
    const id = btn.getAttribute('data-hist-copy');
    if (!id) return;
    const ref = historyRef(btn.getAttribute('data-hist-title') || undefined, id);
    deps.copyText(ref, (ok) => {
      const ic = deps.icons();
      btn.innerHTML = ok ? ic.check || '' : ic.cross || '';
      btn.classList.toggle('copied', ok);
      const say = ok ? t('common.copied') : t('common.copyFailed');
      btn.title = say;
      btn.setAttribute('aria-label', say);
      const prev = state.copyTimers.get(btn);
      if (prev !== undefined) clearTimeout(prev);
      state.copyTimers.set(
        btn,
        setTimeout(() => {
          btn.innerHTML = ic.copy || '';
          btn.classList.remove('copied');
          btn.title = t('topic.copyRefWith', { ref });
          btn.setAttribute('aria-label', t('topic.copyRefBtn'));
        }, 1500)
      );
    });
  };

  deps.sbTabTopics.addEventListener('click', () => setHistoryTab(state, deps, 'topics'));
  deps.sbTabHistory.addEventListener('click', () => setHistoryTab(state, deps, 'history'));
  deps.historyGo.addEventListener('click', () => runHistorySearch(state, deps));
  deps.historyMore.addEventListener('click', () => {
    if (state.next) loadHistory(state, deps, state.next);
  });
  deps.historyQ.addEventListener('keydown', (e) => {
    // Mid-composition Enter commits an IME candidate, not a search.
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      runHistorySearch(state, deps);
    }
  });
  deps.historyQ.addEventListener('input', () => {
    if (deps.historyQ.value.trim()) return;
    if (state.tab === 'history') showHistoryList(state, deps);
  });
  deps.historyListEl.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const copyBtn = target?.closest<HTMLElement>('[data-hist-copy]');
    if (copyBtn) {
      e.stopPropagation();
      copyRow(copyBtn);
      return;
    }
    const row = target?.closest('[data-hist]');
    if (row) pickLib(row);
  });
  deps.historyListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[data-hist-copy]')) return;
    const row = target?.closest('[data-hist]');
    if (!row) return;
    e.preventDefault();
    pickLib(row);
  });
  deps.libTopicBtn.addEventListener('click', () => {
    const id = state.libSession?.topic;
    if (!id || !deps.topicExists(id)) {
      refreshReadOnly(state, deps);
      return;
    }
    setHistoryTab(state, deps, 'topics');
    deps.switchTopic(id);
  });
  deps.libCloseBtn.addEventListener('click', () => closeLib(state, deps));
  deps.libLog.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const shot = target.closest('img.shot');
    if (shot) {
      deps.openShot(shot);
      return;
    }
    const go = target.closest('a[data-goto]');
    if (go) {
      e.preventDefault();
      const goId = go.getAttribute('data-goto');
      if (goId && deps.topicExists(goId)) {
        deps.switchTopic(goId);
        if (deps.narrow()) deps.setSidebar(false);
      }
      return;
    }
    const all = target.closest('[data-tl-all]');
    if (all) {
      deps.toggleAll(all.getAttribute('data-tl-all'));
      return;
    }
    const line = target.closest('.tl');
    if (line) deps.toggleLine(line);
  });
}

export function createHistoryPanel(deps: HistoryPanelDeps): HistoryPanel {
  const state: HistoryState = {
    sessions: [],
    next: null,
    query: '',
    seq: 0,
    tab: 'topics',
    libId: null,
    libSession: null,
    libData: {},
    libEls: {},
    libSeq: 0,
    libSaved: null,
    copyTimers: new WeakMap(),
  };
  bindHistoryEvents(state, deps);

  return {
    setTab: (tab) => setHistoryTab(state, deps, tab),
    isOpen: () => isLibOpen(deps),
    close: () => closeLib(state, deps),
    currentRef: () => (state.libSession ? historyRef(state.libSession.title, state.libSession.id) : null),
    getMessage: (key) => state.libData[key],
    repaintMessage: (key) => {
      const m = state.libData[key];
      const el = state.libEls[key];
      if (!m || !el) return;
      const out = deps.msgMarkup(key, m, false);
      el.className = out.cls;
      el.innerHTML = out.h;
      deps.codeBlocks(el);
    },
    refreshReadOnly: () => refreshReadOnly(state, deps),
    repaint: () => {
      if (state.tab === 'history' && !state.query && state.sessions.length) renderHistory(state, deps);
      refreshReadOnly(state, deps);
    },
  };
}
