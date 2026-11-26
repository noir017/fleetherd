import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { openConfirmDialog } from '../../components/dialog/index.js';
import { t as tr } from '../../i18n/index.js';
import { post, text } from '../../services/api.js';
import type { CacheCopy, CacheMessage, CacheMeta, CacheVersion } from '../../services/cache.js';
import { ageClock, ageText, createAgeTicker, schedAgo } from './age.js';
import { makeFilterBar as createFilterBar } from './filter-bar.js';
import { createIdleDialogController, type IdleDialogElements } from './idle-dialog.js';
import { createTopicPrefetcher } from './prefetch.js';
import { createRowMenuController } from './row-menu.js';
import { forkFromText, rowHtml, treeRowHtml } from './row-render.js';
import {
  agentTagHtml,
  buildTabForest,
  buildTopicFilterGroups,
  buildTopicForest,
  buildTopicRows,
  busyBelow,
  createTreeWalker,
  idleTopics as computeIdleTopics,
  NEEDS_WHAT,
  needsYou,
  rowRunning,
  runOwners,
  splitTitle,
  subtreeOf,
  topicTree,
} from './tree.js';
import type {
  CreateTopicSeed,
  FilterBar,
  FilterBarOpts,
  RowHtmlOpts,
  ScheduleTaskLike,
  Topic,
  TopicForest,
  TopicIcons,
  TopicSnapshotPayload,
  TopicTree,
  TreeRow,
  TreeRowOpts,
  TreeWalker,
} from './types.js';

export * from './types.js';
export * from './age.js';
export * from './tree.js';
export * from './row-render.js';
export * from './filter-bar.js';
export * from './row-menu.js';
export * from './prefetch.js';
export * from './idle-dialog.js';

export const LOCAL_WAIT_MS = 300;
const FOLDED_STORAGE_KEY = 'aa_folded';

export interface TopicsFeatureElements extends IdleDialogElements {
  readonly bar: HTMLElement;
  readonly topicsFilterHost: HTMLElement;
  readonly rowMenu: HTMLElement;
  readonly newTopicBtn: HTMLElement;
  readonly readBtn: HTMLButtonElement;
  readonly clearBtn: HTMLElement;
  readonly noIdleBtn: HTMLElement;
  readonly idleCount: HTMLElement;
  readonly chatTitle: HTMLElement;
  readonly chatStatus: HTMLElement;
  readonly killBtn: HTMLElement;
  readonly stopBtn: HTMLElement;
  readonly note: HTMLElement;
}

