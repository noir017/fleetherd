// The web UI's client script, moved out of `page.ts` as it was (Phase 1 Step 1A of
// docs/refactor-plan.md): the same text the page used to carry inline, now bundled by
// `scripts/webui-client.mjs` into `dist/webui-assets/app-<hash>.js` and loaded by the page's one
// `<script src>`, so the CSP can drop `script-src 'unsafe-inline'`.
//
// Still not typechecked or linted — `tsconfig.json` and `eslint.config.js` leave this file out —
// and still kept deliberately stupid for the reasons `page.ts` gives: every decision that can live
// in TypeScript lives on the server's side of the wire. Splitting it into typed modules is the
// plan's later steps, not this one, so read it as the old inline script with three seams:
//
//   - What the server decides per deployment (terminal, files, instructions, which gate, the
//     code view's bundle, the page's build) arrives in `<script type="application/json"
//     id="boot-config">`, read once into `BOOT` below. It used to be spliced into this text.
//   - The two `__FH_…__` markers below are replaced at build time (`scripts/webui-client.mjs`)
//     with `clientIcons()` (icons.ts) and `CACHE_CORE` (cache-script.ts). The cache core is source
//     text that sw.ts includes too, so it cannot be an import until both are modules; the build
//     fails if either marker is missing or doubled rather than ship one that throws at load.
//   - The test harness runs the same bundle (page.test-helpers.ts), so a page that renders
//     nothing still fails page.dom.*.test.ts the way it always did.

import { createReviewsPanel } from './panels/reviews.js';
import { createHistoryPanel } from './panels/history.js';
import { createGitPanel } from './panels/git.js';
import { createFilesPanel } from './panels/files.js';
import { createInstructionsPanel } from './panels/instructions.js';
import { createSchedulesPanel } from './panels/schedules.js';
import { createSkillsPanel } from './panels/skills.js';
import {
  applyDomI18n,
  getLocale,
  initLocale,
  onLocaleChange,
  t as tr,
} from './i18n/index.js';
import { readBootConfig } from './services/boot.js';
import { text, wait, post, sendLimit } from './services/api.js';
import { OverlayManager } from './services/overlays.js';
import { applyTopicRows, createStreamClient } from './services/stream.js';
import { collectCacheableMessages, createCacheService } from './services/cache.js';
import { createReadsService } from './services/reads.js';
import { createSettingsFeature, inlineCodeHtml as inl } from './features/settings/index.js';
import { createTopicStatusController, stClock, stLeft } from './features/topic/status/index.js';
import { createNotifyController } from './features/notify/index.js';
import { createTerminalController } from './features/terminal/index.js';
import {
  createCodeViewLoader,
  createLightbox,
  createReader,
  formatByteSize,
} from './features/reader/index.js';
import { createLegacyShell } from './workbench/legacy-shell.js';
import { createTranscriptController } from './features/topic/transcript/index.js';

