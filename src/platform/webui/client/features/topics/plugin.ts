import { addDisposableListener } from '../../base/dom.js';
import { icon } from '../../../icons.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import {
  createActionBar,
  createFilterBar,
  createMenu,
  createSegmented,
  openConfirmDialog,
  type ActionBarController,
  type ActionItem,
  type FilterBarController,
  type FilterBarGroup as ComponentFilterBarGroup,
  type FilterBarOption as ComponentFilterBarOption,
  type MenuController,
  type MenuEntry,
  type SegmentedController,
} from '../../components/index.js';
import {
  attachListNavigation,
  type DomListBatchAction,
  type DomListNavigationController,
} from '../../components/list/index.js';
import { t as tr, type MessageKey } from '../../i18n/index.js';
import {
  definePlugin,
  type MenuItem,
  type MenuLocation,
  type PluginContext,
  type TopicInfo,
  type ViewContribution,
  type WebuiPlugin,
} from '../../plugins/api.js';
import type { ContributionRegistry, ResolvedMenuItem } from '../../plugins/registry.js';
import { text } from '../../services/api.js';
import type { OverlayManager } from '../../services/overlays.js';
import { createAgeTicker } from './age.js';
import { createTopicGestures, type TopicGesturesController } from './gestures.js';
import { createTopicPrefetcher, type TopicPrefetchDeps, type TopicPrefetcher } from './prefetch.js';
import { wbTopicRowHtml } from './row-render.js';
import { createTopicRowSheet, type TopicRowSheetController } from './row-sheet.js';
import {
  agentOf,
  buildTabForest,
  buildTopicFilterGroups,
  buildTopicForest,
  buildTopicRows,
  NEEDS_WHAT,
  needsYou,
  rowRunning,
  subtreeOf,
} from './tree.js';
import type { FilterBarGroup, Topic, TopicForest, TopicIcons, TreeRow } from './types.js';

export type TopicsPluginTab = 'topics' | 'starred';

type TopicsPanelComponent = ReturnType<ViewContribution['component']>;

export interface TopicsPluginDeps {
  readonly doc?: Document;
  readonly win?: Window;
  readonly instanceId?: string;
  readonly overlays?: OverlayManager;
  readonly registry?: Pick<ContributionRegistry, 'listMenuGroups' | 'refreshActivityBadges'>;
  readonly getMenuGroups?: (where: MenuLocation, target: unknown) => readonly (readonly ResolvedMenuItem[])[];
  readonly refreshActivityBadges?: () => void;
  readonly getIcons?: () => Partial<TopicIcons>;
  readonly getTopics?: () => readonly Topic[];
  readonly getActiveTopicId?: () => string;
  readonly unreadOf?: (t: Topic) => number;
  readonly needsRead?: (t: Topic) => boolean;
  readonly offSince?: (host: string) => number;
  readonly offTitle?: (host: string) => string;
  readonly onSelectTopic?: (id: string) => void;
  readonly onCreateTopic?: () => void | Promise<unknown>;
  readonly onStarTopic?: (id: string, nextStarred: boolean) => void | Promise<void>;
  readonly onCopyTopicRef?: (id: string) => void | Promise<void>;
  readonly onForkTopic?: (id: string) => void | Promise<void>;
  readonly onEndTopic?: (id: string) => void | Promise<void>;
  readonly onDeleteTopic?: (id: string) => void | Promise<void>;
  readonly onMarkAllRead?: (visible: readonly Topic[]) => void | Promise<void>;
  readonly onClearUnstarred?: () => void | Promise<void>;
  readonly prefetchDeps?: Omit<TopicPrefetchDeps, 'doc' | 'getActiveTopic' | 'getTopics' | 'topicById' | 'now'>;
  readonly confirmFn?: (message: string) => boolean;
  readonly alertFn?: (message: string) => void;
  readonly copyText?: (value: string) => void | Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_ICONS: TopicIcons = {
  more: icon('more'),
  star: icon('star'),
  chevronRight: icon('chevronRight'),
  chevronDown: icon('chevronDown'),
  fork: icon('fork'),
  offline: icon('offline'),
  search: icon('search'),
  cross: icon('cross'),
  filter: icon('filter'),
  sort: icon('sort'),
  arrowUp: icon('arrowUp'),
  arrowDown: icon('arrowDown'),
  copy: icon('copy'),
  power: icon('power'),
  trash: icon('trash'),
  pause: icon('pause'),
  play: icon('play'),
  clock: icon('clock'),
  pencil: icon('pencil'),
  plus: icon('plus'),
  check: icon('check'),
  bell: icon('bell'),
  dot: icon('dot'),
  globe: icon('globe'),
  expand: icon('expand'),
};

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function isTopicTarget(target: unknown): target is Topic {
  return Boolean(target && typeof target === 'object' && typeof (target as Topic).id === 'string');
}

function toTopic(info: TopicInfo): Topic {
  return info as unknown as Topic;
}

function resolveIcons(deps: TopicsPluginDeps): TopicIcons {
  const custom = deps.getIcons?.();
  return custom ? { ...DEFAULT_ICONS, ...custom } : DEFAULT_ICONS;
}

function resolveIconSvg(icons: TopicIcons, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return icons[name] ?? (name.startsWith('<svg') ? name : undefined);
}

function mapFilterGroups(
  groups: readonly FilterBarGroup[],
  icons: TopicIcons,
): ComponentFilterBarGroup[] {
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    pinned: g.pinned,
    options: g.options.map((o): ComponentFilterBarOption => ({
      value: o.value,
      label: o.label,
      short: o.short,
      icon: resolveIconSvg(icons, o.icon),
      count: o.count,
    })),
  }));
}

