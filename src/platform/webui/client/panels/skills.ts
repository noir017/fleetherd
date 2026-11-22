import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelHistoryEntry,
  SkillPanelOp,
  SkillPanelSearch,
  SkillPanelSearches,
} from '../../../adapter.js';
import { t as tr, type MessageKey } from '../i18n/index.js';

export interface SkillsPanelDeps {
  app: HTMLElement;
  skillsWin: HTMLElement;
  skillsToggle: HTMLElement;
  skillsBack: HTMLElement;
  skillsTitle: HTMLElement;
  skillsCount: HTMLElement;
  skillsNewBtn: HTMLElement;
  skillsRefreshBtn: HTMLButtonElement;
  skillsClose: HTMLElement;
  skillsBody: HTMLElement;
  skillsNote: HTMLElement;
  skillsListEl: HTMLElement;
  skillsDetailEl: HTMLElement;
  icons: () => Record<string, string>;
  text: (s: unknown) => string;
  schedAgo: (at: number) => string;
  byteSize: (n: number) => string;
  copyText: (s: string, done: (ok: boolean) => void) => void;
  post: (path: string, body: unknown, tries: number) => Promise<Response>;
  closeMenus: () => void;
}

export interface SkillsPanel {
  open: () => void;
  close: () => void;
  beforeExternalWrite: () => void;
  afterExternalWrite: (refreshPending: boolean) => void;
  repaint: () => void;
}

interface SkillQueueEntry {
  chain: Promise<void>;
  pending: number;
  gen: number;
}

interface SkillListResponse {
  enabled?: boolean;
  skills?: SkillPanelEntry[];
  searches?: SkillPanelSearches | null;
}

interface SkillOpResponse {
  ok?: boolean;
  error?: string;
  skills?: SkillPanelEntry[];
  detail?: SkillPanelDetail;
}

interface SkillsState {
  enabled: boolean;
  list: SkillPanelEntry[];
  sel: SkillPanelDetail | null;
  busy: boolean;
  newMode: boolean;
  searches: SkillPanelSearches | null;
  cacheRead: boolean;
  fetchedAt: number;
  sig: string;
  // Bumped on every outgoing write; reads started before it are dropped and retried once writes settle.
  epoch: number;
  showSeq: number;
  refreshPending: boolean;
  refreshPendingManual: boolean;
  redrawPending: boolean;
  showPending: { name: string; file?: string } | null;
  fetching: boolean;
  fetchManual: boolean;
  tab: 'library' | 'resident';
  queue: Record<string, SkillQueueEntry>;
  copyTimers: WeakMap<Element, ReturnType<typeof setTimeout>>;
}

const SKILLS_CACHE = 'aa_skills';
const SKILLS_CACHE_V = 1;
const SKILL_TABS: ReadonlyArray<{ key: 'library' | 'resident'; titleKey: MessageKey; hintKey: MessageKey }> = [
  { key: 'library', titleKey: 'skills.tabLibrary', hintKey: 'skills.tabLibraryHint' },
  { key: 'resident', titleKey: 'skills.tabResident', hintKey: 'skills.tabResidentHint' },
];

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return tr('common.networkError');
}

function getEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function skillAgo(iso: string | undefined, schedAgo: (at: number) => string): string {
  const at = iso ? Date.parse(iso) : 0;
  return at ? schedAgo(at) : '';
}

function skillOn(s: SkillPanelEntry): boolean {
  return s.status !== 'archived';
}

function skillTabOf(s: SkillPanelEntry): 'library' | 'resident' {
  return s.resident ? 'resident' : 'library';
}

function skillPlace(s: SkillPanelEntry): string {
  return !skillOn(s) ? tr('common.offCap') : s.resident ? tr('skills.tabResident') : tr('skills.tabLibrary');
}

function skillSigOf(state: SkillsState): string {
  return JSON.stringify([state.enabled, state.list, state.searches]);
}

function skillEntryOk(e: unknown): e is SkillPanelEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
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

function skillCacheLoad(state: SkillsState): void {
  let d: unknown = null;
  try {
    d = JSON.parse(localStorage.getItem(SKILLS_CACHE) || 'null');
  } catch {
    return;
  }
  if (!d || typeof d !== 'object') return;
  const rec = d as { v?: unknown; enabled?: unknown; skills?: unknown; at?: unknown };
  if (rec.v !== SKILLS_CACHE_V || rec.enabled === false || !Array.isArray(rec.skills)) return;
  const entries: SkillPanelEntry[] = [];
  for (const item of rec.skills) {
    if (!skillEntryOk(item)) return;
    entries.push(item);
  }
  state.enabled = true;
  state.list = entries;
  state.searches = null;
  state.fetchedAt = Number(rec.at) || 0;
  state.sig = skillSigOf(state);
}

function skillCacheSave(state: SkillsState): void {
  try {
    localStorage.setItem(
      SKILLS_CACHE,
      JSON.stringify({ v: SKILLS_CACHE_V, at: state.fetchedAt, enabled: true, skills: state.list })
    );
  } catch {
    // Ignore storage quota/access errors.
  }
}

function skillRemember(state: SkillsState): void {
  state.sig = skillSigOf(state);
  if (!state.enabled) {
    try {
      localStorage.removeItem(SKILLS_CACHE);
    } catch {
      // Ignore storage access errors.
    }
    return;
  }
  skillCacheSave(state);
}