export interface TopicsFeatureDeps {
  readonly els: TopicsFeatureElements;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly instanceId: string;
  readonly termOk: boolean;
  readonly getIcons: () => TopicIcons;
  readonly getTopics: () => Topic[];
  readonly setTopics: (next: Topic[]) => void;
  readonly getTopic: () => string;
  readonly setTopic: (id: string) => void;
  readonly getEpoch: () => number;
  readonly narrow: () => boolean;
  readonly setSidebar: (open: boolean) => void;
  readonly setSbTab: (tab: string) => void;
  readonly getSbTab: () => string;
  readonly closeMenus: () => void;
  readonly closeLib: () => void;
  readonly refreshHistoryReadOnly: () => void;
  readonly closeSettings: () => void;
  readonly closeGit: () => void;
  readonly closeTransientSchedules: () => void;
  readonly onSchedulesTopicsUpdated: () => void;
  readonly getScheduleTask: (id: string) => ScheduleTaskLike | null | undefined;
  readonly openTaskPage: (id: string, edit: boolean) => void;
  readonly scheduleOp: (id: string, action: string, btn: HTMLElement | null) => void;
  readonly rememberAdoptedReview: (topicId: string, reviewText: string) => void;
  readonly unreadOf: (t: Topic) => number;
  readonly needsRead: (t: Topic) => boolean;
  readonly syncReads: (topics: readonly Topic[], activeTopicId: string) => void;
  readonly markTopicReadFromList: (id: string, topics: readonly Topic[]) => void;
  readonly removeRead: (id: string) => void;
  readonly markAllRead: (list: readonly Topic[], noun: string, say: (msg: string) => void) => void;
  readonly reportSeen: () => void;
  readonly offSince: (host: string) => number;
  readonly offTitle: (host: string) => string;
  readonly paintMachineNote: () => void;
  readonly paintForkNote: (cur: Topic | null) => void;
  readonly syncCopyRef: () => void;
  readonly copyTopicRef: (id: string) => void;
  readonly applyTerm: () => void;
  readonly paintFrames: () => void;
  readonly dropTerm: (id: string) => void;
  readonly urlNow: () => string;
  readonly command: (text: string) => void;
  readonly saveView: (id: string) => void;
  readonly stashDraft: (id: string) => void;
  readonly loadDraft: (id: string) => void;
  readonly seedDraft: (topicId: string, draft: string) => void;
  readonly forgetTopic: (id: string) => void;
  readonly keepOnlyTopics: (keep: Record<string, number>) => void;
  readonly resetForSwitch: (nextTopicId: string) => void;
  readonly showSkeleton: () => void;
  readonly setStale: (stale: boolean) => void;
  readonly setSettleOnResume: (value: boolean) => void;
  readonly claimMessage: (m: CacheMessage) => void;
  readonly adoptMessages: (msgs: readonly CacheMessage[], current?: boolean) => void;
  readonly showUnsent: (id: string) => void;
  readonly isDbAvailable: () => boolean;
  readonly getCacheVersion: (id: string) => CacheVersion | undefined;
  readonly setCacheVersion: (id: string, ver: CacheVersion) => void;
  readonly isNewer: (a: string | undefined, b: string | undefined) => boolean;
  readonly memCopy: (id: string) => CacheCopy | null;
  readonly getCache: (id: string) => Promise<CacheCopy | null>;
  readonly peekCache: (id: string) => Promise<unknown>;
  readonly putCache: (id: string, msgs: readonly CacheMessage[], meta: CacheMeta) => Promise<boolean>;
  readonly dropCache: (id: string) => void;
  readonly leaveCache: () => void;
  readonly snapshotMsgs: (d: TopicSnapshotPayload) => CacheMessage[];
  readonly isStreamParked: () => boolean;
  readonly isStreamOpen: () => boolean;
  readonly closeStream: () => void;
  readonly setStreamLastEventId: (last: string) => void;
  readonly connectStream: (resume: boolean) => void;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  readonly fetchFn?: typeof fetch;
  readonly confirmFn?: (message: string) => boolean;
  readonly alertFn?: (message: string) => void;
  readonly now?: () => number;
}

export interface TopicsFeature extends Disposable {
  attach(): void;
  topicById(id: string): Topic | null;
  topicExists(id: string): boolean;
  topicForest(): TopicForest;
  runOwners(): Record<string, string>;
  rowRunning(t: Topic): boolean;
  busyBelow(id: string): boolean;
  idleTopics(): Topic[];
  topicTree(list: readonly Topic[]): TopicTree;
  treeWalker(tree: TopicTree): TreeWalker;
  treeRowHtml(row: TreeRow, o: TreeRowOpts): string;
  rowHtml(o: RowHtmlOpts): string;
  agentTagHtml(t: Topic): string;
  splitTitle(title: string): { readonly tag: string; readonly rest: string };
  forkFromText(t: Topic): string;
  schedAgo(at: number | null | undefined): string;
  ageClock(at: number): string;
  ageText(ms: number, done: boolean): string;
  paintAges(): void;
  armAgeTick(): void;
  paintTopics(): void;
  foldClick(e: Event): boolean;
  switchTopic(id: string): void;
  enter(id: string): void;
  createTopic(seed?: CreateTopicSeed): Promise<boolean>;
  deleteTopic(delId: string): void;
  starTopic(id: string): void;
  forkTopic(id: string): void;
  endTopic(id: string): void;
  clearTopics(): void;
  makeFilterBar(opts: FilterBarOpts): FilterBar;
  getRowMenuKey(): string | null;
  isRowMenuOpen(): boolean;
  rowMenuFollow(): void;
  closeRowMenu(focusBack?: boolean): void;
  openRowMenuFor(btn: HTMLElement): void;
  openIdle(): void;
  closeIdle(): void;
  isIdleOpen(): boolean;
  schedulePrefetch(): void;
  clearPrefetchTried(): void;
  forgetPrefetch(id: string): void;
  prunePrefetch(known: Readonly<Record<string, unknown>>): void;
  onLocaleChange(): void;
}