function toMenuEntries(
  groups: readonly (readonly ResolvedMenuItem[])[],
  target: Topic,
  icons: TopicIcons,
  topics: readonly Topic[],
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  let aliveSub = 0;
  for (const child of subtreeOf(target.id, topics).slice(1)) {
    if (child.live) aliveSub++;
  }
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group || group.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: 'separator' });
    for (const resolved of group) {
      const item = resolved.item;
      let label = item.label;
      let title = resolved.disabledReason ?? item.title;
      if (item.id === 'topics.endAgent' && aliveSub > 0 && !resolved.disabled) {
        label = tr(aliveSub === 1 ? 'topic.endAgentSub' : 'topic.endAgentSubs', { count: aliveSub });
        title = tr(aliveSub === 1 ? 'topic.endAgentSubTitle' : 'topic.endAgentSubsTitle', { count: aliveSub });
      }
      entries.push({
        kind: 'item',
        id: item.id,
        label,
        icon: resolveIconSvg(icons, item.icon),
        shortcut: item.id === 'topics.openInNewTab' ? 'Ctrl' : undefined,
        title,
        disabled: resolved.disabled,
        danger: item.danger,
        onSelect: () => {
          void item.run(target);
        },
      });
    }
  }
  return entries;
}

interface TopicsRuntime {
  readonly ctx: PluginContext;
  readonly deps: TopicsPluginDeps;
  readonly doc: Document;
  readonly win: Window;
  readonly nowFn: () => number;
  readonly confirmFn?: (message: string) => boolean;
  readonly alertFn: (message: string) => void;
  topics: Topic[];
  activeTopicId: string;
  tab: TopicsPluginTab;
  folded: Record<string, boolean>;
  readonly views: Set<TopicsViewInstance>;
  getIcons(): TopicIcons;
  getTopics(): readonly Topic[];
  getActiveTopicId(): string;
  topicById(id: string): Topic | null;
  getFullForest(): TopicForest;
  countNeedsYou(): number;
  setTab(tab: TopicsPluginTab): void;
  toggleFold(topicId: string): void;
  paintAll(): void;
  refreshLocale(): void;
  refreshBadges(): void;
  openTopic(id: string): void;
  getMenuGroups(where: MenuLocation, target: unknown): readonly (readonly ResolvedMenuItem[])[];
  schedulePrefetch(): void;
}

interface TopicsViewInstance extends TopicsPanelComponent {
  paint(): void;
  refreshLocale(): void;
}

