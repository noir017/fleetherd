import type {
  SchedulePanelAction,
  SchedulePanelSetting,
  SchedulePanelShape,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  openConfirmDialog,
  renderBadge,
  renderNotice,
  renderSegmented,
  renderStatusDot,
  type NoticeTone,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  buildTaskEditDiff,
  formatClock,
  formatDueIn,
  formatLastRun,
  formatRelativeAge,
  initialFormValues,
  isFormDirty,
  listTimeZones,
  parseTagList,
  resolveFormShape,
  resolveTargetShort,
  taskAssociatedSessions,
  type TaskFormValues,
  taskTags,
} from './helpers.js';
import { renderRunsTableSection, type RunStatusFilter } from './runs-table.js';
import type { SchedulesStore } from './store.js';
import type {
  ScheduleEditorInput,
  ScheduleEditorMode,
  SchedulePanelComponent,
  SchedulePanelInitContext,
  SchedulesPluginDeps,
  TaskPageDetail,
} from './types.js';

interface EditorNotice {
  readonly tone: NoticeTone;
  readonly message: string;
}

function parseInput(raw: unknown): { id: string | null; mode: ScheduleEditorMode; title?: string } {
  if (!raw || typeof raw !== 'object') return { id: null, mode: 'new' };
  const rec = raw as ScheduleEditorInput;
  const id = typeof rec.id === 'string' && rec.id ? rec.id : null;
  const mode: ScheduleEditorMode =
    rec.mode === 'new' || (!id && rec.mode !== 'edit')
      ? 'new'
      : rec.mode === 'edit'
        ? 'edit'
        : 'view';
  return { id, mode, title: typeof rec.title === 'string' ? rec.title : undefined };
}

function taskMoved(next: SchedulePanelTask, prev: SchedulePanelTask): boolean {
  return (
    next.runs !== prev.runs ||
    Boolean(next.running) !== Boolean(prev.running) ||
    next.state !== prev.state ||
    (next.last?.at ?? 0) !== (prev.last?.at ?? 0)
  );
}

function sessionHintText(shape: SchedulePanelShape): string {
  if (shape === 'fixed') return tr('taskPage.sessionFixedHint');
  if (shape === 'daily') return tr('taskPage.sessionDailyHint');
  return tr('taskPage.sessionNewHint');
}

function targetHintText(other: boolean, shape: SchedulePanelShape): string {
  if (other) return tr('taskPage.targetOtherHint');
  if (shape === 'bash') return tr('taskPage.targetBashHint');
  if (shape === 'fixed') return tr('taskPage.targetFixedHint');
  return tr('taskPage.targetNewHint');
}

function renderViewActions(
  detail: SchedulePanelTaskDetail,
  busy: boolean,
  onAction: (action: 'edit' | 'pause' | 'resume' | 'run' | 'remove') => void,
): TemplateResult {
  const t = detail.task;
  const taskState = t.state || 'active';
  return html`<div class="tp-acts">
    ${!detail.locked
      ? html`<button type="button" class="fh-btn fh-btn--primary" data-tp-act="edit" ?disabled=${busy} @click=${() => onAction('edit')}>
          ${unsafeHTML(icon('pencil'))}<span>${tr('common.edit')}</span>
        </button>`
      : nothing}
    ${taskState === 'active'
      ? html`<button type="button" class="fh-btn fh-btn--secondary" data-tp-act="pause" ?disabled=${busy} @click=${() => onAction('pause')}>
          ${unsafeHTML(icon('pause'))}<span>${tr('sched.pause')}</span>
        </button>`
      : nothing}
    ${taskState === 'paused'
      ? html`<button type="button" class="fh-btn fh-btn--secondary" data-tp-act="resume" ?disabled=${busy} @click=${() => onAction('resume')}>
          ${unsafeHTML(icon('play'))}<span>${tr('sched.resume')}</span>
        </button>`
      : nothing}
    ${taskState === 'active' || taskState === 'paused'
      ? html`<button
          type="button"
          class="fh-btn fh-btn--secondary"
          data-tp-act="run"
          ?disabled=${busy || t.running}
          title=${t.running ? tr('sched.runNowBusyTitle') : tr('sched.runNowTitle')}
          @click=${() => onAction('run')}
        >${unsafeHTML(icon('clock'))}<span>${tr('sched.runNow')}</span></button>`
      : nothing}
    <button type="button" class="fh-btn fh-btn--danger" data-tp-act="remove" ?disabled=${busy} @click=${() => onAction('remove')}>
      ${unsafeHTML(icon('trash'))}<span>${tr('common.delete')}</span>
    </button>
  </div>`;
}

