import type { SchedulePanelRun } from '../../../../workbench.js';
import { html, type TemplateResult } from '../../base/html.js';
import { renderStatusDot } from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import { formatDuration, runStatusWord } from './helpers.js';

export type RunStatusFilter = 'all' | SchedulePanelRun['status'];

export interface RunStatusCounts {
  readonly all: number;
  readonly ok: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly skipped: number;
  readonly missed: number;
}

export function countRunsByStatus(runs: readonly SchedulePanelRun[]): RunStatusCounts {
  let ok = 0;
  let failed = 0;
  let interrupted = 0;
  let skipped = 0;
  let missed = 0;
  for (const r of runs) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'failed') failed++;
    else if (r.status === 'interrupted') interrupted++;
    else if (r.status === 'skipped') skipped++;
    else if (r.status === 'missed') missed++;
  }
  return { all: runs.length, ok, failed, interrupted, skipped, missed };
}

export function filterRunsByStatus(
  runs: readonly SchedulePanelRun[],
  filter: RunStatusFilter,
): SchedulePanelRun[] {
  if (filter === 'all') return runs.slice();
  return runs.filter((r) => r.status === filter);
}

export function runBadgeTone(status: SchedulePanelRun['status']): 'ok' | 'err' | 'warn' | 'idle' {
  if (status === 'ok') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'interrupted') return 'warn';
  return 'idle';
}

export function formatRunSummary(
  run: SchedulePanelRun,
  ctx: PluginContext,
): { readonly text: string; readonly isError: boolean } {
  const exitPart = run.exitCode != null ? tr('taskPage.exitCode', { code: run.exitCode }) : '';
  if (run.error) {
    return {
      text: exitPart ? `${run.error} (${exitPart})` : run.error,
      isError: true,
    };
  }
  if (exitPart) {
    return { text: exitPart, isError: run.status !== 'ok' };
  }
  if (run.status === 'ok') {
    return { text: ctx.i18n.t('wb.sched.summaryOk'), isError: false };
  }
  return { text: runStatusWord(run.status), isError: run.status === 'failed' };
}

function buildFilterTabs(counts: RunStatusCounts, ctx: PluginContext): Array<{ value: RunStatusFilter; label: string; count: number }> {
  const tabs: Array<{ value: RunStatusFilter; label: string; count: number }> = [
    { value: 'all', label: ctx.i18n.t('wb.sched.runsAll'), count: counts.all },
    { value: 'ok', label: runStatusWord('ok'), count: counts.ok },
    { value: 'failed', label: runStatusWord('failed'), count: counts.failed },
  ];
  if (counts.interrupted > 0) tabs.push({ value: 'interrupted', label: runStatusWord('interrupted'), count: counts.interrupted });
  if (counts.skipped > 0) tabs.push({ value: 'skipped', label: runStatusWord('skipped'), count: counts.skipped });
  if (counts.missed > 0) tabs.push({ value: 'missed', label: runStatusWord('missed'), count: counts.missed });
  return tabs;
}

function renderSessionCell(
  r: SchedulePanelRun,
  topics: readonly TopicInfo[],
  onOpenTopic: (id: string) => void,
): TemplateResult {
  if (r.topic) {
    const topic = topics.find((item) => item.id === r.topic);
    if (topic) {
      return html`<button
        type="button"
        class="tp-run-open fh-run-jump"
        data-tp-topic=${r.topic}
        title=${topic.title}
        @click=${() => onOpenTopic(r.topic!)}
      >${tr('common.open')}</button>`;
    }
    return html`<span class="tp-run-where" title=${tr('taskPage.topicGoneTitle')}>${tr('taskPage.topicGone')}</span>`;
  }
  if (r.where) {
    return html`<span class="tp-run-where" title=${r.where}>${r.where}</span>`;
  }
  return html`<span class="fh-run-dash">\u2014</span>`;
}

export function renderRunsTableSection(opts: {
  readonly ctx: PluginContext;
  readonly runs: readonly SchedulePanelRun[];
  readonly filter: RunStatusFilter;
  readonly topics: readonly TopicInfo[];
  readonly onFilterChange: (next: RunStatusFilter) => void;
  readonly onOpenTopic: (id: string) => void;
}): TemplateResult {
  const { ctx, runs, filter, topics, onFilterChange, onOpenTopic } = opts;
  const counts = countRunsByStatus(runs);
  const filtered = filterRunsByStatus(runs, filter);
  const tabs = buildFilterTabs(counts, ctx);
  const countText = filter === 'all' ? String(runs.length) : `${filtered.length} / ${runs.length}`;

  return html`<div class="fh-runs-section">
    <div class="fh-runs-head">
      <div class="tp-label">${tr('taskPage.runs')}<span class="tp-n">${countText}</span></div>
      ${runs.length > 0
        ? html`<div class="fh-runs-filters" role="group" aria-label=${tr('taskPage.runs')}>
            ${tabs.map(
              (tab) => html`<button
                type="button"
                class=${`fh-run-filter${filter === tab.value ? ' is-active' : ''}`}
                data-run-filter=${tab.value}
                aria-pressed=${filter === tab.value ? 'true' : 'false'}
                @click=${() => onFilterChange(tab.value)}
              ><span>${tab.label}</span><span class="fh-run-filter-n">${tab.count}</span></button>`,
            )}
          </div>`
        : ''}
    </div>
    ${runs.length === 0
      ? html`<div class="tp-empty fh-runs-empty">${tr('taskPage.noRuns')}</div>`
      : filtered.length === 0
        ? html`<div class="tp-empty fh-runs-empty">
            <span>${ctx.i18n.t('wb.sched.noMatchingRuns')}</span>
            <button
              type="button"
              class="fh-btn fh-btn--secondary fh-runs-reset"
              data-run-filter-reset="1"
              @click=${() => onFilterChange('all')}
            >${ctx.i18n.t('wb.sched.showAllRuns')}</button>
          </div>`
        : html`<div class="fh-runs-table-wrap">
            <table class="fh-runs-table">
              <thead>
                <tr>
                  <th scope="col">${ctx.i18n.t('wb.sched.colTime')}</th>
                  <th scope="col">${ctx.i18n.t('wb.sched.colStatus')}</th>
                  <th scope="col">${ctx.i18n.t('wb.sched.colDuration')}</th>
                  <th scope="col">${ctx.i18n.t('wb.sched.colSummary')}</th>
                  <th scope="col">${ctx.i18n.t('wb.sched.colSession')}</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((r) => {
                  const tone = runBadgeTone(r.status);
                  const summary = formatRunSummary(r, ctx);
                  return html`<tr class="fh-run-row" data-run-status=${r.status}>
                    <td class="fh-run-time">${r.atText}</td>
                    <td class="fh-run-status-cell">
                      <span class=${`fh-run-badge fh-run-badge--${tone}`}>
                        ${renderStatusDot({ status: tone })}
                        <span>${runStatusWord(r.status)}</span>
                      </span>
                    </td>
                    <td class="fh-run-dur">${r.durationMs != null ? formatDuration(r.durationMs) : '\u2014'}</td>
                    <td class=${`fh-run-summary${summary.isError ? ' is-error' : ''}`} title=${summary.text}>${summary.text}</td>
                    <td class="fh-run-session">${renderSessionCell(r, topics, onOpenTopic)}</td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`}
  </div>`;
}
