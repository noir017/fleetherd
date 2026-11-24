// Web UI client entrypoint: DOM lookups, module wiring, SSE event dispatch, and startup order.
// Bundled by `scripts/webui-client.mjs` into `dist/webui-assets/app-<hash>.js` with two build-time
// markers replaced before bundling with `clientIcons()` (`icons.ts`) and `CACHE_CORE` (`cache-script.ts`).

import type { WebEvent, WebMessage } from '../protocol.js';
import type { Topic } from '../topics.js';
import { createFilesPanel, type FilesPanel } from './panels/files.js';
import { createGitPanel, type GitPanel } from './panels/git.js';
import { createHistoryPanel, type HistoryPanel, type SidebarTab } from './panels/history.js';
import { createInstructionsPanel, type InstructionsPanel } from './panels/instructions.js';
import { createReviewsPanel, type ReviewsPanel } from './panels/reviews.js';
import { createSchedulesPanel, type SchedulesPanel } from './panels/schedules.js';
import { createSkillsPanel, type SkillsPanel } from './panels/skills.js';
import { applyDomI18n, initLocale, onLocaleChange, t as tr } from './i18n/index.js';
import { post, text } from './services/api.js';
import { readBootConfig, type BootConfig } from './services/boot.js';
import {
  collectCacheableMessages,
  createCacheService,
  type CacheCore,
  type CacheMessage,
  type CacheService,
} from './services/cache.js';
import { OverlayManager } from './services/overlays.js';
import { createReadsService, type ReadsService } from './services/reads.js';
import {
  applyTopicRows,
  createStreamClient,
  type StreamClient,
  type StreamEventPayload,
} from './services/stream.js';
import { createNotifyController, type NotifyController } from './features/notify/index.js';
import {
  createCodeViewLoader,
  createLightbox,
  createReader,
  formatByteSize,
  type LightboxController,
  type ReaderController,
} from './features/reader/index.js';
import {
  createSettingsFeature,
  inlineCodeHtml as inl,
  type SettingsFeature,
} from './features/settings/index.js';
import { createTerminalController, type TerminalController } from './features/terminal/index.js';
import { mountWorkbenchIfEnabled } from './workbench/shell.js';
import {
  createComposerController,
  type ComposerController,
  type LocalBubbleMessage,
} from './features/topic/composer/index.js';
import {
  createTopicStatusController,
  stClock,
  stLeft,
  type TopicStatusController,
} from './features/topic/status/index.js';
import {
  createTranscriptController,
  type LaunchChoice,
  type TranscriptController,
  type TranscriptMessage,
} from './features/topic/transcript/index.js';
import {
  createTopicsFeature,
  type TopicsFeature,
  type TopicSnapshotPayload,
} from './features/topics/index.js';
import { createLegacyShell, type LegacyShell } from './workbench/legacy-shell.js';
import type { ClientIconsBundle } from './build-markers.d.ts';

interface CacheCoreBundle extends CacheCore {
  readonly snapshotMsgs: (d: TopicSnapshotPayload) => CacheMessage[];
}

interface AppDom {
  readonly log: HTMLElement;
  readonly app: HTMLElement;
  readonly gate: HTMLElement;
  readonly err: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly chips: HTMLElement;
  readonly hints: HTMLElement;
  readonly typing: HTMLElement;
  readonly note: HTMLElement;
  readonly picker: HTMLInputElement;
  readonly bar: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly sidebarResize: HTMLElement;
  readonly collapseBtn: HTMLElement;
  readonly expandBtn: HTMLElement;
  readonly newTopicBtn: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly clearBtn: HTMLElement;
  readonly readBtn: HTMLButtonElement;
  readonly idleBtn: HTMLElement;
  readonly noIdleBtn: HTMLElement;
  readonly idleCount: HTMLElement;
  readonly notifyBtn: HTMLButtonElement;
  readonly notifyState: HTMLElement;
  readonly idleDialog: HTMLElement;
  readonly idleTitle: HTMLElement;
  readonly idleWhy: HTMLElement;
  readonly idleList: HTMLElement;
  readonly idleGo: HTMLButtonElement;
  readonly idleCancel: HTMLButtonElement;
  readonly rowMenu: HTMLElement;
  readonly optsBtn: HTMLElement;
  readonly optsMenu: HTMLElement;
  readonly manageBtn: HTMLElement;
  readonly manageMenu: HTMLElement;
  readonly calmBtn: HTMLElement;
  readonly calmState: HTMLElement;
  readonly themeBtn: HTMLElement;
  readonly themeState: HTMLElement;
  readonly langBtn: HTMLElement;
  readonly langState: HTMLElement;
  readonly chatTitle: HTMLElement;
  readonly chatStatus: HTMLElement;
  readonly forkNote: HTMLElement;
  readonly chat: HTMLElement;
  readonly chatHead: HTMLElement;
  readonly composer: HTMLElement;
  readonly termBtn: HTMLButtonElement;
  readonly termHost: HTMLElement;
  readonly termEl: HTMLElement;
  readonly termGrip: HTMLElement;
  readonly termName: HTMLElement;
  readonly termMinBtn: HTMLButtonElement;
  readonly termEndBtn: HTMLButtonElement;
  readonly schedToggle: HTMLElement;
  readonly schedAlert: HTMLElement;
  readonly schedList: HTMLElement;
  readonly schedSummary: HTMLElement;
  readonly schedReadBtn: HTMLButtonElement;
  readonly schedFilterHost: HTMLElement;
  readonly schedNewBtn: HTMLElement;
  readonly schedClose: HTMLElement;
  readonly schedNote: HTMLElement;
  readonly schedPanel: HTMLElement;
  readonly schedSessionList: HTMLElement;
  readonly schedResize: HTMLElement;
  readonly schedSubnav: HTMLElement;
  readonly schedTabScheduled: HTMLElement;
  readonly schedTabScheduledN: HTMLElement;
  readonly schedTabScheduledAlert: HTMLElement;
  readonly schedTabReviews: HTMLElement;
  readonly schedTabReviewsN: HTMLElement;
  readonly schedTabTasks: HTMLElement;
  readonly schedTabTasksN: HTMLElement;
  readonly schedTabSessions: HTMLElement;
  readonly schedTabSessionsN: HTMLElement;
  readonly schedSessionsAlert: HTMLElement;
  readonly revPane: HTMLElement;
  readonly revList: HTMLElement;
  readonly lightbox: HTMLElement;
  readonly lightboxImg: HTMLImageElement;
  readonly reader: HTMLElement;
  readonly readerName: HTMLElement;
  readonly readerGet: HTMLElement;
  readonly readerBody: HTMLElement;
  readonly readerClose: HTMLElement;
  readonly skillsWin: HTMLElement;
  readonly skillsToggle: HTMLElement;
  readonly skillsBack: HTMLElement;
  readonly skillsTitle: HTMLElement;
  readonly skillsCount: HTMLElement;
  readonly skillsNewBtn: HTMLElement;
  readonly skillsRefreshBtn: HTMLButtonElement;
  readonly skillsClose: HTMLElement;
  readonly skillsBody: HTMLElement;
  readonly skillsNote: HTMLElement;
  readonly skillsListEl: HTMLElement;
  readonly skillsDetailEl: HTMLElement;
  readonly sbTabTopics: HTMLElement;
  readonly sbTabStarred: HTMLElement;
  readonly sbTabHistory: HTMLElement;
  readonly topicsFilterHost: HTMLElement;
  readonly historyPane: HTMLElement;
  readonly historyCountEl: HTMLElement;
  readonly historyBody: HTMLElement;
  readonly historyQ: HTMLInputElement;
  readonly historyGo: HTMLButtonElement;
  readonly historyErr: HTMLElement;
  readonly historyListEl: HTMLElement;
  readonly historyMore: HTMLButtonElement;
  readonly libLog: HTMLElement;
  readonly libTitle: HTMLElement;
  readonly libNote: HTMLElement;
  readonly libWhy: HTMLElement;
  readonly libTopicBtn: HTMLButtonElement;
  readonly libCloseBtn: HTMLButtonElement;
  readonly settingsPage: HTMLElement;
  readonly settingsBody: HTMLElement;
  readonly settingsTopicEl: HTMLElement;
  readonly settingsClose: HTMLElement;
  readonly settingsOpenBtn: HTMLElement;
  readonly taskPage: HTMLElement;
  readonly taskTitle: HTMLElement;
  readonly taskSub: HTMLElement;
  readonly taskClose: HTMLElement;
  readonly taskNote: HTMLElement;
  readonly taskView: HTMLElement;
  readonly copyRefBtn: HTMLButtonElement | null;
  readonly killBtn: HTMLElement;
  readonly stopBtn: HTMLElement;
  readonly pendingQueueEl: HTMLElement | null;
  readonly statusEl: HTMLElement | null;
  readonly machineNoteEl: HTMLElement;
  readonly updateEl: HTMLElement;
  readonly updateReloadBtn: HTMLElement | null;
  readonly gateForm: HTMLFormElement | null;
  readonly secretInput: HTMLInputElement | null;
  readonly modelPop: HTMLElement;
  readonly mpList: HTMLElement;
  readonly mpFilter: HTMLInputElement;
  readonly mpAgent: HTMLElement;
  readonly mpHeading: HTMLElement;
  readonly mpFoot: HTMLElement;
  readonly mpClose: HTMLElement | null;
  readonly btwBox: HTMLElement;
  readonly btwQ: HTMLElement;
  readonly btwBody: HTMLElement;
  readonly btwClose: HTMLElement | null;
  readonly attachBtn: HTMLElement | null;
  readonly micBtn: HTMLButtonElement | null;
  readonly composerForm: HTMLFormElement | null;
}