function renderViewTags(
  t: SchedulePanelTask,
  onRemoveTag: (tag: string) => void,
  onAddTags: (raw: string, input: HTMLInputElement) => void,
): TemplateResult {
  return html`<div class="tp-label">${tr('sched.tags')}</div>
    <div class="sched-tag-edit">
      ${taskTags(t).map((tag) => {
        const removeLabel = tr('taskPage.removeTag', { tag });
        return html`<span class="sched-tag">
          ${unsafeHTML(icon('tag'))}
          <span>${tag}</span>
          <button
            type="button"
            class="sched-tag-x"
            data-tag-del=${tag}
            title=${removeLabel}
            aria-label=${removeLabel}
            @click=${() => onRemoveTag(tag)}
          >${unsafeHTML(icon('cross'))}</button>
        </span>`;
      })}
      <span class="sched-tag-add">
        ${unsafeHTML(icon('plus'))}
        <input
          type="text"
          data-tag-input="1"
          placeholder=${tr('taskPage.tagPlaceholder')}
          aria-label=${tr('taskPage.addTagAria')}
          autocomplete="off"
          spellcheck="false"
          @keydown=${(ev: KeyboardEvent) => {
            if (ev.key === 'Enter' && !ev.isComposing) {
              ev.preventDefault();
              const input = ev.currentTarget as HTMLInputElement;
              onAddTags(input.value, input);
            }
          }}
        />
      </span>
    </div>`;
}

function renderViewSessions(
  detail: SchedulePanelTaskDetail,
  topics: readonly TopicInfo[],
  nowMs: number,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  const sessions = taskAssociatedSessions(detail, topics);
  return html`<div class="tp-label">${tr('sideTasks.tabSessions')}<span class="tp-n">${sessions.length}</span></div>
    <div class="tp-list tp-topics">
      ${sessions.length === 0
        ? html`<div class="tp-empty">${detail.task.kind === 'bash' ? tr('taskPage.noSessionsBash') : tr('taskPage.noSessionsAgent')}</div>`
        : sessions.map(
            (s) => html`<div
              class="topic-item tp-sess framed"
              data-tp-topic=${s.id}
              role="button"
              tabindex="0"
              @click=${() => onOpenTopic(s.id)}
              @keydown=${(ev: KeyboardEvent) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onOpenTopic(s.id);
                }
              }}
            >
              ${renderStatusDot({
                status: s.asking ? 'warn' : s.running ? 'ok' : s.stage === 'failed' ? 'err' : 'idle',
                pulsing: Boolean(s.running || s.asking),
              })}
              <span class="topic-main">
                <span class="topic-title">${s.title || tr('common.untitled')}</span>
                <span class="topic-sub"><span class="topic-dir">${s.lastAt ? formatRelativeAge(s.lastAt, nowMs) : ''}</span></span>
              </span>
            </div>`,
          )}
    </div>`;
}

