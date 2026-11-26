import type {
  ReviewPanelChange,
  ReviewPanelEntry,
  ReviewPanelPreference,
} from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createActionBar,
  createSidebarActionBarHost,
  renderNotice,
  type ActionItem,
  type SidebarActionBarHost,
} from '../../components/index.js';
import {
  attachListNavigation,
  type DomListBatchAction,
} from '../../components/list/index.js';
import { getLocale, t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import type { ReviewsStore } from './store.js';
import type { ReviewPanelComponent, ReviewsPluginDeps } from './types.js';

function formatWhen(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return new Date(at).toISOString();
  }
}

function formatShortReviewTime(at: number, nowMs: number): string {
  try {
    const d = new Date(at);
    const now = new Date(nowMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    if (sameDay || isYesterday) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear()) return `${mo}-${day}`;
    return `${d.getFullYear()}-${mo}-${day}`;
  } catch {
    return '';
  }
}

interface ReviewDateGroup {
  readonly key: string;
  readonly label: string;
  readonly items: ReviewPanelEntry[];
}

function groupReviewsByDate(items: readonly ReviewPanelEntry[], nowMs: number): ReviewDateGroup[] {
  const now = new Date(nowMs);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const groups: ReviewDateGroup[] = [];
  const byKey = new Map<string, ReviewDateGroup>();
  for (const item of items) {
    const d = new Date(item.at);
    let key: string;
    let label: string;
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      key = 'today';
      label = tr('sched.today');
    } else if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      key = 'yesterday';
      label = tr('sched.yesterday');
    } else {
      const monthIdx = d.getMonth();
      const monthKey = `age.month${monthIdx}` as Parameters<typeof tr>[0];
      key = `m:${d.getFullYear()}-${String(monthIdx + 1).padStart(2, '0')}`;
      label = d.getFullYear() === now.getFullYear() ? tr(monthKey) : `${d.getFullYear()} ${tr(monthKey)}`;
    }
    let grp = byKey.get(key);
    if (!grp) {
      grp = { key, label, items: [] };
      byKey.set(key, grp);
      groups.push(grp);
    }
    grp.items.push(item);
  }
  return groups;
}

function renderPendingSection(
  pending: readonly ReviewPanelPreference[],
  busyKeys: ReadonlySet<string>,
  onAdopt: (pref: ReviewPanelPreference) => void,
  onArchive: (pref: ReviewPanelPreference) => void,
  onDismiss: (pref: ReviewPanelPreference) => void,
): TemplateResult | typeof nothing {
  if (pending.length === 0) return nothing;
  return html`<div class="rev-pending">
    <div class="rev-label">${tr('reviews.suggestions', { count: pending.length })}</div>
    <div class="rev-note">${tr('reviews.suggestionsNote')}</div>
    ${pending.map((p, idx) => {
      const from = p.from.map((entry) => entry.title).join(', ');
      const actBusy = p.archive
        ? busyKeys.has(`archive:${p.archive.name}`)
        : busyKeys.has(`adopt:${p.text}`);
      const dismissBusy = busyKeys.has(`dismiss:${p.text}`);
      return html`<div class="rev-pitem" data-rev-pending=${idx}>
        <div class="rev-pbody">
          <div class="rev-ptext">${p.text}</div>
          ${p.reason ? html`<div class="rev-reason">${p.reason}</div>` : nothing}
          <div class="rev-pmeta">
            ${p.count > 1 ? tr('reviews.reviewsCount', { count: p.count }) : ''}${from}
          </div>
        </div>
        <div class="rev-pacts">
          ${p.archive
            ? html`<button
                type="button"
                class="rev-adopt rev-archive"
                data-rev-archive=${idx}
                ?disabled=${actBusy}
                @click=${(ev: MouseEvent) => {
                  ev.stopPropagation();
                  onArchive(p);
                }}
              >${tr('reviews.archive')}</button>`
            : html`<button
                type="button"
                class="rev-adopt"
                data-rev-adopt=${idx}
                ?disabled=${actBusy}
                @click=${(ev: MouseEvent) => {
                  ev.stopPropagation();
                  onAdopt(p);
                }}
              >${tr('reviews.adopt')}</button>`}
          <button
            type="button"
            class="rev-dismiss"
            data-rev-dismiss=${idx}
            ?disabled=${dismissBusy}
            @click=${(ev: MouseEvent) => {
              ev.stopPropagation();
              onDismiss(p);
            }}
          >${tr('reviews.dismiss')}</button>
        </div>
      </div>`;
    })}
  </div>`;
}