interface AppState {
  data: Record<string, TranscriptMessage | undefined>;
  els: Record<string, HTMLElement | undefined>;
  topics: Topic[];
  topic: string;
  epoch: number;
  synced: boolean;
  entering: boolean;
  stale: boolean;
  launch: LaunchChoice | null;
  settleOnResume: boolean;
}

interface AppControllers {
  readonly boot: BootConfig;
  readonly icons: ClientIconsBundle;
  readonly dom: AppDom;
  readonly state: AppState;
  readonly overlays: OverlayManager;
  readonly cacheCore: CacheCoreBundle;
  readonly codeView: ReturnType<typeof createCodeViewLoader>;
  streamClient: StreamClient;
  cacheService: CacheService;
  readsService: ReadsService;
  settingsFeature: SettingsFeature;
  topicStatus: TopicStatusController;
  legacyShell: LegacyShell;
  notifyController: NotifyController;
  terminalController: TerminalController;
  lightbox: LightboxController;
  reader: ReaderController;
  transcript: TranscriptController;
  topicsFeature: TopicsFeature;
  composerController: ComposerController;
  reviewsPanel: ReviewsPanel;
  historyPanel: HistoryPanel;
  schedulesPanel: SchedulesPanel;
  skillsPanel: SkillsPanel;
  gitPanel: GitPanel;
  filesPanel: FilesPanel;
  instructionsPanel: InstructionsPanel;
}

function reqEl<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
}

function optEl<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function collectChatAndShellDom(doc: Document) {
  return {
    log: reqEl(doc, 'log'),
    app: reqEl(doc, 'app'),
    gate: reqEl(doc, 'login'),
    err: reqEl(doc, 'err'),
    input: reqEl<HTMLTextAreaElement>(doc, 'input'),
    chips: reqEl(doc, 'chips'),
    hints: reqEl(doc, 'hints'),
    typing: reqEl(doc, 'typing'),
    note: reqEl(doc, 'note'),
    picker: reqEl<HTMLInputElement>(doc, 'picker'),
    bar: reqEl(doc, 'topics'),
    sidebar: reqEl(doc, 'sidebar'),
    sidebarResize: reqEl(doc, 'sidebar-resize'),
    collapseBtn: reqEl(doc, 'collapse-sidebar'),
    expandBtn: reqEl(doc, 'expand-sidebar'),
    newTopicBtn: reqEl(doc, 'new-topic'),
    backdrop: reqEl(doc, 'backdrop'),
    clearBtn: reqEl(doc, 'clear-topics'),
    readBtn: reqEl<HTMLButtonElement>(doc, 'read-topics'),
    idleBtn: reqEl(doc, 'close-idle'),
    noIdleBtn: reqEl(doc, 'no-idle'),
    idleCount: reqEl(doc, 'idle-count'),
    notifyBtn: reqEl<HTMLButtonElement>(doc, 'notify-toggle'),
    notifyState: reqEl(doc, 'notify-state'),
    idleDialog: reqEl(doc, 'idle-dialog'),
    idleTitle: reqEl(doc, 'idle-title'),
    idleWhy: reqEl(doc, 'idle-why'),
    idleList: reqEl(doc, 'idle-list'),
    idleGo: reqEl<HTMLButtonElement>(doc, 'idle-go'),
    idleCancel: reqEl<HTMLButtonElement>(doc, 'idle-cancel'),
    rowMenu: reqEl(doc, 'row-menu'),
    optsBtn: reqEl(doc, 'opts-toggle'),
    optsMenu: reqEl(doc, 'opts-menu'),
    manageBtn: reqEl(doc, 'manage-toggle'),
    manageMenu: reqEl(doc, 'manage-menu'),
    calmBtn: reqEl(doc, 'calm-toggle'),
    calmState: reqEl(doc, 'calm-state'),
    themeBtn: reqEl(doc, 'theme-toggle'),
    themeState: reqEl(doc, 'theme-state'),
    langBtn: reqEl(doc, 'lang-toggle'),
    langState: reqEl(doc, 'lang-state'),
    chatTitle: reqEl(doc, 'topic-title'),
    chatStatus: reqEl(doc, 'topic-status'),
    forkNote: reqEl(doc, 'fork-note'),
    chat: reqEl(doc, 'chat'),
    chatHead: reqEl(doc, 'chat-header'),
    composer: reqEl(doc, 'bar'),
    termBtn: reqEl<HTMLButtonElement>(doc, 'term-toggle'),
    termHost: reqEl(doc, 'term-frames'),
    termEl: reqEl(doc, 'term'),
    termGrip: reqEl(doc, 'term-grip'),
    termName: reqEl(doc, 'term-name'),
    termMinBtn: reqEl<HTMLButtonElement>(doc, 'term-min'),
    termEndBtn: reqEl<HTMLButtonElement>(doc, 'term-end'),
    copyRefBtn: optEl<HTMLButtonElement>(doc, 'copy-ref'),
    killBtn: reqEl(doc, 'kill-agent'),
    stopBtn: reqEl(doc, 'stop-turn'),
    pendingQueueEl: optEl(doc, 'pending-queue'),
    statusEl: optEl(doc, 'status'),
    machineNoteEl: reqEl(doc, 'machine-note'),
    updateEl: reqEl(doc, 'update'),
    updateReloadBtn: optEl(doc, 'update-reload'),
    gateForm: optEl<HTMLFormElement>(doc, 'gate'),
    secretInput: optEl<HTMLInputElement>(doc, 'secret'),
    modelPop: reqEl(doc, 'model-pop'),
    mpList: reqEl(doc, 'mp-list'),
    mpFilter: reqEl<HTMLInputElement>(doc, 'mp-filter'),
    mpAgent: reqEl(doc, 'mp-agent'),
    mpHeading: reqEl(doc, 'mp-heading'),
    mpFoot: reqEl(doc, 'mp-foot'),
    mpClose: optEl(doc, 'mp-close'),
    btwBox: reqEl(doc, 'btw'),
    btwQ: reqEl(doc, 'btw-q'),
    btwBody: reqEl(doc, 'btw-body'),
    btwClose: optEl(doc, 'btw-close'),
    attachBtn: optEl(doc, 'attach'),
    micBtn: optEl<HTMLButtonElement>(doc, 'mic'),
    composerForm: optEl<HTMLFormElement>(doc, 'composer'),
  };
}

