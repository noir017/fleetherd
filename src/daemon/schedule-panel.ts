import { parseTarget, type ConversationAddress } from '../core/conversation.js';
import {
  describeRun,
  describeWhen,
  editLockOf,
  formatDuration,
  formatInZone,
  formatWakeOn,
  nextRunOf,
  SHAPE_SETTINGS,
  targetId,
  type EditTaskInput,
  type NewTaskInput,
  type ScheduleRunRecord,
  type ScheduleTask,
} from '../core/schedule.js';
import type {
  SchedulePanelEdit,
  SchedulePanelFormContext,
  SchedulePanelNew,
  SchedulePanelRun,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../platform/workbench.js';
import type { Destination } from './schedule-service.js';

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
        ? `bash · ${formatDuration(run.timeoutMs)}${run.host ? ` · ${run.host}` : ''}${
            run.wake ? ` · wake (${formatWakeOn(run.wake.on)}, ${task.wakes ?? 0}/${run.wake.max})` : ''
          }`
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

/** What the task form offers, from the daemon's config: see SchedulePanelFormContext. */
export interface PanelFormSource {
  agents: ReadonlyArray<{ id: string; host?: string }>;
  hosts: readonly string[];
  /** `fleetherd channels`' rows: the places a task can post to. */
  channels: ReadonlyArray<{ id: string; title: string }>;
  /** The web UI instance showing the form; its own topics come from the page, not from here. */
  instance: string;
  tz: string;
  agent: string;
}

/**
 * The form's choices. Places on the showing instance are left out of `channels`: the page offers its
 * own topics by title, and an id of one of them typed as text would name the same lane twice.
 */
export function panelForm(src: PanelFormSource): SchedulePanelFormContext {
  const agentHosts: Record<string, string> = {};
  for (const a of src.agents) if (a.host !== undefined) agentHosts[a.id] = a.host;
  const shapes = Object.fromEntries(Object.entries(SHAPE_SETTINGS).map(([k, v]) => [k, [...v]])) as SchedulePanelFormContext['shapes'];
  return {
    agents: src.agents.map((a) => a.id),
    agentHosts,
    hosts: [...src.hosts],
    channels: src.channels.filter((c) => !c.id.startsWith(`${src.instance}:`)).map((c) => ({ id: c.id, title: c.title })),
    shapes,
    tz: src.tz,
    agent: src.agent,
  };
}

/** What a task's page needs from the daemon beyond the task: the form's choices, and where a run's conversation is. */
export interface PanelDetailContext {
  now: number;
  running: boolean;
  /** The web UI instance showing the page; only its topics can be opened from it. */
  instance: string;
  form: SchedulePanelFormContext;
  /** `ConversationRegistry.laneFor`: a conversation key to the platform and address it lives at. */
  laneOf(conversation: string): { platformId: string; address: ConversationAddress } | undefined;
}

/**
 * One task's page: the row's facts, the raw values the form starts from, the form's choices, and
 * every recorded run with the conversation it went to.
 *
 * What the form offers for the task is not decided here any more: everything a task has can be
 * changed, its kind, session and target included, and which fields a shape keeps is the shared
 * `shapes` table — the form follows the shape it is set to, not the one the task had.
 */
export function panelTaskDetail(task: ScheduleTask, ctx: PanelDetailContext): SchedulePanelTaskDetail {
  const run = task.run;
  const when = 'cron' in task.when ? { cron: task.when.cron } : { at: formatInZone(task.when.at, task.when.tz) };
  const locked = editLockOf(task);
  return {
    ...ctx.form,
    task: panelTask(task, ctx.now, ctx.running, ctx.instance),
    fields: {
      name: task.name,
      ...when,
      tz: task.when.tz,
      ...(run.kind === 'bash'
        ? {
            command: run.command,
            timeoutMs: run.timeoutMs,
            ...(run.host ? { host: run.host } : {}),
            ...(run.wake ? { wake: true, wakeOn: formatWakeOn(run.wake.on), wakeMax: run.wake.max } : {}),
          }
        : { prompt: run.prompt, agent: run.agent, session: run.session, ...(run.model ? { model: run.model } : {}) }),
      ...(run.cwd ? { cwd: run.cwd } : {}),
      target: targetId(task.target),
    },
    ...(locked ? { locked } : {}),
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
 * `target` is not an input field: it is resolved by `panelTarget` and handed over as the context's.
 */
export function panelEditInput(edit: SchedulePanelEdit): EditTaskInput {
  const { command, target: _target, ...rest } = edit;
  return { ...rest, ...(command !== undefined ? { bash: command } : {}) };
}

/**
 * The page's new task as `schedule add` takes it. A `null` directory or model is the same as none:
 * a new task has nothing to empty. A `null` host stays — it is the gateway's machine, named.
 */
export function panelNewInput(task: SchedulePanelNew): NewTaskInput {
  const { command, target: _target, cwd, model, wakeOn, ...rest } = task;
  return {
    ...rest,
    ...(command !== undefined ? { bash: command } : {}),
    ...(cwd != null ? { cwd } : {}),
    ...(model != null ? { model } : {}),
    ...(wakeOn != null ? { wakeOn } : {}),
  };
}

/**
 * Where the page says a task posts, as add and edit take a target. The id is `fleetherd channels`'
 * (core/conversation.ts parseTarget, the same parse `--channel` gets); one with no instance in front
 * is a place on the page's own, as an unqualified `--channel` stays on the caller's platform.
 * Throws parseTarget's sentence for an id that is not one.
 */
export function panelTarget(raw: string, instance: string, instances: ReadonlySet<string>): Destination {
  const parsed = parseTarget(raw.trim(), instances);
  return { platform: parsed.platform ?? instance, address: parsed.address };
}