function renderViewContent(
  ctx: PluginContext,
  detail: SchedulePanelTaskDetail,
  topics: readonly TopicInfo[],
  nowMs: number,
  busy: boolean,
  runFilter: RunStatusFilter,
  onRunFilterChange: (next: RunStatusFilter) => void,
  onAction: (action: 'edit' | 'pause' | 'resume' | 'run' | 'remove') => void,
  onRemoveTag: (tag: string) => void,
  onAddTags: (raw: string, input: HTMLInputElement) => void,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  const t = detail.task;
  const f = detail.fields;
  const metaBits = [
    `#${t.id}`,
    tr(t.runs === 1 ? 'taskPage.runCountOne' : 'taskPage.runCountMany', { count: t.runs }),
    t.createdAt ? tr('taskPage.created', { when: formatClock(t.createdAt) }) : '',
    t.expires ? tr('taskPage.until', { when: t.expires }) : '',
  ].filter(Boolean);

  return html`<div class="tp-view">
    ${renderViewActions(detail, busy, onAction)}
    ${detail.locked ? html`<div class="tp-locked">${detail.locked}</div>` : nothing}
    <div class="tp-grid">
      <div>
        <div class="tp-label">${tr('taskPage.schedule')}</div>
        <div class="tp-val tp-mono">${t.when}${t.next ? ` \u00b7 ${tr('sched.nextPrefix', { next: t.next })}` : ''}</div>
      </div>
      <div>
        <div class="tp-label">${tr('taskPage.runsAs')}</div>
        <div class="tp-val">${t.run}</div>
      </div>
      ${f.cwd
        ? html`<div>
            <div class="tp-label">${tr('taskPage.directory')}</div>
            <div class="tp-val tp-mono">${f.cwd}</div>
          </div>`
        : nothing}
      <div>
        <div class="tp-label">${tr('taskPage.postsTo')}</div>
        <div class="tp-val">${resolveTargetShort(t, topics)}</div>
      </div>
    </div>
    <div class="tp-label">${t.kind === 'bash' ? tr('taskPage.command') : tr('taskPage.prompt')}</div>
    <div class="tp-body">${t.detail}</div>
    ${renderViewTags(t, onRemoveTag, onAddTags)}
    <div class="tp-meta">${metaBits.join(' \u00b7 ')}</div>
    ${renderViewSessions(detail, topics, nowMs, onOpenTopic)}
    ${renderRunsTableSection({
      ctx,
      runs: detail.runs,
      filter: runFilter,
      topics,
      onFilterChange: onRunFilterChange,
      onOpenTopic,
    })}
  </div>`;
}

function renderFormRuntimeFields(
  detail: TaskPageDetail,
  values: TaskFormValues,
  keeps: readonly SchedulePanelSetting[],
  onPatch: (patch: Partial<TaskFormValues>) => void,
): TemplateResult {
  const has = (k: SchedulePanelSetting): boolean => keeps.includes(k);
  const agents =
    detail.agents.includes(values.agent) || !values.agent
      ? detail.agents
      : [values.agent, ...detail.agents];
  const machine =
    (values.kind === 'bash' ? values.host : detail.agentHosts[values.agent]) ||
    tr('taskPage.gatewayMachine');

  return html`${has('agent')
      ? html`<label class="tp-label" for="tp-agent">${tr('taskPage.agent')}</label>
          <select
            id="tp-agent"
            class="skill-field"
            .value=${values.agent}
            @change=${(ev: Event) => onPatch({ agent: (ev.currentTarget as HTMLSelectElement).value })}
          >
            ${agents.map(
              (ag) => html`<option value=${ag} ?selected=${ag === values.agent}>
                ${ag}${detail.agentHosts[ag] ? ` \u00b7 ${detail.agentHosts[ag]}` : ''}
              </option>`,
            )}
          </select>`
      : nothing}
    ${has('model')
      ? html`<label class="tp-label" for="tp-model">${tr('taskPage.model')}</label>
          <input
            id="tp-model"
            class="skill-field"
            type="text"
            placeholder=${tr('taskPage.modelPlaceholder')}
            autocomplete="off"
            spellcheck="false"
            .value=${values.model}
            @input=${(ev: Event) => onPatch({ model: (ev.currentTarget as HTMLInputElement).value })}
          />
          <div class="tp-hint">${tr('taskPage.modelHint')}</div>`
      : nothing}
    ${has('host')
      ? html`<label class="tp-label" for="tp-host">${tr('taskPage.machine')}</label>
          <select
            id="tp-host"
            class="skill-field"
            .value=${values.host}
            @change=${(ev: Event) => onPatch({ host: (ev.currentTarget as HTMLSelectElement).value })}
          >
            <option value="" ?selected=${values.host === ''}>${tr('taskPage.gatewayMachineCap')}</option>
            ${detail.hosts.map((host) => html`<option value=${host} ?selected=${host === values.host}>${host}</option>`)}
          </select>`
      : nothing}
    ${has('cwd')
      ? html`<label class="tp-label" for="tp-cwd">${tr('taskPage.directory')}</label>
          <input
            id="tp-cwd"
            class="skill-field tp-mono"
            type="text"
            placeholder=${tr('taskPage.dirPlaceholder')}
            autocomplete="off"
            spellcheck="false"
            .value=${values.cwd}
            @input=${(ev: Event) => onPatch({ cwd: (ev.currentTarget as HTMLInputElement).value })}
          />
          <div class="tp-hint">${tr('taskPage.cwdHint', { machine })}</div>`
      : nothing}
    ${has('timeout')
      ? html`<label class="tp-label" for="tp-timeout">${tr('taskPage.timeout')}</label>
          <input
            id="tp-timeout"
            class="skill-field"
            type="text"
            placeholder="10m"
            autocomplete="off"
            spellcheck="false"
            .value=${values.timeout}
            @input=${(ev: Event) => onPatch({ timeout: (ev.currentTarget as HTMLInputElement).value })}
          />
          <div class="tp-hint">${tr('taskPage.timeoutHint')}</div>`
      : nothing}`;
}

