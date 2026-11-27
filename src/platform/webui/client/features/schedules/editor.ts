import type {
  SchedulePanelAction,
  SchedulePanelSetting,
  SchedulePanelShape,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../../../../workbench.js';
import { icon } from '../../../icons.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  openConfirmDialog,
  renderNotice,
  renderSegmented,
  renderStatusDot,
  type NoticeTone,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';

function scheduleStateBadge(task: SchedulePanelTask | null | undefined): { readonly label: string; readonly cls: string } {
  const taskState = task?.state ?? 'active';
  const label = task?.running ? tr('sched.statusRunning') : taskState;
  const cls = task?.running || taskState === 'active' ? 'fh-pill fh-pill--ok' : 'fh-pill fh-pill--neutral';
  return { label, cls };
}
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

type QuickPresetKind = 'daily' | 'weekly' | 'interval' | 'cron';

interface QuickPresetState {
  readonly kind: QuickPresetKind;
  readonly time: string;
  readonly dow: string;
  readonly every: number;
  readonly unit: 'm' | 'h';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseQuickPreset(cron: string): QuickPresetState {
  const base: QuickPresetState = { kind: 'cron', time: '09:00', dow: '1', every: 30, unit: 'm' };
  const s = cron.trim();
  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(s);
  if (daily) {
    const m = Number(daily[1]);
    const h = Number(daily[2]);
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23) {
      return { ...base, kind: 'daily', time: `${pad2(h)}:${pad2(m)}` };
    }
  }
  const weekly = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])$/.exec(s);
  if (weekly) {
    const m = Number(weekly[1]);
    const h = Number(weekly[2]);
    if (m >= 0 && m <= 59 && h >= 0 && h <= 23) {
      return { ...base, kind: 'weekly', time: `${pad2(h)}:${pad2(m)}`, dow: weekly[3]! };
    }
  }
  const minStep = /^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/.exec(s);
  if (minStep) {
    const every = Number(minStep[1]);
    if (every >= 1 && every <= 59) return { ...base, kind: 'interval', every, unit: 'm' };
  }
  const hrStep = /^0\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/.exec(s);
  if (hrStep) {
    const every = Number(hrStep[1]);
    if (every >= 1 && every <= 23) return { ...base, kind: 'interval', every, unit: 'h' };
  }
  return base;
}

function buildCronFromPreset(p: QuickPresetState): string {
  const [rawH = '9', rawM = '0'] = p.time.split(':');
  const h = Math.max(0, Math.min(23, Number(rawH) || 0));
  const m = Math.max(0, Math.min(59, Number(rawM) || 0));
  if (p.kind === 'daily') return `${m} ${h} * * *`;
  if (p.kind === 'weekly') return `${m} ${h} * * ${p.dow}`;
  if (p.kind === 'interval') {
    if (p.unit === 'h') {
      const n = Math.max(1, Math.min(23, Math.round(p.every) || 1));
      return `0 */${n} * * *`;
    }
    const n = Math.max(1, Math.min(59, Math.round(p.every) || 1));
    return `*/${n} * * * *`;
  }
  return '';
}

