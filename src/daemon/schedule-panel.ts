import type { ConversationAddress } from '../core/conversation.js';
import {
  describeRun,
  describeWhen,
  editLockOf,
  formatDuration,
  formatInZone,
  nextRunOf,
  targetId,
  type EditTaskInput,
  type ScheduleRunRecord,
  type ScheduleTask,
} from '../core/schedule.js';
import type {
  SchedulePanelEdit,
  SchedulePanelEditField,
  SchedulePanelRun,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../platform/adapter.js';

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

/** What a task's page needs from the daemon beyond the task: the agents, and where a run's conversation is. */
export interface PanelDetailContext {
  now: number;
  running: boolean;
  /** The web UI instance showing the page; only its topics can be opened from it. */
  instance: string;
  agents: readonly string[];
  /** `ConversationRegistry.laneFor`: a conversation key to the platform and address it lives at. */
  laneOf(conversation: string): { platformId: string; address: ConversationAddress } | undefined;
}

/**
 * One task's page: the row's facts, the raw values the form starts from, what the form may offer,
 * and every recorded run with the conversation it went to.
 *
 * `editable` is the shape of `buildTask`'s refusals, read the other way: a fixed-session task runs
 * in a person's topic, which keeps its own directory and model, so it offers neither; a bash task
 * is run by the gateway, so it has no agent or model; a daily task needs a cron. A field outside
 * the list is shown, not edited — the page says why with the rest of what an edit cannot change.
 */
export function panelTaskDetail(task: ScheduleTask, ctx: PanelDetailContext): SchedulePanelTaskDetail {
  const run = task.run;
  const when = 'cron' in task.when ? { cron: task.when.cron } : { at: formatInZone(task.when.at, task.when.tz) };
  const editable: SchedulePanelEditField[] = ['name', 'cron', 'tz'];
  if (!(run.kind === 'agent' && run.session === 'daily')) editable.push('at');
  if (run.kind === 'bash') editable.push('command', 'timeout', 'cwd');
  else {
    editable.push('prompt', 'agent');
    if (run.session !== 'fixed') editable.push('model', 'cwd');
  }
  const locked = editLockOf(task);
  return {
    task: panelTask(task, ctx.now, ctx.running, ctx.instance),
    fields: {
      name: task.name,
      ...when,
      tz: task.when.tz,
      ...(run.kind === 'bash'
        ? { command: run.command, timeoutMs: run.timeoutMs, ...(run.host ? { host: run.host } : {}) }
        : { prompt: run.prompt, agent: run.agent, session: run.session, ...(run.model ? { model: run.model } : {}) }),
      ...(run.cwd ? { cwd: run.cwd } : {}),
    },
    editable,
    ...(locked ? { locked } : {}),
    agents: [...ctx.agents],
    runs: runsOf(task).map((r) => panelRun(r, task.when.tz, ctx)),
  };
}

/** The recorded runs, newest first. A task written before history existed has only its last one. */
function runsOf(task: ScheduleTask): ScheduleRunRecord[] {
  if (task.history) return task.history;
  return task.lastRun ? [task.lastRun] : [];
}

/**
 * A run, with its conversation turned into a topic of this page where it is one. A conversation the
 * daemon no longer knows (its record was swept) keeps no link; one on another platform or instance
 * is named, so the row still says where its output is.
 */
function panelRun(r: ScheduleRunRecord, tz: string, ctx: PanelDetailContext): SchedulePanelRun {
  const lane = r.conversation !== undefined ? ctx.laneOf(r.conversation) : undefined;
  const here = lane !== undefined && lane.platformId === ctx.instance && lane.address.thread !== undefined;
  return {
    at: r.at,
    atText: formatInZone(r.at, tz),
    status: r.status,
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(here ? { topic: lane.address.thread } : {}),
    ...(lane && !here ? { where: targetId({ platform: lane.platformId, ...lane.address }) } : {}),
  };
}

/**
 * The page's edit as `schedule edit` takes it. The page says `command` where the CLI says `--bash`,
 * because the field is a command whatever runs it; everything else is the CLI's own name, and
 * nothing is filled in — a field the person did not change is absent, so the task keeps its own.
 */
export function panelEditInput(edit: SchedulePanelEdit): Omit<EditTaskInput, 'host'> {
  const { command, ...rest } = edit;
  return { ...rest, ...(command !== undefined ? { bash: command } : {}) };
}