function renderFormScheduleFields(
  detail: TaskPageDetail,
  values: TaskFormValues,
  shape: SchedulePanelShape,
  supportsAt: boolean,
  topics: readonly TopicInfo[],
  timeZones: readonly string[],
  onPatch: (patch: Partial<TaskFormValues>) => void,
): TemplateResult {
  const ownTopic = detail.task?.targetTopic ?? '';
  const selectableTopics = topics.filter((t) => (!t.scheduled && !t.parent) || t.id === ownTopic);
  const effectiveWhenMode = supportsAt ? values.whenMode : 'cron';

  return html`<div class="tp-label">${tr('taskPage.when')}</div>
    ${supportsAt
      ? renderSegmented({
          kind: 'value',
          value: effectiveWhenMode,
          ariaLabel: tr('taskPage.whenAria'),
          options: [
            { value: 'cron', label: tr('taskPage.repeats') },
            { value: 'at', label: tr('taskPage.once') },
          ],
          onChange: (v) => onPatch({ whenMode: v === 'at' ? 'at' : 'cron' }),
        })
      : nothing}
    <div class="tp-row2">
      <div>
        ${effectiveWhenMode === 'at'
          ? html`<input
              id="tp-at"
              class="skill-field"
              type="datetime-local"
              step="1"
              aria-label=${tr('taskPage.atAria')}
              .value=${values.at}
              @input=${(ev: Event) => onPatch({ at: (ev.currentTarget as HTMLInputElement).value })}
            />`
          : html`<input
              id="tp-cron"
              class="skill-field tp-mono"
              type="text"
              placeholder="0 8 * * *"
              aria-label=${tr('taskPage.cronAria')}
              autocomplete="off"
              spellcheck="false"
              .value=${values.cron}
              @input=${(ev: Event) => onPatch({ cron: (ev.currentTarget as HTMLInputElement).value })}
            />`}
      </div>
      <div>
        <input
          id="tp-tz"
          class="skill-field"
          type="text"
          list="tp-tzs"
          aria-label=${tr('taskPage.tzAria')}
          autocomplete="off"
          spellcheck="false"
          .value=${values.tz}
          @input=${(ev: Event) => onPatch({ tz: (ev.currentTarget as HTMLInputElement).value })}
        />
        <datalist id="tp-tzs">
          ${timeZones.map((tz) => html`<option value=${tz}></option>`)}
        </datalist>
      </div>
    </div>
    <div class="tp-hint">${effectiveWhenMode === 'at' ? tr('taskPage.atHint') : tr('taskPage.cronHint')}</div>
    <label class="tp-label" for="tp-target">${tr('taskPage.postsTo')}</label>
    <select
      id="tp-target"
      class="skill-field"
      .value=${values.targetKind}
      @change=${(ev: Event) => onPatch({ targetKind: (ev.currentTarget as HTMLSelectElement).value })}
    >
      ${selectableTopics.map(
        (t) => html`<option value=${`topic:${t.id}`} ?selected=${values.targetKind === `topic:${t.id}`}>
          ${t.title || tr('common.untitled')}
        </option>`,
      )}
      <option value="other" ?selected=${values.targetKind === 'other'}>${tr('taskPage.anotherChat')}</option>
    </select>
    ${values.targetKind === 'other'
      ? html`<input
          id="tp-target-other"
          class="skill-field tp-mono"
          type="text"
          list="tp-chans"
          placeholder="channel-id"
          aria-label=${tr('taskPage.targetOtherAria')}
          autocomplete="off"
          spellcheck="false"
          .value=${values.targetOther}
          @input=${(ev: Event) => onPatch({ targetOther: (ev.currentTarget as HTMLInputElement).value })}
        />`
      : nothing}
    <datalist id="tp-chans">
      ${detail.channels.map((ch) => html`<option value=${ch.id}>${ch.title}</option>`)}
    </datalist>
    <div class="tp-hint">${targetHintText(values.targetKind === 'other', shape)}</div>
    <label class="tp-label" for="tp-tags">${tr('sched.tags')}</label>
    <input
      id="tp-tags"
      class="skill-field"
      type="text"
      placeholder="ci, ops"
      autocomplete="off"
      spellcheck="false"
      .value=${values.tags}
      @input=${(ev: Event) => onPatch({ tags: (ev.currentTarget as HTMLInputElement).value })}
    />
    <div class="tp-hint">${tr('taskPage.tagsHint')}</div>`;
}