interface CreateTopicResponse {
  readonly topic?: Topic;
  readonly error?: string;
}

interface ClearTopicsResponse {
  readonly topic?: Topic;
  readonly topics?: Topic[];
}

interface EndTopicResponse {
  readonly results?: ReadonlyArray<{ readonly outcome?: string }>;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
}

function getDefaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function loadFolded(storage: Pick<Storage, 'getItem' | 'setItem'> | null): Record<string, boolean> {
  try {
    const raw = storage ? storage.getItem(FOLDED_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'boolean') out[k] = v;
      }
      return out;
    }
  } catch {
    // Ignore corrupt or unavailable storage.
  }
  return {};
}

class TopicsFeatureImpl implements TopicsFeature {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly postFn: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  private readonly confirmFn?: (message: string) => boolean;
  private readonly alertFn: (message: string) => void;
  private readonly nowFn: () => number;
  private readonly listeners = new DisposableStore();
  private readonly folded: Record<string, boolean>;
  private readonly ageTicker: ReturnType<typeof createAgeTicker>;
  private readonly prefetcher: ReturnType<typeof createTopicPrefetcher>;
  private readonly idleDialog: ReturnType<typeof createIdleDialogController>;
  private readonly rowMenu: ReturnType<typeof createRowMenuController>;
  private topicFilter: FilterBar | null = null;
  private enterToken = 0;

  constructor(private readonly deps: TopicsFeatureDeps) {
    this.doc = deps.doc ?? document;
    this.win = deps.win ?? window;
    this.storage = deps.storage !== undefined ? deps.storage : getDefaultStorage();
    this.postFn = deps.postFn ?? post;
    this.confirmFn = deps.confirmFn;
    this.alertFn = deps.alertFn ?? ((msg: string) => this.win.alert(msg));
    this.nowFn = deps.now ?? (() => Date.now());
    this.folded = loadFolded(this.storage);
    this.ageTicker = createAgeTicker(this.doc, this.nowFn);
    this.prefetcher = createTopicPrefetcher({
      doc: this.doc,
      isDbAvailable: deps.isDbAvailable,
      isStreamParked: deps.isStreamParked,
      isStreamOpen: deps.isStreamOpen,
      getEpoch: deps.getEpoch,
      getActiveTopic: deps.getTopic,
      getTopics: deps.getTopics,
      topicById: (id) => this.topicById(id),
      getVersion: deps.getCacheVersion,
      isNewer: deps.isNewer,
      peekCache: deps.peekCache,
      putCache: deps.putCache,
      snapshotMsgs: deps.snapshotMsgs,
      fetchFn: deps.fetchFn,
      now: this.nowFn,
    });
    this.idleDialog = createIdleDialogController({
      els: deps.els,
      getIdleTopics: () => computeIdleTopics(deps.getTopics()),
      closeOtherMenus: deps.closeMenus,
      postFn: this.postFn,
    });
    this.rowMenu = createRowMenuController({
      rowMenu: deps.els.rowMenu,
      doc: this.doc,
      win: this.win,
      instanceId: deps.instanceId,
      getIcons: deps.getIcons,
      getTopics: deps.getTopics,
      topicById: (id) => this.topicById(id),
      closeOtherMenus: deps.closeMenus,
      onStarTopic: (id) => this.starTopic(id),
      onCopyTopicRef: deps.copyTopicRef,
      onForkTopic: (id) => this.forkTopic(id),
      onEndTopic: (id) => this.endTopic(id),
      onDeleteTopic: (id) => this.deleteTopic(id),
      getScheduleTask: deps.getScheduleTask,
      onOpenTaskPage: deps.openTaskPage,
      onScheduleOp: deps.scheduleOp,
      confirmFn: this.confirmFn,
    });
  }

