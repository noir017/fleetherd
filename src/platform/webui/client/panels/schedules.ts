import type {
  SchedulePanelAction,
  SchedulePanelFormContext,
  SchedulePanelRun,
  SchedulePanelSetting,
  SchedulePanelShape,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../adapter.js';
import type { ScheduleTargetRequest } from '../../protocol.js';
import type { Topic } from '../../topics.js';

export interface FilterBarOption {
  value: string;
  label: string;
  short?: string;
  icon?: string;
  count?: number;
}

export interface FilterBarGroup {
  id: string;
  label: string;
  pinned?: boolean;
  options: FilterBarOption[];
}

export interface FilterBarState {
  q: string;
  sel: Record<string, string[] | undefined>;
  sort: string;
  dir: string;
}

export interface FilterBar {
  el: HTMLElement;
  state: () => FilterBarState;
  setGroups: (groups: FilterBarGroup[] | null) => void;
  setCounts: (shown: number, total: number) => void;
  clear: () => void;
}

export interface FilterBarOpts {
  key: string;
  placeholder: string;
  groups: FilterBarGroup[];
  sort?: {
    options: Array<{ value: string; label: string }>;
    value: string;
    dir: string;
  };
  onChange: () => void;
}

export interface TopicTree {
  visible: Topic[];
  byId: Record<string, Topic>;
  kids: Record<string, Topic[]>;
  forks?: Record<string, Topic[]>;
  roots: Topic[];
}

export interface TreeRow {
  t: Topic;
  depth: number;
  kids: number;
  shut: boolean;
  under: string;
}

export interface TreeWalker {
  rows: TreeRow[];
  walk: (t: Topic, depth: number) => void;
}

export interface TreeRowOpts {
  attr: string;
  menu: string;
  cls?: string;
  tail?: string;
  attrs?: string;
  sub?: string;
  time?: string;
  moreTitle?: string;
}

export interface RowHtmlOpts {
  cls?: string;
  attrs: string;
  key?: string;
  legend?: string;
  dot?: string;
  title?: string;
  sub?: string;
  time?: string;
  badge?: string;
  mark?: string;
  moreTitle?: string;
}

export interface SchedulesPanelDeps {
  app: HTMLElement;
  schedToggle: HTMLElement;
  schedAlert: HTMLElement;
  schedList: HTMLElement;
  schedSummary: HTMLElement;
  schedReadBtn: HTMLButtonElement;
  schedFilterHost: HTMLElement;
  schedNewBtn: HTMLElement;
  schedClose: HTMLElement;
  schedNote: HTMLElement;
  schedSessionList: HTMLElement;
  schedSubnav: HTMLElement;
  schedTabScheduled: HTMLElement;
  schedTabScheduledN: HTMLElement;
  schedTabScheduledAlert: HTMLElement | null;
  schedTabReviews: HTMLElement;
  schedTabReviewsN: HTMLElement;
  schedTabTasks: HTMLElement;
  schedTabTasksN: HTMLElement;
  schedTabSessions: HTMLElement;
  schedTabSessionsN: HTMLElement;
  schedSessionsAlert: HTMLElement | null;
  revPane: HTMLElement;
  rowMenu: HTMLElement;
  taskPage: HTMLElement;
  taskTitle: HTMLElement;
  taskSub: HTMLElement;
  taskClose: HTMLElement;
  taskNote: HTMLElement;
  taskView: HTMLElement;
  icons: () => Record<string, string>;
  getTopics: () => Topic[];
  getTopic: () => string;
  topicById: (id: string) => Topic | null;
  runOwners: () => Record<string, string>;
  rowRunning: (t: Topic) => boolean;
  unreadOf: (t: Topic) => number;
  needsRead: (t: Topic) => boolean;
  topicTree: (list: Topic[]) => TopicTree;
  treeWalker: (tree: TopicTree) => TreeWalker;
  treeRowHtml: (row: TreeRow, opts: TreeRowOpts) => string;
  rowHtml: (opts: RowHtmlOpts) => string;
  agentTagHtml: (t: Topic) => string;
  splitTitle: (title: string) => { rest: string };
  text: (s: unknown) => string;
  schedAgo: (at: number) => string;
  ageClock: (at: number) => string;
  ageText: (ms: number, done: boolean) => string;
  stLeft: (ms: number) => string;
  atBottom: () => boolean;
  toBottom: () => void;
  armAgeTick: () => void;
  markAllRead: (list: Topic[], noun: string, say: (msg: string) => void) => void;
  switchTopic: (id: string) => void;
  foldClick: (e: MouseEvent) => boolean;
  rowMenuFollow: () => void;
  closeRowMenu: (refocus: boolean) => void;
  getRowMenuKey: () => string | null;
  openRowMenuFor: (btn: Element) => void;
  makeFilterBar: (opts: FilterBarOpts) => FilterBar;
  paneIsOpen: () => boolean;
  paneDocked: () => boolean;
  paneSetOpen: (open: boolean, opts?: { transient?: boolean }) => void;
  reviewsCount: () => number | null;
  loadReviews: () => void;
  paintReviews: () => void;
}

export interface SchedulesPanel {
  init: () => void;
  setOpen: (open: boolean, transient?: boolean) => void;
  onPanelOpen: () => void;
  onStreamOpen: () => void;
  onTopicsUpdated: () => void;
  disarm: () => void;
  showNote: (msg: string) => void;
  paintTab: () => void;
  paintCounts: () => void;
  paintSummary: () => void;
  getTask: (id: string) => SchedulePanelTask | null;
  op: (
    id: string,
    action: SchedulePanelAction,
    btn?: HTMLButtonElement | null,
    tags?: string[],
    clearDraft?: boolean
  ) => void;
  openTaskPage: (id: string | null, edit?: boolean) => void;
  closeTaskPage: (force?: boolean) => boolean;
}

interface SessionGroup {
  key: string;
  label: string;
  items: Topic[];
  unread: number;
  running: number;
  asking: number;
  current: boolean;
}

type TaskPageDetail = Omit<SchedulePanelTaskDetail, 'task'> & { task: SchedulePanelTask | null };

interface TaskPageState {
  id: string | null;
  detail: TaskPageDetail | null;
  mode: 'view' | 'edit' | 'new';
  seq: number;
  busy: boolean;
}

interface SchedulesState {
  enabled: boolean;
  tasks: SchedulePanelTask[] | null;
  busy: boolean;
  seq: number;
  timer: ReturnType<typeof setTimeout> | 0;
  filter: FilterBar | null;
  tab: 'scheduled' | 'reviews';
  subtab: 'tasks' | 'sessions';
  sessGroups: Record<string, boolean>;
  tp: TaskPageState;
  zonesHtml: string | null;
}

interface TaskEditPayload {
  name?: string;
  cron?: string;
  at?: string;
  tz?: string;
  prompt?: string;
  command?: string;
  agent?: string;
  session?: 'fixed' | 'new' | 'daily';
  model?: string | null;
  cwd?: string | null;
  host?: string | null;
  timeoutMs?: number;
  tags?: string[];
  target?: ScheduleTargetRequest;
}

interface SchedulesListResponse {
  enabled?: boolean;
  tasks?: SchedulePanelTask[];
}

interface ScheduleOpResponse {
  ok?: boolean;
  error?: string;
  tasks?: SchedulePanelTask[];
}

interface ScheduleDetailResponse {
  ok?: boolean;
  error?: string;
  detail?: SchedulePanelTaskDetail;
  tasks?: SchedulePanelTask[];
}

interface ScheduleFormResponse {
  ok?: boolean;
  error?: string;
  form?: SchedulePanelFormContext;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const RUN_STATUS_WORD: Record<string, string> = {
  ok: 'ok',
  failed: 'failed',
  interrupted: 'interrupted',
  skipped: 'skipped',
  missed: 'missed',
};

const TP_CRON_HINT = 'Five fields: minute, hour, day of month, month, weekday \u2014 read in the task\u2019s time zone.';
const TP_AT_HINT = 'One run, at this time in the task\u2019s time zone.';

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return 'network error';
}

function schedSessions(deps: SchedulesPanelDeps): Topic[] {
  const out: Topic[] = [];
  for (const t of deps.getTopics()) if (t.scheduled) out.push(t);
  return out;
}

function schedMembers(deps: SchedulesPanelDeps): Topic[] {
  const runs = deps.runOwners();
  const out: Topic[] = [];
  for (const t of deps.getTopics()) if (runs[t.id]) out.push(t);
  return out;
}

function sessionGroupMeta(
  at: Date | null,
  now: Date,
  yesterday: Date
): { key: string; label: string } {
  if (!at) return { key: 'x:earlier', label: 'Earlier' };
  const y = now.getFullYear();
  const m = now.getMonth();
  const day = at.getFullYear() === y && at.getMonth() === m;
  const month = ('0' + (at.getMonth() + 1)).slice(-2);
  if (!day) {
    return {
      key: 'm:' + at.getFullYear() + '-' + month,
      label: (MONTH_NAMES[at.getMonth()] ?? '') + ' ' + at.getFullYear(),
    };
  }
  const key = 'd:' + at.getFullYear() + '-' + month + '-' + ('0' + at.getDate()).slice(-2);
  if (at.getDate() === now.getDate()) return { key, label: 'Today' };
  if (
    at.getFullYear() === yesterday.getFullYear() &&
    at.getMonth() === yesterday.getMonth() &&
    at.getDate() === yesterday.getDate()
  ) {
    return { key, label: 'Yesterday' };
  }
  return { key, label: (MONTH_NAMES[at.getMonth()] ?? '').slice(0, 3) + ' ' + at.getDate() };
}

function schedSessionGroups(list: readonly Topic[], deps: SchedulesPanelDeps): SessionGroup[] {
  const runs = deps.runOwners();
  const below: Record<string, boolean> = {};
  const now = new Date();
  for (const t of deps.getTopics()) {
    const r = runs[t.id];
    if (r && t.asking) below[r] = true;
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const curTopic = deps.getTopic();
  const out: SessionGroup[] = [];
  const byKey: Record<string, SessionGroup> = {};
  for (const t of list) {
    const at = t.lastAt ? new Date(t.lastAt) : null;
    const { key, label } = sessionGroupMeta(at, now, yesterday);
    let g = byKey[key];
    if (!g) {
      g = { key, label, items: [], unread: 0, running: 0, asking: 0, current: false };
      byKey[key] = g;
      out.push(g);
    }
    g.items.push(t);
    if (t.id === curTopic || runs[curTopic] === t.id) g.current = true;
    g.unread += deps.unreadOf(t);
    if (deps.rowRunning(t) || below[t.id]) g.running++;
    if (t.asking || below[t.id]) g.asking++;
  }
  for (let j = 0; j < out.length; j++) {
    const item = out[j];
    if (item && item.key === 'x:earlier' && j < out.length - 1) {
      out.push(out.splice(j, 1)[0] as SessionGroup);
      break;
    }
  }
  return out;
}

function saveSessGroups(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const keep: Record<string, boolean> = {};
  for (const g of schedSessionGroups(schedSessions(deps), deps)) keep[g.key] = true;
  for (const k of Object.keys(state.sessGroups)) if (!keep[k]) delete state.sessGroups[k];
  try {
    localStorage.setItem('aa_sched_groups', JSON.stringify(state.sessGroups));
  } catch {
    // Ignore storage errors.
  }
}

function sessGroupOpen(state: SchedulesState, g: SessionGroup, newest: boolean): boolean {
  if (g.current) return true;
  const st = state.sessGroups[g.key];
  if (st === true || st === false) return st;
  return newest;
}

function schedSessionRow(row: TreeRow, deps: SchedulesPanelDeps): string {
  const t = row.t;
  const run = Boolean(t.scheduled);
  const o: TreeRowOpts = { attr: 'data-sess', menu: 'sess', cls: ' sess-item' };
  if (!run) {
    o.moreTitle = 'Topic actions';
    return deps.treeRowHtml(row, o);
  }
  const count = t.msgCount || 0;
  const stateLabel = t.asking
    ? 'awaiting you'
    : deps.rowRunning(t)
      ? 'running'
      : t.stage === 'failed'
        ? 'failed'
        : t.stage === 'review'
          ? 'finished'
          : '';
  const when = t.lastAt
    ? '<span class="topic-age" data-age="' +
      deps.text(t.lastAt) +
      '" data-age-run="0" title="Ended ' +
      deps.text(deps.ageClock(t.lastAt)) +
      '">' +
      deps.text(deps.ageText(Date.now() - t.lastAt, true)) +
      '</span>'
    : '';
  o.sub =
    '<span class="topic-dir">' +
    when +
    (count ? ' \u00b7 ' + count + ' message' + (count === 1 ? '' : 's') : '') +
    (stateLabel ? ' \u00b7 ' + stateLabel : '') +
    '</span>';
  o.time = '';
  o.moreTitle = 'Session actions';
  return deps.treeRowHtml(row, o);
}

function paintSchedRead(deps: SchedulesPanelDeps, pending: number): void {
  deps.schedReadBtn.disabled = !pending;
  deps.schedReadBtn.title = pending
    ? 'Mark all read (' + pending + ' session' + (pending === 1 ? '' : 's') + ')'
    : 'Mark all read \u2014 nothing unread';
}

function renderSessionGroup(
  gr: SessionGroup,
  open: boolean,
  walker: TreeWalker,
  deps: SchedulesPanelDeps
): string {
  const ic = deps.icons();
  let flags = '';
  if (!open) {
    if (gr.unread) flags += '<span class="sess-group-flag unread">' + gr.unread + ' unread</span>';
    if (gr.asking) flags += '<span class="sess-group-flag asking">' + gr.asking + ' awaiting you</span>';
    if (gr.running > gr.asking) {
      flags += '<span class="sess-group-flag running">' + (gr.running - gr.asking) + ' running</span>';
    }
  }
  let body = '';
  const from = walker.rows.length;
  for (const item of gr.items) walker.walk(item, 0);
  for (let r = from; r < walker.rows.length; r++) {
    const row = walker.rows[r];
    if (row) body += schedSessionRow(row, deps);
  }
  const id = 'sess-g-' + gr.key.replace(/:/g, '-');
  return (
    '<div class="sess-group">' +
    '<button type="button" class="sess-group-head" data-sgroup="' +
    deps.text(gr.key) +
    '"' +
    (gr.current ? ' data-slock="1"' : '') +
    ' aria-expanded="' +
    (open ? 'true' : 'false') +
    '" aria-controls="' +
    id +
    '">' +
    '<span class="sess-group-caret">' +
    (open ? ic.chevronDown || '' : ic.chevronRight || '') +
    '</span>' +
    '<span class="sess-group-name">' +
    deps.text(gr.label) +
    '</span>' +
    '<span class="sess-group-count">' +
    gr.items.length +
    '</span>' +
    flags +
    '</button>' +
    '<div class="sess-group-rows" id="' +
    id +
    '"' +
    (open ? '' : ' hidden') +
    '>' +
    body +
    '</div></div>'
  );
}

function paintSessions(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const list = schedSessions(deps);
  if (!list.length) {
    paintSchedRead(deps, 0);
    deps.schedSessionList.innerHTML =
      '<div class="sched-empty">No scheduled sessions yet. A task that runs in a new or daily session opens one here.</div>';
    deps.rowMenuFollow();
    deps.armAgeTick();
    return;
  }
  const tree = deps.topicTree(schedMembers(deps));
  const walker = deps.treeWalker(tree);
  let pending = 0;
  for (const t of tree.visible) if (deps.needsRead(t)) pending++;
  paintSchedRead(deps, pending);
  const groups = schedSessionGroups(list, deps);
  let h = '';
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    if (!gr) continue;
    h += renderSessionGroup(gr, sessGroupOpen(state, gr, g === 0), walker, deps);
  }
  deps.schedSessionList.innerHTML = h;
  deps.rowMenuFollow();
  deps.armAgeTick();
}

function paintSchedCounts(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const tCount = state.tasks ? String(state.tasks.length) : '';
  const sList = schedSessions(deps);
  deps.schedTabTasksN.textContent = tCount;
  deps.schedTabSessionsN.textContent = String(sList.length);
  const revCount = deps.reviewsCount();
  deps.schedTabReviewsN.textContent = revCount !== null ? String(revCount) : '';
  // No spaces around the separator so narrow 220px tabs do not clip the alert dot.
  deps.schedTabScheduledN.textContent =
    sList.length > 0 ? (tCount ? tCount + '\u00b7' + sList.length : String(sList.length)) : tCount;
}

function paintSchedAlert(deps: SchedulesPanelDeps): void {
  let waiting = false;
  const runs = deps.runOwners();
  for (const t of deps.getTopics()) {
    if (runs[t.id] && t.stage === 'answer') {
      waiting = true;
      break;
    }
  }
  deps.schedAlert.hidden = !waiting;
  const label = waiting ? 'Side tasks \u2014 a run is waiting on your answer' : 'Side tasks';
  deps.schedToggle.title = label;
  deps.schedToggle.setAttribute('aria-label', label);
  if (deps.schedTabScheduledAlert) deps.schedTabScheduledAlert.hidden = !waiting;
  if (deps.schedSessionsAlert) deps.schedSessionsAlert.hidden = !waiting;
  deps.schedTabScheduled.title = waiting ? 'Scheduled \u2014 a run is waiting on your answer' : 'Scheduled';
  deps.schedTabSessions.title = waiting ? 'Sessions \u2014 a run is waiting on your answer' : 'Sessions';
}

function paintTasksSummary(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (state.tasks === null) {
    deps.schedSummary.textContent = 'loading\u2026';
    return;
  }
  let active = 0;
  let paused = 0;
  let ended = 0;
  for (const t of state.tasks) {
    if (t.state === 'active') active++;
    else if (t.state === 'paused') paused++;
    else ended++;
  }
  deps.schedSummary.textContent = !state.enabled
    ? 'not enabled'
    : state.tasks.length
      ? active + ' active' + (paused ? ' \u00b7 ' + paused + ' paused' : '') + (ended ? ' \u00b7 ' + ended + ' ended' : '')
      : 'nothing scheduled';
}

function paintSummary(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (state.tab === 'reviews') {
    const revCount = deps.reviewsCount();
    deps.schedSummary.textContent =
      revCount !== null
        ? revCount
          ? revCount + (revCount === 1 ? ' review' : ' reviews')
          : 'no reviews yet'
        : 'loading\u2026';
    return;
  }
  if (state.subtab === 'sessions') {
    const list = schedSessions(deps);
    let busy = 0;
    for (const item of list) if (deps.rowRunning(item) || item.asking) busy++;
    deps.schedSummary.textContent = list.length
      ? list.length + (list.length === 1 ? ' session' : ' sessions') + (busy ? ' \u00b7 ' + busy + ' running' : '')
      : 'no sessions yet';
    return;
  }
  paintTasksSummary(state, deps);
}

function paintSchedTab(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const isReviews = state.tab === 'reviews';
  deps.schedTabScheduled.classList.toggle('on', !isReviews);
  deps.schedTabReviews.classList.toggle('on', isReviews);
  deps.schedTabScheduled.setAttribute('aria-selected', !isReviews ? 'true' : 'false');
  deps.schedTabReviews.setAttribute('aria-selected', isReviews ? 'true' : 'false');
  deps.schedSubnav.hidden = isReviews;
  deps.revPane.hidden = !isReviews;
  deps.schedFilterHost.hidden = isReviews || state.subtab === 'sessions';
  deps.schedReadBtn.hidden = isReviews || state.subtab !== 'sessions';
  deps.schedNewBtn.hidden = isReviews || state.subtab === 'sessions' || !state.enabled;

  if (!isReviews) {
    const isSessions = state.subtab === 'sessions';
    deps.schedTabTasks.classList.toggle('on', !isSessions);
    deps.schedTabSessions.classList.toggle('on', isSessions);
    deps.schedTabTasks.setAttribute('aria-selected', !isSessions ? 'true' : 'false');
    deps.schedTabSessions.setAttribute('aria-selected', isSessions ? 'true' : 'false');
    deps.schedList.hidden = isSessions;
    deps.schedSessionList.hidden = !isSessions;
    if (isSessions) paintSessions(state, deps);
  } else {
    deps.schedTabTasks.classList.remove('on');
    deps.schedTabSessions.classList.remove('on');
    deps.schedTabTasks.setAttribute('aria-selected', 'false');
    deps.schedTabSessions.setAttribute('aria-selected', 'false');
    deps.schedList.hidden = true;
    deps.schedSessionList.hidden = true;
    deps.paintReviews();
  }
  paintSchedCounts(state, deps);
  paintSchedAlert(deps);
  paintSummary(state, deps);
}

function setSchedTab(state: SchedulesState, deps: SchedulesPanelDeps, tab: string): void {
  deps.closeRowMenu(false);
  state.tab = tab === 'reviews' ? 'reviews' : 'scheduled';
  try {
    localStorage.setItem('aa_sched_tab', state.tab);
  } catch {
    // Ignore storage errors.
  }
  if (state.tab === 'reviews') deps.loadReviews();
  paintSchedTab(state, deps);
}

function setSchedSubtab(state: SchedulesState, deps: SchedulesPanelDeps, sub: string): void {
  deps.closeRowMenu(false);
  state.tab = 'scheduled';
  state.subtab = sub === 'sessions' ? 'sessions' : 'tasks';
  try {
    localStorage.setItem('aa_sched_tab', 'scheduled');
    localStorage.setItem('aa_sched_subtab', state.subtab);
  } catch {
    // Ignore storage errors.
  }
  paintSchedTab(state, deps);
}

function disarmSched(state: SchedulesState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = 0;
}

function armSched(state: SchedulesState, deps: SchedulesPanelDeps): void {
  disarmSched(state);
  if (!deps.paneIsOpen()) return;
  const wait = state.tasks && state.tasks.some((t) => t.running) ? 5000 : 30000;
  state.timer = setTimeout(() => {
    state.timer = 0;
    if (!deps.paneIsOpen()) return;
    if (document.visibilityState === 'hidden') {
      armSched(state, deps);
      return;
    }
    loadSchedules(state, deps);
    if (state.tab === 'reviews') deps.loadReviews();
  }, wait);
}

function setSchedules(deps: SchedulesPanelDeps, open: boolean, transient?: boolean): void {
  if (open === deps.paneIsOpen()) return;
  if (!open) deps.closeRowMenu(false);
  const wasBottom = deps.atBottom();
  deps.paneSetOpen(open, { transient });
  if (wasBottom) deps.toBottom();
}

function showSchedNote(deps: SchedulesPanelDeps, msg: string): void {
  deps.schedNote.hidden = false;
  deps.schedNote.textContent = msg;
}

function loadSchedules(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (deps.app.hidden) return;
  const seq = ++state.seq;
  deps.schedNote.hidden = true;
  fetch('api/schedules', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json() as Promise<SchedulesListResponse>;
    })
    .then((d) => {
      if (seq !== state.seq) return;
      state.enabled = d.enabled !== false;
      if (!state.enabled) deps.schedNewBtn.hidden = true;
      paintSchedulesList(state, deps, d.tasks || []);
    })
    .catch((e: unknown) => {
      if (seq !== state.seq) return;
      showSchedNote(deps, 'Could not refresh: ' + errorMessage(e));
    })
    .then(() => {
      if (seq === state.seq) armSched(state, deps);
    });
}

