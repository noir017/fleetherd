import type { ReviewPanelChange, ReviewPanelEntry, ReviewPanelPreference } from '../../../../workbench.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { openConfirmDialog } from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import type { ReviewsStore } from './store.js';
import type { ReviewPanelComponent, ReviewPanelInitContext, ReviewsPluginDeps } from './types.js';

export interface ReviewEditorInput {
  readonly id: string;
  readonly title?: string;
}

export interface ReviewEditorController extends ReviewPanelComponent {
  refreshLocale(): void;
  refreshTopics(): void;
}

function parseReviewInput(raw: unknown): ReviewEditorInput | null {
  if (typeof raw === 'string' && raw.trim()) return { id: raw.trim() };
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id.trim()) return null;
  return {
    id: rec.id.trim(),
    title: typeof rec.title === 'string' ? rec.title : undefined,
  };
}

function formatReviewTime(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return new Date(at).toISOString();
  }
}

function formatReviewDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? (sec > 0 ? `${min}m ${sec}s` : `${min}m`) : `${sec}s`;
}

function formatReviewMeta(entry: ReviewPanelEntry): string {
  const parts: string[] = [formatReviewTime(entry.at)];
  if (entry.reviewer) {
    const who = entry.model ? `${entry.reviewer}（${entry.model}）` : entry.reviewer;
    parts.push(tr('reviews.reviewer', { name: who }));
  } else if (entry.model) {
    parts.push(entry.model);
  }
  if (entry.messagesRead !== undefined) {
    parts.push(tr('reviews.messagesRead', { count: entry.messagesRead }));
  }
  if (entry.durationMs !== undefined) {
    parts.push(tr('reviews.duration', { time: formatReviewDuration(entry.durationMs) }));
  }
  if (entry.inferred) parts.push(tr('reviews.inferredNote'));
  return parts.join(' · ');
}

function renderInlineDiff(diff: string): TemplateResult | typeof nothing {
  const lines = diff.split('\n').filter((line) => {
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      return false;
    }
    return true;
  });
  if (lines.length === 0) return nothing;
  return html`<div class="fh-rev-diff" data-rev-diff="1">
    ${lines.map((line) => {
      const cls = line.startsWith('@@')
        ? 'fh-rev-dl fh-rev-dl--hunk'
        : line.startsWith('+')
          ? 'fh-rev-dl fh-rev-dl--add'
          : line.startsWith('-')
            ? 'fh-rev-dl fh-rev-dl--del'
            : 'fh-rev-dl';
      return html`<div class=${cls}>${line || ' '}</div>`;
    })}
  </div>`;
}

function formatChangeHeading(c: ReviewPanelChange): string {
  const what =
    c.action === 'create'
      ? tr('reviews.actionCreate')
      : c.action === 'patch'
        ? tr('reviews.actionPatch')
        : c.action === 'archive'
          ? tr('reviews.actionArchive')
          : tr('reviews.actionWrite');
  const name =
    c.action === 'write-file'
      ? tr('reviews.inName', { file: c.file || tr('reviews.aFile'), name: c.name })
      : c.action === 'archive' && c.into
        ? tr('reviews.intoName', { name: c.name, into: c.into })
        : c.name;
  return `${what}${name}`;
}

function renderAppliedCard(
  changes: readonly ReviewPanelChange[],
  ctx: PluginContext,
  store: ReviewsStore,
  busyKeys: ReadonlySet<string>,
  doc: Document,
): TemplateResult | typeof nothing {
  if (changes.length === 0) return nothing;
  return html`<div class="fh-sh">${ctx.i18n.t('wb.reviews.appliedChanges')} · ${changes.length}</div>
    <div class="fh-card">
      ${changes.map((c) => {
        const revertId = c.revertId;
        const busy = revertId ? busyKeys.has(`revert:${c.name}:${revertId}`) : false;
        return html`<div class="fh-ci fh-ci--static">
            <span class="fh-ci-l">${formatChangeHeading(c)}</span>
            ${revertId
              ? html`<span class="fh-acts">
                  <button
                    type="button"
                    class="fh-btn fh-btn--secondary"
                    data-rev-revert=${revertId}
                    data-rev-skill=${c.name}
                    ?disabled=${busy}
                    @click=${() => {
                      openConfirmDialog({
                        doc,
                        title: tr('reviews.revertTitle', { name: c.name }),
                        body: tr('reviews.revertBody', { name: c.name }),
                        confirmLabel: tr('reviews.revert'),
                        danger: true,
                        onConfirm: async () => {
                          await store.revertChange(c.name, revertId);
                        },
                      });
                    }}
                  >${tr('reviews.revert')}</button>
                </span>`
              : c.applied === undefined
                ? html`<span class="fh-pill fh-pill--neutral">${tr('reviews.statusUnknown')}</span>`
                : nothing}
            ${c.reason ? html`<span class="fh-ci-h">${c.reason}</span>` : nothing}
            ${!revertId && c.undo ? html`<code class="rev-undo fh-ci-code">${c.undo}</code>` : nothing}
          </div>
          ${c.diff ? renderInlineDiff(c.diff) : nothing}`;
      })}
    </div>`;
}