  private ensureTopicFilter(): FilterBar {
    if (this.topicFilter) return this.topicFilter;
    this.topicFilter = this.makeFilterBar({
      key: 'aa_topic_filter',
      placeholder: tr('sidebar.searchTopics'),
      groups: [],
      onChange: () => this.paintTopics(),
    });
    this.deps.els.topicsFilterHost.appendChild(this.topicFilter.el);
    this.topicFilter.setGroups(null);
    return this.topicFilter;
  }

  private saveFolded(): void {
    try {
      this.storage?.setItem(FOLDED_STORAGE_KEY, JSON.stringify(this.folded));
    } catch {
      // Ignore storage quota errors.
    }
  }

  topicById(id: string): Topic | null {
    for (const t of this.deps.getTopics()) if (t.id === id) return t;
    return null;
  }

  topicExists(id: string): boolean {
    return this.topicById(id) !== null;
  }

  topicForest(): TopicForest {
    return buildTopicForest(this.deps.getTopics(), this.deps.getTopic());
  }

  runOwners(): Record<string, string> {
    return runOwners(this.deps.getTopics());
  }

  rowRunning(t: Topic): boolean {
    return rowRunning(t, this.deps.getTopics());
  }

  busyBelow(id: string): boolean {
    return busyBelow(id, this.deps.getTopics());
  }

  idleTopics(): Topic[] {
    return computeIdleTopics(this.deps.getTopics());
  }

  topicTree(list: readonly Topic[]): TopicTree {
    return topicTree(list);
  }

  treeWalker(tree: TopicTree): TreeWalker {
    return createTreeWalker(tree, this.deps.getTopic(), this.folded);
  }

  treeRowHtml(row: TreeRow, o: TreeRowOpts): string {
    return treeRowHtml(row, o, {
      activeTopicId: this.deps.getTopic(),
      topics: this.deps.getTopics(),
      rowMenuKey: this.rowMenu.getKey(),
      icons: this.deps.getIcons(),
      unreadOf: this.deps.unreadOf,
      topicById: (id) => this.topicById(id),
      offSince: this.deps.offSince,
      offTitle: this.deps.offTitle,
      now: this.nowFn(),
    });
  }

  rowHtml(o: RowHtmlOpts): string {
    return rowHtml(o, this.rowMenu.getKey(), this.deps.getIcons());
  }

  agentTagHtml(t: Topic): string {
    return agentTagHtml(t);
  }

  splitTitle(title: string): { readonly tag: string; readonly rest: string } {
    return splitTitle(title);
  }

  forkFromText(t: Topic): string {
    return forkFromText(t, (id) => this.topicById(id));
  }

  schedAgo(at: number | null | undefined): string {
    return schedAgo(at, this.nowFn());
  }

  ageClock(at: number): string {
    return ageClock(at, new Date(this.nowFn()));
  }

  ageText(ms: number, done: boolean): string {
    return ageText(ms, done);
  }

  paintAges(): void {
    this.ageTicker.paintAges();
  }

  armAgeTick(): void {
    this.ageTicker.armAgeTick();
  }

  makeFilterBar(opts: FilterBarOpts): FilterBar {
    return createFilterBar(opts, { icons: this.deps.getIcons(), doc: this.doc, storage: this.storage });
  }

  getRowMenuKey(): string | null {
    return this.rowMenu.getKey();
  }

  isRowMenuOpen(): boolean {
    return this.rowMenu.isOpen();
  }

  rowMenuFollow(): void {
    this.rowMenu.follow();
  }

  closeRowMenu(focusBack?: boolean): void {
    this.rowMenu.close(focusBack);
  }

  openRowMenuFor(btn: HTMLElement): void {
    this.rowMenu.openFor(btn);
  }

  openIdle(): void {
    this.idleDialog.open();
  }

  closeIdle(): void {
    this.idleDialog.close();
  }

  isIdleOpen(): boolean {
    return this.idleDialog.isOpen();
  }

  schedulePrefetch(): void {
    this.prefetcher.schedule();
  }

  clearPrefetchTried(): void {
    this.prefetcher.clearTried();
  }

  forgetPrefetch(id: string): void {
    this.prefetcher.forget(id);
  }

  prunePrefetch(known: Readonly<Record<string, unknown>>): void {
    this.prefetcher.prune(known);
  }