function schedIn(at: number, stLeft: (ms: number) => string): string {
  if (at <= Date.now()) return 'due now';
  return 'in ' + stLeft(at - Date.now());
}

function schedDur(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
}

function schedTargetShort(t: SchedulePanelTask, deps: SchedulesPanelDeps): string {
  if (t.targetTopic) {
    for (const topic of deps.getTopics()) {
      if (topic.id === t.targetTopic) return topic.title || t.targetTopic;
    }
  }
  return t.target;
}

function schedTarget(t: SchedulePanelTask, deps: SchedulesPanelDeps): string {
  return 'posts to ' + schedTargetShort(t, deps);
}

function schedLast(t: SchedulePanelTask, schedAgo: (at: number) => string): string {
  if (!t.last) return '';
  const word = RUN_STATUS_WORD[t.last.status] || t.last.status;
  let s = 'last run ' + word + ' \u00b7 ' + schedAgo(t.last.at);
  if (t.last.durationMs != null) s += ' \u00b7 ' + schedDur(t.last.durationMs);
  if (t.last.error) s += ' \u2014 ' + t.last.error;
  return s;
}

function schedLastShort(t: SchedulePanelTask, schedAgo: (at: number) => string): string {
  if (!t.last) return '';
  const word = RUN_STATUS_WORD[t.last.status] || t.last.status;
  return 'last ' + word + ' ' + schedAgo(t.last.at);
}