function skillNote(deps: SkillsPanelDeps, msg: string): void {
  deps.skillsNote.hidden = false;
  deps.skillsNote.textContent = msg;
}

function skillClearNote(deps: SkillsPanelDeps): void {
  deps.skillsNote.hidden = true;
}

function skillCopyName(state: SkillsState, deps: SkillsPanelDeps, name: string, btn: HTMLElement): void {
  if (!name) return;
  deps.copyText(name, (ok) => {
    if (!ok) {
      skillNote(deps, tr('skills.copyFailed'));
      return;
    }
    const ic = deps.icons();
    btn.innerHTML = ic.check || '';
    const copied = tr('common.copied');
    btn.title = copied;
    btn.setAttribute('aria-label', copied);
    const prev = state.copyTimers.get(btn);
    if (prev !== undefined) clearTimeout(prev);
    state.copyTimers.set(
      btn,
      setTimeout(() => {
        btn.innerHTML = ic.copy || '';
        const copyLabel = tr('skills.copyName');
        btn.title = copyLabel;
        btn.setAttribute('aria-label', copyLabel);
      }, 1200)
    );
  });
}

function skillDetailMeta(s: SkillPanelEntry, schedAgo: (at: number) => string): string {
  const parts = ['v' + s.version, tr('skills.created', { ago: skillAgo(s.createdAt, schedAgo) })];
  if (s.status === 'expired') parts.unshift(tr('skills.expired'));
  if (s.pinned) parts.push(tr('skills.pinned'));
  parts.push(s.lastUsedAt ? tr('skills.lastUsed', { ago: skillAgo(s.lastUsedAt, schedAgo) }) : tr('skills.neverUsed'));
  parts.push(tr(s.uses === 1 ? 'skills.useOne' : 'skills.useMany', { count: s.uses }));
  return parts.join(' \u00b7 ');
}

function skillControls(s: SkillPanelEntry): string {
  const on = skillOn(s);
  const dis = on ? '' : ' disabled';
  const tier = (resident: boolean, label: string, title: string): string =>
    '<button type="button" data-sop="tier" data-resident="' +
    (resident ? '1' : '0') +
    '" aria-pressed="' +
    (s.resident === resident ? 'true' : 'false') +
    '"' +
    dis +
    ' title="' +
    title +
    '">' +
    label +
    '</button>';
  return (
    '<span class="skill-seg" role="group" aria-label="' +
    tr('skills.tierAria') +
    '">' +
    tier(true, tr('skills.tabResident'), tr('skills.tierResidentTitle')) +
    tier(false, tr('skills.tabLibrary'), tr('skills.tierLibraryTitle')) +
    '</span>' +
    '<button type="button" class="skill-switch" role="switch" data-sop="enabled" aria-checked="' +
    (on ? 'true' : 'false') +
    '" title="' +
    (on ? tr('skills.onTitle') : tr('skills.offTitle')) +
    '">' +
    '<span class="skill-knob"></span><span class="skill-switch-label">' +
    (on ? tr('common.onCap') : tr('common.offCap')) +
    '</span></button>'
  );
}

function skillPaintCtl(ctl: Element, s: SkillPanelEntry): void {
  const on = skillOn(s);
  const tiers = ctl.querySelectorAll<HTMLButtonElement>('[data-sop="tier"]');
  for (const t of tiers) {
    t.setAttribute('aria-pressed', (t.getAttribute('data-resident') === '1') === s.resident ? 'true' : 'false');
    t.disabled = !on;
  }
  const sw = ctl.querySelector<HTMLButtonElement>('[data-sop="enabled"]');
  if (!sw) return;
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  sw.title = on ? tr('skills.onTitle') : tr('skills.offTitle');
  const label = sw.querySelector('.skill-switch-label');
  if (label) label.textContent = on ? tr('common.onCap') : tr('common.offCap');
}

function skillFind(state: SkillsState, name: string | null): SkillPanelEntry | null {
  if (!name) return null;
  for (const s of state.list) if (s.name === name) return s;
  return null;
}

function skillPaint(state: SkillsState, deps: SkillsPanelDeps, name: string): void {
  const s = skillFind(state, name);
  if (!s) return;
  const rows = deps.skillsListEl.querySelectorAll('[data-skill]');
  for (const row of rows) {
    if (row.getAttribute('data-skill') !== name) continue;
    row.classList.toggle('skill-off', !skillOn(s));
    const badge = row.querySelector('.skill-state.expired');
    if (badge && s.status !== 'expired') badge.parentNode?.removeChild(badge);
    const ctl = row.querySelector('.skill-ctl');
    if (ctl) skillPaintCtl(ctl, s);
  }
  if (state.sel && state.sel.skill.name === name) {
    const dctl = deps.skillsDetailEl.querySelector('.skill-head .skill-ctl');
    if (dctl) skillPaintCtl(dctl, state.sel.skill);
    deps.skillsCount.textContent = skillPlace(state.sel.skill);
  }
}

function skillTake(state: SkillsState, name: string, entry: SkillPanelEntry | undefined): void {
  if (!entry) return;
  state.list = state.list.slice();
  for (let i = 0; i < state.list.length; i++) {
    if (state.list[i]?.name === name) state.list[i] = entry;
  }
  if (state.sel && state.sel.skill.name === name) state.sel.skill = entry;
  skillRemember(state);
}