function renderFormContent(
  detail: TaskPageDetail,
  values: TaskFormValues,
  isNew: boolean,
  saving: boolean,
  topics: readonly TopicInfo[],
  timeZones: readonly string[],
  onPatch: (patch: Partial<TaskFormValues>) => void,
  onSubmit: () => void,
  onCancel: () => void,
): TemplateResult {
  const shape = resolveFormShape(values.kind, values.session);
  const keeps = detail.shapes[shape] ?? [];
  const saveLabel = saving
    ? isNew
      ? tr('common.adding')
      : tr('common.saving')
    : isNew
      ? tr('common.add')
      : tr('common.save');

  return html`<form
    id="tp-form"
    novalidate
    @submit=${(ev: Event) => {
      ev.preventDefault();
      onSubmit();
    }}
  >
    <label class="tp-label" for="tp-name">${tr('taskPage.name')}</label>
    <input
      id="tp-name"
      class="skill-field"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder=${isNew ? tr('taskPage.namePlaceholder') : ''}
      .value=${values.name}
      @input=${(ev: Event) => onPatch({ name: (ev.currentTarget as HTMLInputElement).value })}
    />
    <div class="tp-label">${tr('taskPage.runs')}</div>
    ${renderSegmented({
      kind: 'value',
      value: values.kind,
      ariaLabel: tr('taskPage.runsAria'),
      options: [
        { value: 'agent', label: tr('taskPage.agentPrompt') },
        { value: 'bash', label: tr('taskPage.bashCommand') },
      ],
      onChange: (v) => onPatch({ kind: v === 'bash' ? 'bash' : 'agent' }),
    })}
    ${!isNew ? html`<div class="tp-hint">${tr('taskPage.editKeepHint')}</div>` : nothing}
    <label class="tp-label" for="tp-text">${values.kind === 'bash' ? tr('taskPage.command') : tr('taskPage.prompt')}</label>
    <textarea
      id="tp-text"
      class="tp-text"
      spellcheck="false"
      .value=${values.text}
      @input=${(ev: Event) => onPatch({ text: (ev.currentTarget as HTMLTextAreaElement).value })}
    ></textarea>
    ${keeps.includes('host') ? html`<div class="tp-hint">${tr('taskPage.bashHint')}</div>` : nothing}
    ${values.kind === 'agent'
      ? html`<div class="tp-label">${tr('taskPage.session')}</div>
          ${renderSegmented({
            kind: 'value',
            value: values.session,
            ariaLabel: tr('taskPage.session'),
            options: [
              { value: 'new', label: tr('taskPage.sessionNew') },
              { value: 'daily', label: tr('taskPage.sessionDaily') },
              { value: 'fixed', label: tr('taskPage.sessionFixed') },
            ],
            onChange: (v) => onPatch({ session: v === 'daily' || v === 'fixed' ? v : 'new' }),
          })}
          <div class="tp-hint">${sessionHintText(shape)}</div>`
      : nothing}
    ${renderFormRuntimeFields(detail, values, keeps, onPatch)}
    ${renderFormScheduleFields(detail, values, shape, keeps.includes('at'), topics, timeZones, onPatch)}
    <div class="tp-acts editor">
      <button type="submit" class="fh-btn fh-btn--primary" data-tp-act="save" ?disabled=${saving}>
        ${saveLabel}
      </button>
      <button type="button" class="fh-btn fh-btn--secondary" data-tp-act="cancel" ?disabled=${saving} @click=${onCancel}>
        ${tr('common.cancel')}
      </button>
    </div>
  </form>`;
}

