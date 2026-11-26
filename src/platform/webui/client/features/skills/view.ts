import type { SkillPanelEntry, SkillPanelSearch, SkillPanelSearches } from '../../../../adapter.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createActionBar,
  createFilterBar,
  createList,
  createNotice,
  createSegmented,
  createSidebarActionBarHost,
  type FilterBarStorageAdapter,
  type ListGroup,
  type ListItem,
  renderTag,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { buildSkillFilterGroups, buildSkillSortDef, filterSkills, groupSkills } from './filtering.js';
import type { SkillsStore } from './store.js';
import {
  formatIsoAgo,
  getSkillIcon,
  isSkillActive,
  type ResolvedSkillsDeps,
  type SkillPanelComponent,
} from './types.js';
import type {
  ActionBarController,
  ActionItem,
  FilterBarController,
  ListController,
  NoticeController,
  SegmentedController,
  SidebarActionBarHost,
  SidebarActionBarVisibilityApi,
} from '../../components/index.js';

const FILTER_STORAGE_KEY = 'skills_filter_v1';
const TIER_STORAGE_KEY = 'skills_tier_v1';

type SkillTierTab = 'resident' | 'library';

function createFilterStorageAdapter(ctx: PluginContext): FilterBarStorageAdapter {
  return {
    getItem(key: string): string | null {
      const val = ctx.storage.get<string>(key);
      return typeof val === 'string' ? val : null;
    },
    setItem(key: string, value: string): void {
      ctx.storage.set(key, value);
    },
  };
}

function renderSkillItemRow(
  skill: SkillPanelEntry,
  copied: boolean,
  deps: ResolvedSkillsDeps,
  onCopy: (name: string) => void,
): TemplateResult {
  const icons = deps.icons();
  const active = isSkillActive(skill);
  const copyLabel = copied ? tr('common.copied') : tr('skills.copyName');
  const copyIcon = getSkillIcon(icons, copied ? 'check' : 'copy');
  const pinIcon = skill.pinned ? getSkillIcon(icons, 'pin') : '';
  const age = formatIsoAgo(skill.lastUsedAt || skill.createdAt, deps.formatAgo);

  return html`
    <div class=${`fh-skill-row${active ? '' : ' is-archived'}`} data-skill-name=${skill.name}>
      <div class="fh-skill-row-head">
        <span class="fh-skill-row-title">
          ${pinIcon ? html`<span class="fh-skill-pin-icon" aria-hidden="true">${renderSvgUnsafe(pinIcon)}</span>` : nothing}
          <span class="fh-skill-row-name">${skill.name}</span>
          ${skill.resident ? html`<span class="fh-skill-row-tier">${tr('skills.tabResident')}</span>` : nothing}
          ${skill.status === 'expired'
            ? renderTag({ label: tr('skills.expiredCap'), tone: 'warn', title: tr('skills.expiredTitle') })
            : nothing}
        </span>
        <span class="fh-skill-row-tail">
          ${age ? html`<span class="fh-skill-row-age">${age}</span>` : nothing}
          <button
            type="button"
            class="fh-btn fh-btn--ghost fh-btn--icon fh-skill-copy"
            data-copy-skill=${skill.name}
            title=${copyLabel}
            aria-label=${copyLabel}
            @click=${(ev: MouseEvent) => {
              ev.stopPropagation();
              onCopy(skill.name);
            }}
          ><span class="fh-icon" aria-hidden="true">${copyIcon ? renderSvgUnsafe(copyIcon) : nothing}</span></button>
        </span>
      </div>
      <div class="fh-skill-row-desc">${skill.description || tr('skills.noDesc')}</div>
      ${skill.warning ? html`<div class="fh-skill-row-warn">${skill.warning}</div>` : nothing}
      ${skill.problem
        ? html`<div class="fh-skill-row-problem">${tr('skills.notDelivered')}${skill.problem}</div>`
        : nothing}
    </div>
  `;
}

function renderSvgUnsafe(markup: string): TemplateResult {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return html`${tpl.content}`;
}

function renderSearchSection(
  title: string,
  entries: readonly SkillPanelSearch[] | undefined,
  withHits: boolean,
  formatAgo: (at: number) => string,
): TemplateResult | typeof nothing {
  if (!entries || entries.length === 0) return nothing;
  return html`
    <div class="fh-skill-searches-group">
      <div class="fh-skill-searches-title">${title}</div>
      ${entries.map((entry) => {
        const metaParts = [formatIsoAgo(entry.at, formatAgo)];
        if (entry.agent) metaParts.push(entry.agent);
        if (withHits && entry.hits.length > 0) metaParts.push(entry.hits.join(', '));
        return html`<div class="fh-skill-search-item">
          <span class="fh-skill-search-q">${entry.query}</span>
          <small class="fh-skill-search-meta">${metaParts.filter(Boolean).join(' \u00b7 ')}</small>
        </div>`;
      })}
    </div>
  `;
}