function skillCard(s: SkillPanelEntry, deps: SkillsPanelDeps): string {
  const { text, schedAgo } = deps;
  const meta: string[] = [];
  if (s.pinned) meta.push(tr('skills.pinned'));
  meta.push(s.lastUsedAt ? tr('skills.lastUsed', { ago: skillAgo(s.lastUsedAt, schedAgo) }) : tr('skills.neverUsed'));
  meta.push(tr(s.uses === 1 ? 'skills.useOne' : 'skills.useMany', { count: s.uses }));
  // The name is the button, not the row, because nesting switches inside a button merges them for screen readers.
  const copyLabel = text(tr('skills.copyName'));
  let h =
    '<div class="skill-item skill-card' +
    (skillOn(s) ? '' : ' skill-off') +
    '" data-skill="' +
    text(s.name) +
    '">' +
    '<div class="skill-main"><div class="skill-row"><button type="button" class="skill-open" title="' +
    text(tr('common.open')) +
    '">' +
    text(s.name) +
    '</button>' +
    '<button type="button" class="skill-copy" data-copy-skill="' +
    text(s.name) +
    '" title="' +
    copyLabel +
    '" aria-label="' +
    copyLabel +
    '">' +
    (deps.icons().copy || '') +
    '</button>';
  if (s.status === 'expired') {
    h += '<span class="skill-state expired" title="' + text(tr('skills.expiredTitle')) + '">' + text(tr('skills.expiredCap')) + '</span>';
  }
  if (s.pinned) h += '<span class="skill-pin">' + text(tr('skills.pinned')) + '</span>';
  if (s.category) h += '<span class="skill-cat">' + text(s.category) + '</span>';
  h += '</div>';
  h += '<div class="skill-desc">' + text(s.description || tr('skills.noDesc')) + '</div>';
  h += '<div class="skill-meta">' + text(meta.join(' \u00b7 ') + ' \u00b7 v' + s.version) + '</div>';
  if (s.warning) h += '<div class="skill-warn">' + text(s.warning) + '</div>';
  if (s.problem) h += '<div class="skill-problem">' + text(tr('skills.notDelivered')) + text(s.problem) + '</div>';
  h += '</div><div class="skill-ctl">' + skillControls(s) + '</div></div>';
  return h;
}

function renderSearchRows(
  title: string,
  list: readonly SkillPanelSearch[] | undefined,
  withHits: boolean,
  deps: SkillsPanelDeps
): string {
  if (!list || !list.length) return '';
  let out = '<div class="skill-section">' + deps.text(title) + '</div>';
  for (const q of list) {
    let meta = skillAgo(q.at, deps.schedAgo);
    if (q.agent) meta += ' \u00b7 ' + q.agent;
    if (withHits && q.hits.length) meta += ' \u00b7 ' + q.hits.join(', ');
    out += '<div class="skill-search">' + deps.text(q.query) + '<small>' + deps.text(meta) + '</small></div>';
  }
  return out;
}

function skillSearchesHtml(state: SkillsState, deps: SkillsPanelDeps): string {
  if (!state.searches) return '';
  const h =
    renderSearchRows(tr('skills.searchesEmpty'), state.searches.misses, false, deps) +
    renderSearchRows(tr('skills.searchesUnread'), state.searches.unread, true, deps);
  return h ? '<div class="skill-searches">' + h + '</div>' : '';
}

function renderTabPane(
  pane: { key: 'library' | 'resident'; titleKey: MessageKey; hintKey: MessageKey },
  state: SkillsState,
  deps: SkillsPanelDeps
): string {
  let on = '';
  let off = '';
  let offN = 0;
  for (const s of state.list) {
    if (skillTabOf(s) !== pane.key) continue;
    if (skillOn(s)) on += skillCard(s, deps);
    else {
      off += skillCard(s, deps);
      offN++;
    }
  }
  let h =
    '<div class="skill-pane" role="tabpanel" data-pane="' +
    pane.key +
    '"' +
    (pane.key === state.tab ? '' : ' hidden') +
    '>' +
    '<div class="skill-group-hint">' +
    deps.text(tr(pane.hintKey)) +
    deps.text(tr('skills.pickupHint')) +
    '</div>';
  if (!on && !off) {
    h += '<div class="skills-empty">' + deps.text(pane.key === 'resident' ? tr('skills.noResident') : tr('skills.noLibrary')) + '</div>';
  }
  if (on) h += '<div class="skill-group" data-group="' + pane.key + '">' + on + '</div>';
  if (off) {
    h +=
      '<div class="skill-group" data-group="off"><div class="skill-group-head"><span class="skill-section">' +
      deps.text(tr('skills.offSection', { count: offN })) +
      '</span><span class="skill-group-hint">' +
      deps.text(tr('skills.offHint')) +
      '</span></div>' +
      off +
      '</div>';
  }
  if (pane.key === 'library') h += skillSearchesHtml(state, deps);
  return h + '</div>';
}