function renderRefusedCard(
  refused: readonly ReviewPanelChange[],
  invalid: readonly string[],
): TemplateResult | typeof nothing {
  const total = refused.length + invalid.length;
  if (total === 0) return nothing;
  return html`<div class="fh-sh">${tr('reviews.rejected')} · ${total}</div>
    <div class="fh-card">
      ${refused.map(
        (c) => html`<div class="fh-ci fh-ci--static">
          <span class="fh-ci-l">${formatChangeHeading(c)}</span>
          <span class="fh-pill fh-pill--err">${tr('reviews.statusRefused')}</span>
          ${c.error ? html`<span class="fh-ci-h">${c.error}</span>` : nothing}
          ${c.reason && c.reason !== c.error ? html`<span class="fh-ci-h">${c.reason}</span>` : nothing}
        </div>`,
      )}
      ${invalid.map(
        (line) => html`<div class="fh-ci fh-ci--static">
          <span class="fh-ci-l">${line}</span>
          <span class="fh-pill fh-pill--err">${tr('reviews.statusRefused')}</span>
        </div>`,
      )}
    </div>`;
}

function renderArchiveSuggestionsCard(
  archives: readonly ReviewPanelChange[],
  ctx: PluginContext,
  store: ReviewsStore,
  busyKeys: ReadonlySet<string>,
): TemplateResult | typeof nothing {
  if (archives.length === 0) return nothing;
  return html`<div class="fh-sh">${ctx.i18n.t('wb.reviews.suggestedArchive')} · ${archives.length}</div>
    <div class="fh-card">
      ${archives.map((c) => {
        const pref: ReviewPanelPreference = {
          text: c.into ? `${c.name} -> ${c.into}` : c.name,
          archive: { name: c.name, into: c.into },
          reason: c.reason,
          count: 1,
          at: Date.now(),
          from: [],
        };
        const busy = busyKeys.has(`archive:${c.name}`);
        return html`<div class="fh-ci fh-ci--static">
          <span class="fh-ci-l">${c.name}</span>
          <span class="fh-acts">
            <button
              type="button"
              class="fh-btn fh-btn--primary"
              ?disabled=${busy}
              @click=${() => void store.archiveSuggestion(pref)}
            >${tr('reviews.archive')}</button>
          </span>
          ${c.reason ? html`<span class="fh-ci-h">${c.reason}</span>` : nothing}
          ${c.command ? html`<code class="rev-undo fh-ci-code">${c.command}</code>` : nothing}
        </div>`;
      })}
    </div>`;
}

function renderReviewPrefsCard(
  preferences: readonly string[],
  ctx: PluginContext,
  store: ReviewsStore,
  busyKeys: ReadonlySet<string>,
): TemplateResult | typeof nothing {
  if (preferences.length === 0) return nothing;
  return html`<div class="fh-sh">${tr('reviews.preferences')} · ${preferences.length}</div>
    <div class="fh-card">
      ${preferences.map((prefText) => {
        const adoptBusy = busyKeys.has(`adopt:${prefText}`);
        const dismissBusy = busyKeys.has(`dismiss:${prefText}`);
        const prefObj: ReviewPanelPreference = {
          text: prefText,
          count: 1,
          at: Date.now(),
          from: [],
        };
        return html`<div class="fh-ci fh-ci--static">
          <span class="fh-ci-l">${prefText}</span>
          <span class="fh-acts">
            <button
              type="button"
              class="fh-btn fh-btn--secondary"
              ?disabled=${dismissBusy}
              @click=${() => void store.dismissSuggestion(prefText)}
            >${tr('reviews.dismiss')}</button>
            <button
              type="button"
              class="fh-btn fh-btn--primary"
              ?disabled=${adoptBusy}
              @click=${() => void store.adoptSuggestion(prefObj)}
            >${tr('reviews.adopt')}</button>
          </span>
          <span class="fh-ci-h">${ctx.i18n.t('wb.reviews.adoptHint')}</span>
        </div>`;
      })}
    </div>`;
}