function collectPanelsDom(doc: Document) {
  return {
    schedToggle: reqEl(doc, 'schedules-toggle'),
    schedAlert: reqEl(doc, 'sched-alert'),
    schedList: reqEl(doc, 'schedules-list'),
    schedSummary: reqEl(doc, 'schedules-summary'),
    schedReadBtn: reqEl<HTMLButtonElement>(doc, 'sched-read'),
    schedFilterHost: reqEl(doc, 'sched-filter'),
    schedNewBtn: reqEl(doc, 'sched-new'),
    schedClose: reqEl(doc, 'schedules-close'),
    schedNote: reqEl(doc, 'schedules-note'),
    schedPanel: reqEl(doc, 'schedules'),
    schedSessionList: reqEl(doc, 'sched-sessions'),
    schedResize: reqEl(doc, 'sched-resize'),
    schedSubnav: reqEl(doc, 'sched-subnav'),
    schedTabScheduled: reqEl(doc, 'sched-tab-scheduled'),
    schedTabScheduledN: reqEl(doc, 'sched-tab-scheduled-n'),
    schedTabScheduledAlert: reqEl(doc, 'sched-tab-alert'),
    schedTabReviews: reqEl(doc, 'sched-tab-reviews'),
    schedTabReviewsN: reqEl(doc, 'sched-tab-reviews-n'),
    schedTabTasks: reqEl(doc, 'sched-tab-tasks'),
    schedTabTasksN: reqEl(doc, 'sched-tab-tasks-n'),
    schedTabSessions: reqEl(doc, 'sched-tab-sessions'),
    schedTabSessionsN: reqEl(doc, 'sched-tab-sessions-n'),
    schedSessionsAlert: reqEl(doc, 'sched-sessions-alert'),
    revPane: reqEl(doc, 'sched-reviews'),
    revList: reqEl(doc, 'sched-reviews-list'),
    lightbox: reqEl(doc, 'lightbox'),
    lightboxImg: reqEl<HTMLImageElement>(doc, 'lightbox-img'),
    reader: reqEl(doc, 'reader'),
    readerName: reqEl(doc, 'reader-name'),
    readerGet: reqEl(doc, 'reader-get'),
    readerBody: reqEl(doc, 'reader-body'),
    readerClose: reqEl(doc, 'reader-close'),
    skillsWin: reqEl(doc, 'skills'),
    skillsToggle: reqEl(doc, 'skills-toggle'),
    skillsBack: reqEl(doc, 'skills-back'),
    skillsTitle: reqEl(doc, 'skills-title'),
    skillsCount: reqEl(doc, 'skills-count'),
    skillsNewBtn: reqEl(doc, 'skills-new'),
    skillsRefreshBtn: reqEl<HTMLButtonElement>(doc, 'skills-refresh'),
    skillsClose: reqEl(doc, 'skills-close'),
    skillsBody: reqEl(doc, 'skills-body'),
    skillsNote: reqEl(doc, 'skills-note'),
    skillsListEl: reqEl(doc, 'skills-list'),
    skillsDetailEl: reqEl(doc, 'skills-detail'),
    sbTabTopics: reqEl(doc, 'sb-tab-topics'),
    sbTabStarred: reqEl(doc, 'sb-tab-starred'),
    sbTabHistory: reqEl(doc, 'sb-tab-history'),
    topicsFilterHost: reqEl(doc, 'topics-filter'),
    historyPane: reqEl(doc, 'history-pane'),
    historyCountEl: reqEl(doc, 'history-count'),
    historyBody: reqEl(doc, 'history-body'),
    historyQ: reqEl<HTMLInputElement>(doc, 'history-q'),
    historyGo: reqEl<HTMLButtonElement>(doc, 'history-go'),
    historyErr: reqEl(doc, 'history-err'),
    historyListEl: reqEl(doc, 'history-list'),
    historyMore: reqEl<HTMLButtonElement>(doc, 'history-more'),
    libLog: reqEl(doc, 'lib-log'),
    libTitle: reqEl(doc, 'lib-title'),
    libNote: reqEl(doc, 'lib-note'),
    libWhy: reqEl(doc, 'lib-why'),
    libTopicBtn: reqEl<HTMLButtonElement>(doc, 'lib-topic'),
    libCloseBtn: reqEl<HTMLButtonElement>(doc, 'lib-close'),
    settingsPage: reqEl(doc, 'settings-page'),
    settingsBody: reqEl(doc, 'settings-body'),
    settingsTopicEl: reqEl(doc, 'settings-topic'),
    settingsClose: reqEl(doc, 'settings-close'),
    settingsOpenBtn: reqEl(doc, 'settings-open'),
    taskPage: reqEl(doc, 'task-page'),
    taskTitle: reqEl(doc, 'task-title'),
    taskSub: reqEl(doc, 'task-sub'),
    taskClose: reqEl(doc, 'task-close'),
    taskNote: reqEl(doc, 'task-note'),
    taskView: reqEl(doc, 'task-view'),
  };
}

function loadCacheCore(): CacheCoreBundle {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- replaced at build time with CACHE_CORE
  __FH_CACHE_CORE__;
  return { STORE, cacheOpen, newer, cacheRecord, cachePut, cacheEvict, snapshotMsgs };
}

function keyOf(m: TranscriptMessage): string {
  return m._local ? m.id : `${m._g}:${m.id}`;
}

function isHistory(state: AppState, m: TranscriptMessage | undefined): boolean {
  return Boolean(m) && !m?._local && state.epoch !== 0 && m?._g !== state.epoch;
}

function forgetTopicState(ctrl: AppControllers, id: string): void {
  ctrl.transcript.scroll.forgetView(id);
  ctrl.cacheService.forget(id);
  ctrl.topicsFeature.forgetPrefetch(id);
  ctrl.composerController.forgetTopic(id);
}

function keepOnlyTopicState(ctrl: AppControllers, keep: Readonly<Record<string, unknown>>): void {
  ctrl.cacheService.keepOnly(keep);
  ctrl.readsService.keepOnly(keep);
  ctrl.transcript.scroll.pruneViews(keep);
  ctrl.composerController.keepOnly(keep);
  ctrl.terminalController.pruneFrames(keep);
}

function pruneTopicState(ctrl: AppControllers): void {
  if (!ctrl.state.topics.length) return;
  const known: Record<string, number> = {};
  for (const t of ctrl.state.topics) known[t.id] = 1;
  ctrl.transcript.scroll.pruneViews(known);
  ctrl.cacheService.prune(known);
  ctrl.topicsFeature.prunePrefetch(known);
  ctrl.composerController.pruneTopics(known);
}

function wireCoreServices(ctrl: AppControllers): void {
  const { dom, state, boot, cacheCore } = ctrl;
  ctrl.streamClient = createStreamClient({
    getTopic: () => state.topic,
    isLoggedOut: () => dom.app.hidden && !dom.gate.hidden,
    getBuild: () => boot.build,
    onBeforeConnect: () => ctrl.transcript.banners.showSkeleton(),
    onOpen: (info) => {
      const fresh = dom.app.hidden || !info.quiet;
      dom.gate.hidden = true;
      dom.app.hidden = false;
      dom.note.textContent = '';
      if (fresh && !ctrl.legacyShell.narrow()) dom.input.focus();
      void ctrl.notifyController.init();
      ctrl.topicsFeature.schedulePrefetch();
      if (fresh && ctrl.legacyShell.schedPane.isOpen()) ctrl.schedulesPanel.onStreamOpen();
    },
    onReconnecting: () => {
      dom.note.textContent = tr('chat.reconnecting');
    },
    onRestarting: () => {
      dom.note.textContent = tr('chat.restarting');
    },
    onAuthExpired: () => {
      dom.app.hidden = true;
      dom.gate.hidden = false;
    },
    onBuildOutdated: () => {
      dom.updateEl.hidden = false;
    },
    onVisibilityResume: () => ctrl.topicsFeature.schedulePrefetch(),
  });
  ctrl.streamClient.onEvent((ev) => handleStreamEvent(ctrl, ev));
  ctrl.streamClient.attachWindowEvents(document, window);

  ctrl.cacheService = createCacheService({
    core: cacheCore,
    getIndexedDB: () => window.indexedDB,
    getTopic: () => state.topic,
    getEpoch: () => state.epoch,
    isSynced: () => state.synced,
    isStale: () => state.stale,
    getLastEventId: () => ctrl.streamClient.getLastEventId(),
    collectScreenMessages: () =>
      collectCacheableMessages(dom.log, state.data as Record<string, CacheMessage | undefined>),
  });

  ctrl.readsService = createReadsService({
    getActiveTopic: () => state.topic,
    getTopics: () => state.topics,
    isOverlayBlocking: () => ctrl.historyPanel.isOpen(),
    postSeen: (topicId) => post('api/seen', { topic: topicId }, 0),
    onChanged: () => ctrl.topicsFeature.paintTopics(),
  });
  ctrl.readsService.attachWindowEvents(document, window);
}