function skillTabsHtml(state: SkillsState, deps: SkillsPanelDeps): string {
  const counts = { library: 0, resident: 0 };
  for (const s of state.list) counts[skillTabOf(s)]++;
  let h = '<div class="skill-tabs" role="tablist">';
  for (const tab of SKILL_TABS) {
    const sel = tab.key === state.tab;
    h +=
      '<button type="button" class="skill-tab' +
      (sel ? ' on' : '') +
      '" role="tab" aria-selected="' +
      (sel ? 'true' : 'false') +
      '" data-stab="' +
      tab.key +
      '">' +
      deps.text(tr(tab.titleKey)) +
      '<span class="skill-tab-n">' +
      counts[tab.key] +
      '</span></button>';
  }
  h += '</div>';
  for (const pane of SKILL_TABS) h += renderTabPane(pane, state, deps);
  return h;
}

function skillNewForm(): string {
  return (
    '<div class="skill-item skill-new-form" data-newform="1">' +
    '<div class="skill-row"><span class="skill-name">' +
    tr('skills.newSkill') +
    '</span></div>' +
    '<input class="skill-field" id="skill-new-name" placeholder="' +
    tr('skills.newNamePlaceholder') +
    '" autocomplete="off">' +
    '<input class="skill-field" id="skill-new-desc" placeholder="' +
    tr('skills.newDescPlaceholder') +
    '" autocomplete="off">' +
    '<textarea class="skill-text" id="skill-new-body" placeholder="' +
    tr('skills.newBodyPlaceholder') +
    '"></textarea>' +
    '<div class="skill-acts editor"><button type="button" data-sop="create">' +
    tr('common.create') +
    '</button><button type="button" class="danger" data-sop="cancel-new">' +
    tr('common.cancel') +
    '</button></div></div>'
  );
}

function renderSkillsList(state: SkillsState, deps: SkillsPanelDeps): void {
  state.redrawPending = false;
  state.sel = null;
  deps.skillsBack.hidden = true;
  deps.skillsDetailEl.hidden = true;
  deps.skillsListEl.hidden = false;
  deps.skillsTitle.textContent = tr('skills.title');
  deps.skillsCount.textContent = state.list.length
    ? tr(state.list.length === 1 ? 'skills.countOne' : 'skills.countMany', { count: state.list.length })
    : '';
  deps.skillsNewBtn.hidden = state.newMode;
  let h = '';
  if (!state.enabled) h = '<div class="skills-empty">' + deps.text(tr('skills.disabled')) + '</div>';
  else if (!state.list.length) {
    h = '<div class="skills-empty">' + deps.text(tr('skills.empty')) + '</div>';
  } else h = skillTabsHtml(state, deps);
  if (state.newMode) h = skillNewForm() + h;
  deps.skillsListEl.innerHTML = h;
  if (state.newMode) getEl<HTMLInputElement>('skill-new-name')?.focus();
}

function skillHistRow(e: SkillPanelHistoryEntry, deps: SkillsPanelDeps): string {
  let meta = skillAgo(e.at, deps.schedAgo);
  // Keep talkcode* compatibility alongside fleetherd* until legacy-name.ts is removed.
  if (e.author && !/^(fleetherd|talkcode)(-|$)/.test(e.author)) meta += ' \u00b7 ' + e.author;
  if (e.note) meta += ' \u00b7 ' + e.note;
  if (e.beforeVersion) meta += ' \u00b7 ' + e.beforeVersion + ' \u2192 ' + (e.afterVersion || tr('skills.noVersion'));
  let h =
    '<div class="skill-hist"><div class="skill-hist-main">' +
    '<div class="skill-hist-action">' +
    deps.text(e.action) +
    '</div>' +
    '<div class="skill-hist-meta">' +
    deps.text(meta) +
    '</div></div>';
  if (e.beforeVersion || e.action === 'commit') {
    h += '<button type="button" class="skill-file" data-revert="' + deps.text(e.id) + '">' + deps.text(tr('skills.restoreVersion')) + '</button>';
  }
  return h + '</div>';
}

