import type { SchedulePanelTask } from '../../../../adapter.js';
import { icon } from '../../../icons.js';
import { addDisposableListener } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { DisposableStore } from '../../base/lifecycle.js';
import {
  createFilterBar,
  createMenu,
  createSegmented,
  type MenuEntry,
  renderNotice,
  renderStatusDot,
  type StatusTone,
} from '../../components/index.js';
import { t as tr } from '../../i18n/index.js';
import type { PluginContext, TopicInfo } from '../../plugins/api.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  buildFilterGroups,
  collectScheduledSessionTree,
  filterAndSortTasks,
  formatClock,
  formatDueIn,
  formatLastRun,
  formatLastRunShort,
  formatRelativeAge,
  formatTasksSummary,
  groupScheduledSessions,
  harnessClass,
  resolveTargetShort,
  scheduledSessions,
  type SessionGroup,
  taskTags,
} from './helpers.js';
import type { SchedulesStore } from './store.js';
import type {
  SchedulePanelComponent,
  SchedulesPluginDeps,
  ScheduleSubtab,
} from './types.js';

const SUBTAB_STORAGE_KEY = 'subtab';
const SESS_GROUPS_STORAGE_KEY = 'sess_groups';

function taskDotStatus(t: SchedulePanelTask): { tone: StatusTone; pulsing: boolean } {
  if (t.running) return { tone: 'ok', pulsing: true };
  if (t.last && t.last.status !== 'ok') return { tone: 'err', pulsing: false };
  if (t.state === 'active') return { tone: 'ok', pulsing: false };
  return { tone: 'idle', pulsing: false };
}

function taskRowTooltip(t: SchedulePanelTask, topics: readonly TopicInfo[], nowMs: number): string {
  const bits: string[] = [];
  if (t.when) bits.push(t.when);
  if (t.next) bits.push(tr('sched.nextPrefix', { next: t.next }));
  bits.push(tr('sched.postsTo', { target: resolveTargetShort(t, topics) }));
  const last = formatLastRun(t, nowMs);
  if (last) bits.push(last);
  if (t.run) bits.push(t.run);
  return bits.join(' \u00b7 ');
}

function renderTaskRow(
  t: SchedulePanelTask,
  active: boolean,
  topics: readonly TopicInfo[],
  nowMs: number,
  onOpen: (task: SchedulePanelTask) => void,
  onMenu: (anchor: HTMLElement, task: SchedulePanelTask) => void,
): TemplateResult {
  const taskState = t.state || 'active';
  const dot = taskDotStatus(t);
  const lastShort = formatLastRunShort(t, nowMs);
  const rightLabel = t.running
    ? tr('sched.statusRunning')
    : taskState === 'active' && t.nextAt
      ? formatDueIn(t.nextAt, nowMs)
      : taskState !== 'active'
        ? taskState
        : '';

  return html`<div class=${`sched-item ${taskState}${t.running ? ' running' : ''}`} data-id=${t.id}>
    <div
      class=${`topic-item sched-row${active ? ' on' : ''}${t.running ? ' running' : ''}${taskState === 'active' ? '' : ' idle'}`}
      role="button"
      tabindex="0"
      title=${taskRowTooltip(t, topics, nowMs)}
      @click=${() => onOpen(t)}
      @keydown=${(ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(t);
        }
      }}
    >
      ${renderStatusDot({ status: dot.tone, pulsing: dot.pulsing })}
      <span class="topic-main">
        <span class="topic-title">${t.name}</span>
        <span class="topic-sub">
          <span class="topic-dir sched-line">
            ${t.when ? html`<span class="sched-when">${t.when}</span>` : nothing}
            <span class="sched-target">${` \u00b7 \u2192 ${resolveTargetShort(t, topics)}`}</span>
            ${lastShort
              ? html`<span class=${`sched-last${t.last && t.last.status !== 'ok' ? ' bad' : ''}`}>${` \u00b7 ${lastShort}`}</span>`
              : nothing}
            ${taskTags(t).map((tag) => html`<span class="sched-row-tag">${` \u00b7 #${tag}`}</span>`)}
          </span>
        </span>
      </span>
      ${rightLabel ? html`<span class=${`sched-row-age${t.running ? ' is-running' : ''}`}>${rightLabel}</span>` : nothing}
      <button
        type="button"
        class="topic-more"
        data-task-menu=${t.id}
        title=${tr('sched.taskActions')}
        aria-label=${tr('sched.taskActions')}
        aria-haspopup="menu"
        aria-expanded="false"
        @click=${(ev: MouseEvent) => {
          ev.stopPropagation();
          onMenu(ev.currentTarget as HTMLElement, t);
        }}
      >${unsafeHTML(icon('more'))}</button>
    </div>
  </div>`;
}