function readFoldedMap(ctx: PluginContext): Record<string, boolean> {
  const stored = ctx.storage.get<unknown>('folded');
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function readInitialTab(ctx: PluginContext): TopicsPluginTab {
  return ctx.storage.get<unknown>('tab') === 'starred' ? 'starred' : 'topics';
}

function buildToolbarActions(
  rt: TopicsRuntime,
  fullForest: TopicForest,
): ActionItem[] {
  const icons = rt.getIcons();
  let stars = 0;
  let toRead = 0;
  const needsRead = rt.deps.needsRead ?? ((t: Topic) => needsYou(t, rt.getActiveTopicId()));
  for (const v of fullForest.visible) {
    if (v.starred) stars++;
    if (needsRead(v)) toRead++;
  }
  const readTitle = toRead
    ? tr(toRead === 1 ? 'sidebar.markAllReadTopics' : 'sidebar.markAllReadTopicsPlural', { count: toRead })
    : tr('sidebar.markAllReadNone');
  const clearLabel = stars ? tr('sidebar.clearUnstarredTopics') : tr('sidebar.clearAllTopics');

  const items: ActionItem[] = [
    {
      id: 'topics.new',
      icon: icons.plus,
      title: tr('sidebar.newTopic'),
      ariaLabel: tr('sidebar.newTopic'),
      variant: 'ghost',
      onClick: () => {
        void rt.ctx.commands.execute('topics.new');
      },
    },
    {
      id: 'topics.markAllRead',
      icon: icons.check,
      title: readTitle,
      ariaLabel: tr('sidebar.markAllRead'),
      variant: 'ghost',
      disabled: toRead === 0,
      onClick: () => {
        void rt.ctx.commands.execute('topics.markAllRead');
      },
    },
  ];
  if (rt.tab !== 'starred') {
    items.push({
      id: 'topics.clearUnstarred',
      icon: icons.trash,
      title: clearLabel,
      ariaLabel: clearLabel,
      variant: 'ghost',
      onClick: () => {
        void rt.ctx.commands.execute('topics.clearUnstarred');
      },
    });
  }
  return items;
}

function renderEmptyTopicsHtml(filtering: boolean, tab: TopicsPluginTab): string {
  if (filtering) {
    return (
      `<div class="topics-empty"><span>${text(tr('sidebar.noMatchingTopics'))}</span>` +
      `<button type="button" class="fb-clear" data-filter-clear="1">${text(tr('common.clear'))}</button></div>`
    );
  }
  if (tab === 'starred') {
    return `<div class="topics-empty"><span>${text(tr('sidebar.noStarredTopics'))}</span></div>`;
  }
  return '';
}

async function confirmAction(
  rt: TopicsRuntime,
  opts: {
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
    readonly danger?: boolean;
    readonly fallbackMessage?: string;
  },
): Promise<boolean> {
  if (rt.confirmFn) {
    return rt.confirmFn(opts.fallbackMessage ?? opts.title);
  }
  return openConfirmDialog({
    title: opts.title,
    body: opts.body,
    confirmLabel: opts.confirmLabel,
    cancelLabel: tr('common.cancel'),
    danger: opts.danger,
    overlays: rt.deps.overlays,
    doc: rt.doc,
  });
}

function topicSheetSubtitle(t: Topic, topics: readonly Topic[]): string {
  const parts: string[] = [];
  const agent = agentOf(t);
  if (agent) parts.push(agent.label);
  if (t.dir) parts.push(t.dir.host ? `${t.dir.host} · ${t.dir.name}` : t.dir.name);
  const running = rowRunning(t, topics);
  const state = t.asking
    ? tr('topic.awaitingYou')
    : running
      ? tr('topic.running')
      : t.stage === 'failed'
        ? tr('topic.failed')
        : tr('topics.statusIdle');
  parts.push(state);
  return parts.join(' · ');
}

function groupKeyForRow(
  row: TreeRow,
  topics: readonly Topic[],
  activeId: string,
  tab: TopicsPluginTab,
): MessageKey {
  const t = row.t;
  if (needsYou(t, activeId)) return 'topics.groupNeeds';
  if (!t.title) return 'topics.groupNew';
  if (rowRunning(t, topics)) return 'topics.groupRunning';
  if (tab === 'starred' || t.starred) return 'topics.groupStarred';
  return 'topics.groupIdle';
}

interface RenderedTopicItem {
  readonly key: string;
  readonly html: string;
}

function renderTopicRowsHtml(
  rt: TopicsRuntime,
  tabForest: TopicForest,
  topics: readonly Topic[],
  activeId: string,
  icons: TopicIcons,
  openKey: string | null,
  filterState: ReturnType<FilterBarController['state']>,
): { readonly html: string; readonly items: readonly RenderedTopicItem[]; readonly matched: number; readonly total: number } {
  const painted = buildTopicRows(tabForest, topics, activeId, rt.folded, filterState);
  const unreadOf = rt.deps.unreadOf ?? (() => 0);
  const offSince = rt.deps.offSince ?? (() => 0);
  const offTitle = rt.deps.offTitle ?? ((host: string) => host);
  const byId = new Map<string, Topic>();
  for (const item of topics) byId.set(item.id, item);
  const ctx = {
    activeTopicId: activeId,
    topics,
    rowMenuKey: openKey,
    icons,
    unreadOf,
    topicById: (id: string) => byId.get(id) ?? null,
    offSince,
    offTitle,
    now: rt.nowFn(),
  };
  let h = '';
  const items: RenderedTopicItem[] = [];
  let currentGroup: MessageKey | null = null;
  for (let i = 0; i < painted.rows.length; i++) {
    const row = painted.rows[i];
    if (!row) continue;
    const t = row.t;
    if (row.depth === 0) {
      const nextGroup = groupKeyForRow(row, topics, activeId, rt.tab);
      if (nextGroup !== currentGroup) {
        currentGroup = nextGroup;
        const grpHtml = `<div class="wb-topics-grp" role="presentation">${text(tr(nextGroup))}</div>`;
        h += grpHtml;
        items.push({ key: `grp:${nextGroup}`, html: grpHtml });
      }
    }
    const needs = needsYou(t, activeId);
    const whatKey = t.stage ? NEEDS_WHAT[t.stage] : undefined;
    const attrs = needs && whatKey ? ` title="${text(`${tr(whatKey)}${t.line ? `: ${t.line}` : ''}`)}"` : '';
    const rowHtml = wbTopicRowHtml(
      row,
      {
        attr: 'data-topic',
        menu: 'topic',
        cls: painted.dividers[i] ? ' after-needs' : '',
        tail: needs ? ' needs' : '',
        attrs,
        moreTitle: tr('topic.topicActions'),
      },
      ctx,
    );
    h += rowHtml;
    items.push({ key: `row:${t.id}`, html: rowHtml });
  }
  return {
    html: h || renderEmptyTopicsHtml(painted.filtering, rt.tab),
    items,
    matched: painted.matched,
    total: painted.total,
  };
}

function filterGroupsSig(groups: readonly FilterBarGroup[]): string {
  let out = '';
  for (const g of groups) {
    out += `${g.id}:${g.label}:${g.pinned ? 1 : 0}|`;
    for (const o of g.options) {
      out += `${o.value}=${o.count ?? ''}:${o.label}:${o.short ?? ''},`;
    }
    out += ';';
  }
  return out;
}

function actionItemsSig(items: readonly ActionItem[]): string {
  let out = '';
  for (const item of items) {
    out += `${item.id}:${item.label ?? ''}:${item.title ?? ''}:${item.disabled ? 1 : 0}|`;
  }
  return out;
}

function countTabForests(fullForest: TopicForest): { readonly allCount: number; readonly starredCount: number } {
  let allCount = 0;
  let starredCount = 0;
  for (const cid of fullForest.convOrder) {
    const c = fullForest.convs[cid];
    if (!c) continue;
    if (c.starred) starredCount++;
    if (!(c.starred && c.rank >= 3)) allCount++;
  }
  return { allCount, starredCount };
}

async function starTopicById(rt: TopicsRuntime, id: string, nextStarred: boolean): Promise<void> {
  if (rt.deps.onStarTopic) {
    await rt.deps.onStarTopic(id, nextStarred);
    return;
  }
  await rt.ctx.api.post('/api/topics/star', { topic: id, starred: nextStarred });
}

async function endTopicById(rt: TopicsRuntime, id: string): Promise<void> {
  if (rt.deps.onEndTopic) {
    await rt.deps.onEndTopic(id);
    return;
  }
  const ids = subtreeOf(id, rt.getTopics())
    .filter((t) => Boolean(t.live))
    .map((t) => t.id);
  if (ids.length === 0) return;
  await rt.ctx.api.post('/api/topics/kill', { topic: id, topics: ids });
}

function buildTopicsBatchActions(
  rt: TopicsRuntime,
  selectedIds: ReadonlySet<string>,
  clearSelection: () => void,
): DomListBatchAction[] {
  const icons = rt.getIcons();
  const selected: Topic[] = [];
  for (const id of selectedIds) {
    const found = rt.topicById(id);
    if (found) selected.push(found);
  }
  const hasUnstarred = selected.some((t) => !t.starred);
  const hasStarred = selected.some((t) => Boolean(t.starred));
  const liveTargets = selected.filter((t) =>
    subtreeOf(t.id, rt.getTopics()).some((s) => Boolean(s.live)),
  );
  const actions: DomListBatchAction[] = [];
  if (hasUnstarred) {
    actions.push({
      id: 'star',
      label: tr('topic.star'),
      icon: icons.star,
      variant: 'secondary',
      onAction: async () => {
        for (const t of selected) {
          if (!t.starred) await starTopicById(rt, t.id, true);
        }
        clearSelection();
      },
    });
  }
  if (hasStarred) {
    actions.push({
      id: 'unstar',
      label: tr('topic.unstar'),
      icon: icons.star,
      variant: 'secondary',
      onAction: async () => {
        for (const t of selected) {
          if (t.starred) await starTopicById(rt, t.id, false);
        }
        clearSelection();
      },
    });
  }
  actions.push({
    id: 'end',
    label: tr('topic.endAgent'),
    icon: icons.power,
    variant: 'secondary',
    disabled: liveTargets.length === 0,
    onAction: async () => {
      for (const t of liveTargets) await endTopicById(rt, t.id);
      clearSelection();
    },
  });
  actions.push({
    id: 'delete',
    label: tr('topic.deleteTopic'),
    icon: icons.trash,
    variant: 'danger',
    onAction: async () => {
      const confirmed = await confirmAction(rt, {
        title: tr('topics.confirmBatchDeleteTitle', { count: selected.length }),
        body: tr('topics.confirmDeleteBody'),
        confirmLabel: tr('common.delete'),
        danger: true,
      });
      if (!confirmed) return;
      if (rt.deps.onDeleteTopic) {
        for (const t of selected) await rt.deps.onDeleteTopic(t.id);
        clearSelection();
        return;
      }
      for (const t of selected) {
        await rt.ctx.api.post('/api/topics/delete', { topic: t.id });
      }
      clearSelection();
    },
  });
  return actions;
}

class TopicsViewPanel implements TopicsViewInstance {
  readonly element: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly mobileTitleEl: HTMLElement;
  private readonly batchBarHost: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly listeners = new DisposableStore();
  private readonly ageTicker: ReturnType<typeof createAgeTicker>;
  private readonly segmented: SegmentedController;
  private readonly actionBar: ActionBarController;
  private readonly filterBar: FilterBarController;
  private readonly menu: MenuController;
  private readonly rowSheet: TopicRowSheetController;
  private readonly gestures: TopicGesturesController;
  private readonly listNav: DomListNavigationController;
  private menuKey: string | null = null;
  private disposed = false;
  private panelVisible = true;
  private dirty = false;
  private lastSegSig = '';
  private lastActSig = '';
  private lastFilterSig = '';
  private lastListHtml = '';
  private lastRowKeys: string[] = [];
  private lastRowHtmls: string[] = [];
  private readonly patchTpl: HTMLTemplateElement;

  constructor(private readonly rt: TopicsRuntime) {
    const { doc, win } = rt;
    this.element = doc.createElement('div');
    this.element.className = 'wb-topics-view';
    this.patchTpl = doc.createElement('template');

    this.headerEl = doc.createElement('div');
    this.headerEl.className = 'wb-topics-head';
    this.mobileTitleEl = doc.createElement('div');
    this.mobileTitleEl.className = 'wb-topics-mobile-title';
    this.mobileTitleEl.textContent = tr('sidebar.topics');
    const segWrap = doc.createElement('div');
    segWrap.className = 'wb-topics-seg fh-sidebar-seg';
    const filterHost = doc.createElement('div');
    filterHost.className = 'wb-topics-filter fh-sidebar-filter';
    if (!doc.getElementById('topics-filter')) filterHost.id = 'topics-filter';
    this.batchBarHost = doc.createElement('div');
    this.batchBarHost.className = 'wb-topics-batch';
    this.batchBarHost.hidden = true;
    this.listEl = doc.createElement('div');
    this.listEl.className = 'wb-topics-list';
    if (!doc.getElementById('topics')) this.listEl.id = 'topics';
    this.listEl.setAttribute('role', 'list');
    this.listEl.setAttribute('aria-multiselectable', 'true');

    this.element.appendChild(this.headerEl);
    this.element.appendChild(this.mobileTitleEl);
    this.element.appendChild(segWrap);
    this.element.appendChild(filterHost);
    this.element.appendChild(this.batchBarHost);
    this.element.appendChild(this.listEl);

    this.ageTicker = createAgeTicker(doc, rt.nowFn);
    const icons = rt.getIcons();
    this.segmented = createSegmented(
      {
        kind: 'nav',
        value: rt.tab,
        ariaLabel: tr('sidebar.tabsAria'),
        options: [
          { value: 'topics', label: tr('topics.tabAll'), title: tr('sidebar.topicsTitle') },
          { value: 'starred', label: tr('sidebar.starred'), title: tr('sidebar.starredTitle') },
        ],
        onChange: (value) => rt.setTab(value === 'starred' ? 'starred' : 'topics'),
      },
      doc,
    );
    segWrap.appendChild(this.segmented.el);

    this.actionBar = createActionBar({ items: [], compact: true, ariaLabel: tr('sidebar.topics') }, doc);
    this.headerEl.appendChild(this.actionBar.el);

    this.filterBar = createFilterBar(
      {
        key: 'aa_topic_filter',
        placeholder: tr('sidebar.searchTopics'),
        groups: [],
        icons: {
          search: icons.search,
          cross: icons.cross,
          filter: icons.filter,
          sort: icons.sort,
          arrowUp: icons.arrowUp,
          arrowDown: icons.arrowDown,
        },
        storage: {
          getItem: (k) => rt.ctx.storage.get<string>(k) ?? null,
          setItem: (k, v) => rt.ctx.storage.set(k, v),
        },
        onChange: () => this.paint(),
      },
      doc,
    );
    filterHost.appendChild(this.filterBar.el);

    this.menu = createMenu({
      doc,
      win,
      overlays: rt.deps.overlays,
      align: 'end',
      className: 'wb-topic-row-menu',
    });
    this.rowSheet = createTopicRowSheet({
      doc,
      overlays: rt.deps.overlays,
    });
    this.gestures = createTopicGestures({
      container: this.listEl,
      doc,
      win,
      isMobile: () => this.isMobileMode(),
      onLongPress: (topicId) => this.openRowSheet(topicId),
    });
    this.listNav = attachListNavigation({
      container: this.listEl,
      batchBarHost: this.batchBarHost,
      rowSelector: '[data-topic]',
      getRowId: (row) => row.getAttribute('data-topic'),
      ignoreSelector: '[data-rm],[data-fold],[data-filter-clear],[data-swipe-act]',
      ctrlSelect: false,
      getBatchActions: (ids) => buildTopicsBatchActions(this.rt, ids, () => this.listNav.clearSelection()),
      onActivate: (id) => {
        if (this.gestures.consumeSuppressedClick()) return;
        if (this.gestures.getOpenId()) {
          this.gestures.closeAll();
          return;
        }
        this.rt.openTopic(id);
      },
    });
    this.bindEvents();
  }

  private isMobileMode(): boolean {
    if (this.element.closest('[data-wb-mode="mobile"]')) return true;
    return this.rt.win.innerWidth > 0 && this.rt.win.innerWidth < 640;
  }

  private bindEvents(): void {
    this.listeners.add(this.ageTicker.attach());
    this.listeners.add(addDisposableListener(this.listEl, 'click', (e) => this.handleListClick(e)));
    this.listeners.add(addDisposableListener(this.listEl, 'contextmenu', (e) => this.handleContextMenu(e)));
  }

  private handleListClick(e: MouseEvent): void {
    const el = asElement(e.target);
    if (!el) return;
    const swipeBtn = el.closest<HTMLElement>('[data-swipe-act]');
    if (swipeBtn) {
      e.stopPropagation();
      const act = swipeBtn.getAttribute('data-swipe-act');
      const id = swipeBtn.getAttribute('data-swipe-id');
      this.gestures.closeAll();
      if (id && act) this.handleSwipeAction(id, act);
      return;
    }
    if (el.closest('[data-filter-clear]')) {
      e.stopPropagation();
      this.filterBar.clear();
      return;
    }
    const more = el.closest<HTMLElement>('[data-rm]');
    if (more) {
      e.stopPropagation();
      const raw = more.getAttribute('data-rm') ?? '';
      const id = raw.startsWith('topic:') ? raw.slice('topic:'.length) : raw;
      if (id) {
        if (this.isMobileMode()) this.openRowSheet(id);
        else this.openContextMenu(id, more);
      }
      return;
    }
    const fold = el.closest('[data-fold]');
    if (fold) {
      e.stopPropagation();
      const foldId = fold.getAttribute('data-fold');
      if (foldId) this.rt.toggleFold(foldId);
      return;
    }
    this.openNewTabOnCtrlClick(e, el);
  }

  private openNewTabOnCtrlClick(e: MouseEvent, el: Element): void {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || this.listNav.isBatchMode()) return;
    const id = el.closest<HTMLElement>('[data-topic]')?.getAttribute('data-topic');
    if (!id) return;
    e.stopPropagation();
    this.rt.ctx.editors.open('topic', { topicId: id }, { preview: false });
  }

  private handleSwipeAction(topicId: string, action: string): void {
    const topic = this.rt.topicById(topicId);
    if (!topic) return;
    if (action === 'star') {
      void starTopicById(this.rt, topicId, !topic.starred);
      return;
    }
    if (action === 'more') {
      this.openRowSheet(topicId);
      return;
    }
    if (action === 'delete') {
      const groups = this.rt.getMenuGroups('topic.row', topic);
      const delItem = groups.flat().find((r) => r.item.id === 'topics.delete');
      if (delItem) void delItem.item.run(topic);
    }
  }

  private openRowSheet(topicId: string): void {
    const topic = this.rt.topicById(topicId);
    if (!topic) return;
    const entries = toMenuEntries(
      this.rt.getMenuGroups('topic.row', topic),
      topic,
      this.rt.getIcons(),
      this.rt.getTopics(),
    );
    if (entries.length === 0) return;
    const title = topic.title || tr('topics.newPlaceholderTitle');
    const subtitle = topicSheetSubtitle(topic, this.rt.getTopics());
    this.rowSheet.open({ title, subtitle }, entries);
  }

  private handleContextMenu(e: MouseEvent): void {
    const id = asElement(e.target)?.closest('[data-topic]')?.getAttribute('data-topic');
    if (!id) return;
    e.preventDefault();
    if (this.isMobileMode()) {
      this.openRowSheet(id);
      return;
    }
    this.openContextMenu(id, { x: e.clientX, y: e.clientY });
  }

  private openContextMenu(
    topicId: string,
    anchor: HTMLElement | { readonly x: number; readonly y: number },
  ): void {
    const topic = this.rt.topicById(topicId);
    if (!topic) return;
    const key = `topic:${topicId}`;
    if (this.menu.isOpen() && this.menuKey === key && !('x' in anchor)) {
      this.menu.close(true);
      this.menuKey = null;
      return;
    }
    const entries = toMenuEntries(
      this.rt.getMenuGroups('topic.row', topic),
      topic,
      this.rt.getIcons(),
      this.rt.getTopics(),
    );
    if (entries.length === 0) return;
    this.menuKey = key;
    this.menu.open(anchor, entries);
  }

  private syncActionBarHost(): void {
    const sidebarActions = !this.isMobileMode()
      ? this.element.closest('.wb-sidebar')?.querySelector<HTMLElement>('.wb-sidebar-head > .wb-part-actions') ?? null
      : null;
    if (sidebarActions && this.panelVisible) {
      if (this.actionBar.el.parentElement !== sidebarActions) {
        sidebarActions.appendChild(this.actionBar.el);
      }
      this.headerEl.hidden = true;
    } else {
      if (this.actionBar.el.parentElement !== this.headerEl) {
        this.headerEl.appendChild(this.actionBar.el);
      }
      this.headerEl.hidden = false;
    }
  }

  init(
    params?: unknown,
    panelCtx?: { readonly api?: { readonly isVisible?: boolean; onDidVisibilityChange?: (cb: (visible: boolean) => void) => Disposable } },
  ): void {
    this.rt.views.add(this);
    const ctx =
      panelCtx ??
      (params && typeof params === 'object' && 'api' in params
        ? (params as { readonly api?: { readonly isVisible?: boolean; onDidVisibilityChange?: (cb: (visible: boolean) => void) => Disposable } })
        : undefined);
    if (ctx?.api) {
      if (typeof ctx.api.isVisible === 'boolean') this.panelVisible = ctx.api.isVisible;
      const sub = ctx.api.onDidVisibilityChange?.((visible) => {
        this.panelVisible = visible;
        this.syncActionBarHost();
        if (visible && this.dirty) {
          this.dirty = false;
          this.paint();
        }
      });
      if (sub) this.listeners.add(sub);
    }
    this.syncActionBarHost();
    this.paint();
  }

  update(): void {
    this.paint();
  }

  focus(): void {
    this.filterBar.el.querySelector<HTMLElement>('.fh-fb-q')?.focus();
  }

  paint(): void {
    if (this.disposed) return;
    if (!this.panelVisible) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const topics = this.rt.getTopics();
    const activeId = this.rt.getActiveTopicId();
    const fullForest = buildTopicForest(topics, activeId);
    const { allCount, starredCount } = countTabForests(fullForest);
    const segSig = `${this.rt.tab}|${allCount}|${starredCount}|${tr('topics.tabAll')}|${tr('sidebar.starred')}`;
    if (segSig !== this.lastSegSig) {
      this.lastSegSig = segSig;
      this.segmented.update({
        value: this.rt.tab,
        options: [
          { value: 'topics', label: tr('topics.tabAll'), badge: allCount || null, title: tr('sidebar.topicsTitle') },
          { value: 'starred', label: tr('sidebar.starred'), badge: starredCount || null, title: tr('sidebar.starredTitle') },
        ],
      });
    }
    const toolbarItems = buildToolbarActions(this.rt, fullForest);
    const actSig = actionItemsSig(toolbarItems);
    if (actSig !== this.lastActSig) {
      this.lastActSig = actSig;
      this.actionBar.update(toolbarItems);
    }
    this.syncActionBarHost();

    const tabForest = buildTabForest(fullForest, this.rt.tab);
    const currentIcons = this.rt.getIcons();
    const fg = buildTopicFilterGroups(tabForest, this.rt.tab);
    const fSig = filterGroupsSig(fg.groups);
    if (fSig !== this.lastFilterSig) {
      this.lastFilterSig = fSig;
      this.filterBar.setGroups(mapFilterGroups(fg.groups, currentIcons));
    }

    const openKey = this.menu.isOpen() ? this.menuKey : null;
    const rendered = renderTopicRowsHtml(
      this.rt,
      tabForest,
      topics,
      activeId,
      currentIcons,
      openKey,
      this.filterBar.state(),
    );
    this.filterBar.setCounts(rendered.matched, rendered.total);
    if (rendered.html !== this.lastListHtml) {
      this.applyRenderedList(rendered.html, rendered.items);
      this.listNav.sync();
      this.ageTicker.armAgeTick();
    }
    if (this.menu.isOpen()) this.menu.reposition();
  }

  private applyRenderedList(html: string, items: readonly RenderedTopicItem[]): void {
    const canPatch =
      items.length > 0 &&
      items.length === this.lastRowKeys.length &&
      this.listEl.children.length === items.length &&
      items.every((it, idx) => it.key === this.lastRowKeys[idx]);
    if (canPatch) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || item.html === this.lastRowHtmls[i]) continue;
        this.patchTpl.innerHTML = item.html;
        const nextEl = this.patchTpl.content.firstElementChild;
        const prevEl = this.listEl.children[i];
        if (nextEl && prevEl) {
          this.listEl.replaceChild(nextEl, prevEl);
        }
        this.lastRowHtmls[i] = item.html;
      }
      this.lastListHtml = html;
      return;
    }
    this.listEl.innerHTML = html;
    this.lastListHtml = html;
    this.lastRowKeys = items.map((it) => it.key);
    this.lastRowHtmls = items.map((it) => it.html);
  }

  refreshLocale(): void {
    if (this.disposed) return;
    this.lastSegSig = '';
    this.lastActSig = '';
    this.lastFilterSig = '';
    this.lastListHtml = '';
    this.lastRowKeys = [];
    this.lastRowHtmls = [];
    this.mobileTitleEl.textContent = tr('sidebar.topics');
    this.filterBar.refreshI18n(tr('sidebar.searchTopics'));
    this.paint();
    this.ageTicker.paintAges();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rt.views.delete(this);
    this.listNav.dispose();
    this.gestures.dispose();
    this.rowSheet.dispose();
    this.menu.dispose();
    this.filterBar.dispose();
    this.actionBar.dispose();
    this.segmented.dispose();
    this.ageTicker.dispose();
    this.listeners.dispose();
    this.element.remove();
  }
}