function renderSkillDetail(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.sel) {
    renderSkillsList(state, deps);
    return;
  }
  const { text, byteSize, schedAgo } = deps;
  const s = state.sel.skill;
  const cur = state.sel.file;
  deps.skillsListEl.hidden = true;
  deps.skillsDetailEl.hidden = false;
  deps.skillsBack.hidden = false;
  deps.skillsNewBtn.hidden = true;
  deps.skillsTitle.textContent = s.name;
  deps.skillsCount.textContent = skillPlace(s);
  const copyLabel = text(tr('skills.copyName'));
  let h =
    '<div class="skill-head"><span class="skill-name">' +
    text(s.name) +
    '</span>' +
    '<button type="button" class="skill-copy" data-copy-skill="' +
    text(s.name) +
    '" title="' +
    copyLabel +
    '" aria-label="' +
    copyLabel +
    '">' +
    (deps.icons().copy || '') +
    '</button>' +
    '<div class="skill-acts"><button type="button" data-sop="pin">' +
    text(s.pinned ? tr('skills.unpin') : tr('skills.pin')) +
    '</button></div><div class="skill-ctl">' +
    skillControls(s) +
    '</div></div>' +
    '<div class="skill-desc">' +
    text(s.description || tr('skills.noDesc')) +
    '</div>' +
    '<div class="skill-meta">' +
    text(skillDetailMeta(s, schedAgo)) +
    '</div>' +
    '<div class="skill-section">' +
    text(tr('skills.files')) +
    '</div><div class="skill-files">';
  for (const f of state.sel.files) {
    h +=
      '<button type="button" class="skill-file' +
      (cur.path === f.path ? ' on' : '') +
      '" data-file="' +
      text(f.path) +
      '">' +
      text(f.path) +
      '<small>' +
      text(byteSize(f.size)) +
      '</small></button>';
  }
  h +=
    '</div>' +
    '<div class="skill-section" id="skill-editor-label">' +
    text(cur.path) +
    '</div>' +
    '<input class="skill-field" id="skill-path" value="' +
    text(cur.path) +
    '" placeholder="references/notes.md" autocomplete="off"' +
    (cur.path === 'SKILL.md' ? ' readonly' : '') +
    '>' +
    '<textarea class="skill-text" id="skill-text" spellcheck="false"></textarea>' +
    '<div class="skill-acts editor"><button type="button" data-sop="save">' +
    text(tr('common.save')) +
    '</button><button type="button" data-sop="new-file">' +
    text(tr('skills.newFile')) +
    '</button>';
  if (cur.path !== 'SKILL.md') {
    h += '<button type="button" class="danger" data-sop="remove-file">' + text(tr('skills.removeFile')) + '</button>';
  }
  h += '</div><div class="skill-section">' + text(tr('skills.history')) + '</div><div class="skill-history">';
  if (!state.sel.history.length) h += '<div class="skills-empty">' + text(tr('skills.noHistory')) + '</div>';
  else for (const entry of state.sel.history) h += skillHistRow(entry, deps);
  h += '</div>';
  deps.skillsDetailEl.innerHTML = h;
  const ta = getEl<HTMLTextAreaElement>('skill-text');
  if (ta) ta.value = cur.content;
}

function skillPending(state: SkillsState): boolean {
  for (const k of Object.keys(state.queue)) {
    if (state.queue[k]?.pending) return true;
  }
  return false;
}

function skillEditorClean(state: SkillsState): boolean {
  if (!state.sel || !state.sel.file) return false;
  const ta = getEl<HTMLTextAreaElement>('skill-text');
  const pathEl = getEl<HTMLInputElement>('skill-path');
  return Boolean(ta && pathEl && ta.value === state.sel.file.content && pathEl.value === state.sel.file.path);
}

function skillReplayRefresh(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.refreshPending || state.fetching || state.busy || skillPending(state)) return;
  const manual = state.refreshPendingManual;
  state.refreshPending = false;
  state.refreshPendingManual = false;
  loadSkills(state, deps, manual);
}

function skillReplayShow(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.showPending || state.busy || skillPending(state)) return;
  const p = state.showPending;
  state.showPending = null;
  openSkill(state, deps, p.name, p.file);
}

function skillAfterWrite(state: SkillsState, deps: SkillsPanelDeps): void {
  skillReplayShow(state, deps);
  skillReplayRefresh(state, deps);
}

function skillRefreshStale(state: SkillsState, deps: SkillsPanelDeps, manual: boolean): void {
  state.refreshPending = true;
  state.refreshPendingManual = state.refreshPendingManual || manual;
  skillReplayRefresh(state, deps);
}

function skillRefreshDetail(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.sel || state.busy || skillPending(state)) return;
  const name = state.sel.skill.name;
  if (skillEditorClean(state)) {
    openSkill(state, deps, name, state.sel.file.path);
    return;
  }
  const e = skillFind(state, name);
  if (e) {
    state.sel.skill = e;
    skillPaint(state, deps, name);
  }
}

function skillRefreshDone(state: SkillsState, deps: SkillsPanelDeps, changed: boolean, manual: boolean): void {
  if (state.sel) {
    if (manual) {
      if (state.busy || skillPending(state)) {
        state.refreshPending = true;
        state.refreshPendingManual = true;
        return;
      }
      skillRefreshDetail(state, deps);
    } else if (!state.busy && !skillPending(state)) {
      const e = skillFind(state, state.sel.skill.name);
      if (e) {
        state.sel.skill = e;
        skillPaint(state, deps, state.sel.skill.name);
      }
    }
    return;
  }
  if (state.newMode) return;
  if (state.busy || skillPending(state)) {
    state.refreshPending = true;
    state.redrawPending = true;
    state.refreshPendingManual = state.refreshPendingManual || manual;
    return;
  }
  if (!changed && !state.redrawPending) return;
  renderSkillsList(state, deps);
}

function loadSkills(state: SkillsState, deps: SkillsPanelDeps, manual: boolean): void {
  if (state.fetching) {
    if (manual) {
      state.fetchManual = true;
      if (deps.skillsRefreshBtn) deps.skillsRefreshBtn.disabled = true;
    }
    return;
  }
  if (deps.app.hidden) return;
  state.fetching = true;
  state.fetchManual = manual;
  if (manual && deps.skillsRefreshBtn) deps.skillsRefreshBtn.disabled = true;
  const epoch = state.epoch;
  fetch('api/skills', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json() as Promise<SkillListResponse>;
    })
    .then((d) => {
      const manualNow = state.fetchManual;
      const was = state.sig;
      state.fetching = false;
      state.fetchManual = false;
      if (deps.skillsRefreshBtn) deps.skillsRefreshBtn.disabled = false;
      if (epoch !== state.epoch) {
        skillRefreshStale(state, deps, manualNow);
        return;
      }
      state.enabled = d.enabled !== false;
      state.list = d.skills || [];
      state.searches = d.searches || null;
      state.fetchedAt = Date.now();
      skillRemember(state);
      skillRefreshDone(state, deps, was !== state.sig, manualNow);
    })
    .catch((e: unknown) => {
      const manualNow = state.fetchManual;
      state.fetching = false;
      state.fetchManual = false;
      if (deps.skillsRefreshBtn) deps.skillsRefreshBtn.disabled = false;
      if (epoch !== state.epoch) {
        skillRefreshStale(state, deps, manualNow);
        return;
      }
      if (manualNow) {
        skillNote(
          deps,
          tr(state.fetchedAt ? 'skills.refreshFailed' : 'skills.loadFailed', { err: errorMessage(e) })
        );
      }
    });
}

