import {
  describeRun,
  describeWhen,
  formatDuration,
  formatInZone,
  nextRunOf,
  targetId,
  type ScheduleTask,
} from '../core/schedule.js';
import type { SchedulePanelTask } from '../platform/adapter.js';

/**
 * The daemon's side of the web UI's scheduled-task panel: domain tasks → the flat shape the page
 * draws, and the order it draws them in.
 *
 * Here rather than in the page because every sentence the gateway says about a task is already
 * core/schedule.ts's (`describeWhen`, `describeRun`, `formatInZone`), and a second copy of that
 * formatting on the browser side would drift the moment either changed. The page gets absolute
 * `nextAt` as well as the formatted `next`, so its countdown can tick without asking again.
 */

/** What is still going to happen first, then what is paused, then what has ended. */
const STATE_RANK: Record<ScheduleTask['state'], number> = { active: 0, paused: 1, expired: 2, done: 3 };

export function panelTask(task: ScheduleTask, now: number, running: boolean, instance: string): SchedulePanelTask {
  const next = nextRunOf(task, now);
  const run = task.run;
  return {
    id: task.id,
    name: task.name,
    tags: task.tags ?? [],
    createdAt: task.createdAt,
    state: task.state,
    when: describeWhen(task.when, true),
    ...(next !== undefined ? { nextAt: next, next: formatInZone(next, task.when.tz) } : {}),
    run:
      run.kind === 'bash'
        ? `bash · ${formatDuration(run.timeoutMs)}${run.host ? ` · ${run.host}` : ''}`
        : describeRun(run),
    target: targetId(task.target),
    // Only a lane of THIS instance is a topic the page can look up a title for. A task posting to
    // Telegram, or to another web UI instance, keeps the raw target and says nothing it cannot.
    ...(task.target.platform === instance && task.target.thread ? { targetTopic: task.target.thread } : {}),
    ...(task.lastRun
      ? { last: { ...task.lastRun, atText: formatInZone(task.lastRun.at, task.when.tz) } }
      : {}),
    runs: task.runs,
    running,
    detail: run.kind === 'bash' ? run.command : run.prompt,
    kind: run.kind,
    ...(run.cwd ? { cwd: run.cwd } : {}),
    ...(task.expiresAt !== undefined ? { expires: formatInZone(task.expiresAt, task.when.tz) } : {}),
  };
}

/**
 * The list as the panel shows it.
 *
 * The store keeps registration order, which is right for the chat menus but wrong here: a panel
 * is glanced at, and the first row should be the next thing that will happen. Within a rank the
 * store's order is kept (a stable sort), so a list that did not change does not move between two
 * refreshes.
 */
export function panelTasks(
  tasks: readonly ScheduleTask[],
  now: number,
  running: (id: string) => boolean,
  instance: string
): SchedulePanelTask[] {
  return tasks
    .map((t) => panelTask(t, now, running(t.id), instance))
    .sort((a, b) => {
      const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (rank !== 0) return rank;
      if (a.state === 'active') {
        return (a.nextAt ?? Number.POSITIVE_INFINITY) - (b.nextAt ?? Number.POSITIVE_INFINITY);
      }
      return 0;
    });
}