function schedDot(t: SchedulePanelTask, taskState: string): string {
  let dot = 'topic-dot';
  if (t.running) dot += ' running';
  else if (t.last && t.last.status !== 'ok') dot += ' failed';
  else if (taskState === 'active') dot += ' live';
  return dot;
}

function schedTags(t: SchedulePanelTask): string[] {
  return t.tags && t.tags.length ? t.tags : [];
}

function schedTask(state: SchedulesState, id: string | null): SchedulePanelTask | null {
  if (!id || !state.tasks) return null;
  for (const t of state.tasks) if (t.id === id) return t;
  return null;
}

function schedStatusKey(t: SchedulePanelTask): 'running' | 'paused' | 'active' | 'ended' {
  if (t.running) return 'running';
  if (t.state === 'paused') return 'paused';
  if (t.state === 'active') return 'active';
  return 'ended';
}

function schedFilterGroups(tasks: readonly SchedulePanelTask[]): FilterBarGroup[] {
  const counts = { running: 0, active: 0, paused: 0, ended: 0 };
  const tags: Record<string, number> = {};
  const order: string[] = [];
  let untagged = 0;
  for (const t of tasks) {
    const list = schedTags(t);
    counts[schedStatusKey(t)]++;
    if (!list.length) untagged++;
    for (const tag of list) {
      if (tags[tag] === undefined) {
        tags[tag] = 0;
        order.push(tag);
      }
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
  }
  order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tagOpts: FilterBarOption[] = order.map((tag) => ({
    value: tag,
    label: tag,
    icon: 'tag',
    count: tags[tag] ?? 0,
  }));
  tagOpts.push({ value: ' untagged', label: 'Untagged', icon: 'tag', count: untagged });
  return [
    {
      id: 'status',
      label: 'Status',
      pinned: true,
      options: [
        { value: 'running', label: 'Running', short: 'Run', icon: 'play', count: counts.running },
        { value: 'active', label: 'Active', short: 'Active', icon: 'clock', count: counts.active },
        { value: 'paused', label: 'Paused', short: 'Pause', icon: 'pause', count: counts.paused },
        { value: 'ended', label: 'Ended', short: 'End', icon: 'stop', count: counts.ended },
      ],
    },
    { id: 'tags', label: 'Tags', options: tagOpts },
  ];
}

function schedMatch(
  t: SchedulePanelTask,
  words: readonly string[],
  sel: Record<string, string[] | undefined>,
  deps: SchedulesPanelDeps
): boolean {
  if (words.length) {
    const hay = ((t.name || '') + ' ' + (t.detail || '') + ' ' + (t.target || '') + ' ' + schedTarget(t, deps)).toLowerCase();
    for (const w of words) if (hay.indexOf(w) < 0) return false;
  }
  const statusSel = sel.status;
  if (statusSel && statusSel.length && statusSel.indexOf(schedStatusKey(t)) < 0) return false;
  const tagSel = sel.tags;
  if (tagSel && tagSel.length) {
    const tags = schedTags(t);
    const hit = !tags.length ? tagSel.indexOf(' untagged') >= 0 : tags.some((tag) => tagSel.indexOf(tag) >= 0);
    if (!hit) return false;
  }
  return true;
}

function schedSorted(rows: Array<{ t: SchedulePanelTask; i: number }>, fs: FilterBarState): Array<{ t: SchedulePanelTask; i: number }> {
  const sort = fs.sort || 'status';
  const desc = fs.dir === 'desc';
  if (sort === 'status') {
    return rows.slice().sort((a, b) => (a.i - b.i) * (desc ? -1 : 1));
  }
  const key =
    sort === 'next'
      ? (r: { t: SchedulePanelTask; i: number }): number | undefined => r.t.nextAt
      : sort === 'last'
        ? (r: { t: SchedulePanelTask; i: number }): number | undefined => (r.t.last ? r.t.last.at : undefined)
        : (r: { t: SchedulePanelTask; i: number }): number | undefined => r.t.createdAt;
  const valued: Array<{ t: SchedulePanelTask; i: number }> = [];
  const missing: Array<{ t: SchedulePanelTask; i: number }> = [];
  for (const r of rows) (key(r) === undefined ? missing : valued).push(r);
  valued.sort((a, b) => {
    const d = (key(a) ?? 0) - (key(b) ?? 0);
    return d ? (desc ? -d : d) : a.i - b.i;
  });
  return valued.concat(missing);
}

function schedRowLine(t: SchedulePanelTask, taskState: string, deps: SchedulesPanelDeps): string {
  const bits: string[] = [];
  if (t.running) bits.push('<span class="sched-next">running now</span>');
  else if (taskState === 'active' && t.nextAt) {
    bits.push('<span class="sched-next">' + deps.text(schedIn(t.nextAt, deps.stLeft)) + '</span>');
  } else if (taskState !== 'active') bits.push('<span class="sched-next">' + deps.text(taskState) + '</span>');
  bits.push('<span class="sched-target">' + deps.text('\u2192 ' + schedTargetShort(t, deps)) + '</span>');
  const last = schedLastShort(t, deps.schedAgo);
  if (last) {
    bits.push('<span class="sched-last' + (t.last && t.last.status !== 'ok' ? ' bad' : '') + '">' + deps.text(last) + '</span>');
  }
  for (const tag of schedTags(t)) bits.push('<span class="sched-row-tag">#' + deps.text(tag) + '</span>');
  return '<span class="topic-dir sched-line">' + bits.join(' \u00b7 ') + '</span>';
}

function schedRowTitle(t: SchedulePanelTask, deps: SchedulesPanelDeps): string {
  const bits: string[] = [];
  if (t.when) bits.push(t.when);
  if (t.next) bits.push('next ' + t.next);
  bits.push(schedTarget(t, deps));
  const last = schedLast(t, deps.schedAgo);
  if (last) bits.push(last);
  if (t.run) bits.push(t.run);
  return bits.join(' \u00b7 ');
}

function schedCard(t: SchedulePanelTask, deps: SchedulesPanelDeps): string {
  const taskState = t.state || 'active';
  let h = '<div class="sched-item ' + deps.text(taskState) + (t.running ? ' running' : '') + '" data-id="' + deps.text(t.id) + '">';
  h += deps.rowHtml({
    cls: (t.running ? 'running ' : '') + (taskState === 'active' ? '' : 'idle ') + 'sched-row',
    attrs: ' role="button" tabindex="0" title="' + deps.text(schedRowTitle(t, deps)) + '"',
    key: 'task:' + t.id,
    dot: schedDot(t, taskState),
    title: '<span class="topic-title">' + deps.text(t.name) + '</span>',
    sub: schedRowLine(t, taskState, deps),
    moreTitle: 'Task actions',
  });
  return h + '</div>';
}

function paintSchedTasks(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (state.tasks === null) {
    deps.schedList.innerHTML = '<div class="sched-empty">Loading\u2026</div>';
    if (state.filter) state.filter.setCounts(0, 0);
    deps.rowMenuFollow();
    return;
  }
  const fs = state.filter ? state.filter.state() : { q: '', sel: {}, sort: 'status', dir: 'asc' };
  const words = fs.q.trim() ? fs.q.trim().toLowerCase().split(/\s+/) : [];
  const rows: Array<{ t: SchedulePanelTask; i: number }> = [];
  const total = state.tasks.length;
  for (let i = 0; i < total; i++) {
    const task = state.tasks[i];
    if (task && schedMatch(task, words, fs.sel, deps)) rows.push({ t: task, i });
  }
  const sorted = schedSorted(rows, fs);
  if (!total) {
    deps.schedList.innerHTML =
      '<div class="sched-empty">' +
      (state.enabled
        ? 'No scheduled tasks yet. Add one with + above, or ask an agent in a topic \u2014 for example \u201cevery morning at 8, summarise the CI failures\u201d \u2014 and it will be registered here.'
        : 'Scheduled tasks are not enabled in this daemon.') +
      '</div>';
  } else if (!sorted.length) {
    deps.schedList.innerHTML =
      '<div class="sched-empty sched-none">No matching tasks<button type="button" class="fb-clear" data-sched-clear="1">Clear</button></div>';
  } else {
    let h = '';
    for (const r of sorted) h += schedCard(r.t, deps);
    deps.schedList.innerHTML = h;
  }
  if (state.filter) state.filter.setCounts(sorted.length, total);
  deps.rowMenuFollow();
}

function paintSchedulesList(state: SchedulesState, deps: SchedulesPanelDeps, tasks: SchedulePanelTask[]): void {
  state.tasks = tasks || [];
  if (state.filter) state.filter.setGroups(schedFilterGroups(state.tasks));
  paintSchedTasks(state, deps);
  paintSchedCounts(state, deps);
  paintSummary(state, deps);
  taskPageFollow(state, deps);
}

function taskSay(deps: SchedulesPanelDeps, msg: string | null, kind?: string): void {
  if (!msg) {
    deps.taskNote.hidden = true;
    deps.taskNote.textContent = '';
    return;
  }
  deps.taskNote.hidden = false;
  deps.taskNote.className = kind || '';
  deps.taskNote.textContent = msg;
}

function schedOp(
  state: SchedulesState,
  deps: SchedulesPanelDeps,
  id: string,
  action: SchedulePanelAction,
  btn?: HTMLButtonElement | null,
  tags?: string[],
  clearDraft?: boolean
): void {
  if (state.busy) return;
  state.busy = true;
  if (btn) btn.disabled = true;
  deps.schedNote.hidden = true;
  const onPage = !deps.taskPage.hidden && state.tp.id === id;
  if (onPage) taskSay(deps, null);
  const body = tags !== undefined ? { id, action, tags } : { id, action };
  const say = (msg: string): void => {
    if (onPage && !deps.taskPage.hidden && state.tp.id === id) taskSay(deps, msg, 'error');
    else showSchedNote(deps, msg);
  };
  fetch('api/schedules/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<ScheduleOpResponse>)
    .then((d) => {
      if (d && d.ok && d.tasks) {
        if (clearDraft) {
          const field = deps.taskView.querySelector<HTMLInputElement>('[data-tag-input]');
          if (field) field.value = '';
        }
        paintSchedulesList(state, deps, d.tasks);
      } else {
        say((d && d.error) || 'That did not work.');
      }
    })
    .catch((e: unknown) => {
      say('Could not reach the daemon: ' + errorMessage(e));
    })
    .then(() => {
      state.busy = false;
      if (btn) btn.disabled = false;
      armSched(state, deps);
    });
}

function tpEl<T extends HTMLElement>(deps: SchedulesPanelDeps, id: string): T | null {
  return deps.taskView.querySelector<T>('#' + id);
}

function tpVal(deps: SchedulesPanelDeps, id: string): string {
  const e = tpEl<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(deps, id);
  return e ? String(e.value) : '';
}

function taskZonesHtml(state: SchedulesState, text: (s: unknown) => string): string {
  if (state.zonesHtml === null) {
    let names: string[] = [];
    try {
      const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
      names = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
    } catch {
      names = [];
    }
    let html = '<datalist id="tp-tzs">';
    for (const name of names) html += '<option value="' + text(name) + '">';
    html += '</datalist>';
    state.zonesHtml = html;
  }
  return state.zonesHtml;
}

function taskDurText(ms: number): string {
  if (ms % 3600000 === 0) return ms / 3600000 + 'h';
  if (ms % 60000 === 0) return ms / 60000 + 'm';
  if (ms % 1000 === 0) return ms / 1000 + 's';
  return ms + 'ms';
}

function taskDurParse(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(s).trim());
  if (!m) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const factor = mult[unit];
  if (!factor) return null;
  return Math.round(parseFloat(m[1] || '0') * factor);
}

function taskPress(deps: SchedulesPanelDeps, attr: string, value: string): void {
  const seg = deps.taskView.querySelectorAll('[' + attr + ']');
  for (const el of seg) el.setAttribute('aria-pressed', el.getAttribute(attr) === value ? 'true' : 'false');
}

function taskPressed(deps: SchedulesPanelDeps, attr: string): string {
  const on = deps.taskView.querySelector('[' + attr + '][aria-pressed="true"]');
  return on ? on.getAttribute(attr) || '' : '';
}

function taskKind(deps: SchedulesPanelDeps): 'agent' | 'bash' {
  return taskPressed(deps, 'data-tp-kind') === 'bash' ? 'bash' : 'agent';
}

function taskShape(deps: SchedulesPanelDeps): SchedulePanelShape {
  if (taskKind(deps) === 'bash') return 'bash';
  const session = taskPressed(deps, 'data-tp-session');
  return session === 'daily' || session === 'fixed' ? session : 'new';
}

function taskWhenMode(deps: SchedulesPanelDeps): 'at' | 'cron' {
  const at = tpEl<HTMLInputElement>(deps, 'tp-at');
  return at && !at.hidden ? 'at' : 'cron';
}

function taskWhen(deps: SchedulesPanelDeps, once: boolean, focus: boolean): void {
  taskPress(deps, 'data-tp-when', once ? 'at' : 'cron');
  const cronEl = tpEl<HTMLInputElement>(deps, 'tp-cron');
  const atEl = tpEl<HTMLInputElement>(deps, 'tp-at');
  const hintEl = tpEl<HTMLElement>(deps, 'tp-when-hint');
  if (cronEl) cronEl.hidden = once;
  if (atEl) atEl.hidden = !once;
  if (hintEl) hintEl.textContent = once ? TP_AT_HINT : TP_CRON_HINT;
  if (focus) (once ? atEl : cronEl)?.focus();
}

function taskMachine(state: SchedulesState, deps: SchedulesPanelDeps): string {
  const d = state.tp.detail;
  const host = taskKind(deps) === 'bash' ? tpVal(deps, 'tp-host') : (d?.agentHosts[tpVal(deps, 'tp-agent')] || '');
  return host || 'the gateway\u2019s machine';
}

function sessionHintText(shape: SchedulePanelShape): string {
  if (shape === 'fixed') {
    return 'Each run is a turn in the topic it posts to, for 24 hours from when it starts there. Its directory and model are that topic\u2019s \u2014 /cd and /model there change them.';
  }
  if (shape === 'daily') {
    return 'The first run of each day opens a topic; the rest of that day\u2019s runs join it. Needs a repeating time.';
  }
  return 'Each run is a fresh session in a topic of its own.';
}

function targetHintText(other: boolean, shape: SchedulePanelShape): string {
  if (other) return 'An id as fleetherd channels prints it: <instance>:<chat>[/<thread>].';
  if (shape === 'bash') return 'The command\u2019s output is posted there.';
  if (shape === 'fixed') return 'The runs are turns there.';
  return 'Each run\u2019s topic is opened from there, and failures are reported there.';
}

function taskShapePaint(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const d = state.tp.detail;
  if (!d) return;
  const shape = taskShape(deps);
  const keeps: SchedulePanelSetting[] = d.shapes[shape] || [];
  const kind = taskKind(deps);
  for (const el of deps.taskView.querySelectorAll<HTMLElement>('[data-tp-need]')) {
    const need = el.getAttribute('data-tp-need') as SchedulePanelSetting | null;
    el.hidden = !need || keeps.indexOf(need) < 0;
  }
  for (const el of deps.taskView.querySelectorAll<HTMLElement>('[data-tp-kinded]')) {
    el.hidden = el.getAttribute('data-tp-kinded') !== kind;
  }
  const textLabel = tpEl<HTMLElement>(deps, 'tp-text-label');
  if (textLabel) textLabel.textContent = kind === 'bash' ? 'Command' : 'Prompt';
  if (keeps.indexOf('at') < 0 && taskWhenMode(deps) === 'at') taskWhen(deps, false, false);
  const sh = tpEl<HTMLElement>(deps, 'tp-session-hint');
  if (sh) sh.textContent = sessionHintText(shape);
  const ch = tpEl<HTMLElement>(deps, 'tp-cwd-hint');
  if (ch) ch.textContent = 'An absolute path on ' + taskMachine(state, deps) + '; it is checked there before saving. Empty: the default directory.';
  const other = tpVal(deps, 'tp-target') === 'other';
  const targetOther = tpEl<HTMLInputElement>(deps, 'tp-target-other');
  if (targetOther) targetOther.hidden = !other;
  const targetHint = tpEl<HTMLElement>(deps, 'tp-target-hint');
  if (targetHint) targetHint.textContent = targetHintText(other, shape);
}

function taskTargetOptions(d: TaskPageDetail, deps: SchedulesPanelDeps): string {
  const own = d.task ? d.task.targetTopic : '';
  let h = '';
  for (const t of deps.getTopics()) {
    if ((t.scheduled || t.parent) && t.id !== own) continue;
    h += '<option value="topic:' + deps.text(t.id) + '">' + deps.text(deps.splitTitle(t.title || 'Untitled').rest) + '</option>';
  }
  return h + '<option value="other">Another chat\u2026</option>';
}

function taskFormScheduleHtml(state: SchedulesState, d: TaskPageDetail, deps: SchedulesPanelDeps): string {
  const once = d.fields.at !== undefined;
  let h =
    '<div class="tp-label">When</div>' +
    '<div class="skill-seg tp-when" role="group" aria-label="Repeats or once" data-tp-need="at">' +
    '<button type="button" data-tp-when="cron" aria-pressed="' +
    (once ? 'false' : 'true') +
    '">Repeats</button>' +
    '<button type="button" data-tp-when="at" aria-pressed="' +
    (once ? 'true' : 'false') +
    '">Once</button></div>' +
    '<div class="tp-row2"><div>' +
    '<input id="tp-cron" class="skill-field tp-mono" type="text" placeholder="0 8 * * *" aria-label="Cron expression" autocomplete="off" spellcheck="false"' +
    (once ? ' hidden' : '') +
    '>' +
    '<input id="tp-at" class="skill-field" type="datetime-local" step="1" aria-label="Time of the run"' +
    (once ? '' : ' hidden') +
    '>' +
    '</div><div><input id="tp-tz" class="skill-field" type="text" list="tp-tzs" aria-label="Time zone" autocomplete="off" spellcheck="false">' +
    taskZonesHtml(state, deps.text) +
    '</div></div>' +
    '<div class="tp-hint" id="tp-when-hint">' +
    (once ? TP_AT_HINT : TP_CRON_HINT) +
    '</div>' +
    '<label class="tp-label" for="tp-target">Posts to</label><select id="tp-target" class="skill-field">' +
    taskTargetOptions(d, deps) +
    '</select>' +
    '<input id="tp-target-other" class="skill-field tp-mono" type="text" list="tp-chans" placeholder="tg:-1001234567/8" aria-label="Another chat, as fleetherd channels lists it" autocomplete="off" spellcheck="false" hidden>' +
    '<datalist id="tp-chans">';
  for (const ch of d.channels) h += '<option value="' + deps.text(ch.id) + '">' + deps.text(ch.title) + '</option>';
  h +=
    '</datalist><div class="tp-hint" id="tp-target-hint"></div>' +
    '<label class="tp-label" for="tp-tags">Tags</label><input id="tp-tags" class="skill-field" type="text" placeholder="ci, ops" autocomplete="off" spellcheck="false"><div class="tp-hint">Comma-separated: up to 5, letters, digits and - _ . /</div>';
  return h;
}

function taskFormHtml(state: SchedulesState, d: TaskPageDetail, deps: SchedulesPanelDeps): string {
  const { text } = deps;
  const f = d.fields;
  const isNew = state.tp.mode === 'new';
  let h =
    '<form id="tp-form" novalidate>' +
    '<label class="tp-label" for="tp-name">Name</label><input id="tp-name" class="skill-field" type="text" autocomplete="off" spellcheck="false"' +
    (isNew ? ' placeholder="from the prompt or command"' : '') +
    '>' +
    '<div class="tp-label">Runs</div><div class="skill-seg tp-seg" role="group" aria-label="What it runs">' +
    '<button type="button" data-tp-kind="agent" aria-pressed="false">Agent prompt</button>' +
    '<button type="button" data-tp-kind="bash" aria-pressed="false">Bash command</button></div>';
  if (!isNew) {
    h += '<div class="tp-hint">Changing what a task is, how it runs or where it posts keeps its id, tags and run history.</div>';
  }
  h +=
    '<label class="tp-label" for="tp-text" id="tp-text-label">Prompt</label><textarea id="tp-text" class="tp-text" spellcheck="false"></textarea>' +
    '<div class="tp-hint" data-tp-need="host">Run with bash -lc on the machine below.</div>' +
    '<div data-tp-kinded="agent"><div class="tp-label">Session</div><div class="skill-seg tp-seg" role="group" aria-label="Session">' +
    '<button type="button" data-tp-session="new" aria-pressed="false">New each run</button>' +
    '<button type="button" data-tp-session="daily" aria-pressed="false">One a day</button>' +
    '<button type="button" data-tp-session="fixed" aria-pressed="false">In its topic</button></div>' +
    '<div class="tp-hint" id="tp-session-hint"></div></div>';
  const agents = d.agents.slice();
  if (f.agent && agents.indexOf(f.agent) < 0) agents.unshift(f.agent);
  h += '<div data-tp-need="agent"><label class="tp-label" for="tp-agent">Agent</label><select id="tp-agent" class="skill-field">';
  for (const ag of agents) {
    h += '<option value="' + text(ag) + '">' + text(ag) + (d.agentHosts[ag] ? ' \u00b7 ' + text(d.agentHosts[ag]) : '') + '</option>';
  }
  h +=
    '</select></div>' +
    '<div data-tp-need="model"><label class="tp-label" for="tp-model">Model</label><input id="tp-model" class="skill-field" type="text" placeholder="the agent\u2019s own" autocomplete="off" spellcheck="false"><div class="tp-hint">An id the agent\u2019s /model list offers. Empty: the model the agent starts with.</div></div>' +
    '<div data-tp-need="host"><label class="tp-label" for="tp-host">Machine</label><select id="tp-host" class="skill-field"><option value="">The gateway\u2019s machine</option>';
  for (const host of d.hosts) h += '<option value="' + text(host) + '">' + text(host) + '</option>';
  h +=
    '</select></div>' +
    '<div data-tp-need="cwd"><label class="tp-label" for="tp-cwd">Directory</label><input id="tp-cwd" class="skill-field tp-mono" type="text" placeholder="the default directory" autocomplete="off" spellcheck="false"><div class="tp-hint" id="tp-cwd-hint"></div></div>' +
    '<div data-tp-need="timeout"><label class="tp-label" for="tp-timeout">Timeout</label><input id="tp-timeout" class="skill-field" type="text" placeholder="10m" autocomplete="off" spellcheck="false"><div class="tp-hint">How long a run may take: 90s, 10m, 1h \u2014 at most 6h.</div></div>';
  h += taskFormScheduleHtml(state, d, deps);
  h +=
    '<div class="tp-acts editor"><button type="submit" class="primary" data-tp-act="save">' +
    (isNew ? 'Add' : 'Save') +
    '</button><button type="button" data-tp-act="cancel">Cancel</button></div></form>';
  return h;
}

function taskTargetStart(d: TaskPageDetail, deps: SchedulesPanelDeps): string {
  if (d.task) return d.task.targetTopic && deps.topicById(d.task.targetTopic) ? 'topic:' + d.task.targetTopic : 'other';
  const cur = deps.getTopic();
  if (cur && deps.topicById(cur)) return 'topic:' + cur;
  const sel = tpEl<HTMLSelectElement>(deps, 'tp-target');
  return sel && sel.options.length > 1 ? sel.options[0]?.value || 'other' : 'other';
}

function setTpField(deps: SchedulesPanelDeps, id: string, v: string | undefined | null): void {
  const e = tpEl<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(deps, id);
  if (e) e.value = v == null ? '' : v;
}

function fillTaskForm(state: SchedulesState, d: TaskPageDetail, deps: SchedulesPanelDeps): void {
  const f = d.fields;
  const isBash = f.command !== undefined;
  setTpField(deps, 'tp-name', f.name);
  setTpField(deps, 'tp-cron', f.cron);
  setTpField(deps, 'tp-at', f.at ? f.at.replace(' ', 'T') : '');
  setTpField(deps, 'tp-tz', f.tz);
  setTpField(deps, 'tp-text', isBash ? f.command : f.prompt);
  setTpField(deps, 'tp-agent', f.agent || d.agent);
  setTpField(deps, 'tp-model', f.model);
  setTpField(deps, 'tp-host', f.host || (f.agent ? d.agentHosts[f.agent] : ''));
  setTpField(deps, 'tp-cwd', f.cwd);
  if (f.timeoutMs) setTpField(deps, 'tp-timeout', taskDurText(f.timeoutMs));
  setTpField(deps, 'tp-tags', (d.task?.tags ?? []).join(', '));
  const start = taskTargetStart(d, deps);
  setTpField(deps, 'tp-target', start);
  if (start === 'other' && f.target) setTpField(deps, 'tp-target-other', f.target);
  taskPress(deps, 'data-tp-kind', isBash ? 'bash' : 'agent');
  taskPress(deps, 'data-tp-session', f.session || 'new');
  taskShapePaint(state, deps);
  tpEl<HTMLInputElement>(deps, 'tp-name')?.focus();
}

function taskTargetValue(deps: SchedulesPanelDeps): ScheduleTargetRequest | null {
  const v = tpVal(deps, 'tp-target');
  if (v.indexOf('topic:') === 0) return { topic: v.slice(6) };
  const id = tpVal(deps, 'tp-target-other').trim();
  return id ? { channel: id } : null;
}

function taskTagList(raw: string): string[] {
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function diffWhen(
  deps: SchedulesPanelDeps,
  f: SchedulePanelTaskDetail['fields'],
  isNew: boolean,
  out: TaskEditPayload
): string | null {
  const tz = tpVal(deps, 'tp-tz').trim();
  if (isNew || tz !== f.tz) out.tz = tz;
  if (taskWhenMode(deps) === 'at') {
    const v = tpVal(deps, 'tp-at').replace('T', ' ');
    if (!v) return 'Pick a date and time for the run.';
    if (isNew || f.at === undefined || v !== f.at || out.tz !== undefined) out.at = v;
  } else {
    const v = tpVal(deps, 'tp-cron').trim();
    if (isNew || f.cron === undefined || v !== f.cron) out.cron = v;
  }
  return null;
}

function diffNullableField(
  val: string,
  prev: string | undefined,
  isNew: boolean,
  forceSend: boolean
): { send: boolean; value: string | null } {
  const changed = forceSend || (isNew ? Boolean(val) : val !== (prev || ''));
  return { send: changed, value: val || null };
}

function diffTimeoutField(
  deps: SchedulesPanelDeps,
  prevMs: number | undefined,
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload
): string | null {
  const raw = tpVal(deps, 'tp-timeout').trim();
  if (!raw) return null;
  const ms = taskDurParse(raw);
  if (ms === null || ms <= 0) return 'The timeout is a length of time: 90s, 10m or 1h.';
  if (isNew || turned || ms !== prevMs) out.timeoutMs = ms;
  return null;
}

function diffShapeFields(
  deps: SchedulesPanelDeps,
  f: SchedulePanelTaskDetail['fields'],
  keeps: readonly SchedulePanelSetting[],
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload
): string | null {
  const shown = (k: SchedulePanelSetting): boolean => keeps.indexOf(k) >= 0;
  if (shown('agent')) {
    const v = tpVal(deps, 'tp-agent');
    if (v && (isNew || turned || v !== f.agent)) out.agent = v;
  }
  if (shown('model')) {
    const res = diffNullableField(tpVal(deps, 'tp-model').trim(), f.model, isNew, false);
    if (res.send) out.model = res.value;
  }
  if (shown('host')) {
    const res = diffNullableField(tpVal(deps, 'tp-host'), f.host, isNew, isNew || turned);
    if (res.send) out.host = res.value;
  }
  if (shown('cwd')) {
    const res = diffNullableField(tpVal(deps, 'tp-cwd').trim(), f.cwd, isNew, false);
    if (res.send) out.cwd = res.value;
  }
  if (shown('timeout')) return diffTimeoutField(deps, f.timeoutMs, isNew, turned, out);
  return null;
}

function diffBodyAndSession(
  deps: SchedulesPanelDeps,
  f: SchedulePanelTaskDetail['fields'],
  kind: 'agent' | 'bash',
  shape: SchedulePanelShape,
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload
): void {
  const bodyText = tpVal(deps, 'tp-text');
  if (kind === 'bash') {
    if (isNew || turned || bodyText !== f.command) out.command = bodyText;
    return;
  }
  if (isNew || turned || bodyText !== f.prompt) out.prompt = bodyText;
  const session = shape === 'daily' || shape === 'fixed' ? shape : 'new';
  if (isNew || turned || session !== f.session) out.session = session;
}

function diffTargetAndTags(
  deps: SchedulesPanelDeps,
  d: TaskPageDetail,
  isNew: boolean,
  out: TaskEditPayload
): string | null {
  const target = taskTargetValue(deps);
  if (!target) return 'Say where it posts: pick a topic, or give an id fleetherd channels lists.';
  const own = d.task?.targetTopic && deps.topicById(d.task.targetTopic) ? d.task.targetTopic : '';
  const targetChanged = 'topic' in target ? target.topic !== own : target.channel !== d.fields.target;
  if (isNew || targetChanged) out.target = target;
  const tags = taskTagList(tpVal(deps, 'tp-tags'));
  const had = d.task?.tags ?? [];
  if (isNew ? tags.length : tags.join(',') !== had.join(',')) out.tags = tags;
  return null;
}

function taskEditDiff(
  state: SchedulesState,
  deps: SchedulesPanelDeps
): { error: string } | { edit: TaskEditPayload } {
  const d = state.tp.detail;
  if (!d) return { edit: {} };
  const f = d.fields;
  const out: TaskEditPayload = {};
  const isNew = state.tp.mode === 'new';
  const kind = taskKind(deps);
  const shape = taskShape(deps);
  const keeps = d.shapes[shape] || [];
  const turned = !isNew && kind !== (f.command !== undefined ? 'bash' : 'agent');

  const name = tpVal(deps, 'tp-name').trim();
  if (isNew ? name : name !== f.name) out.name = name;

  const whenErr = diffWhen(deps, f, isNew, out);
  if (whenErr) return { error: whenErr };

  diffBodyAndSession(deps, f, kind, shape, isNew, turned, out);
  const shapeErr = diffShapeFields(deps, f, keeps, isNew, turned, out);
  if (shapeErr) return { error: shapeErr };
  const tailErr = diffTargetAndTags(deps, d, isNew, out);
  if (tailErr) return { error: tailErr };
  return { edit: out };
}

function taskDirty(state: SchedulesState, deps: SchedulesPanelDeps): boolean {
  if (!tpEl(deps, 'tp-form')) return false;
  if (state.tp.mode === 'new') {
    return Boolean(
      tpVal(deps, 'tp-name').trim() ||
        tpVal(deps, 'tp-text').trim() ||
        tpVal(deps, 'tp-cron').trim() ||
        tpVal(deps, 'tp-tags').trim()
    );
  }
  const diff = taskEditDiff(state, deps);
  return 'error' in diff || Object.keys(diff.edit).length > 0;
}

function taskDiscardText(state: SchedulesState): string {
  return state.tp.mode === 'new' ? 'Discard this new task?' : 'Discard your changes to this task?';
}

function taskFact(label: string, value: string, text: (s: unknown) => string, mono?: boolean): string {
  return '<div><div class="tp-label">' + text(label) + '</div><div class="tp-val' + (mono ? ' tp-mono' : '') + '">' + value + '</div></div>';
}

function taskSessions(d: SchedulePanelTaskDetail, deps: SchedulesPanelDeps): Topic[] {
  const named: Record<string, boolean> = {};
  for (const r of d.runs) if (r.topic) named[r.topic] = true;
  const out: Topic[] = [];
  for (const t of deps.getTopics()) {
    if (t.task === d.task.id || named[t.id]) out.push(t);
  }
  return out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function taskSessionRow(t: Topic, deps: SchedulesPanelDeps): string {
  const running = deps.rowRunning(t);
  const asking = Boolean(t.asking);
  const unread = deps.unreadOf(t);
  const count = t.msgCount || 0;
  const dot =
    'topic-dot' + (asking ? ' asking' : running ? ' running' : t.stage === 'failed' ? ' failed' : t.stage === 'review' ? ' review' : '');
  const stateLabel = asking ? 'awaiting you' : running ? 'running' : t.stage === 'failed' ? 'failed' : '';
  const when = t.lastAt
    ? '<span class="topic-age" data-age="' +
      deps.text(t.lastAt) +
      '" data-age-run="0" title="' +
      deps.text(deps.ageClock(t.lastAt)) +
      '">' +
      deps.text(deps.ageText(Date.now() - t.lastAt, true)) +
      '</span>'
    : '';
  return (
    '<div class="topic-item tp-sess framed' +
    (t.id === deps.getTopic() ? ' on' : '') +
    (running ? ' running' : ' idle') +
    '" data-tp-topic="' +
    deps.text(t.id) +
    '" role="button" tabindex="0">' +
    deps.agentTagHtml(t) +
    '<span class="' +
    dot +
    '"></span>' +
    '<span class="topic-main"><span class="topic-title">' +
    deps.text(deps.splitTitle(t.title || 'Untitled').rest) +
    '</span>' +
    '<span class="topic-sub"><span class="topic-dir">' +
    when +
    (count ? ' \u00b7 ' + count + ' message' + (count === 1 ? '' : 's') : '') +
    (stateLabel ? ' \u00b7 ' + stateLabel : '') +
    '</span></span></span>' +
    (unread > 0 ? '<span class="topic-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
    '</div>'
  );
}

function taskSessionsHtml(d: SchedulePanelTaskDetail, deps: SchedulesPanelDeps): string {
  const list = taskSessions(d, deps);
  let h = '<div class="tp-label">Sessions<span class="tp-n">' + list.length + '</span></div><div class="tp-list tp-topics">';
  if (!list.length) {
    h +=
      '<div class="tp-empty">' +
      (d.task.kind === 'bash'
        ? 'A bash task runs without a conversation; its output is posted where it posts.'
        : 'None on this page yet. Each run that opens a topic lists it here.') +
      '</div>';
  }
  for (const t of list) h += taskSessionRow(t, deps);
  return h + '</div>';
}

function taskRunRow(r: SchedulePanelRun, deps: SchedulesPanelDeps): string {
  const word = RUN_STATUS_WORD[r.status] || r.status;
  const bits = [deps.text(r.atText)];
  if (r.durationMs != null) bits.push(deps.text(schedDur(r.durationMs)));
  if (r.exitCode != null) bits.push('exit ' + deps.text(r.exitCode));
  let where = '';
  if (r.topic) {
    const t = deps.topicById(r.topic);
    where = t
      ? '<button type="button" class="tp-run-open" data-tp-topic="' +
        deps.text(r.topic) +
        '" title="' +
        deps.text(t.title || '') +
        '">Open</button>'
      : '<span class="tp-run-where" title="The topic this run used is no longer on this page">topic gone</span>';
  } else if (r.where) {
    where = '<span class="tp-run-where" title="' + deps.text(r.where) + '">' + deps.text(r.where) + '</span>';
  }
  return (
    '<div class="tp-run"><span class="topic-dot' +
    (r.status === 'ok' ? '' : ' failed') +
    '"></span>' +
    '<span class="tp-run-main"><span class="tp-run-head"><span class="tp-run-status' +
    (r.status === 'ok' ? '' : ' bad') +
    '">' +
    deps.text(word) +
    '</span> \u00b7 ' +
    bits.join(' \u00b7 ') +
    '</span>' +
    (r.error ? '<span class="tp-run-err">' + deps.text(r.error) + '</span>' : '') +
    '</span>' +
    where +
    '</div>'
  );
}

function taskActionButtonsHtml(d: SchedulePanelTaskDetail, ic: Record<string, string>): string {
  const t = d.task;
  const taskState = t.state || 'active';
  const busyNote = ' disabled title="A run is in progress \u2014 wait for it to finish"';
  let h = '<div class="tp-acts">';
  if (!d.locked) h += '<button type="button" data-tp-act="edit"' + (t.running ? busyNote : '') + '>' + (ic.pencil || '') + 'Edit</button>';
  if (taskState === 'active') h += '<button type="button" data-tp-act="pause">' + (ic.pause || '') + 'Pause</button>';
  if (taskState === 'paused') h += '<button type="button" data-tp-act="resume">' + (ic.play || '') + 'Resume</button>';
  if (taskState === 'active' || taskState === 'paused') {
    h += '<button type="button" data-tp-act="run"' + (t.running ? busyNote : '') + '>' + (ic.clock || '') + 'Run now</button>';
  }
  return h + '<button type="button" class="danger" data-tp-act="remove">' + (ic.trash || '') + 'Delete</button></div>';
}

function taskTagsHtml(t: SchedulePanelTask, ic: Record<string, string>, text: (s: unknown) => string): string {
  let h = '<div class="tp-label">Tags</div><div class="sched-tag-edit">';
  for (const tag of schedTags(t)) {
    h +=
      '<span class="sched-tag">' +
      (ic.tag || '') +
      '<span>' +
      text(tag) +
      '</span><button type="button" class="sched-tag-x" data-tag-del="' +
      text(tag) +
      '" title="Remove ' +
      text(tag) +
      '" aria-label="Remove ' +
      text(tag) +
      '">' +
      (ic.cross || '') +
      '</button></span>';
  }
  return (
    h +
    '<span class="sched-tag-add">' +
    (ic.plus || '') +
    '<input type="text" data-tag-input placeholder="tag" aria-label="Add a tag" autocomplete="off" spellcheck="false"></span></div>'
  );
}

function taskViewHtml(d: SchedulePanelTaskDetail, deps: SchedulesPanelDeps): string {
  const { text } = deps;
  const ic = deps.icons();
  const t = d.task;
  const f = d.fields;
  let h = taskActionButtonsHtml(d, ic);
  if (d.locked) h += '<div class="tp-locked">' + text(d.locked) + '</div>';
  h += '<div class="tp-grid">';
  h += taskFact('Schedule', text(t.when) + (t.next ? ' \u00b7 next ' + text(t.next) : ''), text, true);
  h += taskFact('Runs as', text(t.run), text);
  if (f.cwd) h += taskFact('Directory', text(f.cwd), text, true);
  h += taskFact('Posts to', text(schedTargetShort(t, deps)), text);
  h += '</div>';
  h += '<div class="tp-label">' + (t.kind === 'bash' ? 'Command' : 'Prompt') + '</div><div class="tp-body">' + text(t.detail) + '</div>';
  h += taskTagsHtml(t, ic, text);
  let meta =
    '#' +
    t.id +
    ' \u00b7 ' +
    t.runs +
    (t.runs === 1 ? ' run' : ' runs') +
    (t.createdAt ? ' \u00b7 created ' + deps.ageClock(t.createdAt) : '');
  if (t.expires) meta += ' \u00b7 until ' + t.expires;
  h += '<div class="tp-meta">' + text(meta) + '</div>';
  h += '<div id="tp-sessions">' + taskSessionsHtml(d, deps) + '</div>';
  h += '<div class="tp-label">Runs<span class="tp-n">' + d.runs.length + '</span></div><div class="tp-list">';
  if (!d.runs.length) h += '<div class="tp-empty">No runs yet.</div>';
  for (const r of d.runs) h += taskRunRow(r, deps);
  return h + '</div>';
}

function paintTaskHead(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const t = state.tp.detail?.task || schedTask(state, state.tp.id);
  if (state.tp.mode === 'new') {
    deps.taskTitle.textContent = 'New task';
    deps.taskSub.textContent = '';
    deps.taskSub.title = '';
    return;
  }
  deps.taskTitle.textContent = t ? t.name : 'Task';
  const bits: string[] = [];
  if (t) {
    const taskState = t.state || 'active';
    if (t.running) bits.push('running now');
    else if (taskState === 'active' && t.nextAt) bits.push('next ' + (t.next || '') + ' (' + schedIn(t.nextAt, deps.stLeft) + ')');
    else bits.push(taskState);
    const last = schedLast(t, deps.schedAgo);
    if (last) bits.push(last);
  }
  deps.taskSub.textContent = bits.join(' \u00b7 ');
  deps.taskSub.title = deps.taskSub.textContent;
}

function paintTaskPage(state: SchedulesState, deps: SchedulesPanelDeps): void {
  paintTaskHead(state, deps);
  const d = state.tp.detail;
  if (!d) {
    deps.taskView.innerHTML = '<div class="tp-empty">Loading\u2026</div>';
    return;
  }
  if (state.tp.mode === 'new' || (state.tp.mode === 'edit' && !d.locked)) {
    deps.taskView.innerHTML = taskFormHtml(state, d, deps);
    fillTaskForm(state, d, deps);
    return;
  }
  if (!d.task) return;
  state.tp.mode = 'view';
  deps.taskView.innerHTML = taskViewHtml(d as SchedulePanelTaskDetail, deps);
  deps.armAgeTick();
}

function closeTaskPage(state: SchedulesState, deps: SchedulesPanelDeps, force?: boolean): boolean {
  if (deps.taskPage.hidden) return true;
  if (!force && (state.tp.mode === 'edit' || state.tp.mode === 'new') && state.tp.detail && taskDirty(state, deps)) {
    if (!confirm(taskDiscardText(state))) return false;
  }
  deps.taskPage.hidden = true;
  state.tp.id = null;
  state.tp.detail = null;
  state.tp.mode = 'view';
  state.tp.seq++;
  return true;
}

function loadTaskPage(state: SchedulesState, deps: SchedulesPanelDeps): void {
  const id = state.tp.id;
  if (!id) return;
  const seq = ++state.tp.seq;
  fetch('api/schedules/task?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<ScheduleDetailResponse>)
    .then((d) => {
      if (seq !== state.tp.seq || state.tp.id !== id || deps.taskPage.hidden) return;
      if (d && d.ok && d.detail) {
        const row = schedTask(state, id);
        if (row) d.detail.task = row;
        const form = state.tp.mode === 'edit' && deps.taskView.querySelector('#tp-form');
        state.tp.detail = d.detail;
        if (form) paintTaskHead(state, deps);
        else paintTaskPage(state, deps);
      } else {
        taskSay(deps, (d && d.error) || 'Could not load this task.', 'error');
        if (!state.tp.detail) deps.taskView.innerHTML = '';
      }
    })
    .catch((e: unknown) => {
      if (seq !== state.tp.seq) return;
      taskSay(deps, 'Could not reach the daemon: ' + errorMessage(e), 'error');
      if (!state.tp.detail) deps.taskView.innerHTML = '';
    });
}

function openTaskPage(state: SchedulesState, deps: SchedulesPanelDeps, id: string | null, edit?: boolean): void {
  if (!id) return;
  const same = state.tp.id === id && !deps.taskPage.hidden;
  if (same && state.tp.mode === 'edit' && !edit) return;
  state.tp.id = id;
  state.tp.mode = edit ? 'edit' : 'view';
  if (!same) state.tp.detail = null;
  taskSay(deps, null);
  deps.taskPage.hidden = false;
  paintTaskPage(state, deps);
  loadTaskPage(state, deps);
  deps.taskClose.focus();
}

function taskMoved(t: SchedulePanelTask, was: SchedulePanelTask): boolean {
  return (
    t.runs !== was.runs ||
    Boolean(t.running) !== Boolean(was.running) ||
    t.state !== was.state ||
    (t.last ? t.last.at : 0) !== (was.last ? was.last.at : 0)
  );
}

function taskPageFollow(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (deps.taskPage.hidden || !state.tp.id || state.tasks === null) return;
  const t = schedTask(state, state.tp.id);
  if (!t) {
    closeTaskPage(state, deps, true);
    return;
  }
  const d = state.tp.detail;
  if (!d || !d.task) return;
  const moved = taskMoved(t, d.task);
  d.task = t;
  paintTaskHead(state, deps);
  if (state.tp.mode === 'view') {
    const field = deps.taskView.querySelector<HTMLInputElement>('[data-tag-input]');
    if (!field || !field.value) {
      const focused = Boolean(field) && document.activeElement === field;
      paintTaskPage(state, deps);
      if (focused) deps.taskView.querySelector<HTMLInputElement>('[data-tag-input]')?.focus();
    }
  }
  if (moved) loadTaskPage(state, deps);
}

function taskPageTopics(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (deps.taskPage.hidden || !state.tp.detail || !state.tp.detail.task || state.tp.mode !== 'view') return;
  const host = deps.taskView.querySelector('#tp-sessions');
  if (host) host.innerHTML = taskSessionsHtml(state.tp.detail as SchedulePanelTaskDetail, deps);
}

function saveTaskEdit(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (state.tp.busy || !state.tp.detail) return;
  const isNew = state.tp.mode === 'new';
  const diff = taskEditDiff(state, deps);
  if ('error' in diff) {
    taskSay(deps, diff.error, 'error');
    return;
  }
  if (!isNew && !Object.keys(diff.edit).length) {
    state.tp.mode = 'view';
    paintTaskPage(state, deps);
    taskSay(deps, 'Nothing was changed.');
    return;
  }
  const id = state.tp.id;
  const seq = state.tp.seq;
  const btn = deps.taskView.querySelector<HTMLButtonElement>('[data-tp-act="save"]');
  const label = isNew ? 'Add' : 'Save';
  state.tp.busy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = isNew ? 'Adding\u2026' : 'Saving\u2026';
  }
  taskSay(deps, null);
  fetch(isNew ? 'api/schedules/add' : 'api/schedules/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(isNew ? { task: diff.edit } : { id, edit: diff.edit }),
    credentials: 'same-origin',
  })
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<ScheduleDetailResponse>)
    .then((d) => {
      if (deps.taskPage.hidden || (isNew ? state.tp.mode !== 'new' || state.tp.seq !== seq : state.tp.id !== id)) return;
      if (d && d.ok && d.detail) {
        state.tp.id = d.detail.task.id;
        state.tp.detail = d.detail;
        state.tp.mode = 'view';
        state.tp.seq++;
        paintTaskPage(state, deps);
        taskSay(
          deps,
          isNew
            ? 'Added. The conversation it posts to was sent the task.'
            : 'Saved. The conversation it posts to was sent the updated task.',
          'ok'
        );
        if (d.tasks) paintSchedulesList(state, deps, d.tasks);
      } else {
        taskSay(deps, (d && d.error) || 'That did not work.', 'error');
      }
    })
    .catch((e: unknown) => {
      if (isNew ? state.tp.mode === 'new' : state.tp.id === id) {
        taskSay(deps, 'Could not reach the daemon: ' + errorMessage(e), 'error');
      }
    })
    .then(() => {
      state.tp.busy = false;
      const again = deps.taskView.querySelector<HTMLButtonElement>('[data-tp-act="save"]');
      if (again) {
        again.disabled = false;
        again.textContent = label;
      }
    });
}

function newTaskDetail(form: SchedulePanelFormContext): TaskPageDetail {
  return {
    ...form,
    task: null,
    runs: [],
    fields: { name: '', tz: form.tz, prompt: '', agent: form.agent, session: 'new', target: '' },
  };
}

function openNewTask(state: SchedulesState, deps: SchedulesPanelDeps): void {
  if (!deps.taskPage.hidden && !closeTaskPage(state, deps, false)) return;
  state.tp.id = null;
  state.tp.mode = 'new';
  state.tp.detail = null;
  taskSay(deps, null);
  deps.taskPage.hidden = false;
  paintTaskPage(state, deps);
  const seq = ++state.tp.seq;
  fetch('api/schedules/form', { credentials: 'same-origin' })
    .then((r) => r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })) as Promise<ScheduleFormResponse>)
    .then((d) => {
      if (seq !== state.tp.seq || state.tp.mode !== 'new' || deps.taskPage.hidden) return;
      if (d && d.ok && d.form) {
        state.tp.detail = newTaskDetail(d.form);
        paintTaskPage(state, deps);
      } else {
        taskSay(deps, (d && d.error) || 'Could not open the form.', 'error');
        deps.taskView.innerHTML = '';
      }
    })
    .catch((e: unknown) => {
      if (seq !== state.tp.seq) return;
      taskSay(deps, 'Could not reach the daemon: ' + errorMessage(e), 'error');
      deps.taskView.innerHTML = '';
    });
  deps.taskClose.focus();
}

