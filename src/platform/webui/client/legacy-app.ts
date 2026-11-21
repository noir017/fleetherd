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
      sbTabTopics=$('sb-tab-topics'), sbTabHistory=$('sb-tab-history'), topicsFilterHost=$('topics-filter'),
      historyPane=$('history-pane'), historyCountEl=$('history-count'),
      historyBody=$('history-body'), historyQ=$('history-q'), historyGo=$('history-go'),
      historyErr=$('history-err'), historyListEl=$('history-list'), historyMore=$('history-more'),
      libLog=$('lib-log'), libTitle=$('lib-title'), libNote=$('lib-note'), libWhy=$('lib-why'),
      libTopicBtn=$('lib-topic'), libCloseBtn=$('lib-close'),
      settingsPage=$('settings-page'), settingsBody=$('settings-body'), settingsTopicEl=$('settings-topic'),
      taskPage=$('task-page'), taskTitle=$('task-title'), taskSub=$('task-sub'), taskClose=$('task-close'),
      taskNote=$('task-note'), taskView=$('task-view'),
      settingsClose=$('settings-close'), settingsOpenBtn=$('settings-open'),
      copyRefBtn=$('copy-ref'), killBtn=$('kill-agent'), stopBtn=$('stop-turn'), statusEl=$('status'), machineNoteEl=$('machine-note'),
      updateEl=$('update'),
      modelPop=$('model-pop'), mpList=$('mp-list'), mpFilter=$('mp-filter'), mpAgent=$('mp-agent'),
      mpHeading=$('mp-heading'), mpFoot=$('mp-foot');
  // The 30-second tick that keeps the ages current (see paintAges). Declared here, not beside
  // its functions, because paintSessions can arm it while the script is still setting up — and a
  // var initialised after that would overwrite the timer's handle with null and leak the timer.
  var AGE_TICK_MS=30000, ageTimer=null;
  var data={}, els={}, files=[], commands=[], stream=null;
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
    closeModelPop: closeModelPop,
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
  // Which of the agent's own settings to draw for a topic with no status yet (see "The agent's own
  // settings"). Up here because paintStatus reads it, and the launcher repaints the status line
  // while the script is still setting up.
  var opk={ topic: null, agent: '', model: '', options: [], seq: 0, timer: null };
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
  // What the server decided for this deployment (page.ts bootConfig), written into the page as
  // JSON rather than spliced into this script: the script is now one file every deployment shares.
  var BOOT = JSON.parse($('boot-config').textContent);
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
    getSettingsMsg: function(){ return settingsMsg; },
    getSettingsTopic: function(){ return settingsTopic; },
    getTopic: function(){ return topic; },
    renderSettings: renderSettings,
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
  var readCounts = {};
  try { readCounts = JSON.parse(localStorage.getItem('aa_reads') || '{}'); } catch(x){}
  // The /setting page: the live settings message it draws, the topic it was opened in, and the
  // one message whose page the operator closed. A settings message is never a row in the
  // transcript, and the daemon marks a retired one (wasSettings) so it cannot become one later.
  // settingsClosed is per message id, so an edit to the page that was put away does not reopen
  // it — a new /setting is a new message, and that does open.
  //
  // A request made from the menu has no message id yet, so closing it while it is still Loading
  // cannot be remembered that way. It gets a token (settingsReq); the answers are matched to the
  // tokens by order, since the daemon answers one /setting with one screen, and closing cancels
  // every token issued so far (settingsClosedUpTo). An answer to a cancelled request is dropped;
  // a later request has a later token and still opens. A token is also tagged with the topic it
  // was asked in: an answer arriving after a topic switch belongs to that topic's queue, not the
  // one on screen.
  // settingsNote: the page's own line when a control's request failed (cleared by the next screen);
  // settingsLevel: which level is drawn, so a move between them starts at the top.
  // settingsListFk: the list's control that last posted, which a move back to the list lands on.
  var settingsMsg=null, settingsTopic=null, settingsClosed={}, settingsNote=null, settingsLevel='', settingsFade=0, settingsQuery='';
  var settingsListFk=null;
  var SETTINGS_FADE_MS=5000;
  var settingsReq=0, settingsPending=[], settingsClosedUpTo=0, settingsTimer=0;
  // How long the page waits for the screen before saying the daemon did not answer. The send
  // itself gives up after fifteen seconds on one attempt, so this is the same patience.
  var SETTINGS_WAIT_MS=15000;

  function saveReads(){
    try { localStorage.setItem('aa_reads', JSON.stringify(readCounts)); } catch(x){}
  }

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

  // ── Each topic's copy ───────────────────────────────────────────────────────
  // What lets a topic paint before its stream has answered, lets the stream resume rather than send
  // the whole topic again, and makes a daemon restart cost the conversation its liveness rather than
  // its contents.
  //
  // One copy per topic, behind one put and one get, in two layers: memory (copies: the topics most
  // recently put, COPY_TOPICS of them and COPY_MSGS messages between them — no database read, and
  // all a browser without IndexedDB has) and IndexedDB (cache-script.ts's records, shared with the
  // service worker, which writes the topic a push is about). Every copy says what it is a copy of,
  // the id of the last event it reflects, and one rule says which of two copies is newer (newer):
  // neither layer takes an older copy over a newer one. vers is the newest copy this page knows of
  // for each topic, {last, epoch} — from every put, read and peek, and from the service worker — so
  // deciding how to open a topic and what to fetch reads no database. Absent: not looked at since
  // the page loaded.
  //
  // Through 3.13 a topic could be on the page three times — held in memory when it was left, a
  // record in the database, a copy fetched before it was opened — each with its own idea of new,
  // and entering a topic took them in a fixed order rather than the newest. A topic left mid-turn
  // came back as it was left, never fetched, and the finished turn arrived a second or two later.
  __FH_CACHE_CORE__;
  // How long the copy of the topic on screen waits to be put: a streamed reply upserts the same
  // message every second or so, and each would otherwise re-serialise the whole topic.
  var SAVE_MS=400, COPY_TOPICS=8, COPY_MSGS=4000;
  // copySeq orders memory's copies by when they were put: two puts can share a millisecond.
  var db=null, dbOff=false, saveTimer=null, copies={}, vers={}, copySeq=0;

  function cacheOff(why){
    if(dbOff) return;
    dbOff=true; db=null;
    // Once, and only once. The page works without the cache, and a line per attempted write
    // would be the loudest thing in the console for a feature nobody can see failing.
    try { console.warn('[webui] local transcript cache disabled:', (why && why.message) || why || 'unavailable'); } catch(x){}
  }

  function dbOn(){ return !dbOff && Boolean(window.indexedDB); }

  function idb(){
    if(db) return Promise.resolve(db);
    if(!dbOn()) return Promise.resolve(null);
    return cacheOpen(window.indexedDB).then(function(r){
      if(r.db){ db = r.db; return db; }
      cacheOff(r.error);
      return null;
    });
  }

  /** One transaction. Resolves {ok:true, value} with whatever body asked for, or {ok:false}. */
  function cacheTx(mode, body){
    return idb().then(function(d){
      if(!d) return {ok:false};
      return new Promise(function(res){
        var t, out=null;
        try { t = d.transaction(STORE, mode); } catch(x){ cacheOff(x); return res({ok:false}); }
        var rq = body(t.objectStore(STORE));
        if(rq) rq.onsuccess = function(){ out = rq.result; };
        t.oncomplete = function(){ res({ok:true, value:out}); };
        t.onabort = function(){ res({ok:false, error:t.error}); };
        t.onerror = function(){ res({ok:false, error:t.error}); };
      });
    });
  }

  /** That a copy of a topic as new as last, of run ep, is somewhere ('' : one with nothing to resume from). */
  function noteVer(id, last, ep){
    var v = vers[id];
    if(!v || newer(last, v.last, ep, v.epoch)) vers[id] = {last:last || '', epoch:ep || 0};
  }

  /**
   * Keep a copy of a topic: msgs in the order they are read, meta {epoch, last, stale} saying what
   * they are a copy of. Into memory now and into the database under cachePut's rule; neither takes
   * it over a newer copy. Resolves whether the database now holds this copy or a newer one.
   */
  function put(id, msgs, meta){
    var c = {topic:id, msgs:msgs, epoch:meta.epoch, last:meta.last || '', stale:Boolean(meta.stale), at:++copySeq};
    var m = copies[id];
    if(!m || !newer(m.last, c.last, m.epoch, c.epoch)){ copies[id] = c; trimCopies(); }
    noteVer(id, c.last, c.epoch);
    return dbOn() ? cacheWrite(id, msgs, meta, false) : Promise.resolve(false);
  }

  /** Memory keeps the topics most recently put, least recent out first; the database keeps the rest. */
  function trimCopies(){
    var ids = Object.keys(copies).sort(function(a, b){ return copies[b].at - copies[a].at; }), total = 0;
    for(var i=0;i<ids.length;i++){
      total += copies[ids[i]].msgs.length;
      if(i < COPY_TOPICS && (i === 0 || total <= COPY_MSGS)) continue;
      delete copies[ids[i]];
      // Without a database that was the only copy.
      if(!dbOn()) delete vers[ids[i]];
    }
  }

  /** The copy in memory, unless the database is known to hold a newer one (the service worker's). */
  function memCopy(id){
    var m = copies[id], v = vers[id];
    return m && !(v && newer(v.last, m.last, v.epoch, m.epoch)) ? m : null;
  }

  /** A topic's newest copy the page can find, {msgs, epoch, last, stale}, or null. */
  function get(id){
    var m = memCopy(id);
    if(m || !dbOn()) return Promise.resolve(m || copies[id] || null);
    return cacheRead(id).then(function(r){
      var o = copies[id];
      return o && (!r || newer(o.last, r.last, o.epoch, r.epoch)) ? o : r;
    });
  }

  /** Write a topic's record under cachePut's rule. Resolves whether it, or a newer one, is there. */
  function cacheWrite(tId, msgs, meta, retried){
    var rec = cacheRecord(tId, msgs, meta), w = null;
    return cacheTx('readwrite', function(store){ w = cachePut(store, rec); return null; })
      .then(function(r){
        if(r.ok){ if(w && w.stood) noteVer(tId, w.stood.last, w.stood.epoch); return true; }
        if(dbOff) return false;
        if(retried){ cacheOff(r.error || 'the write was refused twice'); return false; }
        // Out of room, most likely. Everything except the topic being read goes, and the write
        // is tried once more before the cache is written off for this session.
        return cacheTx('readwrite', function(store){ cacheEvict(store, tId, true); return null; })
          .then(function(){ return cacheWrite(tId, msgs, meta, true); });
      });
  }

  /** A topic's record as {msgs, epoch, last, stale}, or null when there is none; noted in vers. */
  function cacheRead(tId){
    return cacheTx('readonly', function(store){ return store.get(tId); }).then(function(r){
      var v = r.ok ? r.value : null, list = null;
      if(v && v.json) try { list = JSON.parse(v.json); } catch(x){ list = null; }
      if(!v || !Array.isArray(list)){ if(r.ok) noteVer(tId, '', 0); return null; }
      noteVer(tId, v.last, v.epoch);
      return {msgs:list, epoch:v.epoch || 0, last:v.last || '', stale:Boolean(v.stale)};
    });
  }

  /**
   * Learn what a topic's record is a copy of without parsing it: the prefetch asks this of every
   * topic it has not looked at, and a whole topic is up to 2M characters of JSON.
   */
  function cachePeek(tId){
    return cacheTx('readonly', function(store){ return store.get(tId); }).then(function(r){
      var v = r.ok && r.value && r.value.json ? r.value : null;
      noteVer(tId, v ? v.last : '', v ? v.epoch : 0);
    });
  }

  function cacheDrop(tId){ cacheTx('readwrite', function(store){ store.delete(tId); return null; }); }
  /** Drop every cached topic not in keep — over KEYS, for the same reason evict walks keys. */
  function cacheKeep(keep){
    cacheTx('readwrite', function(store){
      var cur = store.index('at').openKeyCursor();
      cur.onsuccess = function(){
        var at = cur.result;
        if(!at) return;
        if(!keep[at.primaryKey]) store.delete(at.primaryKey);
        at.continue();
      };
      return null;
    });
  }

  /**
   * What is on screen, in the order it is on screen, as the cache should hold it.
   *
   * Read off #log rather than from a list of our own, because here the DOM IS the order — and
   * what it holds is already the union of cached history and what the daemon has since sent,
   * which is exactly what the next reload should get back.
   *
   * A local message is never included. Everything this page has sent and not had acknowledged is
   * written to localStorage the moment it is sent (see unsent), which a write coalesced into a
   * 400ms window of an asynchronous database could not promise: a reload in that window used to
   * lose a send still in flight outright.
   */
  function cacheable(){
    var out=[];
    for(var n=log.firstChild; n; n=n.nextSibling){
      var k = n.getAttribute ? n.getAttribute('data-k') : null;
      var m = k ? data[k] : null;
      if(!m || m._local) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * What the topic on screen is a copy of, or null while it is nothing a copy did not already say:
   * before its sync, or before it was put up from a copy. Resumable from lastEv when lastEv names
   * this topic — the screen is then every message the room had as of that event.
   */
  function liveMeta(){
    var last = (lastEv && lastEv.indexOf(topic+'.') === 0) ? lastEv : '';
    return topic && epoch && (synced || last) ? {epoch:epoch, stale:stale, last:last} : null;
  }

  /** Put the topic on screen into the store as it stands. */
  function keepScreen(){
    var meta = liveMeta();
    if(meta) put(topic, cacheable(), meta);
  }

  /** Keep the topic on screen, at most once every SAVE_MS. */
  function cacheSave(){
    if(!topic || saveTimer) return;
    saveTimer = setTimeout(function(){ saveTimer = null; keepScreen(); }, SAVE_MS);
  }

  /** The way out of a topic: kept now, since in a moment nothing on screen belongs to it. */
  function leave(){
    clearTimeout(saveTimer); saveTimer = null;
    keepScreen();
  }

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
   * The gateway's settings page, from the Menu. The command is sent quietly — the daemon
   * has to build the screen from the live config, and it answers with a message of its own, but a
   * page opening must not leave a /setting bubble in the transcript.
   */
  settingsOpenBtn.addEventListener('click', function(){
    setMenu(null, false);
    var token = openSettingsLoading();
    var t = settingsTopic;
    if(!token || !t) return;
    quietCommand('/setting', t).then(function(ok){
      if(ok) return;
      forgetSettingsRequest(token);
      if(!settingsMsg && !settingsPage.hidden) settingsSay('Could not reach the daemon. Close this and try again.');
    });
  });
  settingsClose.addEventListener('click', closeSettings);
  settingsPage.addEventListener('click', function(e){ if(e.target === settingsPage) closeSettings(); });

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
    calmState.textContent = calm ? 'on' : 'off';
  }
  calmBtn.addEventListener('click', function(){
    calm = !calm;
    try { if(calm) localStorage.setItem('aa_calm', '1'); else localStorage.removeItem('aa_calm'); } catch(x){}
    paintCalm();
  });
  paintCalm();

  function schedAgo(at){
    if(!at) return '';
    var s=Math.max(0, Math.round((Date.now()-at)/1000));
    if(s<60) return s+'s ago';
    if(s<3600) return Math.round(s/60)+'m ago';
    if(s<86400) return Math.round(s/3600)+'h ago';
    return Math.round(s/86400)+'d ago';
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
    return durText(ms)+(done?' ago':'');
  }

  /** HH:MM, with the date in front when it was not today — the tooltip's "started/ended at". */
  function ageClock(at){
    var d=new Date(at), now=new Date();
    var hm=(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes();
    if(d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate()) return hm;
    var day=MONTH_NAMES[d.getMonth()].slice(0,3)+' '+d.getDate();
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
      + ' title="'+text((a.run?'Started ':'Ended ')+ageClock(a.at))+'">'
      + text(ageText(Date.now()-a.at, !a.run))+'</span>';
  }

  var MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

  /**
   * A topic's unread messages, as its row's badge counts them. The topic on screen is read by
   * definition: opening it stamps readCounts.
   */
  function unreadOf(t){
    var count=t.msgCount||0;
    return t.id===topic?0:Math.max(0, count-(readCounts[t.id]||0));
  }

  /** Whether a topic has anything a Mark all read would clear: a badge, or a reply the daemon
   *  still counts as unseen (stage review). The topic on screen is excluded: reportSeen is
   *  already clearing it. A sub-agent has only its badge to clear: its finished turn is the news
   *  of the agent that opened it, not the person's, and its row has no green dot to take away. */
  function needsRead(t){
    return t.id!==topic && (unreadOf(t)>0 || unseenReply(t));
  }

  /** A reply the daemon still counts as unseen — the green dot, cleared by api/seen. */
  function unseenReply(t){
    return t.stage==='review' && !t.parent;
  }

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
      + ' title="'+text(o.moreTitle||'Row actions')+'" aria-label="'+text(o.moreTitle||'Row actions')+'">'+IC.icon.more+'</button>';
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
    var term=t.term?'<span class="topic-term" title="A terminal is attached to this topic">&gt;_</span>':'';
    var line=o.sub!==undefined ? o.sub : topicDirHtml(t);
    // The subject alone: who answers is the legend on the row's frame, not the "[cc] " the stored
    // name opens with (which the chat platforms still need, and which a later /agent leaves stale).
    var title='<span class="topic-title">'
       + forkMarkHtml(t)
       + text(splitTitle(t.title || 'Untitled').rest)+'</span>';
    // A lit star on a starred row is a marker, not a button: Star/Unstar lives in the menu now.
    var starMark=t.starred
      ? '<span class="topic-star-mark" title="Starred: never removed to make room, and kept by Clear" aria-hidden="true">'+IC.icon.star+'</span>'
      : '';
    // Its own button, like the star: folding a parent is not a reason to switch to it.
    var fold=row.kids?'<button type="button" class="topic-fold'+(row.shut?' folded':'')+(row.under?' '+row.under:'')+'"'
       + ' data-fold="'+text(t.id)+'" aria-expanded="'+(row.shut?'false':'true')+'"'
       + ' title="'+(row.shut?'Show':'Hide')+' the '+row.kids+' topic'+(row.kids>1?'s':'')+' its agent opened">'
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
    return 'Forked from '+(src ? (src.title || 'Untitled') : 'another topic')+(t.forkTurn ? ' · turn '+t.forkTurn : '');
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

  /**
   * Mark a list's topics read: the Sessions tab's Mark all read (every run and the sub-agents under
   * them) and the topic list's (every topic in it). noun names them in the failure, and say is
   * where that list reports one.
   *
   * Two kinds of unread live in a list and both have to go: the badge is this page's own
   * count (readCounts in localStorage), while the green dot is the daemon's stage: review,
   * which clears only when the server is told the topic was seen. api/seen takes one topic
   * and has no bulk form, so this posts once per topic that still has a reply to clear — a
   * handful of requests on a tap, not a poll.
   *
   * One at a time, not all at once: every markSeen announces the topic list to every open page,
   * and N parallel posts would be N announcements racing each other. And a 4xx/5xx is a
   * resolved response, not a rejection — post() only rejects on a dead link — so r.ok has to be
   * checked or a refused mark would leave the badge gone here and the topic still finished there,
   * with nothing said.
   */
  function markAllRead(list, noun, say){
    var wrote=false, queue=[];
    for(var i=0;i<list.length;i++){
      var count=list[i].msgCount||0;
      if((readCounts[list[i].id]||0)!==count){ readCounts[list[i].id]=count; wrote=true; }
      if(unseenReply(list[i])) queue.push(list[i].id);
    }
    if(wrote) saveReads();
    // Both lists, and the button that started this: paintTopics repaints the Sessions tab too.
    paintTopics();
    var failed=0;
    function markOneAt(n){
      if(n>=queue.length){
        if(failed) say('Could not mark '+failed+' '+noun+(failed===1?'':'s')+' read: the daemon did not accept it. '+(failed===1?'It':'They')+' keep the finished mark.');
        return;
      }
      post('api/seen',{topic:queue[n]},0).then(function(r){
        if(!r.ok) failed++;
      }, function(){ failed++; }).then(function(){ markOneAt(n+1); });
    }
    markOneAt(0);
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

  // Escapes for BOTH uses this page makes of it: element content, and the inside of a
  // double-quoted attribute. textContent alone covers the first and leaves the quote, which is
  // what the second needs — a directory whose name contains a double quote would end the title
  // attribute early and put the rest of the path in the tag. Everything interpolated here is the
  // (their paths, their command list), so this is a rendering bug rather than a way in; the
  // load-bearing escaping is web-markdown.ts, which never lets agent output near a tag at all.
  function text(s){
    var d=document.createElement('div');
    d.textContent=s==null?'':String(s);
    return d.innerHTML.replace(/"/g,'&quot;');
  }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  // Retried, which is only safe because every send carries a nonce the server remembers: on a
  // bad link a request can be accepted and still time out, and without the nonce a retry would
  // post the same message twice.
  //
  // limit is how long ONE attempt may go unanswered, in ms, before it is abandoned and counted as
  // a dropped request. fetch has no timeout of its own, so a request that never answers — a tunnel
  // that took the body and went quiet, a socket the OS has not noticed is dead — used to leave the
  // caller waiting for ever: for a send, a grey bubble that neither turned red nor offered Retry.
  // Only a send passes one. The other callers' requests are short, and a stuck button is a
  // different complaint from a message that looks sent and is not.
  function post(path, body, tries, limit){
    // Built first: JSON.stringify is the one thing here that can throw, and nothing is armed yet.
    // Bytes (a send that carries files, see framed) go as they are.
    var bytes = ArrayBuffer.isView(body);
    var init = {method:'POST',headers:{'Content-Type': bytes ? 'application/octet-stream' : 'application/json'},
      body: bytes ? body : JSON.stringify(body),credentials:'same-origin'};
    var expired = false, timer = 0;
    if(limit && typeof AbortController === 'function'){
      var ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(function(){ expired = true; ctl.abort(); }, limit);
    }
    return fetch(path, init).then(function(r){
      clearTimeout(timer);
      if(!r.ok && r.status>=500 && tries>0) return wait(700).then(function(){ return post(path, body, tries-1, limit); });
      return r;
    }, function(e){
      clearTimeout(timer);
      // An attempt that was given a minute or more was carrying an upload, and starting one over
      // from its first byte twice more is a quarter of an hour of grey for a link that has just
      // shown it cannot do it. It fails once instead, and Retry is a single tap.
      if(tries>0 && !(expired && limit > 60000)) return wait(700).then(function(){ return post(path, body, tries-1, limit); });
      throw e;
    });
  }

  /**
   * How long one attempt at posting this message may take: fifteen seconds, plus one for every
   * 64 KiB of it, up to the five minutes the server allows a request body (Node's
   * http.Server.requestTimeout, whose default has been 300000 since v18 — nodejs.org, http docs).
   *
   * Scaled rather than flat because the same page sends a line of text and a 20 MB attachment: a
   * limit short enough to catch the first would cut the second off mid-upload on any ordinary
   * mobile uplink and call that a failure.
   */
  function sendLimit(body){
    var n = (body.text || '').length, f = body.files || [];
    for(var i=0;i<f.length;i++) n += f[i].data.length + f[i].name.length;
    return Math.min(300000, 15000 + Math.round(n / 65.536));
  }

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
      var say = ok ? 'Copied' : 'Could not copy \u2014 select the code instead';
      btn.innerHTML = ok ? IC.icon.check : IC.icon.cross;
      btn.title = say;
      btn.setAttribute('aria-label', say);
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(function(){
        btn.innerHTML = IC.icon.copy;
        btn.title = 'Copy';
        btn.setAttribute('aria-label', 'Copy code');
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
  var SUB_K = {dispatch:'Sub-agent task', report:'Sub-agent report', aside:'Side question'};

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
  var BTW_FOOT_RE=/<p>(side question \u2014 [^<]*)<\/p>\s*$/;

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
    var state = answered ? 'Answer' + IC.icon.chevronRight
      : stuck(m) ? '' : hist ? 'No answer' : 'Waiting\u2026';
    var shown = btwKey === key && !btwBox.hidden;
    var cls = 'm btw-q' + (hist ? ' hist' : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (stuck(m) ? ' failed' : '');
    var h = '<button type="button" class="btw-chip" aria-haspopup="dialog" aria-controls="btw"'
      + ' aria-expanded="'+(shown ? 'true' : 'false')+'" title="'+text(asked ? 'Side question: '+asked : 'Side question')+'">'
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
      h = '<div class="btw-wait">' + (stuck(m) ? 'Not sent, so nothing is answering it.'
        : isHistory(m) ? 'No answer came before the daemon restarted.'
        : '<span class="set-spin" aria-hidden="true"></span>Asking a copy of this conversation\u2026') + '</div>';
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
    var tag = kind && Object.prototype.hasOwnProperty.call(SUB_K, kind) ? SUB_K[kind] : '';
    var cls = 'm' + (m.own ? ' own' : '') + (hist ? ' hist' : '')
      + (tag ? ' '+kind : '')
      + (m._local && m._state === 'sending' ? ' pending' : '')
      + (stuck(m) ? ' failed' : '');
    var h='';
    // The tag, not the text, is what makes the kinds tell apart before the body is read.
    if(tag) h += '<div class="sub-k">'+tag+'</div>';
    if(m.quote && m.quote.html) h += '<div class="q">'+m.quote.html+'</div>';
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
      if(m.file.view && !hist) h += '<a class="view" href="'+text(m.file.url)+'" download>Download</a>';
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
    var files = c.files === 1 ? '1 file changed' : c.files + ' files changed';
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
      title: 'Turn ' + turn + ' changes',
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

  /**
   * A /setting screen as markup, for the settings page rather than for the transcript.
   *
   * The daemon sends the screen as data (WebMessage.settings): groups, rows, values, what control
   * each row is changed with, and the button id every control posts. Nothing here parses a label
   * or decides a value — the grid did, because a label was all it had. What IS decided here is
   * presentation: a choice of up to five short values is drawn as a segmented control (one tap,
   * every option visible), a longer one as a select, and a per-agent row puts one labelled
   * control per setting beside the agent's name.
   *
   * Every interactive element carries data-fk, a key that survives a redraw (the row's index and
   * the part of it), so focus can be put back after the daemon's answer replaces the markup.
   */
  function settingsScreen(m){
    var s = m.settings;
    if(!s) return '';
    return s.level === 'values' ? settingsValues(s) : settingsList(s);
  }

  // Escaped text with code spans kept: what the daemon writes in its sentences. Escaping comes
  // first, so the only markup that can come out is the <code> put in here.
  function inl(s){
    return text(s == null ? '' : s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  }

  function settingsNotice(n){
    if(!n) return '';
    var tone = n.tone === 'ok' || n.tone === 'error' ? n.tone : 'info';
    return '<div class="set-notice '+tone+'" role="'+(tone === 'error' ? 'alert' : 'status')+'">'+inl(n.text)+'</div>';
  }

  /**
   * The list screen. A group's own rows sit in one card, and its agents — the Agents group's rows
   * whose control is an agent — follow it as cards of their own (settingsAgents). The daemon puts the
   * default agent first in that group, so drawing a group's plain rows before its agents keeps the
   * order it sent.
   */
  function settingsList(s){
    var h = '';
    if(s.about) h += '<p class="set-about">'+inl(s.about)+'</p>';
    if(settingsNote) h += settingsNotice({ tone: 'error', text: settingsNote });
    h += settingsNotice(s.notice);
    var notes = {}, groups = s.groups || [];
    for(var g=0;g<groups.length;g++) notes[groups[g].name] = groups[g].note;
    var rows = s.rows || [], secs = [], agentsShown = false;
    for(var i=0;i<rows.length;i++){
      var name = String(rows[i].group == null ? '' : rows[i].group), sec = secs[secs.length-1];
      if(!sec || sec.name !== name){ sec = { name: name, plain: [], agents: [] }; secs.push(sec); }
      (rows[i].control && rows[i].control.kind === 'agent' ? sec.agents : sec.plain).push(i);
    }
    for(var k=0;k<secs.length;k++){
      var x = secs[k];
      h += '<section class="set-sec">'+(x.name ? '<h3 class="set-group">'+text(x.name)+'</h3>' : '')
        + (notes[x.name] ? '<p class="set-gnote">'+inl(notes[x.name])+'</p>' : '');
      if(x.plain.length){
        h += '<div class="set-card">';
        for(var p=0;p<x.plain.length;p++) h += settingsItem(rows[x.plain[p]], x.plain[p]);
        h += '</div>';
      }
      if(x.agents.length) h += settingsAgents(rows, x.agents);
      // The gateway's files no agent reads have no card of their own; the Agents section is where
      // a person looks for them (settingsOrphans). With no Agents section at all, they follow the
      // last one so they are still reachable.
      if(x.name === 'Agents'){ h += instructionsPanel.renderOrphans(); agentsShown = true; }
      h += '</section>';
    }
    if(!agentsShown) h += instructionsPanel.renderOrphans();
    return h;
  }

  /** A row's name, its badges and its one line: the left half of every kind of row. */
  function settingsText(r){
    var badges = '';
    if(r.here) badges += '<span class="set-badge here" title="Answers the topic \u201c'+text(settingsTopicName(settingsTopic))+'\u201d">this topic</span>';
    if(r.effectLabel) badges += '<span class="set-badge restart"'+(r.effectDetail ? ' title="'+text(r.effectDetail)+'"' : '')+'>'+text(r.effectLabel)+'</span>';
    return '<div class="set-tx"><div class="set-label">'+settingsLabel(r.label)
      + (r.targetKind ? '<span class="set-kind">'+text(r.targetKind)+'</span>' : '') + badges + '</div>'
      + (r.hint ? '<div class="set-hint">'+inl(r.hint)+'</div>' : '') + '</div>';
  }

  /**
   * A row's name. The scheduled tasks' row is named the way a chat button is, \u23f0 first (core
   * schedule-menu.ts), and a glyph is the reader's font's to draw — an empty box where it has none
   * (Chromium without an emoji font, 2026-11-19). The page draws its own clock instead.
   */
  function settingsLabel(label){
    var s = String(label == null ? '' : label), m = /^\u23f0\uFE0F? */.exec(s);
    return '<span>'+(m ? IC.icon.clock+' '+text(s.slice(m[0].length)) : text(s))+'</span>';
  }

  function settingsItem(r, i){
    var c = r.control || { kind: 'list' };
    if(c.kind === 'switch'){
      return '<div class="set-item sw">' + settingsText(r)
        + '<div class="set-ctl"><button type="button" class="set-switch" role="switch" aria-checked="'+(c.on ? 'true' : 'false')+'"'
        + ' aria-label="'+text(r.label)+'" data-fk="r'+i+'" data-btn="'+text(c.set)+'"></button></div></div>';
    }
    if(c.kind === 'choice') return '<div class="set-item">' + settingsText(r) + '<div class="set-ctl">'+settingsChoice(r.label, c.options || [], 'r'+i, r.value)+'</div></div>';
    // A row with a screen of its own, or a way to another menu: the whole row is the button.
    var value = '';
    if(c.kind !== 'link' && r.value != null){
      value = '<span class="set-vv"><span class="set-v'+(r.unset ? ' unset' : '')+'" title="'+text(r.value)+'">'+text(r.value)+'</span>'
        + (r.valueNote ? '<span class="set-vnote">'+text(r.valueNote)+'</span>' : '') + '</span>';
    }
    return '<button type="button" class="set-item set-open" data-fk="r'+i+'" data-btn="'+text(r.buttonId)+'">'
      + settingsText(r) + value + '<span class="set-chev" aria-hidden="true">'+IC.icon.chevronRight+'</span></button>';
  }

  /**
   * The agent cards, under a heading per machine (the row's place, which the daemon names as the
   * /agent menu does) when they run on more than one. Machines in the order their first agent
   * comes in config.yaml, and agents in config order within each: the order a person already knows
   * them in from that menu.
   */
  function settingsAgents(rows, idx){
    var places = [], by = new Map();
    for(var k=0;k<idx.length;k++){
      var p = String(rows[idx[k]].place || '');
      if(!by.has(p)){ by.set(p, []); places.push(p); }
      by.get(p).push(idx[k]);
    }
    var h = '<div class="ag-list">', heads = places.length > 1;
    for(var j=0;j<places.length;j++){
      var list = by.get(places[j]);
      if(heads) h += '<h4 class="ag-place"><span>'+text(places[j] || 'elsewhere')+'</span><span class="ag-count">'+list.length+'</span></h4>';
      for(var n=0;n<list.length;n++) h += settingsAgent(rows[list[n]], list[n]);
    }
    return h + '</div>';
  }

  /**
   * Which agent's card is open, by its id: the page's alone, never posted. It survives every redraw
   * — the daemon's answer to a change in it, the instruction list arriving, a model screen and back —
   * and goes when the page is closed.
   */
  var agOpen = null;

  /**
   * The hue a harness is drawn in, from its name: the same harness the same colour on every card
   * and every page, with nothing to keep in step with the list of harnesses. The palette is ordered
   * so the names this project's harnesses hash to land far apart — Claude Code orange, Codex green,
   * OpenCode blue, Antigravity violet, codebuddy yellow — and the six built-in names on six different
   * hues (page.dom.test.ts pins that).
   */
  var AG_HUES = [0, 52, 245, 24, 188, 330, 100, 210, 280, 158];
  function agHue(kind){
    var s = String(kind || ''), x = 0;
    for(var i=0;i<s.length;i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return AG_HUES[x % AG_HUES.length];
  }

  function agentFieldOf(fields, label){
    for(var k=0;k<fields.length;k++) if(fields[k].label === label) return fields[k];
    return null;
  }

  /**
   * One agent's card. Shut, it is a summary a person reads down a list by: the name and its badges,
   * the harness in its colour, the model and the level, unset ones in italics. Open, it is every
   * setting the daemon sent for the agent (settingsField), and then the instruction files it reads
   * (agentInstr). The fields carry the daemon's button ids; the page decides only layout.
   */
  function settingsAgent(r, i){
    var fields = (r.control && r.control.fields) || [], id = String(r.target || r.label), open = agOpen === id;
    var badges = (r.here ? '<span class="set-badge here" title="Answers the topic \u201c'+text(settingsTopicName(settingsTopic))+'\u201d">this topic</span>' : '')
      + (r.defaultAgent ? '<span class="set-badge def" title="A new conversation no routing rule claims gets this agent">default</span>' : '');
    var sum = r.targetKind ? ['<span class="ag-kind">'+text(r.targetKind)+'</span>'] : [];
    for(var k=0;k<fields.length;k++){
      var f = fields[k], v = f.value == null ? '' : String(f.value);
      sum.push('<span class="'+(f.label === 'Model' ? 'ag-mono' : 'ag-lvl')+(f.unset ? ' unset' : '')+'" title="'+text(f.label+': '+v+(f.unset ? ' (not set)' : ''))+'">'+text(v)+'</span>');
    }
    var body = '';
    for(var n=0;n<fields.length;n++){
      body += '<div class="ag-field"><span class="ag-lab">'+text(fields[n].label)+'</span><div class="ag-val">'
        + settingsField(r.label, fields[n], 'r'+i+'f'+n) + '</div></div>';
    }
    body += instructionsPanel.renderAgent(r, i);
    return '<div class="ag-card'+(open ? ' open' : '')+'" style="--ag-h:'+agHue(r.targetKind)+'" role="group" aria-label="'+text(r.label)+'" data-ag="'+text(id)+'">'
      + '<button type="button" class="ag-top" data-fk="r'+i+'x" aria-expanded="'+(open ? 'true' : 'false')+'" aria-controls="ag-b'+i+'">'
      + '<span class="ag-who"><span class="ag-id"><span class="ag-name">'+text(r.label)+'</span>'+badges+'</span>'
      + '<span class="ag-sum">'+sum.join('<span class="ag-sep" aria-hidden="true">\u00b7</span>')+'</span></span>'
      + '<span class="ag-chev" aria-hidden="true">'+IC.icon.chevronDown+'</span></button>'
      + '<div class="ag-body" id="ag-b'+i+'"'+(open ? '' : ' hidden')+'>'+body+'</div></div>';
  }

  /** Open one agent's card, or shut it; any other open card shuts. Drawn here, never posted. */
  function toggleAgent(top){
    var card = top.closest('.ag-card');
    if(!card) return;
    var open = top.getAttribute('aria-expanded') !== 'true', cards = settingsBody.querySelectorAll('.ag-card');
    for(var i=0;i<cards.length;i++){
      var on = open && cards[i] === card, t = cards[i].querySelector('.ag-top'), b = cards[i].querySelector('.ag-body');
      cards[i].classList.toggle('open', on);
      if(t) t.setAttribute('aria-expanded', on ? 'true' : 'false');
      if(b) b.hidden = !on;
    }
    agOpen = open ? card.getAttribute('data-ag') : null;
  }

  // agent is the row's name, carried into every control's accessible name: several agents' cards
  // sit on one page, so a reader that hears only "Model" cannot tell whose it is.
  function settingsField(agent, f, key){
    var c = f.control || { kind: 'list' }, v = f.value == null ? '' : String(f.value);
    var unset = f.unset ? ' unset' : '', tip = f.unset ? text(v + ' (not set)') : text(v);
    var badge = f.effectLabel ? '<span class="set-badge restart"'+(f.effectDetail ? ' title="'+text(f.effectDetail)+'"' : '')+'>'+text(f.effectLabel)+'</span>' : '';
    // Under a value, what it cannot say by itself: where it comes from (a pinned mode, a running
    // session's, a pod's file), and for a level the chosen level's meaning — the levels are five
    // short words, and what each one asks is the whole point of picking one. A level that was never
    // set says so: the control shows what applies, and a selected button cannot say it was a default.
    var note = f.valueNote ? String(f.valueNote) : (f.unset && c.kind === 'choice' ? 'not set' : '');
    var foot = function(extra){
      var parts = [];
      if(extra) parts.push('<span>'+text(extra)+'</span>');
      if(note) parts.push('<span>'+text(note)+'</span>');
      return parts.length || badge ? '<div class="ag-note">'+parts.join('<span aria-hidden="true">\u00b7</span>')+badge+'</div>' : '';
    };
    if(c.kind === 'choice'){
      var opts = c.options || [], now = null;
      for(var k=0;k<opts.length;k++) if(opts[k].current) now = opts[k];
      // One level on offer (an API agent asks about nothing) is a fact, not a control: a control
      // with a single option invites a tap that cannot change anything.
      if(opts.length < 2){
        var only = opts[0];
        return '<span class="ag-fixed'+unset+'" title="'+(only && only.detail ? text(only.detail) : tip)+'">'+text(only ? only.label : v)+'</span>' + foot(only && only.detail);
      }
      // The levels side by side where they fit (five short words do), a select where one is long:
      // an open card has the width a table column did not.
      return settingsChoice(agent + ' \u00b7 ' + f.label, opts, key, v, false, f.unset ? 'unset' : '') + foot(now && now.detail);
    }
    return '<button type="button" class="ag-open" data-fk="' + key + '" data-btn="' + text(f.buttonId) + '"'
      + ' aria-label="' + text(agent + ' \u00b7 ' + f.label + ': ' + v) + '">'
      + '<span class="set-v' + unset + '" title="' + tip + '">' + text(v) + '</span>'
      + '<span class="set-chev" aria-hidden="true">' + IC.icon.chevronRight + '</span></button>' + foot('');
  }

  // key is what its controls' data-fk is built from: a row's ("r3"), or one field of an agent's
  // row ("r3f1"), so a redraw can put focus back on the exact control that was used.
  function settingsChoice(label, opts, key, value, select, cls){
    var short = !select && opts.length > 0 && opts.length <= 5;
    for(var k=0;k<opts.length;k++) if(String(opts[k].label).length > 6) short = false;
    var h = '', any = false;
    if(short){
      for(var j=0;j<opts.length;j++){
        var o = opts[j];
        h += '<button type="button" role="radio" aria-checked="'+(o.current ? 'true' : 'false')+'" data-fk="'+key+'o'+j+'" data-btn="'+text(o.buttonId)+'"'
          + (o.detail ? ' title="'+text(o.detail)+'"' : '')+'>'+text(o.label)+'</button>';
      }
      return '<div class="set-seg" role="radiogroup" aria-label="'+text(label)+'">'+h+'</div>';
    }
    for(var n=0;n<opts.length;n++){
      var p = opts[n];
      if(p.current) any = true;
      // The value alone: a closed select shows its option's whole text, and a value with its
      // explanation was cut mid-sentence at 390px. The row's hint says what the values mean.
      h += '<option value="'+text(p.buttonId)+'"'+(p.current ? ' selected' : '')+(p.detail ? ' title="'+text(p.detail)+'"' : '')+'>'+text(p.label)+'</option>';
    }
    // A value none of the options names (a window typed by hand, 90m) is still shown as what it is.
    if(!any) h = '<option value="" selected disabled>'+text(value == null ? '' : value)+'</option>' + h;
    return '<select class="set-select'+(cls ? ' '+cls : '')+'" data-fk="'+key+'" aria-label="'+text(label)+'">'+h+'</select>';
  }

  function settingsValues(s){
    var h = '', hd = s.head, n = s.nav || {};
    if(n.back) h += '<button type="button" class="set-back" data-fk="back" data-btn="'+text(n.back)+'">'+IC.icon.chevronLeft+' All settings</button>';
    if(hd){
      h += '<div class="set-head"><h3><span>'+text(hd.label)+'</span>'
        + (hd.target ? '<span class="set-tgt">'+text(hd.target)+'</span>' : '')
        + (hd.targetKind ? '<span class="set-kind">'+text(hd.targetKind)+'</span>' : '') + '</h3>'
        + '<p class="set-now">Now: <span class="set-v'+(hd.unset ? ' unset' : '')+'">'+text(hd.value)+'</span></p>'
        + (hd.source ? '<p class="set-src">'+inl(hd.source)+'</p>' : '')
        + '<p class="set-desc">'+inl(hd.description)+'</p>'
        + (hd.effect ? '<p class="set-when">'+inl(hd.effect)+'</p>' : '') + '</div>';
    }
    if(settingsNote) h += settingsNotice({ tone: 'error', text: settingsNote });
    h += settingsNotice(s.notice);
    var opts = s.options || [];
    // One field for both: it filters a long list as it is typed into, and Use (or Enter) takes
    // what is typed as the value — a harness takes model names its list never offers.
    if(s.typed){
      h += '<div class="set-typed"><input type="text" class="set-type" data-fk="typed" data-btn="'+text(s.typed.buttonId)+'"'
        + ' placeholder="'+text(opts.length > 8 ? 'Filter, or type a model name' : s.typed.placeholder)+'" aria-label="'+text(s.typed.placeholder)+'"'
        + ' autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">'
        + '<button type="button" class="set-use" data-fk="use">Use</button></div>';
    }
    if(s.loading || (hd && hd.hint)) h += '<div class="set-hintbox'+(s.loading ? ' loading' : '')+'">'+(s.loading ? '<span class="set-spin" aria-hidden="true"></span>' : '')+inl(hd && hd.hint ? hd.hint : 'Loading…')+'</div>';
    if(opts.length){
      h += '<div class="set-card set-list">';
      for(var i=0;i<opts.length;i++) h += settingsOption(opts[i], i);
      h += '</div><p class="set-nomatch" hidden>No model in the list matches. Use takes the name as typed.</p>';
    }
    if(n.pageCount > 1){
      h += '<div class="set-nav">'
        + (n.prev ? '<button type="button" data-fk="prev" data-btn="'+text(n.prev)+'">'+IC.icon.chevronLeft+' Prev</button>' : '')
        + '<span class="set-page">'+text(n.page)+' / '+text(n.pageCount)+'</span>'
        + (n.next ? '<button type="button" data-fk="next" data-btn="'+text(n.next)+'">Next '+IC.icon.chevronRight+'</button>' : '')
        + '</div>';
    }
    return h;
  }

  function settingsOption(o, i){
    return '<button type="button" class="set-opt'+(o.current ? ' on' : '')+'" data-fk="o'+i+'" data-btn="'+text(o.buttonId)+'"'
      + (o.current ? ' aria-current="true"' : '')+' data-q="'+text(String(o.label+' '+(o.detail || '')).toLowerCase())+'">'
      + '<span class="set-check" aria-hidden="true">'+(o.current ? IC.icon.check : '')+'</span>'
      + '<span class="set-opt-main"><span class="set-opt-label">'+text(o.label)+'</span>'
      + (o.detail ? '<span class="set-opt-detail">'+text(o.detail)+'</span>' : '')
      + '</span></button>';
  }

  // ── The settings page ────────────────────────────────────────────────────────
  /**
   * /setting as a page of its own, not a message in the transcript.
   *
   * The daemon already answers /setting with one message carrying the structured screen
   * (SettingsScreen) and the button ids that write config.yaml. That is still the only source of
   * the rows, the values and the writes — this page never parses a label or builds a value. It
   * only moves the drawing out of the transcript and into a window: the message is taken out of
   * the log before it is painted, and its updates (the daemon edits the same message when a row is
   * tapped) are painted into this page instead. Closing the page is remembered per message id, so
   * a late edit does not reopen what the operator put away.
   *
   * It is bound to the topic it was opened in, though what it sets is not that topic's: every row
   * is config.yaml, for every conversation. The binding is mechanical — the buttons carry that
   * conversation's message id, and "this topic" marks the agent answering it — so switching topics
   * closes the page rather than leaving it pointing at the old one.
   */
  function settingsKey(m){ return (m._g || m.g || epoch) + ':' + m.id; }

  function settingsTopicName(id){
    for(var i=0;i<topics.length;i++) if(topics[i].id===id) return topics[i].title || 'Untitled';
    return 'Untitled';
  }

  // Where these settings live, which is the same for every topic. The bar used to name the topic
  // the page was opened in, and that read as "these are this topic's settings" — they never were.
  function paintSettingsTopic(){
    settingsTopicEl.textContent = 'Saved to config.yaml · every topic';
    settingsTopicEl.title = 'Opened from the topic “' + settingsTopicName(settingsTopic) + '”';
  }

  /**
   * Draw the page from the message it holds. Focus goes back to the control that had it — the
   * daemon's answer to a switch replaces the markup, and a keyboard user would otherwise be sent
   * back to the top of the page after every toggle. A move to a value screen starts at the top; a
   * move back to the list lands on the control that left it (settingsListFk), whose card is still
   * open — the top of the page was three screens of agents away from the one being set.
   */
  function renderSettings(){
    if(!settingsMsg) return;
    var a = document.activeElement, fk = a && settingsBody.contains(a) ? a.getAttribute('data-fk') : null;
    var level = settingsMsg.settings ? settingsMsg.settings.level : '';
    var typed = settingsBody.querySelector('.set-type');
    if(typed) settingsQuery = typed.value;
    settingsBody.innerHTML = settingsScreen(settingsMsg);
    if(INSTR_OK && level === 'list') instructionsPanel.ensure();
    if(level !== settingsLevel){
      var back = level === 'list' && settingsLevel === 'values' ? settingsListFk : null;
      settingsBody.scrollTop = 0; fk = back; settingsQuery = '';
    }
    settingsLevel = level;
    // What was typed survives the redraw — the list arriving after "asking" is one — and so does
    // the filter it applies.
    var field = settingsBody.querySelector('.set-type');
    if(field && settingsQuery){ field.value = settingsQuery; filterSettings(); }
    // A notice that is good news fades once it has been seen; an error stays until the next screen.
    clearTimeout(settingsFade);
    var note = settingsBody.querySelector('.set-notice.ok, .set-notice.info');
    if(note) settingsFade = setTimeout(function(){ note.classList.add('faded'); }, SETTINGS_FADE_MS);
    if(fk){
      var to = settingsBody.querySelector('[data-fk="'+fk+'"]');
      if(to && to.focus) to.focus();
    }
  }

  /**
   * A live settings screen arrived: draw it, or update the page already drawing it.
   *
   * An edit of a page the operator closed is dropped; a new message is a new page. That is the
   * whole rule, and it is why the id is remembered rather than a boolean. An answer that belongs
   * to a request the operator closed while it was still Loading is dropped too — the request is
   * identified by its token, and the answers come back in the order they were asked for.
   */
  function takeSettings(m){
    m._g = m.g || epoch;
    var k = settingsKey(m);
    // An edit of the screen already on the page: update it in place, and do not consume a
    // pending request — this answer belongs to the message, not to a new question.
    if(!settingsPage.hidden && settingsMsg && settingsMsg.id === m.id){
      settingsMsg = m;
      settingsNote = null;
      renderSettings();
      return;
    }
    var wasHidden = settingsPage.hidden;
    if(wasHidden && settingsClosed[k]) return;
    if(!topic) return;
    var token = 0;
    for(var i=0;i<settingsPending.length;i++){
      if(settingsPending[i].t !== topic) continue;
      token = settingsPending[i].n;
      settingsPending.splice(i, 1);
      break;
    }
    if(wasHidden && token && token <= settingsClosedUpTo) return;
    settingsMsg = m;
    settingsNote = null;
    settingsLevel = '';
    settingsTopic = topic;
    paintSettingsTopic();
    renderSettings();
    settingsPage.hidden = false;
    settingsBody.scrollTop = 0;
    disarmSettingsWait();
  }

  /** The page, before the daemon has answered: it says which topic it is about at once. */
  function openSettingsLoading(){
    if(!topic) return 0;
    settingsMsg = null;
    settingsTopic = topic;
    settingsBody.innerHTML = '<div class="set-loading">Loading settings…</div>';
    paintSettingsTopic();
    settingsPage.hidden = false;
    settingsBody.scrollTop = 0;
    var token = ++settingsReq;
    settingsPending.push({ t: topic, n: token });
    armSettingsWait();
    return token;
  }

  /** Stop waiting for an answer: the page is open, closed, or the request failed. */
  function disarmSettingsWait(){
    if(settingsTimer){ clearTimeout(settingsTimer); settingsTimer = 0; }
  }

  /**
   * Say so rather than sitting on Loading for ever: the daemon may have dropped the request, or
   * answered with something that is not a screen at all. The page stays up, so the operator can
   * close it and try again.
   */
  function armSettingsWait(){
    disarmSettingsWait();
    settingsTimer = setTimeout(function(){
      settingsTimer = 0;
      if(settingsPage.hidden || settingsMsg) return;
      settingsSay('The daemon did not answer. Close this and try again.');
    }, SETTINGS_WAIT_MS);
  }

  /** The answer to a request that failed on the way out will never arrive; let its token go. */
  function forgetSettingsRequest(token){
    for(var i=0;i<settingsPending.length;i++){
      if(settingsPending[i].n !== token) continue;
      settingsPending.splice(i, 1);
      return;
    }
  }

  function settingsSay(s){
    settingsBody.innerHTML = '<div class="set-loading">'+text(s)+'</div>';
  }

  function closeSettings(){
    if(settingsPage.hidden) return;
    if(settingsMsg) settingsClosed[settingsKey(settingsMsg)] = 1;
    // Every request issued so far is cancelled, including one still in flight while Loading —
    // otherwise its answer would reopen the page the operator just put away.
    if(settingsReq) settingsClosedUpTo = Math.max(settingsClosedUpTo, settingsReq);
    disarmSettingsWait();
    settingsPage.hidden = true;
    settingsMsg = null;
    settingsNote = null;
    settingsTopic = null;
    settingsListFk = null;
    agOpen = null;
    settingsBody.textContent = '';
  }

  /**
   * A control on the settings page was used. Posted like any menu button, with the page's own
   * message and topic. A switch or a segment shows its new state at once — the round trip is the
   * daemon writing config.yaml, and a control that sits unmoved for it reads as broken — and the
   * daemon's answer redraws the page from what was actually written. When the answer cannot come
   * (the request failed, or the message is gone), the page is redrawn from what it last had, which
   * puts the control back, with a line saying why.
   */
  /** Show only the values whose name or meaning holds what is typed, and say so when none does. */
  function filterSettings(){
    var field = settingsBody.querySelector('.set-type');
    var q = field ? field.value.trim().toLowerCase() : '';
    var opts = settingsBody.querySelectorAll('.set-list .set-opt'), shown = 0;
    for(var i=0;i<opts.length;i++){
      var hit = !q || (opts[i].getAttribute('data-q') || '').indexOf(q) >= 0;
      opts[i].hidden = !hit;
      if(hit) shown++;
    }
    var none = settingsBody.querySelector('.set-nomatch');
    if(none) none.hidden = !(q && opts.length && !shown);
  }

  /** Use what is typed: the click carries it as its value (ButtonInteraction.value). */
  function useTyped(){
    var field = settingsBody.querySelector('.set-type');
    if(!field) return;
    var v = field.value.trim();
    if(!v){ field.focus(); return; }
    postSetting(field, field.getAttribute('data-btn'), v);
  }

  function postSetting(el, id, value){
    if(!settingsMsg || !settingsTopic || !id) return;
    var msgId = settingsMsg.id;
    if(settingsLevel === 'list') settingsListFk = el.getAttribute('data-fk');
    if(el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    if(el.getAttribute('role') === 'radio'){
      var peers = el.parentNode ? el.parentNode.children : [];
      for(var i=0;i<peers.length;i++) peers[i].setAttribute('aria-checked', peers[i] === el ? 'true' : 'false');
    }
    el.disabled = true;
    el.classList.add('busy');
    var fail = function(why){
      if(!settingsMsg || settingsMsg.id !== msgId) return;
      settingsNote = why;
      renderSettings();
    };
    // A limit, unlike a transcript menu's tap: a request that goes quiet would leave the control
    // half-moved for ever, with nothing on the page to say the change never happened.
    var body = {topic:settingsTopic,messageId:msgId,buttonId:id};
    if(value) body.value = value;
    post('api/click',body,2,SETTINGS_WAIT_MS)
      .then(function(r){
        if(r.ok) return;
        fail(r.status === 409 || r.status === 404
          ? 'This settings page is out of date, so nothing was changed. Close it and open Settings again.'
          : 'The daemon did not take that (HTTP '+r.status+'), so nothing was changed. Try again.');
      }, function(){ fail('Could not reach the daemon, so nothing was changed. Check the connection and try again.'); });
  }

  /**
   * Send a command the operator did not type — the Menu asking the daemon for its own
   * settings screen. quiet tells the room not to write it into the conversation: a page opening
   * must not leave a /setting bubble in the transcript, and nothing on the daemon's side needs
   * the echo (the answer is a new message of its own).
   */
  function quietCommand(cmd, t){
    var nonce = Math.random().toString(36).slice(2)+Date.now().toString(36);
    return post('api/send', {topic:t, text:cmd, nonce:nonce, quiet:true}, 2)
      .then(function(r){ return r.ok; }, function(){ return false; });
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
      + (st && st.all ? 'Collapse' : 'Show all') + '</button>';
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
      ? 'Not confirmed — the page closed before the daemon answered, so this may not have arrived.'
      : 'Not delivered — the agent never saw this.';
    var h = '<div class="warn">'+why+'</div><div class="acts">';
    if(outbox[m._nonce]) h += '<button type="button" data-retry="'+text(m._nonce)+'">Retry</button>';
    return h + '<button type="button" data-copy="'+text(m._nonce)+'">Copy</button>'
      + '<button type="button" data-discard="'+text(m._nonce)+'">Discard</button></div>';
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
  var EMPTY_NOTE = 'This topic is older than the running daemon, and its transcript was not kept, so'
    + ' anything said in it is no longer here. The agent still has its context, so you can carry on'
    + ' where you left off.';

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
      emptyEl.textContent = EMPTY_NOTE;
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
    var h = '<div class="launch-head"><div class="launch-title">Choose an agent</div>'
      + '<div class="launch-sub">Or just type — <b>'+text(c.current)+'</b> answers by default.</div></div>';
    // One machine needs no heading: it would name the only answer to a question nobody asked —
    // unless it is offline, which is worth saying even of the only one.
    var many = c.groups.length > 1;
    for(var i=0;i<c.groups.length;i++){
      var g = c.groups[i], off = offSince(g.name);
      h += '<section class="launch-group'+(off?' off':'')+'">';
      if(many || off) h += '<h3 class="launch-host">'+text(g.name)+' <span class="n">'+g.agents.length+'</span>'
        + (off ? '<span class="off" title="'+text(offTitle(g.name))+'">'+IC.icon.offline+'offline since '+text(offWhen(off))+'</span>' : '')
        + '</h3>';
      h += '<div class="launch-grid">';
      for(var j=0;j<g.agents.length;j++){
        var a = g.agents[j], on = a.id === c.current;
        h += '<button type="button" class="agent-card'+(on?' def':'')+'" data-agent="'+text(a.id)+'" title="/agent '+text(a.id)+(off?' — '+text(g.name)+' is offline':'')+'">'
          + '<span class="ac-top"><span class="ac-id">'+text(a.id)+'</span>'+(on?'<span class="ac-tag">default</span>':'')+'</span>'
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
    paintStatus();
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
    return name+' has been offline since '+offWhen(offSince(name))+': the gateway cannot reach it, so its agents cannot answer until it is back.';
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
    machineNoteEl.innerHTML = IC.icon.offline+'<span>'+text(name+' is offline since '+offWhen(off)+' — its agents cannot answer until it is back.')+'</span>';
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
    forkNote.innerHTML=IC.icon.fork+'<span>Forked from</span><span class="fork-src">'+text(src.title||'Untitled')+'</span>'
      +(cur.forkTurn?'<span>· turn '+cur.forkTurn+'</span>':'');
    forkNote.setAttribute('data-src', src.id);
    forkNote.title='Back to '+(src.title||'Untitled');
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
  var DIVIDER_NOTE = 'Everything above is from before the daemon restarted.'
    + ' The agent still has its context, so you can carry on below.';
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
      dividerEl.textContent=DIVIDER_NOTE;
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
  var SYNC_NOTE = 'Checking for anything said while you were away';
  var syncingEl=null;

  function showSyncing(){
    // Not over an empty log: the skeleton is already standing in for the whole transcript there,
    // and two answers to one wait is one too many.
    if(syncingEl || synced || skeleton || !log.firstChild) return;
    syncingEl=document.createElement('div');
    syncingEl.className='syncing';
    syncingEl.innerHTML='<span class="dots"><i></i><i></i><i></i></span><span>'+SYNC_NOTE+'</span>';
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
  var NEEDS_WHAT = {answer:'Waiting on your answer', failed:'Failed', review:'Finished'};
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
      + ' placeholder="' + text(opts.placeholder || 'Search') + '" aria-label="' + text(opts.placeholder || 'Search') + '">'
      + '<button type="button" class="fb-qclear" title="Clear search" aria-label="Clear search" hidden>' + IC.icon.cross + '</button>'
      + '</div>'
      + '<button type="button" class="fb-filter fb-btn" aria-expanded="false" title="Filter">'
      + IC.icon.filter + '<span>Filter</span><span class="fb-dot" hidden></span></button>';
    if(sortDef){
      html += '<span class="fb-tools"><span class="fb-sort" title="Sort">' + IC.icon.sort
        + '<select class="fb-sortsel" aria-label="Sort"></select></span>'
        + '<button type="button" class="fb-dir fb-btn" aria-label="Ascending" title="Ascending"></button></span>';
    }
    html += '</div>'
      + '<div class="fb-pins" hidden></div>'
      + '<div class="fb-sum" hidden><span class="fb-sumtext"></span><button type="button" class="fb-clear">Clear</button></div>'
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
      sumText.textContent = 'Showing ' + counts.shown + ' of ' + counts.total;
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
      dirBtn.title = up ? 'Ascending' : 'Descending';
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

    return {el:root, state:state, active:active, setGroups:setGroups, setCounts:setCounts, clear:clear, destroy:destroy};
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
  function topicFilterGroups(forest){
    var stateOpts = [
      {value:'needs', label:'Needs you', short:'Needs', icon:'bell', count:0},
      {value:'running', label:'Running', short:'Run', icon:'play', count:0},
      {value:'idle', label:'Idle', short:'Idle', icon:'dot', count:0},
      {value:'none', label:'No agent', short:'None', icon:'offline', count:0}
    ];
    var starredOpts = [
      {value:'starred', label:'Starred', icon:'star', count:0},
      {value:'plain', label:'Unstarred', count:0}
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
      hostOpts.push({value:hv, label:hv === '__local' ? 'Local' : hv, icon:'globe', count:hosts[hv]});
    }
    var groups = [
      {id:'state', label:'State', pinned:true, options:stateOpts},
      {id:'starred', label:'Starred', options:starredOpts}
    ];
    if(agentOpts.length) groups.push({id:'agent', label:'Agent', options:agentOpts});
    groups.push({id:'host', label:'Host', options:hostOpts});
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
    var forest = topicForest();
    // Before the rows, so a selected agent or host that has just disappeared is dropped from the
    // bar's state first and the list below is filtered by what the panel actually shows.
    var fg = topicFilterGroups(forest);
    if(topicFilter) topicFilter.setGroups(fg.groups);
    var painted=topicRows(forest);
    if(topicFilter) topicFilter.setCounts(painted.matched, painted.total);
    // The topic on screen may be a scheduled run, which topicRows leaves out of the list. The
    // header, Stop/power and the read marks still belong to it, so find it in the full list —
    // and seed a mark for every topic, hidden ones included, or the Sessions tab would count a
    // run's whole history as unread the first time it was opened.
    for(var i=0;i<topics.length;i++){
      var seed=topics[i];
      if(readCounts[seed.id]===undefined){ readCounts[seed.id]=seed.msgCount||0; saveReads(); }
      if(seed.id===topic){ cur=seed; readCounts[seed.id]=seed.msgCount||0; saveReads(); }
    }
    var stars=painted.stars;
    for(i=0;i<painted.rows.length;i++){
      var t=painted.rows[i].t;
      // What the Needs-you block used to say on a second line, now on hover: the row keeps its shape.
      h += treeRowHtml(painted.rows[i], {
        attr:'data-topic',
        menu:'topic',
        cls:(painted.dividers[i]?' after-needs':''),
        tail:(needsYou(t)?' needs':''),
        attrs:needsYou(t)?' title="'+text(NEEDS_WHAT[t.stage]+(t.line?': '+t.line:''))+'"':'',
        moreTitle:'Topic actions'
      });
    }
    bar.innerHTML=h;
    // From the same list the rows were drawn from, so the line and the row cannot disagree.
    paintMachineNote();
    // A filtered list with nothing left says so where the rows would be, rather than looking like
    // a topic list that failed to load. Clear is the way back without hunting for the field.
    if(!h && painted.filtering){
      bar.innerHTML='<div class="topics-empty"><span>No matching topics</span>'
        + '<button type="button" class="fb-clear" data-filter-clear="1">Clear</button></div>';
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
    for(i=0;i<forest.visible.length;i++) if(needsRead(forest.visible[i])) toRead++;
    readBtn.disabled = !toRead;
    readBtn.title = toRead ? 'Mark all read ('+toRead+' topic'+(toRead===1?'':'s')+')' : 'Mark all read — nothing unread';
    // Says what it will do: with stars in the list it no longer clears all of them.
    var clearLabel = stars ? 'Clear unstarred topics' : 'Clear all topics';
    clearBtn.title = clearLabel;
    clearBtn.setAttribute('aria-label', clearLabel);
    // The count sits on Manage's face, so it is read without opening the menu; the item inside
    // says what closing would do, or shows a disabled explanation when there is nothing to close.
    var idle=idleTopics().length;
    idleBtn.hidden = !idle;
    noIdleBtn.hidden = Boolean(idle);
    idleBtn.textContent = 'Close idle ('+idle+')';
    idleCount.textContent = idle ? '('+idle+')' : '';
    var below = cur ? busyBelow(cur.id) : false;
    paintForkNote(cur);
    if(cur){
      chatTitle.textContent=cur.title || 'Untitled';
      // Same order as the dot, and the same reason: during an ask the turn is still open, so
      // "running" is true and is the less useful of the two things to say. A dispatcher whose
      // sub-agents work is running too: its own turn ended, the job did not.
      var curRunning=Boolean(cur.running) || below;
      var state=cur.asking?'awaiting you':(curRunning?'running':'');
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
      ? 'Stop this topic and the sub-agents it started — their conversations are kept (/stop)'
      : 'Stop what the agent is doing — the conversation is kept (/stop)';
    // The window's title bar names the same topic this row does, so a rename lands on both in
    // the same frame rather than leaving the bar holding the old name until the next switch.
    if(TERM_OK) paintFrames();
    schedulesPanel.onTopicsUpdated();
  }

  /**
   * Tell the daemon the operator is looking at the topic on screen, when that changes something: a
   * reply it has not been told was read (stage review). It stamps its own clock (WebRoom.markSeen),
   * and the stage — here and in the Needs-you list — moves on.
   * Only while the page is actually visible, and at most every two seconds per topic.
   */
  var seenPosted={};
  function reportSeen(){
    // A conversation from History covers the topic: it is underneath, not being read.
    if(!topic || document.visibilityState==='hidden' || libOn()) return;
    var cur=null;
    for(var i=0;i<topics.length;i++){ if(topics[i].id===topic){ cur=topics[i]; break; } }
    if(!cur || cur.stage!=='review') return;
    var now=Date.now();
    if(seenPosted[topic] && now-seenPosted[topic]<2000) return;
    seenPosted[topic]=now;
    post('api/seen',{topic:topic},0).catch(function(){});
  }
  document.addEventListener('visibilitychange', reportSeen);

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
      notifyState.textContent='blocked';
      notifyBtn.title='Blocked in this browser: allow notifications for this site in the browser settings, then reload';
      return;
    }
    notifyBtn.disabled=false;
    notifyBtn.setAttribute('aria-pressed', pushSub ? 'true' : 'false');
    notifyState.textContent = pushSub ? 'on' : 'off';
    notifyBtn.title = pushSub
      ? 'This device is notified when something needs you, even with the page closed. Click to stop.'
      : 'Notify this device when something needs you, even with the page closed';
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
      alert('Could not turn notifications on: ' + ((e && e.message) || e));
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
    termBtn.title = on ? 'Minimize the terminal' : (state ? 'Show the terminal (still running)' : 'Terminal');
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
    var title = (cur && cur.title) ? cur.title : 'Untitled';
    if(!confirm('End the terminal session in "'+title+'"?\n\nAnything still running in it is killed. Minimize instead to leave it running.')) return;
    var id = topic;
    // Not retried, unlike a send. A 500 here means the operator's command ran and failed, and
    // running it again 700ms later answers the same way while spawning a second process; the
    // retry in post() is for a link that dropped a request, which is not this.
    post('api/terminal/end',{topic:id},0).then(function(r){
      return r.ok ? {ok:true} : r.json().then(function(d){ return {ok:false, error:(d&&d.error)||'could not end the terminal session'}; }, function(){ return {ok:false, error:'could not end the terminal session'}; });
    }).then(function(d){
      if(!d.ok){ alert(d.error); return; }
      dropTerm(id);
      if(id===topic){ history.replaceState(null,'',urlNow()); applyTerm(); }
    }, function(){
      alert('could not reach the daemon to end the terminal session');
    });
  }

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
    if(!dbOn() || document.visibilityState === 'hidden' || parked || !epoch) return [];
    if(!stream || stream.readyState !== 1) return [];
    var rows = topics.filter(function(t){ return t.id !== topic && NEEDS_ORDER[t.stage] !== undefined; });
    // What needs a decision first, then most recent: the row nearest the top is the one most likely
    // to be tapped next.
    rows.sort(function(a, b){ return NEEDS_ORDER[a.stage]-NEEDS_ORDER[b.stage] || (b.lastAt||0)-(a.lastAt||0); });
    return rows.slice(0, PRE_TOPICS).filter(function(t){
      var v = vers[t.id], tried = preTried[t.id];
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
    (vers[t.id] === undefined ? cachePeek(t.id) : Promise.resolve()).then(function(){
      if(done) return;
      var v = vers[t.id];
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
    closeSettings();
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
    for(var i=0;i<topics.length;i++){
      if(topics[i].id===id){
        readCounts[id]=topics[i].msgCount || 0;
        saveReads();
        break;
      }
    }
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
    closeModelPop();
    closeBtw(false);
    setStatus(null);
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
    var mine = ++enterToken, used = false, v = vers[id];
    // The topic being left has to stop talking now, not when the read comes back: everything its
    // stream delivered in between would be drawn into this topic. Its handlers check es !== stream.
    if(stream){ stream.close(); stream = null; }
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
      if(resume){ lastEv = c.last; settleOnResume = true; }
      connect(resume);
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
    var title = (target && target.title) ? target.title : 'Untitled';
    // A star protects a topic from everything automatic, not from this: the × is the operator
    // deciding about one row, which is exactly what a star defers to. The question says so.
    if(!confirm('Delete '+(target && target.starred ? 'starred ' : '')+'topic "' + title + '"?')) return;
    post('api/topics/delete',{topic:delId},1).then(function(r){
      return r.ok ? r.json() : null;
    }).then(function(d){
      if(!d) return;
      cacheDrop(delId);
      // The row is gone, so its terminal window has nothing left to belong to. Only the window
      // — the session on the far side outlives this exactly as it outlives a closed tab, which
      // is why deleting a topic is not offered as a way to end one.
      dropTerm(delId);
      delete readCounts[delId];
      saveReads();
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

  // ── The status strip ─────────────────────────────────────────────────────────
  // What the daemon last pushed about this topic's agent (see status-board.ts), or null. Every time
  // in it is absolute, so a countdown is worked out here against the clock rather than re-sent:
  // the server says when a cache expires once, and this page counts to it.
  var agentStatus = null, statusTimer = null, statusHtml = '';
  // How often a countdown on screen is redrawn. Minutes are its finest unit, so twice a minute is
  // as often as it can visibly change; and only while one is on screen and the tab is visible.
  var STATUS_TICK_MS = 30000;

  function setStatus(s){
    agentStatus = s || null;
    paintStatus();
    armStatusTick();
  }

  function hasCountdown(s){
    if(!s) return false;
    if(s.cacheExpiresAt) return true;
    var q = s.quota || [];
    for(var i=0;i<q.length;i++) if(q[i].resetsAt) return true;
    return false;
  }

  function armStatusTick(){
    var want = hasCountdown(agentStatus) && document.visibilityState !== 'hidden';
    if(want && !statusTimer) statusTimer = setInterval(paintStatus, STATUS_TICK_MS);
    else if(!want && statusTimer){ clearInterval(statusTimer); statusTimer = null; }
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
      n.title=(run?'Started ':'Ended ')+ageClock(at);
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

  // The same units as the footer (core/runtime-footer.ts formatTokens / formatWindow), so a number
  // read here and one read under a reply can be compared.
  function stTokens(n){
    return n >= 1e6 ? (n/1e6).toFixed(1).replace(/\.0$/,'')+'M' : Math.round(n/1000)+'k';
  }
  function stWindow(n){
    return n >= 1e6 ? (Math.floor(n/1e5)/10).toFixed(1).replace(/\.0$/,'')+'M' : Math.floor(n/1000)+'k';
  }
  function stLeft(ms){
    var m = Math.floor(ms/60000);
    if(m < 1) return '<1m';
    var d = Math.floor(m/1440), h = Math.floor((m%1440)/60), mm = m%60;
    if(d > 0) return d+'d'+(h ? ' '+h+'h' : '');
    if(h > 0) return h+'h'+(mm ? ' '+mm+'m' : '');
    return m+'m';
  }
  function stClock(at){
    var t = new Date(at);
    return (t.getHours()<10?'0':'')+t.getHours()+':'+(t.getMinutes()<10?'0':'')+t.getMinutes();
  }
  // agy's pool ids, made readable: gemini-5h → Gemini 5h, 3p-weekly → 3P wk. An id of any other
  // shape is shown as it came, rather than dropped for not being one of the four known today.
  function poolLabel(id){
    var cut = id.lastIndexOf('-');
    var fam = cut > 0 ? id.slice(0, cut) : id, win = cut > 0 ? id.slice(cut+1) : '';
    fam = fam === '3p' ? '3P' : (fam === 'gemini' ? 'Gemini' : fam);
    win = win === 'weekly' ? 'wk' : (win === 'daily' ? 'day' : win);
    return win ? fam+' '+win : fam;
  }
  function seg(cls, title, html){
    return '<span class="st'+(cls ? ' '+cls : '')+'"'+(title ? ' title="'+text(title)+'"' : '')+'>'+html+'</span>';
  }

  function statusSegments(s, now, open){
    var out = [];
    out.push(seg('st-who', '', text(s.agent)+' \u00b7 '+modelChip(s.model || 'Model')+(s.effort ? ' \u00b7 '+text(s.effort) : '')
      +optChips(s.options || opkFor(topic))));
    if(s.context && s.context.size > 0){
      var pct = Math.min(100, Math.max(0, Math.round(s.context.used / s.context.size * 100)));
      out.push(seg(pct >= 80 ? 'bad' : (pct >= 50 ? 'warn' : ''),
        s.context.used.toLocaleString()+' of '+s.context.size.toLocaleString()+' tokens in context',
        '<i class="st-meter"><i style="width:'+pct+'%"></i></i>'+pct+'%'
          +'<span class="st-x">'+stTokens(s.context.used)+'/'+stWindow(s.context.size)+'</span>'));
    }
    if(s.cost){
      var c = s.cost;
      out.push(seg('', 'Session cost so far, as the harness reports it ('+c.amount.toFixed(4)+' '+c.currency+')',
        c.currency === 'USD' ? '$'+c.amount.toFixed(2) : text(c.amount.toFixed(2)+' '+c.currency)));
    }
    if(s.cacheExpiresAt){
      var left = s.cacheExpiresAt - now;
      out.push(left > 0
        ? seg(left < 5*60000 ? 'warn' : '', 'Prompt cache expires at '+stClock(s.cacheExpiresAt)+'; after that the next message re-reads the whole context at full price', text('cache '+stLeft(left)))
        : seg('', 'Prompt cache expired at '+stClock(s.cacheExpiresAt)+'; the next message re-reads the whole context at full price', 'cache expired'));
    }
    var pools = s.quota || [], anyActive = false;
    for(var i=0;i<pools.length;i++) if(pools[i].active) anyActive = true;
    var qAccts = {};
    for(var a=0;a<pools.length;a++) if(pools[a].account) qAccts[pools[a].account] = 1;
    var multiAcct = Object.keys(qAccts).length > 1;
    for(var j=0;j<pools.length;j++){
      var p = pools[j], off = anyActive && !p.active;
      // Closed, only the pools being spent from: the others are context, and the line is short.
      if(off && !open) continue;
      var rp = Math.round(p.remaining * 100);
      // A reset time is only worth the room while something has been spent.
      var reset = p.resetsAt && rp < 100 ? ' ('+stLeft(p.resetsAt - now)+')' : '';
      var acctTag = multiAcct && p.account ? p.account.split('@')[0]+' ' : '';
      var tip = (p.account ? p.account+(p.resetsAt ? ' \u00b7 ' : '') : '')
        + (p.resetsAt ? 'Refills '+new Date(p.resetsAt).toLocaleString() : '');
      out.push(seg((rp <= 15 ? 'bad' : (rp <= 40 ? 'warn' : ''))+(off ? ' off' : ''),
        tip,
        text(acctTag+poolLabel(p.id)+' '+rp+'%'+reset)));
    }
    return out.join('');
  }

  function paintStatus(){
    var s = agentStatus;
    // With no status yet (a restart, a conversation that has not reported), the line still offers
    // the switch once the topic has a conversation in it — not in a new one, where the agent
    // launcher is the choice to make first. Asked of the launcher on screen, not of launch: that
    // is the last sync's snapshot of the empty room and stays set until the next sync, so testing it
    // hid the switch from the moment an agent was chosen until the first reply reported a status —
    // exactly when someone wants to pick the model the first message goes to.
    var bare = !s && topic && synced && !launchEl && log.querySelector('.m');
    var opkSame = opk.topic === topic;
    var bareWho = (opkSame && opk.agent ? text(opk.agent)+' \u00b7 ' : '')
      + modelChip((opkSame && opk.model) || 'Model')
      + optChips(opkFor(topic));
    var html = s ? statusSegments(s, Date.now(), statusEl.classList.contains('open'))
      : (bare ? seg('st-who', '', bareWho) : '');
    // The agent's own settings have no status to come from yet either, so ask which to draw.
    if(bare && opk.topic !== topic) schedulePeek();
    // Compared before writing: the tick redraws twice a minute, and most of those change nothing.
    if(html === statusHtml) return;
    statusHtml = html;
    statusEl.innerHTML = html;
    statusEl.hidden = !html;
  }

  statusEl.addEventListener('click', function(e){
    // A setting first: its switch is an .st-model too, for the look.
    var ob = e.target.closest ? e.target.closest('.st-opt') : null;
    if(ob){
      if(ob.disabled) return;
      var oid = ob.getAttribute('data-opt');
      if(!modelPop.hidden && mp.opt === oid) closeModelPop(); else openOptPop(oid);
      return;
    }
    if(e.target.closest && e.target.closest('.st-model')){
      if(!modelPop.hidden && !mp.opt) closeModelPop(); else openModelPop();
      return;
    }
    statusEl.classList.toggle('open');
    paintStatus();
  });

  // ── The model switch ─────────────────────────────────────────────────────────
  // /model as a control: the list the topic's agent offers (GET api/models, which starts a cold
  // agent the way /model does — hence "Asking…"), and the switch (POST api/models), which is
  // /model's own: a runtime override for this topic, config untouched. mp.seq drops an answer that
  // belongs to a list closed or reopened since.
  // The same list serves one of the agent's own settings (openOptPop): mp.opt is that setting's id,
  // null for the model.
  var mp = { topic: null, opt: null, data: null, err: '', loading: false, busy: false, seq: 0 };
  var MODEL_WAIT_MS = 45000;

  function modelChip(label){
    return '<button type="button" class="st-model" aria-haspopup="dialog" aria-expanded="'+(modelPop.hidden || (mp && mp.opt) ? 'false' : 'true')+'"'
      + ' title="Switch the model for this topic (/model)"><span class="st-mtext">'+text(label)+'</span></button>';
  }

  // ── The agent's own settings ─────────────────────────────────────────────────
  // Settings an agent defines itself (an ACP select option in an underscore category — an account a web
  // agent runs on, say), each drawn beside the model as a switch of the same kind. Their state is
  // the agent's: the status carries it once a turn has reported, and before that — a new topic,
  // the one time a setting like an account may still be changed — GET api/options?peek=1 says which
  // to draw without starting the agent, and what it knows of them. opk is that answer for the topic
  // on screen, asked again when a message arrives there (a /cd or /new ends the session it
  // described) and after a pick. One with a single choice is one the agent will not change now.
  // (opk is declared with the page's early state, for the reason given there.)

  function opkFor(t){ return opk.topic === t ? opk.options : []; }

  function optChips(list){
    var h = '';
    for(var i=0;i<(list||[]).length;i++) h += ' \u00b7 '+optChip(list[i]);
    return h;
  }

  function optChip(o){
    var val = o.value !== undefined && o.value !== null ? String(o.value) : '';
    var body = '<span class="st-olabel">'+text(o.name)+'</span>'+(val ? ' <span class="st-mtext">'+text(val)+'</span>' : '');
    var note = o.note ? '\n'+o.note : '';
    if(o.fixed){
      return '<button type="button" class="st-model st-opt fixed" disabled data-opt="'+text(o.id)+'"'
        + ' title="'+text(o.name+': '+val+' \u2014 fixed for this conversation'+note)+'">'+body+'</button>';
    }
    var open = !modelPop.hidden && mp.opt === o.id;
    return '<button type="button" class="st-model st-opt" data-opt="'+text(o.id)+'" aria-haspopup="dialog" aria-expanded="'+(open ? 'true' : 'false')+'"'
      + ' title="'+text('Switch '+o.name+' for this topic'+note)+'">'+body+'</button>';
  }

  /** Ask which settings to draw, a moment from now: a burst of messages, or an agent being chosen, is one ask. */
  function schedulePeek(){
    if(opk.timer) clearTimeout(opk.timer);
    opk.timer = setTimeout(function(){ opk.timer = null; peekOptions(); }, 400);
  }

  function peekOptions(){
    // A status that has arrived since says it all, and is kept current by the daemon.
    if(!topic || agentStatus) return;
    var n = ++opk.seq, t = topic;
    // Claimed now, so the repaints while it is asked do not ask again.
    if(opk.topic !== t){ opk.topic = t; opk.agent = ''; opk.model = ''; opk.options = []; }
    fetch('api/options?peek=1&t='+encodeURIComponent(t), {credentials:'same-origin'})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if(n !== opk.seq || t !== opk.topic || !j) return;
        opk.agent = j.agent || '';
        opk.model = j.model || '';
        opk.options = j.options || [];
        paintStatus();
      }, function(){});
  }

  /** The setting's name, from what the line is drawn from — for the list's heading. */
  function optName(id){
    var list = (agentStatus && agentStatus.options) || opkFor(topic);
    for(var i=0;i<list.length;i++) if(list[i].id === id) return list[i].name;
    return 'Setting';
  }

  function openModelPop(){ openPop(null); }
  function openOptPop(id){ openPop(id); }

  function openPop(opt){
    if(!topic) return;
    var n = ++mp.seq, t = topic;
    mp.topic = t; mp.opt = opt; mp.data = null; mp.err = ''; mp.loading = true; mp.busy = false;
    mpFilter.value = '';
    mpHeading.textContent = opt ? optName(opt)+' for this topic' : 'Model for this topic';
    mpFilter.placeholder = opt ? 'Filter' : 'Filter models';
    mpFoot.innerHTML = opt ? 'This topic only. The agent decides what can be changed, and when.'
      : 'This topic only, like <code>/model</code>. The default for each agent is in Settings.';
    modelPop.hidden = false;
    paintStatus();
    renderModelPop();
    // Not on a phone: the keyboard would take half the screen before the list was read.
    if(!narrow()) mpFilter.focus();
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctl) ctl.abort(); }, MODEL_WAIT_MS);
    fetch((opt ? 'api/options?t=' : 'api/models?t=')+encodeURIComponent(t), ctl ? {credentials:'same-origin', signal: ctl.signal} : {credentials:'same-origin'})
      .then(function(r){ return r.json().then(function(j){ return { r: r, j: j }; }); })
      .then(function(x){
        clearTimeout(timer);
        if(n !== mp.seq) return;
        mp.loading = false;
        if(!x.r.ok) mp.err = 'The daemon did not give a list (HTTP '+x.r.status+').';
        else mp.data = x.j;
        renderModelPop();
        // Either list started the agent if it had to, so its settings are known now: draw them.
        if(x.r.ok && x.j && x.j.ok && t === topic && !agentStatus) peekOptions();
      }, function(){
        clearTimeout(timer);
        if(n !== mp.seq) return;
        mp.loading = false;
        mp.err = 'Could not reach the daemon for the list. Check the connection and try again.';
        renderModelPop();
      });
  }

  function closeModelPop(){
    if(modelPop.hidden) return;
    mp.seq++;
    modelPop.hidden = true;
    mpList.innerHTML = '';
    paintStatus();
  }

  /** The list, or what stands in for it: asking, why there is none, or what went wrong. */
  function renderModelPop(){
    var d = mp.data;
    mpAgent.textContent = d && d.agent ? d.agent : '';
    mpFilter.hidden = !(d && d.ok && (mp.opt ? optChoices(d).length : d.options.length) > 8);
    if(mp.loading){ mpList.innerHTML = '<div class="mp-msg mp-wait"><span class="set-spin" aria-hidden="true"></span>Asking the agent for its '+(mp.opt ? 'settings' : 'models')+'… a cold one takes a second or two to start.</div>'; return; }
    if(mp.err){ mpList.innerHTML = '<div class="mp-msg err">'+inl(mp.err)+'</div>'; return; }
    if(!d || !d.ok){ mpList.innerHTML = '<div class="mp-msg">'+inl(d ? d.text : '')+'</div>'; return; }
    if(mp.opt){ renderOptList(d); return; }
    var h = '';
    for(var i=0;i<d.options.length;i++){
      var o = d.options[i], on = o.value === d.current, def = d.configured && o.value === d.configured;
      var name = o.name && o.name !== o.value ? o.name : '';
      h += '<button type="button" class="mp-opt'+(on ? ' on' : '')+'" role="option" aria-selected="'+(on ? 'true' : 'false')+'" data-v="'+text(o.value)+'"'
        + ' data-q="'+text((o.value+' '+name).toLowerCase())+'">'
        + '<span class="mp-check" aria-hidden="true">'+(on ? IC.icon.check : '')+'</span>'
        + '<span class="mp-main"><span class="mp-v">'+text(o.value)+'</span>'+(name ? '<span class="mp-n">'+text(name)+'</span>' : '')+'</span>'
        + (def ? '<span class="mp-tag" title="What this agent starts a new session with (Settings)">default</span>' : '')
        + '</button>';
    }
    mpList.innerHTML = h;
    filterModels();
  }

  /** The setting the list is open on, out of the agent's answer. */
  function optOf(d){
    var list = (d && d.options) || [];
    for(var i=0;i<list.length;i++) if(list[i].id === mp.opt) return list[i];
    return null;
  }
  function optChoices(d){ var o = optOf(d); return o ? o.options : []; }

  /**
   * One setting's choices, each with the agent's description of it as a second line (an account's
   * used-up quota). A single choice is listed and not offered: the agent will not change it now.
   */
  function renderOptList(d){
    var o = optOf(d);
    if(!o){ mpList.innerHTML = '<div class="mp-msg">The agent no longer offers this setting.</div>'; return; }
    var fixed = o.options.length <= 1, h = '';
    if(fixed) h += '<div class="mp-msg">Fixed for this conversation: the agent offers no other '+text(o.name)+' now.</div>';
    for(var i=0;i<o.options.length;i++){
      var c = o.options[i], on = c.value === o.current;
      h += '<button type="button" class="mp-opt'+(on ? ' on' : '')+'" role="option" aria-selected="'+(on ? 'true' : 'false')+'" data-v="'+text(c.value)+'"'
        + ' data-q="'+text((c.name+' '+c.value+' '+(c.description || '')).toLowerCase())+'"'+(fixed ? ' disabled' : '')+'>'
        + '<span class="mp-check" aria-hidden="true">'+(on ? IC.icon.check : '')+'</span>'
        + '<span class="mp-main"><span class="mp-o">'+text(c.name)+'</span>'+(c.description ? '<span class="mp-n">'+text(c.description)+'</span>' : '')+'</span>'
        + '</button>';
    }
    mpList.innerHTML = h;
    filterModels();
  }

  function filterModels(){
    var q = mpFilter.value.trim().toLowerCase();
    var opts = mpList.querySelectorAll('.mp-opt');
    for(var i=0;i<opts.length;i++) opts[i].hidden = !!q && (opts[i].getAttribute('data-q') || '').indexOf(q) < 0;
  }

  /**
   * Switch to one, as /model would — or set the agent's setting, which the agent may refuse. Either
   * refusal is shown in the list in its own words.
   */
  function chooseModel(b){
    if(mp.busy || !mp.topic || b.disabled) return;
    var n = mp.seq, t = mp.topic, v = b.getAttribute('data-v'), opt = mp.opt;
    mp.busy = true;
    b.classList.add('busy');
    post(opt ? 'api/options' : 'api/models', opt ? {topic: t, id: opt, value: v} : {topic: t, value: v}, 1, MODEL_WAIT_MS)
      .then(function(r){ return r.json().then(function(j){ return { r: r, j: j }; }); })
      .then(function(x){
        mp.busy = false;
        if(n !== mp.seq) return;
        if(x.r.ok && x.j.ok){
          if(!opt && t === topic && agentStatus) agentStatus = Object.assign({}, agentStatus, { model: x.j.model });
          closeModelPop();
          note.textContent = String(x.j.text || '').replace(/\x60/g, '');
          // A status the daemon pushes says it too once there is one; until then this is how.
          if(opt && t === topic) peekOptions();
          return;
        }
        mp.err = x.j && x.j.text ? x.j.text : 'The daemon refused that (HTTP '+x.r.status+').';
        renderModelPop();
      }, function(){
        mp.busy = false;
        if(n !== mp.seq) return;
        mp.err = 'Could not reach the daemon, so '+(opt ? 'nothing' : 'the model')+' was changed. Try again.';
        renderModelPop();
      });
  }

  mpList.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('.mp-opt') : null;
    if(b) chooseModel(b);
  });
  mpFilter.addEventListener('input', filterModels);
  $('mp-close').addEventListener('click', closeModelPop);
  // Its own Escape and outside click, ahead of nothing else: the list is not a window over the
  // page, so it does not join the overlays the page-wide Escape closes.
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && !modelPop.hidden){ closeModelPop(); e.stopPropagation(); }
  }, true);
  document.addEventListener('click', function(e){
    if(modelPop.hidden || !e.target.closest) return;
    if(e.target.closest('#model-pop') || e.target.closest('.st-model')) return;
    closeModelPop();
  });
  // A countdown is redrawn the moment the page is looked at again, rather than up to a tick late.
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState !== 'hidden') paintStatus();
    armStatusTick();
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
      var arriving = entering && (landedAt < 0 || log.scrollTop === landedAt);
      var stick = atBottom();
      entering = false;
      // Which run of the daemon everything in this sync belongs to. Anything already on screen
      // from another one is cached history from here on, whatever it was painted as.
      // A different run under a page that was already open is a restart, and the daemon that came
      // back may be a newer one than served this script.
      if(epoch && ev.epoch && ev.epoch !== epoch) checkBuild();
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
      readCounts[topic] = ev.messages.length;
      saveReads();
      commands = ev.commands || [];
      topics = ev.topics || [];
      topicsV = ev.tv || 0;
      paintTopics();
      prune();
      // Absent when the topic's agent has reported nothing since the daemon started, which clears
      // whatever a previous connection had put up.
      setStatus(ev.status);
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
      var sm = ev.msg;
      if(sm && sm.settings){ takeSettings(sm); return; }
      if(sm && sm.wasSettings) return;
      if(sm && settingsMsg && sm.id === settingsMsg.id) closeSettings();
      // Before the upsert: if this is the echo of something typed here, it takes over the node
      // that local message is already occupying rather than appearing underneath it.
      claim(ev.msg);
      upsert(ev.msg);
      btwArrived(ev.msg);
      cacheSave();
      // Without a status, the settings drawn came from a peek, and what just happened may have
      // ended the session it described (a /cd, a /new): ask again.
      if(!agentStatus){ paintStatus(); schedulePeek(); }
      readCounts[topic] = (readCounts[topic] || 0) + 1;
      saveReads();
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
    else if(ev.t==='status'){ setStatus(ev.status); }
    else if(ev.t==='machines'){ setMachines(ev.offline || []); }
    else if(ev.t==='topics' || ev.t==='topic-rows'){
      if(ev.t==='topics') topics = ev.topics || [];
      else applyRows(ev);
      topicsV = ev.tv || 0;
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
    // would retry it every few seconds for as long as the daemon is down; this tries again on a
    // back-off instead. The resume point it sends names the run that is going away, so the daemon
    // that answers hands over the whole topic — which is what a page that outlived a restart needs.
    // It used to stop for good and ask for a reload.
    else if(ev.t==='bye'){
      if(stream) stream.close();
      note.textContent='The daemon is restarting. Reconnecting...';
      reconnectLater();
    }
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

  // The version of the topic list on this page (the daemon's tv), sent on a resume so the list is
  // only sent again if it moved.
  var topicsV=0;

  /**
   * What changed in the topic list (a topic-rows event): every row it carries replaces the one with
   * its id, or joins the end; the ids it names as gone are dropped; and the list is put back in the
   * daemon's order — sorted by lastAt, newest first, ties left as they were, which is how the store
   * orders it — unless the event says the order outright. room.ts derivedOrder is this same
   * algorithm on the other side, and sends the order whenever the two would disagree.
   */
  function applyRows(ev){
    var gone={}, at={}, next=[], i;
    var g=ev.gone || [], rows=ev.rows || [];
    for(i=0;i<g.length;i++) gone[g[i]]=1;
    for(i=0;i<topics.length;i++){
      if(gone[topics[i].id]) continue;
      at[topics[i].id]=next.length;
      next.push(topics[i]);
    }
    for(i=0;i<rows.length;i++){
      var r=rows[i];
      if(Object.prototype.hasOwnProperty.call(at, r.id)) next[at[r.id]]=r;
      else { at[r.id]=next.length; next.push(r); }
    }
    if(ev.order){
      var byId={};
      for(i=0;i<next.length;i++) byId[next[i].id]=next[i];
      next=[];
      for(i=0;i<ev.order.length;i++) if(byId[ev.order[i]]) next.push(byId[ev.order[i]]);
    } else {
      next = next.map(function(t, n){ return {t:t, n:n}; })
        .sort(function(a, b){ return (b.t.lastAt||0) - (a.t.lastAt||0) || a.n - b.n; })
        .map(function(x){ return x.t; });
    }
    topics = next;
  }

  // How long until the next attempt after a bye or a refused stream: one second, doubling to half
  // a minute, and back to nothing once a stream opens. Every attempt is one request, so a daemon
  // that is down for an hour costs a tab two a minute. One that falls due behind a hidden tab is
  // left for the tab to make when it is looked at again (see park).
  var retryMs=0, retryTimer=0;
  function reconnectLater(){
    if(retryTimer) return;
    retryMs = retryMs ? Math.min(retryMs*2, 30000) : 1000;
    retryTimer = setTimeout(function(){
      retryTimer=0;
      if(document.visibilityState === 'hidden'){ parked = true; return; }
      connect(true, true);
    }, retryMs);
  }

  // ── The stream behind a hidden tab ──────────────────────────────────────────
  // A tab nobody is looking at still received every event: each message in the topic, and the
  // topic list after every message posted anywhere. A phone on the table and a desktop tab behind
  // others are most of the time the page is open. So a tab hidden for PARK_MS closes its stream,
  // and coming back opens a new one from the last event it had (?last=, which the server treats as
  // Last-Event-ID): what was said meanwhile is replayed from the backlog, or the whole topic comes
  // again if the backlog no longer reaches. Nothing on the page needs the stream while hidden —
  // the title is never changed, notifications are Web Push and go through the service worker, the
  // seen mark is only posted while visible — so the grace is only there so that glancing at another
  // tab does not cost a reconnect. lastEv is the newest event id this stream has delivered.
  var PARK_MS=15000, parkTimer=0, parked=false, lastEv='';
  function park(){
    parkTimer=0;
    if(document.visibilityState !== 'hidden' || !stream || stream.readyState === 2) return;
    parked=true;
    stream.close();
  }
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden'){
      if(!parkTimer && !parked) parkTimer = setTimeout(park, PARK_MS);
      return;
    }
    clearTimeout(parkTimer); parkTimer=0;
    if(parked){ parked=false; connect(true, true); }
    // A tab coming back is exactly when a topic may have started needing an answer while nobody
    // was looking; nothing else fires until the next message.
    schedulePrefetch();
  });

  /**
   * Whether the session is still good, asked after a stream was refused for good.
   *
   * EventSource gives up on any answer that is not an event stream, and two very different answers
   * are that: the daemon's 401 when the session is gone, and a proxy's 502 while the daemon behind
   * it is restarting (cloudflared answers that way). Only the first is a reason to show the gate.
   * A request that cannot get through says nothing about the session, so it counts as still good.
   */
  function signedIn(){
    return fetch('api/push', {credentials:'same-origin', cache:'no-store'})
      .then(function(r){ return r.status !== 401; }, function(){ return true; });
  }

  /**
   * After a restart: does the daemon now serve a different page from this one?
   *
   * A HEAD names the page's ETag, which is its build (servePage), so this is one round trip with
   * no body. When it differs the script on screen is the old one, talking to a newer daemon; the
   * page says so and offers the reload rather than doing it, because a reload here would throw away
   * whatever is open — a skill half-edited, a recording, the place in a long transcript. An answer
   * with no ETag (a proxy that stripped it) says nothing, and nothing is shown.
   */
  function checkBuild(){
    fetch(location.pathname, {method:'HEAD', cache:'no-store', credentials:'same-origin'}).then(function(r){
      var tag = (r && r.headers && r.headers.get) ? (r.headers.get('ETag') || '') : '';
      if(tag && tag.indexOf(BUILD) < 0) updateEl.hidden = false;
    }, function(){});
  }

  /**
   * Open the event stream for the topic on screen.
   *
   * resume carries the last event this page had (lastEv): for a stream opened again on the same
   * topic (a tab coming back, a retry after a refused stream), or on a topic put up from its copy
   * (enter). The daemon replays what came after it, or sends the whole topic when it cannot. Without
   * it — a new topic, a fresh visit — there is nothing to resume from. quiet is for the same topic
   * coming back: no focus taken, no side-panel lists asked for again.
   */
  function connect(resume, quiet){
    if(stream) stream.close();
    clearTimeout(retryTimer); retryTimer=0;
    parked=false;
    // Placeholders for the wait that is about to start. Guarded on an empty log inside, so a
    // reconnect after a blip — where the conversation is still on screen and only the stream went
    // away — is not answered by replacing it with skeletons.
    showSkeleton();
    var from = resume ? lastEv : '';
    lastEv = from;
    var qs = [];
    if(topic) qs.push('t='+encodeURIComponent(topic));
    if(from) qs.push('last='+encodeURIComponent(from));
    if(from && topicsV) qs.push('tv='+topicsV);
    // EventSource resends the last id it saw on its own, so a blip is answered with the few
    // events that were missed rather than the whole conversation.
    var es = stream = new EventSource('api/events' + (qs.length ? '?'+qs.join('&') : ''));
    es.onmessage = function(e){
      if(es === stream && e.lastEventId) lastEv = e.lastEventId;
      try{ handle(JSON.parse(e.data)); }catch(x){}
    };
    // Not focused on a phone: the keyboard would come up before a word has been read, and on
    // a portrait screen that is half the viewport gone to reach a field nobody asked for yet.
    // Nor when the same topic's stream comes back (quiet): a tab returning to the front
    // reconnects, and the focus is wherever the person left it.
    es.onopen = function(){
      retryMs = 0;
      var fresh = app.hidden || !quiet;
      gate.hidden=true; app.hidden=false; note.textContent=''; if(fresh && !narrow()) input.focus(); initNotify();
      // The stream is the one thing that says the daemon is there to be asked; a tab that was
      // hidden, or one that just rode out a restart, gets its prefetch from here.
      schedulePrefetch();
      // A panel opened (or restored from aa_sched_open) before the gate came down asked too
      // early (loadSchedules and loadReviews refuse while #app is hidden); this is the first
      // moment the answer can be had. The restored tab is read here too: on a reload that comes
      // back to Reviews the panel opens before the gate does, so nothing else would ask. A tab
      // coming back has already asked (the panel's own visibilitychange), so a resume does not.
      if(fresh && schedPane.isOpen()) schedulesPanel.onStreamOpen();
    };
    es.onerror = function(){
      // A stream this page has since replaced or closed has nothing left to say.
      if(es !== stream) return;
      if(es.readyState === 2){
        // Closed for good rather than retrying: the server answered with something that is not a
        // stream. The gate only if that was the session going; otherwise a back-off, which is what
        // carries a page through a restart behind a proxy that answers 502 meanwhile.
        signedIn().then(function(ok){
          if(es !== stream) return;
          if(ok){ note.textContent='Reconnecting...'; reconnectLater(); }
          else { app.hidden=true; gate.hidden=false; }
        });
      } else {
        note.textContent='Reconnecting...';
      }
    };
  }

  /**
   * The topic list's filter bar (makeFilterBar above). It only says what the options are and
   * re-paints the list when one changes; the keyword and the chips are applied in topicRows.
   */
  topicFilter = makeFilterBar({
    key: 'aa_topic_filter',
    placeholder: 'Search topics',
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
      {key:'star', icon:IC.icon.star, label:t.starred?'Unstar':'Star',
       title:t.starred?'Stop keeping this topic through Clear and eviction':'Keep this topic through Clear and eviction'}
    ];
    items.push({key:'copy', icon:IC.icon.copy, label:'Copy reference',
      title:'Copy the title and topic id ('+INSTANCE_ID+':main/'+id+') so an agent can read this conversation'});
    if(canFork){
      items.push({key:'fork', icon:IC.icon.fork, label:'Fork', disabled:busy,
       title:busy
         ? 'A turn is running here — fork it once the turn ends'
         : 'Copy this conversation into a new topic beside it: it carries on from here, and this one is unchanged (/fork)'});
    }
    items.push(
      {key:'end', icon:IC.icon.power,
       label:'End agent'+(alive?' + '+alive+' sub-agent'+(alive===1?'':'s'):''),
       disabled:!able,
       // The reason, when there is nothing to end: a greyed item with no explanation asks.
       title:able
         ? 'End the agent process here'+(alive?' and in the '+alive+' topic'+(alive===1?'':'s')+' under it':'')
           +' — the conversations are kept, and the next message resumes them'
         : 'No agent process is running in this topic or the topics under it — there is nothing to end'},
      {sep:true},
      {key:'delete', icon:IC.icon.trash, label:'Delete topic', danger:true}
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
    if(state==='active') items.push({key:'pause', icon:IC.icon.pause, label:'Pause', title:'Stop running this task on its schedule'});
    if(state==='paused') items.push({key:'resume', icon:IC.icon.play, label:'Resume', title:'Put this task back on its schedule'});
    if(state==='active'||state==='paused') items.push({key:'run', icon:IC.icon.clock, label:'Run now', disabled:Boolean(t.running),
      title:t.running?'A run is in progress — wait for it to finish':'Run this task now, without waiting for its next scheduled time'});
    // Edit opens the task's page on its form. Greyed rather than hidden while a run is in flight,
    // like Run now; absent on a task that is over, which no edit can change.
    if(state==='active'||state==='paused') items.push({key:'edit', icon:IC.icon.pencil, label:'Edit', disabled:Boolean(t.running),
      title:t.running?'A run is in progress — edit it once that run finishes':'Change its schedule, prompt or command, agent, model or directory'});
    // Delete is below a divider only when there is something above it: an expired or done task
    // has no state change to offer, and a menu that opens with a line is a menu that looks cut.
    if(items.length) items.push({sep:true});
    items.push({key:'remove', icon:IC.icon.trash, label:'Delete', danger:true});
    openRowMenu(btn, btn.getAttribute('data-rm')||('task:'+id), items, function(what){
      if(what==='edit'){ openTaskPage(id, true); return; }
      if(what==='remove'){
        // One question, like deleting a topic: the task is gone for good, and a tap that opened
        // the menu is not a decision to remove it.
        if(!confirm('Delete task "'+(t.name||t.id)+'"?')) return;
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
      return {error:'the daemon could not be reached'};
    }).then(function(d){
      if(d && d.error){ alert('Could not open a new topic: '+d.error); return false; }
      if(!d || !d.topic) return false;
      // Just made, so there is no copy of it to look for: entered at once (enter).
      vers[d.topic.id] = {last:'', epoch:0};
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
      alert('Could not '+(on?'star':'unstar')+' that topic.');
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
      if(!r.ok) alert('Could not fork that topic: the daemon refused the request.');
    }, function(){ alert('Could not reach the server to fork that topic.'); });
  }

  // Not createTopic itself: a listener is handed the MouseEvent, which would arrive as a seed.
  // A new topic is a row in the Topics list, so that is the tab it is created into.
  newTopicBtn.addEventListener('click', function(){ setSbTab('topics'); createTopic(); });

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

  readBtn.addEventListener('click', function(){
    setMenu(null, false);
    markAllRead(topicForest().visible, 'topic', function(msg){ note.textContent=msg; });
  });

  clearBtn.addEventListener('click', function(){
    setMenu(null, false);
    var stars = topics.filter(function(t){ return t.starred; }).length;
    var gone = topics.length - stars;
    if(stars && !gone){ alert('Every topic is starred, so there is nothing to clear. Unstar one first.'); return; }
    // The button clears the whole list, not the filtered rows — say that where a search or a
    // filter is on screen, or it reads as "clear these three".
    var scope = topicFilter && topicFilter.active() ? ' This applies to every topic, not only the ones shown.' : '';
    if(!confirm(stars
      ? 'Delete '+gone+' topic'+(gone===1?'':'s')+'? The '+stars+' starred one'+(stars===1?' is':'s are')+' kept.'+scope+' This cannot be undone.'
      : 'Delete all ' + topics.length + ' topics?'+scope+' This cannot be undone.')) return;
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
      vers[d.topic.id] = {last:'', epoch:0};
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
      h += '<li data-idle="'+text(t.id)+'"><span class="idle-main"><span class="idle-name">'+text(t.title || 'Untitled')+'</span>'
         + (where?'<span class="idle-dir">'+text(where)+'</span>':'')+'</span><span class="idle-out"></span></li>';
    }
    idleList.innerHTML=h;
    idleTitle.textContent='Close '+list.length+' idle agent'+(list.length===1?'':'s')+'?';
    idleWhy.hidden=false;
    idleGo.hidden=false;
    idleGo.disabled=false;
    idleGo.textContent='Close agents';
    idleCancel.textContent='Cancel';
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
      if(!d) return alert('Could not end the agent'+(ids.length===1?'':'s')+': the daemon refused the request.');
      // Nothing to say for a clean end — the dots go grey from the daemon's own broadcast. A
      // process the runtime cannot resume is the one refusal that leaves a row looking untouched,
      // and nothing else on the page would say why it is still lit.
      var results=d.results || [], stuck=0;
      for(var i=0;i<results.length;i++) if(results[i].outcome==='unresumable') stuck++;
      if(stuck) alert(stuck+' agent'+(stuck===1?'':'s')+' left running: the runtime cannot resume '+(stuck===1?'it':'them')+'.');
    }, function(){
      alert('Could not reach the server to end the agent'+(ids.length===1?'':'s')+'.');
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
      if(!d) return idleFailed('The daemon refused the request.');
      var rows=idleList.querySelectorAll('li'), i;
      var closed={};
      for(i=0;i<d.closed.length;i++) closed[d.closed[i]]=1;
      for(i=0;i<rows.length;i++){
        var out=rows[i].querySelector('.idle-out'), ok=closed[rows[i].getAttribute('data-idle')];
        out.textContent = ok ? 'closed' : 'left running';
        out.className = 'idle-out' + (ok ? '' : ' kept');
      }
      var n=d.closed.length, k=d.kept.length;
      idleTitle.textContent='Closed '+n+' idle agent'+(n===1?'':'s')
        + (k ? '; '+k+' left running — busy again, or unable to resume' : '');
      idleWhy.hidden=true;
      idleGo.hidden=true;
      idleCancel.textContent='Done';
      idleCancel.focus();
    }, function(){ if(mine===idleSeq) idleFailed('Could not reach the server.'); });
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
    for(id in copies) if(!keep[id]) delete copies[id];
    for(id in vers) if(!keep[id]) delete vers[id];
    for(id in readCounts) if(!keep[id]) delete readCounts[id];
    saveReads();
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
      if(r.ok){ $('secret').value=''; connect(); return; }
      err.textContent = r.status===429 ? 'Too many attempts. Wait a minute.' : 'That is not the right token.';
    }).catch(function(){ err.textContent='Could not reach the server.'; });
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

  // The settings page's rows and values are the same buttons the transcript's menus carry, so
  // they post through the same function — with the topic the page was opened in, not whichever
  // one is on screen (the page is closed when that changes, but the two are not the same fact).
  settingsBody.addEventListener('click', function(e){
    if(!e.target.closest || !settingsMsg || !settingsTopic) return;
    if(e.target.closest('.set-use')){ useTyped(); return; }
    var top = e.target.closest('.ag-top');
    if(top){ toggleAgent(top); return; }
    var b = e.target.closest('button[data-btn]');
    // A switch row is a target as a whole, as a settings row is anywhere: the label is the bigger
    // half of it, and on a phone the one a thumb lands on.
    if(!b){
      var row = e.target.closest('.set-item.sw');
      b = row ? row.querySelector('.set-switch') : null;
    }
    if(!b || b.disabled) return;
    postSetting(b, b.getAttribute('data-btn'));
  });
  settingsBody.addEventListener('input', function(e){
    if(e.target && e.target.classList && e.target.classList.contains('set-type')) filterSettings();
  });
  settingsBody.addEventListener('keydown', function(e){
    if(e.key !== 'Enter' || !e.target || !e.target.classList || !e.target.classList.contains('set-type')) return;
    e.preventDefault();
    useTyped();
  });
  settingsBody.addEventListener('change', function(e){
    var sel = e.target;
    if(!sel || !sel.classList || !sel.classList.contains('set-select')) return;
    postSetting(sel, sel.value);
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

  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    // An IME uses Escape to cancel its candidate list. That keystroke belongs to the composition,
    // not to the page: dismissing a panel (and remembering the dismissal) mid-word is not
    // something the person asked for.
    if(e.isComposing) return;
    // A recording is cancelled by Escape too, and the recorder's own listener below does that.
    // The same keystroke must not also put away what is behind the composer.
    if(rec) return;
    // The instruction editor is opened from the settings page and sits over it: put away the
    // editor alone, and the page it came from is still there.
    if(filesPanel.isCustomOpen()){ filesPanel.close(); return; }
    // Close the topmost thing first: Escape over a picture, the reader or a menu must not also
    // put away a panel behind it. The command suggestions are the composer's own overlay.
    var hintsOpen = !hints.hidden;
    var overlay = hintsOpen || !lightbox.hidden || !reader.hidden || !idleDialog.hidden || !rowMenu.hidden
      || openMenu() || !skillsWin.hidden || !settingsPage.hidden || !taskPage.hidden || filesPanel.isOpen() || gitPanel.isOpen();
    closeShot(); closeReader(); closeIdle(); closeSkills(); closeSettings(); filesPanel.close(); gitPanel.close();
    // Its own confirm when a form holds changes; a refused one leaves everything as it was.
    closeTaskPage(false);
    // The row menu gives the focus back to its ⋯, so a keyboard user is where they left off.
    closeRowMenu(true);
    if(hintsOpen){ hints.hidden = true; hints.innerHTML = ''; }
    var m = openMenu();
    if(m){ setMenu(null, false); m.btn.focus(); }
    // The two panels answer Escape alike: the right one first, then the left. Each is a choice
    // the page remembers, and each has a control on screen that brings it back. A side answer's
    // card goes before either: it is the most passing thing on the page, and over the composer.
    if(!overlay){
      if(!btwBox.hidden) closeBtw(true);
      else if(schedPane.isOpen()) setSchedules(false);
      else if(sbPane.isOpen()) setSidebar(false);
    }
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
    readerSay('Loading\u2026');
    reader.hidden = false;
    readerBody.focus();
    var mine = ++readSeq;
    fetch(link.getAttribute('data-view'), {credentials:'same-origin'}).then(function(r){
      return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; });
    }).then(function(res){
      if(mine !== readSeq) return;
      if(!res.ok) return readerSay(res.status === 404
        ? 'This file is no longer here: the daemon has let it go since it was sent.'
        : (res.body && res.body.error) || 'This file cannot be shown.');
      var j = res.body, note = '';
      if(j.shown < j.size) note = '<div class="reader-note">Showing the first '+text(byteSize(j.shown))+' of '+text(byteSize(j.size))+'. Download it for the rest.</div>';
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
    }).catch(function(){ if(mine === readSeq) readerSay('Could not reach the server.'); });
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
    x.title = 'Remove ' + f.name;
    x.setAttribute('aria-label', 'Remove ' + f.name);
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
    delete copies[id];
    delete vers[id];
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
    for(id in views) if(!known[id]) delete views[id];
    for(id in copies) if(!known[id]) delete copies[id];
    for(id in vers) if(!known[id]) delete vers[id];
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
    noteOwner = 'Compressing ' + (n > 1 ? n + ' pictures' : 'picture') + '...';
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
                note.textContent = 'Could not read ' + name + '; it was not attached.';
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
  var micBtn=$('mic'), rec=null, recStarting=false, voices=0;
  var MIC_TYPES=['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/mp4','audio/webm'];
  var MIC_MAX_MS=10*60*1000;
  micBtn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  function recordType(){
    for(var i=0;i<MIC_TYPES.length;i++){
      try { if(MediaRecorder.isTypeSupported(MIC_TYPES[i])) return MIC_TYPES[i]; } catch(e){}
    }
    return '';
  }
  function micLabel(){
    if(!rec){ micBtn.innerHTML=IC.icon.mic; micBtn.classList.remove('rec'); micBtn.title='Record a voice message'; return; }
    var s=Math.floor((Date.now()-rec.started)/1000);
    micBtn.innerHTML=IC.icon.stop+' '+Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
    micBtn.classList.add('rec');
    micBtn.title='Stop and send the recording (Esc discards it)';
  }
  function micFailed(e){
    recStarting=false;
    note.textContent='Could not record: '+((e && (e.message || e.name)) || 'the microphone is unavailable')+'.';
    micLabel();
  }
  function releaseMic(r){ r.stream.getTracks().forEach(function(t){ t.stop(); }); }
  function voiceExt(mime){ var sub=mime.split('/')[1] || 'webm'; return sub==='mp4' ? 'm4a' : sub; }

  function startRec(){
    recStarting=true;
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      recStarting=false;
      var type=recordType(), mr;
      try { mr = type ? new MediaRecorder(stream, {mimeType:type}) : new MediaRecorder(stream); }
      catch(e){ stream.getTracks().forEach(function(t){ t.stop(); }); micFailed(e); return; }
      var r={mr:mr, stream:stream, type:type, parts:[], started:Date.now(), keep:true, timer:0, cap:0};
      mr.ondataavailable=function(ev){ if(ev.data && ev.data.size) r.parts.push(ev.data); };
      mr.onstop=function(){
        releaseMic(r);
        if(!r.keep || !r.parts.length) return;
        var mime=(mr.mimeType || r.type || 'audio/webm').split(';')[0];
        var fr=new FileReader();
        fr.onload=function(){
          var s=String(fr.result), c=s.indexOf(',');
          voices++;
          dispatch('', [{name:'voice-'+voices+'.'+voiceExt(mime), mime:mime, data:c<0?'':s.slice(c+1)}]);
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
    else if(!recStarting && topic) startRec();
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
      if(Object.prototype.hasOwnProperty.call(unsent, n) && unsent[n].t === tId && !data['p:'+n]) list.push(n);
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
    data['p:'+nonce] = localMsg(nonce, unsent[nonce]);
    paint('p:'+nonce);
    // A side question opens its card at once, saying it is being asked: the answer can take a
    // while to start, and the line alone would not say anything was happening.
    if(btwAsked('p:'+nonce, data['p:'+nonce]) !== null) openBtw('p:'+nonce);
    syncEmptyNote();
    // Unconditionally, unlike an arriving message: you have just written this one, so wherever
    // you were in the history is not where you want to be now.
    toBottom();
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
    return (t.title || 'Untitled') + ' (' + INSTANCE_ID + ':main/' + t.id + ')';
  }

  function syncCopyRef(){
    if(libOn()){
      var ref = historyPanel.currentRef();
      copyRefBtn.hidden = !ref;
      copyRefBtn.title = ref ? 'Copy reference: ' + ref : 'Copy conversation reference';
      return;
    }
    var cur = topicById(topic);
    copyRefBtn.hidden = !cur;
    copyRefBtn.title = cur ? 'Copy reference: ' + topicRef(cur) : 'Copy conversation reference';
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
      flashCopyNote(ok ? 'Copied reference: ' + ref : 'Could not copy the reference.');
    });
  }

  function flashCopyBtn(btn, ok, restoreTitle, restoreLabel){
    var say = ok ? 'Copied' : 'Could not copy';
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
    copyText(m._text, function(ok){ btn.textContent = ok ? 'Copied' : 'Select it above'; });
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
      flashCopyBtn(copyRefBtn, ok, 'Copy reference: ' + ref, 'Copy conversation reference');
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
  enter(topic);
})();