export function createReviewDetailEditorComponent(
  ctx: PluginContext,
  store: ReviewsStore,
  deps: ReviewsPluginDeps,
): ReviewEditorController {
  const doc = deps.doc ?? document;
  const disposables = new DisposableStore();
  const root = doc.createElement('div');
  root.className = 'fh-review-editor';
  let panelCtx: ReviewPanelInitContext | null = null;
  let reviewId: string | null = null;
  let disposed = false;

  const findEntry = (): ReviewPanelEntry | null => {
    const reviews = store.snapshot().data?.reviews ?? [];
    return reviews.find((r) => r.id === reviewId) ?? null;
  };

  const paint = (): void => {
    if (disposed) return;
    const snap = store.snapshot();
    const entry = findEntry();
    if (!entry) {
      render(
        html`<div class="fh-review-editor-head">
            <span class="fh-review-editor-title">${tr('sideTasks.tabReviews')}</span>
          </div>
          <div class="fh-review-editor-body"><div class="fh-pcol"><div class="sched-empty">
            ${snap.data === null ? tr('common.loading') : tr('reviews.nothingChanging')}
          </div></div></div>`,
        root,
      );
      return;
    }
    panelCtx?.api.setTitle(`${tr('sideTasks.tabReviews')} · ${entry.title}`);
    const archives = entry.changes.filter((c) => Boolean(c.suggested));
    const applied = entry.changes.filter((c) => !c.suggested && c.applied !== false);
    const refused = entry.changes.filter((c) => !c.suggested && c.applied === false);
    const canOpenTopic = Boolean(entry.topic && ctx.topics.list().some((t) => t.id === entry.topic));
    const pillCls =
      entry.outcome === 'failed'
        ? 'fh-pill fh-pill--err'
        : entry.outcome === 'changed'
          ? 'fh-pill fh-pill--ok'
          : 'fh-pill fh-pill--neutral';
    const isEmpty =
      entry.changes.length === 0 && entry.preferences.length === 0 && entry.invalid.length === 0 && !entry.error;

    render(
      html`<div class="fh-review-editor-head">
          <span class="fh-review-editor-title">${entry.title}</span>
          <span class=${pillCls}>${entry.summary}</span>
          <span class="fh-head-spacer"></span>
          ${canOpenTopic
            ? html`<button
                type="button"
                class="fh-btn fh-btn--secondary"
                data-rev-topic=${entry.topic!}
                @click=${() => ctx.topics.open(entry.topic!)}
              >${ctx.i18n.t('wb.reviews.openOrigTopic')}</button>`
            : nothing}
        </div>
        <div class="fh-review-editor-body">
          <div class="fh-pcol">
            <div class="fh-psub" data-rev-meta="1">${formatReviewMeta(entry)}</div>
            ${snap.note
              ? html`<div class="fh-card"><div class="fh-ci fh-ci--static">
                  <span class="fh-ci-l rev-note bad">${snap.note}</span>
                </div></div>`
              : nothing}
            ${entry.error
              ? html`<div class="fh-card"><div class="fh-ci fh-ci--static">
                  <span class="fh-ci-l rev-note bad">${entry.error}</span>
                </div></div>`
              : nothing}
            ${renderAppliedCard(applied, ctx, store, snap.busyKeys, doc)}
            ${renderRefusedCard(refused, entry.invalid)}
            ${renderArchiveSuggestionsCard(archives, ctx, store, snap.busyKeys)}
            ${renderReviewPrefsCard(entry.preferences, ctx, store, snap.busyKeys)}
            ${isEmpty ? html`<div class="sched-empty">${tr('reviews.nothingChanging')}</div>` : nothing}
          </div>
        </div>`,
      root,
    );
  };

  disposables.add(store.onDidChange(() => paint()));

  return {
    element: root,
    init(params, initCtx): void {
      panelCtx = initCtx;
      const parsed = parseReviewInput(params);
      reviewId = parsed?.id ?? null;
      if (!store.snapshot().data) void store.load();
      paint();
    },
    update(params): void {
      const parsed = parseReviewInput(params);
      reviewId = parsed?.id ?? null;
      paint();
    },
    focus(): void {
      root.querySelector<HTMLElement>('button')?.focus();
    },
    refreshLocale: paint,
    refreshTopics: paint,
    dispose(): void {
      disposed = true;
      disposables.dispose();
      render(nothing, root);
      root.remove();
    },
  };
}

