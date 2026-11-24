import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { post as defaultPost, text } from '../../services/api.js';
import { renderSettingsScreen } from './render.js';
import type { SettingsFeature, SettingsFeatureDeps, SettingsWebMessage } from './types.js';

const DEFAULT_FADE_MS = 5000;
const DEFAULT_WAIT_MS = 15000;

interface PendingRequest {
  t: string;
  n: number;
}

interface SettingsState {
  msg: SettingsWebMessage | null;
  topic: string | null;
  closed: Record<string, 1>;
  note: string | null;
  level: '' | 'list' | 'values';
  fadeTimer: ReturnType<typeof setTimeout> | null;
  query: string;
  listFk: string | null;
  openAgentId: string | null;
  reqSeq: number;
  pending: PendingRequest[];
  closedUpTo: number;
  waitTimer: ReturnType<typeof setTimeout> | null;
}

function createInitialState(): SettingsState {
  return {
    msg: null,
    topic: null,
    closed: {},
    note: null,
    level: '',
    fadeTimer: null,
    query: '',
    listFk: null,
    openAgentId: null,
    reqSeq: 0,
    pending: [],
    closedUpTo: 0,
    waitTimer: null,
  };
}

function asElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') return null;
  return 'closest' in target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function asSelectElement(target: EventTarget | null): HTMLSelectElement | null {
  const el = asElement(target);
  if (!el || el.tagName !== 'SELECT') return null;
  return el as HTMLSelectElement;
}

function optimisticToggleControl(el: HTMLElement): void {
  if (el.getAttribute('role') === 'switch') {
    el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  }
  if (el.getAttribute('role') === 'radio') {
    const peers = el.parentNode ? el.parentNode.children : [];
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (peer) peer.setAttribute('aria-checked', peer === el ? 'true' : 'false');
    }
  }
}

interface ResolvedDeps extends SettingsFeatureDeps {
  readonly postFn: NonNullable<SettingsFeatureDeps['post']>;
  readonly doc: Document;
  readonly fadeMs: number;
  readonly waitMs: number;
}

function settingsKey(deps: ResolvedDeps, m: SettingsWebMessage): string {
  return String(m._g || m.g || deps.getEpoch()) + ':' + m.id;
}

function topicName(deps: ResolvedDeps, id: string | null): string {
  for (const item of deps.getTopics()) {
    if (item.id === id) return item.title || tr('common.untitled');
  }
  return tr('common.untitled');
}

function paintTopic(state: SettingsState, deps: ResolvedDeps): void {
  deps.settingsTopicEl.textContent = tr('settings.savedWhere');
  deps.settingsTopicEl.title = tr('settings.openedFrom', { title: topicName(deps, state.topic) });
}

function disarmWait(state: SettingsState): void {
  if (state.waitTimer !== null) {
    clearTimeout(state.waitTimer);
    state.waitTimer = null;
  }
}

function disarmFade(state: SettingsState): void {
  if (state.fadeTimer !== null) {
    clearTimeout(state.fadeTimer);
    state.fadeTimer = null;
  }
}

function say(deps: ResolvedDeps, message: string): void {
  deps.settingsBody.innerHTML = '<div class="set-loading">' + text(message) + '</div>';
}

function armWait(state: SettingsState, deps: ResolvedDeps): void {
  disarmWait(state);
  state.waitTimer = setTimeout(() => {
    state.waitTimer = null;
    if (deps.settingsPage.hidden || state.msg) return;
    say(deps, tr('settings.noAnswer'));
  }, deps.waitMs);
}

function forgetRequest(state: SettingsState, token: number): void {
  for (let i = 0; i < state.pending.length; i++) {
    if (state.pending[i]?.n !== token) continue;
    state.pending.splice(i, 1);
    return;
  }
}

function filterOptions(deps: ResolvedDeps): void {
  const field = deps.settingsBody.querySelector<HTMLInputElement>('.set-type');
  const q = field ? field.value.trim().toLowerCase() : '';
  const opts = deps.settingsBody.querySelectorAll<HTMLElement>('.set-list .set-opt');
  let shown = 0;
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i];
    if (!opt) continue;
    const hit = !q || (opt.getAttribute('data-q') || '').indexOf(q) >= 0;
    opt.hidden = !hit;
    if (hit) shown++;
  }
  const none = deps.settingsBody.querySelector<HTMLElement>('.set-nomatch');
  if (none) none.hidden = !(q && opts.length && !shown);
}