function sessionDotStatus(t: TopicInfo): { tone: StatusTone; pulsing: boolean } {
  if (t.asking) return { tone: 'warn', pulsing: true };
  if (t.running) return { tone: 'ok', pulsing: true };
  if (t.stage === 'failed') return { tone: 'err', pulsing: false };
  return { tone: 'idle', pulsing: false };
}

function sessionStateLabel(t: TopicInfo): string {
  if (t.asking) return tr('topic.awaitingYou');
  if (t.running) return tr('topic.running');
  if (t.stage === 'failed') return tr('topic.failed');
  if (t.stage === 'review') return tr('topic.finished');
  return '';
}

function renderSessionItem(
  t: TopicInfo,
  depth: number,
  activeId: string | undefined,
  unread: number,
  nowMs: number,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  const dot = sessionDotStatus(t);
  const count = t.msgCount || 0;
  const stateLabel = sessionStateLabel(t);
  const age = t.lastAt ? formatRelativeAge(t.lastAt, nowMs) : '';
  const bits = [
    count ? tr(count === 1 ? 'sched.msgOne' : 'sched.msgMany', { count }) : '',
    stateLabel,
  ].filter(Boolean);
  const harnessLabel = t.agent?.harness || t.agent?.id || '';

  return html`<div
    class=${`topic-item sess-item${depth > 0 ? ` is-sub is-d${depth}` : ''}${t.id === activeId ? ' on' : ''}${t.running ? ' running' : ' idle'}`}
    data-sess=${t.id}
    role="button"
    tabindex="0"
    title=${t.lastAt ? tr('age.ended', { when: formatClock(t.lastAt) }) : t.title}
    @click=${() => onOpenTopic(t.id)}
    @keydown=${(ev: KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onOpenTopic(t.id);
      }
    }}
  >
    ${renderStatusDot({ status: dot.tone, pulsing: dot.pulsing })}
    <span class="topic-main">
      <span class="topic-title">${t.title || tr('common.untitled')}</span>
      <span class="topic-sub">
        <span class="topic-dir">
          ${harnessLabel ? html`<span class=${harnessClass(t.agent?.harness)}>${harnessLabel}</span>` : nothing}
          ${bits.join(' \u00b7 ')}
        </span>
      </span>
    </span>
    ${age ? html`<span class="sched-row-age">${age}</span>` : nothing}
    ${unread > 0 ? html`<span class="topic-badge">${unread > 99 ? '99+' : unread}</span>` : nothing}
  </div>`;
}

function renderSessionGroup(
  g: SessionGroup,
  depthMap: ReadonlyMap<string, number>,
  open: boolean,
  activeId: string | undefined,
  unreadOf: (t: TopicInfo) => number,
  nowMs: number,
  onToggle: (key: string) => void,
  onOpenTopic: (id: string) => void,
): TemplateResult {
  const id = `sess-g-${g.key.replace(/:/g, '-')}`;
  return html`<div class="sess-group">
    <button
      type="button"
      class="sess-group-head"
      data-sgroup=${g.key}
      aria-expanded=${open ? 'true' : 'false'}
      aria-controls=${id}
      @click=${() => {
        if (!g.current) onToggle(g.key);
      }}
    >
      <span class="sess-group-caret">${unsafeHTML(open ? icon('chevronDown') : icon('chevronRight'))}</span>
      <span class="sess-group-name">${g.label}</span>
      <span class="sess-group-count">${g.items.length}</span>
      ${g.unread > 0
        ? html`<span class="sess-group-flag unread">${tr('sched.unreadCount', { count: g.unread })}</span>`
        : nothing}
      ${g.asking > 0
        ? html`<span class="sess-group-flag asking">${tr('sched.awaitingCount', { count: g.asking })}</span>`
        : nothing}
      ${!open && g.running > g.asking
        ? html`<span class="sess-group-flag running">${tr('sched.runningCount', { count: g.running - g.asking })}</span>`
        : nothing}
    </button>
    <div class="sess-group-rows" id=${id} ?hidden=${!open}>
      ${g.items.map((item) => renderSessionItem(item, depthMap.get(item.id) ?? 0, activeId, unreadOf(item), nowMs, onOpenTopic))}
    </div>
  </div>`;
}