function createTopicsView(rt: TopicsRuntime): TopicsViewInstance {
  return new TopicsViewPanel(rt);
}

function createTopicMenuHandlers(rt: TopicsRuntime) {
  const starRun = async (target: unknown, nextStarred: boolean): Promise<void> => {
    if (!isTopicTarget(target)) return;
    if (rt.deps.onStarTopic) {
      await rt.deps.onStarTopic(target.id, nextStarred);
      return;
    }
    await rt.ctx.api.post('/api/topics/star', { topic: target.id, starred: nextStarred });
  };

  const copyRefRun = async (target: unknown): Promise<void> => {
    if (!isTopicTarget(target)) return;
    if (rt.deps.onCopyTopicRef) {
      await rt.deps.onCopyTopicRef(target.id);
      return;
    }
    const instanceId = rt.deps.instanceId || 'web';
    const ref = `${target.title || tr('common.untitled')} (${instanceId}:main/${target.id})`;
    if (rt.deps.copyText) {
      await rt.deps.copyText(ref);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ref);
    }
  };

  const forkRun = async (target: unknown): Promise<void> => {
    if (!isTopicTarget(target)) return;
    if (rt.deps.onForkTopic) {
      await rt.deps.onForkTopic(target.id);
      return;
    }
    const nonce = Math.random().toString(36).slice(2) + rt.nowFn().toString(36);
    await rt.ctx.api.post('/api/send', { topic: target.id, text: '/fork', nonce });
  };

  const endRun = async (target: unknown): Promise<void> => {
    if (!isTopicTarget(target)) return;
    if (rt.deps.onEndTopic) {
      await rt.deps.onEndTopic(target.id);
      return;
    }
    const ids = subtreeOf(target.id, rt.getTopics())
      .filter((t) => Boolean(t.live))
      .map((t) => t.id);
    if (ids.length === 0) return;
    await rt.ctx.api.post('/api/topics/kill', { topic: target.id, topics: ids });
  };

  const deleteRun = async (target: unknown): Promise<void> => {
    if (!isTopicTarget(target)) return;
    const title = target.title || tr('common.untitled');
    const ok = await confirmAction(rt, {
      title: tr(target.starred ? 'topics.confirmDeleteStarredTitle' : 'topics.confirmDeleteTitle', { title }),
      body: tr('topics.confirmDeleteBody'),
      confirmLabel: tr('common.delete'),
      danger: true,
      fallbackMessage: tr(target.starred ? 'topic.confirmDeleteStarred' : 'topic.confirmDelete', { title }),
    });
    if (!ok) return;
    if (rt.deps.onDeleteTopic) {
      await rt.deps.onDeleteTopic(target.id);
      return;
    }
    await rt.ctx.api.post('/api/topics/delete', { topic: target.id });
  };

  return { starRun, copyRefRun, forkRun, endRun, deleteRun };
}