function renderScreen(state: SettingsState, deps: ResolvedDeps): void {
  if (!state.msg) return;
  const active = deps.doc.activeElement;
  let fk = active && deps.settingsBody.contains(active) ? active.getAttribute('data-fk') : null;
  const level = state.msg.settings ? state.msg.settings.level : '';
  const typed = deps.settingsBody.querySelector<HTMLInputElement>('.set-type');
  if (typed) state.query = typed.value;

  deps.settingsBody.innerHTML = renderSettingsScreen(state.msg, {
    topicTitle: topicName(deps, state.topic),
    errorNote: state.note,
    openAgentId: state.openAgentId,
    renderOrphans: () => deps.instructions.renderOrphans(),
    renderAgentInstructions: (row, index) => deps.instructions.renderAgent(row, index),
  });

  if (deps.instrOk && level === 'list') deps.instructions.ensure();
  if (level !== state.level) {
    const back = level === 'list' && state.level === 'values' ? state.listFk : null;
    deps.settingsBody.scrollTop = 0;
    fk = back;
    state.query = '';
  }
  state.level = level;

  const field = deps.settingsBody.querySelector<HTMLInputElement>('.set-type');
  if (field && state.query) {
    field.value = state.query;
    filterOptions(deps);
  }

  disarmFade(state);
  const notice = deps.settingsBody.querySelector<HTMLElement>('.set-notice.ok, .set-notice.info');
  if (notice) {
    state.fadeTimer = setTimeout(() => {
      notice.classList.add('faded');
    }, deps.fadeMs);
  }
  if (fk) {
    const to = deps.settingsBody.querySelector<HTMLElement>('[data-fk="' + fk + '"]');
    focusSafely(to);
  }
}

function takeScreen(state: SettingsState, deps: ResolvedDeps, m: SettingsWebMessage): void {
  m._g = m.g || deps.getEpoch();
  const key = settingsKey(deps, m);
  if (!deps.settingsPage.hidden && state.msg && state.msg.id === m.id) {
    state.msg = m;
    state.note = null;
    renderScreen(state, deps);
    return;
  }
  const wasHidden = deps.settingsPage.hidden;
  if (wasHidden && state.closed[key]) return;
  const currentTopic = deps.getTopic();
  if (!currentTopic) return;
  let token = 0;
  for (let i = 0; i < state.pending.length; i++) {
    const item = state.pending[i];
    if (!item || item.t !== currentTopic) continue;
    token = item.n;
    state.pending.splice(i, 1);
    break;
  }
  // Drop answers to Loading requests that were closed before the daemon replied.
  if (wasHidden && token && token <= state.closedUpTo) return;
  state.msg = m;
  state.note = null;
  state.level = '';
  state.topic = currentTopic;
  paintTopic(state, deps);
  renderScreen(state, deps);
  deps.settingsPage.hidden = false;
  deps.settingsBody.scrollTop = 0;
  disarmWait(state);
}

function openLoading(state: SettingsState, deps: ResolvedDeps): number {
  const currentTopic = deps.getTopic();
  if (!currentTopic) return 0;
  state.msg = null;
  state.topic = currentTopic;
  deps.settingsBody.innerHTML = '<div class="set-loading">' + text(tr('settings.loading')) + '</div>';
  paintTopic(state, deps);
  deps.settingsPage.hidden = false;
  deps.settingsBody.scrollTop = 0;
  const token = ++state.reqSeq;
  state.pending.push({ t: currentTopic, n: token });
  armWait(state, deps);
  return token;
}

function requestScreen(state: SettingsState, deps: ResolvedDeps): void {
  const token = openLoading(state, deps);
  const targetTopic = state.topic;
  if (!token || !targetTopic) return;
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  void deps.postFn('api/send', { topic: targetTopic, text: '/setting', nonce, quiet: true }, 2).then(
    (r) => r.ok,
    () => false,
  ).then((ok) => {
    if (ok) return;
    forgetRequest(state, token);
    if (!state.msg && !deps.settingsPage.hidden) say(deps, tr('settings.reachErr'));
  });
}

function closeScreen(state: SettingsState, deps: ResolvedDeps): void {
  if (deps.settingsPage.hidden) return;
  if (state.msg) state.closed[settingsKey(deps, state.msg)] = 1;
  if (state.reqSeq) state.closedUpTo = Math.max(state.closedUpTo, state.reqSeq);
  disarmWait(state);
  disarmFade(state);
  deps.settingsPage.hidden = true;
  state.msg = null;
  state.note = null;
  state.topic = null;
  state.listFk = null;
  state.openAgentId = null;
  deps.settingsBody.textContent = '';
}

function toggleAgent(state: SettingsState, deps: ResolvedDeps, top: Element): void {
  const card = top.closest('.ag-card');
  if (!card) return;
  const open = top.getAttribute('aria-expanded') !== 'true';
  const cards = deps.settingsBody.querySelectorAll('.ag-card');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c) continue;
    const on = open && c === card;
    const tEl = c.querySelector('.ag-top');
    const bEl = c.querySelector<HTMLElement>('.ag-body');
    c.classList.toggle('open', on);
    if (tEl) tEl.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (bEl) bEl.hidden = !on;
  }
  state.openAgentId = open ? card.getAttribute('data-ag') : null;
}