  private paintSidebarMeta(fullForest: TopicForest): void {
    const { readBtn, clearBtn, idleBtn, noIdleBtn, idleCount } = this.deps.els;
    let stars = 0;
    let toRead = 0;
    for (const v of fullForest.visible) {
      if (v.starred) stars++;
      if (this.deps.needsRead(v)) toRead++;
    }
    readBtn.disabled = !toRead;
    readBtn.title = toRead
      ? tr(toRead === 1 ? 'sidebar.markAllReadTopics' : 'sidebar.markAllReadTopicsPlural', { count: toRead })
      : tr('sidebar.markAllReadNone');
    const clearLabel = stars ? tr('sidebar.clearUnstarredTopics') : tr('sidebar.clearAllTopics');
    clearBtn.title = clearLabel;
    clearBtn.setAttribute('aria-label', clearLabel);
    const idle = computeIdleTopics(this.deps.getTopics()).length;
    idleBtn.hidden = !idle;
    noIdleBtn.hidden = Boolean(idle);
    idleBtn.textContent = tr('menu.closeIdleCount', { count: idle });
    idleCount.textContent = idle ? `(${idle})` : '';
  }

  private paintChatHeader(cur: Topic | null): void {
    const { chatTitle, chatStatus, killBtn, stopBtn } = this.deps.els;
    const below = cur ? busyBelow(cur.id, this.deps.getTopics()) : false;
    this.deps.paintForkNote(cur);
    if (cur) {
      chatTitle.textContent = cur.title || tr('common.untitled');
      const curRunning = Boolean(cur.running) || below;
      const state = cur.asking ? tr('topic.awaitingYou') : curRunning ? tr('topic.running') : '';
      chatStatus.textContent = state;
      chatStatus.className = `chat-status${cur.asking ? ' asking' : curRunning ? ' running' : ''}`;
    } else {
      chatTitle.textContent = '';
      chatStatus.textContent = '';
    }
    killBtn.hidden = !(cur && cur.live);
    this.deps.syncCopyRef();
    stopBtn.hidden = !(cur && (cur.running || cur.asking || below));
    stopBtn.title = below ? tr('composer.stopSubTitle') : tr('composer.stopTitle');
  }

  paintTopics(): void {
    const topics = this.deps.getTopics();
    const activeId = this.deps.getTopic();
    const filter = this.ensureTopicFilter();
    this.deps.refreshHistoryReadOnly();
    const fullForest = buildTopicForest(topics, activeId);
    const sbTab = this.deps.getSbTab();
    const forest = buildTabForest(fullForest, sbTab);
    const fg = buildTopicFilterGroups(forest, sbTab);
    filter.setGroups(fg.groups);
    const painted = buildTopicRows(forest, topics, activeId, this.folded, filter.state());
    filter.setCounts(painted.matched, painted.total);
    this.deps.syncReads(topics, activeId);
    const cur = this.topicById(activeId);

    let h = '';
    for (let i = 0; i < painted.rows.length; i++) {
      const row = painted.rows[i];
      if (!row) continue;
      const t = row.t;
      const needs = needsYou(t, activeId);
      const whatKey = t.stage ? NEEDS_WHAT[t.stage] : undefined;
      h += this.treeRowHtml(row, {
        attr: 'data-topic',
        menu: 'topic',
        cls: painted.dividers[i] ? ' after-needs' : '',
        tail: needs ? ' needs' : '',
        attrs: needs && whatKey ? ` title="${text(`${tr(whatKey)}${t.line ? `: ${t.line}` : ''}`)}"` : '',
        moreTitle: tr('topic.topicActions'),
      });
    }
    this.deps.els.bar.innerHTML = h;
    this.deps.paintMachineNote();
    if (!h && painted.filtering) {
      this.deps.els.bar.innerHTML =
        `<div class="topics-empty"><span>${text(tr('sidebar.noMatchingTopics'))}</span>` +
        `<button type="button" class="fb-clear" data-filter-clear="1">${text(tr('common.clear'))}</button></div>`;
    } else if (!h && sbTab === 'starred') {
      this.deps.els.bar.innerHTML = `<div class="topics-empty"><span>${text(tr('sidebar.noStarredTopics'))}</span></div>`;
    }
    this.ageTicker.armAgeTick();
    this.rowMenu.follow();
    this.paintSidebarMeta(fullForest);
    this.paintChatHeader(cur);
    if (this.deps.termOk) this.deps.paintFrames();
    this.deps.onSchedulesTopicsUpdated();
  }

