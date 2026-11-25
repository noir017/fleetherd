import type { HistoryPanelHit, HistoryPanelSession } from '../../../../adapter.js';
import { addDisposableListener } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createFilterBar,
  createNotice,
  type FilterBarController,
  type NoticeController,
} from '../../components/index.js';
import {
  attachListNavigation,
  type DomListBatchAction,
  type DomListNavigationController,
} from '../../components/list/index.js';
import { getLocale, t as tr } from '../../i18n/index.js';
import type { PluginContext } from '../../plugins/api.js';
import { text } from '../../services/api.js';
import {
  buildHistoryFilterGroups,
  copyWithFallback,
  errorMessage,
  filterHistoryRecords,
  formatHistoryExportMarkdown,
  formatHistoryRef,
  formatHistoryShortTime,
  formatHistoryTime,
  groupHistoryByDate,
  historyAgentClass,
  type HistoryEditorInput,
  type HistoryIcons,
  type HistoryPageResponse,
  type HistoryPanelComponent,
  type HistoryPluginDeps,
  type HistoryReadResponse,
  type HistorySearchResponse,
  resolveHistoryIcons,
} from './helpers.js';

export interface HistoryViewInstance extends HistoryPanelComponent {
  setActiveId(id: string | null): void;
  refresh(): void;
  refreshLocale(): void;
}

interface HistoryViewState {
  sessions: HistoryPanelSession[];
  hits: HistoryPanelHit[];
  moreHits: boolean;
  next: string | null;
  query: string;
  seq: number;
  activeId: string | null;
  disabledLibrary: boolean;
  loading: boolean;
  copyTimers: Set<ReturnType<typeof setTimeout>>;
}

function renderCopyButton(title: string | undefined, id: string | number, icons: HistoryIcons): string {
  const ref = formatHistoryRef(title, id);
  return (
    `<button type="button" class="btn-icon hist-copy" data-hist-copy="${text(id)}"` +
    ` data-hist-title="${text(title || '')}" title="${text(tr('topic.copyRefWith', { ref }))}"` +
    ` aria-label="${text(tr('topic.copyRefBtn'))}">${icons.copy || ''}</button>`
  );
}

function renderSessionRow(s: HistoryPanelSession, activeId: string | null, icons: HistoryIcons): string {
  const count = s.messages || 0;
  const agent = s.agent || '';
  const metaBits = [
    s.platform || tr('history.unknown'),
    tr(count === 1 ? 'sched.msgOne' : 'sched.msgMany', { count }),
  ];
  const badge = agent ? `<span class="${historyAgentClass(agent)}">${text(agent)}</span>` : '';
  const shortTime = formatHistoryShortTime(s.lastAt);
  return (
    `<div class="hist-item${activeId !== null && String(s.id) === activeId ? ' on' : ''}"` +
    ` data-hist="${text(s.id)}" data-hist-title="${text(s.title || '')}" title="${text(formatHistoryTime(s.lastAt))}" role="button" tabindex="0">` +
    `<div class="hist-top"><div class="hist-title">${text(s.title || tr('history.untitled'))}</div>` +
    `<span class="hist-age">${text(shortTime)}</span>${renderCopyButton(s.title, s.id, icons)}</div>` +
    `<div class="hist-meta">${badge}${text(metaBits.join(' · '))}</div></div>`
  );
}

function renderHitRow(h: HistoryPanelHit, activeId: string | null, icons: HistoryIcons): string {
  const agent = h.agent || '';
  const badge = agent ? `<span class="${historyAgentClass(agent)}">${text(agent)}</span>` : '';
  const metaBits = [h.platform || tr('history.unknown')];
  const shortTime = formatHistoryShortTime(h.at);
  return (
    `<div class="hist-item${activeId !== null && String(h.session) === activeId ? ' on' : ''}"` +
    ` data-hist="${text(h.session)}" data-hist-title="${text(h.title || '')}" title="${text(formatHistoryTime(h.at))}" role="button" tabindex="0">` +
    `<div class="hist-top"><div class="hist-title">${text(h.title || tr('history.untitled'))}</div>` +
    `<span class="hist-age">${text(shortTime)}</span>${renderCopyButton(h.title, h.session, icons)}</div>` +
    `<div class="hist-excerpt">${text(h.excerpt)}</div>` +
    `<div class="hist-meta">${badge}${text(metaBits.join(' · '))}</div></div>`
  );
}

