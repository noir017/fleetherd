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
import { createTranscriptController } from './features/topic/transcript/index.js';
import { createTopicsFeature } from './features/topics/index.js';

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
  initLocale();
  var schedTitleEl = document.querySelector('#schedules-head .panel-title');
  if(schedTitleEl) schedTitleEl.setAttribute('data-i18n', 'sideTasks.title');
  applyDomI18n(document);
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
    hasLauncher: function(){ return transcript.banners.hasLaunch(); },
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
    hasOutbox: function(nonce){ return composerController.hasOutbox(nonce); },
    claim: claim,
    adoptLegacy: adoptLegacy,
    showUnsent: showUnsent,
    cacheSave: cacheSave,
    getHistoryMessage: function(k){ return historyPanel.getMessage(k); },
    repaintHistoryMessage: function(k){ historyPanel.repaintMessage(k); },
    paintTopics: paintTopics,
    paintStatus: function(){ topicStatus.paintStatus(); },
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
  var topicsFeature = createTopicsFeature({
    els: {
      bar: bar,
      topicsFilterHost: topicsFilterHost,
      rowMenu: rowMenu,
      newTopicBtn: newTopicBtn,
      readBtn: readBtn,
      clearBtn: clearBtn,
      idleBtn: idleBtn,
      noIdleBtn: noIdleBtn,
      idleCount: idleCount,
      idleDialog: idleDialog,
      idleTitle: idleTitle,
      idleWhy: idleWhy,
      idleList: idleList,
      idleGo: idleGo,
      idleCancel: idleCancel,
      chatTitle: chatTitle,
      chatStatus: chatStatus,
      killBtn: killBtn,
      stopBtn: stopBtn,
      note: note,
    },
    instanceId: BOOT.instance || 'web',
    termOk: Boolean(BOOT.terminal),
    getIcons: function(){ return IC.icon; },
    getTopics: function(){ return topics; },
    setTopics: function(next){ topics = next; },
    getTopic: function(){ return topic; },
    setTopic: function(id){ topic = id; },
    getEpoch: function(){ return epoch; },
    narrow: narrow,
    setSidebar: setSidebar,
    setSbTab: setSbTab,
    getSbTab: function(){ return historyPanel.getTab(); },
    closeMenus: function(){ setMenu(null, false); },
    closeLib: closeLib,
    refreshHistoryReadOnly: function(){ historyPanel.refreshReadOnly(); },
    closeSettings: function(){ settingsFeature.close(); },
    closeGit: function(){ gitPanel.close(); },
    closeTransientSchedules: function(){
      if(schedPane.isOpen() && !schedPane.docked()) setSchedules(false, true);
    },
    onSchedulesTopicsUpdated: function(){ schedulesPanel.onTopicsUpdated(); },
    getScheduleTask: schedTask,
    openTaskPage: openTaskPage,
    scheduleOp: schedOp,
    rememberAdoptedReview: function(topicId, reviewText){ reviewsPanel.rememberAdopted(topicId, reviewText); },
    unreadOf: unreadOf,
    needsRead: needsRead,
    syncReads: function(list, activeId){ readsService.syncTopics(list, activeId); },
    markTopicReadFromList: function(id, list){ readsService.markTopicFromList(id, list); },
    removeRead: function(id){ readsService.remove(id); },
    markAllRead: markAllRead,
    reportSeen: reportSeen,
    offSince: offSince,
    offTitle: offTitle,
    paintMachineNote: paintMachineNote,
    paintForkNote: paintForkNote,
    syncCopyRef: syncCopyRef,
    copyTopicRef: copyTopicRef,
    applyTerm: applyTerm,
    paintFrames: paintFrames,
    dropTerm: dropTerm,
    urlNow: urlNow,
    command: command,
    saveView: saveView,
    stashDraft: stashDraft,
    loadDraft: loadDraft,
    seedDraft: function(topicId, draftText){ composerController.seedDraft(topicId, draftText); },
    forgetTopic: forget,
    keepOnlyTopics: keepOnly,
    resetForSwitch: function(nextId){
      log.innerHTML = '';
      data = {};
      els = {};
      stale = false;
      topicStatus.closeModelPop();
      transcript.resetForTopicSwitch(nextId);
      topicStatus.setStatus(null);
      topicStatus.setPending([]);
      entering = true;
      synced = false;
    },
    showSkeleton: showSkeleton,
    setStale: function(v){ stale = v; },
    setSettleOnResume: function(v){ settleOnResume = v; },
    claimMessage: claim,
    adoptMessages: adopt,
    showUnsent: showUnsent,
    isDbAvailable: dbOn,
    getCacheVersion: function(id){ return cacheService.getVersion(id); },
    setCacheVersion: function(id, ver){ cacheService.setVersion(id, ver); },
    isNewer: newer,
    memCopy: memCopy,
    getCache: get,
    peekCache: cachePeek,
    putCache: put,
    dropCache: cacheDrop,
    leaveCache: leave,
    snapshotMsgs: snapshotMsgs,
    isStreamParked: function(){ return streamClient.isParked(); },
    isStreamOpen: function(){ return streamClient.isOpen(); },
    closeStream: function(){ streamClient.close(); },
    setStreamLastEventId: function(last){ streamClient.setLastEventId(last); },
    connectStream: function(resume){ streamClient.connect(resume); },
  });
  function schedAgo(at){ return topicsFeature.schedAgo(at); }
  function ageText(ms, done){ return topicsFeature.ageText(ms, done); }
  function ageClock(at){ return topicsFeature.ageClock(at); }
  function rowHtml(o){ return topicsFeature.rowHtml(o); }
  function treeRowHtml(row, o){ return topicsFeature.treeRowHtml(row, o); }
  function forkFromText(t){ return topicsFeature.forkFromText(t); }
  function topicExists(id){ return topicsFeature.topicExists(id); }
  function topicById(id){ return topicsFeature.topicById(id); }
  function runOwners(){ return topicsFeature.runOwners(); }
  function topicTree(list){ return topicsFeature.topicTree(list); }
  function treeWalker(tree){ return topicsFeature.treeWalker(tree); }
  function rowRunning(t){ return topicsFeature.rowRunning(t); }
  function splitTitle(title){ return topicsFeature.splitTitle(title); }
  function agentTagHtml(t){ return topicsFeature.agentTagHtml(t); }
  function makeFilterBar(opts){ return topicsFeature.makeFilterBar(opts); }
  function paintTopics(){ topicsFeature.paintTopics(); }
  function schedulePrefetch(){ topicsFeature.schedulePrefetch(); }
  function switchTopic(id){ topicsFeature.switchTopic(id); }
  function enter(id){ topicsFeature.enter(id); }
  function paintAges(){ topicsFeature.paintAges(); }
  function armAgeTick(){ topicsFeature.armAgeTick(); }
  function foldClick(e){ return topicsFeature.foldClick(e); }
  function closeRowMenu(focusBack){ topicsFeature.closeRowMenu(focusBack); }
  function rowMenuFollow(){ topicsFeature.rowMenuFollow(); }
  function openRowMenuFor(btn){ topicsFeature.openRowMenuFor(btn); }
  function createTopic(seed){ return topicsFeature.createTopic(seed); }
  function closeIdle(){ topicsFeature.closeIdle(); }
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
      deleteMessage: function(key){ transcript.retireLocalKey(key); },
      hasElement: function(key){ return Boolean(els[key]); },
      removeElement: function(key){ if(els[key]){ els[key].remove(); delete els[key]; } },
      adoptElement: function(fromKey, toKey){
        transcript.transferLocalKey(fromKey, toKey);
      },
      paint: paint,
      drop: drop,
      sinkLocals: sinkLocals,
      syncEmptyNote: syncEmptyNote,
      atBottom: atBottom,
      toBottom: toBottom,
      onBtwAsked: function(key, msg){ if(btwAsked(key, msg) !== null) openBtw(key); },
      onClaimKeyMoved: function(fromKey, toKey){
        transcript.btw.transferKey(fromKey, toKey);
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
    getRowMenuKey: function(){ return topicsFeature.getRowMenuKey(); },
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
  // Whether the next sync is the one that opens a topic.
  var entering=true;
  // What the last sync said about this topic being older than the daemon.
  var stale=false;
  var launch=null;
  var settleOnResume=false;
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


  // ── Reviews (client/panels/reviews.ts) ─────────────────────────────────────
  function loadReviews(){ reviewsPanel.load(); }
  function paintReviews(){ reviewsPanel.paint(); }
  function settleAdopted(id, typed){ reviewsPanel.settleAdopted(id, typed); }

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



  // ── Notifications ─────────────────────────────────────────────────────────
  // Web Push (webpush.ts on the server, sw.ts the worker): what reaches this device when the page is
  // closed or the phone is in a pocket. Off until the operator turns it on here, per device — the
  // browser asks for permission, and a permission prompt nobody asked for is the fastest way to a
  // "block". Only offered where the browser can do it at all: Chrome, Firefox, Edge, and Safari on
  // iOS only once the page is installed as an app.

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
      if(ev.epoch && epoch && ev.epoch !== epoch) topicsFeature.clearPrefetchTried();
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

  topicsFeature.attach();


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

  // ── Topic cleanup helpers (delegating drafts & unsent to composerController) ──
  function forget(id){
    transcript.scroll.forgetView(id);
    cacheService.forget(id);
    topicsFeature.forgetPrefetch(id);
    composerController.forgetTopic(id);
  }
  function prune(){
    if(!topics.length) return;
    var known={}, id;
    for(var i=0;i<topics.length;i++) known[topics[i].id]=1;
    transcript.scroll.pruneViews(known);
    cacheService.prune(known);
    topicsFeature.prunePrefetch(known);
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
    transcript.refreshI18n();
    topicsFeature.onLocaleChange();
    topicStatus.onLocaleChange();
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
