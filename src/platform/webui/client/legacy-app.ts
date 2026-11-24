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
      transcript.drop(pk);
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
    seedDraft: function(topicId, draftText){
      drafts[topicId] = { text: draftText, s: draftText.length, e: draftText.length, files: [] };
      writeDraft(topicId);
      loadDraft(topicId);
    },
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
    topicsFeature.forgetPrefetch(id);
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
    topicsFeature.prunePrefetch(known);
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
