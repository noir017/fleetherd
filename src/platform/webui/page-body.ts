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
      <span class="panel-title"><span class="sb-tabs" role="tablist" aria-label="Topics and history"><button type="button" class="sb-tab on" id="sb-tab-topics" role="tab" aria-selected="true" aria-controls="topics" aria-label="Topics" title="Topics on this page">${icon('chat')}<span class="sb-word">Topics</span></button><button type="button" class="sb-tab" id="sb-tab-history" role="tab" aria-selected="false" aria-controls="history-pane" aria-label="History" title="Every conversation the gateway recorded">${icon('history')}<span class="sb-word">History</span></button></span><button type="button" class="btn-icon" id="clear-topics" title="Clear all topics" aria-label="Clear all topics"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></button><button type="button" class="btn-icon" id="read-topics" title="Mark all read" aria-label="Mark all read" disabled>${icon('done')}</button></span>
      <button type="button" class="btn-icon add" id="new-topic" data-new="1" title="New topic">+</button>
      <button type="button" class="btn-icon panel-close" id="collapse-sidebar" title="Close (Esc)" aria-label="Close">&times;</button>
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
            <input id="history-q" class="fb-q" type="search" autocomplete="off" placeholder="Search all conversations" aria-label="Search all conversations">
            <button type="button" class="fb-qclear" id="history-go" title="Search (Enter)" aria-label="Search">${icon('search')}</button>
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
        <button type="button" id="history-more" hidden>Load older conversations</button>
      </div>
    </div>
    <!-- Two menus, one row. Menu holds what is set once per device or visited rarely; Manage
         holds Close idle, with the idle count on its face so the number is still seen without
         opening anything. Both open upward with the same box and the same dismissal (setMenu). -->
    <div id="sidebar-footer" class="panel-foot">
      <button type="button" id="opts-toggle" aria-expanded="false" aria-controls="opts-menu" title="Menu"><span class="opts-gear">${icon('gear')}</span><span class="opts-word"> Menu</span></button>
      <button type="button" id="manage-toggle" aria-expanded="false" aria-controls="manage-menu" title="Close idle agents"><span class="opts-gear"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v7"/><path d="M8.5 9h7v3h-7z"/><path d="M7.5 12h9l2.5 9.5H5z"/><path d="M10 15.5 9.3 21.5"/><path d="M14 15.5l.7 6"/></svg></span><span class="opts-word"> Manage</span><span class="foot-count" id="idle-count"></span></button>
      <div id="opts-menu" class="panel-menu" hidden>
        <!-- The gateway's own settings: agents, models, idle reclaim, scope. A page rather than a
             chat command, because the rows need the width a message never had. -->
        <button type="button" id="settings-open" title="Agents, models and conversation settings for this topic"><span>All settings</span></button>
        <button type="button" id="notify-toggle" hidden aria-pressed="false" title="Notify this device when something needs you"><span>Notifications</span><span class="opt-state" id="notify-state">off</span></button>
        <button type="button" id="calm-toggle" aria-pressed="false" title="Running topics stop pulsing and unread counts go grey; a question, a failure or an unread reply still stands out. This device only."><span>Low attention</span><span class="opt-state" id="calm-state">off</span></button>
        <div class="opts-sep"></div>
        <!-- The gateway's managed skills: a surface of its own, not a setting, which is why it
             was a footer button of its own until the row ran out of width. -->
        <button type="button" id="skills-toggle" title="Skills the gateway gives every agent"><span>Skills</span></button>
      </div>
      <div id="manage-menu" class="panel-menu" hidden>
        <button type="button" id="close-idle" hidden title="End the agent process of every topic that is idle — each conversation is kept">Close idle</button>
        <button type="button" id="no-idle" disabled>No idle agents</button>
      </div>
    </div>
    <div id="sidebar-resize" class="panel-resize" title="Drag to resize · double-click for the default width"></div>
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
        <a id="reader-get" download>Download</a>
        <button type="button" class="btn-icon" id="reader-close" title="Close (Esc)" aria-label="Close">&times;</button>
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
        <button type="button" class="btn-icon" id="skills-back" title="Back to all skills" aria-label="Back" hidden>${icon('chevronLeft')}</button>
        <span id="skills-title">Skills</span>
        <span id="skills-count"></span>
        <button type="button" class="btn-icon" id="skills-refresh" title="Refresh skills" aria-label="Refresh skills">${icon('refresh')}</button>
        <button type="button" id="skills-new" title="Create a skill">New</button>
        <button type="button" class="btn-icon" id="skills-close" title="Close (Esc)" aria-label="Close">&times;</button>
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
          <span id="task-title">Task</span>
          <span id="task-sub"></span>
        </div>
        <button type="button" class="btn-icon" id="task-close" title="Close (Esc)" aria-label="Close">&times;</button>
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
          <span id="settings-title">Settings</span>
          <span id="settings-topic"></span>
        </div>
        <button type="button" class="btn-icon" id="settings-close" title="Close (Esc)" aria-label="Close">&times;</button>
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
        <button type="button" class="btn-icon" id="files-tree-toggle" title="Files" aria-label="Show the file tree">${icon('menu')}</button>
        <span id="files-title">Files</span>
        <span id="files-where"></span>
        <button type="button" class="btn-icon" id="files-refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
        <button type="button" class="btn-icon" id="files-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div id="files-body">
        <aside id="files-tree" aria-label="Files">
          <div id="files-tree-head">
            <button type="button" id="files-new-file" title="New file">New file</button>
            <button type="button" id="files-new-dir" title="New folder">New folder</button>
          </div>
          <div id="files-new-row" hidden>
            <input id="files-new-name" type="text" autocomplete="off" placeholder="name" aria-label="Name">
            <button type="button" id="files-new-go">Create</button>
            <button type="button" id="files-new-cancel">Cancel</button>
          </div>
          <div id="files-tree-list"></div>
          <div id="files-hits" hidden></div>
        </aside>
        <div id="files-main">
          <div id="files-crumbs"></div>
          <div id="files-search-row">
            <input id="files-q" type="search" autocomplete="off" placeholder="Search by file name" aria-label="Search by file name">
            <button type="button" id="files-q-go" title="Search" aria-label="Search">${icon('search')}</button>
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
              <button type="button" id="files-reload">Reload from disk</button>
              <button type="button" id="files-overwrite">Overwrite</button>
              <button type="button" id="files-cancel">Cancel</button>
            </div>
          </div>
          <div id="files-actions">
            <button type="button" id="files-save" disabled>Save</button>
            <button type="button" id="files-preview-toggle" hidden>Preview</button>
            <button type="button" id="files-rename-open" disabled>Rename</button>
            <button type="button" id="files-delete" disabled>Delete</button>
            <span id="files-dirty" hidden>Unsaved changes</span>
          </div>
          <div id="files-rename-row" hidden>
            <span id="files-rename-what"></span>
            <input id="files-rename-name" type="text" autocomplete="off" aria-label="New name">
            <button type="button" id="files-rename-go">Rename</button>
            <button type="button" id="files-rename-cancel">Cancel</button>
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
        <span id="git-title">Changes</span>
        <span id="git-branch"></span>
        <div id="git-modes" role="tablist" aria-label="Compare">
          <button type="button" class="git-mode on" data-gm="working">Working</button>
          <button type="button" class="git-mode" data-gm="branch">Branch</button>
          <button type="button" class="git-mode" data-gm="committed">Committed</button>
          <button type="button" class="git-mode" data-gm="commits">Commits</button>
        </div>
        <select id="git-base" title="Compare against this branch" aria-label="Compare against this branch" hidden></select>
        <span id="git-spacer"></span>
        <button type="button" id="git-layout" title="Switch between one column and two" hidden>Split</button>
        <button type="button" class="btn-icon" id="git-refresh" title="Refresh changes" aria-label="Refresh changes">${icon('refresh')}</button>
        <button type="button" class="btn-icon" id="git-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div id="git-body">
        <div id="git-files"></div>
        <div id="git-pane">
          <div id="git-note" hidden role="status"></div>
          <div id="git-sel" hidden><span id="git-sel-what"></span><button type="button" id="git-comment-open">Comment</button></div>
          <div id="git-diff"></div>
          <div id="git-comment" hidden>
            <div id="git-comment-what"></div>
            <textarea id="git-comment-text" placeholder="What about these lines?" aria-label="Comment"></textarea>
            <div id="git-comment-acts">
              <button type="button" id="git-comment-cancel">Cancel</button>
              <button type="button" class="primary" id="git-comment-add">Add to message</button>
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
  <div id="row-menu" role="menu" aria-label="Row actions" hidden></div>
  <!-- "Close idle agents", confirmed against the list it will act on (openIdle), then showing what
       happened to each. -->
  <div id="idle-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="idle-title">
    <div id="idle-box">
      <div id="idle-title"></div>
      <p id="idle-why">Each conversation is kept: the next message in a topic starts its agent again where it left off.</p>
      <ul id="idle-list"></ul>
      <div class="idle-acts">
        <button type="button" id="idle-cancel">Cancel</button>
        <button type="button" id="idle-go">Close agents</button>
      </div>
    </div>
  </div>
  <section id="chat">
    <div id="chat-header">
      <button type="button" class="btn-icon" id="expand-sidebar" title="Show topics" aria-label="Show topics" hidden>${icon('menu')}</button>
      <span id="topic-title" class="chat-title"></span>
      <!-- A conversation opened from the History tab: its title, and the word that says what it is.
           Separate from #topic-title, which every topics event rewrites for the topic underneath. -->
      <span id="lib-title" class="chat-title"></span>
      <span id="lib-tag" class="chat-status" title="A conversation from History, read-only">${icon('history')}<span class="lib-tag-word">History · read-only</span></span>
      <!-- /kill, one tap away. Beside the title rather than beside Send because it is about the
           topic — the process behind it — and not about the message being written; shown only
           while there is a process to end, which is the same fact the sidebar dot is lit by.
           An SVG rather than U+23FB: that glyph only arrived in Unicode 9, not every system font
           carries it, and where it is missing it renders as an empty box — which nobody presses. -->
      <button type="button" class="btn-icon" id="kill-agent" hidden
        title="End the agent process — the conversation is kept, and the next message resumes it (/kill)"
        aria-label="End the agent process"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"
        stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path
        d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg></button>
      <span id="topic-status" class="chat-status"></span>
      <!-- Present in the markup but hidden unless the daemon serves a terminal, so the script
           has one thing to reveal rather than one thing to build. -->
      <button type="button" class="btn-icon" id="term-toggle" title="Terminal" aria-label="Terminal" hidden>${icon('terminal')}</button>
      <!-- The file window: the files of whichever machine this topic's agent runs on. Built in the
           markup and hidden, like the terminal's button, so the script reveals one thing rather
           than constructing one; it is revealed only when platforms.<id>.files is enabled. -->
      <button type="button" class="btn-icon" id="files-toggle" title="Files on this topic's machine" aria-label="Files" hidden>${icon('folder')}</button>
      <!-- Always present, unlike the terminal's: the task panel is the only place on this page
           where scheduled tasks are managed. A clock rather than an emoji for the same reason
           the power button is an SVG — it has to sit on the header's text baseline. -->
      <button type="button" class="btn-icon" id="schedules-toggle" aria-expanded="false" aria-controls="schedules" title="Side tasks" aria-label="Side tasks"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span class="sched-alert" id="sched-alert" hidden></span></button>
      <!-- The repository the topic's directory sits in: what changed, and one file's diff. Read
           only — committing stays in the conversation, where the agent can be asked what it meant. -->
      <button type="button" class="btn-icon" id="git-toggle" title="Changes in this directory" aria-label="Changes">${icon('git')}</button>
    </div>
    <!-- A fork's source (Topic.forkOf), and the way back to it. Above the transcript, which is empty
         at first: the fork holds the agent's context, not the messages. -->
    <button type="button" id="fork-note" hidden></button>
    <div id="log"></div>
    <!-- A conversation from the History tab, in the transcript's place (openLib). Its own element
         rather than #log: the topic underneath keeps its stream, its messages and its place, and is
         simply shown again when this closes. Drawn with the same bubbles as #log. -->
    <div id="lib-log" aria-label="Recorded conversation"></div>
    <!-- Where the composer was: why nothing can be sent here, and the ways out. The note says what
         the store's bound left out, and sits here because this is where the reader lands. -->
    <div id="lib-bar" role="status">
      <div id="lib-note" class="hist-note" hidden></div>
      <div class="lib-ro">
        <span id="lib-why"></span>
        <span class="lib-acts">
          <button type="button" id="lib-topic" hidden>Open the topic</button>
          <button type="button" id="lib-close" title="Back to the conversation you were in">Close</button>
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
      <div id="update" role="status" hidden>fleetherd was updated while this page was open. <button type="button" id="update-reload">Reload</button></div>
      <div id="machine-note" role="status" hidden></div>
      <div id="status" hidden title="Tap for details"></div>
      <!-- The answer to a side question (/btw), read here rather than in the transcript (openBtw). -->
      <div id="btw" hidden role="dialog" aria-labelledby="btw-q">
        <div class="btw-head">
          <span class="btw-tag">btw</span>
          <div id="btw-q"></div>
          <button type="button" class="btn-icon" id="btw-close" title="Close (Esc)" aria-label="Close">&times;</button>
        </div>
        <div id="btw-body"></div>
      </div>
      <!-- The model switch's list, opened from the model in the status line (openModelPop), and the
           same list for one of the agent's own settings (openOptPop). -->
      <div id="model-pop" hidden role="dialog" aria-labelledby="mp-heading">
        <div class="mp-head">
          <div class="mp-title"><b id="mp-heading">Model for this topic</b><span id="mp-agent"></span></div>
          <button type="button" class="btn-icon" id="mp-close" title="Close (Esc)" aria-label="Close">&times;</button>
        </div>
        <input id="mp-filter" type="text" placeholder="Filter models" aria-label="Filter models" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div id="mp-list" role="listbox" aria-labelledby="mp-heading"></div>
        <p class="mp-foot" id="mp-foot"></p>
      </div>
      <div id="hints" hidden></div>
      <div id="chips"></div>
      <form id="composer">
        <div id="row">
          <textarea id="input" rows="1" placeholder="Message" autocomplete="off"></textarea>
          <input id="picker" type="file" multiple hidden>
          <button type="button" id="attach" title="Attach a file">+</button>
          <!-- A voice message: tap to record, tap again to send it on its own. Hidden where the
               browser cannot record (no MediaRecorder, or an insecure origin, where
               navigator.mediaDevices does not exist at all). -->
          <button type="button" id="mic" title="Record a voice message" aria-label="Record a voice message" hidden>${icon('mic')}</button>
          <!-- /stop, while there is a turn to stop. Beside Send because that is where the eye
               already is while a reply streams in, and separate from it because the composer
               still sends mid-turn (into the running turn, or queued behind it) — neither of
               which is "stop". -->
          <button type="button" id="stop-turn" title="Stop what the agent is doing — the conversation is kept (/stop)" hidden>Stop</button>
          <!-- A tooltip is a pointer's affordance, so it names the pointer's shortcut: under the
               narrow-screen layout Enter writes a newline, but nothing there can hover to read
               this. Ctrl-Enter sends on both and is what that layout's users are left with. -->
          <button type="submit" title="Send (Enter)">Send</button>
        </div>
      </form>
    </div>
    <!-- The panel's divider, dragged like the side panel's. Only on screen while the panel is,
         and never when the daemon serves no terminal at all: it is a control, not decoration. -->
    <div id="term-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panel" aria-controls="term" title="Drag to resize · double-click for half the screen" tabindex="0"></div>
    <!-- A panel, not a mode: the bar is what makes minimize and close two different things.
         The dash hides it and leaves the session connected; the cross ends the session, and is
         rendered only where the daemon was given a way to do that. Below the composer, so the
         transcript and the place you type are both above it and neither is covered. -->
    <div id="term">
      <div id="term-bar">
        <span id="term-name" class="term-name"></span>
        <button type="button" class="btn-icon" id="term-min" title="Minimize — the terminal keeps running">&#8211;</button>
        <button type="button" class="btn-icon" id="term-end" title="End this terminal session" hidden>&times;</button>
      </div>
      <div id="term-frames"></div>
    </div>
  </section>
  <!-- The side panel: the same .panel as the sidebar, on the right. A column of its own on a wide
       screen and a drawer below 1024px; the stylesheet decides which of the two it is from the
       width, and .collapsed is what moves it off-screen either way. Outside #chat because it is
       about the gateway, not about the topic being read. -->
  <aside id="schedules" class="panel panel-right" aria-label="Side tasks">
    <!-- The docked panel's width, dragged like the sidebar's. Not offered below 1024px, where
         the panel is a drawer and the screen decides its width. -->
    <div id="sched-resize" class="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize · double-click for the default width"></div>
    <div id="schedules-head" class="panel-head">
      <div class="sched-heading">
        <span class="panel-title">Side tasks</span>
        <span id="schedules-summary" class="sched-summary"></span>
      </div>
      <!-- The Sessions tab's one bulk action, as the topic list has it beside its title. Shown only
           on that tab: it marks runs read, and over Tasks or Reviews it would name nothing listed. -->
      <button type="button" class="btn-icon" id="sched-read" title="Mark all read" aria-label="Mark all read" disabled hidden>${icon('done')}</button>
      <!-- The Tasks tab's one action of its own: a new task, on the same form an edit uses
           (openNewTask). Shown only there, as Mark all read is only on Sessions. -->
      <button type="button" class="btn-icon" id="sched-new" title="New task" aria-label="New task" hidden>${icon('plus')}</button>
      <button type="button" class="btn-icon panel-close" id="schedules-close" title="Close (Esc)" aria-label="Close">&times;</button>
    </div>
    <div id="sched-subnav" class="sched-subnav" role="tablist" aria-label="Tasks and sessions">
      <button type="button" class="sched-subtab on" id="sched-tab-tasks" role="tab" aria-selected="true" aria-controls="schedules-list">Tasks <span class="sched-count" id="sched-tab-tasks-n"></span></button>
      <button type="button" class="sched-subtab" id="sched-tab-sessions" role="tab" aria-selected="false" aria-controls="sched-sessions">Sessions <span class="sched-count" id="sched-tab-sessions-n"></span><span class="sched-tab-alert" id="sched-sessions-alert" hidden></span></button>
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
    <div id="sched-tabs" class="panel-foot" role="tablist" aria-label="Side tasks and reviews">
      <button type="button" class="sched-tab on" id="sched-tab-scheduled" role="tab" aria-selected="true" aria-controls="schedules-body">Scheduled <span class="sched-count" id="sched-tab-scheduled-n"></span><span class="sched-tab-alert" id="sched-tab-alert" hidden></span></button>
      <button type="button" class="sched-tab" id="sched-tab-reviews" role="tab" aria-selected="false" aria-controls="sched-reviews">Reviews <span class="sched-count" id="sched-tab-reviews-n"></span></button>
    </div>
  </aside>
</main>
`;
