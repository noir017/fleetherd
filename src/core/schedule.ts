import { Cron } from 'croner';
import type { ConversationAddress } from './conversation.js';
import { formatTarget } from './conversation.js';

/**
 * Scheduled tasks as data: what a task is, when it runs next, whether a late run is still worth
 * making, and every sentence the gateway says about one. The timers, the process spawning and the
 * turns live in daemon/scheduler.ts; nothing here reads a clock — `now` is always passed in.
 *
 * ── Why the gateway schedules at all ──────────────────────────────────────────────────────────
 * The harnesses have schedulers of their own (Claude Code's CronCreate, for one), and they are
 * scoped to the harness PROCESS: the job lives in memory and fires only while that process is up.
 * This gateway reclaims an idle conversation's process after an hour and restarts every process on
 * an upgrade, so a "every morning at 8" set up that way silently stops existing by lunchtime. A
 * task kept here survives both, because it is a file and a timer in the one process that is always
 * running. (Those harness tools are deliberately left enabled — the gateway does not edit an agent's
 * toolbox. The agent-facing help says which one survives.)
 *
 * ── Two kinds, three session modes ───────────────────────────────────────────────────────────
 * - `bash`: a command, run by the daemon itself, its output posted to the target. No agent.
 * - `agent` + `fixed`: the prompt is a turn in ONE conversation — by default the topic it was
 *   registered from — so context accumulates and the user can follow up in place. Limited to a
 *   24-hour window (FIXED_SESSION_WINDOW_MS), after which the task is marked expired: a topic that a
 *   schedule keeps talking into indefinitely grows a context nobody is reading.
 * - `agent` + `new`: every run is a fresh session, in a new topic where the platform can open one.
 *   No window; this is the shape for "every morning".
 * - `agent` + `daily`: the first run of each local day opens a new topic and the rest of that
 *   day's runs join it — one conversation a day, then a fresh one tomorrow. The day is the
 *   task's own `tz` (a run belongs to the day of its PLANNED time, so a catch-up after midnight
 *   still joins the day it was meant for). Needs a cron and a platform that can open a topic:
 *   unlike `new`, there is no throwaway fallback, because a session nobody can reply into is not
 *   a conversation — it is a place output goes to die. No window; this is the shape for a
 *   briefing that should build on itself through the day.
 */

/** How long a fixed-session task stays live after it is registered (operator's rule, 2026-09-30). */
export const FIXED_SESSION_WINDOW_MS = 24 * 3_600_000;

/**
 * How late a run may still be made. A run missed by less than this — the daemon was down across
 * the moment, typically for an image update — is made once as soon as it can be; later than this it
 * is recorded as missed and skipped, because an 08:00 briefing delivered at 15:00 is noise.
 */
export const CATCH_UP_GRACE_MS = 3_600_000;

export const DEFAULT_BASH_TIMEOUT_MS = 10 * 60_000;
export const MAX_BASH_TIMEOUT_MS = 6 * 3_600_000;

export type ScheduleWhen = { cron: string; tz: string } | { at: number; tz: string };

export type ScheduleRun =
  | {
      kind: 'agent';
      agent: string;
      prompt: string;
      session: 'fixed' | 'new' | 'daily';
      cwd?: string;
      /**
       * The model this task's own conversations use. Only `new` and `daily` may name one: a
       * fixed-session task runs in a person's topic, whose model is that topic's `/model` choice,
       * and a bash run has no model at all.
       */
      model?: string;
    }
  /**
   * `host`: the `hosts:` entry the registering agent ran on. A command an agent wrote names that
   * agent's machine — its paths, its tools — so it runs there, not on the gateway.
   */
  | { kind: 'bash'; command: string; cwd?: string; timeoutMs: number; host?: string };

/** Where a task's output goes: a platform instance and an address on it. */
export interface ScheduleTarget {
  platform: string;
  channel: string;
  thread?: string;
}

export type ScheduleRunStatus = 'ok' | 'failed' | 'interrupted' | 'skipped' | 'missed';

/**
 * - `active`  — will run.
 * - `paused`  — kept, not run; `resume` brings it back.
 * - `expired` — a fixed-session task past its window. Kept so the list still says what it was.
 * - `done`    — a one-shot task that has had its run (or missed it).
 */
export type ScheduleState = 'active' | 'paused' | 'expired' | 'done';

/**
 * The topic a daily-session task is using today, and which day that is.
 *
 * Persisted with the task rather than held in memory, because the whole promise is that a
 * restart in the middle of the day still lands in the same conversation. `day` is the task's
 * local calendar date (`YYYY-MM-DD` in its own `tz`); when a run's planned day differs, the
 * entry is stale and a new topic is opened.
 */