function openSkill(state: SkillsState, deps: SkillsPanelDeps, name: string, file?: string): void {
  const body: SkillPanelOp = file ? { action: 'show', name, file } : { action: 'show', name };
  state.showPending = null;
  const seq = ++state.showSeq;
  const epoch = state.epoch;
  state.busy = true;
  skillClearNote(deps);
  deps
    .post('api/skills/op', body, 1)
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<SkillOpResponse>)
    .then((d) => {
      if (seq !== state.showSeq) return;
      // A write left after this show started; discard the stale read and reopen once writes settle.
      if (epoch !== state.epoch) {
        state.busy = false;
        if (!deps.skillsWin.hidden) state.showPending = { name, file };
        skillAfterWrite(state, deps);
        return;
      }
      if (!d || !d.ok) {
        state.busy = false;
        skillNote(deps, (d && d.error) || tr('skills.openFailed'));
        skillAfterWrite(state, deps);
        return;
      }
      state.list = d.skills || state.list;
      skillRemember(state);
      state.sel = d.detail || null;
      state.newMode = false;
      skillClearNote(deps);
      // Release busy before rendering so controls in the new DOM accept clicks immediately.
      state.busy = false;
      renderSkillDetail(state, deps);
      skillAfterWrite(state, deps);
    })
    .catch((e: unknown) => {
      if (seq !== state.showSeq) return;
      state.busy = false;
      if (epoch !== state.epoch) {
        if (!deps.skillsWin.hidden) state.showPending = { name, file };
        skillAfterWrite(state, deps);
        return;
      }
      skillNote(deps, tr('common.reachDaemonWithErr', { err: errorMessage(e) }));
      skillAfterWrite(state, deps);
    });
}

function skillOp(
  state: SkillsState,
  deps: SkillsPanelDeps,
  body: SkillPanelOp,
  then?: (d: SkillOpResponse) => void
): void {
  if (state.busy) return;
  state.busy = true;
  state.epoch++;
  skillClearNote(deps);
  deps
    .post('api/skills/op', body, 1)
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<SkillOpResponse>)
    .then((d) => {
      if (!d || !d.ok) {
        state.busy = false;
        skillNote(deps, (d && d.error) || tr('common.didNotWork'));
        skillAfterWrite(state, deps);
        return;
      }
      state.list = d.skills || state.list;
      skillRemember(state);
      if (d.detail) state.sel = d.detail;
      // Release busy before then() because it may start an openSkill() that re-acquires busy.
      state.busy = false;
      if (then) then(d);
      else if (state.sel) renderSkillDetail(state, deps);
      else renderSkillsList(state, deps);
      skillAfterWrite(state, deps);
    })
    .catch((e: unknown) => {
      state.busy = false;
      skillNote(deps, tr('common.reachDaemonWithErr', { err: errorMessage(e) }));
      skillAfterWrite(state, deps);
    });
}

function saveSkillFile(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.sel) return;
  const pathEl = getEl<HTMLInputElement>('skill-path');
  const textEl = getEl<HTMLTextAreaElement>('skill-text');
  if (!pathEl || !textEl) return;
  const path = (pathEl.value || '').trim();
  const content = textEl.value;
  const s = state.sel.skill;
  if (!path) {
    skillNote(deps, tr('skills.filePathRequired'));
    return;
  }
  if (path === 'SKILL.md') {
    if (!state.sel.file || state.sel.file.path !== 'SKILL.md') {
      skillNote(deps, tr('skills.openSkillMd'));
      return;
    }
    skillOp(state, deps, { action: 'patch', name: s.name, version: state.sel.file.version, content }, () => {
      openSkill(state, deps, s.name, 'SKILL.md');
    });
  } else {
    skillOp(state, deps, { action: 'write-file', name: s.name, file: path, content }, () => {
      openSkill(state, deps, s.name, path);
    });
  }
}

function removeFileUi(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!state.sel) return;
  const pathEl = getEl<HTMLInputElement>('skill-path');
  const path = pathEl ? (pathEl.value || '').trim() : '';
  if (!path || path === 'SKILL.md') return;
  const name = state.sel.skill.name;
  if (!confirm(tr('skills.confirmRemoveFile', { path, name }))) return;
  skillOp(state, deps, { action: 'remove-file', name, file: path }, () => openSkill(state, deps, name, 'SKILL.md'));
}

function skillReread(state: SkillsState, deps: SkillsPanelDeps, name: string): void {
  if (!state.sel || state.sel.skill.name !== name || !state.sel.file) return;
  if (!skillEditorClean(state)) return;
  openSkill(state, deps, name, state.sel.file.path);
}

