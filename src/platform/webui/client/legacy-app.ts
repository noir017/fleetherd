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
import { THEMES, getTheme, setTheme, nextTheme, initTheme, themeLabel } from './theme.js';
import {
  applyDomI18n,
  getLocale,
  initLocale,
  localeLabel,
  nextLocale,
  onLocaleChange,
  setLocale,
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
    hasLauncher: function(){ return Boolean(launchEl); },
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
      sig = {};
      skeleton = false;
      stale = false;
      emptyEl = null;
      launch = null;
      launchEl = null;
      launchSig = '';
      dividerEl = null;
      syncingEl = null;
      topicStatus.closeModelPop();
      closeBtw(false);
      topicStatus.setStatus(null);
      topicStatus.setPending([]);
      entering = true;
      synced = false;
      view = views[nextId] || null;
      landedAt = -1;
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
    paintTermHeightIfOpen: function(){ if(topic && termState[topic]==='open') paintTermHeight(); },
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
  var TERM_END = BOOT.terminalEnd;
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
  // The code view's bundle, relative to this page (assets/codeview-<hash>.js), or null when the
  // daemon was built without the asset build. Read only by codeView(), which every caller goes
  // through. Relative for the same reason every other URL here is: a sub-path mount.
  var CODEVIEW = BOOT.codeview;
  // Whether the shared secret is still a way in. False means the gate above has no field and
  // the only thing that can sign anyone in is the proxy in front (sso.password: false).
  var PASSWORD_LOGIN = BOOT.password;
  // A terminal panel belongs to a TOPIC, not to the page: 'open' is shown, 'min' is hidden and
  // still connected, absent is no window at all. Keyed this way because the alternative — one
  // window that follows whichever topic is on screen — would tear down the connection to the
  // topic being left, which is both a surprise (the pane you minimized is gone) and the end of
  // the switcher's marker ever meaning anything: at most one topic could ever be lit.
  var termState = {};
  var termFrames = {};
  // A reload asked for the pane, before any topic is known. "Asked for" is separate from
  // "shown": there is nothing to point a terminal at until the first sync names a topic, so
  // this is spent there rather than here.
  var termBoot = TERM_OK && new URLSearchParams(location.search).get('v')==='term';
  var topics = [];

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

  // The one place the narrow-screen breakpoint lives on this side of the wire. It has to stay
  // the same number as the @media rule above: the CSS turns the sidebar into an overlay, and
  // this decides whether opening a topic should then get it back out of the way.
  var NARROW = 640;
  function narrow(){ return window.innerWidth <= NARROW; }

  /**
   * One side panel, used on both edges of the page: the topic list on the left and the
   * scheduled work on the right. Everything about the way a panel behaves is here once — the
   * width and its drag handle, the open/close animation, the drawer it becomes under its
   * breakpoint, the inert state that keeps Tab out of a panel nobody can see, and the storage
   * that remembers both choices. What the two sides do not share is passed in: which edge it
   * is on, how wide it starts and may get, and how narrow the screen has to be before a column
   * has no room and it slides over the chat instead.
   *
   * Closed, a panel keeps its width and is moved off-screen with a negative margin (a column)
   * or a transform (a drawer) — never display:none, because a hidden element has nothing to
   * animate. --pw is the dragged width, inline and kept per browser; the stylesheet's
   * --pw-default is the fallback, and the two must agree with width() below.
   */
  function makePanel(cfg){
    var el=cfg.el, handle=cfg.handle, open=false, drag=null;
    function docked(){ return window.innerWidth >= cfg.dockAt; }
    function width(){
      var w=parseFloat(el.style.getPropertyValue('--pw'));
      if(w > 0) return w;
      return typeof cfg.width === 'function' ? cfg.width() : cfg.width;
    }
    function maxWidth(){
      return Math.max(cfg.min, Math.min(cfg.max, cfg.maxWidth ? cfg.maxWidth() : cfg.max));
    }
    function setWidth(w, keep){
      if(w == null){
        el.style.removeProperty('--pw');
        try { localStorage.removeItem(cfg.widthKey); } catch(x){}
        return;
      }
      w = Math.round(Math.max(cfg.min, Math.min(maxWidth(), w)));
      el.style.setProperty('--pw', w+'px');
      if(keep) try { localStorage.setItem(cfg.widthKey, String(w)); } catch(x){}
    }
    function paint(){
      el.classList.toggle('collapsed', !open);
      // A panel moved off-screen is still in the tab order: without this, Tab walks into a
      // column nobody can see. Removed as soon as it is open, and harmless on a docked column.
      if(open) el.removeAttribute('inert'); else el.setAttribute('inert', '');
      if(cfg.onPaint) cfg.onPaint(open);
    }
    function setOpen(next, opts){
      opts = opts || {};
      if(next === open){ if(opts.force) paint(); return; }
      open = next;
      // A close nobody asked for — following a session on an overlay, where the panel would
      // cover the chat it just opened — is not a preference, so it leaves storage alone.
      if(!opts.transient && cfg.storeKey){
        try { if(open) localStorage.setItem(cfg.storeKey,'1'); else localStorage.removeItem(cfg.storeKey); } catch(x){}
      }
      paint();
      if(cfg.onChange) cfg.onChange(open);
    }
    // The drag listens on the document rather than the 8px handle, because the pointer leaves
    // the handle on the first fast move. The edge it measures from is the one the panel is
    // anchored to: the left panel grows to the right, the right panel to the left.
    handle.addEventListener('pointerdown', function(e){
      if(!docked()) return;
      e.preventDefault();
      drag = {edge: cfg.side === 'left' ? el.getBoundingClientRect().left : el.getBoundingClientRect().right};
      handle.className = 'panel-resize dragging';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('pointermove', function(e){
      if(drag) setWidth(cfg.side === 'left' ? e.clientX - drag.edge : drag.edge - e.clientX, false);
    });
    document.addEventListener('pointerup', function(){
      if(!drag) return;
      drag = null;
      handle.className = 'panel-resize';
      document.body.style.userSelect = '';
      var w = parseFloat(el.style.getPropertyValue('--pw'));
      if(w > 0) setWidth(w, true);
    });
    handle.addEventListener('dblclick', function(){ setWidth(null); });
    // The saved width is applied before the first paint, so a reload does not flash the default
    // column and then jump to the operator's.
    var saved = 0;
    try { saved = Number(localStorage.getItem(cfg.widthKey)); } catch(x){}
    if(saved > 0) setWidth(saved, false);
    paint();
    return {el:el, isOpen:function(){ return open; }, setOpen:setOpen, toggle:function(){ setOpen(!open); },
            width:width, setWidth:setWidth, docked:docked};
  }

  // The two panels. The left starts open on a wide screen and closed on a phone; the right is
  // closed until asked for, and only restored where it can be docked (below 1024px it would come
  // back as a drawer over the chat nobody asked it to cover).
  var sbPane = makePanel({
    el: sidebar, handle: $('sidebar-resize'), side:'left',
    min:180, max:640, width:240, storeKey:'aa_sb_open', widthKey:'aa_sb_w',
    dockAt: NARROW + 1,
    // The cap leaves the chat 360px with the right panel docked: that panel's width comes off
    // the top, and the sidebar may take the rest up to 640.
    maxWidth: function(){
      return window.innerWidth - 360 - (schedPane && schedPane.isOpen() && schedPane.docked() ? schedPane.width() : 0);
    },
    onPaint: function(open){
      app.classList.toggle('sb-open', open);
      expandBtn.hidden = open;
    }
  });
  var schedPane = makePanel({
    el: schedPanel, handle: schedResize, side:'right',
    min:220, max:640,
    // The stylesheet's clamp(240px,20vw,320px), as the number the caps and the drag need.
    width: function(){ return Math.min(320, Math.max(240, Math.round(window.innerWidth * 0.20))); },
    storeKey:'aa_sched_open', widthKey:'aa_sched_w',
    dockAt: 1024,
    // The sidebar's stored width, not its current on-screen one: that is the width the chat
    // loses whenever the sidebar is open, which is what this cap has to keep room for.
    maxWidth: function(){ return window.innerWidth - sbPane.width() - 360; },
    onPaint: function(open){
      app.classList.toggle('sched-open', open);
      schedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      schedToggle.classList.toggle('on', open);
      paintSchedTab();
    },
    onChange: function(open){
      if(open) schedulesPanel.onPanelOpen();
      else schedulesPanel.disarm();
      clampPanels();
    }
  });

  /**
   * Both widths are capped against the other column, so opening or closing one can leave the
   * other past its maximum. The clamp rewrites --pw, not storage: the narrower width stays until
   * the page is reloaded, when the stored one is applied again.
   */
  function clampPanels(){
    // Only a column has a width of its own; in drawer mode the screen decides it, and a clamp
    // here would shrink the saved width of a window that is merely narrow at the moment.
    if(!sbPane.docked()) return;
    var w = parseFloat(sidebar.style.getPropertyValue('--pw'));
    if(w > 0) sbPane.setWidth(w, false);
    if(schedPane.docked()){
      var sw = parseFloat(schedPanel.style.getPropertyValue('--pw'));
      if(sw > 0) schedPane.setWidth(sw, false);
    }
  }

  function setSidebar(open){ sbPane.setOpen(open); }
  collapseBtn.addEventListener('click', function(){ setSidebar(false); });
  expandBtn.addEventListener('click', function(){ setSidebar(true); });

  // Restored on the next visit. A first visit on a phone starts with the topic list out of the
  // way; a wide one starts with it open. Neither writes the default back to storage.
  var savedSbOpen = null;
  try { savedSbOpen = localStorage.getItem('aa_sb_open'); } catch(x){}
  if(savedSbOpen === null) savedSbOpen = narrow() ? '0' : '1';
  if(savedSbOpen !== '0') sbPane.setOpen(true, {transient:true});

  /**
   * The two menus at the foot of the sidebar — Menu (all settings, notifications, low attention,
   * skills) and Manage (close idle). One open at a time, one box in one place;
   * a click anywhere else puts it away, and Escape puts it away and gives the focus back to the
   * button that opened it. A disclosure rather than an ARIA menu: role=menu promises arrow-key
   * navigation, and these are reached with Tab like any other buttons.
   */
  var menus = [];
  function setMenu(entry, open){
    for(var i=0;i<menus.length;i++){
      var e=menus[i], on = open && e === entry;
      e.menu.hidden = !on;
      e.btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }
  function openMenu(){
    for(var i=0;i<menus.length;i++) if(!menus[i].menu.hidden) return menus[i];
    return null;
  }
  function addMenu(btn, menu){
    var entry={btn:btn, menu:menu};
    menus.push(entry);
    btn.addEventListener('click', function(){ setMenu(entry, menu.hidden); });
  }
  addMenu(optsBtn, optsMenu);
  addMenu(manageBtn, manageMenu);
  document.addEventListener('click', function(e){
    var m=openMenu();
    if(!m || m.menu.contains(e.target) || m.btn.contains(e.target)) return;
    setMenu(null, false);
  });

  // One sheet dismisses whichever drawer is over the chat. Both are put away if a narrow screen
  // has somehow got both open — a tap outside means "show me the chat".
  backdrop.addEventListener('click', function(){
    if(schedPane.isOpen()) setSchedules(false);
    if(sbPane.isOpen()) setSidebar(false);
  });

  /**
   * Low attention (#app.calm in the stylesheet, which says what it changes and why). Per device,
   * like the sidebar's width: the phone in a pocket and the desktop with five agents on it are not
   * asking for the same list. Absent means off, so nothing changes until someone asks for it.
   */
  var calm = false;
  try { calm = localStorage.getItem('aa_calm') === '1'; } catch(x){}
  function paintCalm(){
    app.classList.toggle('calm', calm);
    calmBtn.setAttribute('aria-pressed', calm ? 'true' : 'false');
    calmState.textContent = calm ? tr('common.on') : tr('common.off');
  }
  calmBtn.addEventListener('click', function(){
    calm = !calm;
    try { if(calm) localStorage.setItem('aa_calm', '1'); else localStorage.removeItem('aa_calm'); } catch(x){}
    paintCalm();
  });
  paintCalm();

  var THEME_I18N_KEYS = { system: 'menu.themeSystem', dark: 'menu.themeDark', light: 'menu.themeLight' };
  function localizedThemeLabel(id){
    var key = THEME_I18N_KEYS[id];
    return key ? tr(key) : themeLabel(id);
  }
  function paintTheme(){
    var current = getTheme();
    var label = localizedThemeLabel(current);
    var options = THEMES.map(function(entry){ return localizedThemeLabel(entry.id); }).join(' / ');
    themeState.textContent = label;
    themeBtn.setAttribute('aria-label', tr('menu.themeAria', { label: label }));
    themeBtn.title = tr('menu.themeTitle', { label: label, options: options });
  }
  themeBtn.addEventListener('click', function(){
    setTheme(nextTheme());
    paintTheme();
  });
  initTheme(paintTheme);
  paintTheme();
  function paintLang(){
    if(langState) langState.textContent = localeLabel(getLocale());
  }
  if(langBtn){
    langBtn.addEventListener('click', function(){
      setLocale(nextLocale(getLocale()));
    });
  }
  paintLang();

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
    if(outbox[m._nonce]) h += '<button type="button" data-retry="'+text(m._nonce)+'">'+text(tr('common.retry'))+'</button>';
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

  // ── Notifications ─────────────────────────────────────────────────────────
  // Web Push (webpush.ts on the server, sw.ts the worker): what reaches this device when the page is
  // closed or the phone is in a pocket. Off until the operator turns it on here, per device — the
  // browser asks for permission, and a permission prompt nobody asked for is the fastest way to a
  // "block". Only offered where the browser can do it at all: Chrome, Firefox, Edge, and Safari on
  // iOS only once the page is installed as an app.
  var PUSH_OK = Boolean(window.isSecureContext && navigator.serviceWorker && window.PushManager && window.Notification);
  var pushKey = null, pushSub = null, notifyInit = false;
  function keyBytes(s){
    var b = atob((s + '==='.slice((s.length + 3) % 4)).replace(/-/g,'+').replace(/_/g,'/'));
    var out = new Uint8Array(b.length);
    for(var i=0;i<b.length;i++) out[i]=b.charCodeAt(i);
    return out;
  }
  function paintNotify(){
    if(!PUSH_OK || !pushKey){ notifyBtn.hidden=true; return; }
    notifyBtn.hidden=false;
    if(window.Notification.permission==='denied'){
      notifyBtn.disabled=true;
      notifyBtn.setAttribute('aria-pressed','false');
      notifyState.textContent=tr('menu.notificationsBlocked');
      notifyBtn.title=tr('menu.notificationsBlockedTitle');
      return;
    }
    notifyBtn.disabled=false;
    notifyBtn.setAttribute('aria-pressed', pushSub ? 'true' : 'false');
    notifyState.textContent = pushSub ? tr('common.on') : tr('common.off');
    notifyBtn.title = pushSub
      ? tr('menu.notificationsOnTitle')
      : tr('menu.notificationsOffTitle');
  }
  // Once the stream is open, i.e. once signed in: api/push is behind the session like every route.
  function initNotify(){
    if(!PUSH_OK || notifyInit) return;
    notifyInit = true;
    fetch('api/push', {credentials:'same-origin'}).then(function(r){ return r.json(); }).then(function(d){
      if(!d || !d.enabled || !d.key) return;
      pushKey = d.key;
      return navigator.serviceWorker.getRegistration('sw.js').then(function(reg){
        return reg ? reg.pushManager.getSubscription() : null;
      }).then(function(sub){ pushSub = sub; paintNotify(); });
    }).catch(function(){});
  }
  notifyBtn.addEventListener('click', function(){
    if(!pushKey) return;
    notifyBtn.disabled = true;
    if(pushSub){
      var endpoint = pushSub.endpoint;
      pushSub.unsubscribe().catch(function(){}).then(function(){
        pushSub = null;
        return post('api/push/unsubscribe', {endpoint:endpoint}, 1);
      }).catch(function(){}).then(paintNotify);
      return;
    }
    window.Notification.requestPermission().then(function(permission){
      if(permission !== 'granted') return;
      return navigator.serviceWorker.register('sw.js').then(function(){ return navigator.serviceWorker.ready; }).then(function(reg){
        return reg.pushManager.getSubscription().then(function(old){
          return old || reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:keyBytes(pushKey)});
        });
      }).then(function(sub){
        return post('api/push/subscribe', sub.toJSON(), 1).then(function(r){
          if(r.ok){ pushSub = sub; return; }
          return r.json().then(function(d){ throw new Error((d && d.error) || ('HTTP '+r.status)); });
        });
      });
    }).catch(function(e){
      alert(tr('menu.notificationsError', { err: (e && e.message) || e }));
    }).then(paintNotify);
  });
  // A notification tapped while this page is open: the worker asks it to show the topic. And a
  // topic the worker has just written to the cache (sw.ts keepTopic), noted so the prefetch does not
  // fetch it a second time and an older copy in memory is not put up in its place.
  if(PUSH_OK) navigator.serviceWorker.addEventListener('message', function(e){
    var kept = e.data && e.data.cached;
    if(kept && typeof kept === 'object' && typeof kept.topic === 'string'){ noteVer(kept.topic, kept.last, kept.epoch); return; }
    var goId = e.data && e.data.goto;
    if(goId && goId!==topic && topics.some(function(t){ return t.id===goId; })){
      switchTopic(goId);
      if(narrow()) setSidebar(false);
    }
  });


  // ── Terminal ───────────────────────────────────────────────────────────────
  // A panel at the bottom of the conversation, one per topic. The iframe holds ttyd's own
  // terminal, which is why this is a hundred lines instead of a terminal emulator. Nothing here
  // speaks to the agent — the two share a topic id and nothing else.

  // How tall the panel is, in pixels, once the divider has been dragged. 0 means "half the
  // chat": recomputed rather than frozen, so a phone and a desktop each get half of their own
  // screen, and a panel that was never resized follows a window that changes size.
  var TERM_H_KEY = 'aa_term_h', TERM_MIN = 120, TERM_MIN_LOG = 120;
  var termH = 0;
  try { var storedTermH = parseInt(localStorage.getItem(TERM_H_KEY) || '', 10); if(storedTermH > 0) termH = storedTermH; } catch(x){}

  /**
   * What the panel may be: never taller than the chat it sits in, and never so tall that the
   * transcript has no lines left. What is above it is measured rather than guessed — a phone's
   * header and two-row composer are most of the chat, and a fixed allowance sized for a desktop
   * would leave the log 20px tall there. On a window too short for both, the chat wins.
   */
  function termLimits(){
    var room = chat.clientHeight;
    if(!room) return {min:TERM_MIN, max:TERM_MIN + 40};
    var fixed = chatHead.clientHeight + composer.clientHeight + (termGrip.offsetHeight || 12) + TERM_MIN_LOG;
    var max = Math.min(room, Math.max(TERM_MIN, room - fixed));
    return {min:Math.min(TERM_MIN, max), max:max};
  }
  function termHeight(){
    var lim = termLimits();
    return Math.max(lim.min, Math.min(lim.max, termH || Math.round(chat.clientHeight * 0.5)));
  }
  // Set as a pixel height rather than a percentage: a closed panel is parked at this size, and
  // it must not change under a hidden iframe — a resize there is a redraw the reader never asked
  // for, and on some backends a detach.
  function paintTermHeight(){
    // While a record from History is up, #bar and the divider are display:none and measure 0 —
    // a ceiling worked out from those would be ~100px too generous, and the panel would come
    // back from the record too tall. closeLib paints again once they are back on screen.
    if(libOn()) return;
    var lim = termLimits(), h = termHeight();
    termEl.style.height = h + 'px';
    termGrip.setAttribute('aria-valuenow', String(h));
    termGrip.setAttribute('aria-valuemin', String(lim.min));
    termGrip.setAttribute('aria-valuemax', String(lim.max));
  }
  function setTermHeight(h){
    var lim = termLimits();
    termH = Math.max(lim.min, Math.min(lim.max, Math.round(h)));
    paintTermHeight();
  }
  function saveTermHeight(){
    try { if(termH) localStorage.setItem(TERM_H_KEY, String(termH)); else localStorage.removeItem(TERM_H_KEY); } catch(x){}
  }

  // What the address bar should say now. The topic and the pane are both worth surviving a
  // reload, and both are written the same way so neither can silently drop the other.
  function urlNow(){
    return '?t='+encodeURIComponent(topic) + (termState[topic]==='open' ? '&v=term' : '');
  }

  // Mounted on first use, so a page that never opens a terminal never connects to ttyd, and
  // dropped only when the window is CLOSED — never when it is minimized and never when the
  // topic changes. What survives a drop is the session itself, on the far side, which is the
  // operator's arrangement (ttyd hangs up its child; their wrapper holds the session open) and
  // the reason closing needs a server round trip while minimizing does not.
  function applyTerm(){
    if(!TERM_OK) return;
    if(termBoot && topic){
      termBoot = false;
      if(!termState[topic]) termState[topic]='open';
    }
    var state = topic ? termState[topic] : undefined;
    var on = state === 'open';
    chat.classList.toggle('term', on);
    // After the class, so the divider the panel is measured against is on screen and has its
    // height — and only while it is on screen: painting a closed panel would resize the parked
    // iframe for nothing, which is the redraw this design exists to avoid. Before mountTerm, so
    // a window opened for the first time is born at the height it will keep.
    if(on) paintTermHeight();
    termBtn.classList.toggle('on', Boolean(state));
    termBtn.title = on ? tr('term.minBtnTitle') : (state ? tr('term.showRunningTitle') : tr('term.title'));
    // Only ever rendered where a session can actually be ended; see TERM_END.
    termEndBtn.hidden = !TERM_END;
    if(state && topic) mountTerm(topic);
    paintFrames();
  }

  function mountTerm(id){
    if(termFrames[id]) return;
    var frame = document.createElement('iframe');
    frame.setAttribute('title','Terminal');
    // Relative, for the same reason every fetch here is: a reverse proxy may mount the daemon
    // under a sub-path, and an absolute "/" walks out of it.
    frame.setAttribute('src','term/?arg='+encodeURIComponent(id));
    termFrames[id] = frame;
    termHost.appendChild(frame);
  }

  /**
   * Exactly one mounted terminal is visible: the current topic's, and only while it is open and
   * nothing else covers the chat.
   *
   * A record from History is why the second half is here rather than in the stylesheet. The
   * panel's own visibility is inherited, and an iframe's rule saying visible wins over it — so a
   * parent rule alone leaves the terminal painted over the record, visible and unclickable. The
   * frame's on class is the one thing that decides, and openLib/closeLib repaint through here.
   */
  function paintFrames(){
    var on = Boolean(topic && termState[topic]==='open' && !libOn());
    for(var id in termFrames){
      if(!Object.prototype.hasOwnProperty.call(termFrames, id)) continue;
      var live = on && id===topic;
      termFrames[id].classList.toggle('on', live);
      // Per frame, not only on the panel: with one topic's terminal open, another topic's frame
      // is still mounted and hidden, and inert is what keeps it out of reach from script.
      termFrames[id].toggleAttribute('inert', !live);
    }
    // Inert as well as invisible: visibility keeps the keyboard out, but an iframe can still be
    // focused from script — and a terminal that grabs focus while it is parked is typing going
    // somewhere the person cannot see. This one covers the panel's own two buttons.
    termEl.toggleAttribute('inert', !on);
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    termName.textContent = cur && cur.title ? cur.title : 'Untitled';
  }

  /** Unmount one topic's terminal. Ends a connection, never a session — see endTerm. */
  function dropTerm(id){
    var frame = termFrames[id];
    if(frame){
      if(frame.parentNode) frame.parentNode.removeChild(frame);
      delete termFrames[id];
    }
    delete termState[id];
  }

  function showTerm(){
    if(!TERM_OK || !topic) return;
    // Opening the panel takes height from the transcript, and a reader who was at the bottom
    // would otherwise find the newest message pushed under the divider.
    var stick = atBottom();
    termState[topic] = 'open';
    history.replaceState(null,'',urlNow());
    applyTerm();
    if(stick) toBottom();
  }

  // Hidden, not unmounted: the point of minimizing is that whatever is running in there keeps
  // running AND stays connected, so coming back is a repaint rather than a reconnect and a
  // redraw.
  function minTerm(){
    if(!TERM_OK || !topic || !termState[topic]) return;
    termState[topic] = 'min';
    history.replaceState(null,'',urlNow());
    applyTerm();
  }

  /**
   * End the session, which is a different act from closing the window and is why it asks first.
   *
   * Dropping the iframe would only hang up on a shell that carries on without us. What actually
   * ends it is a command the operator configured, so this is a request; the window is taken down
   * only once the server says it worked, because a window closed over a session that is still
   * alive is the one outcome nobody could explain from the screen.
   */
  function endTerm(){
    if(!TERM_OK || !TERM_END || !topic || !termState[topic]) return;
    var cur = null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    var title = (cur && cur.title) ? cur.title : tr('common.untitled');
    if(!confirm(tr('term.confirmEnd', { title: title }))) return;
    var id = topic;
    // Not retried, unlike a send. A 500 here means the operator's command ran and failed, and
    // running it again 700ms later answers the same way while spawning a second process; the
    // retry in post() is for a link that dropped a request, which is not this.
    post('api/terminal/end',{topic:id},0).then(function(r){
      return r.ok ? {ok:true} : r.json().then(function(d){ return {ok:false, error:(d&&d.error)||tr('term.endFailed')}; }, function(){ return {ok:false, error:tr('term.endFailed')}; });
    }).then(function(d){
      if(!d.ok){ alert(d.error); return; }
      dropTerm(id);
      if(id===topic){ history.replaceState(null,'',urlNow()); applyTerm(); }
    }, function(){
      alert(tr('term.endReachErr'));
    });
  }

  var settleOnResume=false;

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
      if(!btwBox.hidden) renderBtw(false);
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

  // Revealed only where there is something behind it. When the daemon serves no terminal the
  // button stays hidden and these listeners never have anything to toggle.
  if(TERM_OK){
    termBtn.hidden = false;
    // One button, three states: no window opens one, a shown window is minimized, a minimized
    // one comes back. Minimizing from here as well as from the title bar because the header
    // button is where the hand already is on a phone, and because it is what this button did
    // before there was a window to minimize.
    termBtn.addEventListener('click', function(){
      if(termState[topic]==='open') minTerm(); else showTerm();
    });
    termMinBtn.addEventListener('click', minTerm);
    termEndBtn.addEventListener('click', endTerm);

    // Dragging the divider. The new height comes from the POINTER's travel rather than from the
    // panel's box: a drag grabbed anywhere on the strip must not jump on the first move, and the
    // panel's own bottom edge is the window's, which does not move.
    var termDrag = null;
    termGrip.addEventListener('pointerdown', function(e){
      if(!topic || !termState[topic]) return;
      e.preventDefault();
      termDrag = {y:e.clientY, h:termHeight()};
      termGrip.classList.add('drag');
      if(termGrip.setPointerCapture) try { termGrip.setPointerCapture(e.pointerId); } catch(x){}
    });
    termGrip.addEventListener('pointermove', function(e){
      if(termDrag) setTermHeight(termDrag.h - (e.clientY - termDrag.y));
    });
    var endTermDrag = function(){
      if(!termDrag) return;
      termDrag = null;
      termGrip.classList.remove('drag');
      saveTermHeight();
    };
    // On the window, not the strip: when the capture fails the pointerup can land anywhere, and
    // a drag that never ends leaves the next pointermove still resizing the panel.
    window.addEventListener('pointerup', endTermDrag);
    window.addEventListener('pointercancel', endTermDrag);
    termGrip.addEventListener('lostpointercapture', endTermDrag);
    // Back to half the chat, the same gesture the two side panels offer for their width.
    termGrip.addEventListener('dblclick', function(){
      termH = 0;
      paintTermHeight();
      saveTermHeight();
    });
    // A divider is a control, so it answers the keyboard as well as the pointer.
    termGrip.addEventListener('keydown', function(e){
      if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      setTermHeight(termHeight() + (e.key === 'ArrowUp' ? 24 : -24));
      saveTermHeight();
    });
    // A shorter window may leave a stored height taller than the chat; the transcript keeps its
    // lines. Not while the panel is closed (the parked iframe must not be resized for nothing),
    // and not while a record is up — its composer is hidden, so there is nothing to measure
    // against; closeLib does it when the record goes.
    window.addEventListener('resize', function(){
      if(topic && termState[topic]==='open' && !libOn()) paintTermHeight();
    });
  }

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
    for(id in termFrames){
      if(Object.prototype.hasOwnProperty.call(termFrames, id) && !keep[id]) dropTerm(id);
    }
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

  function openShot(img){
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
  }
  function closeShot(){
    if(lightbox.hidden) return;
    lightbox.hidden = true;
    // Dropped rather than left behind: a full-resolution screenshot held decoded by an overlay
    // nobody is looking at is the kind of thing a daemon running for weeks pays for.
    lightboxImg.removeAttribute('src');
  }
  lightbox.addEventListener('click', closeShot);

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
    if(!btwBox.hidden){ closeBtw(true); return true; }
    if(schedPane.isOpen()){ setSchedules(false); return true; }
    if(sbPane.isOpen()){ setSidebar(false); return true; }
    return false;
  });

  /**
   * The code view — CodeMirror, bundled into assets/ and loaded the first time a file needs it.
   *
   *   editor(parent, {doc, name, readOnly?, onChange?(doc), onSave?()})
   *     → {getDoc(), setDoc(doc), focus(), destroy()}
   *   diff(parent, {name, original, modified, layout: 'unified'|'split', onSelect?(sel|null)})
   *     → {setLayout(layout), destroy()}     sel = {side: 'old'|'new', from, to, text}, lines from 1
   *   highlighter(lang) → Promise<null | (code) → [[from, to, classes], ...]>   (a fence's colours)
   *
   * window.__fhCodeView is the seam, and it is checked first: page.dom.test.ts puts a fake there.
   *
   * Resolves null when there is nothing to load or the import failed. That is not an error the
   * caller reports: the reader already has the server's pre element, which is a complete answer,
   * and the page is built to work with no bundle at all (a source checkout that never ran the
   * asset build). The warning is once per page, not once per file.
   */
  var codeViewP = null, codeViewWarned = false;
  function codeView(){
    if(window.__fhCodeView) return Promise.resolve(window.__fhCodeView);
    if(!CODEVIEW) return Promise.resolve(null);
    if(codeViewP) return codeViewP;
    // Absolute, because a relative specifier in an INLINE classic script does not resolve:
    // Chromium answers "Failed to resolve module specifier" — measured 2026-11-18, and the bundle
    // is next to the page in its own directory. document.baseURI keeps a sub-path mount working
    // (a proxy prefix is part of the page's own URL), and the URL is same-origin, which is what
    // the CSP's script-src 'self' admits.
    codeViewP = import(new URL(CODEVIEW, document.baseURI).href).then(function(m){
      return (m && m.default) || m || null;
    }).catch(function(e){
      if(!codeViewWarned){ codeViewWarned = true; console.warn('code view unavailable, showing plain text:', e); }
      return null;
    });
    return codeViewP;
  }

  /**
   * Read a file the agent sent without downloading it. The server renders it (reading.ts) and the
   * answer fills a window over the transcript. The name and the download link are on the file's
   * own link, so a slow link shows which file is coming rather than an empty frame.
   *
   * A text file also arrives as its own bytes (text), and when the code view is available it is
   * shown in that instead of the server's pre element; markdown keeps the rendered HTML. The pre
   * is the fallback rather than a second mode, because it is what the server would have shown.
   *
   * readSeq is which opening an answer belongs to. Close one file and open another before the first
   * has answered, and without it the first file's text would land under the second one's name.
   */
  var readSeq = 0, readerEditor = null;
  function readerDoc(note, html){
    readerBody.innerHTML = note + '<div class="b">' + html + '</div>';
    codeBlocks(readerBody);
    readerBody.scrollTop = 0;
  }
  function readerDropEditor(){
    if(readerEditor){ readerEditor.destroy(); readerEditor = null; }
    readerBody.classList.remove('cv');
  }
  function openReader(link){
    readerDropEditor();
    readerName.textContent = link.textContent;
    readerName.title = readerName.textContent;
    readerGet.setAttribute('href', link.getAttribute('href'));
    readerSay(tr('common.loading'));
    reader.hidden = false;
    readerBody.focus();
    var mine = ++readSeq;
    fetch(link.getAttribute('data-view'), {credentials:'same-origin'}).then(function(r){
      return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; });
    }).then(function(res){
      if(mine !== readSeq) return;
      if(!res.ok) return readerSay(res.status === 404
        ? tr('reader.gone')
        : (res.body && res.body.error) || tr('reader.cannotShow'));
      var j = res.body, note = '';
      if(j.shown < j.size) note = '<div class="reader-note">'+text(tr('reader.partial', { shown: byteSize(j.shown), size: byteSize(j.size) }))+'</div>';
      if(typeof j.text !== 'string') return readerDoc(note, j.html);
      codeView().then(function(cv){
        if(mine !== readSeq) return;
        if(!cv) return readerDoc(note, j.html);
        readerBody.classList.add('cv');
        readerBody.innerHTML = note;
        var host = document.createElement('div');
        host.className = 'cv-host';
        readerBody.appendChild(host);
        try {
          readerEditor = cv.editor(host, {doc:j.text, name:j.name, readOnly:true});
        } catch(e) {
          // A bundle that loaded but cannot build an editor is the same answer as no bundle:
          // the plain text the server sent, rather than an empty window.
          console.warn('code view failed, showing plain text:', e);
          readerDropEditor();
          readerDoc(note, j.html);
        }
      });
    }).catch(function(){ if(mine === readSeq) readerSay(tr('common.reachServerError')); });
  }
  function readerSay(s){ readerBody.innerHTML = '<div class="empty">'+text(s)+'</div>'; }
  function closeReader(){
    if(reader.hidden) return;
    reader.hidden = true;
    readSeq++;
    readerDropEditor();
    // Emptied, not kept: half a megabyte of rendered document is a lot of DOM to leave behind an
    // overlay nobody is looking at — the lightbox drops its picture for the same reason.
    readerBody.textContent = '';
  }
  function byteSize(n){ return n < 1048576 ? Math.max(1, Math.round(n/1024)) + ' KB' : (n/1048576).toFixed(1) + ' MB'; }
  $('reader-close').addEventListener('click', closeReader);
  // The dimmed page behind the window is a way out too, as it is for the lightbox — but only the
  // backdrop itself: a click that lands in the document must not close what is being read.
  reader.addEventListener('click', function(e){ if(e.target === reader) closeReader(); });

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
    delete views[id];
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
    for(id in views) if(!known[id]) delete views[id];
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
    if(!els[pk]) return;
    var key = (m.g || epoch) + ':' + m.id;
    if(els[key]){ els[pk].remove(); }
    else {
      els[key]=els[pk];
      sig[key]=sig[pk];
      els[key].setAttribute('data-k', key);
    }
    delete els[pk];
    delete sig[pk];
    delete data[pk];
    // A side question's card follows it to the key the daemon gave it.
    if(btwKey === pk) btwKey = key;
    if(btwShut[pk]){ btwShut[key] = 1; delete btwShut[pk]; }
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
    forkNoteKey = '';
    launchSig = '';
    topicsFeature.onLocaleChange();
    topicStatus.onLocaleChange();
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