function registerTopicMenus(rt: TopicsRuntime, bucket: DisposableStore): void {
  const canEnd = (target: unknown): boolean => {
    if (!isTopicTarget(target)) return false;
    const under = subtreeOf(target.id, rt.getTopics());
    return under.some((t) => Boolean(t.live));
  };
  const { starRun, copyRefRun, forkRun, endRun, deleteRun } = createTopicMenuHandlers(rt);

  const items: readonly MenuItem[] = [
    {
      id: 'topics.star',
      label: tr('topic.star'),
      icon: 'star',
      title: tr('topic.starTitle'),
      group: '1_primary',
      order: 10,
      when: (target) => isTopicTarget(target) && !target.starred,
      run: (target) => starRun(target, true),
    },
    {
      id: 'topics.unstar',
      label: tr('topic.unstar'),
      icon: 'star',
      title: tr('topic.unstarTitle'),
      group: '1_primary',
      order: 10,
      when: (target) => isTopicTarget(target) && Boolean(target.starred),
      run: (target) => starRun(target, false),
    },
    {
      id: 'topics.copyRef',
      label: tr('topic.copyRef'),
      icon: 'copy',
      title: tr('topic.copyRefBtn'),
      group: '1_primary',
      order: 20,
      when: isTopicTarget,
      run: copyRefRun,
    },
    {
      id: 'topics.fork',
      label: tr('topic.fork'),
      icon: 'fork',
      title: tr('topic.forkTitle'),
      group: '1_primary',
      order: 30,
      when: (target) => isTopicTarget(target) && !(target.agent && target.agent.canFork === false),
      disabled: (target) =>
        isTopicTarget(target) && Boolean(target.running || target.asking) ? tr('topic.forkBusyTitle') : false,
      run: forkRun,
    },
    {
      id: 'topics.openInNewTab',
      label: tr('topics.openInNewTab'),
      icon: 'expand',
      title: tr('topics.openInNewTabTitle'),
      group: '1_primary',
      order: 40,
      when: isTopicTarget,
      run: (target) => {
        if (!isTopicTarget(target)) return;
        rt.ctx.editors.open('topic', { topicId: target.id }, { preview: false });
      },
    },
    {
      id: 'topics.endAgent',
      label: tr('topic.endAgent'),
      icon: 'power',
      title: tr('topic.endAgentTitle'),
      group: '2_process',
      order: 10,
      when: isTopicTarget,
      disabled: (target) => (canEnd(target) ? false : tr('topic.endAgentNoneTitle')),
      run: endRun,
    },
    {
      id: 'topics.delete',
      label: tr('topic.deleteTopic'),
      icon: 'trash',
      group: '9_danger',
      order: 10,
      danger: true,
      when: isTopicTarget,
      run: deleteRun,
    },
  ];

  for (const item of items) {
    bucket.add(rt.ctx.menus.register('topic.row', item));
  }
}