function renderChangeItem(c: ReviewPanelChange): TemplateResult {
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
  const statusCls =
    c.applied === true ? 'rev-status ok' : c.applied === false ? 'rev-status bad' : 'rev-status unknown';
  const statusLabel =
    c.applied === true
      ? tr('reviews.statusApplied')
      : c.applied === false
        ? tr('reviews.statusRefused')
        : c.suggested
          ? tr('reviews.statusSuggested')
          : tr('reviews.statusUnknown');

  return html`<div class="rev-change">
    ${what}<span class="rev-name">${name}</span><span class=${statusCls}>${statusLabel}</span>
    ${c.reason ? html`<div class="rev-reason">${c.reason}</div>` : nothing}
    ${c.error ? html`<div class="rev-note bad">${c.error}</div>` : nothing}
    ${c.undo ? html`<code class="rev-undo">${c.undo}</code>` : nothing}
    ${c.command ? html`<code class="rev-undo">${c.command}</code>` : nothing}
  </div>`;
}

function renderEntryDetail(
  r: ReviewPanelEntry,
  topicExists: (id: string) => boolean,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  const isEmpty =
    r.changes.length === 0 && r.preferences.length === 0 && r.invalid.length === 0 && !r.error;
  return html`<div class="rev-detail">
    ${r.error ? html`<div class="rev-note bad">${r.error}</div>` : nothing}
    ${r.changes.length > 0
      ? html`<div class="rev-label">${tr('reviews.changes')}</div>
          ${r.changes.map(renderChangeItem)}`
      : nothing}
    ${r.invalid.length > 0
      ? html`<div class="rev-label">${tr('reviews.rejected')}</div>
          ${r.invalid.map((inv) => html`<div class="rev-note">${inv}</div>`)}`
      : nothing}
    ${r.preferences.length > 0
      ? html`<div class="rev-label">${tr('reviews.preferences')}</div>
          ${r.preferences.map((pref) => html`<div class="rev-pref">${pref}</div>`)}`
      : nothing}
    ${r.inferred ? html`<div class="rev-note">${tr('reviews.inferredNote')}</div>` : nothing}
    ${isEmpty ? html`<div class="rev-note">${tr('reviews.nothingChanging')}</div>` : nothing}
    ${r.topic && topicExists(r.topic)
      ? html`<button
          type="button"
          class="rev-open"
          data-rev-topic=${r.topic}
          @click=${(ev: MouseEvent) => {
            ev.stopPropagation();
            onOpenTopic(r.topic!);
          }}
        >${tr('reviews.openTopic')}</button>`
      : nothing}
  </div>`;
}

function renderReviewRow(
  r: ReviewPanelEntry,
  open: boolean,
  selected: boolean,
  isRead: boolean,
  nowMs: number,
  topicExists: (id: string) => boolean,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  return html`<div
    class=${`rev-item ${r.outcome}${selected ? ' on' : ''}${open ? ' open' : ''}${isRead ? ' is-read' : ''}`}
    data-rev=${r.id}
    data-rev-read=${isRead ? 'true' : 'false'}
    role="button"
    tabindex="0"
    aria-expanded=${open ? 'true' : 'false'}
  >
    <div class="rev-row">
      <span class="rev-topic">${r.title}</span>
      ${r.inferred ? html`<span class="rev-badge">${tr('reviews.inferredBadge')}</span>` : nothing}
      <span class="rev-when" title=${formatWhen(r.at)}>${formatShortReviewTime(r.at, nowMs)}</span>
    </div>
    <div class="rev-result">${r.summary}</div>
    ${open ? renderEntryDetail(r, topicExists, onOpenTopic) : nothing}
  </div>`;
}

function readStoredIds(ctx: PluginContext, key: string): Set<string> {
  const raw = ctx.storage.get<unknown>(key);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0));
}

function writeStoredIds(ctx: PluginContext, key: string, ids: ReadonlySet<string>): void {
  ctx.storage.set(key, [...ids]);
}

function renderReviewsNotice(
  noticeHost: HTMLElement,
  note: string | null,
  onDismiss: () => void,
): void {
  if (!note) {
    render(nothing, noticeHost);
    noticeHost.hidden = true;
    return;
  }
  noticeHost.hidden = false;
  render(
    renderNotice({
      tone: 'warn',
      message: note,
      dismissible: true,
      dismissIcon: icon('cross'),
      onDismiss,
    }),
    noticeHost,
  );
}

