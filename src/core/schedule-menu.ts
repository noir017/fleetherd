import { formatButtonId, parseButtonId } from './button-id.js';
import type { Locale } from './i18n/index.js';
import { tWorkflows } from './i18n/workflows.js';
import { truncateLabel } from './paging.js';
import {
  describeLastRun,
  describeRun,
  describeWhen,
  formatInZone,
  nextSuffix,
  stateLabel,
  targetId,
  taskListText,
  type ScheduleTask,
} from './schedule.js';

/**
 * `/setting` → ⏰ Scheduled tasks, as data: the list, one task, the delete confirmation, and the
 * button ids between them. The daemon holds the menu's state and carries the clicks out; this
 * module decides what each level says and offers, so the typed and tapped surfaces cannot disagree.
 *
 * Reached from the settings screen rather than being a row of it, because every settings row is a
 * config.yaml value with a parser, a location and an ack (core/settings.ts), and a task list is none
 * of those. The entry button edits the settings message into this menu, and "◀ Settings" edits it
 * back — one message, like every other menu here.
 *
 * Same three rules as the other menus: not one-shot, a frozen snapshot of ids that button indices
 * point into, and the task re-read at every click (so a task deleted meanwhile says so instead of
 * being acted on).
 */

/** Settings list → schedule list: `sco:<reqId>:0` (posted by the settings menu). */
export const SCHEDULE_OPEN_PREFIX = 'sco:';
/** List → one task: `sct:<reqId>:<index into the frozen id list>`. */
export const SCHEDULE_TASK_PREFIX = 'sct:';
/** An action on the open task: `sca:<reqId>:<ScheduleAction index>`. */
export const SCHEDULE_ACTION_PREFIX = 'sca:';

/** Index = the number in the `sca:` id. Append only: ids of menus already posted carry these. */
const ACTIONS = ['pause', 'resume', 'delete', 'confirm-delete', 'back', 'settings'] as const;
export type ScheduleMenuAction = (typeof ACTIONS)[number];

export type ScheduleMenuClick =
  | { kind: 'open'; reqId: string }
  | { kind: 'task'; reqId: string; index: number }
  | { kind: 'action'; reqId: string; action: ScheduleMenuAction };

export function scheduleOpenButtonId(reqId: string): string {
  return formatButtonId(SCHEDULE_OPEN_PREFIX, reqId, 0);
}

function actionId(reqId: string, action: ScheduleMenuAction): string {
  return formatButtonId(SCHEDULE_ACTION_PREFIX, reqId, ACTIONS.indexOf(action));
}

export function parseScheduleButtonId(buttonId: string): ScheduleMenuClick | null {
  const open = parseButtonId(buttonId, SCHEDULE_OPEN_PREFIX);
  if (open) return { kind: 'open', reqId: open.reqId };
  const task = parseButtonId(buttonId, SCHEDULE_TASK_PREFIX);
  if (task) return { kind: 'task', reqId: task.reqId, index: task.n };
  const act = parseButtonId(buttonId, SCHEDULE_ACTION_PREFIX);
  const action = act ? ACTIONS[act.n] : undefined;
  if (act && action) return { kind: 'action', reqId: act.reqId, action };
  return null;
}

/** The entry button's label on the settings screen. */
export function scheduleEntryLabel(tasks: readonly ScheduleTask[], locale: Locale = 'en'): string {
  const active = tasks.filter((t) => t.state === 'active').length;
  const otherText =
    tasks.length > active
      ? tWorkflows(locale, 'schedule.menu.entryOther', { count: tasks.length - active })
      : '';
  return truncateLabel(tWorkflows(locale, 'schedule.menu.entryLabel', { active, other: otherText }));
}

/** Tasks offered as buttons; the rest are listed in the text and managed by typing. */
export const SCHEDULE_MENU_MAX = 20;

const STATE_MARK: Record<ScheduleTask['state'], string> = { active: '', paused: '⏸ ', expired: '⌛ ', done: '✔ ' };

export interface ScheduleMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
}