function wireShellAndDevices(ctrl: AppControllers): void {
  const { dom, state, boot, icons } = ctrl;
  ctrl.settingsFeature = createSettingsFeature({
    settingsPage: dom.settingsPage,
    settingsBody: dom.settingsBody,
    settingsTopicEl: dom.settingsTopicEl,
    settingsClose: dom.settingsClose,
    settingsOpenBtn: dom.settingsOpenBtn,
    instrOk: Boolean(boot.instructions),
    getTopic: () => state.topic,
    getTopics: () => state.topics,
    getEpoch: () => state.epoch,
    closeMenus: () => ctrl.legacyShell.setMenu(null, false),
    instructions: {
      ensure: () => ctrl.instructionsPanel.ensure(),
      renderOrphans: () => ctrl.instructionsPanel.renderOrphans(),
      renderAgent: (row, index) => ctrl.instructionsPanel.renderAgent(row, index),
    },
  });

  ctrl.topicStatus = createTopicStatusController({
    statusEl: dom.statusEl,
    pendingQueueEl: dom.pendingQueueEl,
    modelPopEls: {
      modelPop: dom.modelPop,
      mpList: dom.mpList,
      mpFilter: dom.mpFilter,
      mpAgent: dom.mpAgent,
      mpHeading: dom.mpHeading,
      mpFoot: dom.mpFoot,
      mpClose: dom.mpClose,
    },
    getTopic: () => state.topic,
    isSynced: () => state.synced,
    hasLauncher: () => ctrl.transcript.banners.hasLaunch(),
    hasMessages: () => Boolean(dom.log.querySelector('.m')),
    narrow: () => ctrl.legacyShell.narrow(),
    getIcons: () => icons.icon,
    inl,
    setNote: (msg) => {
      dom.note.textContent = msg;
    },
    onRetireLocalNonce: (nonce) => ctrl.composerController.retireLocalNonce(nonce),
    onRecallContent: (content) => ctrl.composerController.recallContent(content),
  });
  ctrl.topicStatus.attach();

  ctrl.legacyShell = createLegacyShell({
    app: dom.app,
    sidebar: dom.sidebar,
    sidebarResize: dom.sidebarResize,
    collapseBtn: dom.collapseBtn,
    expandBtn: dom.expandBtn,
    schedPanel: dom.schedPanel,
    schedResize: dom.schedResize,
    schedToggle: dom.schedToggle,
    backdrop: dom.backdrop,
    optsBtn: dom.optsBtn,
    optsMenu: dom.optsMenu,
    manageBtn: dom.manageBtn,
    manageMenu: dom.manageMenu,
    calmBtn: dom.calmBtn,
    calmState: dom.calmState,
    themeBtn: dom.themeBtn,
    themeState: dom.themeState,
    langBtn: dom.langBtn,
    langState: dom.langState,
    onSchedPaint: () => {
      if (ctrl.schedulesPanel) ctrl.schedulesPanel.paintTab();
    },
    onSchedOpen: () => ctrl.schedulesPanel.onPanelOpen(),
    onSchedClose: () => ctrl.schedulesPanel.disarm(),
    onCloseSchedules: () => ctrl.schedulesPanel.setOpen(false),
  });

  ctrl.notifyController = createNotifyController({
    notifyBtn: dom.notifyBtn,
    notifyState: dom.notifyState,
    post,
    onCachedMessage: (tId, last, ep) => ctrl.cacheService.noteVersion(tId, last, ep),
    onGotoTopic: (goId) => {
      if (goId && goId !== state.topic && state.topics.some((t) => t.id === goId)) {
        ctrl.topicsFeature.switchTopic(goId);
        if (ctrl.legacyShell.narrow()) ctrl.legacyShell.setSidebar(false);
      }
    },
  });

  ctrl.terminalController = createTerminalController({
    enabled: Boolean(boot.terminal),
    canEnd: Boolean(boot.terminalEnd),
    chat: dom.chat,
    chatHead: dom.chatHead,
    composer: dom.composer,
    termBtn: dom.termBtn,
    termHost: dom.termHost,
    termEl: dom.termEl,
    termGrip: dom.termGrip,
    termName: dom.termName,
    termMinBtn: dom.termMinBtn,
    termEndBtn: dom.termEndBtn,
    getTopic: () => state.topic,
    getTopicTitle: (id) => state.topics.find((t) => t.id === id)?.title,
    isOverlayCovering: () => ctrl.historyPanel.isOpen(),
    atBottom: () => ctrl.transcript.scroll.atBottom(),
    toBottom: () => ctrl.transcript.scroll.toBottom(),
    post,
  });

  ctrl.lightbox = createLightbox({ lightbox: dom.lightbox, lightboxImg: dom.lightboxImg });
  ctrl.reader = createReader({
    reader: dom.reader,
    readerName: dom.readerName,
    readerGet: dom.readerGet,
    readerBody: dom.readerBody,
    readerClose: dom.readerClose,
    codeView: ctrl.codeView,
    codeBlocks: (root) => ctrl.transcript.codeBlocks.enhance(root),
  });
}

function wireTranscriptFeature(ctrl: AppControllers): void {
  const { dom, state, icons } = ctrl;
  ctrl.transcript = createTranscriptController({
    log: dom.log,
    btwBox: dom.btwBox,
    btwQ: dom.btwQ,
    btwBody: dom.btwBody,
    btwClose: dom.btwClose,
    machineNoteEl: dom.machineNoteEl,
    forkNote: dom.forkNote,
    getExtraCodeRoots: () => [dom.libLog, dom.readerBody, ctrl.filesPanel.previewEl()],
    getData: () => state.data,
    getEls: () => state.els,
    getTopic: () => state.topic,
    getTopics: () => state.topics,
    topicById: (id) => ctrl.topicsFeature.topicById(id),
    getEpoch: () => state.epoch,
    isSynced: () => state.synced,
    isStale: () => state.stale,
    isEntering: () => state.entering,
    getLaunch: () => state.launch,
    keyOf,
    isHistory: (m) => isHistory(state, m),
    getIcons: () => icons,
    formatStatusClock: stClock,
    codeView: ctrl.codeView,
    copyText: (s, cb) => ctrl.composerController.copyText(s, cb),
    hasOutbox: (nonce) => ctrl.composerController.hasOutbox(nonce),
    claim: (m) => ctrl.composerController.claim(m),
    adoptLegacy: (m) => ctrl.composerController.adoptLegacy(m),
    showUnsent: (tId) => ctrl.composerController.showUnsent(tId),
    cacheSave: () => ctrl.cacheService.scheduleSave(),
    getHistoryMessage: (k) => ctrl.historyPanel.getMessage(k),
    repaintHistoryMessage: (k) => ctrl.historyPanel.repaintMessage(k),
    paintTopics: () => ctrl.topicsFeature.paintTopics(),
    paintStatus: () => ctrl.topicStatus.paintStatus(),
    switchTopic: (id) => ctrl.topicsFeature.switchTopic(id),
    isNarrow: () => ctrl.legacyShell.narrow(),
    setSidebar: (open) => ctrl.legacyShell.setSidebar(open),
    openShot: (img) => ctrl.lightbox.open(img),
    sendCommand: (cmd) => ctrl.composerController.command(cmd),
    openReader: (link) => ctrl.reader.open(link),
    deliverLocal: (nonce) => ctrl.composerController.deliver(nonce),
    copyLocal: (nonce, btn) => ctrl.composerController.copyLocal(nonce, btn),
    discardLocal: (nonce) => ctrl.composerController.discardLocal(nonce),
  });
  ctrl.transcript.attachEvents(document);
}