function registerTopicCommands(rt: TopicsRuntime): void {
  rt.ctx.commands.register(
    'topics.new',
    async () => {
      rt.setTab('topics');
      if (rt.deps.onCreateTopic) {
        return rt.deps.onCreateTopic();
      }
      const res = await rt.ctx.api.post<{ readonly topic?: Topic }>('/api/topics', {});
      if (res?.topic?.id) {
        rt.openTopic(res.topic.id);
        return res.topic;
      }
      return undefined;
    },
    { title: tr('sidebar.newTopic') },
  );

  rt.ctx.commands.register(
    'topics.markAllRead',
    async () => {
      const visible = rt.getFullForest().visible;
      if (rt.deps.onMarkAllRead) {
        await rt.deps.onMarkAllRead(visible);
      }
    },
    { title: tr('sidebar.markAllRead') },
  );

  rt.ctx.commands.register(
    'topics.clearUnstarred',
    async () => {
      const topics = rt.getTopics();
      const stars = topics.filter((t) => t.starred).length;
      const gone = topics.length - stars;
      if (stars && !gone) {
        rt.alertFn(tr('topic.allStarredAlert'));
        return;
      }
      const msg = stars
        ? tr('topic.confirmClearStarred', {
            gone,
            goneWord: gone === 1 ? tr('topic.nounSingular') : tr('topic.nounPlural'),
            stars,
            starsWord: stars === 1 ? tr('topic.starredOneIs') : tr('topic.starredManyAre'),
            scope: '',
          })
        : tr('topic.confirmClearAll', { total: topics.length, scope: '' });
      const ok = await confirmAction(rt, {
        title: tr('topics.confirmClearTitle'),
        body: msg,
        confirmLabel: tr('common.delete'),
        danger: true,
        fallbackMessage: msg,
      });
      if (!ok) return;
      if (rt.deps.onClearUnstarred) {
        await rt.deps.onClearUnstarred();
        return;
      }
      const res = await rt.ctx.api.post<{ readonly topic?: Topic }>('/api/topics/clear', {});
      if (res?.topic?.id) rt.openTopic(res.topic.id);
    },
    { title: tr('sidebar.clearUnstarredTopics') },
  );

  rt.ctx.commands.register('topics.switchTab', (tab: unknown) => {
    const next: TopicsPluginTab = tab === 'starred' ? 'starred' : 'topics';
    rt.setTab(next);
  });
}