function formatEditorSubline(task: SchedulePanelTask | null, nowMs: number): string {
  if (!task) return '';
  const taskState = task.state || 'active';
  const bits: string[] = [];
  if (task.running) {
    bits.push(tr('sched.runningNow'));
  } else if (taskState === 'active' && task.nextAt) {
    bits.push(tr('sched.nextPrefix', { next: `${task.next || ''} (${formatDueIn(task.nextAt, nowMs)})` }));
  } else {
    bits.push(taskState);
  }
  const last = formatLastRun(task, nowMs);
  if (last) bits.push(last);
  return bits.join(' \u00b7 ');
}

export interface ScheduleEditorController extends SchedulePanelComponent {
  refreshLocale(): void;
  refreshTopics(): void;
}

class ScheduleEditor implements ScheduleEditorController {
  readonly element: HTMLElement;
  private readonly _ctx: PluginContext;
  private readonly _store: SchedulesStore;
  private readonly _deps: SchedulesPluginDeps;
  private readonly _doc: Document;
  private readonly _now: () => number;
  private readonly _disposables = new DisposableStore();
  private readonly _timeZones: readonly string[];
  private _panelCtx: SchedulePanelInitContext | null = null;
  private _taskId: string | null = null;
  private _mode: ScheduleEditorMode = 'view';
  private _detail: TaskPageDetail | null = null;
  private _formValues: TaskFormValues | null = null;
  private _notice: EditorNotice | null = null;
  private _runFilter: RunStatusFilter = 'all';
  private _saving = false;
  private _seq = 0;
  private _disposed = false;

  constructor(ctx: PluginContext, store: SchedulesStore, deps: SchedulesPluginDeps) {
    this._ctx = ctx;
    this._store = store;
    this._deps = deps;
    this._doc = deps.doc ?? document;
    this._now = deps.now ?? (() => Date.now());
    this._timeZones = listTimeZones();
    this.element = this._doc.createElement('div');
    this.element.className = 'fh-schedule-editor';
    this._disposables.add(this._store.onDidChange(() => this._followStore()));
  }

  init(params: unknown, ctxInit: SchedulePanelInitContext): void {
    this._panelCtx = ctxInit;
    this._applyParams(params);
  }

  update(params: unknown): void {
    this._applyParams(params);
  }

  focus(): void {
    this.element.querySelector<HTMLElement>('input, textarea, button, [tabindex="0"]')?.focus();
  }

  refreshLocale(): void {
    this._paint();
  }

  refreshTopics(): void {
    if (this._mode === 'view') this._paint();
  }

  dispose(): void {
    this._disposed = true;
    this._seq++;
    this._disposables.dispose();
    render(nothing, this.element);
    this.element.remove();
  }

  private _updatePanelTitle(): void {
    if (!this._panelCtx) return;
    if (this._mode === 'new') {
      this._panelCtx.api.setTitle(tr('taskPage.newTitle'));
      return;
    }
    const task = this._detail?.task ?? this._store.getTask(this._taskId);
    this._panelCtx.api.setTitle(task?.name || tr('taskPage.title'));
  }

  private _applyParams(params: unknown): void {
    const parsed = parseInput(params);
    const sameId = parsed.id !== null && parsed.id === this._taskId;
    this._taskId = parsed.id;
    this._mode = parsed.mode;
    this._notice = null;
    if (!sameId) {
      this._detail = null;
      this._formValues = null;
      this._runFilter = 'all';
    }
    this._paint();
    if (this._mode === 'new') void this._loadNewForm();
    else if (this._taskId) void this._loadDetail(this._taskId);
  }