export interface SchedulesViewController extends SchedulePanelComponent {
  refreshLocale(): void;
  refreshTopics(): void;
}

class SchedulesView implements SchedulesViewController {
  readonly element: HTMLElement;
  private readonly _ctx: PluginContext;
  private readonly _store: SchedulesStore;
  private readonly _deps: SchedulesPluginDeps;
  private readonly _resolveTaskMenu: (task: SchedulePanelTask) => readonly MenuEntry[];
  private readonly _doc: Document;
  private readonly _now: () => number;
  private readonly _unreadOf: (t: TopicInfo) => number;
  private readonly _disposables = new DisposableStore();
  private readonly _headerHost: HTMLElement;
  private readonly _filterHost: HTMLElement;
  private readonly _sessSearchHost: HTMLElement;
  private readonly _sessSearchInput: HTMLInputElement;
  private readonly _noticeHost: HTMLElement;
  private readonly _listHost: HTMLElement;
  private readonly _menu: ReturnType<typeof createMenu>;
  private readonly _segmented: ReturnType<typeof createSegmented>;
  private readonly _filterBar: ReturnType<typeof createFilterBar>;
  private readonly _sessGroups: Record<string, boolean>;
  private _subtab: ScheduleSubtab;
  private _activeTaskId: string | null = null;
  private _sessQuery = '';
  private _visible = true;
  private _pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    ctx: PluginContext,
    store: SchedulesStore,
    deps: SchedulesPluginDeps,
    resolveTaskMenu: (task: SchedulePanelTask) => readonly MenuEntry[],
  ) {
    this._ctx = ctx;
    this._store = store;
    this._deps = deps;
    this._resolveTaskMenu = resolveTaskMenu;
    this._doc = deps.doc ?? document;
    this._now = deps.now ?? (() => Date.now());
    this._unreadOf = deps.unreadOf ?? (() => 0);

    this.element = this._doc.createElement('div');
    this.element.className = 'fh-schedules-view';
    this._headerHost = this._doc.createElement('div');
    this._headerHost.className = 'fh-schedules-header';
    const subtabHost = this._doc.createElement('div');
    subtabHost.className = 'fh-schedules-subnav';
    this._filterHost = this._doc.createElement('div');
    this._filterHost.className = 'fh-schedules-filter';
    this._sessSearchHost = this._doc.createElement('div');
    this._sessSearchHost.className = 'fh-schedules-sess-search';
    const sessSearchBox = this._doc.createElement('div');
    sessSearchBox.className = 'fh-search-box';
    sessSearchBox.innerHTML = icon('search');
    this._sessSearchInput = this._doc.createElement('input');
    this._sessSearchInput.type = 'search';
    this._sessSearchInput.className = 'fh-search-input';
    this._sessSearchInput.placeholder = this._ctx.i18n.t('wb.sched.searchSessions');
    this._sessSearchInput.setAttribute('aria-label', this._ctx.i18n.t('wb.sched.searchSessions'));
    sessSearchBox.appendChild(this._sessSearchInput);
    this._sessSearchHost.appendChild(sessSearchBox);
    this._noticeHost = this._doc.createElement('div');
    this._noticeHost.className = 'fh-schedules-notice';
    this._listHost = this._doc.createElement('div');
    this._listHost.className = 'fh-schedules-body';
    this.element.append(
      this._headerHost,
      subtabHost,
      this._filterHost,
      this._sessSearchHost,
      this._noticeHost,
      this._listHost,
    );

    this._subtab = ctx.storage.get<string>(SUBTAB_STORAGE_KEY) === 'sessions' ? 'sessions' : 'tasks';
    this._sessGroups = { ...(ctx.storage.get<Record<string, boolean>>(SESS_GROUPS_STORAGE_KEY) ?? {}) };
    this._menu = createMenu({ overlays: deps.overlays, doc: this._doc, win: deps.win ?? window });
    this._disposables.add(this._menu);

    this._segmented = createSegmented(
      {
        kind: 'nav',
        value: this._subtab,
        ariaLabel: tr('sideTasks.subnavAria'),
        options: [
          { value: 'tasks', label: tr('sideTasks.tabTasks') },
          { value: 'sessions', label: tr('sideTasks.tabSessions') },
        ],
        onChange: (val) => {
          this._menu.close(false);
          this._subtab = val === 'sessions' ? 'sessions' : 'tasks';
          this._ctx.storage.set(SUBTAB_STORAGE_KEY, this._subtab);
          this._paint();
        },
      },
      this._doc,
    );
    this._disposables.add(this._segmented);
    subtabHost.appendChild(this._segmented.el);

    this._filterBar = createFilterBar(
      {
        key: 'aa_sched_filter',
        placeholder: tr('sched.searchTasks'),
        groups: [],
        icons: {
          search: icon('search'),
          cross: icon('cross'),
          filter: icon('filter'),
          sort: icon('sort'),
          arrowUp: icon('arrowUp'),
          arrowDown: icon('arrowDown'),
        },
        sort: {
          options: [
            { value: 'status', label: tr('sched.sortStatus') },
            { value: 'next', label: tr('sched.sortNext') },
            { value: 'last', label: tr('sched.sortLast') },
            { value: 'created', label: tr('sched.sortCreated') },
          ],
          value: 'status',
          dir: 'asc',
        },
        onChange: () => this._paintBody(),
      },
      this._doc,
    );
    this._disposables.add(this._filterBar);
    this._filterBar.setGroups(null);
    this._filterHost.appendChild(this._filterBar.el);

    this._disposables.add(this._store.onDidChange(() => this._paint()));
    this._disposables.add(
      addDisposableListener(this._sessSearchInput, 'input', () => {
        this._sessQuery = this._sessSearchInput.value.trim().toLowerCase();
        this._paintBody();
      }),
    );
    this._disposables.add(
      addDisposableListener(this._doc, 'visibilitychange', () => {
        if (!this._visible) return;
        if (this._doc.visibilityState === 'hidden') this._disarmPoll();
        else void this._store.loadTasks().then(() => this._armPoll());
      }),
    );
  }

  init(_params: unknown, panelCtx: Parameters<SchedulePanelComponent['init']>[1]): void {
    this._disposables.add(
      panelCtx.api.onDidVisibilityChange((isVisible) => {
        this._visible = isVisible;
        if (this._visible) void this._store.loadTasks().then(() => this._armPoll());
        else this._disarmPoll();
      }),
    );
    this._paint();
    void this._store.loadTasks().then(() => this._armPoll());
  }

  focus(): void {
    this.element.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus();
  }

  refreshLocale(): void {
    const ph = this._ctx.i18n.t('wb.sched.searchSessions');
    this._sessSearchInput.placeholder = ph;
    this._sessSearchInput.setAttribute('aria-label', ph);
    this._filterBar.refreshI18n(tr('sched.searchTasks'), {
      status: tr('sched.sortStatus'),
      next: tr('sched.sortNext'),
      last: tr('sched.sortLast'),
      created: tr('sched.sortCreated'),
    });
    this._paint();
  }

  refreshTopics(): void {
    this._paintHeader();
    this._paintSegmented();
    this._paintBody();
  }

  dispose(): void {
    this._disarmPoll();
    this._disposables.dispose();
    render(nothing, this._headerHost);
    render(nothing, this._noticeHost);
    render(nothing, this._listHost);
    this.element.remove();
  }

  private _disarmPoll(): void {
    if (this._pollTimer !== undefined) {
      clearTimeout(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private _armPoll(): void {
    this._disarmPoll();
    if (!this._visible) return;
    const waitMs = this._store.hasRunningTask() ? 5000 : 30000;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = undefined;
      if (!this._visible) return;
      if (this._doc.visibilityState === 'hidden') {
        this._armPoll();
        return;
      }
      void this._store.loadTasks().then(() => this._armPoll());
    }, waitMs);
  }

  private _paint(): void {
    const snap = this._store.snapshot();
    if (snap.tasks !== null) this._filterBar.setGroups(buildFilterGroups(snap.tasks));
    this._paintHeader();
    this._paintSegmented();
    this._paintNotice();
    this._paintBody();
  }

  private _paintHeader(): void {
    const snap = this._store.snapshot();
    const sessions = scheduledSessions(this._ctx.topics.list());
    const unreadSessions = sessions.filter((t) => this._unreadOf(t) > 0).length;
    const busySessions = sessions.filter((t) => t.running || t.asking).length;
    const summary =
      this._subtab === 'sessions'
        ? sessions.length > 0
          ? `${tr(sessions.length === 1 ? 'sched.summarySessionOne' : 'sched.summarySessionMany', { count: sessions.length })}${busySessions > 0 ? ` \u00b7 ${tr('sched.runningCount', { count: busySessions })}` : ''}`
          : tr('sched.summaryNoSessions')
        : formatTasksSummary(snap.tasks, snap.enabled);

    render(
      html`<div class="sched-heading">
          <span class="panel-title">${tr('sideTasks.tabScheduled')}</span>
          <span class="sched-summary">${summary}</span>
        </div>
        <div class="fh-schedules-actions">
          ${this._subtab === 'sessions' && this._deps.markAllRead
            ? html`<button
                type="button"
                class="fh-btn fh-btn--ghost fh-btn--icon"
                ?disabled=${unreadSessions === 0}
                title=${unreadSessions > 0
                  ? tr(unreadSessions === 1 ? 'sched.markAllReadSessionsOne' : 'sched.markAllReadSessionsMany', { count: unreadSessions })
                  : tr('sidebar.markAllReadNone')}
                aria-label=${tr('sidebar.markAllReadNone')}
                @click=${() => void this._deps.markAllRead?.(sessions)}
              >${unsafeHTML(icon('check'))}</button>`
            : nothing}
          <button
            type="button"
            class="fh-btn fh-btn--ghost fh-btn--icon"
            data-sched-refresh="1"
            title=${tr('common.refresh')}
            aria-label=${tr('common.refresh')}
            @click=${() => void this._ctx.commands.execute('schedules.refresh')}
          >${unsafeHTML(icon('refresh'))}</button>
          ${snap.enabled
            ? html`<button
                type="button"
                class="fh-btn fh-btn--ghost fh-btn--icon"
                data-sched-new="1"
                title=${tr('sideTasks.newTask')}
                aria-label=${tr('sideTasks.newTask')}
                @click=${() => void this._ctx.commands.execute('schedules.new')}
              >${unsafeHTML(icon('plus'))}</button>`
            : nothing}
        </div>`,
      this._headerHost,
    );
  }

  private _paintSegmented(): void {
    const snap = this._store.snapshot();
    const sessions = scheduledSessions(this._ctx.topics.list());
    this._segmented.update({
      value: this._subtab,
      options: [
        { value: 'tasks', label: tr('sideTasks.tabTasks'), badge: snap.tasks ? snap.tasks.length : null },
        { value: 'sessions', label: tr('sideTasks.tabSessions'), badge: sessions.length },
      ],
    });
    this._filterHost.hidden = this._subtab !== 'tasks';
    this._sessSearchHost.hidden = this._subtab !== 'sessions';
  }

  private _paintNotice(): void {
    const { note } = this._store.snapshot();
    if (!note) {
      render(nothing, this._noticeHost);
      this._noticeHost.hidden = true;
      return;
    }
    this._noticeHost.hidden = false;
    render(
      renderNotice({
        tone: 'warn',
        message: note,
        dismissible: true,
        dismissIcon: icon('cross'),
        onDismiss: () => this._store.clearNote(),
      }),
      this._noticeHost,
    );
  }

  private _paintBody(): void {
    if (this._subtab === 'sessions') this._paintSessionsBody();
    else this._paintTasksBody();
  }

  private _paintTasksBody(): void {
    const snap = this._store.snapshot();
    if (snap.tasks === null) {
      this._filterBar.setCounts(0, 0);
      render(html`<div class="sched-empty">${tr('common.loading')}</div>`, this._listHost);
      return;
    }
    const topics = this._ctx.topics.list();
    const filtered = filterAndSortTasks(snap.tasks, this._filterBar.state(), topics);
    this._filterBar.setCounts(filtered.length, snap.tasks.length);

    if (snap.tasks.length === 0) {
      render(
        html`<div class="sched-empty">${snap.enabled ? tr('sched.noTasksEnabled') : tr('sched.noTasksDisabled')}</div>`,
        this._listHost,
      );
      return;
    }
    if (filtered.length === 0) {
      render(
        html`<div class="sched-empty sched-none">
          <span>${tr('sched.noMatchingTasks')}</span>
          <button type="button" class="fb-clear" data-sched-clear="1" @click=${() => this._filterBar.clear()}>
            ${tr('common.clear')}
          </button>
        </div>`,
        this._listHost,
      );
      return;
    }
    const nowMs = this._now();
    render(
      html`<div class="fh-schedules-task-list">
        ${filtered.map((task) =>
          renderTaskRow(
            task,
            this._activeTaskId === task.id,
            topics,
            nowMs,
            (t) => {
              this._activeTaskId = t.id;
              this._paintBody();
              this._ctx.editors.open('schedule', { id: t.id, mode: 'view', title: t.name });
            },
            (anchor, t) => {
              const entries = this._resolveTaskMenu(t);
              if (entries.length > 0) this._menu.open(anchor, entries);
            },
          ),
        )}
      </div>`,
      this._listHost,
    );
  }

  private _paintSessionsBody(): void {
    const tree = collectScheduledSessionTree(this._ctx.topics.list());
    const depthMap = new Map<string, number>();
    const filteredTopics: TopicInfo[] = [];
    for (const entry of tree) {
      depthMap.set(entry.topic.id, entry.depth);
      if (this._sessQuery) {
        const hay = `${entry.topic.title || ''} ${entry.topic.agent?.id || ''} ${entry.topic.agent?.harness || ''}`.toLowerCase();
        if (!hay.includes(this._sessQuery)) continue;
      }
      filteredTopics.push(entry.topic);
    }
    const sessions = filteredTopics;
    if (sessions.length === 0) {
      render(html`<div class="sched-empty">${tr('sched.noSessions')}</div>`, this._listHost);
      return;
    }
    const activeId = this._ctx.topics.active()?.id;
    const nowMs = this._now();
    const groups = groupScheduledSessions(sessions, activeId, this._unreadOf, nowMs);
    render(
      html`<div class="fh-schedules-session-list">
        ${groups.map((g, idx) => {
          const open = g.current || (this._sessGroups[g.key] ?? idx === 0);
          return renderSessionGroup(
            g,
            depthMap,
            open,
            activeId,
            this._unreadOf,
            nowMs,
            (key) => {
              const prev = this._sessGroups[key];
              this._sessGroups[key] = prev === undefined ? false : !prev;
              this._ctx.storage.set(SESS_GROUPS_STORAGE_KEY, this._sessGroups);
              this._paintBody();
            },
            (id) => this._ctx.topics.open(id),
          );
        })}
      </div>`,
      this._listHost,
    );
  }
}

export function createSchedulesViewComponent(
  ctx: PluginContext,
  store: SchedulesStore,
  deps: SchedulesPluginDeps,
  resolveTaskMenu: (task: SchedulePanelTask) => readonly MenuEntry[],
): SchedulesViewController {
  return new SchedulesView(ctx, store, deps, resolveTaskMenu);
}
