import { addDisposableListener } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createActionBar,
  createFilterBar,
  createMenu,
  createSegmented,
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
import { getLocale, t as tr } from '../../i18n/index.js';
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
import { createTopicPrefetcher, type TopicPrefetchDeps, type TopicPrefetcher } from './prefetch.js';
import { treeRowHtml } from './row-render.js';
import {
  buildTabForest,
  buildTopicFilterGroups,
  buildTopicForest,
  buildTopicRows,
  NEEDS_WHAT,
  needsYou,
  subtreeOf,
} from './tree.js';
import type { FilterBarGroup, Topic, TopicForest, TopicIcons } from './types.js';

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
  more: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  star: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l2.53 6.12 6.6.51-5.04 4.3 1.55 6.44L12 16.9l-5.64 3.47 1.55-6.44-5.04-4.3 6.6-.51z"/></svg>',
  chevronRight: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5.5 6.5 6.5L9 18.5"/></svg>',
  chevronDown: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5.5 9 6.5 6.5L18.5 9"/></svg>',
  fork: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><path d="M6 7.2V9a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 12v4.8"/></svg>',
  offline: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 3.5 20 20.5"/></svg>',
  search: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
  cross: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  filter: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 5h17l-6.5 7.5V19l-4 1.5v-8z"/></svg>',
  sort: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 20V4M16 4v16"/></svg>',
  arrowUp: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  arrowDown: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  copy: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>',
  power: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>',
  trash: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6.5h16M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 6.5l.9 12.6a1.5 1.5 0 0 0 1.5 1.4h7.2a1.5 1.5 0 0 0 1.5-1.4L18 6.5"/></svg>',
  pause: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 5.5v13M15 5.5v13"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>',
  clock: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/></svg>',
  pencil: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15.5 4.5l4 4L8.5 19.5 4 20l.5-4.5z"/></svg>',
  plus: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m4.5 12.5 5 5L19.5 7"/></svg>',
  bell: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 3.6 1.2 5.2 2.2 6.3H3.8C4.8 14.2 6 12.6 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
  dot: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/></svg>',
  globe: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg>',
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
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group || group.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: 'separator' });
    for (const resolved of group) {
      const item = resolved.item;
      entries.push({
        kind: 'item',
        id: item.id,
        label: item.label,
        icon: resolveIconSvg(icons, item.icon),
        title: resolved.disabledReason ?? item.title,
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
  readonly confirmFn: (message: string) => boolean;
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

function renderTopicRowsHtml(
  rt: TopicsRuntime,
  tabForest: TopicForest,
  topics: readonly Topic[],
  activeId: string,
  icons: TopicIcons,
  openKey: string | null,
  filterState: ReturnType<FilterBarController['state']>,
): { readonly html: string; readonly matched: number; readonly total: number } {
  const painted = buildTopicRows(tabForest, topics, activeId, rt.folded, filterState);
  const unreadOf = rt.deps.unreadOf ?? (() => 0);
  const offSince = rt.deps.offSince ?? (() => 0);
  const offTitle = rt.deps.offTitle ?? ((host: string) => host);
  const ctx = {
    activeTopicId: activeId,
    topics,
    rowMenuKey: openKey,
    icons,
    unreadOf,
    topicById: (id: string) => rt.topicById(id),
    offSince,
    offTitle,
    now: rt.nowFn(),
  };
  let h = '';
  for (let i = 0; i < painted.rows.length; i++) {
    const row = painted.rows[i];
    if (!row) continue;
    const t = row.t;
    const needs = needsYou(t, activeId);
    const whatKey = t.stage ? NEEDS_WHAT[t.stage] : undefined;
    const attrs = needs && whatKey ? ` title="${text(`${tr(whatKey)}${t.line ? `: ${t.line}` : ''}`)}"` : '';
    h += treeRowHtml(
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
  }
  return {
    html: h || renderEmptyTopicsHtml(painted.filtering, rt.tab),
    matched: painted.matched,
    total: painted.total,
  };
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
      if (rt.deps.onDeleteTopic) {
        for (const t of selected) await rt.deps.onDeleteTopic(t.id);
        clearSelection();
        return;
      }
      const zh = getLocale() === 'zh-CN';
      const msg = zh
        ? `确定删除已选的 ${selected.length} 个话题？`
        : `Delete ${selected.length} selected topics?`;
      if (!rt.confirmFn(msg)) return;
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
  private readonly batchBarHost: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly listeners = new DisposableStore();
  private readonly ageTicker: ReturnType<typeof createAgeTicker>;
  private readonly segmented: SegmentedController;
  private readonly actionBar: ActionBarController;
  private readonly filterBar: FilterBarController;
  private readonly menu: MenuController;
  private readonly listNav: DomListNavigationController;
  private menuKey: string | null = null;
  private disposed = false;

  constructor(private readonly rt: TopicsRuntime) {
    const { doc, win } = rt;
    this.element = doc.createElement('div');
    this.element.className = 'wb-topics-view';

    const headerEl = doc.createElement('div');
    headerEl.className = 'wb-topics-head';
    const segWrap = doc.createElement('div');
    segWrap.className = 'wb-topics-seg';
    const filterHost = doc.createElement('div');
    filterHost.className = 'wb-topics-filter';
    if (!doc.getElementById('topics-filter')) filterHost.id = 'topics-filter';
    this.batchBarHost = doc.createElement('div');
    this.batchBarHost.className = 'wb-topics-batch';
    this.batchBarHost.hidden = true;
    this.listEl = doc.createElement('div');
    this.listEl.className = 'wb-topics-list';
    if (!doc.getElementById('topics')) this.listEl.id = 'topics';
    this.listEl.setAttribute('role', 'list');
    this.listEl.setAttribute('aria-multiselectable', 'true');

    this.element.appendChild(headerEl);
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
          { value: 'topics', label: tr('sidebar.topics'), title: tr('sidebar.topicsTitle') },
          { value: 'starred', label: tr('sidebar.starred'), title: tr('sidebar.starredTitle') },
        ],
        onChange: (value) => rt.setTab(value === 'starred' ? 'starred' : 'topics'),
      },
      doc,
    );
    segWrap.appendChild(this.segmented.el);

    this.actionBar = createActionBar({ items: [], compact: true, ariaLabel: tr('sidebar.topics') }, doc);
    headerEl.appendChild(this.actionBar.el);

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
    this.listNav = attachListNavigation({
      container: this.listEl,
      batchBarHost: this.batchBarHost,
      rowSelector: '[data-topic]',
      getRowId: (row) => row.getAttribute('data-topic'),
      ignoreSelector: '[data-rm],[data-fold],[data-filter-clear]',
      getBatchActions: (ids) => buildTopicsBatchActions(this.rt, ids, () => this.listNav.clearSelection()),
      onActivate: (id) => this.rt.openTopic(id),
    });
    this.bindEvents();
  }

  private bindEvents(): void {
    this.listeners.add(this.ageTicker.attach());
    this.listeners.add(addDisposableListener(this.listEl, 'click', (e) => this.handleListClick(e)));
    this.listeners.add(addDisposableListener(this.listEl, 'contextmenu', (e) => this.handleContextMenu(e)));
  }

  private handleListClick(e: MouseEvent): void {
    const el = asElement(e.target);
    if (!el) return;
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
      if (id) this.openContextMenu(id, more);
      return;
    }
    const fold = el.closest('[data-fold]');
    if (fold) {
      e.stopPropagation();
      const foldId = fold.getAttribute('data-fold');
      if (foldId) this.rt.toggleFold(foldId);
      return;
    }
  }

  private handleContextMenu(e: MouseEvent): void {
    const id = asElement(e.target)?.closest('[data-topic]')?.getAttribute('data-topic');
    if (!id) return;
    e.preventDefault();
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
    const entries = toMenuEntries(this.rt.getMenuGroups('topic.row', topic), topic, this.rt.getIcons());
    if (entries.length === 0) return;
    this.menuKey = key;
    this.menu.open(anchor, entries);
  }

  init(): void {
    this.rt.views.add(this);
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
    const topics = this.rt.getTopics();
    const activeId = this.rt.getActiveTopicId();
    const fullForest = buildTopicForest(topics, activeId);
    const allCount = buildTabForest(fullForest, 'topics').convOrder.length;
    const starredCount = buildTabForest(fullForest, 'starred').convOrder.length;
    this.segmented.update({
      value: this.rt.tab,
      options: [
        { value: 'topics', label: tr('sidebar.topics'), badge: allCount || null, title: tr('sidebar.topicsTitle') },
        { value: 'starred', label: tr('sidebar.starred'), badge: starredCount || null, title: tr('sidebar.starredTitle') },
      ],
    });
    this.actionBar.update(buildToolbarActions(this.rt, fullForest));

    const tabForest = buildTabForest(fullForest, this.rt.tab);
    const currentIcons = this.rt.getIcons();
    const fg = buildTopicFilterGroups(tabForest, this.rt.tab);
    this.filterBar.setGroups(mapFilterGroups(fg.groups, currentIcons));

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
    this.listEl.innerHTML = rendered.html;
    this.listNav.sync();
    this.ageTicker.armAgeTick();
    if (this.menu.isOpen()) this.menu.reposition();
  }

  refreshLocale(): void {
    if (this.disposed) return;
    this.filterBar.refreshI18n(tr('sidebar.searchTopics'));
    this.paint();
    this.ageTicker.paintAges();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rt.views.delete(this);
    this.listNav.dispose();
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

function registerTopicMenus(rt: TopicsRuntime, bucket: DisposableStore): void {
  const canEnd = (target: unknown): boolean => {
    if (!isTopicTarget(target)) return false;
    const under = subtreeOf(target.id, rt.getTopics());
    return under.some((t) => Boolean(t.live));
  };

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
    if (rt.deps.onDeleteTopic) {
      await rt.deps.onDeleteTopic(target.id);
      return;
    }
    const title = target.title || tr('common.untitled');
    const ok = rt.confirmFn(
      tr(target.starred ? 'topic.confirmDeleteStarred' : 'topic.confirmDelete', { title }),
    );
    if (!ok) return;
    await rt.ctx.api.post('/api/topics/delete', { topic: target.id });
  };

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
      id: 'topics.endAgent',
      label: tr('topic.endAgent'),
      icon: 'power',
      title: tr('topic.endAgentTitle'),
      group: '1_primary',
      order: 40,
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
      if (rt.deps.onClearUnstarred) {
        await rt.deps.onClearUnstarred();
        return;
      }
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
      if (!rt.confirmFn(msg)) return;
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
        confirmFn: deps.confirmFn ?? ((msg: string) => win.confirm(msg)),
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