function renderQuickPresetControls(
  ctx: PluginContext,
  preset: QuickPresetState,
  onPresetChange: (next: QuickPresetState) => void,
): TemplateResult | typeof nothing {
  if (preset.kind === 'cron') return nothing;
  if (preset.kind === 'daily') {
    return html`<div class="tp-quick-row">
      <input
        id="tp-quick-time"
        class="skill-field tp-quick-time"
        type="time"
        aria-label=${ctx.i18n.t('wb.sched.quickDaily')}
        .value=${preset.time}
        @input=${(ev: Event) => onPresetChange({ ...preset, time: (ev.currentTarget as HTMLInputElement).value || '09:00' })}
      />
    </div>`;
  }
  if (preset.kind === 'weekly') {
    return html`<div class="tp-quick-row">
      <select
        id="tp-quick-dow"
        class="skill-field tp-quick-dow"
        aria-label=${ctx.i18n.t('wb.sched.quickWeekly')}
        .value=${preset.dow}
        @change=${(ev: Event) => onPresetChange({ ...preset, dow: (ev.currentTarget as HTMLSelectElement).value })}
      >
        ${['1', '2', '3', '4', '5', '6', '0'].map(
          (d) => html`<option value=${d} ?selected=${preset.dow === d}>${ctx.i18n.t(`wb.sched.dow${d}`)}</option>`,
        )}
      </select>
      <input
        id="tp-quick-time"
        class="skill-field tp-quick-time"
        type="time"
        aria-label=${ctx.i18n.t('wb.sched.quickWeekly')}
        .value=${preset.time}
        @input=${(ev: Event) => onPresetChange({ ...preset, time: (ev.currentTarget as HTMLInputElement).value || '09:00' })}
      />
    </div>`;
  }
  return html`<div class="tp-quick-row">
    <span class="tp-quick-lbl">${ctx.i18n.t('wb.sched.quickEvery')}</span>
    <input
      id="tp-quick-every"
      class="skill-field tp-quick-num"
      type="number"
      min="1"
      max=${preset.unit === 'h' ? '23' : '59'}
      aria-label=${ctx.i18n.t('wb.sched.quickInterval')}
      .value=${String(preset.every)}
      @input=${(ev: Event) => {
        const num = Number((ev.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(num) && num >= 1) onPresetChange({ ...preset, every: num });
      }}
    />
    <select
      id="tp-quick-unit"
      class="skill-field tp-quick-unit"
      aria-label=${ctx.i18n.t('wb.sched.quickInterval')}
      .value=${preset.unit}
      @change=${(ev: Event) => {
        const unit = (ev.currentTarget as HTMLSelectElement).value === 'h' ? 'h' : 'm';
        const every = unit === 'h' ? Math.min(23, preset.every) : Math.min(59, preset.every);
        onPresetChange({ ...preset, unit, every });
      }}
    >
      <option value="m" ?selected=${preset.unit === 'm'}>${ctx.i18n.t('wb.sched.quickUnitMin')}</option>
      <option value="h" ?selected=${preset.unit === 'h'}>${ctx.i18n.t('wb.sched.quickUnitHour')}</option>
    </select>
  </div>`;
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
  variant: 'desktop' | 'mobile' = 'desktop',
): TemplateResult {
  const t = detail.task;
  const taskState = t.state || 'active';
  const cls = variant === 'mobile' ? 'tp-acts tp-acts--mobile' : 'tp-acts tp-acts--head';
  return html`<div class=${cls}>
    ${taskState === 'active'
      ? html`<button type="button" class="fh-btn fh-btn--secondary" data-tp-act="pause" ?disabled=${busy} @click=${() => onAction('pause')}>
          <span>${tr('sched.pause')}</span>
        </button>`
      : nothing}
    ${taskState === 'paused'
      ? html`<button type="button" class="fh-btn fh-btn--secondary" data-tp-act="resume" ?disabled=${busy} @click=${() => onAction('resume')}>
          <span>${tr('sched.resume')}</span>
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
        ><span>${tr('sched.runNow')}</span></button>`
      : nothing}
    ${!detail.locked
      ? html`<button type="button" class="fh-btn fh-btn--primary" data-tp-act="edit" ?disabled=${busy} @click=${() => onAction('edit')}>
          <span>${tr('common.edit')}</span>
        </button>`
      : nothing}
    <button
      type="button"
      class=${variant === 'mobile' ? 'fh-btn fh-btn--danger tp-del-btn' : 'fh-btn fh-btn--ghost fh-btn--icon tp-del-btn'}
      data-tp-act="remove"
      title=${tr('common.delete')}
      aria-label=${tr('common.delete')}
      ?disabled=${busy}
      @click=${() => onAction('remove')}
    >
      ${unsafeHTML(icon('trash'))}
    </button>
  </div>`;
}