function skillResync(state: SkillsState, deps: SkillsPanelDeps, name: string): Promise<void> {
  const epoch = state.epoch;
  return fetch('api/skills', { credentials: 'same-origin' })
    .then((r) => r.json() as Promise<SkillListResponse>)
    .then((d) => {
      if (epoch !== state.epoch) return;
      const list = (d && d.skills) || [];
      for (const entry of list) if (entry.name === name) skillTake(state, name, entry);
      skillPaint(state, deps, name);
    })
    .catch(() => {})
    .then(() => skillAfterWrite(state, deps));
}

function skillSend(state: SkillsState, deps: SkillsPanelDeps, name: string, body: SkillPanelOp): void {
  const q = state.queue[name] || (state.queue[name] = { chain: Promise.resolve(), pending: 0, gen: 0 });
  const gen = q.gen;
  q.pending++;
  state.epoch++;
  q.chain = q.chain
    .then<SkillOpResponse | null>(() => {
      if (q.gen !== gen) return null;
      return deps
        .post('api/skills/op', body, 1)
        .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<SkillOpResponse>)
        .catch((e: unknown) => ({ ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(e) }) }));
    })
    .then((d) => {
      q.pending--;
      if (d === null) {
        skillAfterWrite(state, deps);
        return;
      }
      if (!d || !d.ok) {
        q.gen++;
        skillNote(deps, (d && d.error) || tr('common.didNotWork'));
        return skillResync(state, deps, name);
      }
      if (q.pending) return;
      const list = d.skills || [];
      for (const entry of list) if (entry.name === name) skillTake(state, name, entry);
      skillPaint(state, deps, name);
      skillReread(state, deps, name);
      skillAfterWrite(state, deps);
    });
}

function skillSwitch(state: SkillsState, deps: SkillsPanelDeps, btn: Element, op: 'enabled' | 'tier'): void {
  const row = btn.closest('[data-skill]');
  const name = row ? row.getAttribute('data-skill') : state.sel ? state.sel.skill.name : null;
  const cur = !row && state.sel ? state.sel.skill : skillFind(state, name);
  if (!name || !cur) return;
  let body: SkillPanelOp;
  let change: Partial<SkillPanelEntry>;
  if (op === 'enabled') {
    const off = skillOn(cur);
    body = { action: off ? 'archive' : 'restore', name };
    change = { status: off ? 'archived' : 'active' };
  } else {
    const resident = btn.getAttribute('data-resident') === '1';
    if (!skillOn(cur) || resident === cur.resident) return;
    body = { action: 'resident', name, resident };
    change = { resident };
  }
  skillClearNote(deps);
  state.list = state.list.slice();
  for (let i = 0; i < state.list.length; i++) {
    const item = state.list[i];
    if (item && item.name === name) state.list[i] = { ...item, ...change };
  }
  if (state.sel && state.sel.skill.name === name) state.sel.skill = { ...state.sel.skill, ...change };
  skillPaint(state, deps, name);
  skillSend(state, deps, name, body);
}

function openSkills(state: SkillsState, deps: SkillsPanelDeps): void {
  if (!deps.skillsWin.hidden) return;
  deps.skillsWin.hidden = false;
  state.newMode = false;
  skillClearNote(deps);
  if (!state.cacheRead) {
    state.cacheRead = true;
    skillCacheLoad(state);
  }
  if (state.fetchedAt) {
    renderSkillsList(state, deps);
  } else {
    deps.skillsListEl.innerHTML = '<div class="skills-empty">' + deps.text(tr('common.loading')) + '</div>';
    deps.skillsDetailEl.hidden = true;
    deps.skillsListEl.hidden = false;
    deps.skillsBack.hidden = true;
    deps.skillsTitle.textContent = tr('skills.title');
    deps.skillsCount.textContent = '';
  }
  loadSkills(state, deps, !state.fetchedAt);
  deps.skillsClose.focus();
}

function closeSkills(state: SkillsState, deps: SkillsPanelDeps): void {
  if (deps.skillsWin.hidden) return;
  deps.skillsWin.hidden = true;
  state.showPending = null;
}

function handleCreateSkill(state: SkillsState, deps: SkillsPanelDeps): void {
  const nameEl = getEl<HTMLInputElement>('skill-new-name');
  const descEl = getEl<HTMLInputElement>('skill-new-desc');
  const bodyEl = getEl<HTMLTextAreaElement>('skill-new-body');
  const newName = nameEl ? nameEl.value.trim() : '';
  const newDesc = descEl ? descEl.value.trim() : '';
  if (!newName) {
    skillNote(deps, tr('skills.nameRequired'));
    return;
  }
  if (!newDesc) {
    skillNote(deps, tr('skills.descRequired'));
    return;
  }
  const body: SkillPanelOp =
    bodyEl && bodyEl.value
      ? { action: 'create', name: newName, description: newDesc, body: bodyEl.value }
      : { action: 'create', name: newName, description: newDesc };
  skillOp(state, deps, body, () => {
    state.newMode = false;
    state.sel = null;
    renderSkillsList(state, deps);
    openSkill(state, deps, newName);
  });
}

