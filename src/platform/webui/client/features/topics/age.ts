import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { getLocale, t as tr, type MessageKey } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import type { SubtreeRunInfo, Topic, TopicAgeInfo } from './types.js';

export const AGE_TICK_MS = 30000;

export const MONTH_KEYS: readonly MessageKey[] = [
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

export function schedAgo(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return tr('age.secAgo', { n: s });
  if (s < 3600) return tr('age.minAgo', { n: Math.round(s / 60) });
  if (s < 86400) return tr('age.hourAgo', { n: Math.round(s / 3600) });
  return tr('age.dayAgo', { n: Math.round(s / 86400) });
}

export function durText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d${rh ? `${rh}h` : ''}`;
}

export function ageText(ms: number, done: boolean): string {
  const d = durText(ms);
  return done ? tr('age.ago', { dur: d }) : d;
}

export function ageClock(at: number, now = new Date()): string {
  const d = new Date(at);
  const hm = `${d.getHours() < 10 ? '0' : ''}${d.getHours()}:${d.getMinutes() < 10 ? '0' : ''}${d.getMinutes()}`;
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hm;
  }
  const monthKey = MONTH_KEYS[d.getMonth()] ?? 'age.month0';
  const mn = tr(monthKey);
  const day = `${getLocale() === 'zh-CN' ? mn : mn.slice(0, 3)} ${d.getDate()}`;
  return `${d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`} ${hm}`;
}

export function subtreeRun(id: string, topics: readonly Topic[]): SubtreeRunInfo {
  let busy = false;
  let since = 0;
  const stack: string[] = [id];
  const seen: Record<string, boolean> = {};
  let steps = 0;
  while (stack.length && steps++ < 256) {
    const p = stack.pop();
    if (!p || seen[p]) continue;
    seen[p] = true;
    for (const t of topics) {
      if (t.parent !== p) continue;
      if (t.running) {
        busy = true;
        if (t.runningSince && (!since || t.runningSince < since)) since = t.runningSince;
      }
      stack.push(t.id);
    }
  }
  return { busy, since };
}

export function topicAge(t: Topic, topics: readonly Topic[]): TopicAgeInfo | null {
  if (t.running) return t.runningSince ? { at: t.runningSince, run: true } : null;
  const below = subtreeRun(t.id, topics);
  if (below.busy) return below.since ? { at: below.since, run: true } : null;
  const at = t.outcome && t.outcome.at ? t.outcome.at : t.msgCount ? t.lastAt : 0;
  return at ? { at, run: false } : null;
}

export function ageHtml(t: Topic, topics: readonly Topic[], now = Date.now()): string {
  const a = topicAge(t, topics);
  if (!a) return '';
  return (
    `<span class="topic-age${a.run ? ' run' : ''}" data-age="${text(a.at)}"` +
    ` data-age-run="${a.run ? '1' : '0'}"` +
    ` title="${text(tr(a.run ? 'age.started' : 'age.ended', { when: ageClock(a.at, new Date(now)) }))}">` +
    `${text(ageText(now - a.at, !a.run))}</span>`
  );
}

export interface AgeTicker extends Disposable {
  paintAges(): void;
  armAgeTick(): void;
  attach(): Disposable;
}

export function createAgeTicker(doc: Document = document, nowFn: () => number = () => Date.now()): AgeTicker {
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new DisposableStore();

  function paintAges(): void {
    const nodes = doc.querySelectorAll<HTMLElement>('.topic-age');
    const now = nowFn();
    const nowDate = new Date(now);
    for (const n of nodes) {
      const at = Number(n.getAttribute('data-age')) || 0;
      if (!at) continue;
      const run = n.getAttribute('data-age-run') === '1';
      n.textContent = ageText(now - at, !run);
      n.title = tr(run ? 'age.started' : 'age.ended', { when: ageClock(at, nowDate) });
    }
  }

  function armAgeTick(): void {
    const want = Boolean(doc.querySelector('.topic-age')) && doc.visibilityState !== 'hidden';
    if (want && !timer) {
      timer = setInterval(paintAges, AGE_TICK_MS);
    } else if (!want && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function attach(): Disposable {
    return listeners.add(
      addDisposableListener(doc, 'visibilitychange', () => {
        if (doc.visibilityState !== 'hidden') paintAges();
        armAgeTick();
      }),
    );
  }

  function dispose(): void {
    listeners.dispose();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { paintAges, armAgeTick, attach, dispose };
}