export interface ScheduleDaySession {
  day: string;
  conversation: string;
  address: ConversationAddress;
  /**
   * A person typed `/model` in this topic during the day.
   *
   * Persisted with the day's topic because the conversation's override is in memory only: after a
   * restart it is gone, and a task that re-applied its own model would undo a choice the person
   * made. The task cannot put the person's model back (that choice is lost with the process, like
   * any `/model`), but it can leave the topic alone for the rest of the day.
   */
  personModel?: boolean;
}

export interface ScheduleTask {
  id: string;
  name: string;
  when: ScheduleWhen;
  run: ScheduleRun;
  target: ScheduleTarget;
  /** The conversation a fixed-session task runs in. */
  conversation?: string;
  /** A daily-session task's topic for the current day; absent until its first run of a day. */
  daySession?: ScheduleDaySession;
  state: ScheduleState;
  createdAt: number;
  /** Who registered it: the conversation and the platform it was on. */
  createdBy: { conversation: string; platform: string };
  /** Fixed-session tasks only: the end of the window. */
  expiresAt?: number;
  /**
   * The PLANNED time of the last run handled — made, skipped or missed. The next run is the first
   * planned time after it, which is what makes a restart neither repeat a run nor lose track.
   */
  lastPlannedAt?: number;
  lastRun?: { at: number; status: ScheduleRunStatus; durationMs?: number; exitCode?: number; error?: string };
  runs: number;
}

// ─────────────────────────────── time ───────────────────────────────

/** Throws RangeError for a name Intl does not know. */
export function assertTimeZone(tz: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
}