export function createReviewPrefsEditorComponent(
  ctx: PluginContext,
  store: ReviewsStore,
  deps: ReviewsPluginDeps,
): ReviewEditorController {
  const doc = deps.doc ?? document;
  const disposables = new DisposableStore();
  const root = doc.createElement('div');
  root.className = 'fh-review-editor fh-prefs-editor';
  let disposed = false;

  const paint = (): void => {
    if (disposed) return;
    const { data, busyKeys } = store.snapshot();
    const pending = data?.pending ?? [];
    render(
      html`<div class="fh-review-editor-head">
          <span class="fh-review-editor-title">${ctx.i18n.t('wb.reviews.pendingTitle')}</span>
          <span class="fh-head-spacer"></span>
          <span class="fh-review-editor-from">${ctx.i18n.t('wb.reviews.fromAutoReview')}</span>
        </div>
        <div class="fh-review-editor-body">
          <div class="fh-pcol">
            <div class="fh-psub">${tr('reviews.suggestionsNote')}</div>
            ${data === null
              ? html`<div class="sched-empty">${tr('common.loading')}</div>`
              : pending.length === 0
                ? html`<div class="sched-empty">${ctx.i18n.t('wb.reviews.noPending')}</div>`
                : html`<div class="fh-card">
                    ${pending.map((p, idx) => {
                      const from = p.from.map((entry) => entry.title).join(', ');
                      const actBusy = p.archive
                        ? busyKeys.has(`archive:${p.archive.name}`)
                        : busyKeys.has(`adopt:${p.text}`);
                      const dismissBusy = busyKeys.has(`dismiss:${p.text}`);
                      const meta = `${p.count > 1 ? tr('reviews.reviewsCount', { count: p.count }) : ''}${from}`;
                      return html`<div class="fh-ci fh-ci--static" data-rev-pending=${idx}>
                        <span class="fh-ci-l">${p.text}</span>
                        <span class="fh-acts">
                          <button
                            type="button"
                            class="fh-btn fh-btn--secondary"
                            data-rev-dismiss=${idx}
                            ?disabled=${dismissBusy}
                            @click=${() => void store.dismissSuggestion(p.text)}
                          >${tr('reviews.dismiss')}</button>
                          ${p.archive
                            ? html`<button
                                type="button"
                                class="fh-btn fh-btn--primary"
                                data-rev-archive=${idx}
                                ?disabled=${actBusy}
                                @click=${() => void store.archiveSuggestion(p)}
                              >${tr('reviews.archive')}</button>`
                            : html`<button
                                type="button"
                                class="fh-btn fh-btn--primary"
                                data-rev-adopt=${idx}
                                ?disabled=${actBusy}
                                @click=${() => void store.adoptSuggestion(p)}
                              >${tr('reviews.adopt')}</button>`}
                        </span>
                        ${p.reason ? html`<span class="fh-ci-h">${p.reason}</span>` : nothing}
                        ${meta ? html`<span class="fh-ci-h">${meta}</span>` : nothing}
                      </div>`;
                    })}
                  </div>`}
          </div>
        </div>`,
      root,
    );
  };

  disposables.add(store.onDidChange(() => paint()));

  return {
    element: root,
    init(): void {
      if (!store.snapshot().data) void store.load();
      paint();
    },
    focus(): void {
      root.querySelector<HTMLElement>('button')?.focus();
    },
    refreshLocale: paint,
    refreshTopics: paint,
    dispose(): void {
      disposed = true;
      disposables.dispose();
      render(nothing, root);
      root.remove();
    },
  };
}