function renderSearchesFooter(
  searches: SkillPanelSearches | null,
  formatAgo: (at: number) => string,
): TemplateResult | typeof nothing {
  if (!searches) return nothing;
  const hasMisses = searches.misses.length > 0;
  const hasUnread = searches.unread.length > 0;
  if (!hasMisses && !hasUnread) return nothing;
  return html`
    <div class="fh-skill-searches">
      ${renderSearchSection(tr('skills.searchesEmpty'), searches.misses, false, formatAgo)}
      ${renderSearchSection(tr('skills.searchesUnread'), searches.unread, true, formatAgo)}
    </div>
  `;
}

export function createSkillsViewPanel(
  ctx: PluginContext,
  store: SkillsStore,
  deps: ResolvedSkillsDeps,
): SkillPanelComponent {
  return new SkillsViewPanel(ctx, store, deps);
}

class SkillsViewPanel implements SkillPanelComponent {
  readonly element: HTMLElement;
  private readonly _ctx: PluginContext;
  private readonly _store: SkillsStore;
  private readonly _deps: ResolvedSkillsDeps;
  private readonly _searchesHost: HTMLElement;
  private readonly _actionBar: ActionBarController;
  private _actionBarHost: SidebarActionBarHost | null = null;
  private readonly _segmented: SegmentedController;
  private readonly _notice: NoticeController;
  private readonly _filterBar: FilterBarController;
  private readonly _list: ListController<SkillPanelEntry>;
  private readonly _disposables = new DisposableStore();
  private readonly _copyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _copiedNames = new Set<string>();
  private _tier: SkillTierTab;
  private _disposed = false;

  constructor(ctx: PluginContext, store: SkillsStore, deps: ResolvedSkillsDeps) {
    this._ctx = ctx;
    this._store = store;
    this._deps = deps;
    const doc = deps.doc;
    const icons = deps.icons();
    this._tier = ctx.storage.get<string>(TIER_STORAGE_KEY) === 'resident' ? 'resident' : 'library';

    this.element = doc.createElement('div');
    this.element.className = 'fh-skills-view';

    const segHost = doc.createElement('div');
    segHost.className = 'fh-skills-view-seg fh-sidebar-seg';
    const noticeHost = doc.createElement('div');
    noticeHost.className = 'fh-skills-view-notice';
    const filterHost = doc.createElement('div');
    filterHost.className = 'fh-skills-view-filter fh-sidebar-filter';
    const bodyHost = doc.createElement('div');
    bodyHost.className = 'fh-skills-view-body';
    this._searchesHost = doc.createElement('div');
    this._searchesHost.className = 'fh-skills-view-searches';
    this.element.append(segHost, noticeHost, filterHost, bodyHost, this._searchesHost);

    this._actionBar = createActionBar(
      { compact: true, ariaLabel: tr('skills.title'), items: this._buildActionItems(false) },
      doc,
    );
    this._disposables.add(this._actionBar);

    this._segmented = createSegmented(
      {
        kind: 'nav',
        value: this._tier,
        ariaLabel: tr('skills.tierAria'),
        options: [
          { value: 'resident', label: tr('skills.tabResident'), title: tr('skills.tierResidentTitle') },
          { value: 'library', label: tr('skills.tabLibrary'), title: tr('skills.tierLibraryTitle') },
        ],
        onChange: (value) => {
          this._tier = value === 'library' ? 'library' : 'resident';
          this._ctx.storage.set(TIER_STORAGE_KEY, this._tier);
          this._syncAll();
        },
      },
      doc,
    );
    segHost.appendChild(this._segmented.el);
    this._disposables.add(this._segmented);

    this._notice = createNotice({ tone: 'err', message: '' }, doc);
    this._notice.dismiss();
    noticeHost.appendChild(this._notice.el);
    this._disposables.add(this._notice);

    this._filterBar = this._createFilterBar(doc, icons);
    filterHost.appendChild(this._filterBar.el);
    this._disposables.add(this._filterBar);

    this._list = this._createList(doc);
    bodyHost.appendChild(this._list.el);
    this._disposables.add(this._list);
  }

  init(_params?: unknown, panelCtx?: { readonly api?: SidebarActionBarVisibilityApi }): void {
    this._actionBarHost?.dispose();
    this._actionBarHost = createSidebarActionBarHost({
      viewEl: this.element,
      actionBarEl: this._actionBar.el,
      api: panelCtx?.api,
    });
    this._disposables.add(this._actionBarHost);
    this._disposables.add(this._store.onDidChange(() => this._syncAll()));
    this._syncAll();
    if (!this._store.snapshot().fetchedAt) {
      void this._store.refresh(false);
    }
  }