function wireTopicsFeature(ctrl: AppControllers): void {
  const { dom, state, boot, icons, cacheCore } = ctrl;
  ctrl.topicsFeature = createTopicsFeature({
    els: {
      bar: dom.bar,
      topicsFilterHost: dom.topicsFilterHost,
      rowMenu: dom.rowMenu,
      newTopicBtn: dom.newTopicBtn,
      readBtn: dom.readBtn,
      clearBtn: dom.clearBtn,
      idleBtn: dom.idleBtn,
      noIdleBtn: dom.noIdleBtn,
      idleCount: dom.idleCount,
      idleDialog: dom.idleDialog,
      idleTitle: dom.idleTitle,
      idleWhy: dom.idleWhy,
      idleList: dom.idleList,
      idleGo: dom.idleGo,
      idleCancel: dom.idleCancel,
      chatTitle: dom.chatTitle,
      chatStatus: dom.chatStatus,
      killBtn: dom.killBtn,
      stopBtn: dom.stopBtn,
      note: dom.note,
    },
    instanceId: boot.instance || 'web',
    termOk: Boolean(boot.terminal),
    getIcons: () => icons.icon,
    getTopics: () => state.topics,
    setTopics: (next) => {
      state.topics = next;
    },
    getTopic: () => state.topic,
    setTopic: (id) => {
      state.topic = id;
    },
    getEpoch: () => state.epoch,
    narrow: () => ctrl.legacyShell.narrow(),
    setSidebar: (open) => ctrl.legacyShell.setSidebar(open),
    setSbTab: (tab) => ctrl.historyPanel.setTab(tab as SidebarTab),
    getSbTab: () => ctrl.historyPanel.getTab(),
    closeMenus: () => ctrl.legacyShell.setMenu(null, false),
    closeLib: () => ctrl.historyPanel.close(),
    refreshHistoryReadOnly: () => ctrl.historyPanel.refreshReadOnly(),
    closeSettings: () => ctrl.settingsFeature.close(),
    closeGit: () => ctrl.gitPanel.close(),
    closeTransientSchedules: () => {
      if (ctrl.legacyShell.schedPane.isOpen() && !ctrl.legacyShell.schedPane.docked()) {
        ctrl.schedulesPanel.setOpen(false, true);
      }
    },
    onSchedulesTopicsUpdated: () => ctrl.schedulesPanel.onTopicsUpdated(),
    getScheduleTask: (id) => ctrl.schedulesPanel.getTask(id),
    openTaskPage: (id, edit) => ctrl.schedulesPanel.openTaskPage(id, edit),
    scheduleOp: (id, action, btn) =>
      ctrl.schedulesPanel.op(
        id,
        action as Parameters<SchedulesPanel['op']>[1],
        btn instanceof HTMLButtonElement ? btn : null,
      ),
    rememberAdoptedReview: (topicId, reviewText) =>
      ctrl.reviewsPanel.rememberAdopted(topicId, reviewText),
    unreadOf: (t) => ctrl.readsService.unreadOf(t),
    needsRead: (t) => ctrl.readsService.needsRead(t),
    syncReads: (list, activeId) => ctrl.readsService.syncTopics(list, activeId),
    markTopicReadFromList: (id, list) => ctrl.readsService.markTopicFromList(id, list),
    removeRead: (id) => ctrl.readsService.remove(id),
    markAllRead: (list, noun, say) => {
      void ctrl.readsService.markAllRead(list, noun, say);
    },
    reportSeen: () => ctrl.readsService.reportSeen(),
    offSince: (host) => ctrl.transcript.banners.offSince(host),
    offTitle: (host) => ctrl.transcript.banners.offTitle(host),
    paintMachineNote: () => ctrl.transcript.banners.paintMachineNote(),
    paintForkNote: (cur) => ctrl.transcript.banners.paintForkNote(cur),
    syncCopyRef: () => ctrl.composerController.syncCopyRef(),
    copyTopicRef: (id) => ctrl.composerController.copyTopicRef(id),
    applyTerm: () => ctrl.terminalController.apply(),
    paintFrames: () => ctrl.terminalController.paintFrames(),
    dropTerm: (id) => ctrl.terminalController.drop(id),
    urlNow: () => ctrl.terminalController.urlNow(),
    command: (cmd) => ctrl.composerController.command(cmd),
    saveView: (id) => ctrl.transcript.scroll.saveView(id, state.entering),
    stashDraft: (id) => ctrl.composerController.stashDraft(id),
    loadDraft: (id) => ctrl.composerController.loadDraft(id),
    seedDraft: (topicId, draftText) => ctrl.composerController.seedDraft(topicId, draftText),
    forgetTopic: (id) => forgetTopicState(ctrl, id),
    keepOnlyTopics: (keep) => keepOnlyTopicState(ctrl, keep),
    resetForSwitch: (nextId) => {
      dom.log.innerHTML = '';
      state.data = {};
      state.els = {};
      state.stale = false;
      ctrl.topicStatus.closeModelPop();
      ctrl.transcript.resetForTopicSwitch(nextId);
      ctrl.topicStatus.setStatus(null);
      ctrl.topicStatus.setPending([]);
      state.entering = true;
      state.synced = false;
    },
    showSkeleton: () => ctrl.transcript.banners.showSkeleton(),
    setStale: (v) => {
      state.stale = v;
    },
    setSettleOnResume: (v) => {
      state.settleOnResume = v;
    },
    claimMessage: (m) => ctrl.composerController.claim(m as unknown as TranscriptMessage),
    adoptMessages: (list, current) =>
      ctrl.transcript.adopt(list as unknown as readonly TranscriptMessage[], current),
    showUnsent: (tId) => ctrl.composerController.showUnsent(tId),
    isDbAvailable: () => ctrl.cacheService.isDbAvailable(),
    getCacheVersion: (id) => ctrl.cacheService.getVersion(id),
    setCacheVersion: (id, ver) => ctrl.cacheService.setVersion(id, ver),
    isNewer: cacheCore.newer,
    memCopy: (id) => ctrl.cacheService.memCopy(id),
    getCache: (id) => ctrl.cacheService.get(id),
    peekCache: (id) => ctrl.cacheService.peek(id),
    putCache: (id, msgs, meta) => ctrl.cacheService.put(id, msgs, meta),
    dropCache: (id) => ctrl.cacheService.drop(id),
    leaveCache: () => ctrl.cacheService.leave(),
    snapshotMsgs: cacheCore.snapshotMsgs,
    isStreamParked: () => ctrl.streamClient.isParked(),
    isStreamOpen: () => ctrl.streamClient.isOpen(),
    closeStream: () => ctrl.streamClient.close(),
    setStreamLastEventId: (last) => ctrl.streamClient.setLastEventId(last),
    connectStream: (resume) => ctrl.streamClient.connect(resume),
  });
}