  enter(id: string): void {
    const mine = ++this.enterToken;
    let used = false;
    const v = this.deps.getCacheVersion(id);
    this.deps.closeStream();
    const here = (): boolean => mine === this.enterToken && id === this.deps.getTopic();

    const go = (c: CacheCopy | null): void => {
      if (used) return;
      used = true;
      if (!here()) return;
      const epoch = this.deps.getEpoch();
      const resume = Boolean(c && c.msgs.length && c.last && epoch && c.epoch === epoch);
      if (c) {
        for (const msg of c.msgs) this.deps.claimMessage(msg);
        if (resume) this.deps.setStale(c.stale);
        if (c.msgs.length) {
          this.deps.adoptMessages(c.msgs, resume && this.prefetcher.isRowCurrent(this.topicById(id), c.last));
        }
      }
      this.deps.showUnsent(id);
      if (resume && c) {
        this.deps.setStreamLastEventId(c.last);
        this.deps.setSettleOnResume(true);
      }
      this.deps.connectStream(resume);
    };

    const m = id ? this.deps.memCopy(id) : null;
    if (m || !id) {
      go(m);
      return;
    }
    void this.deps.getCache(id).then((c) => {
      if (!used) {
        go(c);
        return;
      }
      if (c && c.msgs.length && here()) this.deps.adoptMessages(c.msgs);
    });
    const epoch = this.deps.getEpoch();
    if (epoch && this.deps.isDbAvailable() && (!v || (v.last && v.epoch === epoch))) {
      setTimeout(() => go(null), LOCAL_WAIT_MS);
    } else {
      go(null);
    }
  }

  switchTopic(id: string): void {
    if (!id) return;
    this.deps.closeLib();
    if (id === this.deps.getTopic()) return;
    this.deps.closeSettings();
    this.deps.closeGit();
    this.deps.closeTransientSchedules();
    const prev = this.deps.getTopic();
    this.deps.leaveCache();
    this.deps.saveView(prev);
    this.deps.stashDraft(prev);
    this.deps.setTopic(id);
    this.win.history.replaceState(null, '', this.deps.urlNow());
    this.deps.applyTerm();
    this.deps.markTopicReadFromList(id, this.deps.getTopics());
    this.paintTopics();
    this.deps.reportSeen();
    this.deps.resetForSwitch(id);
    this.deps.loadDraft(id);
    this.deps.showSkeleton();
    this.deps.setSettleOnResume(false);
    this.enter(id);
  }

  createTopic(seed?: CreateTopicSeed): Promise<boolean> {
    return this.postFn('api/topics', {}, 1)
      .then(
        (r): Promise<CreateTopicResponse> => {
          if (r.ok) return r.json() as Promise<CreateTopicResponse>;
          return (r.json() as Promise<CreateTopicResponse>).then(
            (d) => ({ error: (d && d.error) || `HTTP ${r.status}` }),
            () => ({ error: `HTTP ${r.status}` }),
          );
        },
        (): CreateTopicResponse => ({ error: tr('topic.createReachErr') }),
      )
      .then((d) => {
        if (d && d.error) {
          this.alertFn(tr('topic.createFailed', { err: d.error }));
          return false;
        }
        if (!d || !d.topic) return false;
        this.deps.setCacheVersion(d.topic.id, { last: '', epoch: 0 });
        this.switchTopic(d.topic.id);
        if (this.deps.narrow()) this.deps.setSidebar(false);
        if (seed) {
          this.deps.seedDraft(d.topic.id, seed.draft);
          this.deps.rememberAdoptedReview(d.topic.id, seed.text);
        }
        return true;
      });
  }