  private _followStore(): void {
    if (!this._taskId || this._mode === 'new') return;
    const latest = this._store.getTask(this._taskId);
    if (!latest && this._store.snapshot().tasks !== null) {
      this._panelCtx?.api.close();
      return;
    }
    if (latest && this._detail?.task) {
      const moved = taskMoved(latest, this._detail.task);
      this._detail.task = latest;
      this._paint();
      if (moved && this._mode === 'view') void this._loadDetail(this._taskId);
    }
  }

  private async _loadDetail(id: string): Promise<void> {
    const mySeq = ++this._seq;
    const res = await this._store.fetchTaskDetail(id);
    if (this._disposed || mySeq !== this._seq || this._taskId !== id) return;
    if (res.ok) {
      this._detail = res.detail;
      if (this._mode === 'edit' && !res.detail.locked) {
        this._formValues = initialFormValues(this._detail, this._ctx.topics.list(), this._ctx.topics.active()?.id);
      } else if (res.detail.locked) {
        this._mode = 'view';
      }
      this._notice = null;
    } else {
      this._notice = { tone: 'err', message: res.error };
    }
    this._paint();
  }

  private async _loadNewForm(): Promise<void> {
    const mySeq = ++this._seq;
    const res = await this._store.fetchNewForm();
    if (this._disposed || mySeq !== this._seq || this._mode !== 'new') return;
    if (res.ok) {
      this._detail = res.detail;
      this._formValues = initialFormValues(this._detail, this._ctx.topics.list(), this._ctx.topics.active()?.id);
      this._notice = null;
    } else {
      this._notice = { tone: 'err', message: res.error };
    }
    this._paint();
  }

  private async _handleOp(action: SchedulePanelAction, tags?: readonly string[]): Promise<void> {
    if (!this._taskId) return;
    const res = await this._store.runOp(this._taskId, action, tags);
    if (this._disposed) return;
    if (!res.ok) {
      this._notice = { tone: 'err', message: res.error || tr('common.didNotWork') };
      this._paint();
      return;
    }
    if (action === 'remove') {
      this._panelCtx?.api.close();
      return;
    }
    void this._loadDetail(this._taskId);
  }

  private _handleViewAction(action: 'edit' | 'pause' | 'resume' | 'run' | 'remove'): void {
    const task = this._detail?.task;
    if (!task) return;
    if (action === 'edit') {
      this._mode = 'edit';
      this._formValues = this._detail
        ? initialFormValues(this._detail, this._ctx.topics.list(), this._ctx.topics.active()?.id)
        : null;
      this._notice = null;
      this._paint();
      return;
    }
    if (action === 'remove') {
      void openConfirmDialog({
        title: tr('common.delete'),
        body: tr('sched.confirmDeleteTask', { name: task.name || task.id }),
        confirmLabel: tr('common.delete'),
        danger: true,
        overlays: this._deps.overlays,
        doc: this._doc,
      }).then((confirmed) => {
        if (confirmed && !this._disposed) void this._handleOp('remove');
      });
      return;
    }
    void this._handleOp(action);
  }

  private async _handleSave(): Promise<void> {
    if (this._saving || !this._detail || !this._formValues) return;
    const isNew = this._mode === 'new';
    const diff = buildTaskEditDiff(this._detail, this._formValues, isNew, this._ctx.topics.list());
    if ('error' in diff) {
      this._notice = { tone: 'err', message: diff.error };
      this._paint();
      return;
    }
    if (!isNew && Object.keys(diff.edit).length === 0) {
      this._mode = 'view';
      this._notice = { tone: 'info', message: tr('taskPage.nothingChanged') };
      this._paint();
      return;
    }
    this._saving = true;
    this._notice = null;
    this._paint();
    const res = await this._store.saveTask(this._taskId, isNew, diff.edit);
    if (this._disposed) return;
    this._saving = false;
    if (res.ok) {
      this._taskId = res.detail.task.id;
      this._detail = res.detail;
      this._mode = 'view';
      this._formValues = null;
      this._notice = { tone: 'ok', message: isNew ? tr('taskPage.addedNote') : tr('taskPage.savedNote') };
    } else {
      this._notice = { tone: 'err', message: res.error };
    }
    this._paint();
  }