function handleSkillOpClick(state: SkillsState, deps: SkillsPanelDeps, opBtn: Element, op: string | null): void {
  if (op === 'create') {
    handleCreateSkill(state, deps);
    return;
  }
  if (op === 'cancel-new') {
    state.newMode = false;
    skillClearNote(deps);
    renderSkillsList(state, deps);
    return;
  }
  if (op === 'save') {
    saveSkillFile(state, deps);
    return;
  }
  if (op === 'new-file') {
    const p = getEl<HTMLInputElement>('skill-path');
    const t = getEl<HTMLTextAreaElement>('skill-text');
    const label = getEl<HTMLElement>('skill-editor-label');
    if (!p || !t) return;
    p.value = '';
    p.removeAttribute('readonly');
    t.value = '';
    if (label) label.textContent = tr('skills.newFile');
    p.focus();
    return;
  }
  if (op === 'remove-file') {
    removeFileUi(state, deps);
    return;
  }
  if (op === 'enabled' || op === 'tier') {
    skillSwitch(state, deps, opBtn, op);
    return;
  }
  if (op === 'pin' && state.sel) {
    const pinName = state.sel.skill.name;
    const pinned = !state.sel.skill.pinned;
    skillOp(state, deps, { action: 'pin', name: pinName, pinned }, () => openSkill(state, deps, pinName));
  }
}

function handleSkillTabClick(state: SkillsState, deps: SkillsPanelDeps, tabBtn: Element): void {
  state.tab = tabBtn.getAttribute('data-stab') === 'resident' ? 'resident' : 'library';
  const tabs = deps.skillsListEl.querySelectorAll('[data-stab]');
  const panes = deps.skillsListEl.querySelectorAll<HTMLElement>('[data-pane]');
  for (const t of tabs) {
    const isOn = t.getAttribute('data-stab') === state.tab;
    t.classList.toggle('on', isOn);
    t.setAttribute('aria-selected', isOn ? 'true' : 'false');
  }
  for (const p of panes) p.hidden = p.getAttribute('data-pane') !== state.tab;
}

function bindSkillEvents(state: SkillsState, deps: SkillsPanelDeps): void {
  deps.skillsToggle.addEventListener('click', () => {
    deps.closeMenus();
    openSkills(state, deps);
  });
  deps.skillsRefreshBtn.addEventListener('click', () => loadSkills(state, deps, true));
  deps.skillsClose.addEventListener('click', () => closeSkills(state, deps));
  deps.skillsWin.addEventListener('click', (e) => {
    if (e.target === deps.skillsWin) closeSkills(state, deps);
  });
  deps.skillsBack.addEventListener('click', () => {
    skillClearNote(deps);
    renderSkillsList(state, deps);
  });
  deps.skillsNewBtn.addEventListener('click', () => {
    state.newMode = true;
    skillClearNote(deps);
    renderSkillsList(state, deps);
  });
  deps.skillsBody.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const tabBtn = target.closest('[data-stab]');
    if (tabBtn) {
      handleSkillTabClick(state, deps, tabBtn);
      return;
    }
    const copyBtn = target.closest<HTMLElement>('[data-copy-skill]');
    if (copyBtn) {
      e.stopPropagation();
      const name = copyBtn.getAttribute('data-copy-skill');
      if (name) skillCopyName(state, deps, name, copyBtn);
      return;
    }
    const rev = target.closest('[data-revert]');
    if (rev) {
      e.stopPropagation();
      if (!state.sel) return;
      const id = rev.getAttribute('data-revert');
      const name = state.sel.skill.name;
      if (!id) return;
      if (!confirm(tr('skills.confirmRevert'))) {
        return;
      }
      skillOp(state, deps, { action: 'revert', name, id }, () => openSkill(state, deps, name));
      return;
    }
    const opBtn = target.closest('[data-sop]');
    if (opBtn) {
      e.stopPropagation();
      handleSkillOpClick(state, deps, opBtn, opBtn.getAttribute('data-sop'));
      return;
    }
    const fileBtn = target.closest('[data-file]');
    if (fileBtn && state.sel) {
      const path = fileBtn.getAttribute('data-file');
      if (path) openSkill(state, deps, state.sel.skill.name, path);
      return;
    }
    const card = target.closest('[data-skill]');
    if (card) {
      const cardName = card.getAttribute('data-skill');
      if (cardName) openSkill(state, deps, cardName);
    }
  });
}

export function createSkillsPanel(deps: SkillsPanelDeps): SkillsPanel {
  const state: SkillsState = {
    enabled: true,
    list: [],
    sel: null,
    busy: false,
    newMode: false,
    searches: null,
    cacheRead: false,
    fetchedAt: 0,
    sig: '',
    epoch: 0,
    showSeq: 0,
    refreshPending: false,
    refreshPendingManual: false,
    redrawPending: false,
    showPending: null,
    fetching: false,
    fetchManual: false,
    tab: 'library',
    queue: {},
    copyTimers: new WeakMap(),
  };
  bindSkillEvents(state, deps);

  return {
    open: () => openSkills(state, deps),
    close: () => closeSkills(state, deps),
    beforeExternalWrite: () => {
      state.epoch++;
    },
    afterExternalWrite: (refreshPending) => {
      if (refreshPending) state.refreshPending = true;
      skillAfterWrite(state, deps);
    },
    repaint: () => {
      if (deps.skillsWin.hidden) return;
      if (state.sel) renderSkillDetail(state, deps);
      else if (state.fetchedAt) renderSkillsList(state, deps);
    },
  };
}