  deleteTopic(delId: string): void {
    const target = this.topicById(delId);
    const title = target && target.title ? target.title : tr('common.untitled');
    const msg = tr(target && target.starred ? 'topic.confirmDeleteStarred' : 'topic.confirmDelete', { title });
    const confirmed = this.confirmFn
      ? Promise.resolve(this.confirmFn(msg))
      : openConfirmDialog({
          title: tr(target && target.starred ? 'topics.confirmDeleteStarredTitle' : 'topics.confirmDeleteTitle', { title }),
          body: tr('topics.confirmDeleteBody'),
          confirmLabel: tr('common.delete'),
          cancelLabel: tr('common.cancel'),
          danger: true,
          doc: this.doc,
        });
    void confirmed.then((ok) => {
      if (!ok) return;
      return this.postFn('api/topics/delete', { topic: delId }, 1)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        this.deps.dropCache(delId);
        this.deps.dropTerm(delId);
        this.deps.removeRead(delId);
        if (this.deps.getTopic() === delId) {
          const remaining = this.deps.getTopics().filter((t) => t.id !== delId);
          if (remaining[0]) this.switchTopic(remaining[0].id);
          else void this.createTopic();
        }
        this.deps.forgetTopic(delId);
      });
    });
  }

  starTopic(id: string): void {
    const t = this.topicById(id);
    if (!t) return;
    const on = !t.starred;
    t.starred = on;
    this.paintTopics();
    void this.postFn('api/topics/star', { topic: id, starred: on }, 1)
      .then(
        (r) => r.ok,
        () => false,
      )
      .then((ok) => {
        if (ok) return;
        const now = this.topicById(id);
        if (now) {
          now.starred = !on;
          this.paintTopics();
        }
        this.alertFn(on ? tr('topic.starFailed') : tr('topic.unstarFailed'));
      });
  }

  forkTopic(id: string): void {
    if (id === this.deps.getTopic()) {
      this.deps.command('/fork');
      return;
    }
    const nonce = Math.random().toString(36).slice(2) + this.nowFn().toString(36);
    void this.postFn('api/send', { topic: id, text: '/fork', nonce }, 1).then(
      (r) => {
        if (!r.ok) this.alertFn(tr('topic.forkRefused'));
      },
      () => this.alertFn(tr('topic.forkReachErr')),
    );
  }

  endTopic(id: string): void {
    const list = subtreeOf(id, this.deps.getTopics()).filter((t) => Boolean(t.live));
    if (!list.length) return;
    const ids = list.map((t) => t.id);
    void this.postFn('api/topics/kill', { topic: id, topics: ids }, 0)
      .then((r) => (r.ok ? (r.json() as Promise<EndTopicResponse>) : null))
      .then(
        (d) => {
          if (!d) {
            this.alertFn(ids.length === 1 ? tr('topic.endRefusedOne') : tr('topic.endRefusedMany'));
            return;
          }
          const results = d.results ?? [];
          let stuck = 0;
          for (const res of results) if (res.outcome === 'unresumable') stuck++;
          if (stuck) {
            this.alertFn(tr(stuck === 1 ? 'topic.endUnresumableOne' : 'topic.endUnresumableMany', { count: stuck }));
          }
        },
        () => {
          this.alertFn(ids.length === 1 ? tr('topic.endReachErrOne') : tr('topic.endReachErrMany'));
        },
      );
  }

  clearTopics(): void {
    this.deps.closeMenus();
    const topics = this.deps.getTopics();
    const stars = topics.filter((t) => t.starred).length;
    const gone = topics.length - stars;
    if (stars && !gone) {
      this.alertFn(tr('topic.allStarredAlert'));
      return;
    }
    const scope = this.ensureTopicFilter().active() ? tr('topic.clearScopeNote') : '';
    const msg = stars
      ? tr('topic.confirmClearStarred', {
          gone,
          goneWord: gone === 1 ? tr('topic.nounSingular') : tr('topic.nounPlural'),
          stars,
          starsWord: stars === 1 ? tr('topic.starredOneIs') : tr('topic.starredManyAre'),
          scope,
        })
      : tr('topic.confirmClearAll', { total: topics.length, scope });
    const confirmed = this.confirmFn
      ? Promise.resolve(this.confirmFn(msg))
      : openConfirmDialog({
          title: tr('topics.confirmClearTitle'),
          body: msg,
          confirmLabel: tr('common.delete'),
          cancelLabel: tr('common.cancel'),
          danger: true,
          doc: this.doc,
        });
    void confirmed.then((ok) => {
      if (!ok) return;
      return this.postFn('api/topics/clear', {}, 1)
      .then((r) => (r.ok ? (r.json() as Promise<ClearTopicsResponse>) : null))
      .then((d) => {
        if (!d || !d.topic) return;
        const list = d.topics || [d.topic];
        const keep: Record<string, number> = {};
        for (const item of list) keep[item.id] = 1;
        this.deps.keepOnlyTopics(keep);
        this.deps.setTopics(list);
        if (!keep[this.deps.getTopic()]) this.deps.setTopic('');
        this.deps.setCacheVersion(d.topic.id, { last: '', epoch: 0 });
        this.switchTopic(d.topic.id);
        if (this.deps.narrow()) this.deps.setSidebar(false);
      });
    });
  }

  foldClick(e: Event): boolean {
    const fold = asElement(e.target)?.closest('[data-fold]');
    if (!fold) return false;
    e.stopPropagation();
    const foldId = fold.getAttribute('data-fold');
    if (foldId) {
      this.folded[foldId] = this.folded[foldId] === false;
      this.saveFolded();
      this.paintTopics();
    }
    return true;
  }

  attach(): void {
    this.ensureTopicFilter();
    this.listeners.add(this.ageTicker.attach());
    this.listeners.add(this.rowMenu.attach());
    this.listeners.add(this.idleDialog.attach());
    this.listeners.add(
      addDisposableListener(this.deps.els.bar, 'click', (e) => {
        const el = asElement(e.target);
        if (!el) return;
        const fc = el.closest('[data-filter-clear]');
        if (fc) {
          e.stopPropagation();
          this.topicFilter?.clear();
          return;
        }
        const more = el.closest<HTMLElement>('[data-rm]');
        if (more) {
          e.stopPropagation();
          if (
            this.rowMenu.getKey() &&
            this.rowMenu.getKey() === more.getAttribute('data-rm') &&
            this.rowMenu.isOpen()
          ) {
            this.rowMenu.close(true);
          } else {
            this.rowMenu.openFor(more);
          }
          return;
        }
        if (this.foldClick(e)) return;
        const b = el.closest('[data-topic]');
        if (!b) return;
        const id = b.getAttribute('data-topic');
        if (!id || id === this.deps.getTopic()) return;
        this.switchTopic(id);
        if (this.deps.narrow()) this.deps.setSidebar(false);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.deps.els.bar, 'keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = asElement(e.target);
        if (!el) return;
        if (el.closest('[data-rm],[data-fold]')) return;
        const b = el.closest('[data-topic]');
        if (!b) return;
        e.preventDefault();
        const id = b.getAttribute('data-topic');
        if (!id || id === this.deps.getTopic()) return;
        this.switchTopic(id);
      }),
    );
    this.listeners.add(
      addDisposableListener(this.deps.els.newTopicBtn, 'click', () => {
        this.deps.setSbTab('topics');
        void this.createTopic();
      }),
    );
    this.listeners.add(
      addDisposableListener(this.deps.els.readBtn, 'click', () => {
        this.deps.closeMenus();
        this.deps.markAllRead(this.topicForest().visible, 'topic', (msg) => {
          this.deps.els.note.textContent = msg;
        });
      }),
    );
    this.listeners.add(addDisposableListener(this.deps.els.clearBtn, 'click', () => this.clearTopics()));
  }

  onLocaleChange(): void {
    this.topicFilter?.refreshI18n(tr('sidebar.searchTopics'));
    this.paintTopics();
    this.ageTicker.paintAges();
  }

  dispose(): void {
    this.listeners.dispose();
    this.ageTicker.dispose();
    this.rowMenu.dispose();
    this.prefetcher.dispose();
    this.idleDialog.dispose();
    this.topicFilter?.destroy();
    this.topicFilter = null;
  }
}

export function createTopicsFeature(deps: TopicsFeatureDeps): TopicsFeature {
  return new TopicsFeatureImpl(deps);
}