(function(){
  var $ = function(id){ return document.getElementById(id); };
  var log=$('log'), app=$('app'), gate=$('login'), err=$('err'), input=$('input'),
      chips=$('chips'), hints=$('hints'), typing=$('typing'), note=$('note'), picker=$('picker'),
      bar=$('topics'), sidebar=$('sidebar'), collapseBtn=$('collapse-sidebar'),
      expandBtn=$('expand-sidebar'), newTopicBtn=$('new-topic'), backdrop=$('backdrop'),
      clearBtn=$('clear-topics'), readBtn=$('read-topics'), idleBtn=$('close-idle'), noIdleBtn=$('no-idle'), idleCount=$('idle-count'),
      notifyBtn=$('notify-toggle'), notifyState=$('notify-state'), idleDialog=$('idle-dialog'), idleTitle=$('idle-title'),
      rowMenu=$('row-menu'),
      optsBtn=$('opts-toggle'), optsMenu=$('opts-menu'), manageBtn=$('manage-toggle'), manageMenu=$('manage-menu'),
      calmBtn=$('calm-toggle'), calmState=$('calm-state'),
      themeBtn=$('theme-toggle'), themeState=$('theme-state'),
      langBtn=$('lang-toggle'), langState=$('lang-state'),
      idleWhy=$('idle-why'), idleList=$('idle-list'), idleGo=$('idle-go'), idleCancel=$('idle-cancel'), chatTitle=$('topic-title'), chatStatus=$('topic-status'), forkNote=$('fork-note'),
      chat=$('chat'), chatHead=$('chat-header'), composer=$('bar'),
      termBtn=$('term-toggle'), termHost=$('term-frames'), termEl=$('term'), termGrip=$('term-grip'),
      termName=$('term-name'), termMinBtn=$('term-min'), termEndBtn=$('term-end'),
      schedToggle=$('schedules-toggle'), schedAlert=$('sched-alert'), schedList=$('schedules-list'), schedSummary=$('schedules-summary'), schedReadBtn=$('sched-read'),
      schedFilterHost=$('sched-filter'), schedNewBtn=$('sched-new'),
      schedClose=$('schedules-close'), schedNote=$('schedules-note'),
      schedPanel=$('schedules'), schedSessionList=$('sched-sessions'), schedResize=$('sched-resize'),
      schedSubnav=$('sched-subnav'),
      schedTabScheduled=$('sched-tab-scheduled'), schedTabScheduledN=$('sched-tab-scheduled-n'), schedTabScheduledAlert=$('sched-tab-alert'),
      schedTabReviews=$('sched-tab-reviews'), schedTabReviewsN=$('sched-tab-reviews-n'),
      schedTabTasks=$('sched-tab-tasks'), schedTabTasksN=$('sched-tab-tasks-n'),
      schedTabSessions=$('sched-tab-sessions'), schedTabSessionsN=$('sched-tab-sessions-n'), schedSessionsAlert=$('sched-sessions-alert'),
      revPane=$('sched-reviews'), revList=$('sched-reviews-list'),
      lightbox=$('lightbox'), lightboxImg=$('lightbox-img'),
      reader=$('reader'), readerName=$('reader-name'), readerGet=$('reader-get'), readerBody=$('reader-body'),
      skillsWin=$('skills'), skillsToggle=$('skills-toggle'), skillsBack=$('skills-back'),
      skillsTitle=$('skills-title'), skillsCount=$('skills-count'), skillsNewBtn=$('skills-new'),
      skillsRefreshBtn=$('skills-refresh'),
      skillsClose=$('skills-close'), skillsBody=$('skills-body'), skillsNote=$('skills-note'),
      skillsListEl=$('skills-list'), skillsDetailEl=$('skills-detail'),
      sbTabTopics=$('sb-tab-topics'), sbTabStarred=$('sb-tab-starred'), sbTabHistory=$('sb-tab-history'), topicsFilterHost=$('topics-filter'),
      historyPane=$('history-pane'), historyCountEl=$('history-count'),
      historyBody=$('history-body'), historyQ=$('history-q'), historyGo=$('history-go'),
      historyErr=$('history-err'), historyListEl=$('history-list'), historyMore=$('history-more'),
      libLog=$('lib-log'), libTitle=$('lib-title'), libNote=$('lib-note'), libWhy=$('lib-why'),
      libTopicBtn=$('lib-topic'), libCloseBtn=$('lib-close'),
      settingsPage=$('settings-page'), settingsBody=$('settings-body'), settingsTopicEl=$('settings-topic'),
      taskPage=$('task-page'), taskTitle=$('task-title'), taskSub=$('task-sub'), taskClose=$('task-close'),
      taskNote=$('task-note'), taskView=$('task-view'),
      settingsClose=$('settings-close'), settingsOpenBtn=$('settings-open'),
      copyRefBtn=$('copy-ref'), killBtn=$('kill-agent'), stopBtn=$('stop-turn'),
      pendingQueueEl=$('pending-queue'), statusEl=$('status'), machineNoteEl=$('machine-note'),
      updateEl=$('update'),
      modelPop=$('model-pop'), mpList=$('mp-list'), mpFilter=$('mp-filter'), mpAgent=$('mp-agent'),
      mpHeading=$('mp-heading'), mpFoot=$('mp-foot');
  // The 30-second tick that keeps the ages current (see paintAges). Declared here, not beside
  // its functions, because paintSessions can arm it while the script is still setting up — and a
  // var initialised after that would overwrite the timer's handle with null and leak the timer.
  initLocale();
  var schedTitleEl = document.querySelector('#schedules-head .panel-title');
  if(schedTitleEl) schedTitleEl.setAttribute('data-i18n', 'sideTasks.title');
  applyDomI18n(document);
  var AGE_TICK_MS=30000, ageTimer=null;
  var data={}, els={}, files=[], commands=[];
  // WIRING
  var BOOT = readBootConfig(document);
  var overlays = new OverlayManager();
  overlays.attach(document);
  var streamClient = createStreamClient({
    getTopic: function(){ return topic; },
    isLoggedOut: function(){ return app.hidden && !gate.hidden; },
    getBuild: function(){ return BUILD; },
    onBeforeConnect: function(){ showSkeleton(); },
    onOpen: function(info){
      var fresh = app.hidden || !info.quiet;
      gate.hidden = true;
      app.hidden = false;
      note.textContent = '';
      if(fresh && !narrow()) input.focus();
      initNotify();
      schedulePrefetch();
      if(fresh && schedPane.isOpen()) schedulesPanel.onStreamOpen();
    },
    onReconnecting: function(){ note.textContent = tr('chat.reconnecting'); },
    onRestarting: function(){ note.textContent = tr('chat.restarting'); },
    onAuthExpired: function(){ app.hidden = true; gate.hidden = false; },
    onBuildOutdated: function(){ updateEl.hidden = false; },
    onVisibilityResume: function(){ schedulePrefetch(); },
  });
  streamClient.onEvent(function(ev){ handle(ev); });
  streamClient.attachWindowEvents(document, window);
  __FH_CACHE_CORE__;
  var cacheService = createCacheService({
    core: {
      STORE: STORE,
      cacheOpen: cacheOpen,
      newer: newer,
      cacheRecord: cacheRecord,
      cachePut: cachePut,
      cacheEvict: cacheEvict,
    },
    getIndexedDB: function(){ return window.indexedDB; },
    getTopic: function(){ return topic; },
    getEpoch: function(){ return epoch; },
    isSynced: function(){ return synced; },
    isStale: function(){ return stale; },
    getLastEventId: function(){ return streamClient.getLastEventId(); },
    collectScreenMessages: function(){ return collectCacheableMessages(log, data); },
  });
  function dbOn(){ return cacheService.isDbAvailable(); }
  function noteVer(id, last, ep){ cacheService.noteVersion(id, last, ep); }
  function put(id, msgs, meta){ return cacheService.put(id, msgs, meta); }
  function memCopy(id){ return cacheService.memCopy(id); }
  function get(id){ return cacheService.get(id); }
  function cachePeek(tId){ return cacheService.peek(tId); }
  function cacheDrop(tId){ cacheService.drop(tId); }
  function cacheKeep(keep){ cacheService.keepOnly(keep); }
  function cacheSave(){ cacheService.scheduleSave(); }
  function leave(){ cacheService.leave(); }
  var readsService = createReadsService({
    getActiveTopic: function(){ return topic; },
    getTopics: function(){ return topics; },
    isOverlayBlocking: function(){ return libOn(); },
    postSeen: function(topicId){ return post('api/seen', { topic: topicId }, 0); },
    onChanged: function(){ paintTopics(); },
  });
  readsService.attachWindowEvents(document, window);
  function unreadOf(t){ return readsService.unreadOf(t); }
  function unseenReply(t){ return readsService.unseenReply(t); }
  function needsRead(t){ return readsService.needsRead(t); }
  function markAllRead(list, noun, say){ return readsService.markAllRead(list, noun, say); }
  function reportSeen(){ readsService.reportSeen(); }
  var settingsFeature = createSettingsFeature({
    settingsPage: settingsPage,
    settingsBody: settingsBody,
    settingsTopicEl: settingsTopicEl,
    settingsClose: settingsClose,
    settingsOpenBtn: settingsOpenBtn,
    instrOk: Boolean(BOOT.instructions),
    getTopic: function(){ return topic; },
    getTopics: function(){ return topics; },
    getEpoch: function(){ return epoch; },
    closeMenus: function(){ setMenu(null, false); },
    instructions: {
      ensure: function(){ instructionsPanel.ensure(); },
      renderOrphans: function(){ return instructionsPanel.renderOrphans(); },
      renderAgent: function(row, index){ return instructionsPanel.renderAgent(row, index); },
    },
  });
  var topicStatus = createTopicStatusController({
    statusEl: statusEl,
    pendingQueueEl: pendingQueueEl,
    modelPopEls: {
      modelPop: modelPop,
      mpList: mpList,
      mpFilter: mpFilter,
      mpAgent: mpAgent,
      mpHeading: mpHeading,
      mpFoot: mpFoot,
      mpClose: $('mp-close'),
    },
    getTopic: function(){ return topic; },
    isSynced: function(){ return synced; },
    hasLauncher: function(){ return transcript.banners.hasLaunch(); },
    hasMessages: function(){ return Boolean(log.querySelector('.m')); },
    narrow: narrow,
    getIcons: function(){ return IC.icon; },
    inl: inl,
    setNote: function(msg){ note.textContent = msg; },
    onRetireLocalNonce: function(nonce){
      var pk = 'p:' + nonce;
      delete outbox[nonce];
      var r = unsent[nonce];
      dropUnsent(nonce);
      if(r) settleAdopted(r.t, r.x);
      if(els[pk]){ els[pk].remove(); delete els[pk]; }
      delete sig[pk];
      delete data[pk];
    },
    onRecallContent: function(content){
      if(!input.value.trim()){
        input.value = content;
        grow();
        stashDraft(topic);
        input.focus();
      }
    },
  });
  topicStatus.attach();
  var legacyShell = createLegacyShell({
    app: app,
    sidebar: sidebar,
    sidebarResize: $('sidebar-resize'),
    collapseBtn: collapseBtn,
    expandBtn: expandBtn,
    schedPanel: schedPanel,
    schedResize: schedResize,
    schedToggle: schedToggle,
    backdrop: backdrop,
    optsBtn: optsBtn,
    optsMenu: optsMenu,
    manageBtn: manageBtn,
    manageMenu: manageMenu,
    calmBtn: calmBtn,
    calmState: calmState,
    themeBtn: themeBtn,
    themeState: themeState,
    langBtn: langBtn,
    langState: langState,
    onSchedPaint: function(){ if(schedulesPanel) paintSchedTab(); },
    onSchedOpen: function(){ schedulesPanel.onPanelOpen(); },
    onSchedClose: function(){ schedulesPanel.disarm(); },
    onCloseSchedules: function(){ setSchedules(false); },
  });
  var sbPane = legacyShell.sbPane;
  var schedPane = legacyShell.schedPane;
  function narrow(){ return legacyShell.narrow(); }
  function setSidebar(open){ legacyShell.setSidebar(open); }
  function setMenu(entry, open){ legacyShell.setMenu(entry, open); }
  function openMenu(){ return legacyShell.openMenu(); }
  function paintCalm(){ legacyShell.paintCalm(); }
  function paintTheme(){ legacyShell.paintTheme(); }
  function paintLang(){ legacyShell.paintLang(); }
  var notifyController = createNotifyController({
    notifyBtn: notifyBtn,
    notifyState: notifyState,
    post: post,
    onCachedMessage: function(tId, last, ep){ cacheService.noteVersion(tId, last, ep); },
    onGotoTopic: function(goId){
      if(goId && goId !== topic && topics.some(function(t){ return t.id === goId; })){
        switchTopic(goId);
        if(narrow()) setSidebar(false);
      }
    },
  });
  function initNotify(){ void notifyController.init(); }
  function paintNotify(){ notifyController.paint(); }
  var terminalController = createTerminalController({
    enabled: Boolean(BOOT.terminal),
    canEnd: Boolean(BOOT.terminalEnd),
    chat: chat,
    chatHead: chatHead,
    composer: composer,
    termBtn: termBtn,
    termHost: termHost,
    termEl: termEl,
    termGrip: termGrip,
    termName: termName,
    termMinBtn: termMinBtn,
    termEndBtn: termEndBtn,
    getTopic: function(){ return topic; },
    getTopicTitle: function(id){
      for(var i=0;i<topics.length;i++){ if(topics[i].id === id) return topics[i].title; }
      return undefined;
    },
    isOverlayCovering: function(){ return libOn(); },
    atBottom: atBottom,
    toBottom: toBottom,
    post: post,
  });
  function urlNow(){ return terminalController.urlNow(); }
  function applyTerm(){ terminalController.apply(); }
  function paintFrames(){ terminalController.paintFrames(); }
  function dropTerm(id){ terminalController.drop(id); }
  var codeView = createCodeViewLoader(BOOT.codeview);
  var lightboxController = createLightbox({ lightbox: lightbox, lightboxImg: lightboxImg });
  function openShot(img){ lightboxController.open(img); }
  function closeShot(){ lightboxController.close(); }
  var readerController = createReader({
    reader: reader,
    readerName: readerName,
    readerGet: readerGet,
    readerBody: readerBody,
    readerClose: $('reader-close'),
    codeView: codeView,
    codeBlocks: codeBlocks,
  });
  function openReader(link){ readerController.open(link); }
  function closeReader(){ readerController.close(); }
  var byteSize = formatByteSize;
  var transcript = createTranscriptController({
    log: log,
    btwBox: $('btw'),
    btwQ: $('btw-q'),
    btwBody: $('btw-body'),
    btwClose: $('btw-close'),
    machineNoteEl: machineNoteEl,
    forkNote: forkNote,
    getExtraCodeRoots: function(){ return [libLog, readerBody, filesPanel.previewEl()]; },
    getData: function(){ return data; },
    getEls: function(){ return els; },
    getTopic: function(){ return topic; },
    getTopics: function(){ return topics; },
    topicById: topicById,
    getEpoch: function(){ return epoch; },
    isSynced: function(){ return synced; },
    isStale: function(){ return stale; },
    isEntering: function(){ return entering; },
    getLaunch: function(){ return launch; },
    keyOf: keyOf,
    isHistory: isHistory,
    getIcons: function(){ return IC; },
    formatStatusClock: stClock,
    codeView: codeView,
    copyText: copyText,
    hasOutbox: function(nonce){ return Boolean(outbox[nonce]); },
    claim: claim,
    adoptLegacy: adoptLegacy,
    showUnsent: showUnsent,
    cacheSave: cacheSave,
    getHistoryMessage: function(k){ return historyPanel.getMessage(k); },
    repaintHistoryMessage: function(k){ historyPanel.repaintMessage(k); },
    paintTopics: paintTopics,
    paintStatus: paintStatus,
    switchTopic: switchTopic,
    isNarrow: narrow,
    setSidebar: setSidebar,
    openShot: openShot,
    sendCommand: command,
    openReader: openReader,
    deliverLocal: deliver,
    copyLocal: copyLocal,
    discardLocal: discardLocal,
  });
  transcript.attachEvents(document);
  function atBottom(){ return transcript.scroll.atBottom(); }
  function toBottom(){ transcript.scroll.toBottom(); }
  function firstVisible(){ return transcript.scroll.firstVisible(); }
  function saveView(id){ transcript.scroll.saveView(id, entering); }
  function land(){ transcript.scroll.land(els); }
  function paint(key, before){ transcript.paint(key, before); }
  function codeBlocks(root){ transcript.codeBlocks.enhance(root); }
  function hlSweep(){ transcript.codeBlocks.sweep(); }
  function btwAsked(key, m){ return transcript.btwAsked(key, m); }
  function openBtw(qk){ transcript.btw.open(qk); }
  function closeBtw(byHand){ transcript.btw.close(byHand); }
  function renderBtw(top){ transcript.btw.render(top); }
  function btwArrived(m){ transcript.btw.onArrived(m); }
  function msgMarkup(key, m, hist){ return transcript.msgMarkup(key, m, hist); }
  function toggleAll(key){ transcript.toggleAll(key); }
  function toggleLine(line){ transcript.toggleLine(line); }
  function repaintKey(key){ transcript.repaintKey(key); }
  function upsert(m){ transcript.upsert(m); }
  function drop(key){ transcript.drop(key); }
  function reconcile(list){ transcript.reconcile(list); }
  function sinkLocals(){ transcript.sinkLocals(); }
  function showSkeleton(){ transcript.banners.showSkeleton(); }
  function clearSkeleton(){ transcript.banners.clearSkeleton(); }
  function syncEmptyNote(){ transcript.banners.syncEmptyNote(); }
  function syncLaunch(want){ transcript.banners.syncLaunch(want); }
  function takeMachines(list){ return transcript.takeMachines(list); }
  function setMachines(list){ transcript.setMachines(list); }
  function offSince(name){ return transcript.banners.offSince(name); }
  function offWhen(at){ return transcript.banners.offWhen(at); }
  function offTitle(name){ return transcript.banners.offTitle(name); }
  function paintMachineNote(){ transcript.banners.paintMachineNote(); }
  function paintForkNote(cur){ transcript.banners.paintForkNote(cur); }
  function placeDivider(){ transcript.banners.placeDivider(); }
  function showSyncing(){ transcript.banners.showSyncing(); }
  function clearSyncing(){ transcript.banners.clearSyncing(); }
  function repaintHistory(){ transcript.repaintHistory(); }
  function adopt(list, current){ transcript.adopt(list, current); }
  function postButton(b, t){ transcript.postButton(b, t); }
  // END WIRING
  // Panels instantiated before makePanel(), which calls paintSchedTab() synchronously on setup.
  var reviewsPanel = createReviewsPanel({
    app: app,
    revList: revList,
    text: text,
    schedAgo: schedAgo,
    post: post,
    showNote: showSchedNote,
    paintCounts: paintSchedCounts,
    paintSummary: paintSummary,
    topicExists: topicExists,
    switchTopic: switchTopic,
    createTopic: createTopic,
    beforeSkillArchive: function(){ skillsPanel.beforeExternalWrite(); },
    afterSkillArchive: function(refreshPending){ skillsPanel.afterExternalWrite(refreshPending); },
  });
  var historyPanel = createHistoryPanel({
    sidebar: sidebar,
    bar: bar,
    topicsFilterHost: topicsFilterHost,
    sbTabTopics: sbTabTopics,
    sbTabStarred: sbTabStarred,
    sbTabHistory: sbTabHistory,
    historyPane: historyPane,
    historyCountEl: historyCountEl,
    historyBody: historyBody,
    historyQ: historyQ,
    historyGo: historyGo,
    historyErr: historyErr,
    historyListEl: historyListEl,
    historyMore: historyMore,
    chat: chat,
    log: log,
    hints: hints,
    libLog: libLog,
    libTitle: libTitle,
    libNote: libNote,
    libWhy: libWhy,
    libTopicBtn: libTopicBtn,
    libCloseBtn: libCloseBtn,
    text: text,
    atBottom: atBottom,
    firstVisible: firstVisible,
    toBottom: toBottom,
    getLogEl: function(key){ return els[key]; },
    closeModelPop: function(){ topicStatus.closeModelPop(); },
    paintFrames: paintFrames,
    paintTermHeightIfOpen: function(){ terminalController.paintHeightIfOpen(); },
    reportSeen: reportSeen,
    topicExists: topicExists,
    switchTopic: switchTopic,
    narrow: narrow,
    setSidebar: setSidebar,
    msgMarkup: msgMarkup,
    codeBlocks: codeBlocks,
    forgetOpenedPrefix: function(prefix){
      transcript.forgetOpenedPrefix(prefix);
    },
    openShot: openShot,
    toggleAll: toggleAll,
    toggleLine: toggleLine,
    icons: function(){ return IC.icon; },
    copyText: copyText,
    onLibStateChange: syncCopyRef,
    onTopicTabChange: function(){ paintTopics(); },
  });
  var schedulesPanel = createSchedulesPanel({
    app: app,
    schedToggle: schedToggle,
    schedAlert: schedAlert,
    schedList: schedList,
    schedSummary: schedSummary,
    schedReadBtn: schedReadBtn,
    schedFilterHost: schedFilterHost,
    schedNewBtn: schedNewBtn,
    schedClose: schedClose,
    schedNote: schedNote,
    schedSessionList: schedSessionList,
    schedSubnav: schedSubnav,
    schedTabScheduled: schedTabScheduled,
    schedTabScheduledN: schedTabScheduledN,
    schedTabScheduledAlert: schedTabScheduledAlert,
    schedTabReviews: schedTabReviews,
    schedTabReviewsN: schedTabReviewsN,
    schedTabTasks: schedTabTasks,
    schedTabTasksN: schedTabTasksN,
    schedTabSessions: schedTabSessions,
    schedTabSessionsN: schedTabSessionsN,
    schedSessionsAlert: schedSessionsAlert,
    revPane: revPane,
    rowMenu: rowMenu,
    taskPage: taskPage,
    taskTitle: taskTitle,
    taskSub: taskSub,
    taskClose: taskClose,
    taskNote: taskNote,
    taskView: taskView,
    icons: function(){ return IC.icon; },
    getTopics: function(){ return topics; },
    getTopic: function(){ return topic; },
    topicById: topicById,
    runOwners: runOwners,
    rowRunning: rowRunning,
    unreadOf: unreadOf,
    needsRead: needsRead,
    topicTree: topicTree,
    treeWalker: treeWalker,
    treeRowHtml: treeRowHtml,
    rowHtml: rowHtml,
    agentTagHtml: agentTagHtml,
    splitTitle: splitTitle,
    text: text,
    schedAgo: schedAgo,
    ageClock: ageClock,
    ageText: ageText,
    stLeft: stLeft,
    atBottom: atBottom,
    toBottom: toBottom,
    armAgeTick: armAgeTick,
    markAllRead: markAllRead,
    switchTopic: switchTopic,
    foldClick: foldClick,
    rowMenuFollow: rowMenuFollow,
    closeRowMenu: closeRowMenu,
    getRowMenuKey: function(){ return rowMenuKey; },
    openRowMenuFor: openRowMenuFor,
    makeFilterBar: makeFilterBar,
    paneIsOpen: function(){ return schedPane.isOpen(); },
    paneDocked: function(){ return schedPane.docked(); },
    paneSetOpen: function(open, opts){ schedPane.setOpen(open, opts); },
    reviewsCount: function(){ return reviewsPanel.count(); },
    loadReviews: loadReviews,
    paintReviews: paintReviews,
  });
  var skillsPanel = createSkillsPanel({
    app: app,
    skillsWin: skillsWin,
    skillsToggle: skillsToggle,
    skillsBack: skillsBack,
    skillsTitle: skillsTitle,
    skillsCount: skillsCount,
    skillsNewBtn: skillsNewBtn,
    skillsRefreshBtn: skillsRefreshBtn,
    skillsClose: skillsClose,
    skillsBody: skillsBody,
    skillsNote: skillsNote,
    skillsListEl: skillsListEl,
    skillsDetailEl: skillsDetailEl,
    icons: function(){ return IC.icon; },
    text: text,
    schedAgo: schedAgo,
    byteSize: byteSize,
    copyText: copyText,
    post: post,
    closeMenus: function(){ setMenu(null, false); },
  });
  // The row menu: which row it belongs to (a key like "topic:<id>", "sess:<id>", "task:<id>"),
  // the button that opened it, and what a pick calls. The button is re-found after every repaint
  // (rowMenuFollow), because the row it lives in is replaced while the menu stays open.
  var rowMenuKey=null, rowMenuBtn=null, rowMenuPick=null;
  // Whether the next sync is the one that opens a topic.
  var entering=true;
  // What the last sync said about this topic being older than the daemon.
  var stale=false;
  // Which run of the daemon the live stream belongs to, and whether this topic's first sync has
  // landed. 0 until one has: every message below is qualified by the generation it came from,
  // and before the first sync the only generations known are the ones out of the cache.
  var epoch=0, synced=false;
  var topic = new URLSearchParams(location.search).get('t') || '';
  // Whether this daemon serves a terminal at all, and whether it was given a way to END one (a
  // configured terminal.endCommand). Without that, the window has no close button rather than a
  // close button that cannot work.
  // The icons (icons.ts): every one by name, and the menu marks and lifecycle reactions the page
  // draws as icons, keyed by the glyph core and config write. Anything not in a table stays text.
  var IC = __FH_ICONS__;
  var TERM_OK = BOOT.terminal;
  var INSTANCE_ID = BOOT.instance || 'web';
  // Whether this daemon has the file window (platforms.<id>.files.enabled). False hides the
  // header button; the routes behind it answer 404, exactly as the terminal's do.
  var FILES_OK = BOOT.files;
  // Whether the settings page offers the instruction editor (platforms.<id>.instructions.enabled).
  // False leaves the section out; its routes answer 404 like the file window's.
  var INSTR_OK = BOOT.instructions;
  var gitPanel = createGitPanel({
    getTopic: function(){ return topic; },
    input: input,
    text: text,
    schedAgo: schedAgo,
    narrow: narrow,
    codeView: codeView,
    closeMenus: function(){ setMenu(null, false); },
  });
  var filesPanel = createFilesPanel({
    filesOk: Boolean(FILES_OK),
    instrOk: Boolean(INSTR_OK),
    getTopic: function(){ return topic; },
    text: text,
    post: post,
    codeView: codeView,
    codeBlocks: codeBlocks,
    closeMenus: function(){ setMenu(null, false); },
  });
  var instructionsPanel = createInstructionsPanel({
    instrOk: Boolean(INSTR_OK),
    settingsPage: settingsPage,
    settingsBody: settingsBody,
    filesPanel: filesPanel,
    getSettingsMsg: function(){ return settingsFeature.getMessage(); },
    getSettingsTopic: function(){ return settingsFeature.getTopic() || ''; },
    getTopic: function(){ return topic; },
    renderSettings: function(){ settingsFeature.render(); },
    text: text,
    inl: inl,
    post: post,
  });
  // Which page this is: a hash of everything it was rendered from, and the page's ETag (servePage).
  // Compared with the daemon's after a restart (checkBuild), since the script on screen is the one
  // the old process served.
  var BUILD = BOOT.build;
  // Whether the shared secret is still a way in. False means the gate above has no field and
  // the only thing that can sign anyone in is the proxy in front (sso.password: false).
  var PASSWORD_LOGIN = BOOT.password;
  var topics = [];
  paintSchedTab();

  /**
   * Parents whose sub-agent topics are folded away (paintTopics), per browser. Folded by default:
   * a /super job's children are the working detail behind one conversation, and a dispatcher that
   * opens five of them would otherwise push five rows into a column read as a list of conversations.
   * An entry of false is an operator who opened one, and it stays open on this browser.
   */
  var folded = {};
  try { folded = JSON.parse(localStorage.getItem('aa_folded') || '{}') || {}; } catch(x){}
  function saveFolded(){
    try { localStorage.setItem('aa_folded', JSON.stringify(folded)); } catch(x){}
  }

  /**
   * How a message is identified ON THIS PAGE, which is deliberately not its server id.
   *
   * Server ids are 'w1', 'w2'..., counted per PROCESS — so a restarted daemon hands the same
   * ones out again, and this page keeps transcripts across restarts. Keyed by id alone, the
   * first reply after a restart silently overwrites a cached message from before it. The
   * generation — a sync's epoch field — is what tells the two apart. A message typed here and
   * not yet acknowledged has no server id at all and travels under its nonce instead, behind a
   * prefix no server id can collide with.
   */
  function keyOf(m){ return m._local ? m.id : m._g + ':' + m.id; }

  /** A cached message from a daemon that is no longer the one on the other end of the stream. */
  function isHistory(m){ return Boolean(m) && !m._local && epoch !== 0 && m._g !== epoch; }

  function schedAgo(at){
    if(!at) return '';
    var s=Math.max(0, Math.round((Date.now()-at)/1000));
    if(s<60) return tr('age.secAgo', { n: s });
    if(s<3600) return tr('age.minAgo', { n: Math.round(s/60) });
    if(s<86400) return tr('age.hourAgo', { n: Math.round(s/3600) });
    return tr('age.dayAgo', { n: Math.round(s/86400) });
  }

  /**
   * How long a span lasted, in the one format every age on this page uses: under a minute is
   * "<1m", under an hour Nm, under a day Nh (no minutes — "23h" is as precise as a row needs),
   * then Nd, or NdNh when the hours are not zero ("1d10h").
   *
   * Rounded down, so a row never claims a minute it has not reached. A negative span — the
   * server's clock ahead of this browser's — counts as zero rather than rendering "-1m".
   */
  function durText(ms){
    var m=Math.floor(Math.max(0, ms)/60000);
    if(m<1) return '<1m';
    if(m<60) return m+'m';
    var h=Math.floor(m/60);
    if(h<24) return h+'h';
    var d=Math.floor(h/24), rh=h%24;
    return d+'d'+(rh?rh+'h':'');
  }

  /** A span as an age: the same units, with " ago" only for something that has ended. */
  function ageText(ms, done){
    var d = durText(ms);
    return done ? tr('age.ago', { dur: d }) : d;
  }

  /** HH:MM, with the date in front when it was not today — the tooltip's "started/ended at". */
  function ageClock(at){
    var d=new Date(at), now=new Date();
    var hm=(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes();
    if(d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate()) return hm;
    var mn=tr(MONTH_KEYS[d.getMonth()]);
    var day=(getLocale()==='zh-CN'?mn:mn.slice(0,3))+' '+d.getDate();
    return (d.getFullYear()===now.getFullYear()?day:day+', '+d.getFullYear())+' '+hm;
  }

  /**
   * One walk of a topic's subtree: whether anything under it is working, and the earliest start
   * among the ones that are — 0 when none carries one.
   *
   * A /super dispatcher's own turn ends between jobs while its sub-agents keep working, and
   * rowRunning draws it as running; its age has to be the job's, not a start it does not have.
   * Earliest, because that is when the work the row is standing for began. Both answers come out
   * of the same walk, so painting one row does not walk its subtree twice for them.
   */
  function subtreeRun(id){
    var busy=false, since=0, stack=[id], seenB={}, n=0;
    while(stack.length && n++<256){
      var p=stack.pop();
      if(seenB[p]) continue;
      seenB[p]=true;
      for(var i=0;i<topics.length;i++){
        var t=topics[i];
        if(t.parent!==p) continue;
        if(t.running){
          busy=true;
          if(t.runningSince && (!since || t.runningSince<since)) since=t.runningSince;
        }
        stack.push(t.id);
      }
    }
    return {busy:busy, since:since};
  }

  /**
   * What a row's age counts from, and whether it is still running: its own start while it works
   * (or the earliest start below a dispatcher), else when its last turn ended — the outcome's
   * own timestamp, or the last message when the daemon sent no outcome. Null when there is
   * nothing to count: a topic nothing has been said in yet, or a running one from a daemon
   * older than runningSince.
   */
  function topicAge(t){
    if(t.running) return t.runningSince ? {at:t.runningSince, run:true} : null;
    // A dispatcher is drawn as running while its sub-agents work, so it has no "ended" to count
    // from: with no start anywhere below (a daemon older than runningSince) it shows nothing.
    var below=subtreeRun(t.id);
    if(below.busy) return below.since ? {at:below.since, run:true} : null;
    var at=(t.outcome && t.outcome.at) ? t.outcome.at : (t.msgCount ? t.lastAt : 0);
    return at ? {at:at, run:false} : null;
  }

  /**
   * The age element of a row, stamped so the 30-second tick can rewrite it without repainting
   * the list (see paintAges): data-age is the instant counted from, data-age-run says which
   * wording it takes.
   */
  function ageHtml(t){
    var a=topicAge(t);
    if(!a) return '';
    return '<span class="topic-age'+(a.run?' run':'')+'" data-age="'+text(a.at)+'"'
      + ' data-age-run="'+(a.run?'1':'0')+'"'
      + ' title="'+text(tr(a.run?'age.started':'age.ended', { when: ageClock(a.at) }))+'">'
      + text(ageText(Date.now()-a.at, !a.run))+'</span>';
  }

  var MONTH_KEYS=['age.month0','age.month1','age.month2','age.month3','age.month4','age.month5','age.month6','age.month7','age.month8','age.month9','age.month10','age.month11'];

  /**
   * One row of any list: a state dot, a title, a quiet second line, an optional badge and mark,
   * and the ⋯ that opens the row's menu.
   *
   * The topic list, a scheduled task and a scheduled run all draw this, because they are the
   * same thing to read: what is it, what is it doing, and one control. The callers own what goes
   * in each slot; this owns the shape, and the key that ties the row to an open menu across the
   * innerHTML repaint every one of these lists does.
   *
   * The "time" slot is the right end of that second line, for the one row that carries a clock.
   * It is a slot of its own rather than part of "sub" because it must not be ellipsised with it.
   * The "legend" slot is a topic row's agent name on its frame (agentTagHtml); it is positioned
   * out of the flex row, so it is first only to be painted under the row's controls, never over.
   */
  function rowHtml(o){
    var key=o.key||'';
    var more='<button type="button" class="btn-icon topic-more" data-rm="'+text(key)+'"'
      + ' aria-haspopup="menu" aria-expanded="'+(rowMenuKey===key?'true':'false')+'"'
      + ' title="'+text(o.moreTitle||tr('topic.rowActions'))+'" aria-label="'+text(o.moreTitle||tr('topic.rowActions'))+'">'+IC.icon.more+'</button>';
    var sub=(o.sub||o.time)?'<span class="topic-sub">'+(o.sub||'')+(o.time||'')+'</span>':'';
    return '<div class="topic-item'+(o.cls?' '+o.cls:'')+'"'+o.attrs+'>'
      + (o.legend||'')
      + '<span class="'+(o.dot||'topic-dot')+'"></span>'
      + '<span class="topic-main">'+(o.title||'')+sub+'</span>'
      + (o.badge||'')
      + '<span class="topic-acts">'+(o.mark||'')+more+'</span>'
      + '</div>';
  }

  /**
   * One topic's row, in whichever list draws it: the switcher, and the Sessions tab — a scheduled
   * run and the sub-agents under it. row is a treeWalker row, so the depth, the fold pill and what
   * it hides come with it; the list decides the rest:
   *   attr     the attribute its click handler reads the id from (data-topic, data-sess)
   *   menu     the prefix of the ⋯'s key, which openRowMenuFor routes on (topic, sess)
   *   cls/tail classes before / after the depth ones (after-needs, needs)
   *   attrs    more attributes for the row
   *   sub/time in place of the directory line and the age: a run's own row says when it ran, how
   *            many messages and in what state instead
   * Everything else — the agent legend, the dot, the title, the badge, the terminal and star marks —
   * is one answer for every list, so a topic looks the same wherever it is found.
   */
  function treeRowHtml(row, o){
    var t=row.t;
    var isCur=(t.id===topic);
    var isRunning=rowRunning(t);
    // A question on screen holds its turn open, so t.running is true at the same time. Asked
    // first everywhere below: "waiting for you" is the state you can act on, and the one the
    // running blue would otherwise hide.
    var isAsking=Boolean(t.asking);
    var isLive=Boolean(t.live);
    var unread=unreadOf(t);
    var cls=(isCur?'on ':'')+(isRunning?'running':'idle')+(isLive?' live':'')
      +(t.starred?' starred':'')+' framed'+(o.cls||'')
      +(row.depth?' sub d'+Math.min(row.depth,3):'')
      +(o.tail||'');
    var isFailed=t.stage==='failed';
    // A sub-agent's finished turn is news for the agent that opened it, not for the person
    // (needsYou says the same): its row keeps the ordinary idle/online grey instead of the
    // green "unread reply" dot, and the parent turns green when the report is waiting to be
    // read. Work and a question are still its own — blue and amber — because both are states a
    // person acts on, or watches, in that topic.
    var dotCls='topic-dot'+(isAsking?' asking':(isRunning?' running':(isFailed?' failed':(t.stage==='review'&&!t.parent?' review':(isLive?' live':'')))));
    var badge=unread>0?'<span class="topic-badge">'+(unread>99?'99+':unread)+'</span>':'';
    // Not "a shell is alive over there" — the daemon only sees the connection, so this says a
    // page has that topic's terminal open (shown or minimized). See terminal-sessions.ts.
    var term=t.term?'<span class="topic-term" title="'+text(tr('topic.termAttached'))+'">&gt;_</span>':'';
    var line=o.sub!==undefined ? o.sub : topicDirHtml(t);
    // The subject alone: who answers is the legend on the row's frame, not the "[cc] " the stored
    // name opens with (which the chat platforms still need, and which a later /agent leaves stale).
    var title='<span class="topic-title">'
       + forkMarkHtml(t)
       + text(splitTitle(t.title || tr('common.untitled')).rest)+'</span>';
    // A lit star on a starred row is a marker, not a button: Star/Unstar lives in the menu now.
    var starMark=t.starred
      ? '<span class="topic-star-mark" title="'+text(tr('topic.starredTitle'))+'" aria-hidden="true">'+IC.icon.star+'</span>'
      : '';
    // Its own button, like the star: folding a parent is not a reason to switch to it.
    var fold=row.kids?'<button type="button" class="topic-fold'+(row.shut?' folded':'')+(row.under?' '+row.under:'')+'"'
       + ' data-fold="'+text(t.id)+'" aria-expanded="'+(row.shut?'false':'true')+'"'
       + ' title="'+text(tr(row.shut?(row.kids>1?'topic.foldShowPlural':'topic.foldShow'):(row.kids>1?'topic.foldHidePlural':'topic.foldHide'), { count: row.kids }))+'">'
       + (row.shut?IC.icon.chevronRight:IC.icon.chevronDown)+' '+row.kids+'</button>':'';
    return rowHtml({
      cls:cls,
      attrs:' '+o.attr+'="'+text(t.id)+'" role="button" tabindex="0"'+(o.attrs||''),
      key:o.menu+':'+t.id,
      legend:agentTagHtml(t),
      dot:dotCls,
      title:title,
      sub:fold ? '<span class="topic-line">'+fold+line+'</span>' : line,
      time:o.time!==undefined ? o.time : ageHtml(t),
      badge:term+badge,
      mark:starMark,
      moreTitle:o.moreTitle
    });
  }

  /**
   * The mark a forked topic's row leads with (Topic.forkOf), saying where it came from on hover; empty
   * for every other row. The source is named as the list shows it, so the hover and the row above
   * read the same.
   */
  function forkMarkHtml(t){
    if(!t.forkOf) return '';
    return '<span class="topic-fork-mark" title="'+text(forkFromText(t))+'">'+IC.icon.fork+'</span>';
  }
  /** "Forked from <source> · turn N", for a fork's mark and the line at the top of its page. */
  function forkFromText(t){
    var src=topicById(t.forkOf);
    var source = src ? (src.title || tr('common.untitled')) : tr('topic.anotherTopic');
    return t.forkTurn ? tr('topic.forkedFromTurn', { source: source, turn: t.forkTurn }) : tr('topic.forkedFrom', { source: source });
  }

  /**
   * Where a topic works, as its row's second line says it: the machine, then the directory's name.
   *
   * The full path on the title attribute rather than in the row: two checkouts of one project have
   * the same last segment, and the column is 240px wide. The machine goes first: it is the short
   * word, and the one that tells apart two agents of one harness on two hosts — whose directories
   * usually share a name too — so it is what the ellipsis spares. An offline machine keeps its name
   * and gains a mark: the line still says where the topic is.
   */
  function topicDirHtml(t){
    if(!t.dir) return '';
    var offAt=t.dir.host?offSince(t.dir.host):0;
    var where=t.dir.host
      ? (offAt ? '<span class="topic-off" title="'+text(offTitle(t.dir.host))+'">'+IC.icon.offline+text(t.dir.host)+'</span> · ' : text(t.dir.host+' · '))
      : '';
    return '<span class="topic-dir" title="'+text((t.dir.host?t.dir.host+':':'')+t.dir.path)+'">'+where+text(t.dir.name)+'</span>';
  }

  // ── Reviews (client/panels/reviews.ts) ─────────────────────────────────────
  function loadReviews(){ reviewsPanel.load(); }
  function paintReviews(){ reviewsPanel.paint(); }
  function settleAdopted(id, typed){ reviewsPanel.settleAdopted(id, typed); }

  function topicExists(id){
    for(var i=0;i<topics.length;i++) if(topics[i].id === id) return true;
    return false;
  }

  // ── Schedules (client/panels/schedules.ts) ──────────────────────────────────
  function paintSchedCounts(){ schedulesPanel.paintCounts(); }
  function paintSummary(){ schedulesPanel.paintSummary(); }
  function paintSchedTab(){ schedulesPanel.paintTab(); }
  function setSchedules(open, transient){ schedulesPanel.setOpen(open, transient); }
  function showSchedNote(msg){ schedulesPanel.showNote(msg); }
  function schedTask(id){ return schedulesPanel.getTask(id); }
  function schedOp(id, action, btn, tags, clearDraft){ schedulesPanel.op(id, action, btn, tags, clearDraft); }
  function openTaskPage(id, edit){ schedulesPanel.openTaskPage(id, edit); }
  function closeTaskPage(force){ return schedulesPanel.closeTaskPage(force); }
  schedulesPanel.init();

  /**
   * A send that carries files, as bytes rather than JSON: a 4-byte big-endian length, the send as
   * JSON with each file's base64 data replaced by its size, then the files' bytes (server.ts
   * readFramedSend). Base64 in JSON is a third larger than the file, and on the uplinks this page
   * is used over that third is the difference between 33 and 44 seconds for one photo. Built as one
   * Uint8Array from strings — atob, and UTF-8 through encodeURIComponent — so it needs nothing a
   * browser might lack, and the same array is sent again by a retry.
   */
  function framed(body){
    var meta = {topic:body.topic, text:body.text, files:[]}, parts = [], total = 0, i, j;
    if(body.nonce) meta.nonce = body.nonce;
    if(body.quiet) meta.quiet = true;
    for(i=0;i<body.files.length;i++){
      var f = body.files[i], bin = atob(f.data);
      meta.files.push({name:f.name, mime:f.mime || '', size:bin.length});
      parts.push(bin);
      total += bin.length;
    }
    var head = unescape(encodeURIComponent(JSON.stringify(meta)));
    var out = new Uint8Array(4 + head.length + total), at = 4;
    out[0] = (head.length >>> 24) & 255; out[1] = (head.length >>> 16) & 255;
    out[2] = (head.length >>> 8) & 255; out[3] = head.length & 255;
    for(j=0;j<head.length;j++) out[at++] = head.charCodeAt(j);
    for(i=0;i<parts.length;i++){
      var p = parts[i];
      for(j=0;j<p.length;j++) out[at++] = p.charCodeAt(j);
    }
    return out;
  }


  /**
   * The scheduled run each topic belongs to, by id: a run is its own, and a topic its agent opened —
   * or one opened under that, any depth — is the run's. A topic in no run has no entry.
   *
   * The two lists split the topics on this: the switcher (topicForest) draws what is in no run, and
   * the Sessions tab (paintSessions) draws every run with the topics under it. Before this, a
   * sub-agent a scheduled run opened was not a run itself, so the switcher drew it — as a root,
   * because its parent was not in that list — while the run it belonged to sat in the panel
   * (reported 2026-11-13). A parent chain that loops, or runs past 32, belongs to no run.
   */
  function runOwners(){
    var byId={}, out={}, i;
    for(i=0;i<topics.length;i++) byId[topics[i].id]=topics[i];
    for(i=0;i<topics.length;i++){
      var t=topics[i], hops=0;
      while(t && hops++<32){
        if(t.scheduled){ out[topics[i].id]=t.id; break; }
        if(!t.parent || t.parent===t.id) break;
        t=byId[t.parent];
      }
    }
    return out;
  }

  /**
   * A list's tree: each topic under the one its agent opened it from (Topic.parent), when that one
   * is in the same list, and a root otherwise. visible keeps the list's order — the daemon's, most
   * recently active first — and so does each topic's kids.
   */
  function topicTree(list){
    var byId={}, kids={}, forks={}, roots=[], i;
    for(i=0;i<list.length;i++) byId[list[i].id]=list[i];
    for(i=0;i<list.length;i++){
      var p=list[i].parent, f=list[i].forkOf;
      if(p && p!==list[i].id && byId[p]) (kids[p]=kids[p]||[]).push(list[i]);
      // A fork (Topic.forkOf) is drawn right after its source, at its depth — beside it, not under
      // it: it is the person's own conversation, which no agent opened. A root when its source is
      // not in this list (a scheduled run's, or one the filter left out).
      else if(f && f!==list[i].id && byId[f]) (forks[f]=forks[f]||[]).push(list[i]);
      else roots.push(list[i]);
    }
    return {visible:list, byId:byId, kids:kids, forks:forks, roots:roots};
  }

  /** Who a row hangs off in the drawn list: its parent, else the source it was forked from. */
  function hangsOff(t, byId){
    if(t.parent && byId[t.parent]) return t.parent;
    if(t.forkOf && byId[t.forkOf]) return t.forkOf;
    return null;
  }

  /**
   * A tree's rows, depth-first: walk(t) adds t and, unless it is folded, the topics its agent
   * opened under it, a level deeper. The one way a sub-agent is nested, in both lists that draw
   * one: the switcher (topicRows) and the Sessions tab (paintSessions), which choose the roots and
   * their order and leave the rest to this.
   *
   * folded is per browser and keyed by the parent's id, so a run folds the same way a topic does.
   * The topic on screen is never folded away: its ancestors are drawn open, without that being
   * saved, so a link into a sub-agent's topic lands on a row you can see. A folded row carries
   * under, the most pressing state among the topics it hides, for the pill's colour.
   *
   * rest(keep) adds whatever no walk reached and no fold hides — only a parent field that loops
   * (a hand-edited file) leaves one: with no root to start from, the first topic of the loop in the
   * list's order is drawn as one and the rest under it, rather than lost. keep, when given, limits
   * it to those ids.
   */
  function treeWalker(tree){
    var byId=tree.byId, kids=tree.kids, forks=tree.forks||{};
    // Up through sources as well as parents: a fork is drawn where its source is, so the topic on
    // screen being a fork of a sub-agent's topic still opens the parent that topic is under.
    var open={}, up=byId[topic], hops=0, next;
    while(up && (next=hangsOff(up, byId)) && hops++<32){ if(up.parent===next) open[next]=true; up=byId[next]; }
    var rows=[], seen={};
    function state(t, depth){
      var ch=kids[t.id]||[], s='';
      for(var k=0;k<ch.length && depth<32;k++){
        var c=ch[k];
        var mine=c.asking?'asking':(c.stage==='failed'?'failed':(c.running?'running':''));
        var deeper=state(c, depth+1);
        var pick=[mine, deeper, s];
        s=pick.indexOf('asking')>=0?'asking':(pick.indexOf('failed')>=0?'failed':(pick.indexOf('running')>=0?'running':''));
      }
      return s;
    }
    function walk(t, depth){
      if(seen[t.id]) return;
      seen[t.id]=true;
      var ch=kids[t.id]||[];
      var shut=ch.length>0 && folded[t.id]!==false && !open[t.id];
      rows.push({t:t, depth:depth, kids:ch.length, shut:shut, under:shut?state(t, 0):''});
      if(!shut) for(var k=0;k<ch.length;k++) walk(ch[k], depth+1);
      // Its forks after it and everything under it, at its own depth, whether or not it is folded:
      // folding hides what its agent opened, and a fork is not that.
      var fk=forks[t.id]||[];
      for(var j=0;j<fk.length;j++) walk(fk[j], depth);
    }
    function rest(keep){
      var list=tree.visible;
      for(var i=0;i<list.length;i++){
        if(keep && !keep[list[i].id]) continue;
        // Hidden under a folded parent is seen-by-design; only a loop leaves one unseen.
        var hidden=false, a=list[i], n=0, by;
        while(a && (by=hangsOff(a, byId)) && n++<32){
          if(a.parent===by && seen[by] && folded[by]!==false && !open[by]){ hidden=true; break; }
          a=byId[by];
        }
        if(!seen[list[i].id] && !hidden) walk(list[i], 0);
      }
    }
    return {rows:rows, walk:walk, rest:rest};
  }

  /**
   * The list's tree and its conversations, built from the topics in hand. A conversation is a
   * root and everything its agent opened under it — the unit the filter keeps or drops whole
   * (topicRows) and the unit the chips count (topicFilterGroups), so one tree is one result in
   * both places. A parent that loops (only a hand-edited file could) gives the loop no root, so
   * the first topic of it met in the list starts the conversation and the rest hang under it the
   * way the walk reaches them — a two-topic loop is drawn as the first root with the second folded
   * under it, and the conversation is exactly that pair. Scheduled runs are conversations, but not
   * ones the person opened: the panel's Sessions tab is where they live, with the sub-agents they
   * opened (runOwners), and leaving them out here also keeps their unread badges and "needs you"
   * rows out of the switcher.
   *
   * Each conversation carries what the filter decides on: its most pressing state, whether any
   * topic in it is starred, and every agent and host it touches. State and star are whole-tree
   * properties, so the four state chips partition the conversations; agents and hosts are a
   * union, because a root and a sub-agent may well run on different ones.
   */
  function topicForest(){
    var runs=runOwners(), list=[], i;
    for(i=0;i<topics.length;i++) if(!runs[topics[i].id]) list.push(topics[i]);
    var tree=topicTree(list), visible=tree.visible, kids=tree.kids, roots=tree.roots;
    var convs={}, convOrder=[], seenC={};
    function mark(t, id){
      if(seenC[t.id]) return;
      seenC[t.id]=true;
      var c=convs[id], rank=stateRank(t);
      c.members.push(t);
      if(rank<c.rank) c.rank=rank;
      if(t.starred) c.starred=true;
      // By the legend's own words, so a chip names an agent the way the rows do.
      var agent=agentOf(t);
      if(agent) c.agents[agent.label]=true;
      c.hosts[t.dir && t.dir.host ? t.dir.host : '__local']=true;
      // A fork belongs to its source's conversation here, as it is drawn beside it: a filter that
      // keeps the source keeps the forks next to it.
      var ch=(kids[t.id]||[]).concat(tree.forks[t.id]||[]);
      for(var k=0;k<ch.length;k++) mark(ch[k], id);
    }
    function start(t){
      if(seenC[t.id]) return;
      convs[t.id]={members:[], rank:3, starred:false, agents:{}, hosts:{}};
      convOrder.push(t.id);
      mark(t, t.id);
    }
    for(i=0;i<roots.length;i++) start(roots[i]);
    for(i=0;i<visible.length;i++) start(visible[i]);
    tree.convs=convs;
    tree.convOrder=convOrder;
    return tree;
  }

  function tabForest(full, tab){
    var isStarredTab = tab === 'starred';
    var convs={}, convOrder=[], keepId={}, byId={}, i, m;
    for(i=0;i<full.convOrder.length;i++){
      var cid = full.convOrder[i];
      var c = full.convs[cid];
      if(isStarredTab ? !c.starred : (c.starred && c.rank >= 3)) continue;
      convs[cid] = c;
      convOrder.push(cid);
      for(m=0;m<c.members.length;m++){
        keepId[c.members[m].id] = true;
        byId[c.members[m].id] = c.members[m];
      }
    }
    return {
      visible: full.visible.filter(function(t){ return Boolean(keepId[t.id]); }),
      byId: byId,
      roots: full.roots.filter(function(t){ return Boolean(keepId[t.id]); }),
      kids: full.kids,
      forks: full.forks,
      convs: convs,
      convOrder: convOrder
    };
  }

  /**
   * The rows in the order they are painted: what needs a decision first (needsYou, most pressing
   * first), then every root by state — a topic with no title yet (Untitled) ahead of every
   * state, then working, resident and idle, no agent — with a starred row ahead of its unstarred
   * peers inside a state and the daemon's order (most recently active first) underneath. Every
   * topic is followed by the ones its agent opened (Topic.parent),
   * depth-first — unless it is folded. Only the painting is reordered: topics itself keeps the
   * daemon's order, because topics[0] is read elsewhere as "the most recent topic" — where to land
   * when the one on screen goes away.
   *
   * A filter picks conversations, not rows: one survives when the conversation as a whole
   * matches (convMatch), and is then drawn by this same order, with its own fold state, its own
   * fold count and the needs-you block — there is no second way of drawing a result.
   *
   * The nesting and folding are treeWalker's, the walk the Sessions tab draws its runs with too.
   */
  function topicRows(forest){
    var visible=forest.visible, roots=forest.roots, i;
    // The bar's state, read once: which conversations match. A match keeps the whole tree, so
    // every row under a surviving root is drawn exactly as it is without a filter — nothing is
    // dimmed, and no child is dropped for failing a search its parent answered.
    var fs = topicFilter ? topicFilter.state() : null;
    var keep=null, matched=forest.convOrder.length, words=[], filtering=false;
    if(fs){
      var anySel=false;
      for(var gk in fs.sel) if(fs.sel[gk] && fs.sel[gk].length){ anySel=true; break; }
      if(fs.q.trim() || anySel){
        filtering=true;
        words=fs.q.trim().toLowerCase().split(/\s+/);
        keep={}; matched=0;
        for(i=0;i<forest.convOrder.length;i++){
          var conv=forest.convs[forest.convOrder[i]];
          if(!convMatch(conv, words, fs.sel)) continue;
          matched++;
          for(var m=0;m<conv.members.length;m++) keep[conv.members[m].id]=1;
        }
      }
    }
    // Folded means folded with a filter on as well: the pill and its count are how the whole
    // conversation is browsed, and a result must not open a tree the person keeps shut.
    var w=treeWalker(forest), walk=w.walk, rows=w.rows, dividers={};
    // What needs the person first (needsYou), most pressing first, each with the topics it
    // opened. A filtered list keeps the block: a conversation that waits on an answer belongs
    // at the top of the list whether or not the bar is in use.
    var pinned=visible.filter(function(t){ return (!keep || keep[t.id]) && needsYou(t); })
      .sort(function(a,b){ return NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage] || (b.lastAt||0)-(a.lastAt||0); });
    for(i=0;i<pinned.length;i++) walk(pinned[i], 0);
    var afterPinned=rows.length;
    var candidates = keep ? roots.filter(function(r){ return Boolean(keep[r.id]); }) : roots;
    // Then everything else in the order the list is read: a topic with no title yet, working, a
    // resident agent with nothing to do, and no agent at all (the decision group is already drawn
    // above). The daemon's order — most recently active first — holds inside a state, and a
    // starred row leads its unstarred peers there: a star is a promise not to forget a topic, not
    // a claim on the top of the column.
    var ordered=candidates.slice().sort(function(a,b){
      var ra=listRank(a), rb=listRank(b), d=ra-rb;
      if(d) return d;
      if(ra===0) d=NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage];
      return d || (b.starred?1:0)-(a.starred?1:0);
    });
    for(i=0;i<ordered.length;i++) walk(ordered[i], 0);
    w.rest(keep);
    if(afterPinned && afterPinned<rows.length) dividers[afterPinned]=true;
    // Any starred topic counts, not just a starred root: the label decides whether Clear would
    // spare anything, and the daemon spares a starred sub-agent too.
    var stars=0;
    for(i=0;i<visible.length;i++) if(visible[i].starred) stars++;
    // matched and total are conversations, not topics: one tree is one result, which is what
    // the chips count and what "Showing N of M" has to agree with.
    return {rows:rows, dividers:dividers, stars:stars, matched:matched, total:forest.convOrder.length, filtering:filtering};
  }

  /** Whether a topic this one opened, or one of theirs, is working. */
  function busyBelow(id){
    return subtreeRun(id).busy;
  }

  /**
   * Whether a row is drawn as working: its own turn, or a sub-agent's.
   *
   * A /super dispatcher hands its work to topics of its own and then sits idle between turns, so
   * drawn from its own flag alone it was the one row that looked dead while the agents under it
   * worked (reported 2026-11-04). A sub-agent holding a question is running too — the daemon sends
   * both flags — so busyBelow counts it, and the fold pill is what says which of the two it is.
   */
  function rowRunning(t){
    return Boolean(t.running) || busyBelow(t.id);
  }

  var NEEDS_ORDER = {answer:0, failed:1, review:2};
  var NEEDS_WHAT = {answer:'topic.needsAnswer', failed:'topic.needsFailed', review:'topic.needsReview'};
  // stateRank's four values in its own order, as the filter chips name them.
  var STATE_KEYS = ['needs', 'running', 'idle', 'none'];
  /**
   * What needs the person: every topic but the one on screen whose stage is a question, a failure,
   * or a reply not yet read — the daemon decides the stage (core/topic-stage.ts) and sends it with
   * the list. Drawn as the topic's own row, first in the list and green (paintTopics). It was a
   * separate "Needs you" block above the list through 2.19.1, which put every such topic on screen
   * twice — the same title, two rows — and read as two conversations.
   *
   * A sub-agent's topic (one with a parent) counts only for a question of its own: its replies and
   * failures go to the agent that opened it, which says what comes of them (room.ts operatorStage,
   * the same rule for notifications).
   */
  function needsYou(t){
    if(t.id===topic || NEEDS_ORDER[t.stage]===undefined) return false;
    return !t.parent || t.stage==='answer';
  }

  /**
   * The four states the list is ordered by, most pressing first: a decision to make, work under
   * way, a resident agent with nothing to do, and no agent at all. stage already says the first,
   * rowRunning the second (a /super dispatcher is working while its sub-agents are), and live
   * splits the last two — the same facts the dot and the row's colours are drawn from, so the order
   * cannot disagree with what the rows say. The filter bar reads this too: its chips are these
   * four, so it must keep meaning the row's state.
   */
  function stateRank(t){
    if(needsYou(t)) return 0;
    if(rowRunning(t)) return 1;
    return t.live ? 2 : 3;
  }

  /**
   * The rank the list is painted by: needsYou 0, a topic that has no title yet 1, and stateRank's
   * other three states shifted up to 2–4. A topic is named by its first message (topics.ts seed),
   * so an empty title means nothing has been said in it yet — the conversation the person has just
   * opened and is about to work in, which the state order otherwise left at the bottom among the
   * topics with no agent behind them. Only roots are ordered by this, which is why the untitled
   * lift needs no "is this a child" guard: a sub-agent's empty title never reaches a sort.
   *
   * It is a rank of the list, not a fifth state: the dot is drawn from the same facts and the
   * filter bar still counts by stateRank, so "No agent" keeps counting the new topic it is.
   */
  function listRank(t){
    var r=stateRank(t);
    return r===0 ? 0 : (!t.title ? 1 : r+1);
  }

  /**
   * Split a topic's "[agent] subject" name into the agent id it opens with and its subject.
   *
   * Only ever reads a leading bracketed group, which formatLaneTitle guarantees: an untagged
   * name (a topic seeded from its first message before any turn) has no tag and is shown as it is.
   * The rows draw only the subject (the agent is their legend, agentTagHtml); the tag is read only
   * where the daemon did not say which agent is bound (agentOf).
   */
  function splitTitle(title){
    var m=/^\[([^\]]+)\]\s*([\s\S]*)$/.exec(title);
    if(!m) return {tag:'', rest:title};
    return {tag:m[1], rest:m[2]};
  }

  /**
   * Which agent answers in a topic, for its row's legend, the Agent filter and the search:
   *   id       the whole agent id, as config names it (cbc@uniagent)
   *   label    what the legend says
   *   harness  the configured harness, which picks the legend's colour; '' when not known
   *
   * The daemon's answer first (Topic.agent: the binding, with its harness). Failing that the title's
   * own "[agent]" — a topic whose agent is gone from config, a daemon that offered no lookup — which
   * says who answered when the topic was named and carries no harness, so its legend is grey.
   *
   * The label drops "@host" when the line under it already names that machine: an agent on a host is
   * "cbc@uniagent", 15 characters spent on a machine the directory line repeats, and the part before
   * the @ is what the operator types to bind it (reported 2026-11-03, against the title's tag). A host
   * the line does not name — no directory known yet, or a group standing in for the host — keeps it,
   * since dropping it would take the only place on the row that says which machine the agent is on.
   * The whole id is on the legend's tooltip either way. null when nothing names an agent.
   */
  function agentOf(t){
    var id='', harness='';
    if(t.agent && t.agent.id){ id=t.agent.id; harness=t.agent.harness || ''; }
    else id=splitTitle(t.title || '').tag;
    if(!id) return null;
    var host=t.dir && t.dir.host, at=id.indexOf('@');
    var label=(at>0 && host && id.slice(at+1)===host) ? id.slice(0, at) : id;
    return {id:id, label:label, harness:harness};
  }

  /** A topic row's agent legend, on its frame's top-left edge; empty for a row with no agent. */
  function agentTagHtml(t){
    var a=agentOf(t);
    if(!a) return '';
    return '<span class="agent-tag'+(a.harness?' h-'+text(a.harness):'')+'" title="'+text('Agent: '+a.id)+'">'+text(a.label)+'</span>';
  }

  // The topic list's bar, built with the rest of the page. paintTopics keeps its option lists and
  // counts in step; the rows are filtered from the same state in topicRows.
  var topicFilter = null;

  /**
   * The filter bar a list uses when it has outgrown a plain column: one row of search + Filter
   * (+ an optional sort), a panel of chip groups under it, and a "Showing N of M" line while
   * either is in use.
   *
   * The component owns the state and the widgets, not the data. groups are the options the
   * caller has right now, and onChange is the caller's cue to re-filter and re-paint its own
   * rows; it then reports how many survived with setCounts(shown, total), because only the
   * caller knows that. setGroups is how a live list keeps the chips honest — agents and hosts
   * appear and disappear — and a selected value that is no longer offered is dropped, so a chip
   * cannot filter the list to nothing for a reason the panel no longer shows.
   *
   * The keyword, the selected values, the sort field and its direction, and whether the panel is
   * open are persisted under key; a reload lands on the same view. The option lists and the
   * counts are not: they describe the data, which the caller re-states on every paint.
   *
   * opts: {
   *   key, placeholder,
   *   groups: [{id, label, pinned?, options: [{value, label, short?, icon?, count?}]}],
   *   sort?: {options: [{value, label}], value?, dir?: 'asc' | 'desc'},
   *   onChange: (state) => void
   * }
   * A pinned group is drawn as one always-visible row under the search instead of folding into
   * the panel — the state filter of both lists, which is what a person reaches for most and
   * should not cost a click to see. short is its label in that row; the full label stays on the
   * chip's title and aria-label, because the row hides the word when four chips cannot share the
   * width (see .fb-pin in the stylesheet). The Filter dot counts the panel's groups only: a
   * pinned chip is never hidden state.
   * setGroups(null) is for the first frame only, before the caller's data has arrived: it offers
   * nothing and prunes nothing. A refresh is not this — keep the last options by passing them
   * again (or leave them alone until the new ones are in hand), because a reload that lands
   * empty would prune a selection exactly as a genuinely empty list would.
   * Returns {el, state, active, setGroups, setCounts, clear, destroy}. el is appended by the
   * caller; destroy removes the document listener and the node.
   */
  function makeFilterBar(opts){
    var key = opts.key;
    var groups = opts.groups || [];
    var sortDef = opts.sort || null;
    var counts = null;
    var st = {q:'', sel:{}, sort:'', dir:'', open:false};
    try {
      var saved = JSON.parse(localStorage.getItem(key) || 'null');
      if(saved && typeof saved === 'object'){
        if(typeof saved.q === 'string') st.q = saved.q;
        if(saved.sel && typeof saved.sel === 'object' && !Array.isArray(saved.sel)){
          var keys0 = Object.keys(saved.sel);
          for(var k0=0;k0<keys0.length;k0++){
            var sv = saved.sel[keys0[k0]];
            if(!Array.isArray(sv)) continue;
            var vals = [];
            for(var v0=0;v0<sv.length;v0++) if(typeof sv[v0] === 'string') vals.push(sv[v0]);
            if(vals.length) st.sel[keys0[k0]] = vals;
          }
        }
        if(typeof saved.sort === 'string') st.sort = saved.sort;
        if(saved.dir === 'asc' || saved.dir === 'desc') st.dir = saved.dir;
        st.open = saved.open === true;
      }
    } catch(x){}
    if(sortDef){
      var offered = [];
      for(var s0=0;s0<sortDef.options.length;s0++) offered.push(sortDef.options[s0].value);
      if(offered.indexOf(st.sort) < 0){
        st.sort = sortDef.value && offered.indexOf(sortDef.value) >= 0 ? sortDef.value : (offered[0] || '');
      }
      if(!st.dir) st.dir = sortDef.dir === 'desc' ? 'desc' : 'asc';
    } else { st.sort = ''; st.dir = ''; }

    var root = document.createElement('div');
    root.className = 'filterbar';
    var html = '<div class="fb-row">'
      + '<div class="fb-search">' + IC.icon.search
      + '<input class="fb-q" type="text" autocomplete="off" spellcheck="false"'
      + ' placeholder="' + text(opts.placeholder || tr('common.search')) + '" aria-label="' + text(opts.placeholder || tr('common.search')) + '">'
      + '<button type="button" class="fb-qclear" title="' + text(tr('common.clearSearch')) + '" aria-label="' + text(tr('common.clearSearch')) + '" hidden>' + IC.icon.cross + '</button>'
      + '</div>'
      + '<button type="button" class="fb-filter fb-btn" aria-expanded="false" title="' + text(tr('common.filter')) + '">'
      + IC.icon.filter + '<span>' + text(tr('common.filter')) + '</span><span class="fb-dot" hidden></span></button>';
    if(sortDef){
      html += '<span class="fb-tools"><span class="fb-sort" title="' + text(tr('common.sort')) + '">' + IC.icon.sort
        + '<select class="fb-sortsel" aria-label="' + text(tr('common.sort')) + '"></select></span>'
        + '<button type="button" class="fb-dir fb-btn" aria-label="' + text(tr('common.ascending')) + '" title="' + text(tr('common.ascending')) + '"></button></span>';
    }
    html += '</div>'
      + '<div class="fb-pins" hidden></div>'
      + '<div class="fb-sum" hidden><span class="fb-sumtext"></span><button type="button" class="fb-clear">' + text(tr('common.clear')) + '</button></div>'
      + '<div class="fb-panel" hidden></div>';
    root.innerHTML = html;

    var q = root.querySelector('.fb-q');
    var qClear = root.querySelector('.fb-qclear');
    var fBtn = root.querySelector('.fb-filter');
    var dot = root.querySelector('.fb-dot');
    var pins = root.querySelector('.fb-pins');
    var panel = root.querySelector('.fb-panel');
    var sum = root.querySelector('.fb-sum');
    var sumText = root.querySelector('.fb-sumtext');
    var clearBtn = root.querySelector('.fb-clear');
    var sortSel = root.querySelector('.fb-sortsel');
    var dirBtn = root.querySelector('.fb-dir');

    function hasSel(){
      for(var i=0;i<groups.length;i++){
        var v = st.sel[groups[i].id];
        if(v && v.length) return true;
      }
      return false;
    }
    /** A selection in a group that lives in the panel. A pinned group is always on screen, so
        selecting one is not hidden state: the dot on Filter says "the panel holds a choice you
        cannot see", and lighting it for a chip in the row would point at nothing. */
    function panelHasSel(){
      for(var i=0;i<groups.length;i++){
        if(groups[i].pinned) continue;
        var v = st.sel[groups[i].id];
        if(v && v.length) return true;
      }
      return false;
    }
    function active(){ return st.q.trim() !== '' || hasSel(); }
    function save(){ try { localStorage.setItem(key, JSON.stringify(st)); } catch(x){} }

    function state(){
      var sel = {};
      for(var i=0;i<groups.length;i++){
        var id = groups[i].id, v = st.sel[id];
        if(v && v.length) sel[id] = v.slice();
      }
      return {q:st.q, sel:sel, sort:st.sort, dir:st.dir, open:st.open};
    }

    /** Drop selections whose group or value the caller no longer offers. */
    function prune(){
      var changed = false, keys = Object.keys(st.sel);
      for(var i=0;i<keys.length;i++){
        var id = keys[i], group = null;
        for(var g=0;g<groups.length;g++) if(groups[g].id === id){ group = groups[g]; break; }
        if(!group){ delete st.sel[id]; changed = true; continue; }
        var kept = [], v = st.sel[id];
        for(var k=0;k<v.length;k++){
          var found = false;
          for(var o=0;o<group.options.length;o++) if(group.options[o].value === v[k]){ found = true; break; }
          if(found) kept.push(v[k]); else changed = true;
        }
        if(kept.length) st.sel[id] = kept; else { delete st.sel[id]; changed = true; }
      }
      return changed;
    }

    var panelSig = '';

    function paintChips(){
      var chips = root.querySelectorAll('[data-fb-value]');
      for(var i=0;i<chips.length;i++){
        var c = chips[i], id = c.getAttribute('data-fb-group'), v = c.getAttribute('data-fb-value');
        var on = (st.sel[id] || []).indexOf(v) >= 0;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    /** Only the numbers move between paints, so they are written in place rather than rebuilt. */
    function paintCounts(){
      var chips = root.querySelectorAll('[data-fb-value]');
      for(var i=0;i<chips.length;i++){
        var c = chips[i], id = c.getAttribute('data-fb-group'), v = c.getAttribute('data-fb-value'), o = null;
        for(var g=0;g<groups.length;g++) if(groups[g].id === id){
          for(var k=0;k<groups[g].options.length;k++) if(groups[g].options[k].value === v) o = groups[g].options[k];
          break;
        }
        var n = c.querySelector('.fb-count');
        if(o && n && typeof o.count === 'number') n.textContent = String(o.count);
        // The pinned row's word may be hidden, so its full name is the accessible one — and the
        // number is the half of the chip a reader cannot infer from the icon.
        if(o && c.hasAttribute('aria-label')){
          c.setAttribute('aria-label', o.label + (typeof o.count === 'number' ? ' ' + o.count : ''));
        }
      }
    }

    function paintPanel(){
      // Counts move with every message; the chips themselves only when an agent or host appears
      // or goes. Rebuilding on a count would replace the chip mid-click and lose its event path.
      var shape = [];
      for(var i=0;i<groups.length;i++){
        var g = groups[i], row = [g.id, g.label, g.pinned ? 1 : 0];
        for(var k=0;k<g.options.length;k++){
          var o = g.options[k];
          row.push([o.value, o.label, o.short || '', o.icon || '', typeof o.count === 'number' ? 1 : 0]);
        }
        shape.push(row);
      }
      var sig = JSON.stringify(shape);
      if(sig === panelSig){ paintCounts(); paintChips(); return; }
      panelSig = sig;
      // A pinned group goes into its own always-visible row under the search; the rest keep the
      // panel, label and all. Both are built here so one signature still guards both hosts.
      var ph = '', h = '';
      for(i=0;i<groups.length;i++){
        var gg = groups[i], chips = '';
        for(k=0;k<gg.options.length;k++){
          var oo = gg.options[k];
          chips += '<button type="button" class="fb-chip' + (gg.pinned ? ' fb-pin' : '') + '"'
            + ' data-fb-group="' + text(gg.id) + '" data-fb-value="' + text(oo.value) + '"'
            + ' aria-pressed="false" title="' + text(oo.label) + '"'
            + (gg.pinned ? ' aria-label="' + text(oo.label + (typeof oo.count === 'number' ? ' ' + oo.count : '')) + '"' : '') + '>'
            + (oo.icon && IC.icon[oo.icon] ? IC.icon[oo.icon] : '')
            + '<span class="fb-chip-label">' + text(gg.pinned ? (oo.short || oo.label) : oo.label) + '</span>'
            + (typeof oo.count === 'number' ? '<span class="fb-count">' + oo.count + '</span>' : '')
            + '</button>';
        }
        if(gg.pinned){
          ph += '<div class="fb-chips fb-pin-row" role="group" aria-label="' + text(gg.label) + '">' + chips + '</div>';
        } else {
          h += '<div class="fb-group"><div class="fb-label">' + text(gg.label) + '</div>'
            + '<div class="fb-chips">' + chips + '</div></div>';
        }
      }
      pins.innerHTML = ph;
      pins.hidden = !ph;
      panel.innerHTML = h;
      paintChips();
    }

    function paintSummary(){
      if(!active() || !counts){ sum.hidden = true; return; }
      sum.hidden = false;
      sumText.textContent = tr('common.showingOf', { shown: counts.shown, total: counts.total });
    }

    function paintChrome(){
      qClear.hidden = !st.q;
      dot.hidden = !panelHasSel();
      fBtn.classList.toggle('on', panelHasSel());
      fBtn.setAttribute('aria-expanded', st.open ? 'true' : 'false');
      panel.hidden = !st.open;
      if(st.q && q.value !== st.q) q.value = st.q;
      paintSummary();
    }

    function emit(){
      save();
      paintChrome();
      // The pressed state of a chip lives here, not in the caller's repaint: the task list
      // redraws its rows on every change but does not restate its groups, so without this a
      // click would filter the list while the chip still read unpressed.
      paintChips();
      if(opts.onChange) opts.onChange(state());
    }

    function paintDir(){
      if(!dirBtn) return;
      var up = st.dir !== 'desc';
      dirBtn.innerHTML = up ? IC.icon.arrowUp : IC.icon.arrowDown;
      dirBtn.title = up ? tr('common.ascending') : tr('common.descending');
      dirBtn.setAttribute('aria-label', dirBtn.title);
    }

    function clear(){
      st.q = ''; st.sel = {}; q.value = '';
      emit();
    }

    q.addEventListener('input', function(){ st.q = q.value; emit(); });
    qClear.addEventListener('click', function(){ q.value = ''; st.q = ''; emit(); q.focus(); });
    // Escape is handled on the whole bar, not just the field: with the keyboard on Filter or a
    // chip, Escape has to put the panel away — and in either case the keystroke must not bubble
    // to the page-wide handler, which would close the whole sidebar drawer behind the panel.
    // An IME uses Escape to cancel its candidate list; that Escape belongs to the composition.
    root.addEventListener('keydown', function(e){
      if(e.isComposing) return;
      if(e.key !== 'Escape') return;
      if(st.q && e.target === q){
        q.value = ''; st.q = ''; emit(); e.preventDefault(); e.stopPropagation();
        return;
      }
      if(st.open){
        st.open = false; save(); paintChrome();
        // A chip in the panel had focus and is hidden with it; leave the keyboard on the control
        // that opens it rather than nowhere. A chip in the pinned row is still on screen, so
        // there is nothing to move away from.
        if(panel.contains(e.target)) fBtn.focus();
        e.preventDefault(); e.stopPropagation();
      } else if(e.target.closest && e.target.closest('[data-fb-value]')){
        // A chip is in the bar whether the panel is open or not, and Escape on it is the person
        // dismissing nothing. Let it through and the page-wide handler closes the whole drawer
        // behind a filter that did not move.
        e.stopPropagation();
      }
    });
    fBtn.addEventListener('click', function(){ st.open = !st.open; save(); paintChrome(); });
    clearBtn.addEventListener('click', clear);
    if(sortSel) sortSel.addEventListener('change', function(){ st.sort = sortSel.value; emit(); });
    if(dirBtn) dirBtn.addEventListener('click', function(){ st.dir = st.dir === 'desc' ? 'asc' : 'desc'; paintDir(); emit(); });
    root.addEventListener('click', function(e){
      var chip = e.target.closest ? e.target.closest('[data-fb-value]') : null;
      if(!chip) return;
      var id = chip.getAttribute('data-fb-group'), val = chip.getAttribute('data-fb-value');
      if(!id || !val) return;
      var arr = st.sel[id] || (st.sel[id] = []);
      var at = arr.indexOf(val);
      if(at >= 0) arr.splice(at, 1); else arr.push(val);
      if(!arr.length) delete st.sel[id];
      emit();
    });
    // A panel left open over the list is furniture while it filters; a click anywhere else is
    // the person moving on, so it folds away like the footer menus do.
    function onDocClick(e){
      if(!st.open) return;
      // The path, not contains(): a chip's own click repaints the panel in place (setGroups), so
      // by the time the event reaches here its target can be a node that is no longer in root.
      var path = e.composedPath ? e.composedPath() : [];
      if(path.indexOf(root) >= 0 || root.contains(e.target)) return;
      st.open = false; save(); paintChrome();
    }
    document.addEventListener('click', onDocClick);

    /**
     * Replace the option lists. null is only for the first frame, before the caller's data has
     * arrived: an empty array here would be read as "every value is gone", and a saved selection
     * would be pruned by a list that had not arrived (the scheduled panel's first frame is
     * exactly this). Not a refresh signal: while reloading, pass the options still on screen
     * again rather than null, or the same pruning waits one step later.
     */
    function setGroups(next){
      if(next == null) return;
      groups = next;
      if(prune()) save();
      paintPanel();
      paintChrome();
    }
    function setCounts(shown, total){
      counts = {shown: Math.max(0, shown | 0), total: Math.max(0, total | 0)};
      paintSummary();
    }

    /**
     * Let the caller take the bar down. It must be mounted outside any container the caller
     * redraws with innerHTML — the keyword's caret, the panel's open state and the chip nodes
     * live in this DOM, and replacing the container under them loses all three. destroy()
     * removes the document listener and the node; a caller whose own redraw already removed the
     * node can ignore it.
     */
    function destroy(){
      document.removeEventListener('click', onDocClick);
      if(root.parentNode) root.parentNode.removeChild(root);
    }

    function refreshI18n(placeholder, sortOptions){
      var ph = placeholder || tr('common.search');
      q.placeholder = ph;
      q.setAttribute('aria-label', ph);
      var cs = tr('common.clearSearch');
      qClear.title = cs;
      qClear.setAttribute('aria-label', cs);
      var fl = tr('common.filter');
      fBtn.title = fl;
      var fSpan = fBtn.querySelector('span');
      if(fSpan) fSpan.textContent = fl;
      clearBtn.textContent = tr('common.clear');
      if(sortSel){
        var sortLabel = tr('common.sort');
        if(sortSel.parentNode) sortSel.parentNode.title = sortLabel;
        sortSel.setAttribute('aria-label', sortLabel);
        if(sortOptions){
          var h2 = '';
          for(var i2=0;i2<sortOptions.length;i2++){
            h2 += '<option value="' + text(sortOptions[i2].value) + '">' + text(sortOptions[i2].label) + '</option>';
          }
          sortSel.innerHTML = h2;
          sortSel.value = st.sort;
        }
        paintDir();
      }
      paintSummary();
    }

    // No prune yet: the caller supplies the live option lists with setGroups on its first paint,
    // and pruning against the empty list here would drop a selection restored from storage.
    paintPanel();
    paintChrome();
    if(sortDef){
      var optsHtml = '';
      for(var s1=0;s1<sortDef.options.length;s1++){
        var so = sortDef.options[s1];
        optsHtml += '<option value="' + text(so.value) + '">' + text(so.label) + '</option>';
      }
      sortSel.innerHTML = optsHtml;
      sortSel.value = st.sort;
      paintDir();
    }

    return {el:root, state:state, active:active, setGroups:setGroups, setCounts:setCounts, clear:clear, destroy:destroy, refreshI18n:refreshI18n};
  }

  /**
   * The topic list's filter groups, rebuilt from the topics in hand on every paint: agents and
   * hosts come and go, and a chip whose value is gone would filter the list to nothing with no
   * way to see why. Counted by conversation, because that is what the chips filter: a tree whose
   * sub-agent is the cbc one counts once under cbc, and the four state chips add up to the number
   * of trees in the list. Scheduled runs are left out for the same reason topicRows leaves them
   * out — they are not rows in this list. Takes the forest paintTopics already built, so the
   * chips and the rows cannot disagree about what a conversation is.
   */
  function topicFilterGroups(forest, tab){
    var stateOpts = [
      {value:'needs', label:tr('filter.needsYou'), short:tr('filter.needsShort'), icon:'bell', count:0},
      {value:'running', label:tr('filter.running'), short:tr('filter.runShort'), icon:'play', count:0},
      {value:'idle', label:tr('filter.idle'), short:tr('filter.idle'), icon:'dot', count:0},
      {value:'none', label:tr('filter.noAgent'), short:tr('filter.noneShort'), icon:'offline', count:0}
    ];
    var starredOpts = [
      {value:'starred', label:tr('filter.starred'), icon:'star', count:0},
      {value:'plain', label:tr('filter.unstarred'), count:0}
    ];
    var agents = {}, agentOrder = [], hosts = {}, hostOrder = [], i;
    for(i=0;i<forest.visible.length;i++){
      var t = forest.visible[i];
      var who = agentOf(t);
      if(who){
        var agent = who.label;
        if(agents[agent] === undefined){ agents[agent] = 0; agentOrder.push(agent); }
      }
      var host = t.dir && t.dir.host ? t.dir.host : '__local';
      if(hosts[host] === undefined){ hosts[host] = 0; hostOrder.push(host); }
    }
    // One pass per conversation, not per topic: every value it carries gets one, however many
    // of its topics carry it.
    for(i=0;i<forest.convOrder.length;i++){
      var c = forest.convs[forest.convOrder[i]];
      stateOpts[c.rank].count++;
      if(c.starred) starredOpts[0].count++; else starredOpts[1].count++;
      for(var a in c.agents) agents[a]++;
      for(var h in c.hosts) hosts[h]++;
    }
    agentOrder.sort(function(a,b){ return a < b ? -1 : a > b ? 1 : 0; });
    hostOrder.sort(function(a,b){ return a < b ? -1 : a > b ? 1 : 0; });
    var agentOpts = [], hostOpts = [];
    for(i=0;i<agentOrder.length;i++){
      // No tag icon here: a tag means a task label in the scheduled list this bar also serves.
      agentOpts.push({value:agentOrder[i], label:agentOrder[i], count:agents[agentOrder[i]]});
    }
    for(i=0;i<hostOrder.length;i++){
      var hv = hostOrder[i];
      hostOpts.push({value:hv, label:hv === '__local' ? tr('filter.local') : hv, icon:'globe', count:hosts[hv]});
    }
    var groups = [
      {id:'state', label:tr('filter.state'), pinned:true, options:stateOpts}
    ];
    if(tab !== 'starred') groups.push({id:'starred', label:tr('filter.starred'), options:starredOpts});
    if(agentOpts.length) groups.push({id:'agent', label:tr('filter.agent'), options:agentOpts});
    groups.push({id:'host', label:tr('filter.host'), options:hostOpts});
    return {groups:groups, total:forest.convOrder.length};
  }

  /** Everything a keyword is matched against on one topic: its title (with the "[agent]" it was
      named under), the agent answering it now, and the second line — directory name, full path and
      host. */
  function topicHay(t){
    var agent = agentOf(t);
    var hay = (t.title || '') + ' ' + (agent ? agent.id : '');
    if(t.dir) hay += ' ' + (t.dir.name || '') + ' ' + (t.dir.path || '') + ' ' + (t.dir.host || '');
    return hay.toLowerCase();
  }

  /**
   * Whether a conversation survives the bar. The unit is the conversation, not the row: the
   * keyword, an agent and a host match when any topic in the tree carries them — the person is
   * looking for the conversation that talks about this, and the sub-agents are part of it. State
   * and star are whole-tree properties (the most pressing state among its topics, and whether any
   * topic in it is starred), so the state chips partition the conversations and each chip's number
   * is the number of conversations a tap on it leaves. Inside a group the values are a union,
   * across groups an intersection. The keyword is split on whitespace and every word has to hit
   * one topic, so "cbc parse" finds the parser topic of the cbc agent in either order.
   */
  function convMatch(conv, words, sel){
    var v = sel.state;
    if(v && v.length && v.indexOf(STATE_KEYS[conv.rank]) < 0) return false;
    v = sel.starred;
    if(v && v.length && v.indexOf(conv.starred ? 'starred' : 'plain') < 0) return false;
    if(sel.agent && sel.agent.length){
      var hitAgent = false;
      for(var a in conv.agents) if(sel.agent.indexOf(a) >= 0){ hitAgent = true; break; }
      if(!hitAgent) return false;
    }
    if(sel.host && sel.host.length){
      var hitHost = false;
      for(var h in conv.hosts) if(sel.host.indexOf(h) >= 0){ hitHost = true; break; }
      if(!hitHost) return false;
    }
    if(words.length){
      for(var i=0;i<conv.members.length;i++){
        var hay = topicHay(conv.members[i]), all = true;
        for(var w=0;w<words.length;w++) if(hay.indexOf(words[w]) < 0){ all = false; break; }
        if(all) return true;
      }
      return false;
    }
    return true;
  }

  function paintTopics(){
    var h='';
    var cur=null;
    // The way into a topic from a conversation opened in History is offered only while the topic is
    // in this list, and the list just changed.
    historyPanel.refreshReadOnly();
    // One tree for the whole paint: the chips and the rows must count and draw the same
    // conversations, and neither the groups nor the rows change the tree itself.
    var fullForest = topicForest();
    var sbTab = historyPanel.getTab();
    var forest = tabForest(fullForest, sbTab);
    // Before the rows, so a selected agent or host that has just disappeared is dropped from the
    // bar's state first and the list below is filtered by what the panel actually shows.
    var fg = topicFilterGroups(forest, sbTab);
    if(topicFilter) topicFilter.setGroups(fg.groups);
    var painted=topicRows(forest);
    if(topicFilter) topicFilter.setCounts(painted.matched, painted.total);
    // The topic on screen may be a scheduled run, which topicRows leaves out of the list. The
    // header, Stop/power and the read marks still belong to it, so find it in the full list —
    // and seed a mark for every topic, hidden ones included, or the Sessions tab would count a
    // run's whole history as unread the first time it was opened.
    readsService.syncTopics(topics, topic);
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    var stars=0;
    for(i=0;i<fullForest.visible.length;i++) if(fullForest.visible[i].starred) stars++;
    for(i=0;i<painted.rows.length;i++){
      var t=painted.rows[i].t;
      // What the Needs-you block used to say on a second line, now on hover: the row keeps its shape.
      h += treeRowHtml(painted.rows[i], {
        attr:'data-topic',
        menu:'topic',
        cls:(painted.dividers[i]?' after-needs':''),
        tail:(needsYou(t)?' needs':''),
        attrs:needsYou(t)?' title="'+text(tr(NEEDS_WHAT[t.stage])+(t.line?': '+t.line:''))+'"':'',
        moreTitle:tr('topic.topicActions')
      });
    }
    bar.innerHTML=h;
    // From the same list the rows were drawn from, so the line and the row cannot disagree.
    paintMachineNote();
    // A filtered list with nothing left says so where the rows would be, rather than looking like
    // a topic list that failed to load. Clear is the way back without hunting for the field.
    if(!h && painted.filtering){
      bar.innerHTML='<div class="topics-empty"><span>'+text(tr('sidebar.noMatchingTopics'))+'</span>'
        + '<button type="button" class="fb-clear" data-filter-clear="1">'+text(tr('common.clear'))+'</button></div>';
    } else if(!h && sbTab === 'starred'){
      bar.innerHTML='<div class="topics-empty"><span>'+text(tr('sidebar.noStarredTopics'))+'</span></div>';
    }
    // The rows above replaced every age element, so the timer is re-armed against the new ones
    // (and stopped when none is left).
    armAgeTick();
    // The row menu lives at the body, so the innerHTML above cannot take it with it. Follow the
    // button's replacement, and close the menu only if its row is gone from the list.
    rowMenuFollow();
    // Greyed while there is nothing in the list to mark, as the Sessions tab's is. The whole list,
    // not the filtered rows, like Clear: a search narrows what is shown, not what is unread.
    var toRead=0;
    for(i=0;i<fullForest.visible.length;i++) if(needsRead(fullForest.visible[i])) toRead++;
    readBtn.disabled = !toRead;
    readBtn.title = toRead ? tr(toRead===1?'sidebar.markAllReadTopics':'sidebar.markAllReadTopicsPlural', { count: toRead }) : tr('sidebar.markAllReadNone');
    // Says what it will do: with stars in the list it no longer clears all of them.
    var clearLabel = stars ? tr('sidebar.clearUnstarredTopics') : tr('sidebar.clearAllTopics');
    clearBtn.title = clearLabel;
    clearBtn.setAttribute('aria-label', clearLabel);
    // The count sits on Manage's face, so it is read without opening the menu; the item inside
    // says what closing would do, or shows a disabled explanation when there is nothing to close.
    var idle=idleTopics().length;
    idleBtn.hidden = !idle;
    noIdleBtn.hidden = Boolean(idle);
    idleBtn.textContent = tr('menu.closeIdleCount', { count: idle });
    idleCount.textContent = idle ? '('+idle+')' : '';
    var below = cur ? busyBelow(cur.id) : false;
    paintForkNote(cur);
    if(cur){
      chatTitle.textContent=cur.title || tr('common.untitled');
      // Same order as the dot, and the same reason: during an ask the turn is still open, so
      // "running" is true and is the less useful of the two things to say. A dispatcher whose
      // sub-agents work is running too: its own turn ended, the job did not.
      var curRunning=Boolean(cur.running) || below;
      var state=cur.asking?tr('topic.awaitingYou'):(curRunning?tr('topic.running'):'');
      chatStatus.textContent=state;
      chatStatus.className='chat-status'+(cur.asking?' asking':(curRunning?' running':''));
    } else {
      chatTitle.textContent='';
      chatStatus.textContent='';
    }
    // Each control exists only while its command has something to act on, read off the same flags
    // as the dot: Stop while a turn is open (a question holds one open, so asking implies it), and
    // the power button while a process is resident. Hiding beats disabling — a greyed-out control
    // asks to be explained, and "nothing is running" is already what an unlit dot says.
    killBtn.hidden = !(cur && cur.live);
    syncCopyRef();
    // Also over a topic whose own turn is over while the sub-agents it started still work — the
    // usual state of a /super job, and the one where there was nothing to press: /stop there stops
    // them too (Delegation.stopOpened).
    stopBtn.hidden = !(cur && (cur.running || cur.asking || below));
    stopBtn.title = below
      ? tr('composer.stopSubTitle')
      : tr('composer.stopTitle');
    // The window's title bar names the same topic this row does, so a rename lands on both in
    // the same frame rather than leaving the bar holding the old name until the next switch.
    if(TERM_OK) paintFrames();
    schedulesPanel.onTopicsUpdated();
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  // Web Push (webpush.ts on the server, sw.ts the worker): what reaches this device when the page is
  // closed or the phone is in a pocket. Off until the operator turns it on here, per device — the
  // browser asks for permission, and a permission prompt nobody asked for is the fastest way to a
  // "block". Only offered where the browser can do it at all: Chrome, Firefox, Edge, and Safari on
  // iOS only once the page is installed as an app.
  // ── Topics fetched before they are opened ───────────────────────────────────
  // A topic in "needs you" is one the person is about to open, and opening it used to cost a full
  // sync. The row says what the reply is; the transcript behind it can be fetched while the person
  // is still deciding and put in the store, so tapping the row paints the reply at once and the
  // stream only replays what came after (enter).
  //
  // One rule says what to fetch: a topic whose stage is in NEEDS_ORDER — a scheduled run's and a
  // sub-agent's too, since each is opened from its own green row or its notification — that is not
  // on screen and whose copy is not its row's latest (current). A topic this page left is no
  // exception: left mid-turn, its copy is the turn half done. Nearest the top of the list first,
  // three at a time, only while the tab is visible and its stream is up. Without IndexedDB memory
  // holds eight topics, and fetching twenty into it would push them out and fetch them again for
  // ever, so nothing is fetched.
  var PRE_TOPICS=20, PRE_PARALLEL=3, PRE_DEBOUNCE_MS=400, PRE_RETRY_MS=60000, PRE_TIMEOUT_MS=60000;
  // preTried: by topic, the row's last a fetch was made for, when, and whether it came in.
  var preTimer=0, preBusy={}, preCount=0, preTried={};

  /**
   * Whether a copy as of last is its row's latest: the row's own last, or past it — a row reports
   * its topic's events up to 300ms after them. A row without last has nothing to be matched against.
   */
  function current(row, last){
    return Boolean(row && row.last && last) && !newer(row.last, last);
  }

  /** The topics worth fetching now, in the order the needs-you rows are drawn (topicRows). */
  function prefetchWanted(){
    if(!dbOn() || document.visibilityState === 'hidden' || streamClient.isParked() || !epoch) return [];
    if(!streamClient.isOpen()) return [];
    var rows = topics.filter(function(t){ return t.id !== topic && NEEDS_ORDER[t.stage] !== undefined; });
    // What needs a decision first, then most recent: the row nearest the top is the one most likely
    // to be tapped next.
    rows.sort(function(a, b){ return NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage] || (b.lastAt||0)-(a.lastAt||0); });
    return rows.slice(0, PRE_TOPICS).filter(function(t){
      var v = cacheService.getVersion(t.id), tried = preTried[t.id];
      if(!t.last || preBusy[t.id] || current(t, v && v.last)) return false;
      // Once per version of the row: a failure is asked again a minute later, at the next list
      // event; an answer that came in, not until the row moves — even one that is not the row's
      // version, which would otherwise be fetched again the moment it landed.
      return !(tried && tried.last === t.last && (tried.ok || Date.now() - tried.at < PRE_RETRY_MS));
    });
  }

  /** Look again once a burst of list events has settled; a message posts one row per topic. */
  function schedulePrefetch(){
    if(preTimer) return;
    preTimer = setTimeout(pumpPrefetch, PRE_DEBOUNCE_MS);
  }

  /**
   * Start what is wanted, up to PRE_PARALLEL at once. Not one at a time, as through 3.9.0: the
   * median topic is 11 KB gzipped (measured on the live gateway, 2026-11-17), so on a slow link
   * each fetch is mostly round trip, and one at a time a sixth topic waited out five of them.
   */
  function pumpPrefetch(){
    preTimer=0;
    var want=prefetchWanted();
    for(var i=0;i<want.length && preCount < PRE_PARALLEL;i++) prefetchOne(want[i]);
  }

  /**
   * Fetch one topic into the store. Every way this can end goes through finish — an answer, a
   * refusal, a body that does not parse, and a request that never comes back, which is aborted
   * after PRE_TIMEOUT_MS. A rejected r.json() once skipped the only line that freed the slot, and
   * one such answer stopped the page prefetching for the rest of its life.
   */
  function prefetchOne(t){
    var done=false;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    preBusy[t.id]=true;
    preCount++;
    function finish(ok){
      if(done) return;
      done=true;
      clearTimeout(timer);
      delete preBusy[t.id];
      preCount--;
      preTried[t.id]={last:t.last, at:Date.now(), ok:ok};
      pumpPrefetch();
    }
    var timer = setTimeout(function(){
      if(ctl){ try{ ctl.abort(); }catch(x){} }
      finish(false);
    }, PRE_TIMEOUT_MS);
    // A topic not looked at since the page loaded may be in the database already — written by an
    // earlier page, or by the service worker when its push came — and reading that is cheaper than
    // asking the daemon for it again.
    (cacheService.getVersion(t.id) === undefined ? cachePeek(t.id) : Promise.resolve()).then(function(){
      if(done) return;
      var v = cacheService.getVersion(t.id);
      if(t.id === topic || current(t, v && v.last)) return finish(true);
      fetch('api/topic?t='+encodeURIComponent(t.id), {credentials:'same-origin', cache:'no-store', signal:ctl ? ctl.signal : undefined})
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){ return takePrefetched(t, d); })
        .then(finish, function(){ finish(false); });
    });
  }

  /** Whether the answer was kept — or was not needed. May be a promise of it. */
  function takePrefetched(t, d){
    if(!d || d.topic !== t.id) return false;
    // Opened while this was on the wire: the screen keeps its own copy. Gone: nothing to keep.
    if(t.id === topic || !topicById(t.id)) return true;
    // Another run of the daemon: these ids name something else. Not retried at once — a page
    // whose epoch is a restart behind would otherwise ask again the moment this came back — and
    // the sync that brings the new epoch clears preTried, so the next pass fetches it properly.
    if(!epoch || d.epoch !== epoch) return false;
    // An answer older than a copy the page has since put (the topic opened and left while this was
    // in flight, a push the service worker kept) is refused by put, in both layers.
    return put(t.id, snapshotMsgs(d), {epoch:d.epoch, last:d.last, stale:Boolean(d.stale)});
  }

  function switchTopic(id){
    if(!id) return;
    // Any way into a topic — a row, a link, the side panel, a notification — is a way out of a
    // conversation opened from History, including into the very topic it covers.
    closeLib();
    if(id===topic) return;
    // The settings page is bound to the topic it was opened in: its rows write that conversation's
    // agent and model, and its buttons name a message that topic holds. Following another topic
    // puts it away rather than leaving it pointing at the one being left.
    settingsFeature.close();
    // The git window reads the directory of the topic it was opened on; following another topic
    // puts it away rather than leaving it pointing at the one being left.
    gitPanel.close();
    // The panel stays where it is: it is part of the workspace, and following a run out of it
    // should leave the list of runs beside the transcript. The one exception is the overlay under
    // 1024px, which covers the chat it just opened — there is nothing to keep it beside there.
    if(schedPane.isOpen() && !schedPane.docked()) setSchedules(false, true);
    // All three read off the topic being left — its copy, where it was being read, its draft — so
    // all before anything below takes it off screen.
    leave();
    saveView(topic);
    stashDraft(topic);
    topic = id;
    history.replaceState(null,'',urlNow());
    // Before the transcript work below, so the terminal follows the topic in the same frame
    // the title does rather than a repaint later.
    applyTerm();
    readsService.markTopicFromList(id, topics);
    paintTopics();
    reportSeen();
    data={};
    els={};
    stale=false;
    launch=null;
    // The strip describes the topic being left; the incoming sync says what the new one's is.
    topicStatus.closeModelPop();
    transcript.resetForTopicSwitch(id);
    topicStatus.setStatus(null);
    topicStatus.setPending([]);
    entering=true;
    synced=false;
    loadDraft(id);
    // The shape of a transcript while both its copy and the stream are outstanding. A copy in
    // memory replaces it at once and one in the database normally answers first; nothing about
    // that is guaranteed, which is why the placeholders go in regardless.
    showSkeleton();
    settleOnResume = false;
    enter(id);
  }

  // How long entering a topic waits for the database to say whether it has a copy to resume from,
  // before opening the stream with a sync instead. A read is a few milliseconds; this is for a
  // database that hangs, which mobile Safari's has been known to do.
  var LOCAL_WAIT_MS=300;
  // Set when a topic is entered from a copy: the copy and what the resumed stream replays after it
  // are the whole room, so the end of the replay can judge the previous page's unsure sends the way
  // a sync does (see resumed). enterToken is which entry is the latest.
  var settleOnResume=false, enterToken=0;

  /**
   * Into a topic, on a switch and on loading the page: its copy (get) put up, and its stream resumed
   * from the copy's last event — the daemon replays what came after, or sends the whole topic when
   * its backlog no longer reaches. A copy that is its row's latest is the topic as it stands, so
   * nothing says more may be coming. Without a copy to resume from — none, one of another run, one
   * cut to fit, an empty room (whose choice of agents only a sync carries), a page that has not had
   * its first sync — the stream asks for a sync and whatever copy there is is painted as it comes.
   *
   * A copy in memory goes up at once; the database is waited on only when it may hold one to resume
   * from, and for at most LOCAL_WAIT_MS. The copy may be older than the person's last page — a send
   * that page left "Not confirmed" can postdate it — so the echoes in it are claimed here, and a
   * send it does not carry is left for the end of the replay to judge, never failed on the copy.
   */
  function enter(id){
    var mine = ++enterToken, used = false, v = cacheService.getVersion(id);
    // The topic being left has to stop talking now, not when the read comes back: everything its
    // stream delivered in between would be drawn into this topic. Its handlers check es !== stream.
    streamClient.close();
    function here(){ return mine === enterToken && id === topic; }
    function go(c){
      if(used) return;
      used = true;
      if(!here()) return;
      var resume = Boolean(c && c.msgs.length && c.last && epoch && c.epoch === epoch);
      if(c){
        // Before the unsent bubbles go up, as a sync would: an echo settles its record instead of
        // leaving a bubble behind for the messages below to skip.
        for(var i=0;i<c.msgs.length;i++) claim(c.msgs[i]);
        if(resume) stale = c.stale;
        if(c.msgs.length) adopt(c.msgs, resume && current(topicById(id), c.last));
      }
      // What was sent into this topic and not acknowledged — including a send still in flight from
      // before a switch, whose bubble went with the transcript it was in.
      showUnsent(id);
      if(resume){ streamClient.setLastEventId(c.last); settleOnResume = true; }
      streamClient.connect(resume);
    }
    var m = id ? memCopy(id) : null;
    if(m || !id) return go(m);
    get(id).then(function(c){
      if(!used) return go(c);
      // Too late to choose how the stream opens; still worth painting.
      if(c && c.msgs.length && here()) adopt(c.msgs);
    });
    if(epoch && dbOn() && (!v || (v.last && v.epoch === epoch))) setTimeout(function(){ go(null); }, LOCAL_WAIT_MS);
    else go(null);
  }

  function deleteTopic(delId){
    var target = null;
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===delId){ target=topics[i]; break; }
    }
    var title = (target && target.title) ? target.title : tr('common.untitled');
    // A star protects a topic from everything automatic, not from this: the × is the operator
    // deciding about one row, which is exactly what a star defers to. The question says so.
    if(!confirm(tr(target && target.starred ? 'topic.confirmDeleteStarred' : 'topic.confirmDelete', { title: title }))) return;
    post('api/topics/delete',{topic:delId},1).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d) return;
      cacheDrop(delId);
      // The row is gone, so its terminal window has nothing left to belong to. Only the window
      // — the session on the far side outlives this exactly as it outlives a closed tab, which
      // is why deleting a topic is not offered as a way to end one.
      dropTerm(delId);
      readsService.remove(delId);
      if(topic === delId){
        var remaining = topics.filter(function(t){ return t.id !== delId; });
        if(remaining.length > 0){
          switchTopic(remaining[0].id);
        } else {
          createTopic();
        }
      }
      // After the switch, which is what writes down the view and the draft of the topic being
      // left — this one, when it was the one on screen. The broadcast that is also on its way
      // prunes the same entries; this is so a draft of a deleted topic is not waiting on it.
      forget(delId);
    });
  }

  // ── The ages on the topic rows ──────────────────────────────────────────────
  // A row's age is derived from a stamp the server sent, so it goes stale on its own. Rewritten
  // in place rather than by repainting the list: paintTopics replaces every row's markup, which
  // would throw away the hover state and any menu open over a row, twice a minute, for a string
  // that changed by one character. Minutes are the finest unit a row shows, so twice a minute is
  // as often as it can visibly move — and only while one is on screen and the tab is visible.
  // AGE_TICK_MS and ageTimer are declared near the top of the script; see there.

  function paintAges(){
    // Both lists carry one: a topic row in the switcher, a scheduled run in the panel.
    var nodes=document.querySelectorAll('.topic-age'), now=Date.now();
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i], at=Number(n.getAttribute('data-age')) || 0;
      if(!at) continue;
      var run=n.getAttribute('data-age-run')==='1';
      n.textContent=ageText(now-at, !run);
      n.title=tr(run?'age.started':'age.ended', { when: ageClock(at) });
    }
  }

  function armAgeTick(){
    var want=Boolean(document.querySelector('.topic-age')) && document.visibilityState !== 'hidden';
    if(want && !ageTimer) ageTimer=setInterval(paintAges, AGE_TICK_MS);
    else if(!want && ageTimer){ clearInterval(ageTimer); ageTimer=null; }
  }

  // A tab looked at again shows the age it should have had, at once, rather than up to half a
  // minute late; and one put away stops the timer until it is back.
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState !== 'hidden') paintAges();
    armAgeTick();
  });

  function handle(ev){
    if(ev.t==='sync'){
      // Only a sync for a topic we have since left is stale enough to drop. A first visit has
      // no topic at all — nothing put ?t= in the URL yet — and the server answers by picking
      // one for us, so testing ev.topic against an empty string threw away the only sync that
      // visit was ever going to get and left the page an empty shell.
      if(topic && ev.topic !== topic) return;
      var named = !topic;
      topic = ev.topic;
      // A visit that named no topic learns only here which room it is in, and so which composer
      // is its own. Not over anything already typed, though: that was typed into this room.
      if(named && drafts[topic] && !input.value && !files.length) loadDraft(topic);
      history.replaceState(null,'',urlNow());
      // The other half of "asked for is not shown": a reload straight into terminal mode, or a
      // first visit with no ?t= at all, only learns which topic to point at here.
      applyTerm();
      // Where the reader was, decided BEFORE the transcript moves under them. Opening a topic lands
      // where it was left (or at the bottom); a resync after a dropped connection must not yank
      // someone out of the history they were reading, which is only a choice at all now that the
      // reconcile leaves their scroll position intact. Nor may the sync that finishes OPENING a
      // topic, once the cache has put the transcript up and the reader has scrolled it — but when
      // they have not, landing again is what finds their message after the sync has put older
      // ones above it.
      var arriving = transcript.scroll.isArriving(entering);
      var stick = atBottom();
      entering = false;
      // Which run of the daemon everything in this sync belongs to. Anything already on screen
      // from another one is cached history from here on, whatever it was painted as.
      // A different run under a page that was already open is a restart, and the daemon that came
      // back may be a newer one than served this script.
      if(epoch && ev.epoch && ev.epoch !== epoch) streamClient.checkBuild();
      // Whatever was fetched from the daemon that went away is about ids this one hands out
      // again for different messages; what was tried goes with it.
      if(ev.epoch && epoch && ev.epoch !== epoch) preTried={};
      // A sync settles the previous page's sends itself, below.
      settleOnResume = false;
      epoch = ev.epoch || 0;
      synced = true;
      // What the server says about this room BEFORE the transcript is reconciled, so the drops
      // that reconcile performs already know whether an emptied log needs explaining.
      stale = Boolean(ev.stale);
      // Present only for a room that is empty and can still be given to an agent; absent clears it.
      launch = ev.agents || null;
      // Before the launcher is drawn below, which marks an offline machine's agents. Absent: none.
      takeMachines(ev.offline || []);
      repaintHistory();
      // Before the reconcile, which claims any of them whose echo this sync turns out to carry. A
      // visit that named no topic learns only now which ones are its own.
      showUnsent(topic);
      reconcile(ev.messages);
      settleUnsure();
      placeDivider();
      syncEmptyNote();
      // The card follows what the sync says its question and answer now are, or goes with them.
      if(transcript.btw.isOpen()) renderBtw(false);
      cacheSave();
      // A visit that named no topic is only told which room it is in here, so this is also where
      // that room's copy is asked for — painted as history above what the sync carried.
      if(named) get(topic).then(function(c){ if(c && c.msgs.length && ev.topic === topic) adopt(c.msgs); });
      readsService.setCount(topic, ev.messages.length);
      commands = ev.commands || [];
      topics = ev.topics || [];
      streamClient.setTopicsVersion(ev.tv || 0);
      paintTopics();
      prune();
      // Absent when the topic's agent has reported nothing since the daemon started, which clears
      // whatever a previous connection had put up.
      topicStatus.setStatus(ev.status);
      topicStatus.setPending(ev.pending || []);
      note.textContent='';
      if(arriving) land(); else if(stick) toBottom();
      transcript.scroll.clearView();
      // The list this sync carried is what says which topics need a person; the debounce keeps a
      // reconnect's sync and the list events after it to one look.
      schedulePrefetch();
    }
    else if(ev.t==='msg'){
      // /setting is a page here, not a message: the daemon's screen goes to it, and a retired
      // one (wasSettings) stays out of the transcript for good. Anything else that edits the
      // message the page is drawing — the scheduled-task handover does — puts the page away and
      // is drawn as the menu it has become.
      if(settingsFeature.handleMessage(ev.msg)) return;
      // Before the upsert: if this is the echo of something typed here, it takes over the node
      // that local message is already occupying rather than appearing underneath it.
      claim(ev.msg);
      upsert(ev.msg);
      btwArrived(ev.msg);
      cacheSave();
      // Without a status, the settings drawn came from a peek, and what just happened may have
      // ended the session it described (a /cd, a /new): ask again.
      topicStatus.onMessageArrived();
      readsService.increment(topic);
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].msgCount = (topics[i].msgCount || 0) + 1;
          break;
        }
      }
      paintTopics();
    }
    else if(ev.t==='del'){
      drop(epoch+':'+ev.id);
      cacheSave();
    }
    else if(ev.t==='react'){
      var rk = epoch+':'+ev.id;
      var m=data[rk]; if(!m) return;
      var kept=(m.reactions||[]).filter(function(e){ return e!==ev.emoji; });
      m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
      paint(rk);
      cacheSave();
    }
    else if(ev.t==='typing'){
      typing.hidden = !ev.on;
      for(var i=0;i<topics.length;i++){
        if(topics[i].id===topic){
          topics[i].running = ev.on;
          break;
        }
      }
      paintTopics();
      // The turn's last message is no longer being written: its code blocks are coloured now.
      if(!ev.on) hlSweep();
      // A turn just ended — the moment its changes are all on disk. The git window, if it is
      // open on this topic, re-reads the list; an open diff is left where the reader put it. In
      // Commits it re-reads the history, which a turn that committed something has changed.
      if(!ev.on) gitPanel.onTurnEnd();
    }
    else if(ev.t==='commands'){ commands = ev.commands || []; }
    else if(ev.t==='status'){ topicStatus.setStatus(ev.status); }
    else if(ev.t==='pending'){ topicStatus.setPending(ev.items || []); }
    else if(ev.t==='machines'){ setMachines(ev.offline || []); }
    else if(ev.t==='topics' || ev.t==='topic-rows'){
      if(ev.t==='topics') topics = ev.topics || [];
      else topics = applyTopicRows(topics, ev);
      streamClient.setTopicsVersion(ev.tv || 0);
      paintTopics();
      reportSeen();
      if(topic && !topics.some(function(t){ return t.id===topic; })){
        if(topics.length > 0){
          switchTopic(topics[0].id);
        } else {
          createTopic();
        }
      }
      // After any switch above, which writes down the view and draft of the topic it leaves — a
      // topic that has just gone, in that case.
      prune();
      schedulePrefetch();
    }
    // The daemon is going away. The stream is closed here rather than left to EventSource, which
    // The end of a resumed stream's catch-up. For a blip or a tab coming back there is nothing to
    // finish; for a topic put up from its copy (enter) this is what a sync would have done: the
    // waiting line goes, and what is on screen is the room from here on.
    else if(ev.t==='resumed'){
      if(synced) return;
      synced = true;
      entering = false;
      // Entered from a copy: that and the replay just finished are the whole room, so a send the
      // previous page left unsure that neither carried never arrived — a sync's judgement, which a
      // resume has to make for itself when no sync is coming.
      if(settleOnResume){ settleOnResume = false; settleUnsure(); }
      clearSyncing();
      placeDivider();
      syncEmptyNote();
      cacheSave();
      note.textContent='';
    }
  }

  /**
   * The topic list's filter bar (makeFilterBar above). It only says what the options are and
   * re-paints the list when one changes; the keyword and the chips are applied in topicRows.
   */
  topicFilter = makeFilterBar({
    key: 'aa_topic_filter',
    placeholder: tr('sidebar.searchTopics'),
    groups: [],
    onChange: function(){ paintTopics(); }
  });
  $('topics-filter').appendChild(topicFilter.el);
  // The first frame, before the first list arrives: null says "nothing to offer yet", so a
  // selection restored from storage is not pruned as if its option had gone.
  topicFilter.setGroups(null);

  bar.addEventListener('click', function(e){
    // The empty state's Clear. The summary line's own Clear is a listener on the bar itself.
    var fc = e.target.closest ? e.target.closest('[data-filter-clear]') : null;
    if(fc){
      e.stopPropagation();
      if(topicFilter) topicFilter.clear();
      return;
    }
    // The row's one control. Opening the menu is not opening the topic, like the star and the ×
    // before it: the act is about the row, not about switching to it.
    var more = e.target.closest ? e.target.closest('[data-rm]') : null;
    if(more){
      e.stopPropagation();
      if(rowMenuKey && rowMenuKey===more.getAttribute('data-rm') && !rowMenu.hidden) closeRowMenu(true);
      else openRowMenuFor(more);
      return;
    }
    if(foldClick(e)) return;
    var b = e.target.closest ? e.target.closest('[data-topic]') : null;
    if(!b) return;
    var id = b.getAttribute('data-topic');
    if(!id || id===topic) return;
    switchTopic(id);
    if(narrow()) setSidebar(false);
  });

  /**
   * A tap on a fold pill, in either list that draws one (treeRowHtml): flip it and repaint. Not a
   * tap on the row — folding a parent is not a reason to switch to it. paintTopics repaints the
   * Sessions tab too when it is on screen, so one call covers a pill in either.
   */
  function foldClick(e){
    var fold = e.target.closest ? e.target.closest('[data-fold]') : null;
    if(!fold) return false;
    e.stopPropagation();
    var foldId = fold.getAttribute('data-fold');
    if(foldId){
      // Folded is the default (an absent entry), so both choices are written down: false is
      // "I opened this one", true is "I put it back".
      folded[foldId] = folded[foldId] === false;
      saveFolded();
      paintTopics();
    }
    return true;
  }

  bar.addEventListener('keydown', function(e){
    if(e.key==='Enter' || e.key===' '){
      if(e.target.closest && e.target.closest('[data-rm],[data-fold]')) return;
      var b = e.target.closest ? e.target.closest('[data-topic]') : null;
      if(!b) return;
      e.preventDefault();
      var id = b.getAttribute('data-topic');
      if(!id || id===topic) return;
      switchTopic(id);
    }
  });

  // ── A row's ⋯ menu ──────────────────────────────────────────────────────────
  // One menu for every list on the page: a topic row, a scheduled run and a scheduled task all
  // open it, with their own items. The box lives at the body, so a list's innerHTML repaint (every
  // message a running agent posts, every poll of the task list) cannot take it away, and it is
  // fixed so it stays beside the button that opened it. What ties it to a row is a key on the
  // button — "topic:<id>", "sess:<id>", "task:<id>" — re-found after each repaint by rowMenuFollow,
  // which closes the menu when the row it acts on has gone.
  var ROW_MENU_ITEMS = '[role="menuitem"]';
  function rowMenuButtons(){
    return Array.prototype.filter.call(rowMenu.querySelectorAll(ROW_MENU_ITEMS), function(b){ return !b.disabled; });
  }
  /** Place the menu under its button, above it when the viewport runs out, inside both edges. */
  function positionRowMenu(btn){
    if(!btn) return;
    var r=btn.getBoundingClientRect();
    var w=rowMenu.offsetWidth || 210, h=rowMenu.offsetHeight || 0;
    var left=Math.max(8, Math.min(r.right-w, window.innerWidth-8-w));
    var top=r.bottom+4;
    if(top+h+8>window.innerHeight) top=Math.max(8, r.top-4-h);
    rowMenu.style.left=left+'px';
    rowMenu.style.top=top+'px';
  }
  /**
   * Draw the menu for one row and put it beside its button.
   *
   * items: {key, icon, label, title, disabled, danger} for an action, {sep:true} for a divider.
   * onPick(key) runs after the menu has closed, so a handler may repaint the list it came from.
   */
  function openRowMenu(btn, key, items, onPick){
    var h='';
    for(var i=0;i<items.length;i++){
      var it=items[i];
      if(it.sep){ h+='<div class="rm-sep" role="separator"></div>'; continue; }
      h+='<button type="button" role="menuitem" data-rmk="'+text(it.key)+'"'
        +(it.disabled?' disabled':'')+(it.danger?' class="rm-del"':'')
        +(it.title?' title="'+text(it.title)+'"':'')+'>'
        +(it.icon||'')+'<span>'+text(it.label)+'</span></button>';
    }
    rowMenu.innerHTML=h;
    // The composer's command list is another overlay; only one is ever up.
    setMenu(null, false);
    // The box moves to this row: the row it was on must stop saying its menu is open.
    if(rowMenuBtn && rowMenuBtn!==btn) rowMenuBtn.setAttribute('aria-expanded','false');
    rowMenuKey=key;
    rowMenuBtn=btn;
    rowMenuPick=onPick;
    rowMenu.hidden=false;
    btn.setAttribute('aria-expanded','true');
    // Measured only once it is on screen; jsdom reports zeroes, hence the fallback width.
    positionRowMenu(btn);
    var first=rowMenuButtons()[0];
    if(first) first.focus();
  }
  function closeRowMenu(focusBack){
    if(rowMenu.hidden) return;
    var btn=rowMenuBtn;
    rowMenu.hidden=true;
    rowMenuKey=null;
    rowMenuBtn=null;
    rowMenuPick=null;
    if(btn) btn.setAttribute('aria-expanded','false');
    if(focusBack && btn && btn.focus) btn.focus();
  }
  /**
   * Keep an open menu beside the button that opened it, after the list was rebuilt with innerHTML,
   * and close it when that row is gone — the task list is repainted on a 5s/30s poll, so a menu
   * whose row vanished would otherwise act on something no longer on screen.
   */
  function rowMenuFollow(){
    if(!rowMenuKey) return;
    var anchor=document.querySelector('[data-rm="'+rowMenuKey+'"]');
    if(!anchor){ closeRowMenu(false); return; }
    rowMenuBtn=anchor;
    anchor.setAttribute('aria-expanded','true');
    positionRowMenu(anchor);
  }
  /** The topic and every topic under it, in the list's order — the ones End agent reaches. */
  function subtreeOf(id){
    var out=[], seen={}, stack=[id];
    while(stack.length){
      var cur=stack.pop();
      if(seen[cur]) continue;
      seen[cur]=1;
      var t=topicById(cur);
      if(t) out.push(t);
      var kids=[];
      for(var i=0;i<topics.length;i++) if(topics[i].parent===cur) kids.push(topics[i].id);
      for(var j=kids.length-1;j>=0;j--) stack.push(kids[j]);
    }
    return out;
  }
  /** A topic's menu, shared by its sidebar row and its Sessions row: Star / End agent / Delete. */
  function openTopicMenu(id, btn){
    var t=topicById(id);
    if(!t) return;
    // How many sub-agent topics under this one have a process to end. The label says what the
    // item reaches, not what the row's dot says: a child that is resident and idle is still a
    // process, and the confirmation lists exactly the ones with one.
    var under=subtreeOf(id).slice(1);
    var alive=0;
    for(var i=0;i<under.length;i++) if(under[i].live) alive++;
    var able=Boolean(t.live) || alive>0;
    // Fork is offered while nothing is running here, which is the only time the daemon makes one
    // (a copy taken mid-turn would hold half of that turn); greyed with that reason otherwise.
    var busy=Boolean(t.running || t.asking);
    var canFork=!(t.agent && t.agent.canFork===false);
    var items=[
      {key:'star', icon:IC.icon.star, label:t.starred?tr('topic.unstar'):tr('topic.star'),
       title:t.starred?tr('topic.unstarTitle'):tr('topic.starTitle')}
    ];
    items.push({key:'copy', icon:IC.icon.copy, label:tr('topic.copyRef'),
      title:tr('topic.copyRefTitle', { ref: INSTANCE_ID+':main/'+id })});
    if(canFork){
      items.push({key:'fork', icon:IC.icon.fork, label:tr('topic.fork'), disabled:busy,
       title:busy
         ? tr('topic.forkBusyTitle')
         : tr('topic.forkTitle')});
    }
    items.push(
      {key:'end', icon:IC.icon.power,
       label:alive ? tr(alive===1?'topic.endAgentSub':'topic.endAgentSubs', { count: alive }) : tr('topic.endAgent'),
       disabled:!able,
       // The reason, when there is nothing to end: a greyed item with no explanation asks.
       title:able
         ? (alive ? tr(alive===1?'topic.endAgentSubTitle':'topic.endAgentSubsTitle', { count: alive }) : tr('topic.endAgentTitle'))
         : tr('topic.endAgentNoneTitle')},
      {sep:true},
      {key:'delete', icon:IC.icon.trash, label:tr('topic.deleteTopic'), danger:true}
    );
    openRowMenu(btn, btn.getAttribute('data-rm')||('topic:'+id), items, function(what){
      if(what==='star') starTopic(id);
      else if(what==='copy') copyTopicRef(id);
      else if(what==='fork') forkTopic(id);
      else if(what==='delete') deleteTopic(id);
      else if(what==='end') endTopic(id);
    });
  }
  /**
   * A task's menu: its state changes, then Delete. Run now is greyed while a run is in flight and
   * says so — the item a person reaches for is the one that would be wrong to allow, so it stays
   * visible with the reason rather than disappearing.
   */
  function openTaskMenu(id, btn){
    var t=schedTask(id);
    if(!t) return;
    var state=t.state||'active';
    var items=[];
    if(state==='active') items.push({key:'pause', icon:IC.icon.pause, label:tr('sched.pause'), title:tr('sched.pauseTitle')});
    if(state==='paused') items.push({key:'resume', icon:IC.icon.play, label:tr('sched.resume'), title:tr('sched.resumeTitle')});
    if(state==='active'||state==='paused') items.push({key:'run', icon:IC.icon.clock, label:tr('sched.runNow'), disabled:Boolean(t.running),
      title:t.running?tr('sched.runNowBusyTitle'):tr('sched.runNowTitle')});
    // Edit opens the task's page on its form. Greyed rather than hidden while a run is in flight,
    // like Run now; absent on a task that is over, which no edit can change.
    if(state==='active'||state==='paused') items.push({key:'edit', icon:IC.icon.pencil, label:tr('common.edit'), disabled:Boolean(t.running),
      title:t.running?tr('sched.editBusyTitle'):tr('sched.editTitle')});
    // Delete is below a divider only when there is something above it: an expired or done task
    // has no state change to offer, and a menu that opens with a line is a menu that looks cut.
    if(items.length) items.push({sep:true});
    items.push({key:'remove', icon:IC.icon.trash, label:tr('common.delete'), danger:true});
    openRowMenu(btn, btn.getAttribute('data-rm')||('task:'+id), items, function(what){
      if(what==='edit'){ openTaskPage(id, true); return; }
      if(what==='remove'){
        // One question, like deleting a topic: the task is gone for good, and a tap that opened
        // the menu is not a decision to remove it.
        if(!confirm(tr('sched.confirmDeleteTask', { name: t.name||t.id }))) return;
        schedOp(id,'remove',null);
        return;
      }
      schedOp(id, what, null);
    });
  }
  /** Open the menu a row's ⋯ belongs to. The key's prefix is what the row is. */
  function openRowMenuFor(btn){
    var key=btn.getAttribute('data-rm')||'';
    var cut=key.indexOf(':');
    if(cut<0) return;
    var kind=key.slice(0,cut), id=key.slice(cut+1);
    if(!id) return;
    if(kind==='task') openTaskMenu(id, btn);
    else openTopicMenu(id, btn);
  }
  rowMenu.addEventListener('click', function(e){
    var item=e.target.closest ? e.target.closest('[data-rmk]') : null;
    if(!item || item.disabled) return;
    var pick=rowMenuPick, what=item.getAttribute('data-rmk');
    if(!pick || !what) return;
    closeRowMenu(false);
    pick(what);
  });
  // Arrow keys move between the enabled items, as role=menu promises. Tab leaves the menu like any
  // other focus trip; Escape is the page-wide handler's, which also puts the focus back.
  rowMenu.addEventListener('keydown', function(e){
    if(e.key!=='ArrowDown' && e.key!=='ArrowUp' && e.key!=='Home' && e.key!=='End') return;
    var items=rowMenuButtons();
    if(!items.length) return;
    e.preventDefault();
    var at=items.indexOf(document.activeElement);
    var next;
    if(e.key==='Home') next=0;
    else if(e.key==='End') next=items.length-1;
    else if(e.key==='ArrowDown') next=at<0 ? 0 : (at+1)%items.length;
    else next=at<0 ? items.length-1 : (at+items.length-1)%items.length;
    items[next].focus();
  });
  // Tab — or any other way the focus leaves — puts the menu away, and the ⋯ stops saying it is
  // open. A move onto the ⋯ itself is left to its own click, which toggles: closing here would
  // make the second tap close and reopen in one gesture. A focusout with NO relatedTarget is
  // left to the document click below: iOS Safari does not focus a button on tap, so it reports
  // one before the click that the tap is about to deliver, and closing here would swallow the
  // action the person just hit.
  rowMenu.addEventListener('focusout', function(e){
    if(rowMenu.hidden) return;
    var to=e.relatedTarget;
    if(!to || rowMenu.contains(to) || (rowMenuBtn && rowMenuBtn.contains(to))) return;
    closeRowMenu(false);
  });
  // A click anywhere else puts it away. The ⋯ itself is excluded: its own handler toggles, and
  // closing it here too would make the second tap open and close in the same gesture.
  document.addEventListener('click', function(e){
    if(rowMenu.hidden) return;
    if(rowMenu.contains(e.target) || (rowMenuBtn && rowMenuBtn.contains(e.target))) return;
    closeRowMenu(false);
  });
  // Any list scrolls under the fixed menu — the sidebar's, the panel's — so follow the button
  // rather than leave the box at a stale pixel.
  document.addEventListener('scroll', function(){ if(rowMenuKey) positionRowMenu(rowMenuBtn); }, true);
  window.addEventListener('resize', function(){ if(rowMenuKey) positionRowMenu(rowMenuBtn); });

  /**
   * Open a new topic, as the + does.
   *
   * seed is what an Adopt starts one with: the suggestion and the draft asking an agent to add
   * it to the person's instructions. The draft goes into the composer and is never sent, and the
   * topic is remembered against the suggestion in memory (revAdopted) so a message that really
   * goes out from it can take the suggestion off the pending list. A refusal says why and leaves
   * the suggestion alone. Answers whether a topic was opened.
   */
  function createTopic(seed){
    return post('api/topics',{},1).then(function(r){
      if(r.ok) return r.json();
      // Never swallowed again. A refusal used to vanish here, so the + simply did nothing and the
      // only trace was a 409 in the network panel. The daemon now gives up its oldest topic to
      // make room by itself, which leaves one reason to refuse — every topic is starred or busy —
      // and its own sentence says which and what to do about it.
      return r.json().then(function(d){ return {error:(d && d.error) || ('HTTP '+r.status)}; },
        function(){ return {error:'HTTP '+r.status}; });
    }, function(){
      return {error:tr('topic.createReachErr')};
    }).then(function(d){
      if(d && d.error){ alert(tr('topic.createFailed', { err: d.error })); return false; }
      if(!d || !d.topic) return false;
      // Just made, so there is no copy of it to look for: entered at once (enter).
      cacheService.setVersion(d.topic.id, {last:'', epoch:0});
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
      if(seed){
        // After the switch, which has just put an empty composer up for this topic. Written down
        // like any draft, so a reload keeps the text even though it loses what it was for. The
        // caret goes at the end, where someone about to edit or send it expects it.
        drafts[d.topic.id] = {text:seed.draft, s:seed.draft.length, e:seed.draft.length, files:[]};
        writeDraft(d.topic.id);
        loadDraft(d.topic.id);
        reviewsPanel.rememberAdopted(d.topic.id, seed.text);
      }
      return true;
    });
  }

  /**
   * Star or unstar a topic. Drawn at once rather than on the broadcast that confirms it — a tap
   * on a slow link should not look ignored — and put back if the daemon refused, in which case
   * the broadcast that would have corrected it is not coming.
   */
  function starTopic(id){
    var t = topicById(id);
    if(!t) return;
    var on = !t.starred;
    t.starred = on;
    paintTopics();
    post('api/topics/star',{topic:id, starred:on},1).then(function(r){ return r.ok; }, function(){ return false; }).then(function(ok){
      if(ok) return;
      // Looked up again: a broadcast in between replaces the array, and the object held above
      // would no longer be the one on screen.
      var now = topicById(id);
      if(now){ now.starred = !on; paintTopics(); }
      alert(on ? tr('topic.starFailed') : tr('topic.unstarFailed'));
    });
  }

  function topicById(id){
    for(var i=0;i<topics.length;i++){ if(topics[i].id===id) return topics[i]; }
    return null;
  }

  /**
   * The menu's Fork: /fork, typed into that topic, so the daemon has one way to be told and the
   * topic's transcript records it like any command. Into the topic on screen it goes through
   * command(), bubble and all; into another it is posted with no bubble here — there is no transcript
   * of that topic on screen to put one in — and its answer is in that topic, while the fork itself
   * appears beside it in the list.
   */
  function forkTopic(id){
    if(id===topic){ command('/fork'); return; }
    var nonce=Math.random().toString(36).slice(2)+Date.now().toString(36);
    post('api/send',{topic:id, text:'/fork', nonce:nonce},1).then(function(r){
      if(!r.ok) alert(tr('topic.forkRefused'));
    }, function(){ alert(tr('topic.forkReachErr')); });
  }

  // Not createTopic itself: a listener is handed the MouseEvent, which would arrive as a seed.
  // A new topic is a row in the Topics list, so that is the tab it is created into.
  newTopicBtn.addEventListener('click', function(){ setSbTab('topics'); createTopic(); });

  readBtn.addEventListener('click', function(){
    setMenu(null, false);
    markAllRead(topicForest().visible, 'topic', function(msg){ note.textContent=msg; });
  });

  clearBtn.addEventListener('click', function(){
    setMenu(null, false);
    var stars = topics.filter(function(t){ return t.starred; }).length;
    var gone = topics.length - stars;
    if(stars && !gone){ alert(tr('topic.allStarredAlert')); return; }
    // The button clears the whole list, not the filtered rows — say that where a search or a
    // filter is on screen, or it reads as "clear these three".
    var scope = topicFilter && topicFilter.active() ? tr('topic.clearScopeNote') : '';
    if(!confirm(stars
      ? tr('topic.confirmClearStarred', { gone: gone, goneWord: gone===1?tr('topic.nounSingular'):tr('topic.nounPlural'), stars: stars, starsWord: stars===1?tr('topic.starredOneIs'):tr('topic.starredManyAre'), scope: scope })
      : tr('topic.confirmClearAll', { total: topics.length, scope: scope }))) return;
    post('api/topics/clear',{},1).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(!d || !d.topic) return;
      // What the daemon kept: the starred topics and the fresh one. Read from its answer rather
      // than from the stars on this page, which another tab may have changed since they were drawn.
      var list = d.topics || [d.topic];
      var keep = {};
      for(var i=0;i<list.length;i++) keep[list[i].id] = 1;
      // Every local record of the rooms that went goes with them. Leaving the caches would put
      // messages on screen for ids the daemon has forgotten, leaving the read marks would badge
      // the replacement topic against a count from a room that no longer exists, and a draft or a
      // terminal window would belong to nothing. The kept topics keep all of theirs.
      keepOnly(keep);
      // The list is replaced with what the server just told us rather than left to the broadcast
      // that is also on its way: paintTopics re-seeds a read mark for every topic it renders, so
      // painting the OLD list once more would write the ids we are here to forget straight back
      // into storage.
      topics=list;
      // Cleared rather than handed straight to switchTopic when the topic on screen went too:
      // nothing of a deleted room should be written back on the way out of it, and the
      // replacement id is four random bytes and may repeat the one being read — a one-in-4-billion
      // case where switchTopic would do nothing and leave a wiped transcript on screen. A starred
      // topic on screen is left alone, so its view and draft are saved like any other switch.
      if(!keep[topic]) topic='';
      cacheService.setVersion(d.topic.id, {last:'', epoch:0});
      switchTopic(d.topic.id);
      if(narrow()) setSidebar(false);
    });
  });

  // ── Closing idle agents ────────────────────────────────────────────────────
  /**
   * The topics whose agent is up and doing nothing — the dim dot, read off the same flags it is
   * drawn from, so the button's count and the dots cannot disagree. A dispatcher whose sub-agents
   * are still working is not one of them: its row is drawn as running (rowRunning), and offering
   * to close it under that row would be the list contradicting itself. In the sidebar's order:
   * starred first, so the dialog lists them where the eye already knows to find them.
   */
  function idleTopics(){
    var on=[], rest=[];
    for(var i=0;i<topics.length;i++){
      var t=topics[i];
      if(!t.live || t.running || t.asking || busyBelow(t.id)) continue;
      (t.starred ? on : rest).push(t);
    }
    return on.concat(rest);
  }

  /**
   * What the dialog was opened on: the ids it lists, which are the ids it posts. Not re-read from the
   * topic list at the click — a topic that went idle while the dialog was open was not shown, and
   * nothing is closed that the operator did not see. idleSeq drops an answer for a dialog since closed.
   */
  var idleIds=[], idleSeq=0;
  function openIdle(){
    var list=idleTopics();
    if(!list.length) return;
    idleIds=[];
    var h='';
    for(var i=0;i<list.length;i++){
      var t=list[i];
      idleIds.push(t.id);
      var where=t.dir?(t.dir.host?t.dir.host+' · ':'')+t.dir.name:'';
      h += '<li data-idle="'+text(t.id)+'"><span class="idle-main"><span class="idle-name">'+text(t.title || tr('common.untitled'))+'</span>'
         + (where?'<span class="idle-dir">'+text(where)+'</span>':'')+'</span><span class="idle-out"></span></li>';
    }
    idleList.innerHTML=h;
    idleTitle.textContent=tr(list.length===1?'idle.confirmTitleOne':'idle.confirmTitleMany', { count: list.length });
    idleWhy.hidden=false;
    idleGo.hidden=false;
    idleGo.disabled=false;
    idleGo.textContent=tr('idle.closeAgents');
    idleCancel.textContent=tr('common.cancel');
    idleDialog.hidden=false;
    // Cancel, not Close: an Enter pressed out of habit should be the answer that changes nothing.
    idleCancel.focus();
  }
  /**
   * A row menu's "End agent": end the process behind this topic and every topic under it at
   * once. The item's label already says how far it reaches ("End agent + 2 sub-agents"), so the
   * reach was on screen when it was clicked — there is no second question. /kill is one tap
   * away in the header and does the same without asking, and a running turn is interrupted here
   * on purpose.
   *
   * The request carries the list as the page drew it: the daemon walks the subtree from its own
   * parent record and ends only the intersection, so a sub-agent opened since is left alone.
   * Posted once, not retried: a retry after a lost answer would find every agent already ended.
   */
  function endTopic(id){
    var list=subtreeOf(id).filter(function(t){ return Boolean(t.live); });
    if(!list.length) return;
    var ids=[];
    for(var i=0;i<list.length;i++) ids.push(list[i].id);
    post('api/topics/kill',{topic:id, topics:ids},0).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d) return alert(ids.length===1 ? tr('topic.endRefusedOne') : tr('topic.endRefusedMany'));
      // Nothing to say for a clean end — the dots go grey from the daemon's own broadcast. A
      // process the runtime cannot resume is the one refusal that leaves a row looking untouched,
      // and nothing else on the page would say why it is still lit.
      var results=d.results || [], stuck=0;
      for(var i=0;i<results.length;i++) if(results[i].outcome==='unresumable') stuck++;
      if(stuck) alert(tr(stuck===1?'topic.endUnresumableOne':'topic.endUnresumableMany', { count: stuck }));
    }, function(){
      alert(ids.length===1 ? tr('topic.endReachErrOne') : tr('topic.endReachErrMany'));
    });
  }
  function closeIdle(){
    if(idleDialog.hidden) return;
    idleDialog.hidden=true;
    idleSeq++;
    idleList.textContent='';
  }
  /**
   * The result, in the dialog rather than under the transcript: on a phone the sidebar is a drawer
   * over the transcript, and the status line there is behind it. Each row says what became of it,
   * because a topic that started working since the list was drawn is left alone (room.ts closeIdle),
   * and "5 of 6" alone would not say which one.
   *
   * Posted once, not retried: a retry after an answer that was lost would find every agent already
   * ended and report them all as left running.
   */
  function goIdle(){
    idleGo.disabled=true;
    var mine=++idleSeq;
    post('api/topics/close-idle',{topics:idleIds},0).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if(mine!==idleSeq) return;
      if(!d) return idleFailed(tr('idle.refused'));
      var rows=idleList.querySelectorAll('li'), i;
      var closed={};
      for(i=0;i<d.closed.length;i++) closed[d.closed[i]]=1;
      for(i=0;i<rows.length;i++){
        var out=rows[i].querySelector('.idle-out'), ok=closed[rows[i].getAttribute('data-idle')];
        out.textContent = ok ? tr('idle.closed') : tr('idle.leftRunning');
        out.className = 'idle-out' + (ok ? '' : ' kept');
      }
      var n=d.closed.length, k=d.kept.length;
      idleTitle.textContent=tr(n===1?'idle.closedTitleOne':'idle.closedTitleMany', { count: n })
        + (k ? tr('idle.keptSuffix', { count: k }) : '');
      idleWhy.hidden=true;
      idleGo.hidden=true;
      idleCancel.textContent=tr('common.done');
      idleCancel.focus();
    }, function(){ if(mine===idleSeq) idleFailed(tr('common.reachServerError')); });
  }
  function idleFailed(why){
    idleTitle.textContent=why;
    idleGo.disabled=false;
  }
  idleBtn.addEventListener('click', function(){ setMenu(null, false); openIdle(); });
  idleGo.addEventListener('click', goIdle);
  idleCancel.addEventListener('click', closeIdle);
  idleDialog.addEventListener('click', function(e){ if(e.target===idleDialog) closeIdle(); });

  /**
   * Forget everything local about every topic NOT in keep: cached transcript, read mark, reading
   * position, draft, terminal window. With nothing starred, keep holds only the fresh topic and
   * this is the whole-page wipe a clear always was.
   */
  function keepOnly(keep){
    var id;
    cacheKeep(keep);
    readsService.keepOnly(keep);
    transcript.scroll.pruneViews(keep);
    for(id in drafts) if(!keep[id]) delete drafts[id];
    // One read-modify-write of the stored drafts, for the same reason writeDraft is one: a second
    // tab's drafts for the kept topics are on disk and not in this tab's map.
    try {
      var all = JSON.parse(localStorage.getItem(DRAFTS) || 'null') || {};
      var left = 0;
      for(id in all){ if(!keep[id]) delete all[id]; else left++; }
      if(left) localStorage.setItem(DRAFTS, JSON.stringify(all)); else localStorage.removeItem(DRAFTS);
    } catch(x){}
    // And what was sent into those rooms and never arrived: there is no longer anywhere to send it.
    for(var n in unsent) if(Object.prototype.hasOwnProperty.call(unsent, n) && !keep[unsent[n].t]) delete unsent[n];
    try {
      var out = JSON.parse(localStorage.getItem(UNSENT) || 'null') || {};
      var kept = 0;
      for(n in out){ if(!(out[n] && keep[out[n].t])) delete out[n]; else kept++; }
      if(kept) localStorage.setItem(UNSENT, JSON.stringify(out)); else localStorage.removeItem(UNSENT);
    } catch(x){}
    terminalController.pruneFrames(keep);
  }

  // The draft first: a reload is a way out of the page, and the composer is the one thing here a
  // person would have typed into.
  $('update-reload').addEventListener('click', function(){ stashDraft(topic); location.reload(); });

  $('gate').addEventListener('submit', function(e){
    e.preventDefault();
    // No password to send: this gate's only control is a reload, which is what sends the
    // browser back through the identity provider.
    if(!PASSWORD_LOGIN){ location.reload(); return; }
    err.textContent='';
    post('api/login',{token:$('secret').value},0).then(function(r){
      if(r.ok){ $('secret').value=''; streamClient.connect(); return; }
      err.textContent = r.status===429 ? tr('gate.tooManyAttempts') : tr('gate.wrongToken');
    }).catch(function(){ err.textContent=tr('common.reachServerError'); });
  });


  // ── History (client/panels/history.ts) ──────────────────────────────────────
  function setSbTab(tab){ historyPanel.setTab(tab); }
  function libOn(){ return historyPanel.isOpen(); }
  function closeLib(){ historyPanel.close(); }

  overlays.addGuard(function(){ return Boolean(rec); });
  overlays.registerFallback(function(){
    if(filesPanel.isCustomOpen()){ filesPanel.close(); return true; }
    return false;
  });
  overlays.registerFallback(function(){
    var hintsOpen = !hints.hidden;
    var overlay = hintsOpen || !lightbox.hidden || !reader.hidden || !idleDialog.hidden || !rowMenu.hidden
      || openMenu() || !skillsWin.hidden || !settingsPage.hidden || !taskPage.hidden || filesPanel.isOpen() || gitPanel.isOpen();
    closeShot(); closeReader(); closeIdle(); closeSkills(); settingsFeature.close(); filesPanel.close(); gitPanel.close();
    closeTaskPage(false);
    closeRowMenu(true);
    if(hintsOpen){ hints.hidden = true; hints.innerHTML = ''; }
    var m = openMenu();
    if(m){ setMenu(null, false); m.btn.focus(); }
    return Boolean(overlay);
  });
  overlays.registerFallback(function(){
    if(transcript.btw.isOpen()){ closeBtw(true); return true; }
    if(schedPane.isOpen()){ setSchedules(false); return true; }
    if(sbPane.isOpen()){ setSidebar(false); return true; }
    return false;
  });

  // ── The git window (client/panels/git.ts) ──────────────────────────────────

  // ── Skills (client/panels/skills.ts) ────────────────────────────────────────
  function closeSkills(){ skillsPanel.close(); }

  // ── The file window (client/panels/files.ts) ───────────────────────────────
  // ── Instructions (client/panels/instructions.ts) ─────────────────────────────

  // Grow to fit, and let the max-height in the stylesheet decide where to stop — it is stated
  // in dvh there, which on a phone with the keyboard up is the viewport that is actually left.
  // Clamping here as well would mean two numbers for one cap, and the JS one cannot see which
  // media query won.
  function grow(){ input.style.height='auto'; input.style.height=input.scrollHeight+'px'; }

  /**
   * The composer's attachments, one chip each: the name, a thumbnail when it is a picture, and a ×
   * that takes it back off the message. Before this a chip was a name and nothing else, so a
   * screenshot could not be checked before it went, and one pasted by mistake could only be got
   * rid of by sending it or by switching topics and back — which keeps it, since the draft does.
   *
   * Two constraints shape how the thumbnail is made:
   *   - It is a data: URL, not URL.createObjectURL. The page's CSP (server.ts) is img-src 'self'
   *     data:, so a blob: URL is refused and every thumbnail would be a broken frame. Widening the
   *     CSP for a preview is the wrong way round.
   *   - Each chip is built ONCE per file and moved, never rebuilt. The URL is the whole file again,
   *     and pushing it through innerHTML (and text() before that) on every paste re-parses and
   *     re-decodes every screenshot already there. The node lives in a WeakMap, not on the file
   *     object, because that object IS the upload: api/send is .strict() and would refuse a
   *     message carrying one more key.
   */
  var chipEls = new WeakMap();
  function chipFor(f){
    var el = chipEls.get(f);
    if(el) return el;
    el = document.createElement('span');
    el.className = 'chip';
    if(/^image\//.test(f.mime) && f.data){
      var img = document.createElement('img');
      img.className = 'thumb';
      img.alt = f.name;
      img.src = 'data:'+f.mime+';base64,'+f.data;
      el.appendChild(img);
    }
    var name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = f.name;
    el.appendChild(name);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.title = tr('composer.removeFile', { name: f.name });
    x.setAttribute('aria-label', x.title);
    x.textContent = '\u00d7';
    el.appendChild(x);
    chipEls.set(f, el);
    return el;
  }
  function renderChips(){
    chips.textContent = '';
    for(var i=0;i<files.length;i++){
      var el = chipFor(files[i]);
      // An index, re-stamped on every render: files only ever grows at the end or loses the one
      // being removed, and either way this render follows it before another click can land.
      el.lastChild.setAttribute('data-drop', String(i));
      chips.appendChild(el);
    }
  }
  chips.addEventListener('click', function(e){
    var x = e.target.closest ? e.target.closest('button[data-drop]') : null;
    if(x){ files.splice(Number(x.getAttribute('data-drop')), 1); renderChips(); return; }
    var t = e.target.closest ? e.target.closest('img.thumb') : null;
    if(t) openShot(t);
  });
  // A picture this browser cannot decode (HEIC on anything but Safari) keeps its name and loses
  // the broken frame, the same answer #log gives one that 404s — and for the same reason in the
  // capture phase: 'error' on an <img> does not bubble.
  chips.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.classList && t.classList.contains('thumb')) t.style.display='none';
  }, true);

  // ── A composer per topic ───────────────────────────────────────────────────
  /**
   * What each topic's composer held when it was left: the text, where the caret was, and the files
   * attached. One textarea serves every topic, so before this a half-written prompt followed the
   * reader into the next topic — and so did its attachments, which is how a screenshot meant for
   * one conversation got sent into another.
   *
   * The text is written through to localStorage, so a reload does not cost it either. Files are
   * not: they are base64, and a failed message cannot be retried after a reload for the same reason.
   *
   * Written when a topic is left, when a message is sent and when the page is hidden, and once
   * typing has paused for DRAFT_IDLE_MS — never per keystroke. visibilitychange is the last event
   * every way out of a page reliably fires (another tab, the app backgrounded, the window closed),
   * so nothing typed is still only in memory by the time the browser is free to discard the page.
   * The pause is for the ways out that fire nothing at all: a renderer that crashes, a phone that
   * kills the tab in the foreground. Those used to cost the whole draft; now they cost the last
   * second of typing, for one small write per pause rather than one per key.
   */
  var DRAFTS='aa_drafts';
  // Past this a draft is kept in memory only. localStorage is one ~5MB budget for the origin, and a
  // pasted log that filled it would take down the writes of the read marks and the drawer state too.
  var DRAFT_MAX=64*1024;
  var DRAFT_IDLE_MS=1000;
  var drafts={}, draftTimer=0;
  (function(){
    var saved=null;
    try { saved = JSON.parse(localStorage.getItem(DRAFTS) || 'null'); } catch(x){}
    if(!saved || typeof saved !== 'object') return;
    for(var id in saved){
      var s = saved[id];
      if(Object.prototype.hasOwnProperty.call(saved, id) && typeof s === 'string' && s)
        drafts[id] = {text:s, s:s.length, e:s.length, files:[]};
    }
  })();

  /**
   * Write one topic's draft through to storage and leave every other entry as it is ON DISK: a
   * second tab on this origin keeps drafts of its own, and writing this tab's whole map would put
   * back ones that tab has since sent. Nothing is written when nothing would change.
   */
  function writeDraft(id){
    try {
      var all = JSON.parse(localStorage.getItem(DRAFTS) || 'null') || {};
      var d = drafts[id];
      var want = (d && d.text && d.text.length <= DRAFT_MAX) ? d.text : undefined;
      if(all[id] === want) return;
      if(want === undefined) delete all[id]; else all[id] = want;
      localStorage.setItem(DRAFTS, JSON.stringify(all));
    } catch(x){}
  }

  /**
   * Take the composer's contents off the topic being left. Storage is only consulted when this
   * topic had a draft before or has one now — leaving an empty composer for an empty one, which is
   * most switches, reads and writes nothing.
   */
  function stashDraft(id){
    // Whatever was waiting on a pause in the typing is being done now, for the topic it was typed in.
    clearTimeout(draftTimer); draftTimer=0;
    if(!id) return;
    var had = Boolean(drafts[id]);
    if(input.value || files.length)
      drafts[id] = {text:input.value, s:input.selectionStart, e:input.selectionEnd, files:files};
    else delete drafts[id];
    if(had || drafts[id]) writeDraft(id);
  }

  /**
   * Put a topic's own composer back — an empty one, when it has none. Each step only when it
   * changes something: grow() measures the textarea, which forces a layout in the middle of the
   * switch, and an empty composer replacing an empty one needs neither that nor new chips.
   */
  function loadDraft(id){
    var d = id ? drafts[id] : null;
    var next = d ? d.text : '', list = d ? d.files : [];
    var chipsChange = files.length || list.length;
    files = list;
    if(chipsChange) renderChips();
    if(input.value !== next){ input.value = next; suggest(); grow(); }
    if(d) try { input.setSelectionRange(d.s, d.e); } catch(x){}
    // "Compressing…" belongs to the composer whose pictures are being shrunk, not to whichever
    // one is on screen now.
    notePending();
  }

  /** Everything this page remembers about one topic, for a topic that no longer exists. */
  function forget(id){
    transcript.scroll.forgetView(id);
    cacheService.forget(id);
    delete preTried[id];
    for(var n in unsent) if(Object.prototype.hasOwnProperty.call(unsent, n) && unsent[n].t === id) dropUnsent(n);
    if(!drafts[id]) return;
    delete drafts[id];
    writeDraft(id);
  }

  /**
   * Forget the topics the list no longer carries — deleted here, in another tab, or by a clear.
   * Storage is only touched for a topic that actually had a draft or an unsent message.
   */
  function prune(){
    // An empty list is a list about to be replaced (the page creates a topic in answer), not an
    // instruction to throw every draft away.
    if(!topics.length) return;
    var known={}, id;
    for(var i=0;i<topics.length;i++) known[topics[i].id]=1;
    transcript.scroll.pruneViews(known);
    cacheService.prune(known);
    for(id in preTried) if(!known[id]) delete preTried[id];
    for(id in drafts) if(!known[id]) forget(id);
    for(id in unsent) if(Object.prototype.hasOwnProperty.call(unsent, id) && !known[unsent[id].t]) dropUnsent(id);
  }

  // The way out of the page, whichever it is. The hidden transition is "the last reliable time to
  // save app and user data"; beforeunload and unload are not, since on mobile neither fires when a
  // tab or the browser itself is closed (developer.chrome.com, Page Lifecycle API, read
  // 2026-09-29). pagehide is the belt: a second write of an unchanged draft writes nothing.
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'hidden') stashDraft(topic); });
  window.addEventListener('pagehide', function(){ stashDraft(topic); });

  // ── Pictures are shrunk before they go ─────────────────────────────────────
  /**
   * A phone camera writes 3–10 MB for one photo, and what an agent can use of it is a fraction of
   * that: Claude sees about 1568 px on the long edge whatever is sent. Every byte above that is
   * paid for on the upload, over a mobile uplink, for nothing.
   *
   * So a still picture the browser can decode, and that is over 300 KB, is redrawn inside
   * 2048×1536 pixels — about 3.1 MP, which is what a model can use of a photo — and re-encoded at
   * the highest quality whose result fits under 300 KB: quality bisected between 0.5 and 0.92 at
   * that size, and the dimensions stepped down only when even 0.5 is too big. A re-encode that did
   * not come out smaller than the original is thrown away.
   *
   * Area, not a long edge, because the two pictures people send are shaped differently. A 1170×2532
   * phone screenshot is already under 3.1 MP, so it keeps its size and its text stays the size it
   * was; a 12 MP photo comes down to 2048×1536 whatever its shape. A 4096 px cap on one side is
   * there for the panorama that fits the area budget by being extremely long and thin, and the
   * floor below which shrinking stops is the area a 1024 px long edge would have at this shape.
   *
   * Never touched: GIF (a canvas keeps one frame, and the animation is the picture), SVG (the file
   * is text), and anything already at or under 300 KB. A decode or encode that fails sends the
   * original with a console warning — a slow send is a nuisance, a lost picture is not.
   *
   * Re-encoding drops EXIF, GPS included. That is a side benefit worth knowing, not the reason.
   */
  var SHRINK_LIMIT = 300 * 1024;
  var SHRINK_PIXELS = 2048 * 1536;
  var SHRINK_EDGE = 4096;
  var SHRINK_EDGE_MIN = 1024;
  // iOS refuses a canvas over 16,777,216 pixels and can answer with a blank one rather than an
  // error, so no canvas here is ever allowed past it.
  var CANVAS_MAX_PIXELS = 4096 * 4096;
  var SHRINK_QUALITY_MAX = 0.92;
  var SHRINK_QUALITY_MIN = 0.5;

  // What the browser might decode as a still. The MIME a picker gives is the first answer; an
  // empty one — a HEIC off an iPhone, through a picker that does not know the type — is read from
  // the name, which is what Safari goes by anyway. GIF and SVG are excluded here, not later.
  var STILL_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif|avif|bmp|x-ms-bmp)$/i;
  var STILL_NAME = /\.(jpe?g|png|webp|heic|heif|avif|bmp)$/i;
  function stillImage(f){
    var t = String(f.type || '').toLowerCase();
    if(t) return STILL_MIME.test(t);
    return STILL_NAME.test(String(f.name || ''));
  }

  /**
   * One file's bytes as the base64 the send API takes, or null when the browser could not read it.
   * A null is reported in #note by the caller: a picture that cannot be attached must not vanish
   * without a word.
   */
  function readBase64(blob){
    return new Promise(function(resolve){
      var r = new FileReader();
      r.onload = function(){
        var s = String(r.result), c = s.indexOf(',');
        resolve(c < 0 ? '' : s.slice(c + 1));
      };
      r.onerror = function(){ resolve(null); };
      r.readAsDataURL(blob);
    });
  }

  /**
   * The decoded picture: a bitmap when the browser has createImageBitmap, an <img> otherwise.
   *
   * createImageBitmap is first because it decodes a File directly — no URL at all, which matters
   * since the page's CSP is img-src 'self' data: and a blob: URL would be refused — and its
   * imageOrientation:'from-image' applies the EXIF rotation a phone saved the shot with. A
   * browser that lacks it, or refuses this file, gets the data: URL and an <img>, which those
   * browsers rotate themselves when drawing.
   */
  function decodePhoto(f){
    var attempt = null;
    if(typeof createImageBitmap === 'function'){
      try { attempt = createImageBitmap(f, {imageOrientation:'from-image'}); } catch(x){ attempt = null; }
    }
    if(attempt && typeof attempt.then === 'function')
      return attempt.then(function(b){ return b; }, function(){ return decodeViaImg(f); });
    return decodeViaImg(f);
  }
  function decodeViaImg(f){
    return readBase64(f).then(function(b64){
      if(b64 === null) throw new Error('the file could not be read');
      return new Promise(function(resolve, reject){
        var img = new Image();
        img.onload = function(){ resolve(img); };
        img.onerror = function(){ reject(new Error('the browser cannot decode it')); };
        img.src = 'data:' + (f.type || '') + ';base64,' + b64;
      });
    });
  }
  function closePhoto(p){ if(p && p.close){ try { p.close(); } catch(x){} } }

  /** A canvas with high-quality smoothing on: the default filter is what makes a shrunk picture soft. */
  function paintCanvas(w, h){
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    if(!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    if('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    return {canvas:canvas, ctx:ctx};
  }

  /**
   * The picture drawn at a fraction of its own pixels, never enlarged.
   *
   * A single drawImage of an 8000 px photo down to 2048 aliases badly — thin lines and text break
   * up — so while the source is more than twice the target in both directions it is halved into
   * an intermediate canvas first. Each of those is one high-quality resample rather than one
   * huge jump.
   */
  function canvasAt(img, scale){
    var iw = img.width, ih = img.height;
    if(!iw || !ih) return null;
    var w = Math.max(1, Math.round(iw * scale));
    var h = Math.max(1, Math.round(ih * scale));
    var from = img, fw = iw, fh = ih;
    // One halving of an 80 MP source is still 20 MP — over the cap, and a canvas over it can come
    // back blank. Come inside the cap in one step before the halving loop starts.
    if(fw * fh > CANVAS_MAX_PIXELS){
      var fit = Math.sqrt(CANVAS_MAX_PIXELS / (fw * fh));
      var cw = Math.max(w, Math.floor(fw * fit)), ch = Math.max(h, Math.floor(fh * fit));
      var first = paintCanvas(cw, ch);
      if(!first) return null;
      first.ctx.drawImage(from, 0, 0, cw, ch);
      from = first.canvas; fw = cw; fh = ch;
    }
    while(fw > w * 2 && fh > h * 2){
      var mw = Math.max(w, Math.round(fw / 2)), mh = Math.max(h, Math.round(fh / 2));
      var mid = paintCanvas(mw, mh);
      if(!mid) return null;
      mid.ctx.drawImage(from, 0, 0, mw, mh);
      from = mid.canvas; fw = mw; fh = mh;
    }
    var out = paintCanvas(w, h);
    if(!out) return null;
    out.ctx.drawImage(from, 0, 0, w, h);
    return out.canvas;
  }

  /**
   * Encode one canvas, or null if the browser would not.
   *
   * The blob's own type is checked against the one asked for because iOS Safari quietly answers a
   * WebP request with a PNG; a PNG wearing a .webp name is worse than no shrink at all. A JPEG
   * gets a white ground first: JPEG has no alpha, and every transparent pixel would otherwise
   * turn black.
   */
  function encodeAs(canvas, mime, quality){
    if(mime === 'image/jpeg'){
      var flat = paintCanvas(canvas.width, canvas.height);
      if(!flat) return Promise.resolve(null);
      flat.ctx.fillStyle = '#fff';
      flat.ctx.fillRect(0, 0, canvas.width, canvas.height);
      flat.ctx.drawImage(canvas, 0, 0);
      canvas = flat.canvas;
    }
    return new Promise(function(resolve){
      try {
        canvas.toBlob(function(blob){ resolve(blob && blob.type === mime ? blob : null); }, mime, quality);
      } catch(x){ resolve(null); }
    });
  }

  /** Whether this browser really encodes WebP, asked once with a 1×1 canvas and remembered. */
  var webpProbe = null;
  function canEncodeWebp(){
    if(webpProbe) return webpProbe;
    webpProbe = new Promise(function(resolve){
      try {
        var c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        c.toBlob(function(b){ resolve(Boolean(b && b.type === 'image/webp')); }, 'image/webp', 0.8);
      } catch(x){ resolve(false); }
    });
    return webpProbe;
  }

  /**
   * The highest quality whose blob fits, by bisection. Five rounds take 0.5–0.92 down to about
   * 0.013, finer than one JPEG quantisation step, and each round is a full encode at 2048 px —
   * so more rounds would cost a visible moment for bytes nobody can see.
   */
  function findQuality(canvas, mime, limit, lo, hi, best, rounds){
    if(rounds <= 0 || hi - lo < 0.05) return Promise.resolve(best);
    var q = (lo + hi) / 2;
    return encodeAs(canvas, mime, q).then(function(blob){
      if(!blob) return best;
      if(blob.size <= limit) return findQuality(canvas, mime, limit, q, hi, blob, rounds - 1);
      return findQuality(canvas, mime, limit, lo, q, best, rounds - 1);
    });
  }

  /**
   * One size: the top quality first (most screenshots fit there), then the bottom one to learn
   * whether this size can fit at all, then the bisection between them. blob is the smallest
   * encode made either way, because when no size fits that is what gets kept.
   */
  function encodeAtSize(canvas, mime, limit){
    var smallest = null;
    function note(blob){
      if(blob && (!smallest || blob.size < smallest.size)) smallest = blob;
      return blob;
    }
    return encodeAs(canvas, mime, SHRINK_QUALITY_MAX).then(function(top){
      note(top);
      if(top && top.size <= limit) return {fits:true, blob:top};
      return encodeAs(canvas, mime, SHRINK_QUALITY_MIN).then(function(bottom){
        note(bottom);
        if(!bottom || bottom.size > limit) return {fits:false, blob:smallest};
        return findQuality(canvas, mime, limit, SHRINK_QUALITY_MIN, SHRINK_QUALITY_MAX, bottom, 5)
          .then(function(best){ note(best); return {fits:true, blob:best || bottom}; });
      });
    });
  }

  /** Whether this one is worth the canvas at all. Asked twice: once to say "Compressing…", once to work. */
  function willShrink(f){
    return Boolean(f && f.size && f.size > SHRINK_LIMIT && stillImage(f));
  }

  /**
   * The smaller picture, or null to send the file as it is.
   *
   * Rejects nothing: every failure — no decoder, a canvas that will not give a context, an encoder
   * that returns nothing — ends in null and a warning, because the person attached a picture and
   * the send is not allowed to lose it.
   */
  function shrinkPhoto(file){
    if(!willShrink(file)) return Promise.resolve(null);
    var photo = null;
    return decodePhoto(file).then(function(img){
      photo = img;
      return canEncodeWebp();
    }).then(function(webp){
      if(!photo) return null;
      /**
       * One pass at one format: the smallest encode made at each size, and whether the encoder
       * produced anything at all. That second answer is what tells a too-big picture apart from
       * a format this browser will not write.
       */
      function attempt(mime){
        var smallest = null, any = false;
        var w = photo.width, h = photo.height;
        var long = Math.max(w, h) || 1;
        var scale = Math.min(1, Math.sqrt(SHRINK_PIXELS / (w * h)), SHRINK_EDGE / long);
        // The floor is the area a 1024 px long edge would have at this shape: below it a picture
        // would fit by being too small to read, and what was made so far is the answer instead.
        var floor = Math.min(1, SHRINK_EDGE_MIN / long);
        function step(){
          var canvas = canvasAt(photo, scale);
          if(!canvas) return Promise.resolve({blob:smallest, any:any});
          return encodeAtSize(canvas, mime, SHRINK_LIMIT).then(function(out){
            if(out.blob){
              any = true;
              if(!smallest || out.blob.size < smallest.size) smallest = out.blob;
            }
            if(out.fits) return {blob:out.blob, any:true};
            // Nothing at all, even at the bottom quality: a smaller canvas would fail the same
            // way, so only the format is worth another try.
            if(!out.blob) return {blob:smallest, any:any};
            var next = scale * 0.72;
            if(!(next < scale) || next < floor) return {blob:smallest, any:any};
            scale = Math.max(floor, next);
            return step();
          });
        }
        return step();
      }
      if(!webp) return attempt('image/jpeg').then(function(r){ return r.blob; });
      return attempt('image/webp').then(function(r){
        // The 1×1 probe can be right and a full-size canvas wrong: iOS Safari answers the probe
        // with WebP and a real encode with PNG, which encodeAs refuses. Nothing came back, so
        // JPEG is still worth trying.
        if(r.any) return r.blob;
        return attempt('image/jpeg').then(function(j){ return j.blob; });
      });
    }).then(function(blob){
      closePhoto(photo);
      // Not smaller than what was attached means the re-encode spent quality and saved nothing.
      return blob && blob.size < file.size ? {blob:blob} : null;
    }, function(x){
      closePhoto(photo);
      console.warn('fleetherd: could not shrink ' + (file.name || 'a picture') + '; sending the original', x);
      return null;
    });
  }

  /**
   * The extension follows the bytes. The daemon sniffs the magic number, so a wrong name is not a
   * format bug — but a JPEG called IMG_0001.HEIC is a trap for whoever saves it later, and the
   * agent reads the name too.
   */
  function withMime(name, mime){
    var base = String(name || 'image');
    // Only a known picture extension is replaced. "2026.11 photo" is a name, not a .11 photo.
    if(STILL_NAME.test(base)) base = base.replace(/\.[^.]*$/, '');
    var sub = mime === 'image/jpeg' ? 'jpg' : String(mime || '').split('/')[1];
    return (base || 'image') + '.' + (sub || 'jpg').toLowerCase();
  }

  /**
   * What each composer is still waiting for, by topic, and the Send tap that arrived during the
   * wait. Both are per topic: a picture being shrunk in one conversation must not hold up a send
   * in another, and "Compressing…" may only appear over the composer it belongs to. A picture
   * smaller than 300 KB is not worth a canvas, so it never counts here.
   */
  var pendingBy = {}, shrinkingBy = {}, queuedSend = null, noteOwner = null;
  function countUp(map, id){ map[id] = (map[id] || 0) + 1; }
  function countDown(map, id){
    if((map[id] || 0) > 1) map[id]--;
    else delete map[id];
  }
  function notePending(){
    var n = shrinkingBy[topic] || 0;
    if(!n){ clearPendingNote(); return; }
    if(noteOwner === null && note.textContent) return;
    noteOwner = n > 1 ? tr('composer.compressingMany', { count: n }) : tr('composer.compressingOne');
    note.textContent = noteOwner;
  }
  function clearPendingNote(){
    if(noteOwner !== null && note.textContent === noteOwner) note.textContent = '';
    noteOwner = null;
  }
  /**
   * One file has become an attachment, or failed to. A queued Send happens only if the person is
   * still in the topic they pressed it in and nothing else is still coming there; a switch away
   * cancels it, and the text and picture stay in that topic's draft for when they come back.
   */
  function settled(into, tookCanvas){
    countDown(pendingBy, into);
    if(tookCanvas) countDown(shrinkingBy, into);
    if(into === topic) notePending();
    if(pendingBy[into]) return;
    var queued = queuedSend;
    if(!queued || queued.topic !== into) return;
    queuedSend = null;
    if(into === topic) send();
  }

  // The rename argument exists for the clipboard, which is the one source that hands over files
  // the browser has already named badly — see the paste handler below. Everything else passes
  // the name through, and this stays the single place a file becomes a chip.
  function take(list, rename){
    // The topic this is being attached in, fixed now: the shrink and the FileReader both answer a
    // turn or more later, and a topic switched to in between must not receive a file picked in
    // the one before it.
    var into = topic;
    for(var i=0;i<list.length;i++){
      (function(f){
        // The name is fixed here rather than after the shrink: the clipboard's counter has to
        // advance in the order the files were handed over, or two pastes share one name.
        var name = (rename ? rename(f) : f.name) || 'file';
        var tookCanvas = willShrink(f);
        countUp(pendingBy, into);
        if(tookCanvas) countUp(shrinkingBy, into);
        notePending();
        shrinkPhoto(f).then(function(out){
          var blob = out ? out.blob : f;
          var mime = out ? out.blob.type : (f.type || '');
          if(out) name = withMime(name, mime);
          return readBase64(blob).then(function(data){
            if(data === null){
              // Degrade explicitly: the picture is not attached, and #note names the one that
              // failed — in the composer it was attached in, never over whichever topic is on
              // screen now.
              if(into === topic){
                noteOwner = null;
                note.textContent = tr('composer.readFileFailed', { name: name });
              } else {
                console.warn('fleetherd: could not read ' + name + '; it was not attached');
              }
              return;
            }
            var file = {name:name, mime:mime, data:data};
            if(!into || into === topic){ files.push(file); renderChips(); return; }
            var d = drafts[into] || (drafts[into] = {text:'', s:0, e:0, files:[]});
            d.files.push(file);
          });
        }).then(function(){ settled(into, tookCanvas); }, function(x){
          // Nothing above is supposed to reject; if it ever does, the send must still be let go.
          console.warn('fleetherd: could not prepare ' + name + '; it was not attached', x);
          settled(into, tookCanvas);
        });
      })(list[i]);
    }
  }

  // Every engine calls a pasted screenshot 'image.png', so two of them in one message would
  // arrive as two attachments neither the chips nor the agent can tell apart. A counter is
  // enough: the name only has to be distinct within the message being composed.
  var pastes = 0;
  function pastedName(f){
    var type = f.type || 'image/png';
    var slash = type.indexOf('/');
    var ext = slash > 0 ? type.slice(slash+1).split(';')[0].split('+')[0] : 'png';
    pastes++;
    return 'pasted-' + pastes + '.' + ext;
  }

  picker.addEventListener('change', function(){ take(picker.files); picker.value=''; });
  $('attach').addEventListener('click', function(){ picker.click(); });
  document.addEventListener('dragover', function(e){ e.preventDefault(); });
  document.addEventListener('drop', function(e){
    e.preventDefault();
    // Not while a conversation from History covers the composer: the file would go, unseen, to the
    // topic underneath.
    if(libOn()) return;
    if(e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files);
  });
  // Ctrl-V of a screenshot, which is the thing most worth showing an agent and the slowest to
  // get to it any other way. On the document rather than the textarea: the composer is not
  // necessarily focused after clicking a topic or a button, and a paste that reaches nothing is
  // indistinguishable from a broken feature. The login field is the only other paste target on
  // the page and a file is not a token, so nothing is taken away from it.
  //
  // preventDefault only once a file has actually been picked up. A clipboard carrying an image
  // usually carries an img tag in text/html beside it — swallowing that is the point — but a
  // plain text paste must still land in the textarea the ordinary way.
  document.addEventListener('paste', function(e){
    var items = e.clipboardData && e.clipboardData.items;
    if(!items || libOn()) return;
    var found = [];
    for(var i=0;i<items.length;i++){
      if(items[i].kind !== 'file') continue;
      var f = items[i].getAsFile();
      if(f) found.push(f);
    }
    if(!found.length) return;
    e.preventDefault();
    take(found, pastedName);
  });

  /**
   * The voice-message button: tap to record, tap again to send.
   *
   * A recording is sent the moment it stops, as a message of its own, and the composer is left
   * alone. Both halves are load-bearing. The daemon transcribes a message that is audio and NOTHING
   * else (core/voice.ts) — a recording sent together with a half-typed draft would be read as a
   * file with a caption, and handed to the agent untranscribed. And whatever was being typed is
   * the user's, so recording must not cost it.
   *
   * The format is the browser's to choose, in this order: Ogg/Opus (Firefox), WebM/Opus
   * (Chromium), MP4/AAC (Safari) — the transcriber takes all three. Capped at ten minutes, which
   * is far past any voice message and well inside what the daemon will transcribe; at the cap it
   * stops and sends rather than discarding what was said. Esc throws a recording away.
   */
  var micBtn=$('mic'), rec=null, recStarting=false, recTranscribing=false, voices=0;
  var MIC_TYPES=['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/mp4','audio/webm'];
  var MIC_MAX_MS=10*60*1000;
  var MIC_BITRATE=24000;
  micBtn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  function recordType(){
    for(var i=0;i<MIC_TYPES.length;i++){
      try { if(MediaRecorder.isTypeSupported(MIC_TYPES[i])) return MIC_TYPES[i]; } catch(e){}
    }
    return '';
  }
  function micLabel(){
    if(recTranscribing){
      micBtn.innerHTML=IC.icon.mic;
      micBtn.classList.remove('rec');
      micBtn.disabled=true;
      micBtn.title=tr('composer.micTranscribing');
      return;
    }
    micBtn.disabled=false;
    if(!rec){ micBtn.innerHTML=IC.icon.mic; micBtn.classList.remove('rec'); micBtn.title=tr('composer.micTitle'); return; }
    var s=Math.floor((Date.now()-rec.started)/1000);
    micBtn.innerHTML=IC.icon.stop+' '+Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
    micBtn.classList.add('rec');
    micBtn.title=tr('composer.micStopTitle');
  }
  function micFailed(e){
    recStarting=false;
    note.textContent=tr('composer.micFailed', { err: (e && (e.message || e.name)) || tr('composer.micUnavailable') });
    micLabel();
  }
  function releaseMic(r){ r.stream.getTracks().forEach(function(t){ t.stop(); }); }
  function voiceExt(mime){ var sub=mime.split('/')[1] || 'webm'; return sub==='mp4' ? 'm4a' : sub; }
  function appendDictation(into, text){
    if(!text) return;
    if(into && into !== topic){
      var d = drafts[into] || (drafts[into] = {text:'', s:0, e:0, files:[]});
      var join = d.text && !/\s$/.test(d.text) ? ' ' : '';
      d.text = d.text + join + text;
      d.s = d.e = d.text.length;
      writeDraft(into);
      return;
    }
    var cur = input.value;
    var sep = cur && !/\s$/.test(cur) ? ' ' : '';
    input.value = cur + sep + text;
    input.selectionStart = input.selectionEnd = input.value.length;
    grow();
    if(topic) stashDraft(topic);
    input.focus();
  }
  function dictateOrSend(into, mime, b64){
    recTranscribing=true;
    micLabel();
    note.textContent=tr('composer.micTranscribing');
    var fallback=function(){
      voices++;
      note.textContent='';
      dispatch('', [{name:'voice-'+voices+'.'+voiceExt(mime), mime:mime, data:b64}]);
    };
    post('api/voice/transcribe', {mime:mime, data:b64}, 1, 95000).then(function(res){
      recTranscribing=false;
      micLabel();
      if(res.status === 404){ fallback(); return; }
      return res.json().catch(function(){ return null; }).then(function(data){
        if(!data || typeof data.ok !== 'boolean'){
          if(res.ok){ fallback(); return; }
          note.textContent=tr('composer.micTranscribeFailed', { err: (data && data.error) || ('HTTP '+res.status) });
          return;
        }
        if(!data.ok){
          note.textContent=data.noSpeech
            ? tr('composer.micNoSpeech')
            : tr('composer.micTranscribeFailed', { err: data.reason || 'unknown error' });
          return;
        }
        var out = data.cleaned || data.text || '';
        appendDictation(into, out);
        var sec = ((data.latencyMs || 0) / 1000).toFixed(1);
        note.textContent = (data.cleaned && data.text && data.cleaned !== data.text)
          ? tr('composer.micTranscribedWithRaw', { seconds: sec, raw: data.text })
          : tr('composer.micTranscribed', { seconds: sec });
      });
    }, function(e){
      recTranscribing=false;
      micLabel();
      note.textContent=tr('composer.micTranscribeFailed', { err: (e && e.message) || 'network error' });
    });
  }

  function startRec(){
    recStarting=true;
    var into=topic;
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      recStarting=false;
      var type=recordType(), mr;
      try {
        var opts = type ? {mimeType:type, audioBitsPerSecond:MIC_BITRATE} : {audioBitsPerSecond:MIC_BITRATE};
        mr = new MediaRecorder(stream, opts);
      } catch(e){
        try { mr = type ? new MediaRecorder(stream, {mimeType:type}) : new MediaRecorder(stream); }
        catch(e2){ stream.getTracks().forEach(function(t){ t.stop(); }); micFailed(e2); return; }
      }
      var r={mr:mr, stream:stream, type:type, parts:[], started:Date.now(), keep:true, timer:0, cap:0};
      mr.ondataavailable=function(ev){ if(ev.data && ev.data.size) r.parts.push(ev.data); };
      mr.onstop=function(){
        releaseMic(r);
        if(!r.keep || !r.parts.length) return;
        var mime=(mr.mimeType || r.type || 'audio/webm').split(';')[0];
        var fr=new FileReader();
        fr.onload=function(){
          var s=String(fr.result), c=s.indexOf(',');
          dictateOrSend(into, mime, c<0?'':s.slice(c+1));
        };
        fr.readAsDataURL(new Blob(r.parts, {type:mime}));
      };
      rec=r;
      mr.start();
      r.timer=setInterval(micLabel, 1000);
      r.cap=setTimeout(function(){ stopRec(true); }, MIC_MAX_MS);
      note.textContent='';
      micLabel();
    }, micFailed);
  }
  function stopRec(keep){
    var r=rec;
    if(!r) return;
    rec=null;
    r.keep=keep;
    clearInterval(r.timer); clearTimeout(r.cap);
    micLabel();
    try { r.mr.stop(); } catch(e){ releaseMic(r); }
  }
  micBtn.addEventListener('click', function(){
    if(rec) stopRec(true);
    else if(!recStarting && !recTranscribing && topic) startRec();
  });
  // Escape throws a recording away — unless it is an IME cancelling its candidate list, which is
  // a different Escape and must not also cost the recording. Captured, and stopped there: while a
  // recording is running Escape belongs to it, not to whatever the focus is on — the filter bar's
  // own handler would otherwise fold its panel and swallow the keystroke.
  document.addEventListener('keydown', function(e){
    if(e.isComposing) return;
    if(e.key === 'Escape' && rec){ stopRec(false); e.stopPropagation(); }
  }, true);

  function suggest(){
    var v=input.value;
    var picked=takesArg(v);
    if(picked){
      hints.innerHTML='<span class="arg-hint"><b>/'+text(picked.name)+' &lt;'+text(picked.options[0].name)+'&gt;</b> — '+text(picked.description)+'</span>';
      hints.hidden=false;
      return;
    }
    if(v.charAt(0)!=='/' || v.indexOf(' ')>=0 || v.indexOf('\n')>=0){ hints.hidden=true; hints.innerHTML=''; return; }
    var q=v.slice(1).toLowerCase();
    var hit=commands.filter(function(c){ return c.name.indexOf(q)===0; }).slice(0,8);
    if(!hit.length){ hints.hidden=true; hints.innerHTML=''; return; }
    var h='';
    for(var i=0;i<hit.length;i++) h += '<button type="button" data-cmd="'+text(hit[i].name)+'" title="'+text(hit[i].description)+'">/'+text(hit[i].name)+'</button>';
    hints.innerHTML=h; hints.hidden=false;
  }

  /**
   * The command just chosen, when it takes an argument and nothing has been typed after it yet —
   * "/super " and no job. The list it was picked from has gone by then, and with it the only place
   * its description was (a button's title, which a phone never shows), so the hint row says what
   * comes next instead. Gone at the first character typed.
   */
  function takesArg(v){
    if(v.charAt(0)!=='/' || v.charAt(v.length-1)!==' ') return null;
    var name=v.slice(1,-1);
    for(var i=0;i<commands.length;i++){
      var c=commands[i];
      if(c.name===name && c.options && c.options.length) return c;
    }
    return null;
  }

  hints.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button[data-cmd]') : null;
    if(!b) return;
    input.value='/'+b.getAttribute('data-cmd')+' ';
    suggest(); input.focus(); grow();
  });

  /**
   * The request bodies of sends that have not been acknowledged, by nonce — what Retry re-posts.
   *
   * In memory only: the body carries the attachments as base64, which is not something to write
   * into localStorage. What IS written down is the message itself, in unsent below; a text-only
   * body is rebuilt from that after a reload, so only a message that carried files loses its Retry.
   */
  var outbox = {};

  /**
   * Every message sent from this page that the daemon has not acknowledged, by nonce, written
   * through to localStorage at the moment it is sent — before the request leaves, and before the
   * composer's draft is cleared, so there is no instant at which the text is in neither place.
   *
   * This is what a connection that goes away mid-send costs nothing of. A Cloudflare Access session
   * that expires answers every request with a redirect to its sign-in page, so the send fails, the
   * stream cannot reconnect, and the only way back is a reload; a dead link is the same with a grey
   * bubble instead of a red one. Before this the bubble was all there was of the message: one still
   * in flight at the reload was gone, and one that had failed came back from the transcript cache
   * only to be sorted above the whole topic by the first sync. And a send still in flight when the
   * topic was switched away from failed with no bubble left to turn red.
   *
   * A record goes when the daemon has it — a 2xx, or its echo, in an event or in a sync — or when
   * it is discarded, or its topic is. { t: topic, x: text, n: file names, at, s: 'sending' |
   * 'failed' | 'unsure', g: the daemon's epoch when it was sent }. Text over DRAFT_MAX is kept in
   * memory only, for the same reason a draft that long is.
   */
  var UNSENT='aa_unsent';
  var unsent={};
  (function(){
    var saved=null;
    try { saved = JSON.parse(localStorage.getItem(UNSENT) || 'null'); } catch(x){}
    if(!saved || typeof saved !== 'object') return;
    for(var n in saved){
      var r = saved[n];
      if(!Object.prototype.hasOwnProperty.call(saved, n) || !r || typeof r.t !== 'string' || typeof r.x !== 'string') continue;
      // Anything not known to have failed was on its way when the last page went away, and nothing
      // that page saw can say how that ended. The first sync can.
      unsent[n] = {t:r.t, x:r.x, n:Array.isArray(r.n) ? r.n.map(String) : [], at:Number(r.at) || 0,
        s:r.s === 'failed' ? 'failed' : 'unsure', g:Number(r.g) || 0};
    }
  })();

  /**
   * Write one record through, leaving every other one as it is ON DISK — a second tab on this origin
   * has sends of its own, and its record must not be put back after it has been acknowledged there.
   */
  function writeUnsent(nonce){
    try {
      var all = JSON.parse(localStorage.getItem(UNSENT) || 'null') || {};
      var r = unsent[nonce];
      if(r && r.x.length <= DRAFT_MAX) all[nonce] = r;
      else if(Object.prototype.hasOwnProperty.call(all, nonce)) delete all[nonce];
      else return;
      var left = false;
      for(var k in all) if(Object.prototype.hasOwnProperty.call(all, k)){ left = true; break; }
      if(left) localStorage.setItem(UNSENT, JSON.stringify(all)); else localStorage.removeItem(UNSENT);
    } catch(x){}
  }

  function dropUnsent(nonce){
    if(!unsent[nonce]) return;
    delete unsent[nonce];
    writeUnsent(nonce);
  }

  /** The bubble for one record, in the shape dispatch draws one. */
  function localMsg(nonce, r){
    return { id:'p:'+nonce, _local:1, _nonce:nonce, _state:r.s, _text:r.x,
      own:true, html:localBody(r.x, r.n), at:r.at, buttons:[], reactions:[] };
  }

  /**
   * Draw what was sent into this topic and not acknowledged, oldest first, where it is not drawn
   * already. A text-only one gets its body back, which is all Retry needs; nonce and all, so a Retry
   * of one that did land is answered as the duplicate it is.
   */
  function showUnsent(tId){
    var list=[];
    for(var n in unsent){
      if(Object.prototype.hasOwnProperty.call(unsent, n) && unsent[n].t === tId && !data['p:'+n] && !topicStatus.hasLocalPending(n)) list.push(n);
    }
    if(!list.length) return;
    list.sort(function(a, b){ return unsent[a].at - unsent[b].at; });
    var stick = atBottom();
    for(var i=0;i<list.length;i++){
      var r = unsent[list[i]];
      if(!outbox[list[i]] && !r.n.length) outbox[list[i]] = {topic:r.t, text:r.x, nonce:list[i]};
      data['p:'+list[i]] = localMsg(list[i], r);
      paint('p:'+list[i]);
    }
    sinkLocals();
    syncEmptyNote();
    if(stick) toBottom();
  }

  /**
   * After a sync: a message restored as 'unsure' that it did not claim never arrived — provided the
   * daemon that answered is the one it was sent to. A restarted one starts with an empty ring, so
   * its silence says nothing, and the message goes on saying it does not know.
   */
  function settleUnsure(){
    for(var n in unsent){
      if(!Object.prototype.hasOwnProperty.call(unsent, n)) continue;
      var r = unsent[n];
      if(r.t === topic && r.s === 'unsure' && r.g && r.g === epoch) setLocal(n, 'failed');
    }
  }

  /**
   * A failure out of a transcript cache written before unsent existed, when the cache was where a
   * failed message was kept. Moved here, because the cache no longer carries local messages and the
   * next write of it would otherwise lose this one a reload later.
   */
  function adoptLegacy(m){
    var n = m._nonce;
    if(!n || unsent[n]) return false;
    var t = document.createElement('template');
    t.innerHTML = String(m.html || '');
    var chips = t.content.querySelectorAll('.files .chip'), names = [];
    for(var i=0;i<chips.length;i++) names.push(chips[i].textContent);
    unsent[n] = {t:topic, x:String(m._text || ''), n:names, at:Number(m.at) || 0, s:'failed', g:0};
    writeUnsent(n);
    return true;
  }

  /**
   * The same shape renderBody builds server-side, minus the pictures, so the echo can replace it in
   * place. The pictures arrive with the echo: they are served from the daemon's copy, and drawing
   * them here would mean putting the whole file into this bubble as a data: URL — which a bubble
   * rebuilt from unsent after a reload could not do again, since unsent keeps names and never bytes.
   */
  function localBody(typed, names){
    var h = '<div class="raw">'+text(typed)+'</div>';
    if(!names.length) return h;
    var chips='';
    for(var i=0;i<names.length;i++) chips += '<span class="chip">'+text(names[i])+'</span>';
    return h + '<div class="files">'+chips+'</div>';
  }

  /**
   * Show the message, then send it — in that order, and independently.
   *
   * Waiting for the daemon's echo to draw it meant a visibly empty transcript for as long as the
   * round trip took, and on a request that failed after its retries it meant the text was gone:
   * out of the composer, never into the conversation, nowhere to copy it back from. The local
   * bubble is the message until the echo claims it, and if nothing ever claims it, it stays and
   * says so.
   */
  function shouldQueueOptimistically(typed){
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    if(!cur || !cur.running || cur.asking) return false;
    if(/^\s*\//.test(typed)) return false;
    return true;
  }

  function send(){
    // A picture still being shrunk in THIS topic is not in files yet, so a send now would leave
    // it out — or wait for nothing and look broken. The tap is remembered for this topic and
    // happens when its last picture lands; #note says why nothing moved yet, unless it is
    // carrying something of its own. Another topic's pictures do not hold this send.
    if(pendingBy[topic]){
      queuedSend = {topic:topic};
      notePending();
      return;
    }
    var typed = input.value;
    if(!typed.trim() && !files.length) return;
    var attached = files;
    input.value=''; files=[]; renderChips(); suggest(); grow();
    // Dispatched first, because dispatch is what writes the message down as unsent. Only then is
    // the stored draft of this topic cleared — left on disk, a reload would put it back in the
    // composer to be sent again.
    dispatch(typed, attached);
    stashDraft(topic);
  }

  /**
   * Send a command on behalf of a control (Stop, the power button): exactly what typing it would
   * post — same bubble, same nonce, same echo — so the daemon has one way to be told and the
   * transcript records the command like any other.
   *
   * The composer is left alone on purpose. A half-written prompt is what someone reaching for Stop
   * mid-reply is most likely to have in there, and pressing it must not cost them that.
   */
  function command(text){
    if(topic) dispatch(text, []);
  }

  function dispatch(typed, attached){
    var nonce = Math.random().toString(36).slice(2)+Date.now().toString(36);
    var body = {topic:topic, text:typed, nonce:nonce};
    var names = [];
    for(var i=0;i<attached.length;i++) names.push(attached[i].name);
    if(attached.length) body.files = attached;
    outbox[nonce] = body;
    unsent[nonce] = {t:topic, x:typed, n:names, at:Date.now(), s:'sending', g:epoch};
    writeUnsent(nonce);
    if(shouldQueueOptimistically(typed)){
      topicStatus.addLocalPending({ topic: topic, nonce: nonce, content: typed, attachments: names.length, at: unsent[nonce].at });
    } else {
      data['p:'+nonce] = localMsg(nonce, unsent[nonce]);
      paint('p:'+nonce);
      // A side question opens its card at once, saying it is being asked: the answer can take a
      // while to start, and the line alone would not say anything was happening.
      if(btwAsked('p:'+nonce, data['p:'+nonce]) !== null) openBtw('p:'+nonce);
      syncEmptyNote();
      // Unconditionally, unlike an arriving message: you have just written this one, so wherever
      // you were in the history is not where you want to be now.
      toBottom();
    }
    deliver(nonce);
  }

  /**
   * Post one queued message, for the first time or on a Retry.
   *
   * The same nonce goes out every time on purpose: the server remembers the last 64 and answers
   * a repeat as if it were the original, so a Retry after a request that actually landed cannot
   * duplicate the message — and the echo of the first attempt retires this bubble either way.
   */
  function deliver(nonce){
    var body = outbox[nonce];
    if(!body) return;
    setLocal(nonce, 'sending');
    // post() can throw before it returns a promise — JSON.stringify on a body too big for the
    // engine to build as one string. Left to escape, the bubble stayed 'sending' for ever, because
    // nothing was attached that could ever change it; as a rejection it becomes a failure, with
    // Copy and Discard, like any other message that did not go.
    var sent;
    try { sent = post('api/send', body.files ? framed(body) : body, 2, sendLimit(body)); }
    catch(x){ sent = Promise.reject(x); }
    sent.then(function(r){
      setLocal(nonce, (r && r.ok) ? 'sent' : 'failed');
    }, function(){
      setLocal(nonce, 'failed');
    });
  }

  function setLocal(nonce, state){
    // The record first, and whether or not the bubble is on screen: a send still in flight when its
    // topic was switched away from settles here too, and the record is all that is left of it. A
    // 2xx is the daemon holding the message, so from there on its ring is what has it. Only a
    // change is written — a first attempt is already on disk as 'sending', put there by dispatch.
    var r = unsent[nonce];
    if(r && r.s !== state){
      if(state === 'sent'){
        delete unsent[nonce];
        // The daemon has the message, so a suggestion an Adopt opened this topic for is dealt
        // with — only if this message still carries it (settleAdopted).
        settleAdopted(r.t, r.x);
      } else r.s = state;
      writeUnsent(nonce);
    }
    if(topicStatus.hasLocalPending(nonce)){
      if(state === 'failed'){
        topicStatus.removeLocalPending(nonce);
        if(r && r.t === topic){
          data['p:'+nonce] = localMsg(nonce, r);
          paint('p:'+nonce);
          syncEmptyNote();
          toBottom();
        }
      }
      return;
    }
    var key='p:'+nonce, m=data[key];
    if(!m) return;
    // Measured before the repaint: a failure grows the bubble by a warning line and three
    // buttons, and a reader sitting at the bottom would otherwise have the new controls pushed
    // off the screen they were just looking at.
    var stick = atBottom();
    m._state = state;
    paint(key);
    if(stick) toBottom();
  }

  /**
   * Put text on the clipboard.
   *
   * With a fallback, because navigator.clipboard does not exist on an insecure origin and
   * plain http is exactly how this page is expected to be reached on a LAN. done() is told
   * which way it went, so the caller can say so rather than reporting success it did not have.
   */
  function copyText(s, done){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).then(function(){ done(true); }, function(){ done(fallbackCopy(s)); });
      return;
    }
    done(fallbackCopy(s));
  }

  function topicRef(t){
    return (t.title || tr('common.untitled')) + ' (' + INSTANCE_ID + ':main/' + t.id + ')';
  }

  function syncCopyRef(){
    if(libOn()){
      var ref = historyPanel.currentRef();
      copyRefBtn.hidden = !ref;
      copyRefBtn.title = ref ? tr('topic.copyRefWith', { ref: ref }) : tr('topic.copyRefBtn');
      return;
    }
    var cur = topicById(topic);
    copyRefBtn.hidden = !cur;
    copyRefBtn.title = cur ? tr('topic.copyRefWith', { ref: topicRef(cur) }) : tr('topic.copyRefBtn');
  }

  var copyNoteTimer = null;
  function flashCopyNote(msg){
    note.textContent = msg;
    clearTimeout(copyNoteTimer);
    copyNoteTimer = setTimeout(function(){
      if(note.textContent === msg) note.textContent = '';
    }, 2500);
  }

  function copyTopicRef(id){
    var t = topicById(id);
    if(!t) return;
    var ref = topicRef(t);
    copyText(ref, function(ok){
      flashCopyNote(ok ? tr('topic.copiedRef', { ref: ref }) : tr('topic.copyRefFailed'));
    });
  }

  function flashCopyBtn(btn, ok, restoreTitle, restoreLabel){
    var say = ok ? tr('common.copied') : tr('common.copyFailed');
    btn.innerHTML = ok ? IC.icon.check : IC.icon.cross;
    btn.title = say;
    btn.setAttribute('aria-label', say);
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(function(){
      btn.innerHTML = IC.icon.copy;
      btn.title = restoreTitle;
      btn.setAttribute('aria-label', restoreLabel);
    }, 1500);
  }

  /** The text of a failed message, on the clipboard. */
  function copyLocal(nonce, btn){
    var m=data['p:'+nonce]; if(!m) return;
    copyText(m._text, function(ok){ btn.textContent = ok ? tr('common.copied') : tr('common.selectAbove'); });
  }

  function fallbackCopy(s){
    // The temporary field takes the selection, and with it the focus. Keep what had it, take the
    // field out on every path (an execCommand that throws must not leave it in the page), and put
    // the focus back where the person left it.
    var prev = document.activeElement, ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      return Boolean(document.execCommand('copy'));
    } catch(x){ return false; }
    finally {
      if(ta && ta.parentNode) ta.parentNode.removeChild(ta);
      if(prev && prev.focus){ try { prev.focus(); } catch(x){} }
    }
  }

  function discardLocal(nonce){
    delete outbox[nonce];
    dropUnsent(nonce);
    drop('p:'+nonce);
    // For a failure an older page kept in the transcript cache: rewritten without it, or the next
    // read of the cache would bring it back.
    cacheSave();
  }

  input.addEventListener('input', function(){
    grow(); suggest();
    // Re-armed by every key, so it fires once typing pauses. stashDraft is what clears it, and every
    // switch calls that for the topic being left, so this never lands on the wrong one.
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function(){ stashDraft(topic); }, DRAFT_IDLE_MS);
  });
  /**
   * Enter sends and Shift-Enter writes a newline — except under the narrow-screen layout, where
   * the two are the other way round.
   *
   * 1.22.0 made Enter a newline on every width, and the half of that which was right is the
   * phone: held upright there is no Shift key to hold down, so Enter-to-send makes a multi-line
   * prompt impossible to type rather than merely awkward, and a stray Enter costs a half-written
   * one. Neither is true of a keyboard, where Shift-Enter is right there and every other chat
   * app on that screen sends on Enter — paying the cost of the phone's problem on a desktop buys
   * nothing. Ctrl/Cmd-Enter sends on both, so what 1.22.0 taught still works.
   *
   * narrow() is read per keypress rather than once: rotating a phone and dragging a window both
   * change the answer, and it is the same breakpoint the CSS uses to decide the layout — where
   * the phone layout applies, the phone's Enter applies.
   */
  input.addEventListener('keydown', function(e){
    // isComposing is an IME candidate being chosen, on either shortcut. It is a keystroke the
    // composer never sees the end of, and sending on it truncates the word being typed.
    if(e.key!=='Enter' || e.isComposing) return;
    if(e.ctrlKey || e.metaKey){ e.preventDefault(); send(); return; }
    if(e.shiftKey || e.altKey || narrow()) return;
    e.preventDefault(); send();
  });
  $('composer').addEventListener('submit', function(e){ e.preventDefault(); send(); });
  copyRefBtn.addEventListener('click', function(){
    var ref = libOn() ? historyPanel.currentRef() : (topicById(topic) ? topicRef(topicById(topic)) : null);
    if(!ref) return;
    copyText(ref, function(ok){
      flashCopyBtn(copyRefBtn, ok, tr('topic.copyRefWith', { ref: ref }), tr('topic.copyRefBtn'));
    });
  });
  killBtn.addEventListener('click', function(){ command('/kill'); });
  stopBtn.addEventListener('click', function(){ command('/stop'); });

  /**
   * Retire the local bubble this message is the echo of.
   *
   * The node is REUSED rather than replaced: creating another element with the same content
   * would re-run the fade-in and move the scroll under whoever is reading, for a message that
   * has been on screen since it was typed.
   */
  function claim(m){
    if(!m.nonce) return;
    topicStatus.removeLocalPending(m.nonce);
    var pk = 'p:' + m.nonce;
    delete outbox[m.nonce];
    // The echo can beat the 2xx: the daemon emits it before it answers the POST. The message has
    // gone out either way, so an Adopt's suggestion is settled here too — by the time setLocal
    // hears the 2xx there is no unsent record left for it to ask.
    var r = unsent[m.nonce];
    dropUnsent(m.nonce);
    if(r) settleAdopted(r.t, r.x);
    transcript.transferLocalKey(pk, (m.g || epoch) + ':' + m.id);
  }

  // What was being typed into this topic before the reload. A visit with no ?t= does not know its
  // topic yet, and picks its draft up from the first sync.
  if(topic && drafts[topic]) loadDraft(topic);

  // Reopens the pane a reload arrived in, when ?t= already named a topic. Without one this
  // does nothing and the sync handler picks it up instead.
  applyTerm();

  // In the one way a topic is entered. No sync has said which run of the daemon is on the other
  // end yet, so nothing is resumed: the stream opens at once and asks for a sync, and the copy this
  // browser already has is painted as it comes — on a slow link long before the stream has said
  // anything, and after a restart even though the daemon can no longer produce it. So is what was
  // sent from it and never acknowledged. A visit with no ?t= is painted from the sync instead.
  onLocaleChange(function(){
    applyDomI18n(document);
    paintLang();
    paintTheme();
    paintCalm();
    paintNotify();
    if(typeof micLabel === 'function' && $('mic')) micLabel();
    if(topicFilter && topicFilter.refreshI18n) topicFilter.refreshI18n(tr('sidebar.searchTopics'));
    transcript.refreshI18n();
    paintTopics();
    topicStatus.onLocaleChange();
    paintAges();
    for(var mk in els){
      if(Object.prototype.hasOwnProperty.call(els, mk) && data[mk]) paint(mk);
    }
    if(transcript.btw.isOpen()) renderBtw(false);
    settingsFeature.onLocaleChange();
    schedulesPanel.repaint();
    reviewsPanel.paint();
    historyPanel.repaint();
    skillsPanel.repaint();
    gitPanel.repaint();
    filesPanel.repaint();
    if(TERM_OK) paintFrames();
  });

  enter(topic);
})();