class HistoryViewPanel implements HistoryViewInstance {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly headerTitle: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchBtn: HTMLButtonElement;
  private readonly filterHost: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly errHost: HTMLElement;
  private readonly batchBarHost: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly filterBar: FilterBarController;
  private readonly listNav: DomListNavigationController;
  private readonly listeners = new DisposableStore();
  private readonly state: HistoryViewState = {
    sessions: [],
    hits: [],
    moreHits: false,
    next: null,
    query: '',
    seq: 0,
    activeId: null,
    disabledLibrary: false,
    loading: false,
    copyTimers: new Set(),
  };
  private errNotice: NoticeController | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly deps: HistoryPluginDeps,
    private readonly onOpen: (input: HistoryEditorInput) => void,
  ) {
    this.doc = deps.doc ?? document;
    this.element = this.doc.createElement('div');
    this.element.className = 'wb-history-view';

    const icons = resolveHistoryIcons(deps);
    const headerEl = this.doc.createElement('div');
    headerEl.className = 'wb-history-header';
    this.headerTitle = this.doc.createElement('span');
    this.headerTitle.className = 'wb-history-header-title';
    this.headerTitle.textContent = tr('sidebar.history');
    this.refreshBtn = this.doc.createElement('button');
    this.refreshBtn.type = 'button';
    this.refreshBtn.className = 'fh-btn fh-btn--ghost fh-btn--icon wb-history-refresh';
    this.refreshBtn.title = tr('common.refresh');
    this.refreshBtn.setAttribute('aria-label', tr('common.refresh'));
    this.refreshBtn.innerHTML = icons.refresh || '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/></svg>';
    headerEl.append(this.headerTitle, this.refreshBtn);

    const searchForm = this.doc.createElement('div');
    searchForm.className = 'wb-history-search';
    const searchIconWrap = this.doc.createElement('span');
    searchIconWrap.className = 'wb-history-search-icon';
    searchIconWrap.innerHTML = icons.search;
    this.searchInput = this.doc.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'fh-input wb-history-q';
    this.searchInput.autocomplete = 'off';
    this.searchInput.spellcheck = false;
    this.searchInput.placeholder = tr('history.searchPlaceholder');
    this.searchInput.setAttribute('aria-label', tr('history.searchPlaceholder'));

    this.searchBtn = this.doc.createElement('button');
    this.searchBtn.type = 'button';
    this.searchBtn.className = 'fh-btn fh-btn--ghost wb-history-go';
    this.searchBtn.textContent = tr('common.search');
    this.searchBtn.title = tr('history.searchTitle');
    searchForm.append(searchIconWrap, this.searchInput, this.searchBtn);

    this.filterHost = this.doc.createElement('div');
    this.filterHost.className = 'wb-history-filter';
    this.filterHost.hidden = true;
    this.countEl = this.doc.createElement('div');
    this.countEl.className = 'wb-history-count';
    this.errHost = this.doc.createElement('div');
    this.errHost.className = 'wb-history-err';
    this.errHost.hidden = true;
    this.batchBarHost = this.doc.createElement('div');
    this.batchBarHost.className = 'wb-history-batch';
    this.batchBarHost.hidden = true;

    const bodyEl = this.doc.createElement('div');
    bodyEl.className = 'wb-history-body';
    this.listEl = this.doc.createElement('div');
    this.listEl.className = 'wb-history-list';
    this.listEl.setAttribute('role', 'list');
    this.listEl.setAttribute('aria-multiselectable', 'true');
    this.moreBtn = this.doc.createElement('button');
    this.moreBtn.type = 'button';
    this.moreBtn.className = 'fh-btn fh-btn--secondary wb-history-more';
    this.moreBtn.textContent = tr('history.loadOlder');
    this.moreBtn.hidden = true;
    bodyEl.appendChild(this.listEl);
    bodyEl.appendChild(this.moreBtn);

    this.element.appendChild(headerEl);
    this.element.appendChild(searchForm);
    this.element.appendChild(this.filterHost);
    this.element.appendChild(this.countEl);
    this.element.appendChild(this.errHost);
    this.element.appendChild(this.batchBarHost);
    this.element.appendChild(bodyEl);

    this.filterBar = createFilterBar(
      {
        key: 'aa_history_filter',
        placeholder: tr('common.filter'),
        groups: [],
        icons: { search: icons.search, cross: icons.cross, filter: icons.filter },
        storage: {
          getItem: (k) => ctx.storage.get<string>(k) ?? null,
          setItem: (k, v) => ctx.storage.set(k, v),
        },
        onChange: () => this.paintList(),
      },
      this.doc,
    );
    this.filterHost.appendChild(this.filterBar.el);
    this.listNav = attachListNavigation({
      container: this.listEl,
      batchBarHost: this.batchBarHost,
      rowSelector: '[data-hist]',
      getRowId: (row) => row.getAttribute('data-hist'),
      ignoreSelector: '[data-hist-copy]',
      getBatchActions: (ids) => this.buildBatchActions(ids),
      onActivate: (_id, row) => this.openFromRow(row),
    });
    this.bindEvents();
  }

  private bindEvents(): void {
    this.listeners.add(addDisposableListener(this.refreshBtn, 'click', () => this.refresh()));
    this.listeners.add(addDisposableListener(this.searchBtn, 'click', () => this.runSearch()));
    this.listeners.add(
      addDisposableListener(this.searchInput, 'keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          this.runSearch();
        }
      }),
    );
    this.listeners.add(
      addDisposableListener(this.searchInput, 'input', () => {
        if (this.searchInput.value.trim()) return;
        this.state.query = '';
        if (this.state.sessions.length) this.paintList();
        else this.loadSessions();
      }),
    );
    this.listeners.add(
      addDisposableListener(this.moreBtn, 'click', () => {
        if (this.state.next) this.loadSessions(this.state.next);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.listEl, 'click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const copyBtn = target?.closest<HTMLElement>('[data-hist-copy]');
        if (copyBtn) {
          e.stopPropagation();
          this.copyRowRef(copyBtn);
        }
      }),
    );
  }

  private resolveSelectedInputs(ids: ReadonlySet<string>): HistoryEditorInput[] {
    const inputs: HistoryEditorInput[] = [];
    const seen = new Set<string>();
    for (const row of this.listEl.querySelectorAll<HTMLElement>('[data-hist]')) {
      const id = row.getAttribute('data-hist');
      if (!id || !ids.has(id) || seen.has(id)) continue;
      seen.add(id);
      const title = row.getAttribute('data-hist-title') || undefined;
      inputs.push({ id, title, query: this.state.query || undefined });
    }
    return inputs;
  }

  private async exportSelected(ids: ReadonlySet<string>): Promise<void> {
    const inputs = this.resolveSelectedInputs(ids);
    if (inputs.length === 0) return;
    if (this.deps.onExportSessions) {
      await this.deps.onExportSessions(inputs);
      this.listNav.clearSelection();
      return;
    }
    const records: Array<{ readonly id: string; readonly title?: string; readonly messages?: HistoryReadResponse['messages'] }> = [];
    for (const item of inputs) {
      try {
        const res = await this.ctx.api.get<HistoryReadResponse>(
          `/api/history/read?id=${encodeURIComponent(item.id)}`,
        );
        records.push({
          id: item.id,
          title: res?.session?.title ?? item.title,
          messages: res?.messages,
        });
      } catch {
        records.push({ id: item.id, title: item.title });
      }
    }
    const md = formatHistoryExportMarkdown(records);
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = this.doc.createElement('a');
      a.href = url;
      a.download = `fleetherd-history-${inputs.length}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      copyWithFallback(md, this.deps, () => {});
    }
    this.listNav.clearSelection();
  }

  private buildBatchActions(ids: ReadonlySet<string>): DomListBatchAction[] {
    const zh = getLocale() === 'zh-CN';
    return [
      {
        id: 'open',
        label: zh ? '打开' : 'Open',
        variant: 'primary',
        onAction: () => {
          const inputs = this.resolveSelectedInputs(ids);
          for (const input of inputs) this.onOpen(input);
          this.listNav.clearSelection();
        },
      },
      {
        id: 'export',
        label: zh ? '导出' : 'Export',
        variant: 'secondary',
        onAction: () => this.exportSelected(ids),
      },
    ];
  }

  private setError(msg: string | null): void {
    if (!msg) {
      this.errHost.hidden = true;
      this.errNotice?.dispose();
      this.errNotice = null;
      return;
    }
    this.errHost.hidden = false;
    if (!this.errNotice) {
      this.errNotice = createNotice({ tone: 'err', message: msg }, this.doc);
      this.errHost.replaceChildren(this.errNotice.el);
    } else {
      this.errNotice.update({ tone: 'err', message: msg });
    }
  }

  private paintSearchHits(icons: HistoryIcons): void {
    const groups = buildHistoryFilterGroups(this.state.hits, icons);
    this.filterBar.setGroups(groups);
    this.filterHost.hidden = groups.length === 0;
    const visibleHits = filterHistoryRecords(this.state.hits, this.filterBar.state());
    this.filterBar.setCounts(visibleHits.length, this.state.hits.length);
    if (!visibleHits.length) {
      this.listEl.innerHTML = `<div class="skills-empty">${text(tr('history.noMatches', { query: this.state.query }))}</div>`;
      this.countEl.textContent = '';
    } else {
      this.listEl.innerHTML = visibleHits.map((h) => renderHitRow(h, this.state.activeId, icons)).join('');
      const countStr = `${visibleHits.length}${this.state.moreHits ? '+' : ''}`;
      this.countEl.textContent = tr(
        visibleHits.length === 1 && !this.state.moreHits ? 'history.matchOne' : 'history.matchMany',
        { count: countStr },
      );
    }
    this.moreBtn.hidden = true;
    this.listNav.sync();
  }

  private paintList(): void {
    if (this.disposed) return;
    const currentIcons = resolveHistoryIcons(this.deps);
    if (this.state.disabledLibrary) {
      this.listEl.innerHTML = `<div class="skills-empty">${text(tr('history.noLibrary'))}</div>`;
      this.countEl.textContent = '';
      this.moreBtn.hidden = true;
      this.listNav.sync();
      return;
    }
    if (this.state.query) {
      this.paintSearchHits(currentIcons);
      return;
    }
    const filterGroups = buildHistoryFilterGroups(this.state.sessions, currentIcons);
    this.filterBar.setGroups(filterGroups);
    this.filterHost.hidden = filterGroups.length === 0;
    const visibleSessions = filterHistoryRecords(this.state.sessions, this.filterBar.state());
    this.filterBar.setCounts(visibleSessions.length, this.state.sessions.length);
    if (visibleSessions.length) {
      const dateGroups = groupHistoryByDate(visibleSessions, (s) => s.lastAt);
      this.listEl.innerHTML = dateGroups
        .map(
          (g) =>
            `<div class="wb-history-grp">${text(g.label)}</div>` +
            g.items.map((s) => renderSessionRow(s, this.state.activeId, currentIcons)).join(''),
        )
        .join('');
    } else {
      this.listEl.innerHTML = `<div class="skills-empty">${text(tr('history.empty'))}</div>`;
    }
    const n = visibleSessions.length;
    const countStr = `${n}${this.state.next ? '+' : ''}`;
    this.countEl.textContent = n
      ? tr(n === 1 && !this.state.next ? 'history.convOne' : 'history.convMany', { count: countStr })
      : '';
    this.moreBtn.hidden = !this.state.next;
    this.moreBtn.disabled = false;
    this.listNav.sync();
  }

  private loadSessions(before?: string): void {
    const seq = ++this.state.seq;
    this.state.loading = true;
    this.moreBtn.disabled = true;
    this.setError(null);
    if (!before && (!this.state.sessions.length || this.state.query)) {
      this.listEl.innerHTML = `<div class="skills-empty">${text(tr('common.loading'))}</div>`;
      this.countEl.textContent = '';
    }
    const path = before ? `/api/history?before=${encodeURIComponent(before)}` : '/api/history';
    void this.ctx.api.get<HistoryPageResponse>(path).then(
      (page) => {
        if (this.disposed || seq !== this.state.seq) return;
        this.state.loading = false;
        this.state.query = '';
        this.state.hits = [];
        this.state.moreHits = false;
        if (page && page.enabled === false) {
          this.state.disabledLibrary = true;
          this.paintList();
          return;
        }
        this.state.disabledLibrary = false;
        const rows = page?.sessions ?? [];
        this.state.sessions = before ? this.state.sessions.concat(rows) : rows;
        this.state.next = page?.next ?? null;
        this.paintList();
      },
      (err: unknown) => {
        if (this.disposed || seq !== this.state.seq) return;
        this.state.loading = false;
        this.setError(tr('history.readLibraryFailed', { err: errorMessage(err) }));
        if (!this.state.sessions.length || this.state.query) this.listEl.innerHTML = '';
        this.moreBtn.hidden = !this.state.next;
        this.moreBtn.disabled = false;
      },
    );
  }

  private runSearch(): void {
    const q = this.searchInput.value.trim();
    if (!q) {
      this.state.query = '';
      if (this.state.sessions.length) this.paintList();
      else this.loadSessions();
      return;
    }
    const seq = ++this.state.seq;
    this.moreBtn.hidden = true;
    this.setError(null);
    this.countEl.textContent = '';
    this.listEl.innerHTML = `<div class="skills-empty">${text(tr('common.searching'))}</div>`;
    void this.ctx.api.get<HistorySearchResponse>(`/api/history/search?q=${encodeURIComponent(q)}`).then(
      (res) => {
        if (this.disposed || seq !== this.state.seq) return;
        if (!res || res.error) {
          this.listEl.innerHTML = `<div class="skills-empty">${text(res?.error || tr('history.searchFailedDefault'))}</div>`;
          return;
        }
        if (res.enabled === false) {
          this.state.disabledLibrary = true;
          this.paintList();
          return;
        }
        this.state.disabledLibrary = false;
        this.state.query = q;
        this.state.hits = res.hits ?? [];
        this.state.moreHits = Boolean(res.more);
        this.paintList();
      },
      (err: unknown) => {
        if (this.disposed || seq !== this.state.seq) return;
        this.listEl.innerHTML = `<div class="skills-empty">${text(tr('history.searchFailed', { err: errorMessage(err) }))}</div>`;
      },
    );
  }

  private copyRowRef(btn: HTMLElement): void {
    const id = btn.getAttribute('data-hist-copy');
    if (!id) return;
    const ref = formatHistoryRef(btn.getAttribute('data-hist-title') || undefined, id);
    copyWithFallback(ref, this.deps, (ok) => {
      if (this.disposed) return;
      const ic = resolveHistoryIcons(this.deps);
      btn.innerHTML = ok ? ic.check : ic.cross;
      btn.classList.toggle('copied', ok);
      const say = ok ? tr('common.copied') : tr('common.copyFailed');
      btn.title = say;
      btn.setAttribute('aria-label', say);
      const timer = setTimeout(() => {
        this.state.copyTimers.delete(timer);
        if (this.disposed) return;
        btn.innerHTML = ic.copy;
        btn.classList.remove('copied');
        btn.title = tr('topic.copyRefWith', { ref });
        btn.setAttribute('aria-label', tr('topic.copyRefBtn'));
      }, 1500);
      this.state.copyTimers.add(timer);
    });
  }

  private openFromRow(row: Element): void {
    const id = row.getAttribute('data-hist');
    if (!id) return;
    const title = row.getAttribute('data-hist-title') || undefined;
    this.state.activeId = id;
    this.paintList();
    this.onOpen({ id, title, query: this.state.query || undefined });
  }

  init(): void {
    this.loadSessions();
  }

  update(): void {
    this.paintList();
  }

  focus(): void {
    this.searchInput.focus();
  }

  setActiveId(id: string | null): void {
    this.state.activeId = id;
    for (const row of this.listEl.querySelectorAll('[data-hist]')) {
      row.classList.toggle('on', id !== null && row.getAttribute('data-hist') === id);
    }
  }

  refresh(): void {
    if (this.searchInput.value.trim()) this.runSearch();
    else this.loadSessions();
  }

  refreshLocale(): void {
    this.headerTitle.textContent = tr('sidebar.history');
    this.refreshBtn.title = tr('common.refresh');
    this.refreshBtn.setAttribute('aria-label', tr('common.refresh'));
    this.searchInput.placeholder = tr('history.searchPlaceholder');
    this.searchInput.setAttribute('aria-label', tr('history.searchPlaceholder'));
    this.searchBtn.textContent = tr('common.search');
    this.searchBtn.title = tr('history.searchTitle');
    this.moreBtn.textContent = tr('history.loadOlder');
    this.filterBar.refreshI18n(tr('common.filter'));
    this.paintList();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state.seq++;
    for (const timer of this.state.copyTimers) clearTimeout(timer);
    this.state.copyTimers.clear();
    this.errNotice?.dispose();
    this.listNav.dispose();
    this.filterBar.dispose();
    this.listeners.dispose();
    this.element.remove();
  }
}

export function createHistoryView(
  ctx: PluginContext,
  deps: HistoryPluginDeps,
  onOpen: (input: HistoryEditorInput) => void,
): HistoryViewInstance {
  return new HistoryViewPanel(ctx, deps, onOpen);
}