function renderReviewsEmpty(listHost: HTMLElement, data: ReturnType<ReviewsStore['snapshot']>['data']): boolean {
  if (data === null) {
    render(html`<div class="sched-empty">${tr('common.loading')}</div>`, listHost);
    return true;
  }
  if (!data.enabled) {
    render(html`<div class="sched-empty">${tr('reviews.noLibrary')}</div>`, listHost);
    return true;
  }
  if (data.reviews.length === 0 && (data.pending?.length ?? 0) === 0) {
    render(
      html`<div class="sched-empty">${data.running ? tr('reviews.emptyRunning') : tr('reviews.emptyOff')}</div>`,
      listHost,
    );
    return true;
  }
  return false;
}

function renderPendingNav(
  ctx: PluginContext,
  pendingCount: number,
  active: boolean,
  onOpen: () => void,
): TemplateResult {
  return html`<div class="fh-rev-nav">
    <div
      class=${`fh-rev-nv${active ? ' on' : ''}`}
      data-rev-prefs-nav="1"
      role="button"
      tabindex="0"
      @click=${onOpen}
      @keydown=${(ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen();
        }
      }}
    >
      ${unsafeHTML(icon('bulb'))}
      <span class="fh-rev-nv-label">${ctx.i18n.t('wb.reviews.pendingTitle')}</span>
      ${pendingCount > 0 ? html`<span class="fh-rev-nv-c">${pendingCount}</span>` : nothing}
      <span class="fh-rev-nv-cv">${unsafeHTML(icon('chevronRight'))}</span>
    </div>
  </div>`;
}

export interface ReviewsViewController extends ReviewPanelComponent {
  refreshLocale(): void;
  refreshTopics(): void;
}

function createReviewsDom(doc: Document) {
  const root = doc.createElement('div');
  root.className = 'fh-reviews-view';
  const noticeHost = doc.createElement('div');
  noticeHost.className = 'fh-reviews-notice';
  const batchBarHost = doc.createElement('div');
  batchBarHost.className = 'fh-reviews-batch';
  batchBarHost.hidden = true;
  const listHost = doc.createElement('div');
  listHost.className = 'fh-reviews-list';
  listHost.setAttribute('aria-multiselectable', 'true');
  root.append(noticeHost, batchBarHost, listHost);
  return { root, noticeHost, batchBarHost, listHost };
}

function buildReviewBatchActions(
  ids: ReadonlySet<string>,
  onMarkRead: (ids: ReadonlySet<string>) => void,
  onArchive: (ids: ReadonlySet<string>) => void,
): DomListBatchAction[] {
  const zh = getLocale() === 'zh-CN';
  return [
    { id: 'mark-read', label: zh ? '标记已读' : 'Mark read', variant: 'secondary', onAction: () => onMarkRead(ids) },
    { id: 'archive', label: zh ? '归档' : 'Archive', variant: 'secondary', onAction: () => onArchive(ids) },
  ];
}

function buildReviewToolbarActions(ctx: PluginContext): ActionItem[] {
  return [
    {
      id: 'reviews.refresh',
      icon: icon('refresh'),
      title: tr('common.refresh'),
      ariaLabel: tr('common.refresh'),
      variant: 'ghost',
      onClick: () => {
        void ctx.commands.execute('reviews.refresh');
      },
    },
  ];
}

function renderReviewsBody(
  ctx: PluginContext,
  store: ReviewsStore,
  listHost: HTMLElement,
  state: {
    readonly expanded: ReadonlySet<string>;
    readonly readIds: ReadonlySet<string>;
    readonly archivedIds: ReadonlySet<string>;
    readonly activeSelection: string | null;
    readonly inlinePendingOpen: boolean;
    readonly nowMs: number;
    readonly topicExists: (id: string) => boolean;
    readonly onOpenPrefs: () => void;
  },
): void {
  const { data, busyKeys } = store.snapshot();
  if (renderReviewsEmpty(listHost, data) || !data) return;
  const pending = data.pending ?? [];
  const visibleReviews = data.reviews.filter((r) => !state.archivedIds.has(r.id));
  const dateGroups = groupReviewsByDate(visibleReviews, state.nowMs);
  render(
    html`${renderPendingNav(ctx, pending.length, state.activeSelection === 'prefs', state.onOpenPrefs)}
      ${state.inlinePendingOpen
        ? renderPendingSection(
            pending,
            busyKeys,
            (pref) => void store.adoptSuggestion(pref),
            (pref) => void store.archiveSuggestion(pref),
            (pref) => void store.dismissSuggestion(pref.text),
          )
        : nothing}
      ${dateGroups.map(
        (g) => html`<div class="fh-rev-grp">${g.label}</div>
          ${g.items.map((r) =>
            renderReviewRow(
              r,
              state.expanded.has(r.id),
              state.activeSelection === `rev:${r.id}`,
              state.readIds.has(r.id),
              state.nowMs,
              state.topicExists,
              (tid) => ctx.topics.open(tid),
            ),
          )}`,
      )}`,
    listHost,
  );
}