function handleTaskAct(state: SchedulesState, deps: SchedulesPanelDeps, act: HTMLButtonElement): void {
  const what = act.getAttribute('data-tp-act');
  const t = state.tp.detail ? state.tp.detail.task : null;
  if (what === 'edit') {
    state.tp.mode = 'edit';
    taskSay(deps, null);
    paintTaskPage(state, deps);
    return;
  }
  if (what === 'cancel') {
    if (taskDirty(state, deps) && !confirm(taskDiscardText(state))) return;
    if (state.tp.mode === 'new') {
      closeTaskPage(state, deps, true);
      return;
    }
    state.tp.mode = 'view';
    taskSay(deps, null);
    paintTaskPage(state, deps);
    return;
  }
  if (what === 'save' || !t) return;
  if (what === 'remove' && !confirm('Delete task "' + (t.name || t.id) + '"?')) return;
  if (what === 'pause' || what === 'resume' || what === 'run' || what === 'remove') {
    schedOp(state, deps, t.id, what, act);
  }
}

function bindTaskPageEvents(state: SchedulesState, deps: SchedulesPanelDeps): void {
  deps.taskClose.addEventListener('click', () => closeTaskPage(state, deps, false));
  deps.taskPage.addEventListener('click', (e) => {
    if (e.target === deps.taskPage) {
      closeTaskPage(state, deps, false);
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const go = target.closest('[data-tp-topic]');
    if (go) {
      const tid = go.getAttribute('data-tp-topic');
      if (tid && closeTaskPage(state, deps, false)) deps.switchTopic(tid);
      return;
    }
    const when = target.closest('[data-tp-when]');
    if (when) {
      taskWhen(deps, when.getAttribute('data-tp-when') === 'at', true);
      return;
    }
    const seg = target.closest('[data-tp-kind],[data-tp-session]');
    if (seg) {
      const attr = seg.hasAttribute('data-tp-kind') ? 'data-tp-kind' : 'data-tp-session';
      taskPress(deps, attr, seg.getAttribute(attr) || '');
      taskShapePaint(state, deps);
      return;
    }
    const del = target.closest('[data-tag-del]');
    if (del) {
      const tag = del.getAttribute('data-tag-del');
      const tagged = schedTask(state, state.tp.id);
      if (tagged && tag && state.tp.id) {
        schedOp(state, deps, state.tp.id, 'tags', null, schedTags(tagged).filter((x) => x !== tag));
      }
      return;
    }
    const act = target.closest<HTMLButtonElement>('[data-tp-act]');
    if (!act || act.disabled) return;
    handleTaskAct(state, deps, act);
  });
  deps.taskPage.addEventListener('submit', (e) => {
    e.preventDefault();
    saveTaskEdit(state, deps);
  });
  deps.taskPage.addEventListener('change', (e) => {
    const id = e.target instanceof Element ? e.target.id : '';
    if (id === 'tp-agent' || id === 'tp-host' || id === 'tp-target') taskShapePaint(state, deps);
  });
  deps.schedNewBtn.addEventListener('click', () => openNewTask(state, deps));
  deps.taskPage.addEventListener('keydown', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (e.key === 'Enter' && !e.isComposing) {
      const input = target.closest<HTMLInputElement>('[data-tag-input]');
      if (input) {
        e.preventDefault();
        const task = schedTask(state, state.tp.id);
        const added = taskTagList(input.value || '');
        if (task && added.length) schedOp(state, deps, task.id, 'tags', null, schedTags(task).concat(added), true);
        return;
      }
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = target.closest('.tp-sess');
    if (!row) return;
    e.preventDefault();
    const tid = row.getAttribute('data-tp-topic');
    if (tid && closeTaskPage(state, deps, false)) deps.switchTopic(tid);
  });
}

function bindSessionEvents(state: SchedulesState, deps: SchedulesPanelDeps): void {
  deps.schedReadBtn.addEventListener('click', () => {
    deps.markAllRead(schedMembers(deps), 'session', (msg) => showSchedNote(deps, msg));
  });
  deps.schedSessionList.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const head = target.closest('[data-sgroup]');
    if (head) {
      e.stopPropagation();
      if (head.getAttribute('data-slock') === '1') return;
      const key = head.getAttribute('data-sgroup');
      if (!key) return;
      state.sessGroups[key] = head.getAttribute('aria-expanded') !== 'true';
      saveSessGroups(state, deps);
      paintSessions(state, deps);
      deps.schedSessionList.querySelector<HTMLElement>('[data-sgroup="' + key + '"]')?.focus();
      return;
    }
    const more = target.closest('[data-rm]');
    if (more) {
      e.stopPropagation();
      if (deps.getRowMenuKey() && deps.getRowMenuKey() === more.getAttribute('data-rm') && !deps.rowMenu.hidden) {
        deps.closeRowMenu(true);
      } else {
        deps.openRowMenuFor(more);
      }
      return;
    }
    if (deps.foldClick(e)) return;
    const row = target.closest('[data-sess]');
    if (!row) return;
    const id = row.getAttribute('data-sess');
    if (!id || id === deps.getTopic()) return;
    deps.switchTopic(id);
  });
  deps.schedSessionList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('[data-rm],[data-fold]')) return;
    const row = target.closest('[data-sess]');
    if (!row) return;
    e.preventDefault();
    const id = row.getAttribute('data-sess');
    if (id && id !== deps.getTopic()) deps.switchTopic(id);
  });
}