function wireComposerFeature(ctrl: AppControllers): void {
  const { dom, state, boot, icons, overlays } = ctrl;
  ctrl.composerController = createComposerController({
    els: {
      input: dom.input,
      chips: dom.chips,
      hints: dom.hints,
      note: dom.note,
      picker: dom.picker,
      attachBtn: dom.attachBtn,
      micBtn: dom.micBtn,
      composerForm: dom.composerForm,
      copyRefBtn: dom.copyRefBtn,
      killBtn: dom.killBtn,
      stopBtn: dom.stopBtn,
    },
    overlays,
    instanceId: boot.instance || 'web',
    getTopic: () => state.topic,
    getTopics: () => state.topics,
    topicById: (id) => ctrl.topicsFeature.topicById(id) ?? undefined,
    getEpoch: () => state.epoch,
    isNarrow: () => ctrl.legacyShell.narrow(),
    isHistoryOpen: () => ctrl.historyPanel.isOpen(),
    getHistoryRef: () => ctrl.historyPanel.currentRef(),
    getIcons: () => icons.icon,
    openShot: (img) => ctrl.lightbox.open(img),
    settleAdopted: (id, typed) => ctrl.reviewsPanel.settleAdopted(id, typed),
    cacheSave: () => ctrl.cacheService.scheduleSave(),
    topicStatus: ctrl.topicStatus,
    transcript: {
      getMessage: (key) => state.data[key] as unknown as LocalBubbleMessage | undefined,
      setMessage: (key, msg) => {
        state.data[key] = msg as unknown as TranscriptMessage;
      },
      deleteMessage: (key) => ctrl.transcript.retireLocalKey(key),
      hasElement: (key) => Boolean(state.els[key]),
      removeElement: (key) => {
        const el = state.els[key];
        if (el) {
          el.remove();
          delete state.els[key];
        }
      },
      adoptElement: (fromKey, toKey) => ctrl.transcript.transferLocalKey(fromKey, toKey),
      paint: (key) => ctrl.transcript.paint(key),
      drop: (key) => ctrl.transcript.drop(key),
      sinkLocals: () => ctrl.transcript.sinkLocals(),
      syncEmptyNote: () => ctrl.transcript.banners.syncEmptyNote(),
      atBottom: () => ctrl.transcript.scroll.atBottom(),
      toBottom: () => ctrl.transcript.scroll.toBottom(),
      onBtwAsked: (key, msg) => {
        if (ctrl.transcript.btwAsked(key, msg as unknown as TranscriptMessage) !== null) {
          ctrl.transcript.btw.open(key);
        }
      },
      onClaimKeyMoved: (fromKey, toKey) => ctrl.transcript.btw.transferKey(fromKey, toKey),
    },
  });
  ctrl.composerController.attach();
}

function wireReviewsAndHistoryPanels(ctrl: AppControllers): void {
  const { dom, state, icons } = ctrl;
  ctrl.reviewsPanel = createReviewsPanel({
    app: dom.app,
    revList: dom.revList,
    text,
    schedAgo: (at) => ctrl.topicsFeature.schedAgo(at),
    post,
    showNote: (msg) => ctrl.schedulesPanel.showNote(msg),
    paintCounts: () => ctrl.schedulesPanel.paintCounts(),
    paintSummary: () => ctrl.schedulesPanel.paintSummary(),
    topicExists: (id) => ctrl.topicsFeature.topicExists(id),
    switchTopic: (id) => ctrl.topicsFeature.switchTopic(id),
    createTopic: (seed) => ctrl.topicsFeature.createTopic(seed),
    beforeSkillArchive: () => ctrl.skillsPanel.beforeExternalWrite(),
    afterSkillArchive: (refreshPending) => ctrl.skillsPanel.afterExternalWrite(refreshPending),
  });

  ctrl.historyPanel = createHistoryPanel({
    sidebar: dom.sidebar,
    bar: dom.bar,
    topicsFilterHost: dom.topicsFilterHost,
    sbTabTopics: dom.sbTabTopics,
    sbTabStarred: dom.sbTabStarred,
    sbTabHistory: dom.sbTabHistory,
    historyPane: dom.historyPane,
    historyCountEl: dom.historyCountEl,
    historyBody: dom.historyBody,
    historyQ: dom.historyQ,
    historyGo: dom.historyGo,
    historyErr: dom.historyErr,
    historyListEl: dom.historyListEl,
    historyMore: dom.historyMore,
    chat: dom.chat,
    log: dom.log,
    hints: dom.hints,
    libLog: dom.libLog,
    libTitle: dom.libTitle,
    libNote: dom.libNote,
    libWhy: dom.libWhy,
    libTopicBtn: dom.libTopicBtn,
    libCloseBtn: dom.libCloseBtn,
    text,
    atBottom: () => ctrl.transcript.scroll.atBottom(),
    firstVisible: () => ctrl.transcript.scroll.firstVisible(),
    toBottom: () => ctrl.transcript.scroll.toBottom(),
    getLogEl: (key) => state.els[key],
    closeModelPop: () => ctrl.topicStatus.closeModelPop(),
    paintFrames: () => ctrl.terminalController.paintFrames(),
    paintTermHeightIfOpen: () => ctrl.terminalController.paintHeightIfOpen(),
    reportSeen: () => ctrl.readsService.reportSeen(),
    topicExists: (id) => ctrl.topicsFeature.topicExists(id),
    switchTopic: (id) => ctrl.topicsFeature.switchTopic(id),
    narrow: () => ctrl.legacyShell.narrow(),
    setSidebar: (open) => ctrl.legacyShell.setSidebar(open),
    msgMarkup: (key, msg, hist) => ctrl.transcript.msgMarkup(key, msg, hist),
    codeBlocks: (root) => ctrl.transcript.codeBlocks.enhance(root),
    forgetOpenedPrefix: (prefix) => ctrl.transcript.forgetOpenedPrefix(prefix),
    openShot: (img) => {
      if (img instanceof HTMLImageElement) ctrl.lightbox.open(img);
    },
    toggleAll: (key) => {
      if (key) ctrl.transcript.toggleAll(key);
    },
    toggleLine: (line) => {
      if (line instanceof HTMLElement) ctrl.transcript.toggleLine(line);
    },
    icons: () => icons.icon,
    copyText: (s, done) => ctrl.composerController.copyText(s, done),
    onLibStateChange: () => ctrl.composerController.syncCopyRef(),
    onTopicTabChange: () => ctrl.topicsFeature.paintTopics(),
  });
}

function wireSchedulesPanel(ctrl: AppControllers): void {
  const { dom, state, icons } = ctrl;
  ctrl.schedulesPanel = createSchedulesPanel({
    app: dom.app,
    schedToggle: dom.schedToggle,
    schedAlert: dom.schedAlert,
    schedList: dom.schedList,
    schedSummary: dom.schedSummary,
    schedReadBtn: dom.schedReadBtn,
    schedFilterHost: dom.schedFilterHost,
    schedNewBtn: dom.schedNewBtn,
    schedClose: dom.schedClose,
    schedNote: dom.schedNote,
    schedSessionList: dom.schedSessionList,
    schedSubnav: dom.schedSubnav,
    schedTabScheduled: dom.schedTabScheduled,
    schedTabScheduledN: dom.schedTabScheduledN,
    schedTabScheduledAlert: dom.schedTabScheduledAlert,
    schedTabReviews: dom.schedTabReviews,
    schedTabReviewsN: dom.schedTabReviewsN,
    schedTabTasks: dom.schedTabTasks,
    schedTabTasksN: dom.schedTabTasksN,
    schedTabSessions: dom.schedTabSessions,
    schedTabSessionsN: dom.schedTabSessionsN,
    schedSessionsAlert: dom.schedSessionsAlert,
    revPane: dom.revPane,
    rowMenu: dom.rowMenu,
    taskPage: dom.taskPage,
    taskTitle: dom.taskTitle,
    taskSub: dom.taskSub,
    taskClose: dom.taskClose,
    taskNote: dom.taskNote,
    taskView: dom.taskView,
    icons: () => icons.icon,
    getTopics: () => state.topics,
    getTopic: () => state.topic,
    topicById: (id) => ctrl.topicsFeature.topicById(id),
    runOwners: () => ctrl.topicsFeature.runOwners(),
    rowRunning: (t) => ctrl.topicsFeature.rowRunning(t),
    unreadOf: (t) => ctrl.readsService.unreadOf(t),
    needsRead: (t) => ctrl.readsService.needsRead(t),
    topicTree: (list) => ctrl.topicsFeature.topicTree(list),
    treeWalker: (tree) => ctrl.topicsFeature.treeWalker({ ...tree, forks: tree.forks ?? {} }),
    treeRowHtml: (row, o) => ctrl.topicsFeature.treeRowHtml(row, o),
    rowHtml: (o) => ctrl.topicsFeature.rowHtml(o),
    agentTagHtml: (t) => ctrl.topicsFeature.agentTagHtml(t),
    splitTitle: (title) => ctrl.topicsFeature.splitTitle(title),
    text,
    schedAgo: (at) => ctrl.topicsFeature.schedAgo(at),
    ageClock: (at) => ctrl.topicsFeature.ageClock(at),
    ageText: (ms, done) => ctrl.topicsFeature.ageText(ms, done),
    stLeft,
    atBottom: () => ctrl.transcript.scroll.atBottom(),
    toBottom: () => ctrl.transcript.scroll.toBottom(),
    armAgeTick: () => ctrl.topicsFeature.armAgeTick(),
    markAllRead: (list, noun, say) => {
      void ctrl.readsService.markAllRead(list, noun, say);
    },
    switchTopic: (id) => ctrl.topicsFeature.switchTopic(id),
    foldClick: (e) => ctrl.topicsFeature.foldClick(e),
    rowMenuFollow: () => ctrl.topicsFeature.rowMenuFollow(),
    closeRowMenu: (focusBack) => ctrl.topicsFeature.closeRowMenu(focusBack),
    getRowMenuKey: () => ctrl.topicsFeature.getRowMenuKey(),
    openRowMenuFor: (btn) => {
      if (btn instanceof HTMLElement) ctrl.topicsFeature.openRowMenuFor(btn);
    },
    makeFilterBar: (opts) => ctrl.topicsFeature.makeFilterBar(opts),
    paneIsOpen: () => ctrl.legacyShell.schedPane.isOpen(),
    paneDocked: () => ctrl.legacyShell.schedPane.docked(),
    paneSetOpen: (open, opts) => ctrl.legacyShell.schedPane.setOpen(open, opts),
    reviewsCount: () => ctrl.reviewsPanel.count(),
    loadReviews: () => ctrl.reviewsPanel.load(),
    paintReviews: () => ctrl.reviewsPanel.paint(),
  });
}