  focus(): void {
    this._list.focusSelected();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const timer of this._copyTimers.values()) clearTimeout(timer);
    this._copyTimers.clear();
    this._disposables.dispose();
    render(nothing, this._searchesHost);
    this.element.remove();
  }

  private _buildActionItems(loading: boolean): ActionItem[] {
    const icons = this._deps.icons();
    return [
      {
        id: 'skills.refresh',
        icon: getSkillIcon(icons, 'refresh'),
        title: tr('skills.refreshTitle'),
        ariaLabel: tr('skills.refreshTitle'),
        variant: 'ghost',
        disabled: loading,
        onClick: () => {
          void this._ctx.commands.execute('skills.refresh');
        },
      },
      {
        id: 'skills.new',
        icon: getSkillIcon(icons, 'plus'),
        title: tr('skills.newTitle'),
        ariaLabel: tr('skills.newTitle'),
        variant: 'ghost',
        onClick: () => {
          void this._ctx.commands.execute('skills.new');
        },
      },
    ];
  }

  private _createFilterBar(doc: Document, icons: Readonly<Record<string, string>>): FilterBarController {
    return createFilterBar(
      {
        key: FILTER_STORAGE_KEY,
        placeholder: this._ctx.i18n.t('wb.skills.searchPlaceholder') || tr('common.search'),
        groups: [],
        sort: buildSkillSortDef(),
        icons: {
          search: getSkillIcon(icons, 'search'),
          cross: getSkillIcon(icons, 'cross'),
          filter: getSkillIcon(icons, 'filter'),
          sort: getSkillIcon(icons, 'sort'),
          arrowUp: getSkillIcon(icons, 'arrowUp'),
          arrowDown: getSkillIcon(icons, 'arrowDown'),
        },
        storage: createFilterStorageAdapter(this._ctx),
        onChange: () => this._paintList(),
      },
      doc,
    );
  }

  private _createList(doc: Document): ListController<SkillPanelEntry> {
    return createList<SkillPanelEntry>(
      {
        groups: [],
        ariaLabel: tr('skills.title'),
        empty: {
          title: tr('skills.empty'),
          action: {
            label: tr('skills.newSkill'),
            variant: 'primary',
            onClick: () => {
              void this._ctx.commands.execute('skills.new');
            },
          },
        },
        renderItem: (item) =>
          item.data
            ? renderSkillItemRow(item.data, this._copiedNames.has(item.id), this._deps, (n) => this._handleCopy(n))
            : html`${item.label}`,
        onActivate: (item) => {
          this._ctx.editors.open('skill', { name: item.id }, { id: `skill:${item.id}` });
        },
      },
      doc,
    );
  }

  private _handleCopy(name: string): void {
    void this._deps.copyText(name).then((ok) => {
      if (this._disposed) return;
      if (!ok) {
        this._notice.update({ tone: 'warn', message: tr('skills.copyFailed'), dismissible: true });
        return;
      }
      this._copiedNames.add(name);
      const prev = this._copyTimers.get(name);
      if (prev !== undefined) clearTimeout(prev);
      this._copyTimers.set(
        name,
        setTimeout(() => {
          this._copyTimers.delete(name);
          this._copiedNames.delete(name);
          if (!this._disposed) this._paintList();
        }, 1200),
      );
      this._paintList();
    });
  }

  private _syncAll(): void {
    if (this._disposed) return;
    const snap = this._store.snapshot();
    const tabSkills = this._skillsForTier(snap.list);
    this._filterBar.setGroups(buildSkillFilterGroups(tabSkills));
    this._paintList();
  }

  private _skillsForTier(list: readonly SkillPanelEntry[]): SkillPanelEntry[] {
    return list.filter((s) => (this._tier === 'resident' ? Boolean(s.resident) : !s.resident));
  }

  private _paintList(): void {
    if (this._disposed) return;
    const snap = this._store.snapshot();
    let residentCount = 0;
    let libraryCount = 0;
    for (const s of snap.list) {
      if (s.resident) residentCount++;
      else libraryCount++;
    }
    this._segmented.update({
      value: this._tier,
      options: [
        {
          value: 'resident',
          label: tr('skills.tabResident'),
          badge: residentCount || null,
          title: tr('skills.tierResidentTitle'),
        },
        {
          value: 'library',
          label: tr('skills.tabLibrary'),
          badge: libraryCount || null,
          title: tr('skills.tierLibraryTitle'),
        },
      ],
    });
    this._actionBar.update(this._buildActionItems(snap.loading));
    this._actionBarHost?.sync();
    this._paintNotice(snap.error, snap.enabled);

    const tabSkills = this._skillsForTier(snap.list);
    const filtered = filterSkills(tabSkills, this._filterBar.state());
    this._filterBar.setCounts(filtered.length, tabSkills.length);

    const groups: ListGroup<SkillPanelEntry>[] = groupSkills(filtered).map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      items: bucket.items.map(
        (skill): ListItem<SkillPanelEntry> => ({
          id: skill.name,
          label: skill.name,
          className: isSkillActive(skill) ? '' : 'is-archived',
          data: skill,
        }),
      ),
    }));
    this._list.setGroups(groups);
    render(renderSearchesFooter(snap.searches, this._deps.formatAgo), this._searchesHost);
  }

  private _paintNotice(error: string | null, enabled: boolean): void {
    if (error) {
      this._notice.update({
        tone: 'err',
        message: error,
        dismissible: true,
        onDismiss: () => this._store.clearError(),
      });
    } else if (!enabled) {
      this._notice.update({ tone: 'warn', message: tr('skills.disabled') });
    } else {
      this._notice.dismiss();
    }
  }
}