export function createTopicsPlugin(deps: TopicsPluginDeps = {}): WebuiPlugin {
  let activeViews: Set<TopicsViewInstance> | null = null;

  return definePlugin({
    id: 'topics',
    activate(ctx) {
      const doc = deps.doc ?? document;
      const win = deps.win ?? window;
      const nowFn = deps.now ?? (() => Date.now());
      const views = new Set<TopicsViewInstance>();
      activeViews = views;
      const menuSubs = new DisposableStore();
      ctx.subscriptions.add(menuSubs);

      let prefetcher: TopicPrefetcher | null = null;

      const rt: TopicsRuntime = {
        ctx,
        deps,
        doc,
        win,
        nowFn,
        confirmFn: deps.confirmFn,
        alertFn: deps.alertFn ?? ((msg: string) => win.alert(msg)),
        topics: deps.getTopics ? [...deps.getTopics()] : ctx.topics.list().map(toTopic),
        activeTopicId: deps.getActiveTopicId ? deps.getActiveTopicId() : (ctx.topics.active()?.id ?? ''),
        tab: readInitialTab(ctx),
        folded: readFoldedMap(ctx),
        views,
        getIcons: () => resolveIcons(deps),
        getTopics: () => (deps.getTopics ? deps.getTopics() : rt.topics),
        getActiveTopicId: () => (deps.getActiveTopicId ? deps.getActiveTopicId() : rt.activeTopicId),
        topicById: (id) => rt.getTopics().find((t) => t.id === id) ?? null,
        getFullForest: () => buildTopicForest(rt.getTopics(), rt.getActiveTopicId()),
        countNeedsYou: () => {
          const activeId = rt.getActiveTopicId();
          let count = 0;
          for (const t of rt.getFullForest().visible) {
            if (needsYou(t, activeId)) count++;
          }
          return count;
        },
        setTab(tab) {
          if (rt.tab === tab) return;
          rt.tab = tab;
          ctx.storage.set('tab', tab);
          rt.paintAll();
        },
        toggleFold(topicId) {
          rt.folded[topicId] = rt.folded[topicId] === false;
          ctx.storage.set('folded', rt.folded);
          rt.paintAll();
        },
        paintAll() {
          for (const view of views) view.paint();
        },
        refreshLocale() {
          menuSubs.clear();
          registerTopicMenus(rt, menuSubs);
          for (const view of views) view.refreshLocale();
        },
        refreshBadges() {
          deps.refreshActivityBadges?.();
          deps.registry?.refreshActivityBadges();
        },
        openTopic(id) {
          ctx.topics.open(id);
          deps.onSelectTopic?.(id);
        },
        getMenuGroups(where, target) {
          if (deps.getMenuGroups) return deps.getMenuGroups(where, target);
          if (deps.registry) return deps.registry.listMenuGroups(where, target);
          return [];
        },
        schedulePrefetch() {
          prefetcher?.schedule();
        },
      };

      if (deps.prefetchDeps) {
        prefetcher = createTopicPrefetcher({
          ...deps.prefetchDeps,
          doc,
          getActiveTopic: () => rt.getActiveTopicId(),
          getTopics: () => rt.getTopics(),
          topicById: (id) => rt.topicById(id),
          now: nowFn,
        });
        ctx.subscriptions.add(prefetcher);
      }

      ctx.views.register({
        id: 'topics',
        title: tr('sidebar.topics'),
        icon: 'chat',
        part: 'sidebar',
        component: () => createTopicsView(rt),
      });

      ctx.activity.register({
        id: 'topics',
        title: tr('sidebar.topics'),
        icon: 'chat',
        view: 'topics',
        order: 10,
        badge: () => {
          const count = rt.countNeedsYou();
          return count > 0 ? count : null;
        },
      });

      registerTopicMenus(rt, menuSubs);
      registerTopicCommands(rt);

      ctx.events.on('topic.list', ({ topics }) => {
        rt.topics = topics.map(toTopic);
        rt.paintAll();
        rt.refreshBadges();
        rt.schedulePrefetch();
      });

      ctx.events.on('topic.active', ({ id }) => {
        rt.activeTopicId = id ?? '';
        rt.paintAll();
        rt.refreshBadges();
      });

      ctx.events.on('locale.change', () => {
        rt.refreshLocale();
      });
    },
    deactivate() {
      if (!activeViews) return;
      for (const view of [...activeViews]) {
        view.dispose();
      }
      activeViews.clear();
      activeViews = null;
    },
  });
}