function renderViewTags(
  ctx: PluginContext,
  t: SchedulePanelTask,
  onRemoveTag: (tag: string) => void,
  onAddTags: (raw: string, input: HTMLInputElement) => void,
): TemplateResult {
  return html`<div class="tp-label">${tr('sched.tags')}</div>
    <div class="sched-tag-edit">
      ${taskTags(t).map((tag) => {
        const removeLabel = tr('taskPage.removeTag', { tag });
        return html`<span class="sched-tag fh-tagx">
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
        <input
          type="text"
          data-tag-input="1"
          placeholder=${ctx.i18n.t('wb.sched.addTagPlaceholder')}
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
    <div class="fh-card tp-list tp-topics">
      ${sessions.length === 0
        ? html`<div class="tp-empty tp-card-empty">${detail.task.kind === 'bash' ? tr('taskPage.noSessionsBash') : tr('taskPage.noSessionsAgent')}</div>`
        : sessions.map(
            (s) => html`<div
              class="fh-ci tp-sess"
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
              <span class="fh-ci-l tp-sess-title">
                ${renderStatusDot({
                  status: s.asking ? 'warn' : s.running ? 'ok' : s.stage === 'failed' ? 'err' : 'idle',
                  pulsing: Boolean(s.running || s.asking),
                })}
                <span>${s.title || tr('common.untitled')}</span>
              </span>
              <span class="fh-ci-h">${s.lastAt ? formatRelativeAge(s.lastAt, nowMs) : ''}</span>
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
  const subBits = [
    t.when,
    t.run,
    tr('sched.postsTo', { target: resolveTargetShort(t, topics) }),
    f.cwd ? f.cwd : '',
  ].filter(Boolean);
  const metaBits = [
    `#${t.id}`,
    tr(t.runs === 1 ? 'taskPage.runCountOne' : 'taskPage.runCountMany', { count: t.runs }),
    t.next ? tr('sched.nextPrefix', { next: t.next }) : '',
    t.createdAt ? tr('taskPage.created', { when: formatClock(t.createdAt) }) : '',
    t.expires ? tr('taskPage.until', { when: t.expires }) : '',
  ].filter(Boolean);

  return html`<div class="tp-view fh-pcol">
    ${renderViewActions(detail, busy, onAction, 'mobile')}
    <div class="fh-psub">${subBits.join(' \u00b7 ')}</div>
    ${detail.locked ? html`<div class="tp-locked">${detail.locked}</div>` : nothing}
    <div class="tp-label">${t.kind === 'bash' ? tr('taskPage.command') : tr('taskPage.prompt')}</div>
    <div class="fh-card tp-prompt-card"><div class="tp-body">${t.detail}</div></div>
    ${renderViewTags(ctx, t, onRemoveTag, onAddTags)}
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
  ctx: PluginContext,
  detail: TaskPageDetail,
  values: TaskFormValues,
  preset: QuickPresetState,
  shape: SchedulePanelShape,
  supportsAt: boolean,
  topics: readonly TopicInfo[],
  timeZones: readonly string[],
  onPatch: (patch: Partial<TaskFormValues>) => void,
  onPresetChange: (next: QuickPresetState) => void,
): TemplateResult {
  const ownTopic = detail.task?.targetTopic ?? '';
  const selectableTopics = topics.filter((t) => (!t.scheduled && !t.parent) || t.id === ownTopic);
  const effectiveWhenMode = supportsAt ? values.whenMode : 'cron';
  const activeSeg = effectiveWhenMode === 'at' ? 'at' : preset.kind;
  const whenOptions = [
    { value: 'daily', label: ctx.i18n.t('wb.sched.quickDaily') },
    { value: 'weekly', label: ctx.i18n.t('wb.sched.quickWeekly') },
    { value: 'interval', label: ctx.i18n.t('wb.sched.quickInterval') },
    { value: 'cron', label: ctx.i18n.t('wb.sched.quickCron') },
    ...(supportsAt ? [{ value: 'at', label: tr('taskPage.once') }] : []),
  ];

  return html`<div class="tp-label">${tr('taskPage.when')}</div>
    <div data-quick-preset>
      ${renderSegmented({
      kind: 'value',
      value: activeSeg,
      ariaLabel: tr('taskPage.whenAria'),
      options: whenOptions,
      onChange: (v) => {
        if (v === 'at') {
          onPatch({ whenMode: 'at' });
          return;
        }
        const nextKind: QuickPresetKind =
          v === 'daily' || v === 'weekly' || v === 'interval' ? v : 'cron';
        onPresetChange({ ...preset, kind: nextKind });
      },
      })}
    </div>
    ${effectiveWhenMode === 'cron' ? renderQuickPresetControls(ctx, preset, onPresetChange) : nothing}
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
  ctx: PluginContext,
  detail: TaskPageDetail,
  values: TaskFormValues,
  preset: QuickPresetState,
  isNew: boolean,
  saving: boolean,
  topics: readonly TopicInfo[],
  timeZones: readonly string[],
  onPatch: (patch: Partial<TaskFormValues>) => void,
  onPresetChange: (next: QuickPresetState) => void,
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
    class="fh-pcol fh-task-form"
    novalidate
    @submit=${(ev: Event) => {
      ev.preventDefault();
      onSubmit();
    }}
  >
    <div class="fh-fld">
      <label class="fh-fld-label" for="tp-name">${tr('taskPage.name')}</label>
      <input
        id="tp-name"
        class="skill-field fh-inp fh-inp--name"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder=${isNew ? tr('taskPage.namePlaceholder') : ''}
        .value=${values.name}
        @input=${(ev: Event) => onPatch({ name: (ev.currentTarget as HTMLInputElement).value })}
      />
    </div>
    <div class="fh-fld">
      <div class="fh-fld-label">${tr('taskPage.runs')}</div>
      <div class="fh-frow">
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
      </div>
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
    </div>
    <div class="fh-fld">
      ${values.kind === 'agent'
        ? html`<div class="fh-fld-label">${tr('taskPage.session')}</div>
            <div class="fh-frow">
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
            </div>
            <div class="tp-hint">${sessionHintText(shape)}</div>`
        : nothing}
      ${renderFormRuntimeFields(detail, values, keeps, onPatch)}
    </div>
    <div class="fh-fld">
      ${renderFormScheduleFields(ctx, detail, values, preset, shape, keeps.includes('at'), topics, timeZones, onPatch, onPresetChange)}
    </div>
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
  private _preset: QuickPresetState = { kind: 'daily', time: '09:00', dow: '1', every: 30, unit: 'm' };
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
        this._preset = parseQuickPreset(this._formValues.cron);
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
      this._preset = parseQuickPreset(this._formValues.cron);
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
      if (this._formValues) this._preset = parseQuickPreset(this._formValues.cron);
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

  private _paintFormHeader(isNew: boolean, task: SchedulePanelTask | null): TemplateResult {
    const titleText = isNew
      ? tr('taskPage.newTitle')
      : this._ctx.i18n.t('wb.sched.editPrefix', { name: task?.name || tr('taskPage.title') });
    const saveLabel = this._saving
      ? isNew
        ? tr('common.adding')
        : tr('common.saving')
      : isNew
        ? tr('common.add')
        : tr('common.save');
    return html`<div class="fh-schedule-editor-head">
      <span class="fh-schedule-editor-title">${titleText}</span>
      <span class="fh-head-spacer"></span>
      <div class="tp-acts tp-acts--head">
        <button type="button" class="fh-btn fh-btn--secondary" ?disabled=${this._saving} @click=${() => this._handleCancel()}>
          ${tr('common.cancel')}
        </button>
        <button type="button" class="fh-btn fh-btn--primary" ?disabled=${this._saving} @click=${() => void this._handleSave()}>
          ${saveLabel}
        </button>
      </div>
    </div>`;
  }

  private _paintHeader(nowMs: number): TemplateResult {
    const isNew = this._mode === 'new';
    const task = this._detail?.task ?? this._store.getTask(this._taskId);
    if (isNew || (this._mode === 'edit' && !this._detail?.locked)) return this._paintFormHeader(isNew, task);
    const { label: badgeLabel, cls: pillCls } = scheduleStateBadge(task);
    const subline = formatEditorSubline(task, nowMs);
    return html`<div class="fh-schedule-editor-head">
      <div class="fh-schedule-editor-title-row">
        <span class="fh-schedule-editor-title">${task?.name || tr('taskPage.title')}</span>
        ${task ? html`<span class=${pillCls}>${badgeLabel}</span>` : nothing}
      </div>
      ${subline ? html`<span class="fh-schedule-editor-sub" title=${subline}></span>` : nothing}
      <span class="fh-head-spacer"></span>
      ${this._detail?.task
        ? renderViewActions(
            this._detail as SchedulePanelTaskDetail,
            this._store.snapshot().busy,
            (act) => this._handleViewAction(act),
            'desktop',
          )
        : nothing}
    </div>`;
  }

  private _paintBody(nowMs: number): TemplateResult | typeof nothing {
    if (!this._detail) return html`<div class="tp-empty">${tr('common.loading')}</div>`;
    const topics = this._ctx.topics.list();
    const isForm = this._mode === 'new' || (this._mode === 'edit' && !this._detail.locked);
    if (isForm && this._formValues) {
      return renderFormContent(
        this._ctx,
        this._detail,
        this._formValues,
        this._preset,
        this._mode === 'new',
        this._saving,
        topics,
        this._timeZones,
        (patch) => {
          if (!this._formValues) return;
          this._formValues = { ...this._formValues, ...patch };
          if (patch.cron !== undefined) {
            this._preset = parseQuickPreset(patch.cron);
          }
          this._paint();
        },
        (nextPreset) => {
          if (!this._formValues) return;
          this._preset = nextPreset;
          const generated = buildCronFromPreset(nextPreset);
          this._formValues = {
            ...this._formValues,
            whenMode: 'cron',
            ...(generated ? { cron: generated } : {}),
          };
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