function wireWorkspacePanels(ctrl: AppControllers): void {
  const { dom, state, boot, icons } = ctrl;
  ctrl.skillsPanel = createSkillsPanel({
    app: dom.app,
    skillsWin: dom.skillsWin,
    skillsToggle: dom.skillsToggle,
    skillsBack: dom.skillsBack,
    skillsTitle: dom.skillsTitle,
    skillsCount: dom.skillsCount,
    skillsNewBtn: dom.skillsNewBtn,
    skillsRefreshBtn: dom.skillsRefreshBtn,
    skillsClose: dom.skillsClose,
    skillsBody: dom.skillsBody,
    skillsNote: dom.skillsNote,
    skillsListEl: dom.skillsListEl,
    skillsDetailEl: dom.skillsDetailEl,
    icons: () => icons.icon,
    text,
    schedAgo: (at) => ctrl.topicsFeature.schedAgo(at),
    byteSize: formatByteSize,
    copyText: (s, done) => ctrl.composerController.copyText(s, done),
    post,
    closeMenus: () => ctrl.legacyShell.setMenu(null, false),
  });

  ctrl.gitPanel = createGitPanel({
    getTopic: () => state.topic,
    input: dom.input,
    text,
    schedAgo: (at) => ctrl.topicsFeature.schedAgo(at),
    narrow: () => ctrl.legacyShell.narrow(),
    codeView: ctrl.codeView,
    closeMenus: () => ctrl.legacyShell.setMenu(null, false),
  });

  ctrl.filesPanel = createFilesPanel({
    filesOk: Boolean(boot.files),
    instrOk: Boolean(boot.instructions),
    getTopic: () => state.topic,
    text,
    post,
    codeView: ctrl.codeView,
    codeBlocks: (root) => ctrl.transcript.codeBlocks.enhance(root),
    closeMenus: () => ctrl.legacyShell.setMenu(null, false),
  });

  ctrl.instructionsPanel = createInstructionsPanel({
    instrOk: Boolean(boot.instructions),
    settingsPage: dom.settingsPage,
    settingsBody: dom.settingsBody,
    filesPanel: ctrl.filesPanel,
    getSettingsMsg: () => ctrl.settingsFeature.getMessage(),
    getSettingsTopic: () => ctrl.settingsFeature.getTopic() || '',
    getTopic: () => state.topic,
    renderSettings: () => ctrl.settingsFeature.render(),
    text,
    inl,
    post,
  });

  ctrl.schedulesPanel.paintTab();
  ctrl.schedulesPanel.init();
}

function handleSyncEvent(
  ctrl: AppControllers,
  ev: Extract<WebEvent, { t: 'sync' }>,
): void {
  const { dom, state } = ctrl;
  const { topic } = state;
  if (topic && ev.topic !== topic) return;
  const named = !topic;
  state.topic = ev.topic;
  if (named) ctrl.composerController.loadDraftIfEmpty(state.topic);
  history.replaceState(null, '', ctrl.terminalController.urlNow());
  ctrl.terminalController.apply();

  const arriving = ctrl.transcript.scroll.isArriving(state.entering);
  const stick = ctrl.transcript.scroll.atBottom();
  state.entering = false;

  if (state.epoch && ev.epoch && ev.epoch !== state.epoch) {
    ctrl.streamClient.checkBuild();
    ctrl.topicsFeature.clearPrefetchTried();
  }
  state.settleOnResume = false;
  state.epoch = ev.epoch || 0;
  state.synced = true;
  state.stale = Boolean(ev.stale);
  state.launch = ev.agents || null;

  ctrl.transcript.takeMachines(ev.offline || []);
  ctrl.transcript.repaintHistory();
  ctrl.composerController.showUnsent(state.topic);
  ctrl.transcript.reconcile(ev.messages);
  ctrl.composerController.settleUnsure();
  ctrl.transcript.banners.placeDivider();
  ctrl.transcript.banners.syncEmptyNote();
  if (ctrl.transcript.btw.isOpen()) ctrl.transcript.btw.render(false);
  ctrl.cacheService.scheduleSave();

  if (named) {
    void ctrl.cacheService.get(state.topic).then((c) => {
      if (c && c.msgs.length && ev.topic === state.topic) {
        ctrl.transcript.adopt(c.msgs as unknown as readonly TranscriptMessage[]);
      }
    });
  }
  ctrl.readsService.setCount(state.topic, ev.messages.length);
  ctrl.composerController.setCommands(ev.commands || []);
  state.topics = ev.topics || [];
  ctrl.streamClient.setTopicsVersion(ev.tv || 0);
  ctrl.topicsFeature.paintTopics();
  pruneTopicState(ctrl);
  ctrl.topicStatus.setStatus(ev.status);
  ctrl.topicStatus.setPending(ev.pending || []);
  dom.note.textContent = '';
  if (arriving) ctrl.transcript.scroll.land(state.els);
  else if (stick) ctrl.transcript.scroll.toBottom();
  ctrl.transcript.scroll.clearView();
  ctrl.topicsFeature.schedulePrefetch();
}

function handleMessageEvent(ctrl: AppControllers, msg: WebMessage): void {
  const { state } = ctrl;
  if (ctrl.settingsFeature.handleMessage(msg)) return;
  ctrl.composerController.claim(msg);
  ctrl.transcript.upsert(msg);
  ctrl.transcript.btw.onArrived(msg);
  ctrl.cacheService.scheduleSave();
  ctrl.topicStatus.onMessageArrived();
  ctrl.readsService.increment(state.topic);
  const cur = state.topics.find((t) => t.id === state.topic);
  if (cur) cur.msgCount = (cur.msgCount || 0) + 1;
  ctrl.topicsFeature.paintTopics();
}

function handleReactEvent(
  ctrl: AppControllers,
  ev: Extract<WebEvent, { t: 'react' }>,
): void {
  const rk = `${ctrl.state.epoch}:${ev.id}`;
  const m = ctrl.state.data[rk];
  if (!m) return;
  const kept = (m.reactions || []).filter((e) => e !== ev.emoji);
  m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
  ctrl.transcript.paint(rk);
  ctrl.cacheService.scheduleSave();
}

function handleTypingEvent(ctrl: AppControllers, on: boolean): void {
  ctrl.dom.typing.hidden = !on;
  const cur = ctrl.state.topics.find((t) => t.id === ctrl.state.topic);
  if (cur) cur.running = on;
  ctrl.topicsFeature.paintTopics();
  if (!on) {
    ctrl.transcript.codeBlocks.sweep();
    ctrl.gitPanel.onTurnEnd();
  }
}