function bindScheduleEvents(state: SchedulesState, deps: SchedulesPanelDeps): void {
  deps.schedToggle.addEventListener('click', () => setSchedules(deps, !deps.paneIsOpen()));
  deps.schedClose.addEventListener('click', () => setSchedules(deps, false));
  deps.schedTabScheduled.addEventListener('click', () => setSchedTab(state, deps, 'scheduled'));
  deps.schedTabReviews.addEventListener('click', () => setSchedTab(state, deps, 'reviews'));
  deps.schedTabTasks.addEventListener('click', () => setSchedSubtab(state, deps, 'tasks'));
  deps.schedTabSessions.addEventListener('click', () => setSchedSubtab(state, deps, 'sessions'));

  bindSessionEvents(state, deps);

  deps.schedList.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('[data-sched-clear]')) {
      e.stopPropagation();
      if (state.filter) state.filter.clear();
      return;
    }
    const more = target.closest('[data-rm]');
    if (more) {
      e.stopPropagation();
      if (deps.getRowMenuKey() && deps.getRowMenuKey() === more.getAttribute('data-rm') && !deps.rowMenu.hidden) {
        deps.closeRowMenu(true);
      } else {
        deps.openRowMenuFor(more);
      }
      return;
    }
    const card = target.closest('.sched-item');
    if (!card) return;
    openTaskPage(state, deps, card.getAttribute('data-id'), false);
  });
  deps.schedList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('[data-rm]')) return;
    const card = target.closest('.sched-item');
    if (!card) return;
    e.preventDefault();
    openTaskPage(state, deps, card.getAttribute('data-id'), false);
  });

  bindTaskPageEvents(state, deps);

  document.addEventListener('visibilitychange', () => {
    if (!deps.paneIsOpen()) return;
    if (document.visibilityState === 'hidden') {
      disarmSched(state);
    } else {
      loadSchedules(state, deps);
      if (state.tab === 'reviews') deps.loadReviews();
    }
  });
}

