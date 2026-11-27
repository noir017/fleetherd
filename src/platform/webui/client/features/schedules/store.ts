import type { SchedulePanelAction, SchedulePanelTask, SchedulePanelTaskDetail } from '../../../../workbench.js';
import { Emitter, type Event } from '../../base/event.js';
import { type Disposable } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { createNewTaskDetail, errorMessage } from './helpers.js';
import type {
  ScheduleDetailResponse,
  ScheduleFormResponse,
  ScheduleOpResponse,
  SchedulesListResponse,
  SchedulesPluginDeps,
  TaskEditPayload,
  TaskPageDetail,
} from './types.js';

export interface SchedulesStoreSnapshot {
  readonly enabled: boolean;
  readonly tasks: readonly SchedulePanelTask[] | null;
  readonly busy: boolean;
  readonly note: string | null;
}

export class SchedulesStore implements Disposable {
  private readonly _ctx: PluginContext;
  private readonly _deps: SchedulesPluginDeps;
  private readonly _onDidChange = new Emitter<void>();
  private _enabled = true;
  private _tasks: SchedulePanelTask[] | null = null;
  private _busy = false;
  private _note: string | null = null;
  private _seq = 0;
  private _disposed = false;

  readonly onDidChange: Event<void> = this._onDidChange.event;

  constructor(ctx: PluginContext, deps: SchedulesPluginDeps) {
    this._ctx = ctx;
    this._deps = deps;
  }

  snapshot(): SchedulesStoreSnapshot {
    return {
      enabled: this._enabled,
      tasks: this._tasks,
      busy: this._busy,
      note: this._note,
    };
  }

  getTask(id: string | null | undefined): SchedulePanelTask | null {
    if (!id || !this._tasks) return null;
    return this._tasks.find((t) => t.id === id) ?? null;
  }

  hasRunningTask(): boolean {
    return Boolean(this._tasks?.some((t) => t.running));
  }

  clearNote(): void {
    if (this._note === null) return;
    this._note = null;
    this._onDidChange.fire();
  }

  setNote(msg: string | null): void {
    this._note = msg;
    this._onDidChange.fire();
  }

  async loadTasks(): Promise<void> {
    if (this._disposed) return;
    const seq = ++this._seq;
    this._note = null;
    try {
      const data = await this._ctx.api.get<SchedulesListResponse>('/api/schedules');
      if (this._disposed || seq !== this._seq) return;
      this._enabled = data.enabled !== false;
      this._tasks = data.tasks ?? [];
      this._onDidChange.fire();
      this._deps.onBadgeChange?.();
    } catch (err) {
      if (this._disposed || seq !== this._seq) return;
      this._note = tr('sched.refreshFailed', { err: errorMessage(err) });
      this._onDidChange.fire();
    }
  }

  async runOp(
    id: string,
    action: SchedulePanelAction,
    tags?: readonly string[],
  ): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (this._disposed || this._busy) return { ok: false, error: tr('common.didNotWork') };
    this._busy = true;
    this._note = null;
    this._onDidChange.fire();
    const body = tags !== undefined ? { id, action, tags } : { id, action };
    try {
      const res = await this._ctx.api.post<ScheduleOpResponse>('/api/schedules/op', body);
      if (this._disposed) return { ok: false };
      if (res.ok && res.tasks) {
        this._tasks = res.tasks;
        this._deps.onOp?.(id, action);
        this._deps.onBadgeChange?.();
        return { ok: true };
      }
      const err = res.error || tr('common.didNotWork');
      this._note = err;
      return { ok: false, error: err };
    } catch (err) {
      const msg = tr('common.reachDaemonWithErr', { err: errorMessage(err) });
      if (!this._disposed) this._note = msg;
      return { ok: false, error: msg };
    } finally {
      this._busy = false;
      if (!this._disposed) this._onDidChange.fire();
    }
  }

  async fetchTaskDetail(
    id: string,
  ): Promise<{ readonly ok: true; readonly detail: SchedulePanelTaskDetail } | { readonly ok: false; readonly error: string }> {
    try {
      const res = await this._ctx.api.get<ScheduleDetailResponse>(
        `/api/schedules/task?id=${encodeURIComponent(id)}`,
      );
      if (res.ok && res.detail) {
        const latest = this.getTask(id);
        if (latest) res.detail.task = latest;
        return { ok: true, detail: res.detail };
      }
      return { ok: false, error: res.error || tr('taskPage.loadErr') };
    } catch (err) {
      return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
    }
  }

  async fetchNewForm(): Promise<
    { readonly ok: true; readonly detail: TaskPageDetail } | { readonly ok: false; readonly error: string }
  > {
    try {
      const res = await this._ctx.api.get<ScheduleFormResponse>('/api/schedules/form');
      if (res.ok && res.form) {
        return { ok: true, detail: createNewTaskDetail(res.form) };
      }
      return { ok: false, error: res.error || tr('taskPage.formErr') };
    } catch (err) {
      return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
    }
  }

  async saveTask(
    id: string | null,
    isNew: boolean,
    edit: TaskEditPayload,
  ): Promise<{ readonly ok: true; readonly detail: SchedulePanelTaskDetail } | { readonly ok: false; readonly error: string }> {
    const path = isNew ? '/api/schedules/add' : '/api/schedules/edit';
    const body = isNew ? { task: edit } : { id, edit };
    try {
      const res = await this._ctx.api.post<ScheduleDetailResponse>(path, body);
      if (res.ok && res.detail) {
        if (res.tasks) {
          this._tasks = res.tasks;
          this._onDidChange.fire();
          this._deps.onBadgeChange?.();
        }
        return { ok: true, detail: res.detail };
      }
      return { ok: false, error: res.error || tr('common.didNotWork') };
    } catch (err) {
      return { ok: false, error: tr('common.reachDaemonWithErr', { err: errorMessage(err) }) };
    }
  }

  dispose(): void {
    this._disposed = true;
    this._onDidChange.dispose();
  }
}
