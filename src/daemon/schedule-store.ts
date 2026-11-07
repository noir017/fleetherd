import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { normalizeTags, type ScheduleTask } from '../core/schedule.js';

/**
 * Scheduled tasks on disk (`<configDir>/schedules.json`) — its own file, not a section of
 * conversations.json, because a task is not a property of a conversation: a bash task has none, a
 * new-session task makes a fresh one every run, and deleting a topic must not delete a schedule.
 *
 * ── What is different from the other state files ──────────────────────────────────────────────
 * - **0600, written atomically** (temp file + rename). This file holds shell commands the daemon
 *   will execute unattended, so it is not world-readable, and a crash mid-write must leave either
 *   the old file or the new one — never a truncated one that drops every task.
 * - **A bad entry is dropped LOUDLY.** conversations.json degrades quietly because losing a binding
 *   costs a restart of context; losing a task means something the user is counting on silently
 *   stops happening. So each rejected entry is logged with its id and the reason, and the rest load.
 *
 * Write-through on every change, like the other stores. Tasks are few; the whole file is rewritten.
 */

const TargetSchema = z.object({ platform: z.string().min(1), channel: z.string().min(1), thread: z.string().min(1).optional() });
const AddressSchema = z.object({ channel: z.string().min(1), thread: z.string().min(1).optional() }).strict();

const WhenSchema = z.union([
  z.object({ cron: z.string().min(1), tz: z.string().min(1) }).strict(),
  z.object({ at: z.number().finite(), tz: z.string().min(1) }).strict(),
]);

const RunSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      agent: z.string().min(1),
      prompt: z.string().min(1),
      session: z.enum(['fixed', 'new', 'daily']),
      cwd: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bash'),
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive(),
      host: z.string().min(1).optional(),
    })
    .strict(),
]);

const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]{4,16}$/),
    name: z.string().min(1),
    // Optional is the migration: every file written before tags existed has none. The bound is
    // only a shape guard; normalizeTags below is the rule itself, so a hand-edited file cannot
    // load a tag the panel would then show differently from what an edit would store.
    tags: z.array(z.string().max(200)).max(50).optional(),
    when: WhenSchema,
    run: RunSchema,
    target: TargetSchema,
    conversation: z.string().min(1).optional(),
    // Absent in every file written before daily sessions existed, and absent on a daily task
    // until its first run of a day — optional is the migration.
    daySession: z
      .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        conversation: z.string().min(1),
        address: AddressSchema,
        // A person chose the model here during the day; see ScheduleDaySession.
        personModel: z.boolean().optional(),
      })
      .strict()
      .optional(),
    state: z.enum(['active', 'paused', 'expired', 'done']),
    createdAt: z.number().finite(),
    createdBy: z.object({ conversation: z.string(), platform: z.string() }),
    expiresAt: z.number().finite().optional(),
    lastPlannedAt: z.number().finite().optional(),
    lastRun: z
      .object({
        at: z.number().finite(),
        status: z.enum(['ok', 'failed', 'interrupted', 'skipped', 'missed']),
        durationMs: z.number().finite().optional(),
        exitCode: z.number().int().optional(),
        error: z.string().optional(),
      })
      .optional(),
    runs: z.number().int().nonnegative(),
  })
  .superRefine((t, ctx) => {
    // The one cross-field rule the scheduler depends on: a fixed-session run has to know where.
    if (t.run.kind === 'agent' && t.run.session === 'fixed' && !t.conversation) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a fixed-session task has no conversation' });
    }
    // A daily task's day comes from its cron; a one-shot has no second run to join.
    if (t.run.kind === 'agent' && t.run.session === 'daily' && 'at' in t.when) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a daily-session task needs a cron, not a one-shot time' });
    }
    // buildTask refuses this too; repeated here so a hand-edited file cannot give a task a model
    // for a person's own topic, where the model belongs to whoever is talking.
    if (t.run.kind === 'agent' && t.run.session === 'fixed' && t.run.model !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a fixed-session task cannot name a model' });
    }
    // The stored tags must already be what the one rule (core/schedule.ts normalizeTags) produces:
    // lowercase, unique, within the limits. A file that says otherwise is not silently rewritten.
    if (t.tags !== undefined) {
      const normalized = normalizeTags(t.tags);
      if (!normalized.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: normalized.error });
      } else if (normalized.tags.length !== t.tags.length || normalized.tags.some((tag, i) => tag !== t.tags![i])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: 'tags are not normalized (lowercase, unique, trimmed)' });
      }
    }
  });

// Drift between the persisted shape and the domain type fails to compile.
type _Aligned = [
  z.infer<typeof TaskSchema> extends ScheduleTask ? true : never,
  ScheduleTask extends z.infer<typeof TaskSchema> ? true : never,
];
const _aligned: _Aligned = [true, true];

export class ScheduleStore {
  private tasks = new Map<string, ScheduleTask>();

  constructor(private readonly file: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[schedule] ${this.file} could not be read; starting with no tasks: ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    const entries = raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
      ? ((raw as { tasks: unknown[] }).tasks)
      : [];
    for (const entry of entries) {
      const parsed = TaskSchema.safeParse(entry);
      if (parsed.success) {
        this.tasks.set(parsed.data.id, parsed.data);
      } else {
        const id = (entry as { id?: unknown } | null)?.id;
        const issue = parsed.error.issues[0];
        console.error(
          `[schedule] dropped task ${typeof id === 'string' ? `#${id}` : '(no id)'} from ${this.file}: ` +
            `${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim()
        );
      }
    }
  }

  /** Give agents new ids (agent-renames.ts) in the tasks that run them. Returns how many changed. */
  renameAgents(renames: ReadonlyMap<string, string>): number {
    let changed = 0;
    for (const t of this.tasks.values()) {
      const next = t.run.kind === 'agent' ? renames.get(t.run.agent) : undefined;
      if (t.run.kind !== 'agent' || !next) continue;
      t.run.agent = next;
      changed++;
    }
    if (changed) this.flush();
    return changed;
  }

  list(): ScheduleTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ScheduleTask | undefined {
    return this.tasks.get(id);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Insert or replace, then persist. */
  put(task: ScheduleTask): void {
    this.tasks.set(task.id, task);
    this.flush();
  }

  remove(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) this.flush();
    return removed;
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.list() }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[schedule] failed to persist tasks:', e instanceof Error ? e.message : e);
    }
  }
}