function handleTopicsEvent(
  ctrl: AppControllers,
  ev: Extract<WebEvent, { t: 'topics' | 'topic-rows' }>,
): void {
  const { state } = ctrl;
  state.topics = ev.t === 'topics' ? ev.topics || [] : applyTopicRows(state.topics, ev);
  ctrl.streamClient.setTopicsVersion(ev.tv || 0);
  ctrl.topicsFeature.paintTopics();
  ctrl.readsService.reportSeen();
  if (state.topic && !state.topics.some((t) => t.id === state.topic)) {
    const first = state.topics[0];
    if (first) ctrl.topicsFeature.switchTopic(first.id);
    else void ctrl.topicsFeature.createTopic();
  }
  pruneTopicState(ctrl);
  ctrl.topicsFeature.schedulePrefetch();
}

function handleResumedEvent(ctrl: AppControllers): void {
  const { state, dom } = ctrl;
  if (state.synced) return;
  state.synced = true;
  state.entering = false;
  if (state.settleOnResume) {
    state.settleOnResume = false;
    ctrl.composerController.settleUnsure();
  }
  ctrl.transcript.banners.clearSyncing();
  ctrl.transcript.banners.placeDivider();
  ctrl.transcript.banners.syncEmptyNote();
  ctrl.cacheService.scheduleSave();
  dom.note.textContent = '';
}

function handleStreamEvent(ctrl: AppControllers, raw: StreamEventPayload): void {
  const ev = raw as unknown as WebEvent;
  switch (ev.t) {
    case 'sync':
      handleSyncEvent(ctrl, ev);
      return;
    case 'msg':
      handleMessageEvent(ctrl, ev.msg);
      return;
    case 'del':
      ctrl.transcript.drop(`${ctrl.state.epoch}:${ev.id}`);
      ctrl.cacheService.scheduleSave();
      return;
    case 'react':
      handleReactEvent(ctrl, ev);
      return;
    case 'typing':
      handleTypingEvent(ctrl, ev.on);
      return;
    case 'commands':
      ctrl.composerController.setCommands(ev.commands || []);
      return;
    case 'status':
      ctrl.topicStatus.setStatus(ev.status);
      return;
    case 'pending':
      ctrl.topicStatus.setPending(ev.items || []);
      return;
    case 'machines':
      ctrl.transcript.setMachines(ev.offline || []);
      return;
    case 'topics':
    case 'topic-rows':
      handleTopicsEvent(ctrl, ev);
      return;
    case 'resumed':
      handleResumedEvent(ctrl);
      return;
    case 'bye':
      return;
  }
}

function wireOverlaysAndGlobalEvents(ctrl: AppControllers): void {
  const { dom, state, boot, overlays } = ctrl;

  dom.updateReloadBtn?.addEventListener('click', () => {
    ctrl.composerController.stashDraft(state.topic);
    location.reload();
  });

  dom.gateForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!boot.password) {
      location.reload();
      return;
    }
    dom.err.textContent = '';
    const secretEl = dom.secretInput;
    const token = secretEl ? secretEl.value : '';
    void post('api/login', { token }, 0)
      .then((r) => {
        if (r.ok) {
          if (secretEl) secretEl.value = '';
          ctrl.streamClient.connect();
          return;
        }
        dom.err.textContent =
          r.status === 429 ? tr('gate.tooManyAttempts') : tr('gate.wrongToken');
      })
      .catch(() => {
        dom.err.textContent = tr('common.reachServerError');
      });
  });

  overlays.registerFallback(() => {
    if (ctrl.filesPanel.isCustomOpen()) {
      ctrl.filesPanel.close();
      return true;
    }
    return false;
  });

  overlays.registerFallback(() => {
    const hintsOpen = ctrl.composerController.isHintsOpen();
    const openMenu = ctrl.legacyShell.openMenu();
    const hadOverlay =
      hintsOpen ||
      !dom.lightbox.hidden ||
      !dom.reader.hidden ||
      !dom.idleDialog.hidden ||
      !dom.rowMenu.hidden ||
      Boolean(openMenu) ||
      !dom.skillsWin.hidden ||
      !dom.settingsPage.hidden ||
      !dom.taskPage.hidden ||
      ctrl.filesPanel.isOpen() ||
      ctrl.gitPanel.isOpen();
    ctrl.lightbox.close();
    ctrl.reader.close();
    ctrl.topicsFeature.closeIdle();
    ctrl.skillsPanel.close();
    ctrl.settingsFeature.close();
    ctrl.filesPanel.close();
    ctrl.gitPanel.close();
    ctrl.schedulesPanel.closeTaskPage(false);
    ctrl.topicsFeature.closeRowMenu(true);
    if (hintsOpen) ctrl.composerController.closeHints();
    const activeMenu = ctrl.legacyShell.openMenu();
    if (activeMenu) {
      ctrl.legacyShell.setMenu(null, false);
      activeMenu.btn.focus();
    }
    return hadOverlay;
  });

  overlays.registerFallback(() => {
    if (ctrl.transcript.btw.isOpen()) {
      ctrl.transcript.btw.close(true);
      return true;
    }
    if (ctrl.legacyShell.schedPane.isOpen()) {
      ctrl.schedulesPanel.setOpen(false);
      return true;
    }
    if (ctrl.legacyShell.sbPane.isOpen()) {
      ctrl.legacyShell.setSidebar(false);
      return true;
    }
    return false;
  });

  onLocaleChange(() => {
    applyDomI18n(document);
    ctrl.legacyShell.paintLang();
    ctrl.legacyShell.paintTheme();
    ctrl.legacyShell.paintCalm();
    ctrl.notifyController.paint();
    ctrl.composerController.onLocaleChange();
    ctrl.transcript.refreshI18n();
    ctrl.topicsFeature.onLocaleChange();
    ctrl.topicStatus.onLocaleChange();
    for (const mk of Object.keys(state.els)) {
      if (state.data[mk]) ctrl.transcript.paint(mk);
    }
    if (ctrl.transcript.btw.isOpen()) ctrl.transcript.btw.render(false);
    ctrl.settingsFeature.onLocaleChange();
    ctrl.schedulesPanel.repaint();
    ctrl.reviewsPanel.paint();
    ctrl.historyPanel.repaint();
    ctrl.skillsPanel.repaint();
    ctrl.gitPanel.repaint();
    ctrl.filesPanel.repaint();
    if (boot.terminal) ctrl.terminalController.paintFrames();
  });
}

function bootstrap(): void {
  const dom: AppDom = {
    ...collectChatAndShellDom(document),
    ...collectPanelsDom(document),
  };

  initLocale();
  const schedTitleEl = document.querySelector('#schedules-head .panel-title');
  if (schedTitleEl) schedTitleEl.setAttribute('data-i18n', 'sideTasks.title');
  applyDomI18n(document);

  const BOOT = readBootConfig(document);
  const icons = __FH_ICONS__;
  const cacheCore = loadCacheCore();
  const codeView = createCodeViewLoader(BOOT.codeview);
  const overlays = new OverlayManager();
  overlays.attach(document);

  const state: AppState = {
    data: {},
    els: {},
    topics: [],
    topic: new URLSearchParams(location.search).get('t') || '',
    epoch: 0,
    synced: false,
    entering: true,
    stale: false,
    launch: null,
    settleOnResume: false,
  };

  const ctrl = {
    boot: BOOT,
    icons,
    dom,
    state,
    overlays,
    cacheCore,
    codeView,
  } as AppControllers;

  wireCoreServices(ctrl);
  wireShellAndDevices(ctrl);
  wireTranscriptFeature(ctrl);
  wireTopicsFeature(ctrl);
  wireComposerFeature(ctrl);
  wireReviewsAndHistoryPanels(ctrl);
  wireSchedulesPanel(ctrl);
  wireWorkspacePanels(ctrl);
  ctrl.topicsFeature.attach();
  wireOverlaysAndGlobalEvents(ctrl);

  if (state.topic && ctrl.composerController.hasDraft(state.topic)) {
    ctrl.composerController.loadDraft(state.topic);
  }
  ctrl.terminalController.apply();
  ctrl.topicsFeature.enter(state.topic);
  mountWorkbenchIfEnabled(document, {
    resolveIcon: (name) => icons.icon[name] ?? '',
  });
}

bootstrap();
