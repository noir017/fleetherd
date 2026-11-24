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
import { createComposerController } from './features/topic/composer/index.js';
import { createNotifyController } from './features/notify/index.js';
import { createTerminalController } from './features/terminal/index.js';
import {
  createCodeViewLoader,
  createLightbox,
  createReader,
  formatByteSize,
} from './features/reader/index.js';
import { createLegacyShell } from './workbench/legacy-shell.js';

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
  var data={}, els={};
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
    hasLauncher: function(){ return Boolean(launchEl); },
    hasMessages: function(){ return Boolean(log.querySelector('.m')); },
    narrow: narrow,
    getIcons: function(){ return IC.icon; },
    inl: inl,
    setNote: function(msg){ note.textContent = msg; },
    onRetireLocalNonce: function(nonce){
      composerController.retireLocalNonce(nonce);
    },
    onRecallContent: function(content){
      composerController.recallContent(content);
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
  var composerController = createComposerController({
    els: {
      input: input,
      chips: chips,
      hints: hints,
      note: note,
      picker: picker,
      attachBtn: $('attach'),
      micBtn: $('mic'),
      composerForm: $('composer'),
      copyRefBtn: copyRefBtn,
      killBtn: killBtn,
      stopBtn: stopBtn,
    },
    overlays: overlays,
    instanceId: BOOT.instance || 'web',
    getTopic: function(){ return topic; },
    getTopics: function(){ return topics; },
    topicById: topicById,
    getEpoch: function(){ return epoch; },
    isNarrow: narrow,
    isHistoryOpen: libOn,
    getHistoryRef: function(){ return historyPanel.currentRef(); },
    getIcons: function(){ return IC.icon; },
    openShot: openShot,
    settleAdopted: settleAdopted,
    cacheSave: cacheSave,
    topicStatus: topicStatus,
    transcript: {
      getMessage: function(key){ return data[key]; },
      setMessage: function(key, msg){ data[key] = msg; },
      deleteMessage: function(key){ delete data[key]; delete sig[key]; },
      hasElement: function(key){ return Boolean(els[key]); },
      removeElement: function(key){ if(els[key]){ els[key].remove(); delete els[key]; } },
      adoptElement: function(fromKey, toKey){
        els[toKey] = els[fromKey];
        sig[toKey] = sig[fromKey];
        els[toKey].setAttribute('data-k', toKey);
        delete els[fromKey];
      },
      paint: paint,
      drop: drop,
      sinkLocals: sinkLocals,
      syncEmptyNote: syncEmptyNote,
      atBottom: atBottom,
      toBottom: toBottom,
      onBtwAsked: function(key, msg){ if(btwAsked(key, msg) !== null) openBtw(key); },
      onClaimKeyMoved: function(fromKey, toKey){
        if(btwKey === fromKey) btwKey = toKey;
        if(btwShut[fromKey]){ btwShut[toKey] = 1; delete btwShut[fromKey]; }
      },
    },
  });
  composerController.attach();
  function grow(){ composerController.grow(); }
  function stashDraft(id){ composerController.stashDraft(id); }
  function loadDraft(id){ composerController.loadDraft(id); }
  function showUnsent(tId){ composerController.showUnsent(tId); }
  function settleUnsure(){ composerController.settleUnsure(); }
  function adoptLegacy(m){ return composerController.adoptLegacy(m); }
  function command(cmd){ composerController.command(cmd); }
  function deliver(nonce){ composerController.deliver(nonce); }
  function copyText(s, done){ composerController.copyText(s, done); }
  function syncCopyRef(){ composerController.syncCopyRef(); }
  function copyTopicRef(id){ composerController.copyTopicRef(id); }
  function copyLocal(nonce, btn){ composerController.copyLocal(nonce, btn); }
  function discardLocal(nonce){ composerController.discardLocal(nonce); }
  function claim(m){ composerController.claim(m); }
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
      for(var k in opened){ if(Object.prototype.hasOwnProperty.call(opened, k) && k.indexOf(prefix) === 0) delete opened[k]; }
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
  // Last markup written per message, so a sync that re-sends an unchanged message touches no DOM.
  var sig={};
  // The tool-bubble lines a reader has opened, per message key. See lineOpen.
  var opened={};
  // Whether #log currently holds placeholders rather than messages, and whether the next sync is
  // the one that opens a topic (which lands at the bottom no matter where the old one was read).
  var skeleton=false, entering=true;
  // What the last sync said about this topic being older than the daemon, and the notice element
  // that says so. Both are per topic, so both are reset on the way into one.
  var stale=false, emptyEl=null;
  // The agents the last sync said this topic could still be given to (null once it cannot, or
  // when the daemon offered none), the element laying them out, and what it was drawn from.
  var launch=null, launchEl=null, launchSig='';
  // The machines the daemon cannot reach, by the name the topic list and the agent cards use →
  // since when (OfflineMachine), and what the list was drawn from. Replaced whole on every push.
  var offlineMachines={}, offlineSig='[]';
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

  function atBottom(){ return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function toBottom(){ log.scrollTop = log.scrollHeight; }

  // ── Where each topic was being read ────────────────────────────────────────
  /**
   * The place in a topic to come back to: the first message on screen when it was left, and how
   * far its top sat from the top of the viewport. No entry means the bottom — which is where a
   * reader who was following along wants to be, and where whatever was said while they were away
   * is going to land.
   *
   * A message rather than a scrollTop, because the transcript a topic comes back to is not the one
   * it was left with: it is rebuilt from its copy — from the database, only the tail of a topic too
   * large for its budget — and then reconciled against a ring of 1000, so the sync can put older
   * messages above the one being read. A pixel offset would land in the middle of those; a message
   * does not move.
   *
   * In memory only, and with no scroll listener. The whole cost is one measurement on the way out
   * of a topic, and one or two on the way back in (see land).
   */
  var views = {};
  // The view being restored on the way into the current topic, until its first sync has landed;
  // and the scrollTop that landing left behind, which is how a reader who has scrolled since is
  // told apart from one who has not. -1 until something has been landed.
  var view = null, landedAt = -1;

  /**
   * The first message whose bottom edge is below the top of the viewport. A binary search, since
   * the children are in vertical order and a topic can hold 1000 of them: every rect after the
   * first is read off a layout that is already up to date, so this forces one layout, not one per
   * message.
   */
  function firstVisible(){
    var kids = log.children, top = log.getBoundingClientRect().top;
    var lo = 0, hi = kids.length;
    while(lo < hi){
      var mid = (lo + hi) >> 1;
      if(kids[mid].getBoundingClientRect().bottom <= top) lo = mid + 1; else hi = mid;
    }
    // Past the divider, the waiting line and the placeholders: only a message has a key to find
    // again.
    for(var i=lo; i<kids.length; i++){ if(kids[i].getAttribute('data-k')) return kids[i]; }
    return null;
  }

  /** Remember where the topic being left was being read. */
  function saveView(id){
    if(!id) return;
    // Still on the way in: nothing on screen yet says more than the view being restored does, so
    // flicking through a topic before it has loaded must not forget where it was being read. A
    // reader who has scrolled the cached transcript since it was landed has answered for themselves.
    if(entering && (landedAt < 0 || log.scrollTop === landedAt)){
      if(view) views[id] = view; else delete views[id];
      return;
    }
    // No box to measure (the page is still laying out), or at the bottom, which is what no entry
    // already means.
    var el = (log.clientHeight && !atBottom()) ? firstVisible() : null;
    if(!el){ delete views[id]; return; }
    views[id] = { key: el.getAttribute('data-k'),
      off: el.getBoundingClientRect().top - log.getBoundingClientRect().top };
  }

  /**
   * Put the reader back where they left this topic, or at the bottom when there is nowhere to put
   * them: it was left there, it was never read, or the message they were on is no longer held.
   */
  function land(){
    var el = view && els[view.key];
    if(el) log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top - view.off;
    else toBottom();
    landedAt = log.scrollTop;
  }

  function clock(ms){
    var d=new Date(ms), p=function(n){ return (n<10?'0':'')+n; };
    return p(d.getHours())+':'+p(d.getMinutes());
  }

  /**
   * Draw one message, creating its element if this is the first sight of it.
   *
   * before is how cached history gets ABOVE a transcript the daemon has already sent: the node
   * is inserted in front of the first live message instead of appended after the last one.
   */
  function paint(key, before){
    var m=data[key]; if(!m) return;
    // A settings screen is drawn in the settings page, never in the transcript (see takeSettings).
    // The guard is here as well as at every call site because paint is the one funnel: an edit
    // that arrives through a path nobody thought of must not put the screen back in the log.
    if(m.settings || m.wasSettings) return;
    var el=els[key];
    if(!el){
      clearSkeleton();
      el=document.createElement('div');
      // The page's own key, on the node, so the order on screen can be read back off #log —
      // which is what the cache writes and what places the history divider.
      el.setAttribute('data-k', key);
      // before is where cached history goes; the waiting line, when one is up, is the last thing
      // in the log and has to stay there, so anything painted under it goes above it instead.
      var at = (before && before.parentNode === log) ? before : syncingEl;
      if(at) log.insertBefore(el, at); else log.appendChild(el);
      els[key]=el;
    }
    var out = msgMarkup(key, m, isHistory(m));
    // A side question's line says whether its answer has come, and an answer is held out of the
    // transcript only while its question is on the page: each repaints the other (btwLink).
    if(!btwNest) btwLink(key, m);
    // Write nothing when nothing changed. A sync re-paints every message it carries, and most of
    // them are messages already on screen unchanged — rewriting innerHTML for those would drop
    // the caret out of a selection, restart any <img> decode, and undo the enabled state of a
    // button the click handler just disabled, all for identical markup.
    if(sig[key]===out.h && el.className===out.cls) return;
    el.className = out.cls;
    el.innerHTML = out.h;
    sig[key] = out.h;
    codeBlocks(el);
  }

  // ── Code blocks (web-markdown.ts codeBlock) ────────────────────────────────
  // A fence arrives as a frame: a bar with its language, Wrap and Copy, over the plain pre. The two
  // buttons are answered here, and the colours are put on here, after the HTML has landed — the
  // server sends no colours, because it has no grammar and the code view's are in the bundle.

  /** Colouring a block longer than this would hold the page up for one block nobody reads whole. */
  var HL_MAX = 20000;
  /** How long after the last write the blocks still waiting are looked at again (hlSweep). */
  var HL_IDLE_MS = 250;
  /**
   * Coloured code, by language and text, so the same fence drawn again — a reply re-rendered around a
   * block that did not change, a topic opened again, the History tab — is coloured in the same task
   * as its HTML is written, before the browser paints, instead of flashing plain while the grammar is
   * asked again. Bounded, the least recently used out first (a Map keeps insertion order).
   */
  var hlCache = new Map(), HL_CACHE_MAX = 300;
  /** Per language: the highlight function, null while its grammar loads, false for none. */
  var hlFns = Object.create(null), hlWarned = false, hlTimer = 0;
  /** Which code blocks have Wrap on, by message key and position, so a re-render keeps the choice. */
  var cbWrapped = Object.create(null);

  /** The language a code element was fenced as, from the class web-markdown.ts gives it; '' for none. */
  function codeLang(code){
    var m = /(?:^|\s)language-(\S+)/.exec(code.className || '');
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * The message a running turn may still be writing: the newest in the transcript, while the topic's
   * turn is running. Read off the topic's row (kept by the list and by typing events alike) rather
   * than the typing line, which nothing resets when another topic is opened.
   */
  function liveEl(){
    var running = false;
    for(var i=0;i<topics.length;i++) if(topics[i].id===topic){ running = Boolean(topics[i].running); break; }
    if(!running) return null;
    for(var n = log.lastElementChild; n; n = n.previousElementSibling) if(n.hasAttribute('data-k')) return n;
    return null;
  }

  /**
   * Restore Wrap and colour the code blocks under root, right after its HTML was written.
   *
   * What can be done now is done now, in the same task as the write, so nothing flashes: a block
   * coloured before (hlCache), and — once its grammar has loaded — any block in a message that has
   * stopped changing. The rest waits for hlSweep: a grammar still loading, and the message a running
   * turn is still writing. That one stays plain until the turn ends or a newer message takes its
   * place, so a block being streamed is not re-coloured under the reader at every edit; the edits
   * themselves already arrive settled (room.ts SETTLE_MS), never per token.
   */
  function codeBlocks(root){
    if(!root || !root.querySelectorAll) return;
    // Every write, code or not: a message arriving under the live one is what ends that one's turn
    // to stay plain, and the sweep is what notices.
    hlLater();
    var frames = root.querySelectorAll('.cb'), i;
    for(i=0;i<frames.length;i++){
      var k = cbKey(frames[i]);
      if(k && cbWrapped[k]) cbWrapSet(frames[i], true);
    }
    var codes = root.querySelectorAll('.cb pre>code[class*="language-"]');
    if(!codes.length) return;
    var live = liveEl();
    for(i=0;i<codes.length;i++){
      var host = codes[i].closest('[data-k]');
      hlApply(codes[i], Boolean(live) && host === live);
    }
  }

  /** Colour one code element if that can be done now. */
  function hlApply(code, live){
    if(code.hasAttribute('data-hl') || code.firstElementChild) return;
    var lang = codeLang(code), src = code.textContent;
    if(!lang || !src || src.length > HL_MAX) return;
    var key = lang + '\n' + src, spans = hlCache.get(key);
    if(spans){
      hlCache.delete(key);
      hlCache.set(key, spans);
      return hlPaint(code, src, spans);
    }
    if(live) return;
    var fn = hlFns[lang];
    if(fn === false) return;
    if(!fn) return hlLoad(lang);
    try { spans = fn(src); }
    catch(e){ hlFns[lang] = false; return hlWarn(e); }
    hlCache.set(key, spans);
    if(hlCache.size > HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value);
    hlPaint(code, src, spans);
  }

  /**
   * The coloured text, built as text nodes and spans — never through innerHTML. The spans are offsets
   * into the code's own text, so the element's text, and what Copy takes, is unchanged.
   */
  function hlPaint(code, src, spans){
    var frag = document.createDocumentFragment(), at = 0;
    for(var i=0;i<spans.length;i++){
      var from = spans[i][0], to = spans[i][1];
      if(!(from >= at && to > from && to <= src.length)) continue;
      if(from > at) frag.appendChild(document.createTextNode(src.slice(at, from)));
      var span = document.createElement('span');
      span.className = String(spans[i][2]);
      span.textContent = src.slice(from, to);
      frag.appendChild(span);
      at = to;
    }
    if(at < src.length) frag.appendChild(document.createTextNode(src.slice(at)));
    code.textContent = '';
    code.appendChild(frag);
    code.setAttribute('data-hl', '');
  }

  /**
   * Ask the code view for a language's grammar, once. No bundle, no grammar by that name, or a chunk
   * that would not load all leave the block as it already is — plain, which is a complete answer —
   * and only the last says so in the console, once per page.
   */
  function hlLoad(lang){
    if(lang in hlFns) return;
    hlFns[lang] = null;
    codeView().then(function(cv){
      return cv && typeof cv.highlighter === 'function' ? cv.highlighter(lang) : null;
    }).then(function(fn){
      hlFns[lang] = typeof fn === 'function' ? fn : false;
      if(fn) hlSweep();
    }, function(e){
      hlFns[lang] = false;
      hlWarn(e);
    });
  }
  function hlWarn(e){
    if(hlWarned) return;
    hlWarned = true;
    console.warn('a code language failed to load, showing plain text:', e);
  }

  /** Look at every waiting block again once the writes have stopped for a moment. */
  function hlLater(){
    clearTimeout(hlTimer);
    hlTimer = setTimeout(hlSweep, HL_IDLE_MS);
  }

  /**
   * Every place a reply's HTML is shown, looked at again: after a grammar has loaded, after a turn
   * has ended, and a moment after the last write — which is when the message a newer one has just
   * followed stops being the live one.
   */
  function hlSweep(){
    clearTimeout(hlTimer);
    var live = liveEl(), roots = [log, libLog, btwBody, readerBody, filesPanel.previewEl()];
    for(var r=0;r<roots.length;r++){
      if(!roots[r]) continue;
      var codes = roots[r].querySelectorAll('.cb pre>code[class*="language-"]:not([data-hl])');
      for(var i=0;i<codes.length;i++){
        var host = codes[i].closest('[data-k]');
        hlApply(codes[i], Boolean(live) && host === live);
      }
    }
  }

  /** Where a code block's Wrap is remembered: its message's key and its place in that message. */
  function cbKey(frame){
    var host = frame.closest('[data-k]');
    if(!host) return null;
    var all = host.querySelectorAll('.cb');
    for(var i=0;i<all.length;i++) if(all[i] === frame) return host.getAttribute('data-k') + '#' + i;
    return null;
  }
  function cbWrapSet(frame, on){
    frame.classList.toggle('wrap', on);
    var b = frame.querySelector('.cb-b[data-cb="wrap"]');
    if(b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /**
   * Copy the code — the code element's text, which the colouring never changes — and say so on the
   * button for a moment: a copy that only changed the clipboard looks like a tap that did nothing.
   */
  function cbCopy(btn, s){
    copyText(s, function(ok){
      var say = ok ? tr('common.copied') : tr('msg.copyCodeFailed');
      btn.innerHTML = ok ? IC.icon.check : IC.icon.cross;
      btn.title = say;
      btn.setAttribute('aria-label', say);
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(function(){
        btn.innerHTML = IC.icon.copy;
        btn.title = tr('common.copy');
        btn.setAttribute('aria-label', tr('msg.copyCodeAria'));
      }, 1500);
    });
  }

  // Delegated on the document: a code block can be in the transcript, the History tab, a side
  // answer's card, the file reader or the file window's preview, and its markup is the same in all.
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('.cb-b[data-cb]') : null;
    var frame = b ? b.closest('.cb') : null;
    var code = frame ? frame.querySelector('pre>code') : null;
    if(!code) return;
    if(b.getAttribute('data-cb') === 'copy') return cbCopy(b, code.textContent);
    var on = !frame.classList.contains('wrap'), k = cbKey(frame);
    cbWrapSet(frame, on);
    if(k){ if(on) cbWrapped[k] = 1; else delete cbWrapped[k]; }
  });

  /**
   * The kinds drawn as a marked bubble — a rail, and this tag — rather than as the agent talking:
   * a task handed to a sub-agent, what sub-agents reported, and the answer to a side question.
   */
  var SUB_K = {dispatch:'msg.dispatch', report:'msg.report', aside:'msg.aside'};

  // ── Side questions (/btw) ──────────────────────────────────────────────────
  // A /btw is asked of a copy of the conversation and kept out of it, and its answer often lands in
  // the middle of a reply still streaming — where, drawn as a message, it read as that reply's next
  // paragraph. So neither half is drawn as a message: the question stays where it was asked as one
  // line, and the answer is read in a card over the composer (#btw) that the line opens again. The
  // daemon sends every message of an answer, and a refusal, as a reply to the /btw (turn-runner.ts
  // sendAside), whose quote names the question's id: the id, not the text, is what pairs them.
  var btwBox=$('btw'), btwQ=$('btw-q'), btwBody=$('btw-body');
  // The question the card shows, by its key in data; what the card last drew; the questions whose
  // card was closed by hand, so an answer still arriving for one updates its line rather than
  // opening the card again; and the guard that stops a question and its answer repainting each
  // other for ever (btwLink).
  var btwKey=null, btwSig='', btwShut={}, btwNest=false;
  // What the daemon takes for a /btw (daemon/routing.ts parseTextCommand): the name exactly, then
  // the question after whitespace, or nothing.
  var BTW_RE=/^\s*\/btw(?:\s+([\s\S]*))?$/;
  // The answer's first line names its question again, for a chat app (turn-runner.ts asideHeader).
  // The card has the question for a title, so there it goes.
  var BTW_HEAD_RE=/^<p>\u21aa btw: [\s\S]*?<\/p>\s*/;
  // And its last says it was kept out of the conversation (asideFooter): small print, drawn as such.
  var BTW_FOOT_RE=/<p>((?:side question|\u65c1\u767d\u63d0\u95ee) \u2014 [^<]*)<\/p>\s*$/;

  /** The text of a message typed here, as the daemon was given it; null when there is none. */
  function ownText(m){
    if(m._local) return m._text;
    // room.ts renderBody: the text escaped, whole, in the first element.
    var x = /^<div class="raw">([^<]*)<\/div>/.exec(m.html || '');
    if(!x) return null;
    return x[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  /**
   * What a message typed here asked on the side — '' for a bare /btw — or null when it is not a
   * /btw. Never in a conversation opened from History ('h:' keys): the library keeps no side
   * question, and a card opened from one would be over a topic that is not on screen.
   */
  function btwAsked(key, m){
    if(!m || !m.own || String(key).indexOf('h:') === 0) return null;
    var raw = ownText(m);
    var x = raw == null ? null : BTW_RE.exec(raw);
    return x ? (x[1] || '').trim() : null;
  }

  /** The key of the question a side answer replies to; null for anything else, and for an answer kept from before answers named it. */
  function btwOf(m){
    return m && m.kind === 'aside' && m.quote && m.quote.id ? (m._g || epoch) + ':' + m.quote.id : null;
  }

  /**
   * Whether an answer is kept out of the transcript. Only while its question is on the page to stand
   * for it: an answer whose question has aged out of the ring or the cache is drawn as a bubble, as
   * every answer was before, rather than becoming unreachable.
   */
  function btwHeld(key, m){
    if(String(key).indexOf('h:') === 0) return false;
    var q = btwOf(m);
    return Boolean(q && data[q] && btwAsked(q, data[q]) !== null);
  }

  /** Every message of the answer to the question under qk, in the order they were sent. */
  function btwParts(qk){
    var out=[];
    for(var k in data){
      if(Object.prototype.hasOwnProperty.call(data, k) && btwOf(data[k]) === qk) out.push(k);
    }
    out.sort(function(a, b){ return (data[a].at - data[b].at) || (seqOf(data[a].id) - seqOf(data[b].id)); });
    return out;
  }
  function seqOf(id){ var n = parseInt(String(id).slice(1), 10); return isNaN(n) ? 0 : n; }

  /** A side question in the transcript: one line that opens its answer, in place of the question's bubble. */
  function btwLine(key, m, asked, hist){
    var answered = !m._local && btwParts(key).length > 0;
    var state = answered ? tr('btw.answer') + IC.icon.chevronRight
      : stuck(m) ? '' : hist ? tr('btw.noAnswer') : tr('btw.waiting');
    var shown = btwKey === key && !btwBox.hidden;
    var cls = 'm btw-q' + (hist ? ' hist' : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (stuck(m) ? ' failed' : '');
    var h = '<button type="button" class="btw-chip" aria-haspopup="dialog" aria-controls="btw"'
      + ' aria-expanded="'+(shown ? 'true' : 'false')+'" title="'+text(asked ? tr('btw.titleWith', { asked: asked }) : tr('btw.title'))+'">'
      + '<span class="btw-tag">btw</span>'
      + '<span class="btw-text">'+text(asked || '/btw')+'</span>'
      + (state ? '<span class="btw-state'+(answered ? ' ready' : '')+'">'+state+'</span>' : '')
      + '<span class="btw-when">'+text(clock(m.at))+'</span>'
      + '</button>';
    if(stuck(m)) h += failedActions(m);
    return { cls: cls, h: h };
  }

  /** Repaint the other half of a side question — an answer's question, or a question's answers — where it is on screen. */
  function btwLink(key, m){
    var qk = btwOf(m), list = qk ? [qk] : btwAsked(key, m) !== null ? btwParts(key) : [];
    if(!list.length) return;
    btwNest = true;
    try { for(var i=0;i<list.length;i++) if(els[list[i]] && data[list[i]]) paint(list[i]); }
    finally { btwNest = false; }
  }

  /** Show the answer to the question under qk, from its start. */
  function openBtw(qk){
    if(!data[qk]) return;
    var was = btwKey;
    btwKey = qk;
    delete btwShut[qk];
    btwBox.hidden = false;
    btwSig = '';
    renderBtw(true);
    if(was && was !== qk && els[was] && data[was]) paint(was);
    if(els[qk]) paint(qk);
  }

  /**
   * Put the card away. byHand is the person closing it, which keeps it shut while the rest of that
   * answer arrives; the page closing it (a topic switch, the question gone) does not.
   */
  function closeBtw(byHand){
    if(btwBox.hidden) return;
    var k = btwKey;
    btwBox.hidden = true;
    btwKey = null;
    btwSig = '';
    btwBody.innerHTML = '';
    if(!k) return;
    if(byHand) btwShut[k] = 1;
    if(els[k] && data[k]) paint(k);
  }

  /**
   * Draw the card for the question it is on. top puts the reader at the start of the answer; any
   * other redraw keeps a reader at the bottom of a growing answer there, and leaves one who has
   * scrolled up where they are.
   */
  function renderBtw(top){
    var m = btwKey ? data[btwKey] : null;
    var asked = m ? btwAsked(btwKey, m) : null;
    if(asked === null){ closeBtw(false); return; }
    btwQ.textContent = asked || '/btw';
    btwQ.title = asked;
    var parts = m._local ? [] : btwParts(btwKey), h = '';
    for(var i=0;i<parts.length;i++){
      var body = String(data[parts[i]].html || '').replace(BTW_HEAD_RE, '').replace(BTW_FOOT_RE, '<p class="btw-foot">$1</p>');
      if(body) h += '<div class="b">'+body+'</div>';
    }
    if(!h){
      h = '<div class="btw-wait">' + (stuck(m) ? text(tr('btw.notSent'))
        : isHistory(m) ? text(tr('btw.restarted'))
        : '<span class="set-spin" aria-hidden="true"></span>'+text(tr('btw.asking'))) + '</div>';
    }
    var stick = btwBody.scrollHeight - btwBody.scrollTop - btwBody.clientHeight < 40;
    if(h !== btwSig){ btwBody.innerHTML = h; btwSig = h; codeBlocks(btwBody); }
    if(top) btwBody.scrollTop = 0;
    else if(stick) btwBody.scrollTop = btwBody.scrollHeight;
  }

  /**
   * A message of a side answer arrived, or grew. The card follows it when it is on that question,
   * and opens on it when it is shut and was not shut by hand on this question: the answer is what
   * the person asked for a moment ago, and a line under a reply still streaming is easy to miss.
   */
  function btwArrived(m){
    var qk = btwOf(m);
    if(!qk || !data[qk] || btwAsked(qk, data[qk]) === null) return;
    if(!btwBox.hidden && btwKey === qk) renderBtw(false);
    else if(btwBox.hidden && !btwShut[qk]) openBtw(qk);
  }

  $('btw-close').addEventListener('click', function(){ closeBtw(true); });

  /**
   * One message's class and inner markup. Shared by the transcript (paint) and by a conversation
   * opened from the History tab (paintLib), which is what makes the two look the same: one place
   * decides what a bubble is.
   */
  function msgMarkup(key, m, hist){
    // A side question and its answer are read in a card over the composer, not here (openBtw).
    var asked = btwAsked(key, m);
    if(asked !== null) return btwLine(key, m, asked, hist);
    if(btwHeld(key, m)) return { cls: 'm aside-held', h: '' };
    var kind = m.kind;
    // A report is a line-based bubble like a tool one: fold it and offer the same control. A
    // dispatch is prose (the card, or the task a sub-agent was handed), so it only takes the tag.
    var folded = kind === 'tools' || kind === 'report';
    var tag = kind && Object.prototype.hasOwnProperty.call(SUB_K, kind) ? tr(SUB_K[kind]) : '';
    var cls = 'm' + (m.own ? ' own' : '') + (hist ? ' hist' : '')
      + (tag ? ' '+kind : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (stuck(m) ? ' failed' : '');
    var h='';
    // The tag, not the text, is what makes the kinds tell apart before the body is read.
    if(tag) h += '<div class="sub-k">'+tag+'</div>';
    if(m.quote && m.quote.html) h += '<div class="q">'+m.quote.html+'</div>';
    if(!hist && m.workdir){
      h += workdirPicker(m);
    } else {
      h += '<div class="b">'+(folded ? foldLines(key, m.html) : m.html)+'</div>';
      if(m.file){
        // An image is drawn, not just named — a screenshot the agent took is about to be looked
        // at, and a round trip through the downloads folder to do that is the friction this
        // exists to remove. The link stays underneath either way: it is still the only way to
        // get the bytes onto disk, and it is what a picture that fails to load degrades to.
        if(m.file.image) h += '<img class="shot" src="'+text(m.file.url)+'" alt="'+text(m.file.name)+'" loading="lazy">';
        h += '<div class="files"><a href="'+text(m.file.url)+'" download'
          + (m.file.view && !hist ? ' data-view="'+text(m.file.view)+'"' : '')
          + '>'+text(m.file.name)+'</a>';
        // A report or a log is read by tapping its name (openReader); Download beside it is the
        // way to the bytes, which is what the name used to be. Not offered on history, for the
        // reason its buttons are dropped below: the token died with the process that minted it, so
        // the reader could only ever open onto "no longer here".
        if(m.file.view && !hist) h += '<a class="view" href="'+text(m.file.url)+'" download>'+text(tr('common.download'))+'</a>';
        h += '</div>';
      }
      // What the turn changed, when the daemon recorded it. Not gated on a message being history:
      // the records outlive the run that took the snapshots, so the entry still opens its window for
      // a reply restored from a previous run. (A message from the History tab never carries one —
      // that transcript has no turn records behind it.) Nothing is drawn unless the page has a
      // window to open (see turnChangeRow).
      if(m.turnChanges) h += turnChangeRow(m);
      // Buttons are dropped from a message that came out of the cache: the process that would
      // answer them is gone, and the id they name now means a different message or nothing at
      // all. A control that cannot act is worse than no control.
      if(!hist && m.buttons && m.buttons.length) h += menu(m);
    }
    if(stuck(m)) h += failedActions(m);
    var meta = text(clock(m.at)) + (m.reactions && m.reactions.length ? '  '+m.reactions.map(reactionMark).join(' ') : '');
    h += '<div class="t">'+meta+(folded ? allToggle(key) : '')+'</div>';
    return { cls: cls, h: h };
  }

  /**
   * What one turn changed, under the reply it ended: "3 files changed +12 -4", and a tap opens the
   * git panel's window on it.
   *
   * Nothing is drawn when the page has no such window (window.openGitWindow, which the git panel
   * provides): an entry that opens nothing is worse than no entry, and a page served by a daemon
   * built without that panel must not show a dead control. The check is at draw time rather than at
   * click time for exactly that reason.
   *
   * The entry itself is part of the message (WebMessage.turnChanges), so a reload, a reconnect and
   * a restart all bring it back with the transcript it belongs to.
   */
  function turnChangeRow(m){
    if(typeof window.openGitWindow !== 'function') return '';
    var c = m.turnChanges;
    var files = c.files === 1 ? tr('msg.turnFilesOne') : tr('msg.turnFilesMany', { count: c.files });
    return '<div class="tc"><button type="button" data-turns="'+text(String(c.turn))+'">'
      + IC.icon.diff
      + '<span>' + text(files) + '</span>'
      + '<span class="add">+' + text(String(c.additions)) + '</span>'
      + '<span class="del">-' + text(String(c.deletions) + (c.truncated ? '+' : '')) + '</span>'
      + '</button></div>';
  }

  /**
   * Open the git panel's window on one turn's changes.
   *
   * The two URLs answer the JSON shapes turnChangesStatusForRef / turnChangesFileForRef build;
   * the window appends "&path=" and a URL-encoded repository-relative path to fileUrl itself, so
   * fileUrl stops at the turn. The topic is the page's own — a transcript row is always in it.
   */
  function openTurnChanges(turn){
    if(typeof window.openGitWindow !== 'function' || !turn) return;
    var q = '?t=' + encodeURIComponent(topic) + '&turn=' + encodeURIComponent(String(turn));
    window.openGitWindow({
      title: tr('msg.turnChangesTitle', { turn: turn }),
      statusUrl: 'api/turn-changes/status' + q,
      fileUrl: 'api/turn-changes/file' + q,
    });
  }

  /**
   * A message's buttons, laid out as what nearly all of them are: a menu to pick one thing from.
   *
   * A grid rather than buttons wrapped like words, because a wrapped row is only as wide as its
   * labels: a page of directories came out as a ragged block whose columns moved on every row, and
   * on a phone as one or two buttons a row in no order at all. The columns are sized from the
   * widest label (--cw, in the menu's own ch), so short names get more of them and long model ids
   * fewer, and the stylesheet keeps at least two — a label longer than half the row wraps inside
   * its cell rather than taking the row.
   *
   * Two things are read off the labels, because a label is all the daemon sends. The marks core
   * puts in front of an item (● the current one, ☑ ☐ a multi-select's ticks, ⌂ the workspace root)
   * become a mark the cell can colour, and the current choice is lit rather than left to be found
   * by a dot the same grey as its text. And the controls that move around a menu rather than
   * answer it (◀ Prev, Next ▶, ◀ Back, ‹ ›) go on a row of their own under the items, instead of
   * reading as two more things to choose. Both are presentation only: a label that happens to
   * match is drawn differently and still posts exactly its own id.
   */
  var MARK = /^([●☑☐⌂]) /, NAV = /^[◀‹]|[▶›]$/;
  /** A nav button's label with its arrow drawn as a chevron: "◀ Back", "Next ▶", "‹", "‹ machines". */
  function navLabel(label){
    var back = /^[◀‹] ?/.exec(label), on = / ?[▶›]$/.exec(label);
    if(back) return IC.icon.chevronLeft + (label.length > back[0].length ? ' '+text(label.slice(back[0].length)) : '');
    if(on) return (on.index ? text(label.slice(0, on.index))+' ' : '') + IC.icon.chevronRight;
    return text(label);
  }
  /** A lifecycle reaction as its icon; one the page has none for (a configured emoji) as itself. */
  function reactionMark(e){
    return IC.reaction[String(e).replace(/\uFE0F/g, '')] || text(e);
  }
  function menu(m){
    var items = '', nav = '', widest = 0, marked = false, msg = text(m.id);
    for(var i=0;i<m.buttons.length;i++){
      var b = m.buttons[i], label = String(b.label == null ? '' : b.label), mk = MARK.exec(label);
      var tag = '<button type="button" data-msg="'+msg+'" data-btn="'+text(b.id)+'"';
      if(NAV.test(label)){ nav += tag+'>'+navLabel(label)+'</button>'; continue; }
      widest = Math.max(widest, labelWidth(label));
      if(mk) marked = true;
      var on = mk && (mk[1] === '●' || mk[1] === '☑');
      items += tag + (on ? ' class="on"' : '') + '>'
        + (mk ? '<span class="mk">'+(IC.mark[mk[1]] || text(mk[1]))+'</span> '+text(label.slice(2)) : text(label)) + '</button>';
    }
    // 40 is core's label budget (truncateLabel); a longer one would be a column no row can hold.
    // A mark is drawn as a 1em icon where labelWidth counted its glyph as one column, so a menu
    // with marks asks for the difference (--mk, in the stylesheet): without it "☑ APAC" was a
    // hair too wide for its column and the icon wrapped onto a line of its own. Only the
    // difference — a whole column more took the /cd menu on a phone from three columns to two.
    return '<div class="btns" style="--cw:'+Math.min(widest, 40)+'ch'+(marked ? ';--mk:1' : '')+'">' + items
      + (nav ? '<div class="nav">'+nav+'</div>' : '') + '</div>';
  }

  function workdirPicker(m){
    var w = m.workdir, msg = text(m.id);
    var crumbs = '';
    var list = w.breadcrumbs || [];
    for(var i=0;i<list.length;i++){
      var c = list[i], isLast = i === list.length - 1;
      if(i > 0 && list[i-1].name !== '/' && !/\\$/.test(list[i-1].name)) crumbs += '<span class="wd-sep" aria-hidden="true">/</span>';
      if(isLast){
        crumbs += '<span class="wd-crumb cur" title="'+text(c.path)+'">'+text(c.name)+'</span>';
      } else {
        crumbs += '<button type="button" class="wd-crumb" data-msg="'+msg+'" data-btn="'+text(c.buttonId)+'" title="'+text(c.path)+'">'+text(c.name)+'</button>';
      }
    }
    var upBtn = w.parent
      ? '<button type="button" class="wd-act wd-up" data-msg="'+msg+'" data-btn="'+text(w.parent.buttonId)+'" title="'+text(tr('workdir.upTitle', { path: w.parent.path }))+'">'+IC.icon.arrowUp+'<span>'+text(tr('workdir.up'))+'</span></button>'
      : '<button type="button" class="wd-act wd-up" disabled>'+IC.icon.arrowUp+'<span>'+text(tr('workdir.up'))+'</span></button>';
    var homeBtn = w.home
      ? '<button type="button" class="wd-act wd-home" data-msg="'+msg+'" data-btn="'+text(w.home.buttonId)+'" title="'+text(tr('workdir.rootTitle', { path: w.home.path }))+'">'+IC.icon.home+'<span>'+text(tr('workdir.root'))+'</span></button>'
      : '';
    var sc = w.selectCurrent;
    var curTags = (sc.current ? '<span class="wd-tag on">'+text(tr('workdir.currentTag'))+'</span>' : '')
      + (sc.root ? '<span class="wd-tag">'+text(tr('workdir.rootTag'))+'</span>' : '');
    var entries = w.entries || [];
    var rows = '';
    for(var j=0;j<entries.length;j++){
      var e = entries[j];
      var rowTag = e.current
        ? '<span class="wd-tag on">'+text(tr('workdir.currentTag'))+'</span>'
        : (e.root ? '<span class="wd-tag">'+text(tr('workdir.rootTag'))+'</span>' : '');
      rows += '<div class="wd-row'+(e.current ? ' on' : '')+'" data-wd-name="'+text(String(e.name).toLowerCase())+'">'
        + '<button type="button" class="wd-open" data-msg="'+msg+'" data-btn="'+text(e.enterId)+'" title="'+text(tr('workdir.openTitle', { name: e.name }))+'">'
        + '<span class="wd-ic">'+(e.root ? IC.icon.home : IC.icon.folder)+'</span>'
        + '<span class="wd-name">'+text(e.name)+'</span>'
        + rowTag
        + '<span class="wd-go" aria-hidden="true">'+IC.icon.chevronRight+'</span>'
        + '</button>'
        + '<button type="button" class="wd-choose'+(e.current ? ' on' : '')+'" data-msg="'+msg+'" data-btn="'+text(e.pickId)+'" title="'+text(tr('workdir.chooseTitle', { path: e.path }))+'">'
        + IC.icon.check+'<span>'+text(tr('workdir.choose'))+'</span>'
        + '</button>'
        + '</div>';
    }
    var filterHtml = entries.length >= 6
      ? '<div class="wd-filter">'+IC.icon.search+'<input type="search" class="wd-q" placeholder="'+text(tr('workdir.filterPlaceholder'))+'" aria-label="'+text(tr('workdir.filterPlaceholder'))+'" autocomplete="off" spellcheck="false"></div>'
      : '';
    var bodyHtml = entries.length
      ? '<div class="wd-list">'+rows+'<div class="wd-empty wd-filter-empty" hidden>'+text(tr('workdir.noMatch'))+'</div></div>'
      : '<div class="wd-empty">'+text(tr('workdir.empty'))+'</div>';
    var hostPill = w.host ? '<span class="wd-meta">'+text(w.host)+'</span>' : '';
    return '<div class="wd-picker" data-browsing="'+text(w.browsing)+'">'
      + '<div class="wd-head"><div class="wd-title-row"><span class="wd-title">'+IC.icon.folder+'<span>'+text(tr('workdir.title'))+'</span></span>'
      + '<span class="wd-badges"><span class="wd-meta">'+text(w.agentId)+'</span>'+hostPill+'</span></div>'
      + '<div class="wd-hint">'+text(tr('workdir.hint'))+'</div></div>'
      + '<div class="wd-bar"><div class="wd-acts">'+upBtn+homeBtn+'</div><nav class="wd-crumbs" aria-label="Path">'+crumbs+'</nav></div>'
      + (w.error ? '<div class="wd-err" role="alert">'+text(w.error)+'</div>' : '')
      + '<div class="wd-cur"><div class="wd-cur-info"><code class="wd-path" title="'+text(sc.path)+'">'+text(sc.path)+'</code>'+curTags+'</div>'
      + '<button type="button" class="wd-pick-cur'+(sc.current ? ' on' : '')+'" data-msg="'+msg+'" data-btn="'+text(sc.buttonId)+'">'+IC.icon.check+'<span>'+text(tr(sc.current ? 'workdir.keepCurrent' : 'workdir.useCurrent'))+'</span></button></div>'
      + filterHtml
      + bodyHtml
      + (w.truncated > 0 ? '<div class="wd-more">'+text(tr('workdir.truncated', { count: w.truncated }))+'</div>' : '')
      + '</div>';
  }

  /**
   * A button in a menu or in the settings page. Disabled and lit as well as disabled: the answer
   * is a round trip away, and a button that only greys out reads as "nothing happened" for
   * exactly that long. A refusal (409: that message is gone) leaves it disabled, but no longer
   * lit — nothing is coming.
   */
  function postButton(b, t){
    b.disabled = true;
    b.classList.add('busy');
    post('api/click',{topic:t,messageId:b.getAttribute('data-msg'),buttonId:b.getAttribute('data-btn')},2)
      .then(function(r){ if(!r.ok) b.classList.remove('busy'); })
      .catch(function(){ b.disabled=false; b.classList.remove('busy'); });
  }

  /**
   * A label's width in ch, near enough to size a column by: a CJK character is about two, and an
   * agent asking in Chinese offers its choices in Chinese. Erring wide is the cheap direction — a
   * column a little too roomy, against a label that wraps when it did not have to.
   */
  function labelWidth(s){
    var n = 0;
    for(var i=0;i<s.length;i++) n += s.charCodeAt(i) >= 0x2e80 ? 2 : 1;
    return n;
  }

  /**
   * Which lines of each tool bubble the reader has opened, by message key: {all, lines: {i: open}}.
   * A line with no entry of its own follows all, which is how "Show all" also opens the lines the
   * agent adds after it was pressed.
   *
   * Kept here rather than as a class on the elements, because a tool bubble is edited every time
   * a tool starts or finishes and every edit rewrites its markup — a line opened on the old
   * element would snap shut under the reader at the next ✓. In memory only: which line someone is
   * reading is a reading position, not part of the conversation, and the cache does not keep it.
   * Like a scroll position, though, it is not reset on the way out of a topic (opened is declared
   * beside sig, and only drop() forgets an entry): coming back finds the same lines open.
   */
  function lineOpen(st, i){
    if(!st) return false;
    return st.lines[i] !== undefined ? st.lines[i] : st.all;
  }

  /**
   * A tool bubble's markup with each line's index stamped on it and the opened ones marked.
   *
   * A string rewrite, not a DOM walk, so the result can be compared with what is on screen before
   * anything is written (see sig in paint). The pattern is exact because the markup is:
   * renderWebToolLines writes this tag and nothing else, and escapes every < inside a line.
   */
  function foldLines(key, html){
    var st = opened[key], i = 0;
    return html.replace(/<div class="tl">/g, function(){
      var n = i++;
      return '<div class="tl'+(lineOpen(st, n) ? ' open' : '')+'" data-i="'+n+'">';
    });
  }

  function allToggle(key){
    var st = opened[key];
    return '<button type="button" class="tl-all" data-tl-all="'+text(key)+'">'
      + text(st && st.all ? tr('msg.collapse') : tr('msg.showAll')) + '</button>';
  }

  /** Open every line of a tool bubble, or fold them all back. Either way, per-line choices go. */
  function toggleAll(key){
    if(!msgAt(key)) return;
    var st = opened[key];
    opened[key] = { all: !(st && st.all), lines: {} };
    repaintKey(key);
  }

  /**
   * Open or fold one line. Not when the click ended a drag-select: copying part of a command is
   * the other thing a reader does with these lines, and repainting the bubble under the selection
   * would throw it away and fold the line they were copying from.
   */
  function toggleLine(line){
    var sel = window.getSelection ? window.getSelection() : null;
    if(sel && String(sel)) return;
    var host = line.closest('[data-k]');
    var key = host ? host.getAttribute('data-k') : null;
    if(!key || !msgAt(key)) return;
    var i = line.getAttribute('data-i');
    var st = opened[key] || (opened[key] = { all: false, lines: {} });
    st.lines[i] = !lineOpen(st, i);
    repaintKey(key);
  }

  /** A message by key, in the transcript or in the conversation opened from History. */
  function msgAt(key){ return data[key] || historyPanel.getMessage(key); }
  function repaintKey(key){ if(historyPanel.getMessage(key)) historyPanel.repaintMessage(key); else paint(key); }

  /**
   * What a message that never reached the daemon offers instead of silence.
   *
   * Retry is there whenever this page can rebuild exactly what was sent: always for a message
   * typed in this tab, and after a reload for one that was text alone. A message that carried
   * files offers Copy and Discard alone once the page has been reloaded — the files were base64 in
   * a request body and deliberately never written down, and re-sending the text without the files
   * it was written about would be a different message.
   *
   * 'unsure' is a message that was still on its way when the last page went away, so nothing here
   * saw how it ended. The first sync settles it: carrying its echo, it is claimed like any other;
   * not carrying it, from the same daemon, it never arrived. Until then — and for good, when the
   * daemon has restarted since and its ring cannot say — it says it does not know.
   */
  function stuck(m){ return Boolean(m._local) && (m._state === 'failed' || m._state === 'unsure'); }

  function failedActions(m){
    var why = m._state === 'unsure'
      ? tr('msg.notConfirmed')
      : tr('msg.notDelivered');
    var h = '<div class="warn">'+text(why)+'</div><div class="acts">';
    if(composerController.hasOutbox(m._nonce)) h += '<button type="button" data-retry="'+text(m._nonce)+'">'+text(tr('common.retry'))+'</button>';
    return h + '<button type="button" data-copy="'+text(m._nonce)+'">'+text(tr('common.copy'))+'</button>'
      + '<button type="button" data-discard="'+text(m._nonce)+'">'+text(tr('common.discard'))+'</button></div>';
  }

  function upsert(m){
    m._g = m.g || epoch;
    // The settings screen lives in its own page; it is not a message here. See takeSettings.
    if(m.settings || m.wasSettings) return;
    var stick=atBottom();
    var key = keyOf(m);
    data[key]=m; paint(key); syncEmptyNote(); if(stick) toBottom();
  }

  function drop(key){
    var m = data[key];
    if(els[key]) { els[key].remove(); delete els[key]; }
    delete data[key];
    delete sig[key];
    delete opened[key];
    // A side question that goes leaves its answers drawn in the transcript rather than nowhere, and
    // takes the card with it; an answer that goes is taken out of the card.
    if(m && btwAsked(key, m) !== null){
      if(btwKey === key) closeBtw(false);
      var parts = btwParts(key);
      for(var i=0;i<parts.length;i++) paint(parts[i]);
    }
    var q = btwOf(m);
    if(q && q === btwKey && !btwBox.hidden) renderBtw(false);
    if(q && els[q] && data[q]) paint(q);
    syncEmptyNote();
  }

  /**
   * Bring the transcript to exactly the list given, reusing what is already on screen.
   *
   * The predecessor emptied #log and rebuilt every message from the sync. That is what made
   * entering a topic jarring: the scroll container was destroyed along with its scrollTop, then
   * refilled and snapped, so a topic whose messages were ALREADY painted from cache still flashed
   * through blank. Here an unchanged message is left untouched (paint writes nothing when the
   * markup matches), and appendChild MOVES a node that already exists rather than cloning it — so
   * ordering costs no re-creation either, and nothing re-runs the fade-in animation.
   *
   * Only messages of the CURRENT generation are the sync's to remove. Cached history belongs to
   * a daemon that is not on the other end of this stream, and a local message still waiting on
   * its POST was never the server's to know about; both would otherwise vanish the moment the
   * connection blipped.
   *
   * A local message whose echo the sync carries is claimed here, exactly as a msg event claims
   * one. Only msg events used to, so an echo that arrived in a full sync instead — a reconnect the
   * backlog no longer reached, a reload — left the local copy on screen beside it, and one restored
   * after a reload could never be told it had arrived.
   */
  function reconcile(list){
    clearSkeleton();
    // The sync this was waiting for. Cleared before anything is painted, so the messages it
    // carries are appended to a log whose last child is a message again.
    clearSyncing();
    var keep={};
    for(var i=0;i<list.length;i++){
      var m=list[i];
      // A message a topic kept on disk from an earlier run says which run (g): it is that
      // run's history, under the key this browser's cache already has it by.
      m._g = m.g || epoch;
      // A settings screen — live or retired — is drawn in its own page, never in the transcript.
      // The sync is where a reload would otherwise bring one back as a plain bubble.
      if(m.settings || m.wasSettings) continue;
      claim(m);
      var key=keyOf(m);
      keep[key]=1;
      data[key]=m;
      paint(key);
      log.appendChild(els[key]);
    }
    var gone=[];
    for(var k in els){
      if(keep[k]) continue;
      var held=data[k];
      if(!held || held._local || held._g !== epoch) continue;
      gone.push(k);
    }
    for(var j=0;j<gone.length;j++) drop(gone[j]);
    sinkLocals();
  }

  /**
   * Put every message still waiting on the daemon under the transcript, in the order it was sent.
   *
   * The loop above appends each message the sync carries, which MOVES it to the end — so anything
   * it does not carry ends up above all of them. For cached history that is the point. For a
   * local message it put a failure restored after a reload at the head of the topic, above every
   * message the reader lands below, which on a long topic is indistinguishable from having lost
   * it. A message nobody has acknowledged is the newest thing in the room and waits where the
   * composer is. Nothing moves when they are already there, so a sync with nothing pending, which
   * is nearly all of them, re-runs no entrance animation.
   */
  function sinkLocals(){
    var mine=[], tail=0, other=false;
    for(var n=log.lastChild; n; n=n.previousSibling){
      if(n === syncingEl) continue;
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      if(k && data[k] && data[k]._local){ mine.unshift(n); if(!other) tail++; }
      else other = true;
    }
    if(tail === mine.length) return;
    var at = (syncingEl && syncingEl.parentNode === log) ? syncingEl : null;
    for(var i=0;i<mine.length;i++) log.insertBefore(mine[i], at);
  }

  /**
   * Hold the shape of a transcript that has not arrived yet.
   *
   * Only ever shown into an EMPTY log: a topic painted from cache has real content to look at,
   * and stacking placeholders under it would claim messages are still coming when the next event
   * is going to replace what is there rather than extend it.
   */
  var SKELETON = '<div class="sk own"><i style="width:34%"></i></div>'
    + '<div class="sk"><i style="width:86%"></i><i style="width:73%"></i><i style="width:41%"></i></div>'
    + '<div class="sk own"><i style="width:52%"></i><i style="width:28%"></i></div>'
    + '<div class="sk"><i style="width:79%"></i><i style="width:62%"></i></div>';

  function showSkeleton(){
    if(log.firstChild) return;
    log.innerHTML = SKELETON;
    skeleton = true;
  }

  function clearSkeleton(){
    if(!skeleton) return;
    skeleton = false;
    log.innerHTML = '';
    // Emptying #log invalidates anything held by reference into it, and these are the only
    // things in there that are not messages.
    emptyEl = null;
    launchEl = null;
    launchSig = '';
    dividerEl = null;
    syncingEl = null;
  }

  /**
   * Say why an empty room is empty, when the server said this topic predates the daemon.
   *
   * A transcript is kept on the daemon's disk, but not by a daemon older than 2.13.0 for a topic that
   * was not starred, nor when its file could not be read — and those topics are rows that open onto
   * nothing. Rendered faithfully that is a blank panel, which is indistinguishable from a page that
   * failed to load — and is exactly how it was reported.
   */
  function hasMessages(){
    for(var k in els) if(els.hasOwnProperty(k)) return true;
    return false;
  }

  function syncEmptyNote(){
    var empty = !hasMessages();
    // The choice of agent first, and instead of the notice: while the choice is open no agent has a
    // session here, so "the agent still has its context" would not be true of this room.
    syncLaunch(Boolean(launch) && empty);
    var want = stale && empty && !launchEl;
    if(want === Boolean(emptyEl)) return;
    if(want){
      clearSkeleton();
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = tr('chat.emptyNote');
      log.appendChild(emptyEl);
    } else {
      if(emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
    }
  }

  /**
   * A new topic: the agents it could be given to, laid out where its transcript is going to be.
   *
   * The daemon sends the choice on the sync of an empty room for as long as it is open — the agent
   * that would answer has no session here yet — and it is drawn while the room stays empty. A tap
   * sends /agent <id> the way typing it would (command), so the transcript records the choice and
   * the daemon follows it with where that agent should work; the bubble that send paints is a
   * message, and a message is what takes this away. Typing instead is an answer too, which is why
   * the agent it would reach is marked. A send that fails and is discarded empties the room again,
   * and the choice comes back with it.
   */
  function launchHtml(c){
    var h = '<div class="launch-head"><div class="launch-title">'+text(tr('chat.launchTitle'))+'</div>'
      + '<div class="launch-sub">'+text(tr('chat.launchSubPrefix'))+'<b>'+text(c.current)+'</b>'+text(tr('chat.launchSubSuffix'))+'</div></div>';
    // One machine needs no heading: it would name the only answer to a question nobody asked —
    // unless it is offline, which is worth saying even of the only one.
    var many = c.groups.length > 1;
    for(var i=0;i<c.groups.length;i++){
      var g = c.groups[i], off = offSince(g.name);
      h += '<section class="launch-group'+(off?' off':'')+'">';
      if(many || off) h += '<h3 class="launch-host">'+text(g.name)+' <span class="n">'+g.agents.length+'</span>'
        + (off ? '<span class="off" title="'+text(offTitle(g.name))+'">'+IC.icon.offline+text(tr('chat.offlineSince', { when: offWhen(off) }))+'</span>' : '')
        + '</h3>';
      h += '<div class="launch-grid">';
      for(var j=0;j<g.agents.length;j++){
        var a = g.agents[j], on = a.id === c.current;
        h += '<button type="button" class="agent-card'+(on?' def':'')+'" data-agent="'+text(a.id)+'" title="/agent '+text(a.id)+(off?text(tr('chat.agentOffline', { name: g.name })):'')+'">'
          + '<span class="ac-top"><span class="ac-id">'+text(a.id)+'</span>'+(on?'<span class="ac-tag">'+text(tr('chat.defaultTag'))+'</span>':'')+'</span>'
          + '<span class="ac-kind"><i class="ac-dot h-'+text(a.harness)+'"></i><span>'+text(a.kind)+'</span></span>'
          + (a.model ? '<span class="ac-model" title="'+text(a.model)+'">'+text(a.model)+'</span>' : '')
          + '</button>';
      }
      h += '</div></section>';
    }
    return h;
  }

  /** Show the choice, or take it away; redrawn only when what it was drawn from changed. */
  function syncLaunch(want){
    // The machine list is part of what it is drawn from: an offline heading comes and goes with it.
    var s = want ? JSON.stringify(launch)+offlineSig : '';
    if(s === launchSig && want === Boolean(launchEl)) return;
    if(launchEl && launchEl.parentNode) launchEl.parentNode.removeChild(launchEl);
    launchEl = null;
    launchSig = '';
    if(want){
      clearSkeleton();
      launchEl = document.createElement('div');
      launchEl.className = 'launch';
      launchEl.innerHTML = launchHtml(launch);
      log.appendChild(launchEl);
      launchSig = s;
    }
    // The model switch waits on the launcher (paintStatus), so it follows it at once: up the moment
    // an agent is chosen, gone again if a failed send empties the room and the choice comes back.
    topicStatus.paintStatus();
    paintMachineNote();
  }

  // ── Machines the gateway cannot reach ───────────────────────────────────────────
  // The daemon measures it (daemon/host-availability.ts) and pushes the whole list on every change:
  // the sync's offline field, then machines events. Shown where it explains something — a topic's
  // line in the list, the heading over that machine's agents, and above the composer of a topic on
  // it — because a message to such a machine is not refused: it waits, or fails once it is tried,
  // and either way nothing on screen said why.

  /** Take the list as state; true when it changed. The caller repaints. */
  function takeMachines(list){
    var sigNow = JSON.stringify(list || []);
    if(sigNow === offlineSig) return false;
    var next = {};
    for(var i=0;i<(list||[]).length;i++) next[list[i].name] = list[i].since;
    offlineMachines = next;
    offlineSig = sigNow;
    return true;
  }

  function setMachines(list){
    if(!takeMachines(list)) return;
    paintTopics();
    if(launchEl) syncLaunch(true);
  }

  /** Since when a machine is offline (epoch ms), or 0 for one that is not. */
  function offSince(name){
    return name && Object.prototype.hasOwnProperty.call(offlineMachines, name) ? offlineMachines[name] : 0;
  }

  /** A time of day for an outage that began today-ish, the date as well for an older one. */
  function offWhen(at){
    return Date.now() - at < 20*3600000 ? stClock(at) : new Date(at).toLocaleString();
  }

  function offTitle(name){
    return tr('chat.machineOfflineTitle', { name: name, when: offWhen(offSince(name)) });
  }

  /** The line above the composer, for the topic on screen when its machine is offline. */
  function paintMachineNote(){
    var cur = null;
    for(var i=0;i<topics.length;i++) if(topics[i].id===topic){ cur = topics[i]; break; }
    var name = cur && cur.dir ? cur.dir.host : '';
    var off = offSince(name);
    // Not under the agent cards, whose heading already says it.
    if(!off || launchEl){
      machineNoteEl.hidden = true;
      machineNoteEl.innerHTML = '';
      return;
    }
    machineNoteEl.innerHTML = IC.icon.offline+'<span>'+text(tr('chat.machineOfflineNote', { name: name, when: offWhen(off) }))+'</span>';
    machineNoteEl.title = offTitle(name);
    machineNoteEl.hidden = false;
  }

  /**
   * The line at the top of a forked topic (Topic.forkOf): where it came from, at which turn, and a tap
   * back there. Hidden on every other topic, and once the source is gone — the daemon drops forkOf
   * with it, so the line never points at nothing. Rewritten only when what it says changes: this runs
   * on every topic list, and a list arrives with every message.
   */
  var forkNoteKey='';
  function paintForkNote(cur){
    var src=cur && cur.forkOf ? topicById(cur.forkOf) : null;
    var key=src ? src.id+'|'+(cur.forkTurn||'')+'|'+(src.title||'') : '';
    if(key===forkNoteKey) return;
    forkNoteKey=key;
    forkNote.hidden=!src;
    if(!src){ forkNote.innerHTML=''; forkNote.removeAttribute('data-src'); return; }
    forkNote.innerHTML=IC.icon.fork+'<span>'+text(tr('topic.forkedFromPrefix'))+'</span><span class="fork-src">'+text(src.title||tr('common.untitled'))+'</span>'
      +(cur.forkTurn?'<span>'+text(tr('topic.forkedTurn', { turn: cur.forkTurn }))+'</span>':'');
    forkNote.setAttribute('data-src', src.id);
    forkNote.title=tr('topic.backTo', { title: src.title || tr('common.untitled') });
  }
  forkNote.addEventListener('click', function(){
    var id=forkNote.getAttribute('data-src');
    if(!id || !topicById(id)) return;
    switchTopic(id);
    if(narrow()) setSidebar(false);
  });

  /**
   * The line between what was said before the daemon restarted and what it is serving now.
   *
   * A restart does not take the conversation, which the agent still has, and it no longer takes
   * what was on screen either. The messages above this line came back out of the daemon's own copy
   * on disk, or out of this browser's cache: they are real, they are just no longer anything the
   * process can be asked about, which is why nothing up there has a button on it.
   */
  var dividerEl=null;

  /** Keep the divider immediately after the last cached message, or gone when there are none. */
  function placeDivider(){
    var last=null;
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      if(k && isHistory(data[k])) last=n;
    }
    if(!last){
      if(dividerEl && dividerEl.parentNode) dividerEl.parentNode.removeChild(dividerEl);
      dividerEl=null;
      return;
    }
    if(!dividerEl){
      dividerEl=document.createElement('div');
      dividerEl.className='divider';
      dividerEl.textContent=tr('chat.dividerNote');
    }
    if(last.nextSibling !== dividerEl) log.insertBefore(dividerEl, last.nextSibling);
  }

  /**
   * That a transcript painted out of the local cache is not the whole story yet.
   *
   * Entering a topic with the cache warm is instantaneous — and then, a second or two later,
   * everything said in it while you were elsewhere appears in one frame, with nothing in between
   * having suggested more was coming. The skeleton cannot answer that: it only ever goes into an
   * EMPTY log, and this log is full. So the wait is marked where the missing messages are going
   * to land, at the bottom, and it says what it is waiting FOR rather than impersonating one of
   * them — most syncs add nothing and the line just goes away again.
   */
  var syncingEl=null;

  function showSyncing(){
    // Not over an empty log: the skeleton is already standing in for the whole transcript there,
    // and two answers to one wait is one too many.
    if(syncingEl || synced || skeleton || !log.firstChild) return;
    syncingEl=document.createElement('div');
    syncingEl.className='syncing';
    syncingEl.innerHTML='<span class="dots"><i></i><i></i><i></i></span><span>'+text(tr('chat.syncNote'))+'</span>';
    log.appendChild(syncingEl);
  }

  function clearSyncing(){
    if(syncingEl && syncingEl.parentNode) syncingEl.parentNode.removeChild(syncingEl);
    syncingEl=null;
  }

  /**
   * Re-draw whatever the cache handed us once a sync has said which generation is live.
   *
   * Before the first sync a cached message is painted as an ordinary message, because there is
   * nothing yet to say it is not one. The sync answers that: if the daemon has been restarted
   * since, every one of them is history, which changes how it is drawn (no buttons) and puts a
   * line under the lot. paint writes nothing for the messages whose markup did not change, so on
   * the ordinary path — same daemon, cache matching the ring — this costs one loop and no DOM.
   */
  function repaintHistory(){
    for(var k in els){ if(isHistory(data[k])) paint(k); }
    placeDivider();
  }

  /**
   * Put cached messages on screen around whatever is already there.
   *
   * Both orders happen and both are normal. Usually the cache wins the race against the first
   * sync, and is then simply the transcript, painted early — its keys are the ones the sync is
   * about to produce, so the sync reuses the nodes and writes nothing. When the sync gets there
   * first the only cached messages still worth showing are the ones the daemon does NOT have,
   * and those belong above what it sent. current says the copy is the topic as it stands (enter),
   * so there is nothing for the line that says the page is still checking to wait for.
   */
  function adopt(list, current){
    clearSkeleton();
    // On the way into a topic this is usually the first real paint, so it is where the reader is
    // put back (land, below). Otherwise the sync got here first and only someone already at the
    // bottom is kept there.
    var stick = !entering && atBottom();
    // Captured once: every history node goes in front of the same first live message, which is
    // what keeps them in the order they were said rather than reversing them.
    var anchor = synced ? log.firstChild : null;
    var moved = false;
    for(var i=0;i<list.length;i++){
      var m=list[i];
      if(!m || !m.id) continue;
      if(m._local){ moved = adoptLegacy(m) || moved; continue; }
      // Never a transcript row, and not something a cached copy should bring back either.
      if(m.settings || m.wasSettings) continue;
      var key = keyOf(m);
      if(data[key] || els[key]) continue;
      if(synced && !isHistory(m)) continue;
      data[key]=m;
      paint(key, synced ? anchor : null);
    }
    // Painted only now, and the cache rewritten without them: from here on unsent is their home.
    if(moved){ showUnsent(topic); cacheSave(); }
    // Before the waiting line goes in. Before the first sync the cache is appended under whatever is
    // already on screen, and that includes the messages restored from unsent, which belong under
    // all of it.
    sinkLocals();
    placeDivider();
    syncEmptyNote();
    // Last, so it is last in the log: what the sync may still add goes under what the cache had.
    if(!current) showSyncing();
    if(entering) land(); else if(stick) toBottom();
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
    log.innerHTML='';
    data={};
    els={};
    sig={};
    skeleton=false;
    // All of these belong to the topic being left: the notice and divider elements are gone with
    // #log's children, whether the NEXT topic predates the daemon is the incoming sync's answer
    // to give, and its transcript has not been read back yet. epoch is NOT reset — it is a
    // property of the daemon on the other end, not of the room being entered.
    stale=false;
    emptyEl=null;
    launch=null;
    launchEl=null;
    launchSig='';
    dividerEl=null;
    syncingEl=null;
    // The strip describes the topic being left; the incoming sync says what the new one's is.
    topicStatus.closeModelPop();
    closeBtw(false);
    topicStatus.setStatus(null);
    topicStatus.setPending([]);
    entering=true;
    synced=false;
    view = views[id] || null;
    landedAt = -1;
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
      if(named) composerController.loadDraftIfEmpty(topic);
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
      var arriving = entering && (landedAt < 0 || log.scrollTop === landedAt);
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
      if(!btwBox.hidden) renderBtw(false);
      cacheSave();
      // A visit that named no topic is only told which room it is in here, so this is also where
      // that room's copy is asked for — painted as history above what the sync carried.
      if(named) get(topic).then(function(c){ if(c && c.msgs.length && ev.topic === topic) adopt(c.msgs); });
      readsService.setCount(topic, ev.messages.length);
      composerController.setCommands(ev.commands || []);
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
      view = null;
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
    else if(ev.t==='commands'){ composerController.setCommands(ev.commands || []); }
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
        composerController.seedDraft(d.topic.id, seed.draft);
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
    for(id in views) if(!keep[id]) delete views[id];
    composerController.keepOnly(keep);
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

  log.addEventListener('click', function(e){
    // A picture, filling the screen. Not a new tab: installed as an app this page has no tab
    // bar to come back from, and leaving the app to look at a screenshot is the same friction
    // as downloading it. Checked first — a picture carries none of the attributes below.
    var shot = e.target.closest ? e.target.closest('img.shot') : null;
    if(shot) return openShot(shot);
    // A link to another topic (a sub-agent's, see web-markdown.ts TOPIC_LINK_RE): switched to in
    // place, not loaded as a page — the stream, the caches and the composer all stay as they are.
    var go = e.target.closest ? e.target.closest('a[data-goto]') : null;
    if(go){
      e.preventDefault();
      var goId = go.getAttribute('data-goto');
      if(goId && topics.some(function(t){ return t.id===goId; })){
        switchTopic(goId);
        if(narrow()) setSidebar(false);
      }
      return;
    }
    // A new topic's choice of agent: typed for the operator, so it is a message like any other.
    var card = e.target.closest ? e.target.closest('button[data-agent]') : null;
    if(card) return command('/agent '+card.getAttribute('data-agent'));
    // A side question's line opens its answer, or puts it away when that is what the card shows.
    var chip = e.target.closest ? e.target.closest('.btw-chip') : null;
    if(chip){
      var holder = chip.closest('[data-k]'), qk = holder ? holder.getAttribute('data-k') : null;
      if(qk){
        if(!btwBox.hidden && btwKey === qk) closeBtw(true);
        else openBtw(qk);
      }
      return;
    }
    // The name of a file the server can render opens it (openReader); the Download link beside
    // it, and any file the server cannot render, stays an ordinary download.
    var view = e.target.closest ? e.target.closest('a[data-view]') : null;
    if(view){ e.preventDefault(); return openReader(view); }
    // What a message that failed to send offers. Checked before the ordinary buttons: these are
    // answered here, locally, and never posted as a click on a message the daemon has no idea
    // about.
    var act = e.target.closest ? e.target.closest('[data-retry],[data-copy],[data-discard]') : null;
    if(act){
      var retry = act.getAttribute('data-retry');
      if(retry) return deliver(retry);
      var copy = act.getAttribute('data-copy');
      if(copy) return copyLocal(copy, act);
      var discard = act.getAttribute('data-discard');
      if(discard) return discardLocal(discard);
      return;
    }
    // A tool bubble's lines, opened and folded. Also answered here and never posted: which line
    // someone is reading is nothing the daemon has a view on.
    var all = e.target.closest ? e.target.closest('[data-tl-all]') : null;
    if(all) return toggleAll(all.getAttribute('data-tl-all'));
    var line = e.target.closest ? e.target.closest('.tl') : null;
    if(line) return toggleLine(line);
    // The entry under a reply opens what that turn changed, in the git panel's window. Answered
    // here and never posted: opening a diff says nothing to the daemon.
    var turns = e.target.closest ? e.target.closest('button[data-turns]') : null;
    if(turns) return openTurnChanges(Number(turns.getAttribute('data-turns')));
    var b = e.target.closest ? e.target.closest('button[data-btn]') : null;
    if(!b) return;
    postButton(b, topic);
  });
  log.addEventListener('input', function(e){
    var q = e.target && e.target.classList && e.target.classList.contains('wd-q') ? e.target : null;
    if(!q) return;
    var box = q.closest ? q.closest('.wd-picker') : null;
    if(!box) return;
    var needle = String(q.value || '').trim().toLowerCase();
    var rows = box.querySelectorAll('.wd-row'), shown = 0;
    for(var i=0;i<rows.length;i++){
      var match = !needle || String(rows[i].getAttribute('data-wd-name') || '').indexOf(needle) !== -1;
      rows[i].hidden = !match;
      if(match) shown++;
    }
    var empty = box.querySelector('.wd-filter-empty');
    if(empty) empty.hidden = shown > 0;
  });

  /**
   * A file the download table has since evicted, or one deleted off disk, answers 404 — and an
   * <img> says so with a broken frame that reads like a bug in the page. Hide it and the link
   * underneath is left, which is what a non-image shows anyway.
   *
   * Capture phase, because 'error' on an <img> does not bubble and so never reaches #log on its
   * own. The hiding survives a repaint for free: identical markup is not rewritten, and markup
   * that IS rewritten builds an image that 404s again.
   */
  log.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.classList && t.classList.contains('shot')) t.style.display='none';
  }, true);

  // ── History (client/panels/history.ts) ──────────────────────────────────────
  function setSbTab(tab){ historyPanel.setTab(tab); }
  function libOn(){ return historyPanel.isOpen(); }
  function closeLib(){ historyPanel.close(); }

  overlays.registerFallback(function(){
    if(filesPanel.isCustomOpen()){ filesPanel.close(); return true; }
    return false;
  });
  overlays.registerFallback(function(){
    var hintsOpen = composerController.isHintsOpen();
    var overlay = hintsOpen || !lightbox.hidden || !reader.hidden || !idleDialog.hidden || !rowMenu.hidden
      || openMenu() || !skillsWin.hidden || !settingsPage.hidden || !taskPage.hidden || filesPanel.isOpen() || gitPanel.isOpen();
    closeShot(); closeReader(); closeIdle(); closeSkills(); settingsFeature.close(); filesPanel.close(); gitPanel.close();
    closeTaskPage(false);
    closeRowMenu(true);
    if(hintsOpen) composerController.closeHints();
    var m = openMenu();
    if(m){ setMenu(null, false); m.btn.focus(); }
    return Boolean(overlay);
  });
  overlays.registerFallback(function(){
    if(!btwBox.hidden){ closeBtw(true); return true; }
    if(schedPane.isOpen()){ setSchedules(false); return true; }
    if(sbPane.isOpen()){ setSidebar(false); return true; }
    return false;
  });

  // ── The git window (client/panels/git.ts) ──────────────────────────────────

  // ── Skills (client/panels/skills.ts) ────────────────────────────────────────
  function closeSkills(){ skillsPanel.close(); }

  // ── The file window (client/panels/files.ts) ───────────────────────────────
  // ── Instructions (client/panels/instructions.ts) ─────────────────────────────

  // ── Topic cleanup helpers (delegating drafts & unsent to composerController) ──
  function forget(id){
    delete views[id];
    cacheService.forget(id);
    delete preTried[id];
    composerController.forgetTopic(id);
  }
  function prune(){
    if(!topics.length) return;
    var known={}, id;
    for(var i=0;i<topics.length;i++) known[topics[i].id]=1;
    for(id in views) if(!known[id]) delete views[id];
    cacheService.prune(known);
    for(id in preTried) if(!known[id]) delete preTried[id];
    composerController.pruneTopics(known);
  }

  // What was being typed into this topic before the reload. A visit with no ?t= does not know its
  // topic yet, and picks its draft up from the first sync.
  if(topic && composerController.hasDraft(topic)) loadDraft(topic);

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
    composerController.onLocaleChange();
    if(topicFilter && topicFilter.refreshI18n) topicFilter.refreshI18n(tr('sidebar.searchTopics'));
    forkNoteKey = '';
    launchSig = '';
    paintTopics();
    topicStatus.onLocaleChange();
    paintAges();
    if(launchEl) syncLaunch(true);
    if(emptyEl) emptyEl.textContent = tr('chat.emptyNote');
    if(dividerEl) dividerEl.textContent = tr('chat.dividerNote');
    if(syncingEl){
      var sp = syncingEl.querySelectorAll('span');
      if(sp[1]) sp[1].textContent = tr('chat.syncNote');
    }
    for(var mk in els){
      if(Object.prototype.hasOwnProperty.call(els, mk) && data[mk]) paint(mk);
    }
    if(!btwBox.hidden) renderBtw(false);
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