function readSavedSessGroups(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('aa_sched_groups') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // Ignore malformed storage.
  }
  return {};
}

function initSchedulesPanel(state: SchedulesState, deps: SchedulesPanelDeps): void {
  state.filter = deps.makeFilterBar({
    key: 'aa_sched_filter',
    placeholder: 'Search tasks',
    groups: [],
    sort: {
      options: [
        { value: 'status', label: 'Status' },
        { value: 'next', label: 'Next run' },
        { value: 'last', label: 'Last run' },
        { value: 'created', label: 'Created' },
      ],
      value: 'status',
      dir: 'asc',
    },
    onChange: () => paintSchedTasks(state, deps),
  });
  deps.schedFilterHost.appendChild(state.filter.el);
  state.filter.setGroups(null);

  try {
    const savedTab = localStorage.getItem('aa_sched_tab');
    if (savedTab === 'reviews') {
      state.tab = 'reviews';
    } else if (savedTab === 'sessions') {
      state.tab = 'scheduled';
      state.subtab = 'sessions';
    } else if (savedTab === 'tasks' || savedTab === 'scheduled') {
      state.tab = 'scheduled';
    }
    const savedSubtab = localStorage.getItem('aa_sched_subtab');
    if (savedSubtab === 'sessions' || savedSubtab === 'tasks') {
      state.subtab = savedSubtab;
    }
    paintSchedTab(state, deps);
  } catch {
    // Ignore storage errors.
  }

  let restoreSched = false;
  try {
    restoreSched = localStorage.getItem('aa_sched_open') === '1';
  } catch {
    restoreSched = false;
  }
  if (restoreSched && deps.paneDocked()) setSchedules(deps, true, true);
}

