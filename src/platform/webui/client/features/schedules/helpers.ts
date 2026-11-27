import type {
  SchedulePanelFormContext,
  SchedulePanelSetting,
  SchedulePanelShape,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../../workbench.js';
import { icon } from '../../../icons.js';
import type { ScheduleTargetRequest } from '../../../protocol.js';
import type { FilterBarGroup, FilterBarOption, FilterBarState } from '../../components/index.js';
import { type MessageKey, t as tr } from '../../i18n/index.js';
import type { TopicInfo } from '../../plugins/api.js';
import type { TaskEditPayload, TaskPageDetail } from './types.js';

const MONTH_KEYS: readonly MessageKey[] = [
  'age.month0',
  'age.month1',
  'age.month2',
  'age.month3',
  'age.month4',
  'age.month5',
  'age.month6',
  'age.month7',
  'age.month8',
  'age.month9',
  'age.month10',
  'age.month11',
];

const RUN_STATUS_KEYS: Record<string, MessageKey> = {
  ok: 'sched.runOk',
  failed: 'sched.runFailed',
  interrupted: 'sched.runInterrupted',
  skipped: 'sched.runSkipped',
  missed: 'sched.runMissed',
};

export interface SessionGroup {
  readonly key: string;
  readonly label: string;
  readonly items: TopicInfo[];
  unread: number;
  running: number;
  asking: number;
  current: boolean;
}

export interface TaskFormValues {
  readonly name: string;
  readonly kind: 'agent' | 'bash';
  readonly session: 'new' | 'daily' | 'fixed';
  readonly text: string;
  readonly whenMode: 'cron' | 'at';
  readonly cron: string;
  readonly at: string;
  readonly tz: string;
  readonly agent: string;
  readonly model: string;
  readonly host: string;
  readonly cwd: string;
  readonly timeout: string;
  readonly wake: boolean;
  readonly wakeOn: string;
  readonly wakeMax: string;
  readonly targetKind: string;
  readonly targetOther: string;
  readonly tags: string;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return tr('common.networkError');
}

export function monthName(index: number): string {
  const key = MONTH_KEYS[index];
  return key ? tr(key) : '';
}

export function runStatusWord(status: string): string {
  const key = RUN_STATUS_KEYS[status];
  return key ? tr(key) : status;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function formatDurationInput(ms: number): string {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function parseDurationInput(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(raw).trim());
  if (!match) return null;
  const unit = (match[2] || 's').toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const factor = mult[unit];
  if (!factor) return null;
  return Math.round(parseFloat(match[1] || '0') * factor);
}

export function formatRelativeAge(at: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - at);
  if (diff < 60000) return tr('age.secAgo', { n: Math.max(1, Math.floor(diff / 1000)) });
  if (diff < 3600000) return tr('age.minAgo', { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return tr('age.hourAgo', { n: Math.floor(diff / 3600000) });
  return tr('age.dayAgo', { n: Math.floor(diff / 86400000) });
}

export function formatTimeLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

export function formatClock(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return new Date(at).toISOString();
  }
}

export function formatDueIn(at: number, nowMs: number): string {
  if (at <= nowMs) return tr('sched.dueNow');
  return tr('sched.inLeft', { left: formatTimeLeft(at - nowMs) });
}

export function taskStatusKey(t: SchedulePanelTask): 'running' | 'paused' | 'active' | 'ended' {
  if (t.running) return 'running';
  if (t.state === 'paused') return 'paused';
  if (t.state === 'active') return 'active';
  return 'ended';
}

export function taskTags(t: SchedulePanelTask): string[] {
  return t.tags && t.tags.length > 0 ? t.tags : [];
}

export function parseTagList(raw: string): string[] {
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function resolveTargetShort(t: SchedulePanelTask, topics: readonly TopicInfo[]): string {
  if (t.targetTopic) {
    const found = topics.find((item) => item.id === t.targetTopic);
    if (found) return found.title || t.targetTopic;
  }
  return t.target;
}

export function formatLastRun(t: SchedulePanelTask, nowMs: number): string {
  if (!t.last) return '';
  const word = runStatusWord(t.last.status);
  let out = tr('sched.lastRun', { status: word, ago: formatRelativeAge(t.last.at, nowMs) });
  if (t.last.durationMs != null) out += ` \u00b7 ${formatDuration(t.last.durationMs)}`;
  if (t.last.error) out += ` \u2014 ${t.last.error}`;
  return out;
}

export function formatLastRunShort(t: SchedulePanelTask, nowMs: number): string {
  if (!t.last) return '';
  return tr('sched.lastShort', {
    status: runStatusWord(t.last.status),
    ago: formatRelativeAge(t.last.at, nowMs),
  });
}

export function buildFilterGroups(tasks: readonly SchedulePanelTask[]): FilterBarGroup[] {
  const counts = { running: 0, active: 0, paused: 0, ended: 0 };
  const tags: Record<string, number> = {};
  const order: string[] = [];
  let untagged = 0;

  for (const t of tasks) {
    const list = taskTags(t);
    counts[taskStatusKey(t)]++;
    if (list.length === 0) untagged++;
    for (const tag of list) {
      if (tags[tag] === undefined) {
        tags[tag] = 0;
        order.push(tag);
      }
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
  }
  order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const tagIcon = icon('tag');
  const tagOpts: FilterBarOption[] = order.map((tag) => ({
    value: tag,
    label: tag,
    icon: tagIcon,
    count: tags[tag] ?? 0,
  }));
  tagOpts.push({ value: ' untagged', label: tr('sched.untagged'), icon: tagIcon, count: untagged });

  return [
    {
      id: 'status',
      label: tr('sched.sortStatus'),
      options: [
        { value: 'running', label: tr('sched.statusRunning'), short: tr('filter.runShort'), icon: icon('play'), count: counts.running },
        { value: 'active', label: tr('sched.statusActive'), short: tr('sched.statusActive'), icon: icon('clock'), count: counts.active },
        { value: 'paused', label: tr('sched.statusPaused'), short: tr('sched.statusPausedShort'), icon: icon('pause'), count: counts.paused },
        { value: 'ended', label: tr('sched.statusEnded'), short: tr('sched.statusEndedShort'), icon: icon('stop'), count: counts.ended },
      ],
    },
    { id: 'tags', label: tr('sched.tags'), options: tagOpts },
  ];
}

export function matchesTaskFilter(
  t: SchedulePanelTask,
  words: readonly string[],
  sel: Record<string, string[] | undefined>,
  topics: readonly TopicInfo[],
): boolean {
  if (words.length > 0) {
    const targetText = tr('sched.postsTo', { target: resolveTargetShort(t, topics) });
    const hay = `${t.name || ''} ${t.detail || ''} ${t.target || ''} ${targetText}`.toLowerCase();
    for (const w of words) {
      if (!hay.includes(w)) return false;
    }
  }
  const statusSel = sel.status;
  if (statusSel && statusSel.length > 0 && !statusSel.includes(taskStatusKey(t))) return false;
  const tagSel = sel.tags;
  if (tagSel && tagSel.length > 0) {
    const tags = taskTags(t);
    const hit = tags.length === 0 ? tagSel.includes(' untagged') : tags.some((tag) => tagSel.includes(tag));
    if (!hit) return false;
  }
  return true;
}

export function filterAndSortTasks(
  tasks: readonly SchedulePanelTask[],
  fs: Pick<FilterBarState, 'q' | 'sel' | 'sort' | 'dir'>,
  topics: readonly TopicInfo[],
): SchedulePanelTask[] {
  const words = fs.q.trim() ? fs.q.trim().toLowerCase().split(/\s+/) : [];
  const rows: Array<{ t: SchedulePanelTask; i: number }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t && matchesTaskFilter(t, words, fs.sel, topics)) rows.push({ t, i });
  }
  const sort = fs.sort || 'status';
  const desc = fs.dir === 'desc';
  if (sort === 'status') {
    return rows
      .slice()
      .sort((a, b) => (a.i - b.i) * (desc ? -1 : 1))
      .map((r) => r.t);
  }
  const getKey = (r: { t: SchedulePanelTask; i: number }): number | undefined => {
    if (sort === 'next') return r.t.nextAt;
    if (sort === 'last') return r.t.last?.at;
    return r.t.createdAt;
  };
  const valued: Array<{ t: SchedulePanelTask; i: number }> = [];
  const missing: Array<{ t: SchedulePanelTask; i: number }> = [];
  for (const r of rows) (getKey(r) === undefined ? missing : valued).push(r);
  valued.sort((a, b) => {
    const d = (getKey(a) ?? 0) - (getKey(b) ?? 0);
    return d !== 0 ? (desc ? -d : d) : a.i - b.i;
  });
  return valued.concat(missing).map((r) => r.t);
}

export function scheduledSessions(topics: readonly TopicInfo[]): TopicInfo[] {
  return topics.filter((t) => Boolean(t.scheduled)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

export interface ScheduledSessionEntry {
  readonly topic: TopicInfo;
  readonly depth: number;
}

export function collectScheduledSessionTree(topics: readonly TopicInfo[]): ScheduledSessionEntry[] {
  const byId = new Map<string, TopicInfo>();
  for (const t of topics) byId.set(t.id, t);

  const childrenByParent = new Map<string, TopicInfo[]>();
  const roots: TopicInfo[] = [];
  for (const t of topics) {
    if (t.scheduled) {
      roots.push(t);
      continue;
    }
    if (t.parent) {
      const list = childrenByParent.get(t.parent) ?? [];
      list.push(t);
      childrenByParent.set(t.parent, list);
    }
  }
  roots.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  const out: ScheduledSessionEntry[] = [];
  const visited = new Set<string>();
  const walk = (node: TopicInfo, depth: number): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    out.push({ topic: node, depth });
    const kids = childrenByParent.get(node.id);
    if (!kids) return;
    kids.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    for (const child of kids) walk(child, Math.min(depth + 1, 3));
  };
  for (const root of roots) walk(root, 0);
  return out;
}

export function harnessClass(harness: string | undefined): string {
  const h = (harness || '').toLowerCase();
  if (h === 'claude') return 'fh-hc fh-hc--claude';
  if (h === 'codex') return 'fh-hc fh-hc--codex';
  if (h === 'opencode') return 'fh-hc fh-hc--opencode';
  if (h === 'agy') return 'fh-hc fh-hc--agy';
  if (h === 'gemini') return 'fh-hc fh-hc--gemini';
  if (h === 'dsh') return 'fh-hc fh-hc--dsh';
  return 'fh-hc';
}

function sessionGroupMeta(at: Date | null, now: Date, yesterday: Date): { key: string; label: string } {
  if (!at) return { key: 'x:earlier', label: tr('sched.earlier') };
  const sameMonth = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  if (!sameMonth) {
    return {
      key: `m:${at.getFullYear()}-${month}`,
      label: `${monthName(at.getMonth())} ${at.getFullYear()}`,
    };
  }
  const key = `d:${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, '0')}`;
  if (at.getDate() === now.getDate()) return { key, label: tr('sched.today') };
  if (
    at.getFullYear() === yesterday.getFullYear() &&
    at.getMonth() === yesterday.getMonth() &&
    at.getDate() === yesterday.getDate()
  ) {
    return { key, label: tr('sched.yesterday') };
  }
  return { key, label: `${monthName(at.getMonth()).slice(0, 3)} ${at.getDate()}` };
}

export function groupScheduledSessions(
  list: readonly TopicInfo[],
  activeTopicId: string | undefined,
  unreadOf: (t: TopicInfo) => number,
  nowMs: number,
): SessionGroup[] {
  const now = new Date(nowMs);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const out: SessionGroup[] = [];
  const byKey = new Map<string, SessionGroup>();

  for (const t of list) {
    const at = t.lastAt ? new Date(t.lastAt) : null;
    const { key, label } = sessionGroupMeta(at, now, yesterday);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, items: [], unread: 0, running: 0, asking: 0, current: false };
      byKey.set(key, g);
      out.push(g);
    }
    g.items.push(t);
    if (t.id === activeTopicId) g.current = true;
    g.unread += unreadOf(t);
    if (t.running) g.running++;
    if (t.asking) g.asking++;
  }
  const earlierIdx = out.findIndex((item) => item.key === 'x:earlier');
  if (earlierIdx >= 0 && earlierIdx < out.length - 1) {
    const [earlier] = out.splice(earlierIdx, 1);
    if (earlier) out.push(earlier);
  }
  return out;
}

export function taskAssociatedSessions(
  detail: SchedulePanelTaskDetail,
  topics: readonly TopicInfo[],
): TopicInfo[] {
  const runTopics = new Set<string>();
  for (const r of detail.runs) {
    if (r.topic) runTopics.add(r.topic);
  }
  return topics
    .filter((t) => t.task === detail.task.id || runTopics.has(t.id))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

export function createNewTaskDetail(form: SchedulePanelFormContext): TaskPageDetail {
  return {
    ...form,
    task: null,
    runs: [],
    fields: { name: '', tz: form.tz, prompt: '', agent: form.agent, session: 'new', target: '' },
  };
}

export function resolveFormShape(kind: 'agent' | 'bash', session: 'new' | 'daily' | 'fixed'): SchedulePanelShape {
  if (kind === 'bash') return 'bash';
  return session;
}

function resolveInitialTargetKind(
  detail: TaskPageDetail,
  topics: readonly TopicInfo[],
  activeTopicId: string | undefined,
): string {
  if (detail.task) {
    const targetId = detail.task.targetTopic;
    return targetId && topics.some((t) => t.id === targetId) ? `topic:${targetId}` : 'other';
  }
  if (activeTopicId && topics.some((t) => t.id === activeTopicId && !t.scheduled && !t.parent)) {
    return `topic:${activeTopicId}`;
  }
  const first = topics.find((t) => !t.scheduled && !t.parent);
  return first ? `topic:${first.id}` : 'other';
}

function initialWakeFields(f: TaskPageDetail['fields']): Pick<TaskFormValues, 'wake' | 'wakeOn' | 'wakeMax'> {
  return {
    wake: Boolean(f.wake),
    wakeOn: f.wakeOn ?? 'any',
    wakeMax: f.wakeMax !== undefined ? String(f.wakeMax) : '3',
  };
}

export function initialFormValues(
  detail: TaskPageDetail,
  topics: readonly TopicInfo[],
  activeTopicId: string | undefined,
): TaskFormValues {
  const f = detail.fields;
  const isBash = f.command !== undefined;
  const targetKind = resolveInitialTargetKind(detail, topics, activeTopicId);
  const defaultHost = f.agent ? detail.agentHosts[f.agent] : undefined;
  const defaultAgent = [f.agent, detail.agent, detail.agents[0]].find(Boolean) ?? '';

  return {
    name: f.name,
    kind: isBash ? 'bash' : 'agent',
    session: f.session || 'new',
    text: (isBash ? f.command : f.prompt) ?? '',
    whenMode: f.at !== undefined ? 'at' : 'cron',
    cron: f.cron ?? '',
    at: f.at ? f.at.replace(' ', 'T') : '',
    tz: f.tz,
    agent: defaultAgent,
    model: f.model ?? '',
    host: f.host ?? defaultHost ?? '',
    cwd: f.cwd ?? '',
    timeout: f.timeoutMs ? formatDurationInput(f.timeoutMs) : '',
    ...initialWakeFields(f),
    targetKind,
    targetOther: targetKind === 'other' ? f.target : '',
    tags: detail.task ? detail.task.tags.join(', ') : '',
  };
}

function diffWhenFields(
  values: TaskFormValues,
  prev: TaskPageDetail['fields'],
  isNew: boolean,
  out: TaskEditPayload,
): string | null {
  const tz = values.tz.trim();
  if (isNew || tz !== prev.tz) out.tz = tz;
  if (values.whenMode === 'at') {
    const at = values.at.replace('T', ' ').trim();
    if (!at) return tr('taskPage.pickDateErr');
    if (isNew || prev.at === undefined || at !== prev.at || out.tz !== undefined) out.at = at;
  } else {
    const cron = values.cron.trim();
    if (isNew || prev.cron === undefined || cron !== prev.cron) out.cron = cron;
  }
  return null;
}

function diffNullableStr(val: string, prev: string | undefined, isNew: boolean, force: boolean): string | null | undefined {
  const changed = force || (isNew ? Boolean(val) : val !== (prev || ''));
  return changed ? (val || null) : undefined;
}

function diffTimeoutSetting(
  raw: string,
  prevMs: number | undefined,
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = parseDurationInput(trimmed);
  if (ms === null || ms <= 0) return tr('taskPage.timeoutErr');
  if (isNew || turned || ms !== prevMs) out.timeoutMs = ms;
  return null;
}

function diffWakeSetting(
  values: TaskFormValues,
  prev: TaskPageDetail['fields'],
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload,
): string | null {
  if (!values.wake) {
    if (!isNew && !turned && prev.wake) out.wake = false;
    return null;
  }
  const wakeOn = values.wakeOn.trim() || 'any';
  const wakeMax = Number(values.wakeMax.trim() || '3');
  if (!Number.isInteger(wakeMax) || wakeMax < 1 || wakeMax > 100) {
    return tr('taskPage.wakeMaxErr');
  }
  if (isNew || turned || !prev.wake) {
    out.wake = true;
    out.wakeOn = wakeOn;
    out.wakeMax = wakeMax;
    return null;
  }
  if (wakeOn !== (prev.wakeOn ?? 'any')) out.wakeOn = wakeOn;
  if (wakeMax !== (prev.wakeMax ?? 3)) out.wakeMax = wakeMax;
  return null;
}

function diffShapeSettings(
  values: TaskFormValues,
  prev: TaskPageDetail['fields'],
  keeps: readonly SchedulePanelSetting[],
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload,
): string | null {
  const has = (k: SchedulePanelSetting): boolean => keeps.includes(k);
  if (has('agent') && values.agent && (isNew || turned || values.agent !== prev.agent)) {
    out.agent = values.agent;
  }
  if (has('model')) {
    const next = diffNullableStr(values.model.trim(), prev.model, isNew, false);
    if (next !== undefined) out.model = next;
  }
  if (has('host')) {
    const next = diffNullableStr(values.host, prev.host, isNew, isNew || turned);
    if (next !== undefined) out.host = next;
  }
  if (has('cwd')) {
    const next = diffNullableStr(values.cwd.trim(), prev.cwd, isNew, false);
    if (next !== undefined) out.cwd = next;
  }
  if (has('timeout')) {
    const err = diffTimeoutSetting(values.timeout, prev.timeoutMs, isNew, turned, out);
    if (err) return err;
  }
  return has('wake') ? diffWakeSetting(values, prev, isNew, turned, out) : null;
}

function resolveTargetRequest(values: TaskFormValues): ScheduleTargetRequest | null {
  if (values.targetKind.startsWith('topic:')) {
    return { topic: values.targetKind.slice(6) };
  }
  const channel = values.targetOther.trim();
  return channel ? { channel } : null;
}

function diffBodyAndSession(
  values: TaskFormValues,
  prev: TaskPageDetail['fields'],
  isNew: boolean,
  turned: boolean,
  out: TaskEditPayload,
): void {
  if (values.kind === 'bash') {
    if (isNew || turned || values.text !== prev.command) out.command = values.text;
    return;
  }
  if (isNew || turned || values.text !== prev.prompt) out.prompt = values.text;
  if (isNew || turned || values.session !== prev.session) out.session = values.session;
}

function diffTargetAndTags(
  detail: TaskPageDetail,
  values: TaskFormValues,
  isNew: boolean,
  topics: readonly TopicInfo[],
  out: TaskEditPayload,
): string | null {
  const target = resolveTargetRequest(values);
  if (!target) return tr('taskPage.targetErr');
  const targetId = detail.task?.targetTopic;
  const ownTopic = targetId && topics.some((t) => t.id === targetId) ? targetId : '';
  const targetChanged = 'topic' in target ? target.topic !== ownTopic : target.channel !== detail.fields.target;
  if (isNew || targetChanged) out.target = target;

  const tags = parseTagList(values.tags);
  const prevTags = detail.task?.tags ?? [];
  if (isNew ? tags.length > 0 : tags.join(',') !== prevTags.join(',')) out.tags = tags;
  return null;
}

export function buildTaskEditDiff(
  detail: TaskPageDetail,
  values: TaskFormValues,
  isNew: boolean,
  topics: readonly TopicInfo[],
): { readonly error: string } | { readonly edit: TaskEditPayload } {
  const prev = detail.fields;
  const out: TaskEditPayload = {};
  const shape = resolveFormShape(values.kind, values.session);
  const keeps = detail.shapes[shape] ?? [];
  const turned = !isNew && values.kind !== (prev.command !== undefined ? 'bash' : 'agent');

  const name = values.name.trim();
  if (isNew ? Boolean(name) : name !== prev.name) out.name = name;

  const whenErr = diffWhenFields(values, prev, isNew, out);
  if (whenErr) return { error: whenErr };

  diffBodyAndSession(values, prev, isNew, turned, out);
  const shapeErr = diffShapeSettings(values, prev, keeps, isNew, turned, out);
  if (shapeErr) return { error: shapeErr };

  const tailErr = diffTargetAndTags(detail, values, isNew, topics, out);
  if (tailErr) return { error: tailErr };

  return { edit: out };
}

export function isFormDirty(
  detail: TaskPageDetail,
  values: TaskFormValues,
  isNew: boolean,
  topics: readonly TopicInfo[],
): boolean {
  if (isNew) {
    return Boolean(
      values.name.trim() || values.text.trim() || values.cron.trim() || values.tags.trim(),
    );
  }
  const diff = buildTaskEditDiff(detail, values, false, topics);
  return 'error' in diff || Object.keys(diff.edit).length > 0;
}

export function listTimeZones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}
