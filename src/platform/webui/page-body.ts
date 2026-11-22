/**
 * The page's body: every element the client script finds by id, as one template.
 *
 * Split out of `page.ts` when its script and stylesheet moved to `client/` (Phase 1 Step 1A of
 * docs/refactor-plan.md) — the markup itself is unchanged, and `page.ts` is left as the shell that
 * frames it: the head, the gate, the boot config and the two asset references.
 *
 * It stays a TypeScript template rather than an `.html` file for the reason `page.ts` gives (tsc
 * ships it to `dist`), and so the icons can be interpolated from `icons.ts`. The same trap applies:
 * a literal backtick or `${` here is read as part of this template.
 */
import { icon } from './icons.js';

export const PAGE_BODY = `<main id="app" hidden>
  <aside id="sidebar" class="panel panel-left">
    <div id="sidebar-header" class="panel-head">
      <!-- Topics | History: two tabs where the title was. History lists every conversation the
           library recorded, and one opened from it takes the transcript's place (openLib). -->
      <span class="panel-title"><span class="sb-tabs" role="tablist" aria-label="Topics and history" data-i18n-aria="sidebar.tabsAria"><button type="button" class="sb-tab on" id="sb-tab-topics" role="tab" aria-selected="true" aria-controls="topics" aria-label="Topics" data-i18n-aria="sidebar.topics" title="Topics on this page" data-i18n-title="sidebar.topicsTitle">${icon('chat')}<span class="sb-word" data-i18n="sidebar.topics">Topics</span></button><button type="button" class="sb-tab" id="sb-tab-history" role="tab" aria-selected="false" aria-controls="history-pane" aria-label="History" data-i18n-aria="sidebar.history" title="Every conversation the gateway recorded" data-i18n-title="sidebar.historyTitle">${icon('history')}<span class="sb-word" data-i18n="sidebar.history">History</span></button></span><button type="button" class="btn-icon" id="clear-topics" title="Clear all topics" data-i18n-title="sidebar.clearAllTopics" aria-label="Clear all topics" data-i18n-aria="sidebar.clearAllTopics"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></button><button type="button" class="btn-icon" id="read-topics" title="Mark all read" data-i18n-title="sidebar.markAllRead" aria-label="Mark all read" data-i18n-aria="sidebar.markAllRead" disabled>${icon('done')}</button></span>
      <button type="button" class="btn-icon add" id="new-topic" data-new="1" title="New topic" data-i18n-title="sidebar.newTopic">+</button>
      <button type="button" class="btn-icon panel-close" id="collapse-sidebar" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
    </div>
    <!-- The topic list's search and filters. Built by makeFilterBar in the script; an empty host
         here so the markup and the component stay separate. -->
    <div id="topics-filter"></div>
    <div id="topics" role="tabpanel" aria-labelledby="sb-tab-topics"></div>
    <!-- The History tab: the conversation library — the same history.db the fleetherd sessions
         command reads, whichever agent and platform a conversation ran on. A list, a keyword
         search, and Load older; a row opens in the transcript's place, read-only. -->
    <div id="history-pane" role="tabpanel" aria-labelledby="sb-tab-history" hidden>
      <div id="history-search" class="filterbar">
        <div class="fb-row">
          <div class="fb-search">
            <input id="history-q" class="fb-q" type="search" autocomplete="off" placeholder="Search all conversations" data-i18n-placeholder="history.searchPlaceholder" aria-label="Search all conversations" data-i18n-aria="history.searchPlaceholder">
            <button type="button" class="fb-qclear" id="history-go" title="Search (Enter)" data-i18n-title="history.searchTitle" aria-label="Search" data-i18n-aria="common.search">${icon('search')}</button>
          </div>
        </div>
        <div class="fb-sum" id="history-count"></div>
      </div>
      <div id="history-body">
        <div id="history-list"></div>
        <!-- Below the list, not above it: a page that could not be read was asked for with the
             button under the last row, and a list fifty rows long puts anything above it out of
             view (measured 2026-11-10, 390×844: the error sat 2550px above the viewport). The
             first page failing leaves the list empty, so there this element is still the first
             thing under the search row. -->
        <div id="history-err" class="hist-note bad" hidden></div>
        <button type="button" id="history-more" data-i18n="history.loadOlder" hidden>Load older conversations</button>
      </div>
    </div>
    <!-- Two menus, one row. Menu holds what is set once per device or visited rarely; Manage
         holds Close idle, with the idle count on its face so the number is still seen without
         opening anything. Both open upward with the same box and the same dismissal (setMenu). -->
    <div id="sidebar-footer" class="panel-foot">
      <button type="button" id="opts-toggle" aria-expanded="false" aria-controls="opts-menu" title="Menu" data-i18n-title="menu.menu"><span class="opts-gear">${icon('gear')}</span><span class="opts-word"> <span data-i18n="menu.menu">Menu</span></span></button>
      <button type="button" id="manage-toggle" aria-expanded="false" aria-controls="manage-menu" title="Close idle agents" data-i18n-title="menu.manageTitle"><span class="opts-gear"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></span><span class="opts-word"> <span data-i18n="menu.manage">Manage</span></span><span class="foot-count" id="idle-count"></span></button>
      <div id="opts-menu" class="panel-menu" hidden>
        <!-- The gateway's own settings: agents, models, idle reclaim, scope. A page rather than a
             chat command, because the rows need the width a message never had. -->
        <button type="button" id="settings-open" title="Agents, models and conversation settings for this topic" data-i18n-title="menu.allSettingsTitle"><span data-i18n="menu.allSettings">All settings</span></button>
        <button type="button" id="notify-toggle" hidden aria-pressed="false" title="Notify this device when something needs you" data-i18n-title="menu.notificationsTitle"><span data-i18n="menu.notifications">Notifications</span><span class="opt-state" id="notify-state">off</span></button>
        <button type="button" id="calm-toggle" aria-pressed="false" title="Running topics stop pulsing and unread counts go grey; a question, a failure or an unread reply still stands out. This device only." data-i18n-title="menu.lowAttentionTitle"><span data-i18n="menu.lowAttention">Low attention</span><span class="opt-state" id="calm-state">off</span></button>
        <button type="button" id="theme-toggle" title="Theme: System — click to switch (System / Dark / Light)" aria-label="Theme: System"><span data-i18n="menu.theme">Theme</span><span class="opt-state" id="theme-state">System</span></button>
        <button type="button" id="lang-toggle" title="Switch interface language" data-i18n-title="menu.languageTitle"><span data-i18n="menu.language">Language</span><span class="opt-state" id="lang-state">English</span></button>
        <div class="opts-sep"></div>
        <!-- The gateway's managed skills: a surface of its own, not a setting, which is why it
             was a footer button of its own until the row ran out of width. -->
        <button type="button" id="skills-toggle" title="Skills the gateway gives every agent" data-i18n-title="menu.skillsTitle"><span data-i18n="menu.skills">Skills</span></button>
      </div>
      <div id="manage-menu" class="panel-menu" hidden>
        <button type="button" id="close-idle" hidden title="End the agent process of every topic that is idle — each conversation is kept" data-i18n-title="menu.closeIdleTitle" data-i18n="menu.closeIdle">Close idle</button>
        <button type="button" id="no-idle" disabled data-i18n="menu.noIdleAgents">No idle agents</button>
      </div>
    </div>
    <div id="sidebar-resize" class="panel-resize" title="Drag to resize · double-click for the default width" data-i18n-title="sidebar.resizeTitle"></div>
  </aside>
  <div id="backdrop"></div>
  <!-- Filled in and revealed when a picture in the log is tapped. One node reused for every
       image, rather than one per message: the transcript holds hundreds. -->
  <div id="lightbox" hidden><img id="lightbox-img" alt=""></div>
  <!-- A file the agent sent, rendered for reading (openReader). One node for every file, like the
       lightbox; the body is emptied when it closes. A window over the transcript rather than a page
       of its own, so the conversation stays visible around it. tabindex lets the body take focus on
       open, so the keyboard scrolls the document rather than the transcript behind it. -->
  <div id="reader" hidden role="dialog" aria-modal="true" aria-labelledby="reader-name">
    <div id="reader-box">
      <div id="reader-bar">
        <span id="reader-name"></span>
        <a id="reader-get" download data-i18n="common.download">Download</a>
        <button type="button" class="btn-icon" id="reader-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="reader-body" tabindex="-1"></div>
    </div>
  </div>
  <!-- The gateway's managed skills, as a window over the transcript. One node with two views
       inside it — the list and the open skill — because a skill is edited in place and going
       back is one tap, not a second window. Every write goes to api/skills/op; the store
       behind it is the one the fleetherd skills command uses, and turning a skill off is an archive. -->
  <div id="skills" hidden role="dialog" aria-modal="true" aria-labelledby="skills-title">
    <div id="skills-box">
      <div id="skills-bar">
        <button type="button" class="btn-icon" id="skills-back" title="Back to all skills" data-i18n-title="skills.backTitle" aria-label="Back" data-i18n-aria="common.back" hidden>${icon('chevronLeft')}</button>
        <span id="skills-title" data-i18n="skills.title">Skills</span>
        <span id="skills-count"></span>
        <button type="button" class="btn-icon" id="skills-refresh" title="Refresh skills" data-i18n-title="skills.refreshTitle" aria-label="Refresh skills" data-i18n-aria="skills.refreshTitle">${icon('refresh')}</button>
        <button type="button" id="skills-new" title="Create a skill" data-i18n-title="skills.newTitle" data-i18n="common.new">New</button>
        <button type="button" class="btn-icon" id="skills-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="skills-body">
        <div id="skills-note" hidden></div>
        <div id="skills-list"></div>
        <div id="skills-detail" hidden></div>
      </div>
    </div>
  </div>
  <!-- A scheduled task's own page: what its row folds away, the topics its runs opened, its runs,
       and the form that changes it. Filled from api/schedules/task; a save goes to
       api/schedules/edit, which is fleetherd schedule edit with its rules. See openTaskPage. The same
       form registers a new task (api/schedules/add, schedule add's rules): see openNewTask. -->
  <div id="task-page" hidden role="dialog" aria-modal="true" aria-labelledby="task-title">
    <div id="task-box">
      <div id="task-bar">
        <div class="set-heading">
          <span id="task-title" data-i18n="taskPage.title">Task</span>
          <span id="task-sub"></span>
        </div>
        <button type="button" class="btn-icon" id="task-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="task-body">
        <div id="task-note" hidden role="status"></div>
        <div id="task-view"></div>
      </div>
    </div>
  </div>
  <!-- /setting as a page rather than a message in the transcript. It is filled from the same
       structured screen the daemon already sends (settingsScreen), so the rows, the values and
       the write all stay on the daemon's side; this element only draws them. The bar says where
       they are kept: config.yaml, the same for every topic. -->
  <div id="settings-page" hidden role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div id="settings-box">
      <div id="settings-bar">
        <div class="set-heading">
          <span id="settings-title" data-i18n="settings.title">Settings</span>
          <span id="settings-topic"></span>
        </div>
        <button type="button" class="btn-icon" id="settings-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="settings-body"></div>
    </div>
  </div>
  <!-- The file window: a directory tree on the left (a drawer on a phone), breadcrumbs, a filename
       search, and an editor on the right. One node for the page, bound to the topic that opened it;
       the files it shows are that topic's machine's (daemon/file-panel.ts). Every path it sends is
       fenced by the daemon against the topic's workspace, and every write is version-checked. -->
  <div id="files" hidden role="dialog" aria-modal="true" aria-labelledby="files-title">
    <div id="files-box">
      <div id="files-bar">
        <button type="button" class="btn-icon" id="files-tree-toggle" title="Files" data-i18n-title="files.title" aria-label="Show the file tree" data-i18n-aria="files.showTreeAria">${icon('menu')}</button>
        <span id="files-title" data-i18n="files.title">Files</span>
        <span id="files-where"></span>
        <button type="button" class="btn-icon" id="files-refresh" title="Refresh" data-i18n-title="common.refresh" aria-label="Refresh" data-i18n-aria="common.refresh">${icon('refresh')}</button>
        <button type="button" class="btn-icon" id="files-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="files-body">
        <aside id="files-tree" aria-label="Files" data-i18n-aria="files.title">
          <div id="files-tree-head">
            <button type="button" id="files-new-file" title="New file" data-i18n-title="files.newFile" data-i18n="files.newFile">New file</button>
            <button type="button" id="files-new-dir" title="New folder" data-i18n-title="files.newFolder" data-i18n="files.newFolder">New folder</button>
          </div>
          <div id="files-new-row" hidden>
            <input id="files-new-name" type="text" autocomplete="off" placeholder="name" data-i18n-placeholder="files.namePlaceholder" aria-label="Name" data-i18n-aria="files.nameAria">
            <button type="button" id="files-new-go" data-i18n="common.create">Create</button>
            <button type="button" id="files-new-cancel" data-i18n="common.cancel">Cancel</button>
          </div>
          <div id="files-tree-list"></div>
          <div id="files-hits" hidden></div>
        </aside>
        <div id="files-main">
          <div id="files-crumbs"></div>
          <div id="files-search-row">
            <input id="files-q" type="search" autocomplete="off" placeholder="Search by file name" data-i18n-placeholder="files.searchPlaceholder" aria-label="Search by file name" data-i18n-aria="files.searchPlaceholder">
            <button type="button" id="files-q-go" title="Search" data-i18n-title="common.search" aria-label="Search" data-i18n-aria="common.search">${icon('search')}</button>
          </div>
          <div id="files-note" role="status" hidden></div>
          <!-- What a save will do to this file's line endings, when that is a change: mixed
               endings, or a file that uses only CR (which an editor cannot hold). Shown before
               the editor rather than changing the file quietly on the first save. -->
          <div id="files-eol" role="status" hidden></div>
          <div id="files-editor"></div>
          <div id="files-preview" hidden></div>
          <div id="files-conflict" hidden>
            <div id="files-conflict-text"></div>
            <div class="fx-acts">
              <button type="button" id="files-reload" data-i18n="files.reloadDisk">Reload from disk</button>
              <button type="button" id="files-overwrite" data-i18n="files.overwrite">Overwrite</button>
              <button type="button" id="files-cancel" data-i18n="common.cancel">Cancel</button>
            </div>
          </div>
          <div id="files-actions">
            <button type="button" id="files-save" disabled data-i18n="common.save">Save</button>
            <button type="button" id="files-preview-toggle" hidden data-i18n="files.preview">Preview</button>
            <button type="button" id="files-rename-open" disabled data-i18n="common.rename">Rename</button>
            <button type="button" id="files-delete" disabled data-i18n="common.delete">Delete</button>
            <span id="files-dirty" hidden data-i18n="files.unsavedChanges">Unsaved changes</span>
          </div>
          <div id="files-rename-row" hidden>
            <span id="files-rename-what"></span>
            <input id="files-rename-name" type="text" autocomplete="off" aria-label="New name" data-i18n-aria="files.newNameAria">
            <button type="button" id="files-rename-go" data-i18n="common.rename">Rename</button>
            <button type="button" id="files-rename-cancel" data-i18n="common.cancel">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- The repository the topic's directory sits in, as a window over the transcript. Three
       comparisons (working tree, branch, committed) and the commit history, a file list, one
       file's diff, and line comments that go into the composer — never sent from here. The same
       window is used by the turn-changes view through openGitWindow(source), which fixes its two
       URLs and hides the comparison controls. -->
  <div id="git" hidden role="dialog" aria-modal="true" aria-labelledby="git-title">
    <div id="git-box">
      <div id="git-bar">
        <span id="git-title" data-i18n="git.title">Changes</span>
        <span id="git-branch"></span>
        <div id="git-modes" role="tablist" aria-label="Compare" data-i18n-aria="git.compareAria">
          <button type="button" class="git-mode on" data-gm="working" data-i18n="git.modeWorking">Working</button>
          <button type="button" class="git-mode" data-gm="branch" data-i18n="git.modeBranch">Branch</button>
          <button type="button" class="git-mode" data-gm="committed" data-i18n="git.modeCommitted">Committed</button>
          <button type="button" class="git-mode" data-gm="commits" data-i18n="git.modeCommits">Commits</button>
        </div>
        <select id="git-base" title="Compare against this branch" data-i18n-title="git.baseTitle" aria-label="Compare against this branch" data-i18n-aria="git.baseTitle" hidden></select>
        <span id="git-spacer"></span>
        <button type="button" id="git-layout" title="Switch between one column and two" data-i18n-title="git.layoutTitle" data-i18n="git.split" hidden>Split</button>
        <button type="button" class="btn-icon" id="git-refresh" title="Refresh changes" data-i18n-title="git.refreshTitle" aria-label="Refresh changes" data-i18n-aria="git.refreshTitle">${icon('refresh')}</button>
        <button type="button" class="btn-icon" id="git-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
      </div>
      <div id="git-body">
        <div id="git-files"></div>
        <div id="git-pane">
          <div id="git-note" hidden role="status"></div>
          <div id="git-sel" hidden><span id="git-sel-what"></span><button type="button" id="git-comment-open" data-i18n="git.comment">Comment</button></div>
          <div id="git-diff"></div>
          <div id="git-comment" hidden>
            <div id="git-comment-what"></div>
            <textarea id="git-comment-text" placeholder="What about these lines?" data-i18n-placeholder="git.commentPlaceholder" aria-label="Comment" data-i18n-aria="git.comment"></textarea>
            <div id="git-comment-acts">
              <button type="button" id="git-comment-cancel" data-i18n="common.cancel">Cancel</button>
              <button type="button" class="primary" id="git-comment-add" data-i18n="git.addToMessage">Add to message</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <!-- A list row's menu, opened by its ⋯. One box for every list on the page — topic rows,
       scheduled runs, scheduled tasks — filled by openRowMenu. At the body, not inside a list:
       every one of them is rebuilt with innerHTML on a poll or on a streaming reply, and a menu
       inside one would be wiped mid-tap. Positioned from the button's rect by positionRowMenu. -->
  <div id="row-menu" role="menu" aria-label="Row actions" data-i18n-aria="topic.rowActions" hidden></div>
  <!-- "Close idle agents", confirmed against the list it will act on (openIdle), then showing what
       happened to each. -->
  <div id="idle-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="idle-title">
    <div id="idle-box">
      <div id="idle-title"></div>
      <p id="idle-why" data-i18n="idle.why">Each conversation is kept: the next message in a topic starts its agent again where it left off.</p>
      <ul id="idle-list"></ul>
      <div class="idle-acts">
        <button type="button" id="idle-cancel" data-i18n="common.cancel">Cancel</button>
        <button type="button" id="idle-go" data-i18n="idle.closeAgents">Close agents</button>
      </div>
    </div>
  </div>
  <section id="chat">
    <div id="chat-header">
      <button type="button" class="btn-icon" id="expand-sidebar" title="Show topics" data-i18n-title="sidebar.showTopics" aria-label="Show topics" data-i18n-aria="sidebar.showTopics" hidden>${icon('menu')}</button>
      <span id="topic-title" class="chat-title"></span>
      <!-- A conversation opened from the History tab: its title, and the word that says what it is.
           Separate from #topic-title, which every topics event rewrites for the topic underneath. -->
      <span id="lib-title" class="chat-title"></span>
      <span id="lib-tag" class="chat-status" title="A conversation from History, read-only" data-i18n-title="history.readOnlyTagTitle">${icon('history')}<span class="lib-tag-word" data-i18n="history.readOnlyTag">History · read-only</span></span>
      <button type="button" class="btn-icon" id="copy-ref" hidden title="Copy conversation reference" data-i18n-title="topic.copyRefBtn" aria-label="Copy conversation reference" data-i18n-aria="topic.copyRefBtn">${icon('copy')}</button>
      <!-- /kill, one tap away. Beside the title rather than beside Send because it is about the
           topic — the process behind it — and not about the message being written; shown only
           while there is a process to end, which is the same fact the sidebar dot is lit by.
           An SVG rather than U+23FB: that glyph only arrived in Unicode 9, not every system font
           carries it, and where it is missing it renders as an empty box — which nobody presses. -->
      <button type="button" class="btn-icon" id="kill-agent" hidden
        title="End the agent process — the conversation is kept, and the next message resumes it (/kill)"
        data-i18n-title="chat.killAgentTitle"
        aria-label="End the agent process" data-i18n-aria="chat.killAgentAria"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"
        stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path
        d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg></button>
      <span id="topic-status" class="chat-status"></span>
      <!-- Present in the markup but hidden unless the daemon serves a terminal, so the script
           has one thing to reveal rather than one thing to build. -->
      <button type="button" class="btn-icon" id="term-toggle" title="Terminal" data-i18n-title="term.title" aria-label="Terminal" data-i18n-aria="term.title" hidden>${icon('terminal')}</button>
      <!-- The file window: the files of whichever machine this topic's agent runs on. Built in the
           markup and hidden, like the terminal's button, so the script reveals one thing rather
           than constructing one; it is revealed only when platforms.<id>.files is enabled. -->
      <button type="button" class="btn-icon" id="files-toggle" title="Files on this topic's machine" data-i18n-title="chat.filesToggleTitle" aria-label="Files" data-i18n-aria="files.title" hidden>${icon('folder')}</button>
      <!-- Always present, unlike the terminal's: the task panel is the only place on this page
           where scheduled tasks are managed. A clock rather than an emoji for the same reason
           the power button is an SVG — it has to sit on the header's text baseline. -->
      <button type="button" class="btn-icon" id="schedules-toggle" aria-expanded="false" aria-controls="schedules" title="Side tasks" data-i18n-title="sideTasks.title" aria-label="Side tasks" data-i18n-aria="sideTasks.title"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span class="sched-alert" id="sched-alert" hidden></span></button>
      <!-- The repository the topic's directory sits in: what changed, and one file's diff. Read
           only — committing stays in the conversation, where the agent can be asked what it meant. -->
      <button type="button" class="btn-icon" id="git-toggle" title="Changes in this directory" data-i18n-title="chat.gitToggleTitle" aria-label="Changes" data-i18n-aria="git.title">${icon('git')}</button>
    </div>
    <!-- A fork's source (Topic.forkOf), and the way back to it. Above the transcript, which is empty
         at first: the fork holds the agent's context, not the messages. -->
    <button type="button" id="fork-note" hidden></button>
    <div id="log"></div>
    <!-- A conversation from the History tab, in the transcript's place (openLib). Its own element
         rather than #log: the topic underneath keeps its stream, its messages and its place, and is
         simply shown again when this closes. Drawn with the same bubbles as #log. -->
    <div id="lib-log" aria-label="Recorded conversation" data-i18n-aria="history.recordedAria"></div>
    <!-- Where the composer was: why nothing can be sent here, and the ways out. The note says what
         the store's bound left out, and sits here because this is where the reader lands. -->
    <div id="lib-bar" role="status">
      <div id="lib-note" class="hist-note" hidden></div>
      <div class="lib-ro">
        <span id="lib-why"></span>
        <span class="lib-acts">
          <button type="button" id="lib-topic" data-i18n="history.openTopic" hidden>Open the topic</button>
          <button type="button" id="lib-close" title="Back to the conversation you were in" data-i18n-title="history.closeTitle" data-i18n="common.close">Close</button>
        </span>
      </div>
    </div>
    <div id="typing" hidden>...</div>
    <div id="note"></div>
    <div id="bar">
      <!-- The agent's live status. Inside #bar rather than above it so it reads as part of the
           place you type. -->
      <!-- The topic's machine cannot be reached (paintMachineNote). Beside the status line, for
           the same reason it is inside #bar: it is about what typing here will do. -->
      <!-- The daemon came back from a restart serving a different page than this one (checkBuild).
           Above the composer, where a phone still shows it, and an offer rather than a reload:
           the page knows nothing about what a reload would throw away. -->
      <div id="update" role="status" hidden><span data-i18n="update.available">fleetherd was updated while this page was open.</span> <button type="button" id="update-reload" data-i18n="gate.reload">Reload</button></div>
      <div id="machine-note" role="status" hidden></div>
      <div id="status" hidden title="Tap for details" data-i18n-title="status.tapDetails"></div>
      <!-- The answer to a side question (/btw), read here rather than in the transcript (openBtw). -->
      <div id="btw" hidden role="dialog" aria-labelledby="btw-q">
        <div class="btw-head">
          <span class="btw-tag">btw</span>
          <div id="btw-q"></div>
          <button type="button" class="btn-icon" id="btw-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
        </div>
        <div id="btw-body"></div>
      </div>
      <!-- The model switch's list, opened from the model in the status line (openModelPop), and the
           same list for one of the agent's own settings (openOptPop). -->
      <div id="model-pop" hidden role="dialog" aria-labelledby="mp-heading">
        <div class="mp-head">
          <div class="mp-title"><b id="mp-heading" data-i18n="modelPop.headingModel">Model for this topic</b><span id="mp-agent"></span></div>
          <button type="button" class="btn-icon" id="mp-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
        </div>
        <input id="mp-filter" type="text" placeholder="Filter models" data-i18n-placeholder="modelPop.filterModels" aria-label="Filter models" data-i18n-aria="modelPop.filterModels" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div id="mp-list" role="listbox" aria-labelledby="mp-heading"></div>
        <p class="mp-foot" id="mp-foot"></p>
      </div>
      <div id="hints" hidden></div>
      <div id="chips"></div>
      <form id="composer">
        <div id="row">
          <textarea id="input" rows="1" placeholder="Message" data-i18n-placeholder="composer.placeholder" autocomplete="off"></textarea>
          <input id="picker" type="file" multiple hidden>
          <button type="button" id="attach" title="Attach a file" data-i18n-title="composer.attachTitle">+</button>
          <!-- A voice message: tap to record, tap again to send it on its own. Hidden where the
               browser cannot record (no MediaRecorder, or an insecure origin, where
               navigator.mediaDevices does not exist at all). -->
          <button type="button" id="mic" title="Record a voice message" data-i18n-title="composer.micTitle" aria-label="Record a voice message" data-i18n-aria="composer.micTitle" hidden>${icon('mic')}</button>
          <!-- /stop, while there is a turn to stop. Beside Send because that is where the eye
               already is while a reply streams in, and separate from it because the composer
               still sends mid-turn (into the running turn, or queued behind it) — neither of
               which is "stop". -->
          <button type="button" id="stop-turn" title="Stop what the agent is doing — the conversation is kept (/stop)" data-i18n-title="composer.stopTitle" data-i18n="composer.stop" hidden>Stop</button>
          <!-- A tooltip is a pointer's affordance, so it names the pointer's shortcut: under the
               narrow-screen layout Enter writes a newline, but nothing there can hover to read
               this. Ctrl-Enter sends on both and is what that layout's users are left with. -->
          <button type="submit" title="Send (Enter)" data-i18n-title="composer.sendTitle" data-i18n="composer.send">Send</button>
        </div>
      </form>
    </div>
    <!-- The panel's divider, dragged like the side panel's. Only on screen while the panel is,
         and never when the daemon serves no terminal at all: it is a control, not decoration. -->
    <div id="term-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panel" data-i18n-aria="term.gripAria" aria-controls="term" title="Drag to resize · double-click for half the screen" data-i18n-title="term.gripTitle" tabindex="0"></div>
    <!-- A panel, not a mode: the bar is what makes minimize and close two different things.
         The dash hides it and leaves the session connected; the cross ends the session, and is
         rendered only where the daemon was given a way to do that. Below the composer, so the
         transcript and the place you type are both above it and neither is covered. -->
    <div id="term">
      <div id="term-bar">
        <span id="term-name" class="term-name"></span>
        <button type="button" class="btn-icon" id="term-min" title="Minimize — the terminal keeps running" data-i18n-title="term.minTitle">&#8211;</button>
        <button type="button" class="btn-icon" id="term-end" title="End this terminal session" data-i18n-title="term.endTitle" hidden>&times;</button>
      </div>
      <div id="term-frames"></div>
    </div>
  </section>
  <!-- The side panel: the same .panel as the sidebar, on the right. A column of its own on a wide
       screen and a drawer below 1024px; the stylesheet decides which of the two it is from the
       width, and .collapsed is what moves it off-screen either way. Outside #chat because it is
       about the gateway, not about the topic being read. -->
  <aside id="schedules" class="panel panel-right" aria-label="Side tasks" data-i18n-aria="sideTasks.title">
    <!-- The docked panel's width, dragged like the sidebar's. Not offered below 1024px, where
         the panel is a drawer and the screen decides its width. -->
    <div id="sched-resize" class="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" data-i18n-aria="sideTasks.resizeAria" title="Drag to resize · double-click for the default width" data-i18n-title="sidebar.resizeTitle"></div>
    <div id="schedules-head" class="panel-head">
      <div class="sched-heading">
        <span class="panel-title" data-i18n="sideTasks.title">Side tasks</span>
        <span id="schedules-summary" class="sched-summary"></span>
      </div>
      <!-- The Sessions tab's one bulk action, as the topic list has it beside its title. Shown only
           on that tab: it marks runs read, and over Tasks or Reviews it would name nothing listed. -->
      <button type="button" class="btn-icon" id="sched-read" title="Mark all read" data-i18n-title="sidebar.markAllRead" aria-label="Mark all read" data-i18n-aria="sidebar.markAllRead" disabled hidden>${icon('done')}</button>
      <!-- The Tasks tab's one action of its own: a new task, on the same form an edit uses
           (openNewTask). Shown only there, as Mark all read is only on Sessions. -->
      <button type="button" class="btn-icon" id="sched-new" title="New task" data-i18n-title="sideTasks.newTask" aria-label="New task" data-i18n-aria="sideTasks.newTask" hidden>${icon('plus')}</button>
      <button type="button" class="btn-icon panel-close" id="schedules-close" title="Close (Esc)" data-i18n-title="common.closeEsc" aria-label="Close" data-i18n-aria="common.close">&times;</button>
    </div>
    <div id="sched-subnav" class="sched-subnav" role="tablist" aria-label="Tasks and sessions" data-i18n-aria="sideTasks.subnavAria">
      <button type="button" class="sched-subtab on" id="sched-tab-tasks" role="tab" aria-selected="true" aria-controls="schedules-list"><span data-i18n="sideTasks.tabTasks">Tasks</span> <span class="sched-count" id="sched-tab-tasks-n"></span></button>
      <button type="button" class="sched-subtab" id="sched-tab-sessions" role="tab" aria-selected="false" aria-controls="sched-sessions"><span data-i18n="sideTasks.tabSessions">Sessions</span> <span class="sched-count" id="sched-tab-sessions-n"></span><span class="sched-tab-alert" id="sched-sessions-alert" hidden></span></button>
    </div>
    <!-- The Tasks list's search, filters and sort. Built by makeFilterBar in the script, and
         mounted outside #schedules-list: that list is redrawn with innerHTML on every poll. -->
    <div id="sched-filter" hidden></div>
    <div id="schedules-body">
      <div id="schedules-note" hidden></div>
      <div id="schedules-list" role="tabpanel" aria-labelledby="sched-tab-tasks"></div>
      <div id="sched-sessions" role="tabpanel" aria-labelledby="sched-tab-sessions" hidden></div>
      <div id="sched-reviews" role="tabpanel" aria-labelledby="sched-tab-reviews" hidden>
        <div id="sched-reviews-list"></div>
      </div>
    </div>
    <!-- Two top-level tabs at the foot of the panel: Scheduled background work and automatic Reviews.
         Scheduled tasks and the topics opened by their runs belong together under one top-level tab,
         subdivided into Tasks (default) and Sessions so definitions and run instances remain distinct
         without cluttering the footer. The tabs sit at the foot, matching the sidebar's footer row,
         so the two columns end together. -->
    <div id="sched-tabs" class="panel-foot" role="tablist" aria-label="Side tasks and reviews" data-i18n-aria="sideTasks.tabsAria">
      <button type="button" class="sched-tab on" id="sched-tab-scheduled" role="tab" aria-selected="true" aria-controls="schedules-body"><span data-i18n="sideTasks.tabScheduled">Scheduled</span> <span class="sched-count" id="sched-tab-scheduled-n"></span><span class="sched-tab-alert" id="sched-tab-alert" hidden></span></button>
      <button type="button" class="sched-tab" id="sched-tab-reviews" role="tab" aria-selected="false" aria-controls="sched-reviews"><span data-i18n="sideTasks.tabReviews">Reviews</span> <span class="sched-count" id="sched-tab-reviews-n"></span></button>
    </div>
  </aside>
</main>
`;