export function createSchedulesPanel(deps: SchedulesPanelDeps): SchedulesPanel {
  const state: SchedulesState = {
    enabled: true,
    tasks: null,
    busy: false,
    seq: 0,
    timer: 0,
    filter: null,
    tab: 'scheduled',
    subtab: 'tasks',
    sessGroups: readSavedSessGroups(),
    tp: { id: null, detail: null, mode: 'view', seq: 0, busy: false },
    zonesHtml: null,
  };
  bindScheduleEvents(state, deps);

  return {
    init: () => initSchedulesPanel(state, deps),
    setOpen: (open, transient) => setSchedules(deps, open, transient),
    onPanelOpen: () => {
      if (state.tasks === null) deps.schedList.innerHTML = '<div class="sched-empty">Loading\u2026</div>';
      loadSchedules(state, deps);
      if (state.tab === 'reviews') deps.loadReviews();
      armSched(state, deps);
    },
    onStreamOpen: () => {
      loadSchedules(state, deps);
      if (state.tab === 'reviews') deps.loadReviews();
      armSched(state, deps);
    },
    onTopicsUpdated: () => {
      paintSchedCounts(state, deps);
      paintSummary(state, deps);
      paintSchedAlert(deps);
      if (deps.paneIsOpen() && state.tab === 'scheduled' && state.subtab === 'sessions') paintSessions(state, deps);
      else if (deps.paneIsOpen() && state.tab === 'reviews') deps.paintReviews();
      taskPageTopics(state, deps);
    },
    disarm: () => disarmSched(state),
    showNote: (msg) => showSchedNote(deps, msg),
    paintTab: () => paintSchedTab(state, deps),
    paintCounts: () => paintSchedCounts(state, deps),
    paintSummary: () => paintSummary(state, deps),
    getTask: (id) => schedTask(state, id),
    op: (id, action, btn, tags, clearDraft) => schedOp(state, deps, id, action, btn, tags, clearDraft),
    openTaskPage: (id, edit) => openTaskPage(state, deps, id, edit),
    closeTaskPage: (force) => closeTaskPage(state, deps, force),
  };
}