  private _handleCancel(): void {
    const isNew = this._mode === 'new';
    const dirty = Boolean(
      this._detail && this._formValues && isFormDirty(this._detail, this._formValues, isNew, this._ctx.topics.list()),
    );
    const finish = (): void => {
      if (isNew) {
        this._panelCtx?.api.close();
        return;
      }
      this._mode = 'view';
      this._formValues = null;
      this._notice = null;
      this._paint();
    };
    if (!dirty) {
      finish();
      return;
    }
    void openConfirmDialog({
      title: tr('common.cancel'),
      body: isNew ? tr('taskPage.discardNew') : tr('taskPage.discardEdit'),
      confirmLabel: tr('common.done'),
      danger: true,
      overlays: this._deps.overlays,
      doc: this._doc,
    }).then((confirmed) => {
      if (confirmed && !this._disposed) finish();
    });
  }

  private _paintHeader(nowMs: number): TemplateResult {
    if (this._mode === 'new') {
      return html`<div class="fh-schedule-editor-head">
        <span class="fh-schedule-editor-title">${tr('taskPage.newTitle')}</span>
      </div>`;
    }
    const task = this._detail?.task ?? this._store.getTask(this._taskId);
    const taskState = task?.state ?? 'active';
    const badgeLabel = task?.running ? tr('sched.statusRunning') : taskState;
    const badgeTone = task?.running ? 'accent' : taskState === 'active' ? 'ok' : 'neutral';
    const subline = formatEditorSubline(task, nowMs);
    return html`<div class="fh-schedule-editor-head">
      <div class="fh-schedule-editor-title-row">
        <span class="fh-schedule-editor-title">${task?.name || tr('taskPage.title')}</span>
        ${task ? renderBadge({ count: badgeLabel, tone: badgeTone }) : nothing}
      </div>
      ${subline ? html`<div class="fh-schedule-editor-sub">${subline}</div>` : nothing}
    </div>`;
  }

  private _paintBody(nowMs: number): TemplateResult | typeof nothing {
    if (!this._detail) return html`<div class="tp-empty">${tr('common.loading')}</div>`;
    const topics = this._ctx.topics.list();
    const isForm = this._mode === 'new' || (this._mode === 'edit' && !this._detail.locked);
    if (isForm && this._formValues) {
      return renderFormContent(
        this._detail,
        this._formValues,
        this._mode === 'new',
        this._saving,
        topics,
        this._timeZones,
        (patch) => {
          if (!this._formValues) return;
          this._formValues = { ...this._formValues, ...patch };
          this._paint();
        },
        () => void this._handleSave(),
        () => this._handleCancel(),
      );
    }
    if (!this._detail.task) return nothing;
    return renderViewContent(
      this._ctx,
      this._detail as SchedulePanelTaskDetail,
      topics,
      nowMs,
      this._store.snapshot().busy,
      this._runFilter,
      (next) => {
        this._runFilter = next;
        this._paint();
      },
      (act) => this._handleViewAction(act),
      (tag) => {
        const task = this._detail?.task;
        if (task) void this._handleOp('tags', taskTags(task).filter((x) => x !== tag));
      },
      (raw, input) => {
        const task = this._detail?.task;
        const added = parseTagList(raw);
        if (!task || added.length === 0) return;
        input.value = '';
        void this._handleOp('tags', taskTags(task).concat(added));
      },
      (tid) => this._ctx.topics.open(tid),
    );
  }

  private _paint(): void {
    if (this._disposed) return;
    this._updatePanelTitle();
    const nowMs = this._now();
    render(
      html`${this._paintHeader(nowMs)}
        <div class="fh-schedule-editor-body">
          ${this._notice
            ? renderNotice({
                tone: this._notice.tone,
                message: this._notice.message,
                dismissible: true,
                dismissIcon: icon('cross'),
                onDismiss: () => {
                  this._notice = null;
                  this._paint();
                },
              })
            : nothing}
          ${this._paintBody(nowMs)}
        </div>`,
      this.element,
    );
  }
}

export function createScheduleEditorComponent(
  ctx: PluginContext,
  store: SchedulesStore,
  deps: SchedulesPluginDeps,
): ScheduleEditorController {
  return new ScheduleEditor(ctx, store, deps);
}