function zonedParts(epoch: number, tz: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** `tz`'s offset from UTC at `epoch`, in ms. */
function offsetAt(epoch: number, tz: string): number {
  const p = zonedParts(epoch, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` names. Two passes, because the offset to subtract is the
 * one in force AT the answer, which on a DST boundary differs from the one at the first guess.
 */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `2026-10-01 08:00` in `tz` — the form every surface shows a time in — with `:ss` added when the
 * time is not on a minute. That matters for `--at +2m`, which lands wherever the clock was: shown as
 * `11:28` a run due at 11:28:28 read as minute-precision to the agent that registered it, and it
 * told the user the task would fire "a few seconds early" (observed 2026-09-30).
 */
export function formatInZone(epoch: number, tz: string): string {
  const p = zonedParts(epoch, tz);
  const base = `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
  return p.second !== 0 ? `${base}:${two(p.second)}` : base;
}

/**
 * The calendar day `epoch` falls on in `tz`, as `YYYY-MM-DD` — a daily-session task's key for
 * "which day is this run part of". The task's own zone decides, never the gateway host's; and the
 * caller passes the PLANNED time, so a run caught up after midnight still belongs to the day it
 * was meant for.
 */
export function formatDay(epoch: number, tz: string): string {
  const p = zonedParts(epoch, tz);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

const RELATIVE_RE = /^\+(\d+)\s*(s|m|h|d)$/i;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `--at`, in the forms an agent is likely to have in hand:
 *  - `+30m`, `+2h`, `+1d`            — relative to now (what "in half an hour" is);
 *  - `08:00`                         — the next time the clock in `tz` reads that;
 *  - `2026-10-01 08:00[:ss]`         — a wall-clock time in `tz`;
 *  - `2026-10-01T00:00:00Z` / `+08:00` — an absolute instant, zone and all.
 * Returns undefined for anything else, so the caller can name the forms it accepts.
 */
export function parseAt(raw: string, tz: string, now: number): number | undefined {
  const s = raw.trim();
  const rel = RELATIVE_RE.exec(s);
  if (rel) return now + Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!;
  const clock = CLOCK_RE.exec(s);
  if (clock) {
    const [h, mi] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || mi > 59) return undefined;
    const today = zonedParts(now, tz);
    const at = zonedToEpoch(today.year, today.month, today.day, h, mi, 0, tz);
    return at > now ? at : zonedToEpoch(today.year, today.month, today.day + 1, h, mi, 0, tz);
  }
  const wall = WALL_RE.exec(s);
  if (wall) {
    const [y, mo, d, h, mi, sec] = wall.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return undefined;
    return zonedToEpoch(y, mo, d, h, mi, sec, tz);
  }
  // Only an ISO string that carries its own zone; a bare date would be read as UTC, silently.
  if (/^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** Five fields or a croner nickname (`@daily`). Six-field (seconds) patterns are refused. */
function singleCronFor(expr: string, tz: string): Cron {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('@') && trimmed.split(/\s+/).length !== 5) {
    throw new Error(`"${expr}" is not a 5-field cron expression (minute hour day month weekday)`);
  }
  // No callback: croner arms no timer, it only computes. The daemon owns every timer there is.
  return new Cron(trimmed, { timezone: tz, paused: true });
}

/** Parses one or more 5-field cron expressions separated by semicolons. */
function cronsFor(expr: string, tz: string): Cron[] {
  const parts = expr.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('cron expression is empty');
  }
  return parts.map((p) => singleCronFor(p, tz));
}

/** The first planned time strictly after `after`, ignoring state and window. */
function plannedAfter(when: ScheduleWhen, after: number): number | undefined {
  if ('at' in when) return when.at > after ? when.at : undefined;
  const crons = cronsFor(when.cron, when.tz);
  const afterDate = new Date(after);
  let earliest: number | undefined;
  for (const c of crons) {
    const next = c.nextRun(afterDate)?.getTime();
    if (next !== undefined && (earliest === undefined || next < earliest)) {
      earliest = next;
    }
  }
  return earliest;
}

/** When an active task next runs, or undefined when it never will again. For display and for timers. */
export function nextRunOf(task: ScheduleTask, now: number): number | undefined {
  if (task.state !== 'active') return undefined;
  const next = plannedAfter(task.when, Math.max(now, task.lastPlannedAt ?? -Infinity));
  if (next === undefined) return undefined;
  if (task.expiresAt !== undefined && next > task.expiresAt) return undefined;
  return next;
}

/**
 * What the scheduler should do with one active task at `now`.
 *
 * - `wait`   — nothing is due; look again at `at`.
 * - `run`    — a run is due. `planned` is the LATEST planned time at or before now: a daemon that
 *              was down across several runs of an every-minute task makes one, not a burst.
 * - `missed` — the latest due run is older than the grace; record it and move on.
 * - `expire` — a fixed-session task whose window has closed.
 * - `done`   — a one-shot task with nothing left to do.
 */
export type ScheduleDecision =
  | { kind: 'wait'; at: number }
  | { kind: 'run'; planned: number }
  | { kind: 'missed'; planned: number }
  | { kind: 'expire' }
  | { kind: 'done' };

/** Guard against a pathological catch-up walk (an every-minute cron after a very long outage). */
const MAX_CATCH_UP_STEPS = 100_000;

export function decide(task: ScheduleTask, now: number, graceMs = CATCH_UP_GRACE_MS): ScheduleDecision {
  // Strictly after registration: a task added at 10:00:00.000 sharp for `*/10` first runs at 10:10,
  // not the instant it is saved (which would read as the act of registering having run it).
  const from = task.lastPlannedAt ?? task.createdAt;
  const first = plannedAfter(task.when, from);
  const pastWindow = (t: number): boolean => task.expiresAt !== undefined && t > task.expiresAt;

  if (first === undefined || pastWindow(first)) {
    if (task.expiresAt === undefined) return { kind: 'done' };
    return now >= task.expiresAt ? { kind: 'expire' } : { kind: 'wait', at: task.expiresAt };
  }
  if (first > now) return { kind: 'wait', at: first };

  // Due. Walk forward to the latest planned time at or before now (still inside the window).
  let latest = first;
  for (let i = 0; i < MAX_CATCH_UP_STEPS; i++) {
    const after = plannedAfter(task.when, latest);
    if (after === undefined || after > now || pastWindow(after)) break;
    latest = after;
  }
  return now - latest <= graceMs ? { kind: 'run', planned: latest } : { kind: 'missed', planned: latest };
}

// ─────────────────────────────── registering ───────────────────────────────

/** What `schedule add` carries, already structurally validated at the IPC boundary. */
export interface NewTaskInput {
  name?: string;
  cron?: string;
  at?: string;
  tz?: string;
  prompt?: string;
  bash?: string;
  agent?: string;
  session?: 'fixed' | 'new' | 'daily';
  cwd?: string;
  model?: string;
  timeoutMs?: number;
}

/** What the daemon knows that the input does not. */
export interface NewTaskContext {
  now: number;
  id: string;
  defaultTz: string;
  /** Configured agent ids. */
  agents: readonly string[];
  /** The registering conversation: its key, the agent answering it, and the directory it works in. */
  from: { key: string; platform: string; agent: string; cwd?: string; host?: string };
  /** Where output goes (`--channel`, else the registering conversation's own lane). */
  target: { platform: string; address: ConversationAddress };
  /**
   * Whether the target platform can open a topic. A daily-session task is refused without it:
   * its whole point is one conversation per day that the person can reply into, and the
   * fallback `new` uses — a throwaway conversation — would be invisible to them.
   */
  canOpenTopic: boolean;
  /**
   * The conversation a fixed-session run would happen in — the target's — with the agent bound
   * there (if any). Undefined when the scope cannot name one conversation for an address.
   */
  targetConversation?: { key: string; agent?: string };
}

const NAME_LIMIT = 48;

function defaultName(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_LIMIT ? flat : `${flat.slice(0, NAME_LIMIT - 1)}…`;
}

type Built = { ok: true; task: ScheduleTask } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** The fields every kind of task shares, once `when` is known. */
type TaskBase = Omit<ScheduleTask, 'name' | 'run'>;

/**
 * Turn `schedule add` into a task, or say exactly what is wrong with it. Every refusal names the
 * flag and the fix, because the reader is an agent that will retry with whatever it is told.
 */
export function buildTask(input: NewTaskInput, ctx: NewTaskContext): Built {
  if ((input.cron === undefined) === (input.at === undefined)) return fail('give exactly one of --cron <expr> or --at <time>');
  if ((input.prompt === undefined) === (input.bash === undefined)) {
    return fail('give exactly one of --prompt <text> (an agent runs it) or --bash <command> (the daemon runs it)');
  }
  if (input.model !== undefined && !input.model.trim()) return fail('--model is empty');
  // A daily session means "the rest of today joins the first run" — a one-shot has no rest of
  // the day to join, and the run after it would be a different task.
  if (input.session === 'daily' && input.at !== undefined) {
    return fail('--session daily needs --cron: a one-shot --at has no rest of the day to join; use --session new for a one-off topic');
  }
  const when = parseWhen(input, ctx);
  if ('error' in when) return fail(when.error);

  const base: TaskBase = {
    id: ctx.id,
    when,
    target: {
      platform: ctx.target.platform,
      channel: ctx.target.address.channel,
      ...(ctx.target.address.thread ? { thread: ctx.target.address.thread } : {}),
    },
    state: 'active',
    createdAt: ctx.now,
    createdBy: { conversation: ctx.from.key, platform: ctx.from.platform },
    runs: 0,
  };
  if (input.bash !== undefined) return buildBashTask(input, input.bash, ctx, base);
  if (input.timeoutMs !== undefined) return fail('--timeout is for --bash tasks; an agent turn is bounded by the gateway itself');
  const prompt = input.prompt!;
  if (!prompt.trim()) return fail('--prompt is empty');
  switch (input.session ?? 'fixed') {
    case 'fixed':
      return buildFixedTask(input, prompt, ctx, base);
    case 'new':
      return buildFreshTask(input, prompt, ctx, base);
    case 'daily':
      return buildDailyTask(input, prompt, ctx, base);
  }
}

function parseWhen(input: NewTaskInput, ctx: NewTaskContext): ScheduleWhen | { error: string } {
  const tz = input.tz ?? ctx.defaultTz;
  try {
    assertTimeZone(tz);
  } catch {
    return { error: `unknown time zone "${tz}" (use an IANA name such as Asia/Shanghai)` };
  }
  if (input.cron !== undefined) {
    try {
      cronsFor(input.cron, tz);
    } catch (e) {
      return { error: `--cron: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { cron: input.cron.trim(), tz };
  }
  const at = parseAt(input.at!, tz, ctx.now);
  if (at === undefined) {
    return {
      error: `--at "${input.at}" is not a time I can read; use +30m / +2h, 08:00, "2026-10-01 08:00" (in --tz), or an ISO time with a zone`,
    };
  }
  if (at <= ctx.now) return { error: `--at ${formatInZone(at, tz)} (${tz}) is already in the past` };
  return { at, tz };
}

function buildBashTask(input: NewTaskInput, command: string, ctx: NewTaskContext, base: TaskBase): Built {
  if (input.session === 'daily') {
    return fail('--session daily is for --prompt tasks: a --bash task is run by the daemon and has no conversation to keep for the day');
  }
  if (input.model !== undefined) {
    return fail('--model is for --prompt tasks; a --bash task is run by the daemon and has no model of its own');
  }
  if (input.agent !== undefined || input.session !== undefined) {
    return fail('--agent and --session are for --prompt tasks; a --bash task is run by the daemon, not an agent');
  }
  if (!command.trim()) return fail('--bash is empty');
  const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (timeoutMs < 1_000 || timeoutMs > MAX_BASH_TIMEOUT_MS) {
    return fail(`--timeout must be between 1s and ${MAX_BASH_TIMEOUT_MS / 3_600_000}h`);
  }
  const cwd = input.cwd ?? ctx.from.cwd;
  return firstRunCheck(
    {
      ...base,
      name: input.name?.trim() || defaultName(command),
      run: { kind: 'bash', command, timeoutMs, ...(cwd ? { cwd } : {}), ...(ctx.from.host ? { host: ctx.from.host } : {}) },
    },
    ctx.now
  );
}

function checkAgent(agent: string, ctx: NewTaskContext): string | undefined {
  return ctx.agents.includes(agent) ? undefined : `unknown agent "${agent}"; configured: ${ctx.agents.join(', ')}`;
}

/** One conversation, one agent, 24 hours. */
function buildFixedTask(input: NewTaskInput, prompt: string, ctx: NewTaskContext, base: TaskBase): Built {
  if (input.model !== undefined) {
    return fail(
      'a fixed-session task runs in this conversation, whose model is set with /model there and belongs to whoever is talking; use --session new or --session daily to give a task its own model'
    );
  }
  const conv = ctx.targetConversation;
  if (!conv) {
    return fail('a fixed-session task needs one conversation to run in, and this target does not name one under the current session scope; use --session new');
  }
  if (input.cwd !== undefined) {
    return fail('a fixed-session task runs where its topic already works; /cd there to move it, or use --session new --cwd <dir>');
  }
  const agent = input.agent ?? conv.agent ?? ctx.from.agent;
  const unknown = checkAgent(agent, ctx);
  if (unknown) return fail(unknown);
  if (conv.agent !== undefined && conv.agent !== agent) {
    return fail(`that topic is answered by ${conv.agent} and a topic keeps its agent, so a fixed-session task there runs with ${conv.agent}; use --session new to run ${agent}`);
  }
  const expiresAt = ctx.now + FIXED_SESSION_WINDOW_MS;
  const task: ScheduleTask = {
    ...base,
    name: input.name?.trim() || defaultName(prompt),
    run: { kind: 'agent', agent, prompt, session: 'fixed' },
    conversation: conv.key,
    expiresAt,
  };
  if (nextRunOf(task, ctx.now) === undefined) {
    const tz = task.when.tz;
    return fail(`a fixed-session task only lives ${FIXED_SESSION_WINDOW_MS / 3_600_000}h (until ${formatInZone(expiresAt, tz)} ${tz}) and this schedule has no run before then; use --session new for a longer-lived one`);
  }
  return { ok: true, task };
}

/** A fresh session every run, with no window. */
function buildFreshTask(input: NewTaskInput, prompt: string, ctx: NewTaskContext, base: TaskBase): Built {
  const agent = input.agent ?? ctx.from.agent;
  const unknown = checkAgent(agent, ctx);
  if (unknown) return fail(unknown);
  const cwd = input.cwd ?? ctx.from.cwd;
  const model = input.model?.trim();
  return firstRunCheck(
    {
      ...base,
      name: input.name?.trim() || defaultName(prompt),
      run: { kind: 'agent', agent, prompt, session: 'new', ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) },
    },
    ctx.now
  );
}

/** One session a day: the first run opens the topic, the rest of that day's runs join it. */
function buildDailyTask(input: NewTaskInput, prompt: string, ctx: NewTaskContext, base: TaskBase): Built {
  if (!ctx.canOpenTopic) {
    return fail(
      '--session daily needs a target that can open a topic with no message to reply to (the web UI, a Telegram forum group): ' +
        'each day gets its own conversation, and without one the runs would have nowhere the user can reply; ' +
        'use --session new to post into the chat instead'
    );
  }
  const agent = input.agent ?? ctx.from.agent;
  const unknown = checkAgent(agent, ctx);
  if (unknown) return fail(unknown);
  const cwd = input.cwd ?? ctx.from.cwd;
  const model = input.model?.trim();
  return firstRunCheck(
    {
      ...base,
      name: input.name?.trim() || defaultName(prompt),
      run: { kind: 'agent', agent, prompt, session: 'daily', ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) },
    },
    ctx.now
  );
}

function firstRunCheck(task: ScheduleTask, now: number): Built {
  return nextRunOf(task, now) === undefined ? fail('that schedule never runs') : { ok: true, task };
}

// ─────────────────────────────── changing one ───────────────────────────────

/**
 * What `schedule edit` may change: everything about a task except what it IS (prompt ↔ bash, the
 * session kind) and where it posts (the target). Those are refused by the command itself, with the
 * `rm` + `add` that does mean "a different task"; a type change would silently keep the id, the run
 * count and the last result of something that never ran this way.
 */
export interface EditTaskInput {
  name?: string;
  cron?: string;
  at?: string;
  tz?: string;
  prompt?: string;
  bash?: string;
  agent?: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Change a task in place, or say exactly what is wrong with the change.
 *
 * The merged task goes through `buildTask` unchanged, so every rule is the one `schedule add`
 * enforces — the same refusals, word for word. What edit adds is what the id means: the task keeps
 * its identity (id, createdAt, runs, lastRun), its state, its target and — for a fixed session —
 * the window it was registered with, because an edit is not a new registration and must not
 * extend how long a schedule may talk into someone's own conversation.
 *
 * A refusal is a value, not a throw, and nothing is written: the caller still holds the old task.
 */
export function editTask(task: ScheduleTask, input: EditTaskInput, ctx: NewTaskContext): Built {
  const blocked = editRefusal(task, input);
  if (blocked) return fail(blocked);

  const built = buildTask(mergedInput(task, input), ctx);
  if (!built.ok) return built;

  const edited = preserveTask(task, built.task);
  // A new time rule starts now. Carrying the old lastPlannedAt over would let a schedule that
  // never existed catch up a run it "missed" — an edit at 10:00 to "0 9 * * *" would fire at once
  // (inside the catch-up grace) while the card says tomorrow 09:00. Keeping it when the rule did
  // not change is the other half: renaming a task must not swallow a run that is already due.
  const next = sameWhen(task.when, edited.when) ? edited : { ...edited, lastPlannedAt: ctx.now };

  const windowProblem = fixedWindowProblem(next, ctx.now);
  if (windowProblem) return fail(windowProblem);
  return { ok: true, task: withoutStaleDayTopic(task, next) };
}

/** What an edit refuses before `buildTask` is even asked: a task that is over, or a type change. */
function editRefusal(task: ScheduleTask, input: EditTaskInput): string | undefined {
  if (task.state === 'expired') {
    return `#${task.id} has expired (a fixed-session task lives ${FIXED_SESSION_WINDOW_MS / 3_600_000}h); add a new task instead`;
  }
  if (task.state === 'done') {
    return `#${task.id} was a one-time task and has already had its run; add a new task instead`;
  }
  if (input.prompt !== undefined && input.bash !== undefined) {
    return 'give at most one of --prompt <text> or --bash <command>';
  }
  if (task.run.kind === 'bash' && input.prompt !== undefined) {
    return `#${task.id} is a --bash task, and edit does not change a task's kind; \`talkcode schedule rm ${task.id}\` and add the prompt task instead`;
  }
  if (task.run.kind === 'agent' && input.bash !== undefined) {
    return `#${task.id} is a --prompt task, and edit does not change a task's kind; \`talkcode schedule rm ${task.id}\` and add the bash task instead`;
  }
  return undefined;
}

/**
 * `buildTask` builds a NEW task: it stamps createdAt and expiresAt, starts at zero runs and has no
 * history. All of that belongs to the task being edited, not to the edit.
 */
function preserveTask(task: ScheduleTask, built: ScheduleTask): ScheduleTask {
  const { expiresAt: _newWindow, ...fresh } = built;
  return {
    ...fresh,
    id: task.id,
    createdAt: task.createdAt,
    createdBy: task.createdBy,
    target: task.target,
    state: task.state,
    runs: task.runs,
    ...(task.lastRun !== undefined ? { lastRun: task.lastRun } : {}),
    ...(task.conversation !== undefined ? { conversation: task.conversation } : {}),
    ...(task.expiresAt !== undefined ? { expiresAt: task.expiresAt } : {}),
    ...(task.lastPlannedAt !== undefined ? { lastPlannedAt: task.lastPlannedAt } : {}),
    ...(task.daySession !== undefined ? { daySession: task.daySession } : {}),
  };
}

/**
 * buildTask checked the window it would have given a NEW task (24h from now); this task keeps the
 * one it was registered with, which may be closer. Returns the refusal, or undefined.
 */
function fixedWindowProblem(task: ScheduleTask, now: number): string | undefined {
  if (task.run.kind !== 'agent' || task.run.session !== 'fixed' || task.expiresAt === undefined) return undefined;
  const first = nextRunOf({ ...task, state: 'active' }, now);
  if (first !== undefined && first <= task.expiresAt) return undefined;
  return (
    `a fixed-session task lives until ${formatInZone(task.expiresAt, task.when.tz)} ${task.when.tz} (24h from registration) and the new schedule has no run before then; ` +
    `\`talkcode schedule rm ${task.id}\` and add it again with --session new for a longer-lived one`
  );
}

/**
 * A daily task's topic for today is one conversation with one agent and one working directory,
 * and a topic keeps its agent. An edit that changes either cannot go on in it — the remaining runs
 * today would each be skipped ("this topic is now answered by …"). So the day's topic is left as
 * it is, like yesterday's, and the next run opens a new one for the rest of the day. Changing only
 * the prompt, name, time or model keeps the topic: the day's context survives, and a model is
 * applied per run anyway (unless a person set it by hand — see personModel).
 */
function withoutStaleDayTopic(task: ScheduleTask, next: ScheduleTask): ScheduleTask {
  if (task.run.kind !== 'agent' || task.run.session !== 'daily' || next.run.kind !== 'agent') return next;
  if (next.run.agent === task.run.agent && next.run.cwd === task.run.cwd) return next;
  const { daySession: _oldDay, ...rest } = next;
  return rest;
}

/**
 * The task's own fields, with what was given laid over them — the input `buildTask` validates.
 *
 * `from` in the context deliberately carries no cwd or agent of its own: every default here is the
 * task's current value, so an edit that does not name a field cannot quietly adopt the caller's
 * directory or agent.
 */
function mergedInput(task: ScheduleTask, input: EditTaskInput): NewTaskInput {
  const run = task.run;
  const common: NewTaskInput = {
    name: input.name ?? task.name,
    ...mergedTime(task, input),
    tz: input.tz ?? task.when.tz,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : run.cwd !== undefined ? { cwd: run.cwd } : {}),
  };
  if (run.kind === 'bash') {
    return {
      ...common,
      bash: input.bash ?? run.command,
      timeoutMs: input.timeoutMs ?? run.timeoutMs,
      // Passed through, not merged away: buildBashTask is what refuses them, in its own words.
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
  }
  return {
    ...common,
    prompt: input.prompt ?? run.prompt,
    session: run.session,
    agent: input.agent ?? run.agent,
    ...(input.model !== undefined ? { model: input.model } : run.model !== undefined ? { model: run.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}

function sameWhen(a: ScheduleWhen, b: ScheduleWhen): boolean {
  if (a.tz !== b.tz) return false;
  if ('cron' in a) return 'cron' in b && a.cron === b.cron;
  return 'at' in b && a.at === b.at;
}

/**
 * The time rule an edit leaves behind: what was given, else the task's own.
 *
 * Both given are passed through together, so buildTask refuses with add's "exactly one of" rather
 * than this function silently choosing cron.
 */
function mergedTime(task: ScheduleTask, input: EditTaskInput): Pick<NewTaskInput, 'cron' | 'at'> {
  if (input.cron !== undefined && input.at !== undefined) return { cron: input.cron, at: input.at };
  if (input.cron !== undefined) return { cron: input.cron };
  if (input.at !== undefined) return { at: input.at };
  if ('cron' in task.when) return { cron: task.when.cron };
  // The one form that keeps the exact instant: a wall-clock string would be read in the task's
  // zone and could land a second off across a DST change.
  return { at: new Date(task.when.at).toISOString() };
}

// ─────────────────────────────── saying things ───────────────────────────────

/** `\`0 8 * * *\` (Asia/Shanghai)` / `once at …` — plus the zone, which is what makes the time mean something. */
export function describeWhen(when: ScheduleWhen, plain = false): string {
  const tick = plain ? '' : '`';
  return 'cron' in when ? `${tick}${when.cron}${tick} (${when.tz})` : `once at ${formatInZone(when.at, when.tz)} (${when.tz})`;
}

export function describeRun(run: ScheduleRun): string {
  if (run.kind === 'bash') return 'bash';
  const session =
    run.session === 'fixed' ? 'fixed session' : run.session === 'daily' ? 'one session a day' : 'new session each run';
  return `${run.agent}${run.model ? ` · ${run.model}` : ''} · ${session}`;
}

/**
 * ` · next <time>` for a recurring task that will run again, else nothing — a one-shot's `when`
 * already IS its next run, and saying the same time twice reads as two different things.
 */
export function nextSuffix(task: ScheduleTask, now: number): string {
  if (!('cron' in task.when)) return '';
  const next = nextRunOf(task, now);
  return next !== undefined ? ` · next ${formatInZone(next, task.when.tz)}` : '';
}

export function targetId(t: ScheduleTarget): string {
  return formatTarget(t.platform, t.thread ? { channel: t.channel, thread: t.thread } : { channel: t.channel });
}

const STATE_LABEL: Record<ScheduleState, string> = {
  active: 'active',
  paused: '⏸ paused',
  expired: '⌛ expired',
  done: '✔ done',
};

const STATUS_LABEL: Record<ScheduleRunStatus, string> = {
  ok: '✅',
  failed: '❌',
  interrupted: '⏹ interrupted',
  skipped: '⏭ skipped',
  missed: '⌛ missed',
};

export function describeLastRun(task: ScheduleTask): string {
  const last = task.lastRun;
  if (!last) return 'not run yet';
  const tz = task.when.tz;
  return `${STATUS_LABEL[last.status]} ${formatInZone(last.at, tz)}${last.error ? ` — ${last.error}` : ''}`;
}

/** What the task does, in one quoted line. */
function body(task: ScheduleTask): string {
  const text = task.run.kind === 'bash' ? task.run.command : task.run.prompt;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/**
 * The card posted when a task is registered, changed or removed — by the daemon itself, never left
 * to the agent's retelling, so what the user reads is what will actually run. `verb` is the change.
 */
export function taskCardText(task: ScheduleTask, verb: string, now: number): string {
  const tz = task.when.tz;
  const lines = [
    `⏰ Scheduled task ${verb} — \`#${task.id}\` **${task.name}**`,
    `• When: ${describeWhen(task.when)}${nextSuffix(task, now)}`,
    `• Runs: ${describeRun(task.run)}${task.expiresAt !== undefined ? ` · until ${formatInZone(task.expiresAt, tz)}` : ''}`,
    `• Posts to: \`${targetId(task.target)}\``,
    `• ${task.run.kind === 'bash' ? 'Command' : 'Prompt'}: ${body(task)}`,
  ];
  if (task.state !== 'active') lines.push(`• State: ${STATE_LABEL[task.state]}`);
  lines.push('`/setting schedule` lists, pauses and deletes tasks.');
  return lines.join('\n');
}

/** One line per task, for `/setting schedule` where there are no buttons. */
export function taskListText(tasks: readonly ScheduleTask[], now: number): string {
  if (tasks.length === 0) {
    return 'No scheduled tasks. An agent registers one with `talkcode schedule add` — ask for "every morning at 8, …" in any conversation.';
  }
  return ['**Scheduled tasks**', ...tasks.map((t) => taskLine(t, now))].join('\n');
}

export function taskLine(task: ScheduleTask, now: number): string {
  const next = nextSuffix(task, now);
  const state = next ? next.replace(/^ · /, '') : STATE_LABEL[task.state];
  return `\`#${task.id}\` **${task.name}** — ${describeWhen(task.when)} · ${describeRun(task.run)} · ${state} · last ${describeLastRun(task)}`;
}

/** The notice that opens a run in the chat, so output that arrives unasked says where it came from. */
export function runNoticeText(task: ScheduleTask, planned: number): string {
  return `⏰ Scheduled task \`#${task.id}\` **${task.name}** · ${formatInZone(planned, task.when.tz)}\n> ${body(task)}`;
}

/** Posted where a fixed-session task ran, when its window closes. */
export function taskExpiredText(task: ScheduleTask): string {
  return `⌛ Scheduled task \`#${task.id}\` **${task.name}** has expired — a fixed-session task lives ${FIXED_SESSION_WINDOW_MS / 3_600_000}h. It ran ${task.runs} time(s). Ask for it again with a new session if it should keep going.`;
}

/**
 * A task flattened for the CLI's TOON table: every value a string, number or boolean, the same keys
 * on every row. `detail` adds what it does and where, for `schedule show`; `here` marks the tasks
 * the asking conversation registered or runs in.
 */
export function taskView(task: ScheduleTask, now: number, opts: { detail?: boolean; here?: string } = {}) {
  const tz = task.when.tz;
  const next = nextRunOf(task, now);
  const view = {
    id: task.id,
    name: task.name,
    state: task.state,
    when: describeWhen(task.when, true),
    next: next !== undefined ? formatInZone(next, tz) : '',
    runs: describeRun(task.run),
    target: targetId(task.target),
    last: task.lastRun ? `${task.lastRun.status} ${formatInZone(task.lastRun.at, tz)}${task.lastRun.error ? ` (${task.lastRun.error})` : ''}` : '',
    count: task.runs,
    expires: task.expiresAt !== undefined ? formatInZone(task.expiresAt, tz) : '',
    here: opts.here !== undefined && (task.createdBy.conversation === opts.here || task.conversation === opts.here),
  };
  if (!opts.detail) return view;
  return {
    ...view,
    ...(task.run.kind === 'bash'
      ? { command: task.run.command, timeout: formatDuration(task.run.timeoutMs) }
      : { prompt: task.run.prompt, ...(task.run.model ? { model: task.run.model } : {}) }),
    cwd: task.run.cwd ?? '',
  };
}

/** How much of a bash task's output is shown inline; the rest is in the attached log. */
export const BASH_INLINE_LIMIT = 3_000;

export interface BashOutcome {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  tail: string;
  bytes: number;
  spawnError?: string;
  durationMs: number;
}

/** Map a bash outcome onto a run status, with the reason worth keeping in the task's record. */
export function bashStatus(r: BashOutcome, timeoutMs: number): { status: 'ok' | 'failed' | 'interrupted'; error?: string } {
  if (r.spawnError) return { status: 'failed', error: r.spawnError };
  if (r.aborted) return { status: 'interrupted', error: 'the gateway stopped while it ran' };
  if (r.timedOut) return { status: 'failed', error: `timed out after ${formatDuration(timeoutMs)}` };
  if (r.exitCode !== 0) return { status: 'failed', error: `exit ${r.exitCode ?? 'signal'}` };
  return { status: 'ok' };
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The message a bash run posts: status line, then the end of the output in a code fence. The fence
 * is one backtick longer than any run of backticks in the output, so output that itself contains a
 * fence cannot close it early. `attach` says the full log should follow as a file.
 */
export function bashResultText(task: ScheduleTask, r: BashOutcome, timeoutMs: number): { text: string; attach: boolean } {
  const { status, error } = bashStatus(r, timeoutMs);
  const mark = status === 'ok' ? '✅' : status === 'interrupted' ? '⏹' : '❌';
  const head = `⏰ \`#${task.id}\` **${task.name}** · ${mark} ${error ?? `exit ${r.exitCode}`} · ${formatDuration(r.durationMs)}`;
  const out = r.tail.replace(/\s+$/, '');
  if (!out) return { text: `${head}\n(no output)`, attach: false };
  const cut = out.length > BASH_INLINE_LIMIT || r.bytes > Buffer.byteLength(r.tail);
  const shown = out.length > BASH_INLINE_LIMIT ? out.slice(out.length - BASH_INLINE_LIMIT) : out;
  const longest = Math.max(0, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const note = cut ? `\n…last ${shown.length} characters of ${r.bytes} bytes; the full output is attached.` : '';
  return { text: `${head}\n${fence}\n${shown}\n${fence}${note}`, attach: cut };
}