export function createReviewsViewComponent(
  ctx: PluginContext,
  store: ReviewsStore,
  deps: ReviewsPluginDeps,
): ReviewsViewController {
  const doc = deps.doc ?? document;
  const now = deps.now ?? (() => Date.now());
  const disposables = new DisposableStore();
  const expanded = new Set<string>();
  const readIds = readStoredIds(ctx, 'readIds');
  const archivedIds = readStoredIds(ctx, 'archivedIds');
  let activeSelection: string | null = null;
  let inlinePendingOpen = false;
  const { root, noticeHost, batchBarHost, listHost } = createReviewsDom(doc);
  const actionBar = createActionBar(
    { items: buildReviewToolbarActions(ctx), compact: true, ariaLabel: tr('sideTasks.tabReviews') },
    doc,
  );
  disposables.add(actionBar);
  let actionBarHost: SidebarActionBarHost | null = null;

  const topicExists = (id: string): boolean => ctx.topics.list().some((t) => t.id === id);

  const openReviewOrToggle = (id: string): void => {
    activeSelection = `rev:${id}`;
    const entry = store.snapshot().data?.reviews.find((r) => r.id === id);
    try {
      ctx.editors.open('review', { id, title: entry?.title }, { id: `review:${id}` });
    } catch {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
    }
    paintList();
  };

  const openPrefsOrToggle = (): void => {
    activeSelection = 'prefs';
    try {
      ctx.editors.open('review-prefs', {}, { id: 'review:prefs' });
    } catch {
      inlinePendingOpen = !inlinePendingOpen;
    }
    paintList();
  };

  const listNav = attachListNavigation({
    container: listHost,
    batchBarHost,
    rowSelector: '[data-rev]',
    getRowId: (row) => row.getAttribute('data-rev'),
    ignoreSelector: '[data-rev-topic],[data-rev-adopt],[data-rev-archive],[data-rev-dismiss]',
    getBatchActions: (ids) =>
      buildReviewBatchActions(
        ids,
        (sel) => {
          for (const id of sel) readIds.add(id);
          writeStoredIds(ctx, 'readIds', readIds);
          listNav.clearSelection();
          paintList();
        },
        (sel) => {
          for (const id of sel) {
            archivedIds.add(id);
            expanded.delete(id);
          }
          writeStoredIds(ctx, 'archivedIds', archivedIds);
          listNav.clearSelection();
          paintList();
        },
      ),
    onActivate: (id) => openReviewOrToggle(id),
  });
  disposables.add(listNav);

  const paintNotice = (): void =>
    renderReviewsNotice(noticeHost, store.snapshot().note, () => store.clearNote());

  const paintList = (): void => {
    renderReviewsBody(ctx, store, listHost, {
      expanded,
      readIds,
      archivedIds,
      activeSelection,
      inlinePendingOpen,
      nowMs: now(),
      topicExists,
      onOpenPrefs: () => openPrefsOrToggle(),
    });
    listNav.sync();
  };

  const paint = (): void => {
    paintNotice();
    paintList();
  };

  disposables.add(store.onDidChange(() => paint()));

  return {
    element: root,
    init(_params, panelCtx): void {
      actionBarHost?.dispose();
      actionBarHost = createSidebarActionBarHost({
        viewEl: root,
        actionBarEl: actionBar.el,
        api: panelCtx?.api,
      });
      disposables.add(actionBarHost);
      disposables.add(
        panelCtx.api.onDidVisibilityChange((isVisible) => {
          if (isVisible) void store.load();
        }),
      );
      paint();
      void store.load();
    },
    focus(): void {
      const target = root.querySelector<HTMLElement>('button, [tabindex="0"]');
      target?.focus();
    },
    refreshLocale(): void {
      actionBar.update(buildReviewToolbarActions(ctx));
      actionBarHost?.sync();
      paint();
    },
    refreshTopics(): void {
      paintList();
    },
    dispose(): void {
      expanded.clear();
      disposables.dispose();
      render(nothing, noticeHost);
      render(nothing, listHost);
      root.remove();
    },
  };
}