/** The list level. `ids` is the frozen snapshot the task buttons index into. */
export function buildScheduleListMenu(
  reqId: string,
  tasks: readonly ScheduleTask[],
  now: number,
  locale: Locale = 'en'
): ScheduleMenuView & { ids: string[] } {
  const shown = tasks.slice(0, SCHEDULE_MENU_MAX);
  const buttons = shown.map((t, i) => ({
    id: formatButtonId(SCHEDULE_TASK_PREFIX, reqId, i),
    label: truncateLabel(`${STATE_MARK[t.state]}#${t.id} ${t.name}`),
  }));
  buttons.push({ id: actionId(reqId, 'settings'), label: tWorkflows(locale, 'schedule.menu.settingsButton') });
  let text = taskListText(tasks, now, locale);
  if (tasks.length > 0) text += tWorkflows(locale, 'schedule.menu.listHint');
  if (tasks.length > SCHEDULE_MENU_MAX) {
    text += tWorkflows(locale, 'schedule.menu.listOverflow', { count: tasks.length - SCHEDULE_MENU_MAX });
  }
  return { text, buttons, ids: shown.map((t) => t.id) };
}

/** One task's level: what it is, and what can be done to it in its state. */
export function buildScheduleTaskMenu(
  reqId: string,
  task: ScheduleTask,
  now: number,
  locale: Locale = 'en'
): ScheduleMenuView {
  const tz = task.when.tz;
  const what = task.run.kind === 'bash' ? task.run.command : task.run.prompt;
  const until =
    task.expiresAt !== undefined
      ? tWorkflows(locale, 'schedule.card.until', { time: formatInZone(task.expiresAt, tz) })
      : '';
  const kindLabel =
    task.run.kind === 'bash'
      ? tWorkflows(locale, 'schedule.menu.commandLabel')
      : tWorkflows(locale, 'schedule.menu.promptLabel');
  const lines = [
    `⏰ \`#${task.id}\` **${task.name}** — ${stateLabel(task.state, locale)}`,
    tWorkflows(locale, 'schedule.menu.taskWhen', {
      value: `${describeWhen(task.when, false, locale)}${nextSuffix(task, now, locale)}`,
    }),
    tWorkflows(locale, 'schedule.menu.taskRuns', {
      value: `${describeRun(task.run, locale)}${until}`,
    }),
    tWorkflows(locale, 'schedule.menu.taskPostsTo', { target: targetId(task.target) }),
    tWorkflows(locale, 'schedule.menu.taskLastRun', {
      last: describeLastRun(task, locale),
      runs: task.runs,
    }),
    `• ${kindLabel}${locale === 'zh-CN' ? '：' : ': '}${what.length <= 300 ? what : `${what.slice(0, 299)}…`}`,
  ];
  const buttons: Array<{ id: string; label: string }> = [];
  if (task.state === 'active') buttons.push({ id: actionId(reqId, 'pause'), label: tWorkflows(locale, 'schedule.menu.btnPause') });
  if (task.state === 'paused') buttons.push({ id: actionId(reqId, 'resume'), label: tWorkflows(locale, 'schedule.menu.btnResume') });
  buttons.push({ id: actionId(reqId, 'delete'), label: tWorkflows(locale, 'schedule.menu.btnDelete') });
  buttons.push({ id: actionId(reqId, 'back'), label: tWorkflows(locale, 'schedule.menu.btnBack') });
  return { text: lines.join('\n'), buttons };
}

/** Delete asks once more: the task is gone for good, and a mis-tap on a phone is easy. */
export function buildScheduleDeleteConfirm(reqId: string, task: ScheduleTask, locale: Locale = 'en'): ScheduleMenuView {
  return {
    text: tWorkflows(locale, 'schedule.menu.deleteConfirm', { id: task.id, name: task.name }),
    buttons: [
      { id: actionId(reqId, 'confirm-delete'), label: tWorkflows(locale, 'schedule.menu.btnConfirmDelete') },
      { id: actionId(reqId, 'back'), label: tWorkflows(locale, 'schedule.menu.btnCancel') },
    ],
  };
}

export function scheduleMenuExpiredText(locale: Locale = 'en'): string {
  return tWorkflows(locale, 'schedule.menu.expired');
}