function postSetting(
  state: SettingsState,
  deps: ResolvedDeps,
  el: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  id: string | null,
  value?: string,
): void {
  if (!state.msg || !state.topic || !id) return;
  const msgId = state.msg.id;
  if (state.level === 'list') state.listFk = el.getAttribute('data-fk');
  optimisticToggleControl(el);
  el.disabled = true;
  el.classList.add('busy');
  const fail = (why: string): void => {
    if (!state.msg || state.msg.id !== msgId) return;
    state.note = why;
    renderScreen(state, deps);
  };
  const body: { topic: string; messageId: string; buttonId: string; value?: string } = {
    topic: state.topic,
    messageId: msgId,
    buttonId: id,
  };
  if (value) body.value = value;
  void deps.postFn('api/click', body, 2, deps.waitMs).then(
    (r) => {
      if (r.ok) return;
      fail(
        r.status === 409 || r.status === 404
          ? tr('settings.outOfDate')
          : tr('settings.httpErr', { status: r.status }),
      );
    },
    () => fail(tr('settings.reachChangeErr')),
  );
}

function useTyped(state: SettingsState, deps: ResolvedDeps): void {
  const field = deps.settingsBody.querySelector<HTMLInputElement>('.set-type');
  if (!field) return;
  const v = field.value.trim();
  if (!v) {
    field.focus();
    return;
  }
  postSetting(state, deps, field, field.getAttribute('data-btn'), v);
}

function handleBodyClick(state: SettingsState, deps: ResolvedDeps, e: Event): void {
  const target = asElement(e.target);
  if (!target || !state.msg || !state.topic) return;
  if (target.closest('.set-use')) {
    useTyped(state, deps);
    return;
  }
  const top = target.closest('.ag-top');
  if (top) {
    toggleAgent(state, deps, top);
    return;
  }
  let btn = target.closest<HTMLButtonElement>('button[data-btn]');
  if (!btn) {
    const row = target.closest('.set-item.sw');
    btn = row ? row.querySelector<HTMLButtonElement>('.set-switch') : null;
  }
  if (!btn || btn.disabled) return;
  postSetting(state, deps, btn, btn.getAttribute('data-btn'));
}

export function createSettingsFeature(rawDeps: SettingsFeatureDeps): SettingsFeature {
  const deps: ResolvedDeps = {
    ...rawDeps,
    postFn: rawDeps.post ?? defaultPost,
    doc: rawDeps.doc ?? document,
    fadeMs: rawDeps.fadeMs ?? DEFAULT_FADE_MS,
    waitMs: rawDeps.waitMs ?? DEFAULT_WAIT_MS,
  };
  const state = createInitialState();
  const disposables = new DisposableStore();

  const open = (): void => {
    deps.closeMenus();
    requestScreen(state, deps);
  };
  const close = (): void => closeScreen(state, deps);
  const take = (m: SettingsWebMessage): void => takeScreen(state, deps, m);
  const render = (): void => renderScreen(state, deps);
  const handleMessage = (m: SettingsWebMessage | null | undefined): boolean => {
    if (m && m.settings) {
      take(m);
      return true;
    }
    if (m && m.wasSettings) return true;
    if (m && state.msg && m.id === state.msg.id) close();
    return false;
  };
  const onLocaleChange = (): void => {
    if (deps.settingsPage.hidden) return;
    paintTopic(state, deps);
    requestScreen(state, deps);
  };

  disposables.add(addDisposableListener(deps.settingsOpenBtn, 'click', open));
  disposables.add(addDisposableListener(deps.settingsClose, 'click', close));
  disposables.add(
    addDisposableListener(deps.settingsPage, 'click', (e) => {
      if (e.target === deps.settingsPage) close();
    }),
  );
  disposables.add(addDisposableListener(deps.settingsBody, 'click', (e) => handleBodyClick(state, deps, e)));
  disposables.add(
    addDisposableListener(deps.settingsBody, 'input', (e) => {
      const target = asElement(e.target);
      if (target && target.classList.contains('set-type')) filterOptions(deps);
    }),
  );
  disposables.add(
    addDisposableListener(deps.settingsBody, 'keydown', (e) => {
      const target = asElement(e.target);
      if (e.key !== 'Enter' || !target || !target.classList.contains('set-type')) return;
      e.preventDefault();
      useTyped(state, deps);
    }),
  );
  disposables.add(
    addDisposableListener(deps.settingsBody, 'change', (e) => {
      const sel = asSelectElement(e.target);
      if (!sel || !sel.classList.contains('set-select')) return;
      postSetting(state, deps, sel, sel.value);
    }),
  );

  return {
    open,
    close,
    isOpen: () => !deps.settingsPage.hidden,
    take,
    handleMessage,
    render,
    getMessage: () => state.msg,
    getTopic: () => state.topic,
    onLocaleChange,
    dispose: () => {
      disarmWait(state);
      disarmFade(state);
      disposables.dispose();
    },
  };
}
