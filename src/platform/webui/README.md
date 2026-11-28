# `src/platform/webui/` — the built-in web UI

A browser chat page the daemon serves itself, wired in as a ninth platform. No account, no
bot token, no upstream service: `fleetherd start`, open the page, type.

It exists because every other way into this gateway needs a chat platform configured first.
When there isn't one — or when a browser is simply the place you want to be — this is the
door.

## The one structural decision

**It is not a Satori adapter, and it does not use the profile seam.**

Every other platform is assembled by [`satori-core.ts`](../satori-core.ts) from a
`PlatformProfile`, and that assembly is built around a Satori `Bot`: resolve one, call
`bot.sendMessage`, normalise a `Session` into an `InboundMessage`, delegate the platform's
differences to the profile. Here the daemon owns both ends of the conversation. There is no
bot, no gateway, no session. Forced through the seam, every profile method would be a stub
around state this module holds anyway.

So it implements [`PlatformAdapter`](../adapter.ts) directly, which is all `daemon/` ever
sees. `platform-factory.ts` dispatches on `type === 'webui'` before it reaches `PROFILES`,
and that map is typed `Record<Exclude<PlatformType, 'webui'>, …>` so the next Satori platform
still fails to compile until it is listed. The shape is a sibling implementation of the
interface, not a pretend member of a protocol it does not speak.

### What bypassing `satori-core` costs

Everything `satori-core` does for *every* platform has to be done again here, and the failure
mode of forgetting one is silence rather than an error. Each is re-implemented with a comment
naming it, and they are all of them:

| What | Where it is here | What its absence would look like |
|---|---|---|
| `chat.channels` listen allowlist | `room.ts` `channelAllowed` | The config field parses and does nothing |
| The `[in]` log line | `room.ts` `submit` | Inbound traffic invisible in the log |
| Connection logging | `room.ts` `subscribe`, `server.ts` `announce` | No way to tell "nobody is watching" from "nothing was sent" |
| `measureRendered` | `index.ts` — identity | Replies chopped at a third of the stated limit |
| Typed outbound failures | `room.ts` `mustFind` | An edit to an evicted message succeeds silently and its text is lost |

## Files

| File | Role |
|---|---|
| `index.ts` | The `PlatformAdapter`: capability declaration + the outbound methods |
| `room.ts` | The conversations — per-topic message rings, subscribers, the hold queue, both directions of traffic. No HTTP. |
| `topics.ts` | The topic list and its file. Shaped like `daemon/workdir-usage.ts`. |
| `server.ts` | `node:http`: routes, auth gate, SSE, upload, download, the upgrade gate, shutdown |
| `auth.ts` | Shared-secret login, session cookies, brute-force throttle |
| `sso.ts` | The other door: an RS256 assertion from the proxy in front, verified against its JWKS |
| `terminal-proxy.ts` | Byte-for-byte reverse proxy to the terminal's ttyd over a unix socket. Speaks no WebSocket. |
| `terminal-sessions.ts` | The bookkeeping either side of those bytes: who is attached, and the operator's command for ending a session |
| `protocol.ts` | `.strict()` zod schemas for every inbound body; the outbound event union |
| `reading.ts` | Which files the page can read in place, and the HTML it is given for one. Pure. |
| `codeview/` | The CodeMirror bundle the page loads on demand: the editor and the diff — see [The code view](#the-code-view) |
| `assets.ts` | Where the built assets are, and the three names the page links: its script, its stylesheet, the code view's entry |
| `page.ts` | The page's HTML shell: head, gate, the `boot-config` JSON, and the links to its script and stylesheet |
| `page-body.ts` | The page's markup — every element the script finds by id — as a template |
| `page-body.ts` | Minimal body shell (`#workbench-root`) paired with the login gate in `page.ts` |
| `client/main.ts` | Typed client entrypoint wiring `WorkbenchShell`, `ContributionRegistry`, `PluginManager`, all 12 built-in plugins, SSE stream, cache, and reads, bundled into `dist/webui-assets/app-<hash>.js` — see below |
| `client/base/` | Typed foundation primitives: `lifecycle.ts` (`DisposableStore`, `MutableDisposable`), `event.ts` (`Emitter`), `html.ts` (`lit-html` re-exports + `escapeHtml`), `dom.ts` (disposable listeners, focus/class/attr/ResizeObserver helpers) |
| `client/services/` | Typed client services: `boot.ts`, `storage.ts`, `store.ts`, `commands.ts`, `keybindings.ts`, `overlays.ts` (LIFO Esc stack), `api.ts` (`post`/`text`/`wait`/`sendLimit`), `stream.ts` (SSE lifecycle, backoff, parking, watchdog, `applyTopicRows`), `cache.ts` (two-layer memory + IndexedDB transcript cache wrapping `CACHE_CORE`), `reads.ts` (unread watermarks, `aa_reads` persistence/merging, `markAllRead`, `reportSeen`) |
| `client/components/` | Reusable accessible `lit-html` + `--fh-*` workbench UI component library (only imports `base/`, `services/`, `i18n/`): `list/` (grouped list, keyboard nav, row `⋯` menu, empty state, multi-select), `filterbar/` (search, pinned/panel chips, sort, persistence, i18n), `actionbar/`, `tabs/` (permanent tab strip + `nav`/`value` segmented control), `menu/` (fixed viewport-clamped context menu + `OverlayManager`), `dialog/` (focus-trapped modal & async confirm dialog), `sheet/` (mobile bottom action sheet), `quickpick/` (live fuzzy filter & grouped picker), `form/` (field rows, text input, switch, select, value segmented, grouped list, radio group), `tree/` (collapsible keyboard-navigable tree), `badge/` (capsule badge, harness/status tag, pulsing status dot), `notice/` (`Notice` & `EmptyState`), `splitter/` (pointer/keyboard resize handle), and barrel `index.ts` |
| `client/workbench/contracts.ts` | Frozen `DockEngine`, `PanelComponent`, `PanelRef`, and `LayoutState` (v1) contracts |
| `client/workbench/dock/` | Dynamic & static dock engines: `splitview.ts` (pure 1D size math + pointer-drag `SplitView`), `gridview.ts` (binary row/column editor group tree + split/merge/normalize), `group.ts` (`EditorGroup` with single-tab titlebar / multi-tab strip, reorder, dirty dot), `dnd.ts` (pointer-event `DockDndController` with ghost, drop zones, Esc cancel, `allowSplit`), `serialize.ts` (`LayoutState` v1 validation, migration, missing-component pruning, `aa_layout` persistence), `engine.ts` (`DynamicDockEngine` implementing `DockEngine` + `onDidActiveTopicChange`), `layout-commands.ts` (17 layout commands, shortcuts, and `buildMoveViewMenuItems`), and `static.ts` (legacy P1 static engine) |
| `client/workbench/parts/` | Workbench layout parts: `activity-bar.ts` (52px left nav rail with SVG icons & badges), `sidebar-part.ts`, `secondary-part.ts`, `panel-part.ts` (resizable bottom panel; each with header `⋯` move-view menu trigger and tab context menu), and `status-bar.ts` (22px left/right aligned status bar) |
| `client/workbench/mobile-drawer.ts` | `< 640px` mobile drawer gesture controller (left-edge swipe open, swipe-back close, and `popstate` back-gesture dismiss) |
| `client/workbench/shell.ts` | Default `WorkbenchShell` (`mountWorkbench`, `attachRegistry`) backed by `DynamicDockEngine`, auto-loading/saving `aa_layout` with corrupt-state fallback, wiring `registerLayoutCommands`, part-header `buildMoveViewMenuItems`, `onDidActiveTopicChange`, and three width breakpoints (`≥ 1024px` desktop with `< 640px` editor auto-collapse/restore, `640–1023px` tablet drawers with `setAllowSplit(false)`, `< 640px` mobile slide-out drawer reusing the workbench shell) |
| `client/plugins/api.ts` | Frozen `WebuiPlugin`, `definePlugin`, `PluginContext`, `MenuItem`, `TopicInfo`, and `WebuiEvents` contracts |
| `client/plugins/registry.ts` | `ContributionRegistry` (views, editors, topicTools, activity, statusBar, commands, menus, device-only settings), `WebuiEventBus`, `PluginI18nRegistry`, external-plugin API path allowlist/traversal guard (`assertPluginApiPath`), and unified `createPluginContext` factory |
| `client/plugins/host.ts` | `PluginManager` lifecycle host: registration, async `activate`/`deactivate`, per-plugin error isolation with partial-registration rollback and status-bar error reporting, and automatic `DisposableStore` cleanup |
| `client/plugins/builtin.ts` | Built-in plugin manifest (`BUILTIN_PLUGIN_IDS`, `createBuiltinPlugins`, `createDefaultBuiltinPluginFactories`, `registerBuiltinPlugins`) wiring all 12 built-in feature plugins |
| `client/features/topics/` | Built-in `topics` plugin (`plugin.ts`, `index.ts`, `age.ts`, `tree.ts`, `row-render.ts`, `filter-bar.ts`, `row-menu.ts`, `row-sheet.ts`, `gestures.ts`, `prefetch.ts`, `idle-dialog.ts`, `types.ts`): activity bar item, primary sidebar topic list, tree/folding, filter bar, row menu, mobile left-swipe/long-press gestures and action sheet, prefetch queue, and close-idle dialog |
| `client/features/topic/` | Built-in `topic` plugin (`plugin.ts`, `editor/{index,dom,header,panel,types}.ts`, `status/`, `transcript/`, `composer/`): per-topic editor panel with header, transcript, `/btw` card, model/option switcher, status strip, and composer (attachments, image shrink, drafts, voice, slash hints, unsent queue) |
| `client/features/history/` | Built-in `history` plugin (`plugin.ts`, `view.ts`, `editor.ts`, `helpers.ts`): conversation library sidebar view and read-only transcript editor |
| `client/features/schedules/` | Built-in `schedules` plugin (`plugin.ts`, `store.ts`, `view.ts`, `editor.ts`, `helpers.ts`, `types.ts`): scheduled Tasks/Sessions sidebar view and task detail/edit/create editor |
| `client/features/reviews/` | Built-in `reviews` plugin (`plugin.ts`, `store.ts`, `view.ts`, `editor.ts`, `types.ts`): auto-review sidebar view, review detail editor (`review`), and pending preference suggestions editor (`review-prefs`) with Adopt/Dismiss |
| `client/features/skills/` | Built-in `skills` plugin (`plugin.ts`, `store.ts`, `view.ts`, `editor.ts`, `filtering.ts`, `new-dialog.ts`, `types.ts`): managed skills sidebar view and `SKILL.md` / file / history editor |
| `client/features/settings/` | Built-in `settings` plugin (`plugin.ts`, `controller.ts`, `render.ts`, `workbench-catalog.ts`, `workbench-editor.ts`, `workbench-instructions.ts`, `workbench-types.ts`, `types.ts`): gateway `/setting` editor, device-only settings, and instructions editor |
| `client/features/changes/` | Built-in `changes` plugin (`plugin.ts`, `changes-tool.ts`, `diff-editor.ts`, `diff-view.ts`, `diff-helpers.ts`, `types.ts`): topic-scoped secondary sidebar git/commits changes list and diff editor with line comments |
| `client/features/files/` | Built-in `files` plugin (`plugin.ts`, `files-tool.ts`, `file-editor.ts`, `helpers.ts`, `types.ts`): topic-scoped secondary sidebar file tree and CodeMirror/Markdown file editor |
| `client/features/terminal/` | Built-in `terminal` plugin (`plugin.ts`, `index.ts`): per-topic embedded ttyd terminal in the workbench bottom panel |
| `client/features/reader/` | Built-in `reader` plugin (`plugin.ts`, `index.ts`): on-demand CodeMirror loader (`createCodeViewLoader`), image lightbox, and document reader editor |
| `client/features/status/` | Built-in `status` plugin (`plugin.ts`, `device-settings.ts`, `idle-dialog.ts`, `notify-bridge.ts`, `topics-stats.ts`, `i18n.ts`, `icons.ts`, `types.ts`): status bar items (connection, running/idle agents, plugin errors, notifications, low attention, language, theme, version) |
| `client/features/notify/index.ts` | Web Push subscription controller (`createNotifyController`), VAPID key decoding, permission/toggle flow, and Service Worker `message` listener (`cached` → `cacheService.noteVersion`, `goto` → topic switch) |
| `client/features/palette/` | Built-in `palette` plugin (`plugin.ts`, `format.ts`, `keybindings-dialog.ts`): `Mod+K` topic quick-open, `Mod+Shift+P` command palette, and `Mod+/` keyboard shortcuts overview |
| `client/plugins/lazy-extras.ts` | On-demand ESM loader (`workbench-extras-<hash>.js`) and lightweight shells for lower-frequency built-in plugins (`history`, `schedules`, `reviews`, `skills`, `settings`, `changes`, `files`, `reader`, `palette`) to keep `app-*.js` gzip under 160 KiB |
| `client/styles/main.css` | Stylesheet entrypoint importing `tokens.css` (default VS Code Dark Modern / Light Modern `--fh-*` semantic tokens and legacy aliases), 18 modular CSS files (`components`, `base`, `layout`, `topics`, `terminal`, `schedules`, `reviews`, `git`, `history`, `skills`, `transcript`, `settings`, `composer`, `overlays`, `status`, `files`, `responsive`, `workbench`), and `workbench-theme.css` (global §4.2 control/shape/typography/scrollbar rules) in cascade order, bundled into `dist/webui-assets/style-<hash>.css` |
| `manifest.ts` | The web app manifest and the icon, as strings, for the same reason `page.ts` is a module |
| `icons.ts` | The page's icons, hand-drawn inline SVG, and which emoji each one replaces — see [Icons](#icons) |
| `webpush.ts` | Web Push, server half: the VAPID key, the subscribed devices, RFC 8291 encryption, the endpoint allowlist |
| `sw.ts` | The service worker (`sw.js`) as a string: shows a push, keeps the push's topic in the transcript cache, opens the topic when it is tapped — and nothing else |
| `cache-script.ts` | The transcript cache's database, record and rotation, as script both the client script and `sw.ts` include, so its two writers cannot disagree on the format |
| [`../web-markdown.ts`](../web-markdown.ts) | Markdown → escaped HTML; lives with the other converters |

`room.ts` is deliberately free of HTTP so the adapter's behaviour is testable without opening
a port — which is what `room.test.ts` and `index.test.ts` do.

**The client script and stylesheet were inline in `page.ts` until Phase 1 Step 1A of
[the refactor plan](../../../docs/refactor-plan.md)**, and were moved to `client/` as they were.
So wherever this README names a script function or a CSS rule as `page.ts`'s — `codeView()`,
`menu()`, `.b .raw` — read `client/main.ts` (and the typed modules it wires under `client/`) or `client/styles/` (imported by `main.css`). Both are bundled by
`scripts/webui-client.mjs` (called by `scripts/build-webui-assets.mjs`, and by the tests), linked
from the page by content-hashed name, and served by `GET /assets/<file>`. What the server decides
per deployment reaches the script as `<script type="application/json" id="boot-config">` — read
once into `BOOT` (including `version`, the package version rendered as `v<version>` in the status
bar and mobile More view) — instead of being spliced into its text, which is what let the CSP drop
`script-src 'unsafe-inline'`. Two build-time markers remain in the script (`clientIcons()` and
`CACHE_CORE`, filled by `webui-client.mjs`); the build fails if either is missing.

## Topics

A topic is a LANE on the one channel: `{ channel: 'main', thread: '<topic id>' }`. Each is its
own conversation, with its own agent session and its own harness-generated name — the shape a
Telegram forum topic or a Feishu 话题群 has, in a browser.

**A lane rather than a channel of its own, and that is not arbitrary.** Both would give
separate conversations: `conversationKey` under the default `per_thread` scope is
`platform#channel#thread`, so either varying part separates them. The difference is naming.
`retitleLane` refuses any address with no lane, so `capabilities.renameThread` is only ever
true for a lane — a channel-per-topic design would have left the automatic naming permanently
inert, and that naming is half of what makes topics worth having.

**`kind` stays `'direct'` even though a lane is set, and this one is a trap worth knowing
about.** `shouldRespond` (`core/inbound-gate.ts`) answers a DM at step 3 and only reaches its
mention requirement at step 6. A `kind: 'thread'` message that is not a DM, has no active
session yet, and carries no @ falls through to that step — and `chat.requireMention` defaults
to true, so **the first message in every new topic would be silently dropped**. `'direct'`
short-circuits before that while `conversationKey` still separates by lane and `retitleLane`
still works. A DM that has lanes is a shape the gateway already knows: a Telegram DM topic.

**Ids are hex and may not contain `/`.** A topic id travels as the lane half of `main/<id>`,
which `parseAddress` splits on `/` and refuses to see twice — so an id with one in it would
break `--channel` and the `chat.channels` allowlist far from here. `protocol.ts` rejects the
wrong shape at the request boundary.

**Message ids are global and never reused**, not per topic. The outbound pacer coalesces edits
into `edit:<channel>:<messageId>` and every topic shares the one channel, so an id restarting
per topic would let one topic's edits supersede another's. They used to share one rate-limit budget
for the same reason — the pacer keys on the channel, as it must for a Telegram forum — and that is
what made a menu tap in a quiet topic wait 1–7 s while other topics streamed. `paceByLane` (2.14.0)
gives each topic its own; nothing at this end counts writes, so the lane is the right unit here.

**The topic list is persisted, and so is each topic's transcript.** Losing the
list is not "the page looks empty": `conversations.json` still holds the agent binding and session
id under `<instance>#main#<topic id>`, so every context would still be running and no longer
reachable. See `topics.ts` for why its `title` duplicates one the daemon also stores. The *browser*
keeps a rotating copy of the transcripts ([below](#the-local-transcript-cache)), and nothing here
reads that cache back; the daemon keeps its own ([below](#every-topic-keeps-its-transcript)).

**Neither the per-topic `×` nor "Clear all topics" ends an agent session.** Both reach exactly as
far as this module: the room goes, the list entry goes, and the daemon's binding under
`<instance>#main#<topic id>` stays behind — it is a list being cleared, not sessions being killed.
The sweep exists because a restart leaves a sidebar full of rows that open onto nothing (see
`stale` below), and deleting a dozen of those one at a time is not a feature.

**Past 200 topics the oldest one goes, unless something is holding on to it.** `topics.ts` used to
refuse past the ceiling outright, on the grounds that evicting a topic orphans its session. In use that
reached the cap (a new-session scheduled task adds a topic per run), after which `+` did
nothing at all — the 409 never reached the screen — and every scheduled run fell back to posting
into the chat. Orphaning costs exactly what a `×` costs, which people press all the time; so now
`WebRoom.createTopic` evicts the least recently active topic first (`makeRoom`), logging its id and
title, since that line is the only way left to find the session it leaves behind.

A topic is passed over when evicting it would *break* something rather than merely orphan it:
mid-turn, asking a question, an agent resident, a terminal attached, or the target of a scheduled
task that can still run (`WorkbenchHost.useScheduleLookup` — a task posts to a plain address and
nothing rewrites it when the topic goes). Otherwise the only thing that keeps a quiet topic is a
**star** (☆ beside the `×`). A starred topic is never evicted, survives "Clear all topics" (which
says "Clear unstarred topics" while any are starred), and leads its unstarred peers inside its
state in the list. The `×` still deletes
it: a star defers to the operator, not the other way round, and the confirmation says "starred".
When every topic is starred or busy, `+` is refused, and the page shows the daemon's sentence
saying so rather than doing nothing.

The star is persisted beside the title, and only when true — a topic file from before stars, or
from someone who never uses them, is unchanged. The page sends `{ starred: true|false }`, never a
toggle, because `post` retries a dropped request and a retried toggle would flip back.

**One-step topic setup (`POST /api/topics` and `POST /api/topics/setup`).** `POST /api/topics`
accepts optional `{ agent?, cwd? }` to create a topic and bind its agent and working directory in
one request (rolling back the newly created topic if setup fails). On an already-created empty topic
before the first message, `POST /api/topics/setup` takes `{ topic, agent?, cwd? }` and applies the
binding directly through the daemon without posting `/agent` or `/cd` commands into the transcript.
The new-topic launcher pairs `POST /api/topics/setup` with `GET /api/topics/workdirs` so users can
switch agents in place and browse/pick a working directory inline (using `/cd`'s one-level
breadcrumbs/up/filter picker) on the same page before sending the first message, while the status
line immediately exposes the chosen agent's model and settings switches.

### Every topic keeps its transcript

Since 2.13.0 every topic's transcript is on disk; from 2.5.0 to then, only a starred one's was.
Before 2.5.0 none was: a restart emptied every room, and the browser's cache, which was meant to
cover that, can only give back what that browser received. Two reports moved this, a week apart:

- **2026-10-24: a starred topic.** Two starred topics came back empty after the container was
  rebuilt, on an instance with 64 topics. The cache holds the 24 topics most recently written in that
  browser, so a topic starred because it matters and opened once a week is exactly the one it has let
  go of — and a phone that never opened it has nothing at all. 2.5.0 had the daemon keep starred
  topics itself.
- **2026-10-31: the end of a turn.** A phone was put down at 13:03, mid-turn; the reply finished at
  13:04; an update came at 13:11. The page came back stopped at a tool line still running, in a
  topic nobody had starred. A page that has gone quiet hears nothing more, so whatever the agent said
  after that existed only in the daemon's memory — not a rare case on a phone, which goes quiet the
  moment it is put down, and not one a star could have helped: nobody stars a topic in case they put
  their phone down. Nothing was cut off; the agent had the reply in its context and gave a summary
  when asked. What was lost was the reply itself, on screen.

`room.ts` writes every topic's ring through a `TranscriptStore` (`index.ts`:
`webui-transcripts-<id>/<topic>.json`, `0600` in a `0700` directory, written to a temporary name and
renamed) and `useTranscripts` reads them back before anything can attach. Decisions in it:

- **Every topic, not only starred ones.** The 2.5.0 argument against this was cost: rewriting every
  topic's ring on every streamed edit. But the write is paid per topic that is *changing*, and the
  topics changing are the ones being read — a topic nobody speaks in is never written. The disk is
  bounded by the 200 topics times 1000 messages. A star now only keeps a topic from eviction and the
  sweep. Deleting, evicting or sweeping a topic removes its file, and a file whose topic is gone when
  the daemon starts is removed too.
- **Written within 3 s of a change, not 3 s after the last one.** The first change arms the write
  and later ones ride along, so a reply streaming for minutes is on disk every few seconds, and a
  kill mid-reply costs at most that much. `dispose` writes whatever is pending on the way out — but
  the 2026-10-31 case did not need it: the reply had been on disk for seven minutes.
- **Off the event loop, one write per topic at a time** (since 2.47.0). The routine write
  serialises a message at a time and writes it out in batches; one `JSON.stringify` and
  `writeFileSync` of a 1000-message ring held the daemon 28 ms at the median, every three seconds,
  while a long topic streamed. The exit write stays synchronous. A write begun before the exit write
  or a delete finds the topic's fence moved and throws its temporary file away instead of renaming
  over them (`index.ts` explains the ordering); a `.tmp` left by a killed run is removed at start.
- **Each message keeps the run it was said in** (`WebMessage.g`, that run's sync `epoch`), through
  any number of restarts. The page keys a message by `<generation>:<id>`, so this is what lets a
  restored message land on the copy its own cache has rather than beside it — a half-finished tool
  line is brought up to date, and the messages the page never received are added after it, in order
  (`page.dom.test.ts` pins this) — and what makes it history: no buttons, above the divider. Buttons
  are stripped on the server too, since the process that would answer them is gone.
- **The id counter starts past every restored id.** `nextId` restarts at `w1` each run, and the
  ring is a map by id, so a new `w5` would overwrite a kept one.
- **What is kept is what the ring had**: up to 1000 messages. A file the agent sent comes back as
  its name. Its download token died with the old process, so the link answers 404 and a picture
  hides itself, as it does from the browser's cache.

A transcript on disk is agent output, which carries the bytes of whatever the agent read. That is
no wider than the agent's own session files, which hold all of it already, but it is the reason
for the `0600`.

**Each row also says which directory that topic works in**, which is the one thing a title does
not tell you when several topics are open on different projects. It is not stored beside the
title, though, and that asymmetry is deliberate: the title is *this module's* (a topic has one
before a turn has ever run), while the directory is the daemon's and moves under `/cd`, so a
copy here would be a second answer that outlives the real one. The daemon hands the adapter a
lookup instead (`WorkbenchHost.useWorkdirLookup`), and `topicList()` asks it — memoised for
`DIR_TTL_MS`, because the list is rebuilt on every posted message and the lookup stats the
filesystem on the other side. A deployment that never offers one shows no second line at all.

The memo is let go whenever the operator writes or taps in a topic (`submit`, `click`), because
those are the only things that move one — `/agent`, `/cd`, `/new`, a menu pick — and the poll
below compares the label too. Before 2.17.0 neither was true: a move was answered inside the TTL,
the answer's announcement carried the old label, and nothing announced the list after it, so a new
topic that chose an agent on another machine went on naming the default agent's machine until the
next message. Checked in Chromium against a real daemon on 2026-11-02.

The lookup answers with the machine as well as the path (`ConversationWorkdir`), and the row puts it
first: `devbox · workspace`. Two agents of one harness on two hosts usually share a home layout,
so without it their rows were identical and the agent id baked into the title was the only tell.
The name is `core/agent-menu.ts` agentPlaceOf — the agent's `group`, else its `host` — so the row
and the `/agent` menu call a machine the same thing; an agent on the gateway's own machine has none.
It is read off the agent's definition on every lookup rather than stored with the topic, for the
directory's reason: a `/reload` that moves an agent moves where the topic's next turn runs.

**The agent is a legend on the row's frame, not a prefix on its title** (2026-11-20). The stored
name still opens with `[agent] ` (`formatLaneTitle`: a Telegram or Feishu topic name has nowhere
else to say it), and the row used to draw that tag inside the one ellipsised title line, where
`[gemini-task] ` left a few characters of subject in a 240px column. Now every topic row is framed
(`.framed`: a faint border, brighter on the topic on screen) and `agentTagHtml` puts the id on the
frame's top-left edge, its background split at the border line — `--behind`, the colour behind the
row, above it, `--row-bg` below — so the line reads as broken by the name and follows hover, the
selected row and the green needs-you rows by itself. The lists of topic rows (`#topics`, the
Sessions tab's `.sess-group-rows`, a task page's `.tp-topics`) are 6px apart to clear the legend; a task
row has no agent and keeps the plain shape. Which agent comes from the same lookup as the directory
(`ConversationWorkdir.agent` → `Topic.agent`, memoised and polled with it): the binding and its
harness, absent while nothing is bound, where the directory falls back to the default agent's —
fine for a directory, a guess on a label naming who answers. It is the binding rather than the
title's tag because a later `/agent` never rewrites the tag. The harness picks the colour from the
palette the agent cards use (`--hc` on `.h-*`, written once for both). With no `agent` — an agent
gone from config, a daemon without the lookup — the page reads the title's tag instead, uncoloured
(`agentOf`, which the Agent filter and the search use too, so a chip names an agent the way the
legend does). `@host` is dropped when the line below names that machine, the rule the tag had.
The conversation header, the terminal's title and the fork note keep the stored name, tag and all:
they are where the whole name is still read.

**A row's ⋯ takes no room until it shows.** On a pointer device it appears only under the
pointer, and until 2.11.1 the row's buttons were merely `opacity:0` — still in the flex row, so
every title in a 240px column got 129px and stopped in front of a 59px strip of nothing (measured
in Chromium). They now sit in one `.topic-acts` box that floats over the row's right end inside
`@media(hover:hover)`, on a fade into `--row-bg`, the row's own colour, which is why that colour
is a variable. A starred row at rest keeps the box in the layout, because its lit star is content
a title must not run under, and drops its ⋯ from it — the star is a non-interactive marker now.
Touch screens are untouched: no hover, so the control is always on screen, dimmed, and keeps its
room. `page.dom.test.ts` pins the rules as text, since jsdom has no layout; the widths above, and
the title's 188px after, were measured in real Chromium on 2026-10-30, along with where a click
on the button lands once the row is hovered.

**The ⋯ opens one menu for the row: Star/Unstar, Fork, End agent, Delete topic** (2026-11-07; Fork
2026-11-20, below). The two
buttons it replaces could not grow a third, and Delete is too easy to hit at a row's tail. The menu
is one element at the body, `position:fixed` from the button's rect — not inside `#topics`, because
a running agent rebuilds that list with `innerHTML` on every message and a menu in it would vanish
mid-tap. `paintTopics` re-finds the button after a repaint and closes the menu only if its topic is
gone. `role=menu`/`menuitem`, arrow keys/Home/End move between items, Escape closes and returns the
focus, Tab (any move of the focus out) closes it, and a click anywhere else closes it.
**End agent** ends the process behind the topic and the sub-agent topics under it at once
(`useTopicKill` → `Delegation.endTopic`, `/kill`'s rules, not the idle sweeper's); the item says
how many sub-agent processes it reaches, and it is disabled when none of them has a process, with
the reason on its title. There is no second confirmation (2026-11-09): the label already states
the reach, and the header's power button has never asked either. The request carries the list the
page held at the click — the daemon walks the subtree from its own parent record but ends only
the intersection, so a sub-agent opened since is left alone. A running turn is interrupted on
purpose; a runtime that cannot resume leaves its process up, and the page says so in one alert.
The header's power button is unchanged: it ends this topic only.

**A fork sits beside its source, not under it** (`Topic.forkOf`, `/fork`, 2026-11-20). The daemon
opens it through `TopicTree.forkThread` (`adapter.topics`) — `WebRoom.forkTopic` names it after the source, with
` (fork)` — and starts its session as a copy of the source's (daemon/README.md). `topicTree` keeps it
out of the roots while its source is in the same list, and `treeWalker` draws it right after the
source and everything under it, at the source's depth, whether or not the source is folded: folding
hides what an agent opened, and a fork is the person's own. It goes where its source goes — under
a folded parent when the source is a sub-agent's topic, opened like an ancestor when it is the
topic on screen — and is a root when its source is not in the list (a scheduled run's, a filter).
The row leads with a fork mark (`icons.ts` `fork`) whose title names the source and turn; the
topic's page opens with `#fork-note`, the same line, a button back to the source. It is never
`parent`: nothing nests it, reports to it or stops it from the source, and `topics.ts` drops
`forkOf` and `forkTurn` with the source as it drops `parent`. The menu's **Fork** types `/fork` —
through `command()` into the topic on screen, posted without a bubble into another — and is greyed
while that topic runs, which is when the daemon would refuse. It is omitted when the bound agent has
declared no `session/fork` (`Topic.agent.canFork === false`).

**The dot on each row is about the agent, not about the turn.** Four states, and two of them
exist because "a turn is running" turned out to be a bad proxy for both of the things a person
actually reads that column for:

| dot | means | where it comes from |
|---|---|---|
| grey | nothing resident — history, or a topic that will have to resume from a session id | the absence of the two below |
| dim blue | an agent child is up and idle | `WorkbenchHost.useLivenessLookup` |
| blue, pulsing | the agent is working — a turn, or background work reporting in after one | `startTyping` / `stopTyping` (the daemon holds typing for both) |
| amber, pulsing | a question is on screen and nothing moves until it is answered | a message in the room still carrying buttons, posted or re-armed since the operator last wrote |

`asking` is derived HERE rather than asked of the daemon, because the room already holds the
fact: every ask, elicitation round and menu arrives as a message with buttons and is retired by
stripping them. Note that it overlaps `running` rather than replacing it — the turn a question
belongs to is still open, typing and all — so anything rendering this checks `asking` first.

`live` is the one thing in this module that is POLLED (`LIVENESS_POLL_MS`). Everything that
turns it on already announces the list; nothing announces it going off, because an idle reclaim
fires on a timer in a conversation nobody is touching and a crashed child is quieter still. The
poll skips itself while no browser is attached and sends only when a flag actually changed.

**The two stop controls read the same flags as the dot.** The power button beside the title is
shown while `live` and sends `/kill` (end the process, keep the conversation); Stop beside Send is
shown while `running` — `asking` implies it — and sends `/stop` (end the turn, or the background
work reporting in after one). Both post the
typed command through `api/send` with the same nonce, bubble and echo as typing it, so the daemon
has one way to be told, the transcript records the command like any other, and this module gains
no route. They leave the composer alone: a half-written prompt is exactly what someone reaching
for Stop mid-reply has in there. The power button does not wait out the poll to disappear — the
daemon ends the child synchronously before it sends the ack (`answerDaemonCommand`), and the ack
is a posted message, which announces the list.

**"Close idle" ends every dim-blue topic's process at once** (since 2.16.0), from the
sidebar footer's Manage menu; the count is on the Manage button itself, and the item inside is
hidden at zero. Unlike the power button it is
not a typed command, and that is deliberate: a `/kill` per topic would leave an echo and an ack in
every room it touched, twenty messages for ten topics. Instead `POST api/topics/close-idle` carries
the ids, `WebRoom.closeIdle` hands each to the daemon (`WorkbenchHost.useIdleReclaim`), and the
answer says which were closed and which were left running. Four decisions in it:

- **It acts on the list the operator was shown.** The dialog names every topic (title and
  `host · dir`), and those ids are what is posted — a topic that went idle while the dialog was
  open is not included, because nobody confirmed it.
- **Idle is checked twice, and neither check is the page's.** The room skips a topic with a turn
  (`typing`, which also covers a background burst after one) or a question on screen; the daemon
  then applies the idle sweeper's gates (`reclaimIdleForRef` → `reclaimSession`). A topic that
  started working after the list was drawn is skipped, never cut off — `/kill` would stop it.
- **Posted once, not retried.** A retry after a lost answer would find every agent already gone and
  report them all as left running.
- **The result is shown in the dialog**, row by row, not in `#note`: on a phone the drawer covers
  the transcript, and the status line with it. `closeIdle` announces the list, so the dots go grey
  at once rather than at the next liveness poll.

A starred topic is closed like any other: a star keeps a topic from eviction and the sweep, not its
process. Checked end to end on 2026-10-31 against a real daemon with real cc children: of three
resident agents, the two idle ones exited and the one in a 75 s turn finished it untouched, and a
closed topic's next message resumed its conversation.

**The strip above the composer is the agent's live status** — what the footer says once per reply,
kept current: agent, model and effort; a context meter; session cost; claude's prompt-cache
countdown; agy's quota pools. The daemon pushes it (`TopicPresence.setStatus`, from
`daemon/status-board.ts`, which drops repeats and sends at most one per topic per 2 s), and three
things about how it travels are deliberate:

- **It is state, not history.** A `status` event carries no sequence number and never enters the
  backlog, so a busy turn's stream of them cannot push the messages a reconnect needs out of it. A
  full sync carries the current one; a *resumed* stream is handed it after the replay, since none
  of the ones it missed were kept.
- **Times are absolute and the page counts.** The daemon says when a cache expires or a pool
  refills once; `paintStatus` works out "41m" against the browser's clock. Its timer runs only
  while a countdown is on screen and the tab is visible, twice a minute — minutes are the finest
  unit shown — and a repaint that would change nothing writes no DOM.
- **Absent means unknown.** A topic whose agent has not reported since the daemon started has no
  status, and the strip is hidden rather than drawn with zeros. Switching topics clears it until
  the incoming sync says what the new one's is.

By default the strip wraps so active quota pools (5h/wk), cost and cache countdown are never
clipped behind long agent, model or account labels on narrow screens; it shows only the quota
pools the serving model spends from, and on a narrow screen drops the token counts beside the
meter (the percentage says the same). A tap toggles `.open`, revealing the other pools dimmed
and the narrow-screen token counts.

**The model in the strip is a switch** (since 2026-11-05): `/model` as a control. It opens a list
above the composer (`#model-pop`) of what the topic's agent offers, the one in use ticked and the
agent's configured default marked, filtered as it is typed into. Decisions in it:

- **It is `/model`, not a second way to set a model.** `GET api/models?t=` is
  `ConversationRegistry.modelPickerForRef`, which does `/model`'s warm-up (warmModelSelector) — a
  cold agent is started, which is why the list says it is asking — and
  `POST api/models` is `chooseModelForRef`, which is `applyModelChoice`: checked against the list
  the agent offers now, written as the conversation's `modelOverride`. So a typed `/model` afterwards
  names the same model, and config.yaml is untouched; the defaults are the settings page's.
- **A conversation the daemon has not seen is bound as its first message would bind it** — the
  binding, else the route's default — because a model list belongs to an agent. For the same reason
  the switch is not offered in a new, empty topic: the agent launcher is the choice made there first,
  and opening the switch would quietly make it. It is offered the moment that choice is made, which
  `paintStatus` reads off the launcher on screen (`launchEl`), not off `launch` — the sync's snapshot
  of the empty room, which nothing after the tap replaces. Testing that hid the switch until the
  first reply, which was the reported bug (2026-11-05).
- **No transcript line.** The strip and the next reply's footer name the model; a line per switch
  would be noise in exactly the conversation being worked in. The daemon's own sentence goes to
  `#note`, and a refusal stays in the open list.
- **Present without a status.** A topic that has a conversation but no status yet (after a restart)
  shows the switch alone, named "Model", rather than no way to switch at all.
- **The caret is CSS** (`.st-model::after`), so the strip's text is still the model's name.

**The agent's own settings sit beside it** (`optChip`, `openOptPop`): every ACP `select` config option
in a `_` category — the spec leaves those to the agent — gets a switch of the same kind, sharing
`#model-pop` (`mp.opt` is the setting's id, null for the model). A web agent driver uses one for
the account a session runs on. Decisions in it:

- **Generic, and only the custom categories** (`agent-acp.ts` customOptionsOf). The model, effort
  and mode have paths of their own; a reserved category nothing here handles (`model_config`, which
  claude-agent-acp reports) or an option with no category must not grow a button.
- **The agent's state, never the gateway's.** No override is recorded and nothing is re-applied on
  a rebuilt child: the agent keeps its setting across a reload and reports it again. The status
  (`AgentStatus.options`) carries each setting's current value, `fixed` when the agent lists only
  one value (ACP has no "disabled", so that is how a locked setting is said), and the current
  value's description; `POST api/options` is `session/set_config_option`, and a refusal is the
  agent's own sentence, shown in the open list.
- **Present before the first message.** A new topic is when a setting like an account can still
  change, and nothing has reported a status yet. So a line with no status asks
  `GET api/options?peek=1` (`optionStatusForRef`), which never starts this topic's agent — that
  would bind the topic before its first message — and answers from its session if it has one, else
  with the setting names its agent has (`ModelCatalog.options`). For a topic with no session yet the
  catalog may ask on a throwaway session, once per agent per daemon run, as the settings page
  does. Opening a setting (`GET api/options`) is the model list's warm-up. The peek is asked again
  when a message arrives in a topic with no status: `/cd` and `/new` end the session it described.
- **A fixed setting is a disabled button**, dim, no caret, with its reason in the title; the
  setting's name stays in front of the value, so a bare account name is not read as something else.
- **A finger target on a phone**: 32px tall in the workbench — a 24px pill whose transparent 4px
  border above and below is still the button (`composer.css`; `responsive.css`'s 44px rule is
  older and loses to it on specificity). The list spans the composer, and the filter is not
  focused on open, for the reason the composer is not.

Its own Escape and outside click close it, rather than joining the page-wide overlay handling — it
is a menu in the composer, not a window over the page.

**On a phone the strip is two lines, and neither wraps** (`composer.css`, the 640px block). The
chips (agent, model, effort, permissions, the agent's own settings) are one sideways-scrolling
line with the working directory after it; the readings (context, cache, quota, cost) are a second
one. Decisions in it:

- **The directory and the agent give way before anything scrolls.** `.st-who` and `.wb-topic-dir`
  both start from `flex-basis: 0`, so neither can push the other onto a second line of the
  wrapping row — line breaking uses the base size, and a `max-content` basis is what wrapped the
  directory before. They grow to `max-content`, the chips 1000 times faster, so the directory is
  the first to sit at its 64px floor; inside `.st-who` only the agent can shrink (to 56px); only
  then does the line scroll. The row still wraps, but only to put `.st-info` under it.
- **Each line keeps its scroll across a repaint** (`paintStatus` restores `scrollLeft`): the strip
  is redrawn from HTML when a switch opens or the countdown ticks, which would otherwise throw a
  reader who had scrolled to the permission switch back to the start the moment it opened.
- **The cost goes last** on that line (`.st-cost`, CSS `order`), as the reading nobody acts on
  mid-conversation; the rest keep the desktop's order.
- **The directory is its last folder** (`dir.name`, which the room already sends as the basename),
  on the desktop too; the path is the title and a visually hidden span, since a generic span cannot
  carry an `aria-label`. The permission switch is a shield and the level, with an `aria-label`
  naming it.
- Measured in Chromium on 2026-11-28 against the real `WebRoom` at 360, 390, 412 and 1280px: one
  line at every phone width with an effort switch and two quota pools in place, a tap in the
  transparent band opening the permission list, both lines scrolled by a real touch drag and kept
  through the repaint that opening caused, no scrollbar drawn.

**`access.allowFrom` identity is `<instance id>:owner`**, the same for every topic. An existing
config that already lists other identities will silently ignore every message typed into this
page until that entry is added — `doctor` checks for exactly this.

**`access.allowFrom` identity is `<instance id>:owner`.** An existing config that already
lists other identities will silently ignore every message typed into this page until that
entry is added — `doctor` checks for exactly this.

### A new topic offers its agents

An empty topic used to be a blank page, and choosing who answers it meant knowing `/agent` and
tapping through its two levels (machine, then agent). Since 2.17.0 the page lays every agent out
there instead, by machine, one card each: the id, what it is (`core/agent-menu.ts` agentKindOf —
the harness as its project names it, a custom harness's command), and its model, short as the
footer says it. Five decisions in it:

- **The daemon decides whether the question is open; the page only draws it.**
  `WorkbenchHost.useAgentCatalog` → `ConversationRegistry.agentCatalogForRef` answers undefined
  once the agent that would answer has a session here (chooseAgent refuses to move it then) and
  when there is a single agent. `room.ts` asks only for the sync of an EMPTY room and puts the
  answer in `sync.agents`; it is not polled, not announced and not in the backlog — the first
  message replaces it, and a `/reload` shows on the next empty topic drawn.
- **A tap types `/agent <id>`**, through `command()` like Stop and the power button, so the daemon
  has one way to be told and the transcript records the choice. The bubble that send paints is a
  message, and a message is what takes the cards away. Typing anything else is an answer too, which
  is why the card of the agent it reaches is marked **default** — the binding, else
  `resolveAgent` for this address (a channel rule can make that something other than
  `routing.default`).
- **Choosing by id asks for the directory**, as a bare `/cc` does in a conversation that has never
  run (`ConversationRegistry.offerPlacement`, after the ack so the menu lands under the line naming
  who it is for). This is not webui-only: a typed `/agent <id>` and a pick from the `/agent` menu
  on any platform do the same. Without it the web UI's new topic, which chooses by id, would have
  started every agent in its root.
- **A command does not name the topic** (`topics.ts` seed). The first message seeds a blank title,
  and with a tap that message is `/agent oc2` — most new topics were named after a command. The
  next non-command message seeds it instead.
- **Over the stale notice, not beside it.** An open choice means no agent has a session here, so
  "the agent still has its context" would be untrue of that room.

An offline machine is marked — the heading over its agents, dimmed cards that can still be chosen —
but not from the connection's state, which was the first idea and why it was dropped on 2026-11-02:
a host's link closes itself after five idle minutes (`remote/connection.ts` IDLE_CLOSE_MS), so "not
connected" mostly means "not used lately", and marking it would grey out healthy machines. The
daemon measures reachability instead (`daemon/host-availability.ts`: a TCP connect to the ssh port
every minute) and pushes the machines it cannot reach (`TopicPresence.setOfflineMachines`), which
`room.ts` sends as the sync's `offline` and then as `machines` events — state like `status`, outside
the backlog, to every client. The same list marks the topic rows and puts a line above the composer
of a topic on such a machine (`paintMachineNote`), since a message there waits or fails with
nothing on screen saying why (since 2.53.0).

Layout was measured in Chromium against a real daemon with seven agents on two machines on
2026-11-02: four cards to a row at 1280 px, two at 390 px (179×68 px each), no card's kind or model
line cut, and nothing wider than `#log`. The launcher is 720 px wide rather than less because
"deepseek-v4.1-flash-free" needs 143 px in the UI face (159 px in monospace) and a desktop card
leaves 148.

## What needs the operator

Each topic in the list carries a `stage` and a `line` (core/topic-stage.ts), computed on every list
from three things: the room's own `typing` and live buttons, the outcome the daemon pushes
(`setActivity`: how the last turn ended, and any scheduled continue), and `seenAt`, when the
operator last looked. The page moves those topics to the top of the list and colours them green
(`needsYou`, `topicRows`): answer, failed, review — and nothing for a healthy topic, which is the
point. A sub-agent's topic counts only for `answer`: its replies and failures are the business of
the agent that opened it, so its row keeps the idle/live dot rather than the green `review` one,
and the parent turns green when that agent's report is waiting. Through 2.19.1 they were a separate
"Needs you" block above the list, which showed each of them twice — the same title in two places
read as two conversations. The outcome and `seenAt` are persisted in the topic file
("you have not read this" has to survive the restart that an update is); a scheduled continue is not
(its timer dies with the daemon).

**`seenAt` is the server's clock, not the page's.** The page only says *now* (`api/seen {topic}`), and
only when the topic on screen is in `review` or `failed` and the page is visible; the room stamps `Date.now()`.
It is compared with a turn's end, which is the daemon's time, and a phone's clock is nothing to
compare a server's with. Posting only on `review`/`failed` keeps the traffic to one request per outcome read.

**A menu is not a question** (`awaitingQuestion`). The room's `awaiting` set is "messages with live
buttons", which was the same thing while every such message was an ask. Operator control menus —
settings, scheduled tasks, `/model`, `/effort`, `/cd`, agent selection and command pickers — are
controls for the operator's own next step, not questions blocking an agent turn. Counted as a
question, opening `/setting` or leaving a setup menu pinned the topic to the top in green and pushed
"Waiting on your answer" about a topic with no agent or no turn running. So `topicList` asks
`awaitingQuestion` instead: a message whose buttons are all control menus does not make the topic
`answer`. `awaiting` itself still holds it, because `inUse` must not evict a topic with a clickable
menu and idle reclaim must not close the agent under one. Unrecognised buttons count as a question,
so a new kind of ask is announced rather than silently missed.

**Sub-agent topics** (daemon/delegation.ts) carry `parent`, the topic whose agent opened them —
persisted, and the only record of the relation (`adapter.topics.parentOf` / `childrenOf` read it back).
`TopicStore.orphan` drops a `parent` that names a topic no longer there, on load and after every
delete or sweep, so the × on a parent never takes its children with it. The page nests them
(`topicRows`: what needs you first, then each root by state — a root with no title yet first, then
working, resident, no agent — with a starred row leading its unstarred peers inside a state, each
followed by what it opened, depth-first;
drawn as `sub d1`–`d3` classes rather than a `--depth` in a style attribute, which the CSP refuses)
and folds them per browser, folded by default (`aa_folded` in localStorage; `false` is an opened
one); the topic on screen is never folded away, and a `parent` chain
that loops is drawn as roots rather than lost. A sub-agent topic is in Needs you, and notifies, only
for a question of its own (`operatorStage`, and the same rule in the page's `needsYou`): its
replies and failures are its parent agent's to read.

**A parent is working while its children are** (`rowRunning`). A /super dispatcher hands its work
to topics of its own and then sits idle between turns, so a row drawn from its own `running` flag
alone was the one row that looked dead while the job ran — and since the children are folded away by
default, that row is all the person sees. It is drawn as running (dot, title, header status) when
anything below it is running or asking, sorted with the working group, and left out of Close idle:
offering to close a row that says "running" is the list contradicting itself.

**A row says how long it has been doing what it is doing** (`topicAge`, since 3.1.0). The dot
answers "is anything happening"; the age answers "for how long", which is what a sidebar of parallel
conversations is scanned for. A working row counts from `runningSince` — `room.ts` stamps it when
`typing` goes on and clears it when it goes off, because no event the daemon pushes carries a turn's
start — and a dispatcher that is running only because of its sub-agents counts from the earliest
start among them, the same subtree `rowRunning` reads. An idle row counts from its last turn's end,
`outcome.at` (which a failed turn writes too), falling back to `lastAt` when the daemon sent no
outcome; a topic nothing has been said in shows nothing, and neither does a working one from a
daemon older than `runningSince`. The span sits at the right end of the line under the title, so a
long directory ellipsises while the time keeps its width, in the running blue or the directory grey
with " ago". Hovering gives the clock time, with the date when it was not today. A 30-second tick
(`paintAges`) rewrites only the label's text — repainting the list would replace every row and close
any menu open over one — and stops while the tab is hidden, catching up as soon as it is looked at.
The Sessions tab's last-activity age uses the same formatter and carries the same stamp, so the one
tick keeps both lists current and "1h" means the same thing in either.

A link to another topic is `?t=<id>` — the one relative link `web-markdown.ts` keeps — rendered with
`data-goto`, which the page intercepts to switch in place.

**Low attention** (2.20.0) is the same list drawn quieter, per browser (`aa_calm` in localStorage,
applied as the script starts so a reload does not flash the pulse back): `#app.calm` stops the
running dot's pulse and turns the unread count grey, and touches nothing that needs the person — the
amber dot still pulses, and the green rows above are unchanged. It is CSS over the same markup on
purpose: `page.dom.test.ts` checks that the rows are identical either way and that the stylesheet's
`#app.calm` rules are exactly those two, so a rule that quiets a question or a failure fails there.

**The sidebar footer is one row, two menus**: ⚙ Menu and Manage (one row since 2.20.0, split
in two when the three buttons stopped fitting).
Menu holds All settings, Notifications, Low attention and Skills — things set once per device or
visited rarely. Manage holds Close idle and carries the idle count on its own
face so the number is still seen without opening anything (with no idle agents, it shows a disabled
No idle agents line; Clear all topics is an icon button beside Topics in the header, and Mark all
read another beside it — the Sessions tab's button for this list, the same `markAllRead`). The two menus are the same box, opened
upward over the list, one at a time, and dismissed by a click outside either (the drawer's backdrop
included) or Escape, which also gives the focus back to the button that opened it (`setMenu`). The
footer is a size container: at the narrowest sidebar (180px) both words drop and the row
shows the icons with (N) on Manage — the count is the one thing that stays.

## The two side panels

The topic list on the left and the background work on the right are one component (`makePanel` in
the script, `.panel` in the stylesheet), not two. A panel is a header row, a scrolling body, a
footer row and a drag handle on its inner edge; the edge decides only the border, the direction it
slides and the direction its handle measures. The rest is written once for both: the width and its
storage, the open/close animation, the drawer it becomes below its breakpoint, `inert` while it is
off-screen, the safe-area padding, the 44px targets on a phone, Escape, and the one backdrop both
drawers share.

Closed, a panel keeps its width and is moved off-screen with a negative margin (`margin-left` on
the left, `margin-right` on the right) rather than `display:none`, which is what lets the 0.18s
margin transition animate and hands the column's width back to the chat. Below its breakpoint it
is `position:fixed` and the same class moves it with a `translateX` of its full width. The two
breakpoints and the drawer width are the parameters: the right panel becomes a drawer at 1023px
(a 240px list plus a 240–320px panel leave too little chat on a laptop), the left at 640px, and
both are `min(88vw, 380px)` wide so a phone keeps a strip of the chat visible. A panel's width is
`--pw`, set inline by the handle and kept per browser (`aa_sb_w` / `aa_sched_w`); the stylesheet's
`--pw-default` is the fallback, and double-click clears both.

## The side panel

The clock at the right of the chat header toggles a panel of the gateway's background work. It is
the right-hand `.panel` described above: a column on a screen at least 1024px wide, a drawer from
the right below that, animated by the same margin/transform transition and dismissed by the same
backdrop and Escape as the topic list. Closed on a first visit, then open until the operator closes
it (`aa_sched_open`), so opening a session from it leaves it beside the transcript. Only a docked
panel is restored on load: a drawer that came back would cover the chat it is supposed to sit
beside. The docked width defaults to `clamp(240px, 20vw, 320px)` — narrower than the topic sidebar,
because this is a glance at background work — and the left edge is a drag handle (`aa_sched_w`,
double-click to reset).

It is deliberately not a section of the topic list. A task is not a conversation — a bash task has
none, and a new-session task makes one per run — and the sidebar is the conversation switcher. The
panel is also the only place on this page where a task can be managed, so its toggle is always in
the header, unlike the terminal's.

**Two tabs at the foot of the panel, with Scheduled subdivided into Tasks and Sessions.**
The footer row — literally the same `.panel-foot` the sidebar keeps its menus in — chooses
between the two main domains of background work: **Scheduled** background tasks and automatic
**Reviews**, so the two columns end together.
Within **Scheduled**, a sub-nav bar under the panel header separates **Tasks** (the definitions
and their controls, default) from **Sessions** (the topics a new-session run opened,
`Topic.scheduled`). Grouping them keeps the footer clean while preserving the distinction between
a task definition and a run instance. The switcher leaves session topics out (`topicForest` filters
them), so the Sessions sub-tab is their only listing and its row's ⋯ is the only delete.

**A run's sub-agents are the run's** (2026-11-13). A topic an agent opened carries `parent`, not
`scheduled`, so before this the switcher drew a run's sub-agent as a root of its own — its parent
was not in that list — while the run sat in the panel. `runOwners` now gives every topic the run it
is under, any depth, and the two lists split on that: the switcher draws what is in no run, Sessions
draws each run with its tree. Both draw through the same three pieces — `topicTree` (who is under
whom), `treeWalker` (depth-first rows, the per-browser `aa_folded` fold, the topic on screen's
ancestors forced open) and `treeRowHtml` (the row: dot, fold pill, badge, marks) — so a sub-agent
is nested and folded the same way wherever it is listed. What stays the list's own: the switcher's
order and filter, and Sessions' date groups, its run-row line (when, messages, state) and its
counts, which are runs. A question from a sub-agent under a run lights the clock and its folded
group's flags, since it has no row in the switcher either. Sessions needs
no request of its own — the `topics` event that keeps the switcher current carries their titles,
state, message counts and unread marks, so a run that starts or finishes moves the tab as it
happens. Its one bulk write is **Mark all read** — the check icon in the panel's title (`#sched-read`),
shown only on this sub-tab, as the topic list's sits beside its own title — which clears this page's `aa_reads` marks and posts
`api/seen` once for each run the daemon still counts as `stage: review` or `failed` (the route takes one topic
and has no bulk form; a run list is a handful). The list is grouped by the browser's calendar —
this month by day, older by month, `lastAt` deciding — with each group folded or opened on its own
in `aa_sched_groups`; the newest group and the one holding the topic on screen start open, and a
folded header carries the unread, running and awaiting counts of the rows it hides. Tapping a row
opens the topic and leaves the panel where it is. A run holding a question
puts an amber dot on the clock (`#sched-alert`), on the Scheduled outer tab, and on the Sessions
sub-tab, because it has no row in the switcher to show it there.

A task is drawn as a row like a topic's — the same `rowHtml`, so the dot, the ellipsis and the ⋯
behave identically in both panels. It leads with the name; one line under it holds what it is doing
(a countdown, `running now`, or the state word for paused/expired/done), where it posts, how the last
run ended (red only when it was not `ok`) and its tags as `#tag`. The cron expression is deliberately
not on the row: it is on the row's `title` with the next run in full, the target and the run mode, and
on the task's page a tap opens (below). The row's actions are in its ⋯ (Pause or Resume, Run now and
Edit, both greyed while a run is in flight with the reason, then Delete, which asks once like deleting
a topic does). The dot reuses `.topic-dot`: running is the blue
pulse, a last run that did not end `ok` is red, an active task is the dim blue of a resident agent,
and paused/expired/done are the grey of an idle row, with the title dimmed to match. The list is
still a poll, so an open menu re-finds its row after every repaint and closes when the task is gone.

Above the cards sits a `makeFilterBar` instance of its own, mounted outside `#schedules-list`
because that list is redrawn with innerHTML on every poll. Its search covers the name, the prompt
or command and the target; its sort is Status, Next run, Last run or Created, either direction,
with a row that has no value for the field kept last. The keyword, selection and sort persist in
the browser. Only the Tasks sub-tab shows it — Sessions and Reviews do not.

**A task's page** (`#task-page`, `openTaskPage`) is a window like Skills', at z-index 21 because it
is opened from the panel, which on a phone is a drawer at 20 later in the document. It replaced a
fold under the row: the panel is 240–320px wide, room to show a prompt but not to edit one. The view
has the row's actions as buttons, the schedule, how it runs, its directory, where it posts, the
prompt or command, the tag editor, and two lists. **Sessions** are the topics its runs opened that
this page still has: every topic marked with the task (`Topic.task`, recorded since 3.9.0 from
`createThread`'s `task`) and every topic a recorded run names — the second is how an older topic, and
a fixed session's own topic, are found; the run history alone holds only the last twenty runs, one
day of an hourly daily task. **Runs** is that history, each with an Open for its topic, the name of a
place elsewhere, or "topic gone". The page follows the list: every poll answer goes through
`taskPageFollow`, which closes it when the task is gone, redraws the view unless a tag is being typed,
and reads the detail again when a run started or ended.

**Edit** turns the view into the task form, and **+** in the panel's head (Tasks tab only) opens
the same form empty (`openNewTask`, filled from `GET api/schedules/form`). The form holds everything
`schedule add` takes: what it runs (an agent prompt or a bash command), the session, the agent, the
model, the machine a command runs on, the directory, the timeout, the time and zone, "Posts to" and
the tags. Which fields are on screen follows the shape the form is set to, from `shapes` — core's
`SHAPE_SETTINGS`, handed over rather than copied — so switching a task to a fixed session hides its
directory and model, and a daily one hides the one-shot switch; a hidden field keeps what was typed
in it but is not sent. "Posts to" lists this page's topics by title (`{topic}`) and "Another chat…",
an id `fleetherd channels` prints (`{channel}`, with the other instances' places as suggestions);
the room turns a topic into its lane before the daemon parses either with `parseTarget`, as
`--channel` is. Save sends only what changed (`taskEditDiff`): an emptied directory or model as
`null`, a one-shot task's time again when its zone changed so the time is read in the new zone, and,
when the kind changed, what the new kind runs with (its text, agent and session, or its machine).
A new task sends everything filled in. Nothing about what a value may be is checked on the page —
a refusal is the service's own sentence in `#task-note`, with the form kept; the page only says so
when "Another chat…" is empty or a timeout is not a length of time. Values are set on the elements
after the markup is in, because a textarea drops a leading newline it is parsed with. Close, Cancel
or Escape on a form with changes asks first (on a new task, once anything was typed). Tag edits and
refusals of the row actions are said on the page when it is open for that task, since it covers the
panel's own note.

A group marked `pinned` is drawn as one always-visible row under the search instead of folding
into the panel, and both bars use it for their state filter: Status here (Running, Active,
Paused, Ended) and State in the topic list (Needs you, Running, Idle, No agent). Four chips share
the row equally and never wrap. When the bar's content is 308px or less — the sidebar's 180px and
this panel's 220px are — the word goes and the icon and count stay, with the full name on the
chip's `title` and `aria-label`, because four words do not fit; above that the short word returns.
A pinned chip never lights the Filter dot: that dot says the panel holds a choice you cannot see.
Tags (every tag in use, plus Untagged) stay in the panel.

**Reviews** is the automatic review of quiet conversations (`daemon/review.ts`). A review that
changed nothing posts no line in any chat, so this is the only place it can be read. Nothing on the
tab changes a review or a skill: undoing a change is the `fleetherd skills revert` / `archive`
command the detail shows, not a button. Its writes are **Adopt**, which opens a topic with a draft
through the same `POST api/topics` the + makes, and **Dismiss** on the pending list described
below, which touches `reviews.json` alone. A row is the
reviewed topic, how long ago, and what happened (`changed`, `preferences`, `refused`, `proposed`,
`nothing`, `failed`); opening it lists each change with its reason, whether the store applied it or
refused it and why, the undo command, the preference suggestions, and — only while the topic is
still in `topics` — a button that opens the reviewed topic. There is no quota line: the sweep has
no daily limit, so the list is the whole story.

Above the rows, **Suggested preferences** is `ReviewPanelList.pending`: every review's preference
suggestions (the newest 200 reviews, not just the 50 rows shown), one entry per wording —
`preferenceKey` in `daemon/review-state.ts` ignores spacing and trailing punctuation — with how
many reviews made it and up to three conversations it came from, less the ones dismissed. A
suggestion lived only inside its review before, so the same rule from three reviews was three rows
to open. The block says nothing on it is in force: a suggestion only takes effect when the person
has it added to their instructions.

**Adopt** starts that. It opens a new topic whose composer holds a short draft asking an agent to
add the suggestion to the person's instructions — the gateway's `instructions/common.md`, or the
file for the agent's own harness ([docs/instructions.md](../../../docs/instructions.md)) — with
the suggestion quoted at the end. Nothing is sent: the person can edit the draft, run `/agent`
first, or throw it away. The suggestion stays on the list until a message that still carries its
text is accepted by the daemon in that topic, and is then dismissed through the same
`POST api/reviews/op` the button sends. The link is by topic and in memory only: a reload forgets
it and the suggestion stays pending, which is the direction a lost link has to fail in. A topic
that cannot be opened — every one starred or in use — says why and leaves the suggestion alone.

A review recorded before results were kept has only its raw answer in the library. `review-panel.ts`
parses that with `parseReviewOutput`, marks the entry `inferred` and leaves every change's `applied`
absent: the row says *unknown* rather than guessing. That is why `HistoryReviewChange.applied` is
three-state.

**Data.** `WorkbenchHost.useSchedulePanel` (`../workbench.ts`) hands the room the task list and the five
operations (pause, resume, run, remove and `tags`); the daemon builds it in
`daemon/schedule-panel.ts` from `ScheduleService`, the same
service the agent's `schedule` commands and `/setting schedule` use, plus `detail(id)`, `form()`,
`add(task)` and `edit(id, change)` for the task's page. Six routes carry it: `GET api/schedules`,
`POST api/schedules/op` (`ScheduleOpRequestSchema`), `GET api/schedules/task?id=`,
`POST api/schedules/edit` (`ScheduleEditRequestSchema`: only the changed fields, each bounded in size,
strict), `GET api/schedules/form` and `POST api/schedules/add` (`ScheduleAddRequestSchema`: the same
fields, with a target). An edit is `ScheduleService.editFromPanel` and a new task
`ScheduleService.addFromPanel` — `schedule edit`'s and `schedule add`'s rules, with a typed directory
read as an absolute path on the machine the task runs on and checked there, and the card posted to
the conversation the task posts to (and, for a move, to the one it left). The task list pulls when the panel opens, after every action, and on a
timer while visible (5s while a run is in flight, 30s otherwise) — the daemon has no event for a
run finishing. Countdowns ("in 3h 12m") are computed from `nextAt` on the client; every other time
arrives formatted in the task's own zone.

Reviews travel the same way and on the same timer: `useReviewPanel` hands the room `list()`,
`dismiss(text)`, and `revert(name, id)`, `daemon/review-panel.ts` builds them from `history.db`
and `reviews.json` (including reviewer/model/message-count/duration metadata and inline diffs), and
the routes are `GET api/reviews` and `POST api/reviews/op` — the latter accepts
`{action:'dismiss', text}` or `{action:'revert', name, id}` (`ReviewOpRequestSchema`), and
answers with the fresh list. There is still no verb that starts or edits a review sweep. The list is
pulled when the tab is selected and on the panel's timer while it is the visible one.

**Creating tasks.** The page used not to create tasks, on the reasoning that a page POSTing a
prompt or a command would put a bash surface behind the login form. The edit route already took a
command from the page (since 3.9.0), and the reasoning does not hold for either: whoever holds this page's
session can ask an agent in any topic to run any command, which is invariant 1 of AGENTS.md — the
login is the gate on running commands here, not the absence of a form. So creation goes through the
same service, the same rules and the same card as an agent's `schedule add`, and the routes take
only bounded, strict bodies. Deleting asks once, like deleting a topic, and a refusal from the daemon
is shown as its own sentence rather than a generic failure.

## The skills page

**Skills** in the ⚙ Menu at the foot of the topic list opens the gateway's managed skills — the
records `daemon/skills-store.ts` keeps and `fleetherd skills` writes. It is a window over the
transcript, like the reader, rather than a third column: an editor and a history row need more
width than a sidebar, and the conversation stays visible around it. On a phone it takes the whole
screen.

**What it does.** The list is every skill with its status, pin and last use; **New** creates one
from a name, a one-line description and an optional body; a skill opens onto its files, a
`SKILL.md` editor and every recorded change. **Delete** archives it — **Restore** brings it back —
and there is no hard delete, here or in the store. Saving `SKILL.md` sends the version the page
read, so a stale edit is refused rather than overwriting a newer one; extra files go through
`write-file`. **Restore this version** is `revert`, and is itself recorded as a new change.

**Data.** `WorkbenchHost.useSkillsPanel` (`../workbench.ts`) hands the room the list and every operation;
`daemon/skills-panel.ts` builds it from `skills-store.ts`, the same functions the reverse command
calls, and passes `notifySkillArchived` so an archive made here tells the conversation that created
the skill exactly as one made from a chat does. Two routes carry it: `GET api/skills` and
`POST api/skills/op`, the latter validated by `SkillOpRequestSchema` — a discriminated union with
no `delete` arm, so a body the page could not have sent is refused before it reaches the store.

**The page is a window, not a column.** `#skills` is one node with two views inside it (the list
and the open skill), opened from the sidebar footer and closed by the ×, Escape, or the backdrop.
The window's own state is not persisted: a management surface is opened on purpose, and one restored on load
would sit over a conversation nobody asked it to cover. The list it last drew is kept per browser — one row per skill, in
`aa_skills` in localStorage, because `api/skills` reads and hashes every delivered file before it answers and
that wait was visible on every open. It is painted before the request leaves, and a silent refresh redraws it
only when the answer differs; a failure behind it is silent, and an open skill or a half-typed New form is never
taken away. A refresh button asks by hand and reports a failure; on a skill's page it also re-reads the skill
unless the editor holds unsaved text. Every name has a copy button, with the `execCommand` fallback a plain-http
origin needs.

## The git window

The branch icon in the chat header opens the repository the topic's directory sits in: what changed,
one file's diff, and line comments that go back into the composer. It is a window over the transcript
like the skills page, and full-screen on a phone. **Read-only** — there is no stage, commit, discard
or checkout in it, here or in the daemon behind it; changing a repository while an agent works in it
belongs in the conversation, where the agent can be asked what it meant.

**Three comparisons, and the history.** `working` is the working tree against HEAD, untracked files
included; `branch` is the working tree against the merge base of HEAD and a base branch, so
committed and uncommitted changes read together; `committed` is HEAD against that merge base. The
base starts as `origin/HEAD`, else `main`, else `master`, and can be picked from the branch list. A
repository with no commits works too: `working` and `branch` list its files as additions,
`committed` is empty. `commits` lists the history instead: short sha, subject, author and age per
commit, **Load more** paging by `skip`, and one commit opened in the same column — the way back, its
header with a foldable body, then its files. Every path in the window is relative to the
**repository root**, not to the topic's directory, which may be a subdirectory of it. A directory
that is not in a repository is answered as `not-git` with a sentence, not as an empty list.

**What an empty pane says.** A comparison with nothing in it writes which comparison and what it
was compared against in the middle of the diff pane, with a button that switches to `commits`; a
`not-git` answer does the same with the daemon's sentence instead of the red note (an `error`
still gets the note), and a turn's own changes say only that the turn changed nothing. A
comparison list with files but nothing selected opens its first file on a wide window; the
turn-changes view and a phone's list ask the reader to pick one (under 640px the two columns are
stacked, and an opened diff would push the list out of sight).

**Data.** [`WorkbenchHost.useGitPanel`](../workbench.ts) hands the room `status`, `file` and `branches`;
[`daemon/git-panel.ts`](../../daemon/git-panel.ts) implements them over
`ConversationRegistry.workspaceForRef`, so the commands run on whichever machine the conversation's
agent runs on. Three routes carry it — `GET api/git/status?t=&mode=&base=`,
`GET api/git/file?t=&mode=&base=&path=` and `GET api/git/branches?t=` — with the query validated by
`GitStatusQuerySchema` / `GitFileQuerySchema` in `protocol.ts`. A refusal from git (`not-git`, a
comparison with no merge base, a path not in the list) is a 200 with its own sentence, like the model
list's "no models"; only a malformed query is a 400.

**How the commands are run.** Every call is argv, never a shell. The path a person names is placed
only after `--`, and it is first checked against the change list git itself returned, so a path the
list did not name cannot be read even if a request invents one. Git runs with
`-c core.quotepath=off -c color.ui=never`, `--no-ext-diff --no-renames` and `-z`, and with
`GIT_OPTIONAL_LOCKS=0` (an agent is usually working in the repository at the same moment, and
`git status` must not take the index lock to refresh it) and `LC_ALL=C`.

**The listing a file open reuses.** A status answer hands the panel everything the comparison
resolved — the repository root, the branch list, the merge base, the changed paths and their stats —
and `buildGitPanel` keeps it for 15 seconds. Opening a file in that window is then only its two
sides and its patch; without the reuse every file click re-ran the whole comparison, which on a
remote host is a round trip per command and one numstat per untracked file. A refresh, a mode change
or a base change calls `status` again and overwrites the entry, and the key includes the comparison,
so one comparison's rows are never read under another's.

**Untracked files and symlinks.** `git status` runs with `--untracked-files=all`, so a directory the
agent just created is listed as its files rather than one `dir/` row that could only be refused. The
per-file numstat calls are bounded to 200 per answer and four in flight; a row past that cap says
its counts were not read (`statsUnknown`) instead of showing a `+0 −0` nobody measured. A symlink is
compared by its TARGET TEXT, on both sides: the committed side is the blob, which already holds the
target, and the working side is read with `readlink` rather than followed. A non-zero exit from
`readlink` is its ordinary "not a symlink" answer; a timeout or a spawn failure is an error, because
a link whose target could not be read must not be shown as the target's bytes.

**Caps, and why a truncated answer is not content.** One side of a file may be 1 MiB; past that the
file is `tooLarge` and all three strings are empty. A NUL byte in either side, or a numstat `-`, is
`binary` and likewise empty. The workspace keeps the END of a command's output past its cap (the
remote host's ring buffer), so a truncated change list is reported as `truncated` rather than parsed
from its tail, and truncated file content is `tooLarge`. A patch is capped separately (4 MiB): a
rewrite of a large file can produce a diff bigger than either side, and one that may be the tail of
a bigger one is not a diff — it comes back `tooLarge` with `patchTooLarge`, which the page words as
the diff being too large, not the file. `truncated` on a status answer means only the LIST is
incomplete; a cut-off numstat merely leaves the counts out. The line counts for an
untracked file come from `git diff --no-index --numstat` — the same text `git add --intent-to-add`
would produce — rather than a temporary index, because a remote host has no way to delete one and
leaving it behind in the repository would be worse than one extra command per untracked file.

**Line comments.** Selecting lines in a diff (the code view's `onSelect`) offers **Comment**; the
text is inserted into the composer — never sent — as the file, line range and side (`(old)` or
`(new)`), a fenced block of the selected lines, then the comment, with several comments separated
by a blank line. The side matters: an old-side line number read as a new-file line number points at
the wrong line. Without `codeView()` there is no selection, so the comment affordance is **not
offered**: the fallback is the unified patch with `+` and `−` coloured, which is readable but cannot
say which lines were chosen.

**Two callers.** `openGitWindow()` with no argument is the header's view. `openGitWindow({ title,
statusUrl, fileUrl })` fixes the two addresses, hides the mode controls, and appends `&path=` to
`fileUrl`; the turn-changes view uses that. Both refresh the change list when a turn in the topic
ends, and neither reloads an open diff under the reader.

**The editor button.** Each row offers **Edit** only when the page has an `openFileEditor` function,
and calls it with the file's ABSOLUTE path — the repository root joined with the root-relative path
this list shows, because the editor resolves a relative one against the topic's directory. The
editor keeps its own workspace fence, so a file outside the topic's directory can still be refused
there. `openFileEditor` is that function; until it exists the button is not drawn rather than drawn
dead.

## The History tab

The sidebar's header is two tabs, **Topics** and **History** (since 2026-11-11; 2.58.0 shipped the
same library as a window opened from a button there). History lists the conversation library: every
conversation the gateway recorded, whichever agent and platform it ran on. It is the same
`history.db` `fleetherd sessions list/search/read` reads, and it is read-only — a list, a keyword
search, and one conversation opened where a topic is read. A review's own session is not a
conversation and is left out (`HistoryStore.list`); those are read on the Reviews tab.

**Why a tab and not the window it was.** The window put a second, plainer transcript renderer over
the page — role labels and preformatted text — so a conversation read there looked nothing like the
same conversation read as a topic, and a long agent reply with code and tables was unreadable in it.
A tab keeps the list where conversations are listed, and opening one puts it where conversations
are read.

**What a row says.** The title, the agent, the platform, when it was last active (absolute, and
the year only when it is not this one) and how many messages it holds. The count above the list is
what is on screen, with a `+` while the library goes further.

**An opened conversation covers the topic; it does not replace it.** `openLib` reads it into
`#lib-log`, a twin of `#log`, and `#chat.lib` swaps the two and the composer for a read-only bar,
the way `#chat.term` shows the terminal below them. A terminal that is open when a record is
opened is parked rather than left painted over it — see
[the terminal pane](#the-terminal-pane). Decisions in it:

- **The same bubbles.** The daemon renders the read as WebMessages (`room.ts` historyMessages): the
  operator's prompt escaped and unrendered, as `record` posts it; a reply as markdown; consecutive
  tool rows as one tool bubble, a line each; a gateway-written prompt as the dispatch or report it
  was in the topic. The page draws them with `msgMarkup`, the function `paint` uses, so one place
  decides what a bubble is. Rendering stays on the server because `web-markdown.ts` is the XSS
  boundary. What the library never kept cannot come back: a run of tool calls is one line
  (`ToolRunFolder`), and there is no ✓, timing, button or picture.
- **The topic underneath is left alone.** Its stream, messages, draft and held state are untouched;
  messages that arrive meanwhile land in the hidden `#log`. Closing is a class coming off, and the
  place `#log` was being read is measured on the way in (`logPlace`) and put back on the way out,
  because a log that was not laid out reports nothing useful. While it is covered the topic is not
  reported seen (`reportSeen`), and a paste or a drop is refused rather than attached, unseen, to
  its composer.
- **The way out is the Topics tab, any topic, or Close.** `switchTopic` closes it first thing —
  including into the topic it covers, which is otherwise a no-op — so a row, a `?t=` link in the
  record, the side panel and a notification all lead out. **Open the topic** is offered only while
  `session.topic` is in this page's list, and asked again whenever the list changes; it also turns
  the sidebar to Topics, where that row is.
- **Why nothing can be sent** is said where the composer was, in one of three sentences: still a
  topic here, a topic cleared from this page, or a conversation from another platform. A read the
  store cut short (`note`) is said in the same bar, beside the last message read: the reader lands
  at the bottom, and the bottom of 500 rows is not the end of the conversation.
- **Not remembered.** Neither the tab nor the open conversation is stored or put in the address:
  `?t=` is what links and notifications open, and a reload that reopened a read-only view over the
  topic they named would hide it. Entering the tab reads the list again (or the search still in the
  field), as the Reviews tab is pulled on selection; the rows already there stay until the answer.

**The header at a narrow sidebar.** Two words, the clear control, the + and the × fit from a 225px
sidebar at 12.5px; under 232px (210px of header content — a container query measures the content
box) each tab keeps only its icon (`chat`, `history`), with its name on the title and label, as the
footer's buttons do. Measured in Chromium at 180–240px on 2026-11-11
(`project-scripts/talkcode-history-tab/shoot.mts`).

**Data.** `WorkbenchHost.useHistoryPanel` (`../workbench.ts`) hands the room `list({before, limit})`,
`search(query)` and `read(id)`; `daemon/history-panel.ts` builds them from `HistoryStore`, and the
instance id is only for the topic link. Three routes carry it: `GET api/history`,
`GET api/history/search?q=` and `GET api/history/read?id=`. All three are reads behind the same
session as everything else; nothing here writes a row. The read answers with the session, the note
and the messages already rendered (`room.ts` historyRead), not the store's rows. Every parameter is in the query string, so
`server.ts` validates each by shape — a cursor it did not hand out, a limit outside 1–200, a query
with no word in it and an id that is not one are refused before they reach the store.

**Paging.** `HistoryStore.list` defaults to the last seven days and at most 200 rows, which is what
`sessions list` means and is not what this page asks. `all: true` lifts the time bound and
`before: {lastAt, id}` resumes after the last row of the page before it — a keyset cursor, not an
offset, because the library is written while it is read and a conversation that becomes active
between two requests would move to the top and make an offset skip a row. The ORDER BY carries
`id` as a tiebreak for the same reason. The daemon asks for one row more than the page needs: its
presence is what makes `next` — and the **Load older conversations** button — exist at all.

**Search is Enter, not every keystroke.** Each search is a request, and the store's keyword search
is not a type-ahead. Clearing the field (its own ×, or deleting the text) puts the library back
rather than leaving the last search's rows under an empty field.

## Notifications

A phone freezes the page the moment it is put down, so nothing the event stream carries reaches it
(see [Every topic keeps its transcript](#every-topic-keeps-its-transcript)). Only a push service does,
so the page offers Web Push (`webpush.ts`, `sw.ts`) behind a per-device toggle in the sidebar's Menu —
never a permission prompt nobody asked for.

- **What notifies** is decided in `room.ts` `watchStages`: a topic entering a needs-you stage, and
  still in it after `NOTIFY_GRACE_MS` (the page marks a reply it is showing as seen within a round
  trip, so the grace is what keeps the phone quiet about what was just read). A sub-agent's topic
  notifies only for a question of its own (`operatorStage`): its parent agent is told the rest.
- **No dependency.** RFC 8291 and RFC 8292 are a hundred lines over `node:crypto`; `webpush.test.ts`
  checks the encryption byte for byte against RFC 8291's Appendix A and decrypts real messages as the
  browser would. Verified end to end on 2026-11-02 in Chromium through FCM to the worker's
  `getNotifications()` (`project-scripts/talkcode-dispatcher/push.mjs`, from the 2.18.0 dispatcher's run).
- **The endpoint allowlist is a security boundary** (AGENTS.md invariant 7): the server POSTs to a URL
  a browser chose. Unbranded Chromium subscribes at `jmt17.google.com/fcm/send/…`, not
  `fcm.googleapis.com` — found when the first real subscription was refused — so that entry is held to
  the `/fcm/` path rather than all of google.com.
- **The worker caches no part of the page.** It has no `fetch` handler, so every request goes to the
  network as if it were not there; the [rule below](#installing-it-as-an-app) against a worker was
  about a cached app shell, and still holds. `sw.js` is served open (the browser re-checks it on its
  own schedule), `no-cache`, under a CSP of its own; the page's CSP gains `worker-src 'self'`, which
  names where a worker may come from and lets no same-origin file run as a page script.
- **It does keep the topic a push is about** (`keepTopic`, since 3.10.0): when no page of the site is
  on screen, it fetches `api/topic` for that topic and writes it to the
  [transcript cache](#the-local-transcript-cache), in the record format and under the write rule
  `cache-script.ts` gives both writers. A phone shows the notification while the page is frozen or not running at all, and the
  page's own prefetch only runs on screen — so without this the person tapped the notification
  before anything was fetched. The worker's CSP gains `connect-src 'self'` for it and nothing wider;
  a redirect off the origin (an expired access session's sign-in page) is refused, not followed. The
  notification is shown first and does not wait on the fetch, every failure is silent, and a page
  open in the background is told what was written, so it neither fetches it again nor puts up an
  older copy it holds in memory.
- The key is made once and kept in `webui-push-<instance>/` (0700, files 0600): every subscription
  names it, so a new key would orphan every device. A subscription the push service answers 404/410
  for is dropped.

## Capabilities

| | value | why |
|---|---|---|
| `editMessage` | ✓ | Redrawing a message is what a DOM does |
| `reaction` / `typing` | ✓ | Nothing in the daemon reads either flag; the real obligation is that the methods are safe to call |
| `reply` | ✓ | Rendered as a quote above the body |
| `thread` / `renameThread` | ✓ | Topics, and topics that name themselves. The second is only possible because the first is a lane |
| `buttons` / `editButtons` | ✓ | Both, or `/model`, `/cd` and `/setting` silently degrade to plain text |
| `settingsScreen` | ✓ | The only platform that declares it: `/setting` is drawn as a settings page from the structured screen the daemon sends, not as the button grid. Every chat platform keeps the grid (see [Menus](#menus)) |
| `menuPageSize` | 24 | Core's ceiling, twice the chat platforms' 12. The page draws a menu as a grid (`menu()` in `page.ts`), so 24 is fewer rows here than 12 is on Telegram, and a page of long model ids is still one phone screen |
| `workdirPageSize` | 61 | `/cd` gets the whole scan on one page: 61 is `daemon/workdir-scan.ts`'s cap plus the root it always prepends, so this menu never pages here. `menuPageSize` stays 24 because that number is about long model ids fitting a phone screen; a list of short directory names has no such cost, and the transcript scrolls |
| `paceByLane` | ✓ | The only platform that declares it: each topic gets its own outbound budget instead of queueing behind every other topic's streaming |
| `slashCommands` | ✓ | *Received*, as ordinary text, exactly like Telegram — `registerCommands` only feeds the page's autocomplete |
| `slashNeedsAck` | – | There is no interaction to close out |
| `maxMessageLength` | 20000 | Not a platform limit. A ceiling so one runaway reply does not become an unbounded DOM node redrawn several times a second |
| `maxEditsPerMessage` | unset | Nothing here ever refuses an edit |
| `toolPreviewLimit` | 2000 | The only platform that declares one: see [Tool bubbles](#tool-bubbles) |

## A turn's changes

Every turn run here records what it changed in its workspace, and its reply carries a line for it.
`daemon/turn-changes.ts` snapshots the work tree before the prompt and after the turn (`GIT_DIR` +
`GIT_WORK_TREE` + a per-snapshot index in `~/.fleetherd/snapshots/<hash of the root>` on the
agent's machine, `add -A`, `write-tree`), diffs the two trees, and keeps the last 50 turns of each
conversation in `<configDir>/turn-changes.json`. The design notes are in that file's header; what
matters here is the page's half:

- **The entry is a field of the message** (`WebMessage.turnChanges`), not a transcript event of its
  own. The transcript store and the browser's cache keep whole messages, so a reload, a reconnect
  and a daemon restart all bring the entry back with the reply it belongs to — nothing has to be
  re-fetched or re-derived. It is hung off the message the turn last posted, which the daemon
  captures at turn end: the end snapshot runs after the turn, and by the time it lands the topic
  may already hold the next turn's reply.
- **It is drawn only when the page can open a window** (`window.openGitWindow`, the git panel's).
  The check is at draw time, so a page served without that panel shows no entry at all rather than a
  button that does nothing; the two URLs it hands over are `api/turn-changes/status` and
  `api/turn-changes/file`, and the window appends `&path=<the URL-encoded path>` to `fileUrl`.
- **Only where something can show it.** The daemon snapshots for a platform that provides
  `adapter.workbench` (`attachTurnChanges`), which is this one; every chat platform skips the work for free.
- **One directory, two topics, is not separated.** A turn's diff is its own "before" against its
  own "after", so when two topics work in the same directory at the same time each one's diff
  contains the other's edits. Splitting them would need a barrier across agents; the honest answer
  is the one in [docs/web-ui.md](../../../docs/web-ui.md).

## Code blocks in a reply

A fence reaches the page from `web-markdown.ts` `codeBlock` already framed: a bar with the language,
**Wrap** and **Copy** (`data-cb`), over the `<pre><code class="language-…">`. The buttons are
markup from the server, icons and all, for the reason a tool bubble's icons are: a reply's HTML
lands in the transcript, the History tab, a side answer's card, the file reader and the file
window's preview, and markup written once is right in all five. The page answers them in one
click handler on the document. Copy takes the `<code>` element's `textContent` — exactly the
fence's text, whatever has been drawn over it since — through `copyText`, with the check mark the
skills page uses. Wrap is a class on the frame, remembered by message key and block position
(`cbWrapped`) so an edit rewriting the message does not undo it.

A ```` ```diff ```` / ```` ```patch ```` fence is coloured on the server, line by line by its first
character (`diffLines`, the git panel fallback's rule and classes): it needs no grammar, so it is
coloured while it streams and on a page with no bundle.

Every other language is coloured on the page by the code view's own grammars and palette —
`highlighter(lang)` in `codeview/app.ts`, reached through `codeView()` like the editor. It returns
spans (`[from, to, classes]`) from a static parse; the page builds the coloured text itself as text
nodes and spans (`hlPaint`), never through innerHTML, so the agent's text cannot become markup on
this side of the boundary either. Six decisions:

- **It is not gated on the file window.** `/assets/` and `CODEVIEW` depend only on the asset build
  (`server.ts` `servedPage`), not on `files.enabled`, so the default configuration colours code.
  A source checkout without `npm run build:assets` has no bundle, and code stays plain.
- **The message a running turn is writing stays plain** (`liveEl`: the newest message of the
  topic, while its row says `running`). It is coloured when the turn ends (the `typing` event) or
  when a newer message follows it (the sweep below). Edits arrive settled anyway (`room.ts`
  `SETTLE_MS`, never per token), so this is not about cost: re-colouring the block a person is
  reading at every edit is what it avoids. The row rather than `#typing`, which nothing resets when
  another topic is opened.
- **Nothing flashes on a re-render.** `paint` writes a message's HTML only when it changed, and every
  write runs `codeBlocks` in the same task, before the browser paints: a block coloured before is
  coloured again from `hlCache` (by language and text, 300 entries, least recently used out), and a
  changed block in a settled message is coloured at once when its grammar is already loaded.
- **What has to wait is swept.** A grammar still loading, a message that has just stopped being the
  live one: `hlSweep` looks at every uncoloured block in the five places above, after a grammar
  loads, when a turn ends, and 250ms after the last write (`HL_IDLE_MS`).
- **Each grammar is asked for once** (`hlFns`); no grammar by that name, or a chunk that would not
  load, leaves the block plain — a complete answer — and the second says so in the console once
  per page. A block over 20 000 characters (`HL_MAX`) is left plain rather than held up for.
- **The palette is mounted by the bundle.** `HighlightStyle` keeps its colours in a style module an
  editor mounts when it is created; with no editor open its classes would style nothing, so
  `highlighter` puts the module's rules in a `<style>` once (the CSP admits inline style).

The first coloured block downloads the shared CodeMirror chunks and the grammar (about 130 KB
gzipped for a `.ts` fence, measured on the 2026-11-20 build), once per page: the names are content
hashes served `immutable`.

A table comes in a `.tbl` frame that scrolls sideways, and its cells wrap at spaces only — the
bubble's `overflow-wrap:anywhere` broke "Before" and every path a letter at a time to fit a phone.
A task item (`- [ ]` / `- [x]`) is drawn with the `boxOff` / `boxOn` icons where the bullet was, and
is not clickable: ticking it would change nothing the agent can see.

Checked in Chromium on 2026-11-20 at 1280 and 390 px against the real `WebRoom` and server with the
built bundle (`project-scripts/fleetherd-webui-md/`): blocks coloured, Copy putting the exact text
on the clipboard with its check mark, Wrap, the patch bands, the table frame scrolling with nothing
else overflowing, a running topic's newest block plain until a newer message and then the turn's
end coloured it, and no console errors.

## Tool bubbles

A tool bubble (`core/tool-renderer.ts`) reaches every adapter as plain text, one
`{emoji} {tool}: "{preview}" ✓ 1.2s` line per tool call. Every chat app has to show that text
as sent, which is why the preview is cut at `tools.previewLimit` (40) on the server: at 40
characters a run of tools still reads one line each on a phone. The cost is that most commands
lose the part that tells two of them apart.

This page can fold a line itself, so it asks for more of it and does the cutting in CSS:

- **`toolPreviewLimit: 2000`** (`index.ts`) — turn-runner hands the renderer the larger of this
  and the operator's setting. Bounded rather than unlimited because every edit of a bubble
  re-sends all of its lines, and a heredoc'd script can run to pages.
- **`SendOptions.kind = 'tools'`** on the bubble's *send* — the only way to know a message is a
  tool bubble once it is text. It rides the paced adapter untouched (the lane view forwards
  `...args`; `daemon/tool-bubble-kind.test.ts` pins that), and `room.ts` stores it on the
  message so every later `revise` keeps rendering it as one.
- **`renderWebToolLines`** (`web-markdown.ts`, with the other converters, because that file is
  the XSS boundary) instead of markdown: one `.tl` per line, the command in `.tl-c` and the
  finish mark in `.tl-s`. Markdown would merge the lines into one paragraph and read `*.ts` or
  `a_b_c` in a command as emphasis. The mark is parsed back off the line end so that a fold cuts
  the command and never the ✓ — the one part that says the tool is done. `room.ts` hands it
  `toolGlyph` (`icons.ts`) for a tool bubble, which draws the head emoji, a sub-agent's `↳` and
  the ✓ / ✗ as [icons](#icons); a sub-agent report goes through it without, its `🔔` left as text.
- **The page** keeps which lines are open per message key, in script state rather than as a class
  on the element: a bubble is edited at every tool start and finish, and each edit rewrites its
  markup, so a class would snap shut at the next ✓. `foldLines` stamps the state into the markup
  before the `sig` comparison, so an open line costs no extra DOM writes. A click that ends a
  text selection does not toggle — copying part of a command is the other thing done here.

Real-browser layout (a folded row is one line high, the ✓ stays inside it, an opened row wraps
instead of widening the transcript) was checked in Chromium at 1280 and 390 px against a live
daemon on 2026-10-10; jsdom has no layout and cannot see any of it.

## Sub-agent bubbles

Two more kinds travel on `SendOptions` and are drawn as bubbles of their own, so a hand-off cannot
be read as the agent's next reply:

- **`dispatch`** — work handed to a sub-agent: the confirmation card (`daemon.ts` `askButtons` →
  `sendButtons`), the started card, and the `↳ From …` task text a sub-agent's topic is handed
  (`conversation.ts` `handTo`, which also covers every later `task-send`).
- **`report`** — the `[sub-agent updates]` card (`delegation.ts` `tell`), which used to ride as
  `tools` only to borrow its folding. It still folds: `webMessageHtml` (`room.ts`) is the one place
  that decides "line-based or prose", for the send and for every later edit, so a report reaches
  the page as one `.tl` per line exactly as a tool bubble does.

A harness's own subagents (Claude Code's Agent tool — not the gateway's `/super` sub-agents above)
have a kind of their own, drawn as a card rather than a bubble:

- **`subagent`** — one subagent's tools (`daemon/subagent-cards.ts`), under a `↳ {name}` header that
  takes ` ✓ 13.2s` / ` ✗ 13.2s` when it ends. The server draws the header as
  `<div class="sa-h" data-st="run|ok|err" data-d="13.2s">{name}</div>` over the tool rows
  (`web-markdown.ts` `renderWebSubagent`, the header parsed with the tool line's own pattern); the
  page builds the card around it (`markup.ts` `subagentCard`): the subagent icon, the name, the
  tool count and duration, a state chip in the reader's language, and a chevron. The rows are the
  tool bubble's own, folded and opened the same way, but the card shows only the newest until its
  header is tapped (`ToolOpenState.card`, kept in script state for the reason a row's is), and it
  has no **Show all**. The fold is a stylesheet rule (`.sa:not(.open) .tl:not(:last-child)`), so
  the row count and the "N earlier" line are the only things the script decides.

A third is not about sub-agents but is drawn the same way:

- **`aside`** — the answer to a side question (`/btw`, `turn-runner.ts` `beginAside`). It is
  asked of a copy of the conversation and kept out of it, and it often lands while the turn's own
  reply is still streaming around it, so it must not read as that reply's next paragraph. Prose,
  like a dispatch; its rail is dashed. Only an answer the page cannot pair with its question is
  drawn this way — see [Side questions](#side-questions).

The page puts the kind on the message's class and a `.sub-k` tag above the body (`SUB_K` in
`page.ts`: the kinds it lists are the ones that get both), and only a report folds its lines like
a tool bubble. The kind is stored on the message
(`WebMessage.kind`), in the transcript file (`parseKept`), and on the page's cached copy — a reload
and a restart redraw the same bubble. Every other platform ignores the field.

## Side questions

A `/btw` and its answer are not drawn as messages. The question stays where it was asked as one line
(`btwLine`: BTW, the question, *Waiting…* or *Answer*), and the answer is read in a card over the
composer (`#btw`, inside `#bar` like the model list). The card opens when the question is sent, follows
the answer as it streams, and opens on an answer that arrives while it is shut — unless the person
closed it on that question, which is remembered (`btwShut`) so a long answer does not keep popping up.
A topic switch and Escape close it; the line toggles it.

**The pairing is by id.** `sendAside` (`daemon/turn-runner.ts`) sends every message of an answer, and
a refusal, as a reply to the `/btw` with `kind: 'aside'`; `replyMessage` here records the replied-to id
in `quote.id`, which the transcript file keeps (`parseKept`). The page reads the question off the
operator's own message (`ownText`, the `.raw` that `renderBody` writes, matched like
`parseTextCommand`) and an answer's question as `<its generation>:<quote.id>` — the reply and the
question come from one run. Matching on the answer's `↪ btw:` header would be a guess; the card does
strip that header (its title already says it) and draws the closing `side question — …` line as small
print, both by the wording `asideHeader` / `asideFooter` write.

**The answer's node stays in `#log`**, empty and of no height (`.m.aside-held`), because the cache
(`cacheable`) and the reading position (`firstVisible`) are both read off `#log`'s children; a node
taken out of the log would be lost to the next reload and break the binary search. A question and its
answer repaint each other in `paint` (`btwLink`, guarded against recursion), so the line learns its
answer has come and an answer learns its question has gone. An answer whose question is no longer held
— aged out of the ring, or kept from before answers were replies — is drawn as the marked bubble
above, never left unreachable.

## Menus

Every message with buttons — `/cd`, `/model`, `/agent`, an `ask` — is drawn by `menu()` in
`page.ts` as a grid (2.14.0; before that, buttons wrapped like words and a page of directories was
a ragged block). Columns are sized from the widest label, so short names get more of them, and there
are never fewer than two: a label longer than half the row wraps inside its cell.

`/setting` is the exception, and it is not a menu at all. A chat app has only buttons, so its
settings rows squeeze the label and the value into one 40-character string; a page does not have
to. The daemon declares `settingsScreen` for this platform, builds the same menu as a
`SettingsScreen` (`WebMessage.settings`), and the page draws it in a window of its own
(`#settings-page`) instead of in the transcript. Nothing on the page parses a label for it — the
groups, values, current marks, button ids and the control each row is changed with all arrive as
data, which is what makes a long model id readable instead of `(harness …`.

**The list is a settings page, not a grid of rows** (since 2026-11-05). Reported on 2026-11-05 as "不明所以，
重点奇怪": ten rows all titled "Default model" in a two-column zig-zag, sub-agent confirmation filed
among them, the topic named in the bar as though these were its settings, and every value the same
blue text and ›. Now:

- **One column of sections**, each a card of rows: the group names come from `core/settings.ts`
  `settingGroup`, and a group may carry one note (`SettingsScreenGroup.note`) — the model group's
  says "next session" once instead of on every row. An agent is one card (below).
- **A control per kind** (`SettingsScreenRow.control`, decided by `settingControl` in core, so a new
  setting cannot compile without one): `switch` for on/off, `choice` for a short closed list — the
  page draws up to five short values as a segmented control and anything longer as a `<select>` —
  `list` for a row that opens its own value screen (a model), and `agent` for the per-agent row,
  whose `fields` (`SettingsScreenField`) are each a `choice` or a `list`. `link` is the scheduled
  tasks, whose chat label starts with ⏰ — drawn as the clock icon here, like every glyph the page
  shows.
- **The agents are cards, one per agent** (`settingsAgents`), after the group's own rows (the default
  agent), under a heading per machine when there is more than one — `SettingsScreenRow.place`, the
  `/agent` menu's name for it (`agentGroupOf`). A card shut is a summary: the id, *this topic* and
  *default* (`defaultAgent`) badges, the harness (`targetKind`) in a colour hashed from its name
  (`agHue`, `--ag-h`, the same harness the same colour everywhere), and each field's value, unset ones
  in italics. A tap on the summary opens it and shuts any other; which one is open (`agOpen`) is the
  page's alone — never posted — survives every redraw, and goes when the page closes. Open, a field
  per line: a `list` field is its value and a chevron, a `choice` field is a segmented control where
  its options are five or fewer short words (a level's are) and a `<select>` otherwise, with the
  chosen option's `detail` and the field's `valueNote` (or `not set`) under it, and a single option
  is plain text. Every control's accessible name carries the agent id. This replaced a table
  (3.15.0): twelve agents' controls at once, a three-line card per agent on a phone with a hairline
  between them, and an Instructions column that said "Edit files" on every row.
- **A switch and a choice write from the row.** Their ids are `sts:<reqId>:<n>`, an index into the
  `choices` the daemon froze when it drew the list (`PendingSettingsMenu.choices`), the same rule
  `stv:` follows. A switch carries one id, the one that writes the *other* side, so a retried request
  sets a value rather than flipping one back. Only a screen carries `sts:`; a chat app's list is
  unchanged, and `settings-command.test.ts` pins that.
- **What a tap did is a banner** (`notice`, from `settingNotice`: the ack's words and a tone). The
  page shows the new state of a switch or segment at once and redraws from the daemon's answer; a
  request that fails or is refused (409: the message is gone) redraws from what the page last had,
  which puts the control back, with a line saying why. The request has the settings wait as its
  limit, so a link that goes quiet cannot leave a switch half-moved.
- **The bar says where these live** — `Saved to config.yaml · every topic` — and the topic it was
  opened from is only its tooltip. The page is still bound to that topic, but for a mechanical
  reason (the buttons carry its message id), not because the settings are its own.
- **Every row**, not the chat menu's first 20: that cap is Discord's 25 components per message.

Focus is put back on the control that was used when the answer redraws the page (`data-fk`). A move
to a value screen starts at the top; a move back to the list lands on the list control that posted
last (`settingsListFk`), whose card is still open — a model picked or Back pressed used to leave the
reader at the top of a page with the agent three screens down. On a phone each row's control goes
under its text at full width — except a switch, which stays on the right — and an open card puts
each label above its control; touch targets are 44px, and a select is 16px so Safari does not zoom.

The page opens from **All settings** in the ⚙ menu, or when the daemon answers a typed
`/setting`. The menu's request is sent with `quiet: true` (`SendRequestSchema`, `WebRoom.record`),
so the daemon gets the command but the transcript gets no row and the topic is not named
`/setting`; a typed command is the operator's own message and stays. The page is bound to the
topic it opened in and closes when that changes. A settings message is never painted: `upsert`,
`reconcile`, `adopt` and `paint` all skip one. A retired screen is marked `wasSettings` by
`room.revise` (only when it keeps no buttons — a message handed to the scheduled-task list is a
menu again and must show), so a reload cannot turn its farewell line into a chat message. Closing
the page records the message id, so a late edit does not reopen it; a new `/setting` is a new
message and does. `page.dom.test.ts` pins the groups and controls drawn from the screen, each
control's request, the banners, the failed-request rollback, the current mark, Back, paging and the
narrow-screen rules.

**A list row's ⋯ is one menu for every list** (`#row-menu`, `openRowMenu`, since the task rows moved
to the shared component). A topic row's ⋯, a scheduled run's and a task's all open the same element
with their own items — `{icon, label, title, disabled, danger}` or a separator — positioned from the
button's rect and kept beside it while its list scrolls. Every one of those lists is rebuilt with
`innerHTML` (on a message, on the 5s/30s poll), so the box lives at the body and each repaint
re-finds its button by the key the button carries (`topic:<id>`, `sess:<id>`, `task:<id>`); when the
row is gone from the list the menu closes. Escape puts the focus back on the ⋯; Tab or a click
outside puts it away. The topic items are Star / End agent / Delete and are unchanged; a task's are
Pause or Resume, Run now (greyed while a run is in flight, its `title` saying why), then Delete,
which asks once through `confirm` like deleting a topic.

**For every other menu, the page reads two conventions off the labels, because a label is all the
daemon sends.** If you change the labels in `core/`, this is what moves:

- A leading `● ` / `☑ ` lights the cell as the current choice; `☐ ` and `⌂ ` become a dim mark.
- A label that starts with `◀`/`‹` or ends with `▶`/`›` (◀ Prev, Next ▶, ◀ Back, ‹ machines) goes
  on a row of its own under the items, drawn quieter — it moves around the menu rather than answers it.

Both are presentation only: a label that matches by accident is drawn differently and still posts
its own id. `page.dom.test.ts` pins both.

A tapped cell is lit and disabled at once and stays so until the repaint that answers it. That
round trip used to include the outbound pacer's queue — every topic shared one budget, so a tap
waited behind other topics' streaming — which is what `paceByLane` removed (see [Topics](#topics)).

Layout was measured in Chromium at 1280 and 390 px on 2026-10-31: a page of 24 model ids is
620 px tall on a phone, inside the 716 px the chat log has there, with the question above it.

## Built for a bad connection

Three things here exist because this is expected to be read over a weak link, and each would be
simpler without that constraint. Together they took a 30-second streamed answer from 13 updates
and ~2.6 KB to 3 updates and ~600 bytes.

**Edits are held, not broadcast.** Every streaming flush re-renders the whole message, so
announcing each one sends the same growing body over and over. An edit is queued and emitted
once the message stops changing, or after a cap so a long reply still shows progress.
`SETTLE_MS` cannot be read on its own: it is 1500ms because `EXPERIENCE.stream.flushIntervalMs`
is 1200ms, and anything below that expires between every pair of edits — announcing each one
separately, adding a fixed delay to all of them, and saving nothing. If that 1200 moves, this
has to move with it.

The ordering rule that makes holding safe: **any non-edit event flushes the queue first.** A
tool bubble is a new message (flush), its progress is an edit (held), and the next segment's
text is another new message (flush) — so the bubble's final state always arrives above the text
that followed it. Getting that backwards is the scrambled transcript
`daemon/render-order.test.ts` exists for, one layer up.

The one edit that is **not** held is an edit carrying buttons, and the reason is interaction
rather than ordering: the page disables a button the instant it is clicked and re-enables it only
when the message repaints. Holding that repaint for the settle window leaves the control the user
just pressed dead in their hand — on a multi-select question, where ticking and unticking land on
the same button, for a second and a half between every tap.

**A dropped stream resumes.** Every event carries a sequence number written as the SSE `id:`
field, and each topic keeps a backlog of the last 300. `EventSource` sends back the last id it
saw, and the room replays only what that client missed. Before this, every network blip cost a
full re-send of the conversation. A `Last-Event-ID` the backlog no longer reaches falls back to
a full sync rather than handing over a transcript with a hole in it, and the cross-topic
`topics` event deliberately carries no id so it cannot move a resume point.

The replay is folded by message: a reply still streaming when the stream dropped is in the
backlog once per flush, so the page is handed its last body once, where it first appeared, and
every other event keeps its order. The last event carries the newest number in the replay even
when the message it belonged to was folded back — the page resumes from the last id it saw, so
an id below the room's would leave it looking caught up while it is not.

**The id names the process that sent it** (`<topic>.<run>.<seq>`, the run being `startedAt` in
base 36). Numbering restarts at 1 with every process and the backlog starts empty, so through a
crash — no `bye`, `EventSource` reconnecting by itself with its old id — the new process used to
find nothing in its backlog newer than the id, call that "nothing missed", and send no sync: the
page sat on a transcript the new process had never seen, with nothing on screen to say so. An id
from another run, or from beyond anything this room has numbered, is now answered with a sync.

**A restart under an open page is ridden out, not reported.** `bye` used to stop the page for
good with "Reload when it is back", which on a phone nobody read until they typed into a dead
page. The page now closes the stream and opens a new one on a back-off (1 s doubling to 30 s,
reset by a stream that opens); the resume point it sends names the run that went away, so the
daemon that answers sends the whole topic. A stream refused for good (`readyState` 2) used to mean "show the
gate", but a proxy's 502 while the daemon restarts is refused the same way as a 401 — cloudflared
answers so — so the page asks `api/push` first and shows the gate only for a 401. After a sync
from a new run the page sends a HEAD for itself: the ETag is the page's build (`servePage`), the
script carries the same hash as `BUILD`, and when they differ a line above the composer offers a
**Reload**. An offer, not a reload: the page cannot see what a reload would cost (a skill half
edited, a recording, the place in a long transcript), and the old script still works against a
newer daemon for as long as the protocol only grows.

**A tab nobody is looking at has no stream.** It used to receive everything — each message in
its topic, and the whole topic list after every message posted anywhere — whether it was a phone
on the table or a desktop tab behind ten others. Nothing on the page needs the stream while it is
hidden (it never changes the title; notifications are Web Push, through the service worker; the
seen mark is posted only while visible), so a tab hidden for 15 s (`PARK_MS`, so a glance at
another tab costs no reconnect) closes it, and coming back opens a new one with `?last=<id>`:
a new `EventSource` cannot set `Last-Event-ID`, and `server.ts` reads the query when the header is
absent. Two things make that resume land. A sync is now sent numbered with the room's position,
so a stream has a resume point from its first event rather than from the first message after it;
and a resumed stream is handed the topic list after the replay, since no backlog keeps it and a
sidebar from before the tab was hidden would otherwise stay wrong until the next post. A resume
neither takes the focus nor re-asks the side panel for its lists — the tab coming back has
already done that, and the focus is where the person left it.

**Everything is compressed**, the event stream included — which is the part with a trap in it.
A gzip stream buffers until told otherwise, so each event is followed by an explicit
`Z_SYNC_FLUSH`. Without it the page receives nothing until the connection closes, which is
indistinguishable from a hung daemon. `server.test.ts` pins it, and the test hangs rather than
failing an assertion if the flush goes away — which is the honest reproduction.

**The page is downloaded once per build, not once per load.** It is 455 KB, 134 KB gzipped, and
until it has all arrived nothing can be tapped: 2.6 s at 500 kbps, 6.3 s at 200 kbps, on every
reload and every tab a phone brought back. It used to be `no-store`, so that a stale page could
never outlive an upgrade. It is now `private, no-cache` with an ETag that is a hash of the rendered
bytes (`servedPage`): the browser keeps it and asks every time, and the answer is a 304 until
anything that changes those bytes changes — an upgrade, the title, the terminal or the password
door. The render and its gzip (20 ms on the event loop per load, before) are made once per set of
inputs. Measured in Chromium at 400 ms / 500 kbps and 800 ms / 200 kbps on 2026-11-10: a reload
of an address the browser already loaded went from 134 KB to a 0.6 KB 304, and from 6.3 s to 1.0 s
on the slower link (`project-scripts/talkcode-webui-net/reload-probe.mts`, `weak.mts` F).

The browser keys its cache by the whole URL, and the page keeps the topic in the address
(`?t=<id>`, so a reload and a shared link land on it). So the first reload after switching to a
topic this browser has never loaded the page on still downloads it whole, once; after that, that
address is a 304 too. Moving the topic out of the query string would make every reload a 304, but
it is what links and notifications open, so it was left alone.

**When the page is downloaded, it is brotli where the client takes it.** Quality 11 makes it 18%
smaller than gzip (114 KB against 139 KB; DOMContentLoaded 2.65 s → 2.25 s at 500 kbps, Chromium,
`br-probe.mts`) and takes about a second, so it is made once per cached page, on libuv's pool
(`brotliPage`), the first time a client that takes `br` asks; until it lands that client is sent
gzip. Browsers offer `br` only over https, so behind the TLS proxy this page is meant to sit behind
— whether the proxy asks the daemon for it is the proxy's choice. The event stream stays gzip: it is
flushed after every event, and that is where the trap is (above), not the ratio.

**Sends are idempotent.** A POST can be accepted and still time out on a bad link, so the page
retries — which is only safe because each send carries a nonce the server remembers. The
daemon's own inbound dedup cannot help here: it keys on a message id, and a retry mints a fresh
one. That nonce comes back out on the echo (`WebMessage.nonce`), which is how the page knows
which of its local bubbles the echo is.

**Files go up as bytes, not as base64 in JSON.** A send that carries files is framed by the page
(`framed`: a 4-byte length, the send as JSON with each file's `data` replaced by its `size`, then
the files' bytes) and posted to the same `api/send` as `application/octet-stream`. `server.ts`
`readFramedSend` checks that the sizes add up to the body exactly, turns it back into the JSON
request — base64 and all, which is what `room.submit` and the daemon's `data:` URL path take — and
validates that with `SendRequestSchema`, so the body cap, the per-file limits, the topic id and
`.strict()` are the JSON form's, unchanged. Same route, same nonce, so a retry in either form is the
same message. The type is not one a form can send, so a cross-site page cannot post it without a
preflight; the origin check and the session apply as to any POST. Text alone stays JSON. Base64 is a
third larger than the file, and on a slow uplink that third decided whether a send finished inside
its limit at all: in Chromium at 250 kbps up (`project-scripts/talkcode-webui-net/upload.mts`,
2026-11-10) a 1 MB file used to go up as 1.33 MB, outlast its 37 s limit, be retried twice from
zero and fail after 110 s; as bytes it arrives in 33 s.

**A message is on screen before the request leaves.** Waiting for the echo to draw it meant a
visibly empty transcript for as long as the round trip took — and on a request that failed after
its retries it meant the text was simply gone: out of the composer, never into the conversation,
nowhere to copy it back from. So `send` paints the message locally first, keyed `p:<nonce>`, and
the POST is a separate concern:

- while it is in flight the bubble is dimmed (`.pending`);
- the echo claims it by nonce and REUSES its node, so nothing re-runs the fade-in or moves the
  scroll for a message that has been on screen since it was typed — whether the echo arrives as a
  `msg` event or inside a full `sync` (a reconnect the backlog no longer reached, a reload);
- a failure leaves it there, edged red, carrying **Retry / Copy / Discard**. Retry re-posts the
  same nonce, so a request that actually landed cannot double.

**What was sent survives the connection going away** (since 2.4.2). Every send is written to
localStorage under `aa_unsent` — text, file names, topic, state, and the daemon's epoch — before the
request leaves and before the composer's draft is cleared, so there is no instant at which the text
is in neither place. A record goes when the daemon has the message (a 2xx, or its echo) or when it
is discarded, or its topic is. Three ways of losing a message were reproduced before this, and each
has a test in `page.dom.test.ts`:

- **A reload while the send was in flight** lost it outright: it was in no store at all. This is the
  everyday case behind Cloudflare Access. When its session lapses, every request is answered with a
  302 to the team's sign-in page on another origin (checked against the live entrance on
  2026-10-24), which `fetch` and `EventSource` both see as a network error — so the send fails, the
  stream says "Reconnecting..." for ever, and a reload is the only way back in.
- **A reload after it had failed** brought it back from the transcript cache, which is where a
  failure used to be kept, and the first sync then sorted it above the whole topic: `reconcile`
  appends what the sync carries, which moves it, so anything it does not carry ends up on top. On a
  long topic that is as good as gone. `sinkLocals` keeps every unacknowledged message under the
  transcript, where the reader lands, and moves nothing when they are already there.
- **A switch to another topic while it was in flight**, followed by a failure, left no bubble to turn
  red. `setLocal` now settles the record whether or not a bubble is on screen, and the way back into
  a topic draws what it has unsent.

A message restored after a reload that was still in flight when the last page went away is
`unsure`: nothing that page saw can say how the request ended, and it says so ("Not confirmed").
The first sync settles it. Carrying its echo, it is claimed. Not carrying it, from the daemon it was
sent to (same epoch), it never arrived and turns into an ordinary failure. From a restarted daemon,
whose ring starts empty, the silence proves nothing, so it stays `unsure`. Retry is offered either
way; the nonce makes it safe against the same daemon, and only a restart in between can let it
double.

**Retry survives a reload for text, not for files.** A text-only body is rebuilt from the record,
nonce and all. A body that carried files held them as base64, and that is not something to write
into localStorage, so a message that carried files offers Copy and Discard alone after a reload,
rather than pretending it can re-send files it no longer has. Text over 64KB is kept in memory only,
for the same reason a draft that long is.

**A send that is never answered fails; it does not wait.** `fetch` has no timeout, so before
2.4.1 a request that went quiet — a tunnel that took the body and stopped, a socket the OS had not
yet noticed was dead — left the bubble dimmed for ever: no error to turn it red, no Retry, and
nothing in the daemon's log, because a request is only logged once its body has been read. Now
`post()` takes a `limit` and aborts the attempt through an `AbortController`; the send passes
`sendLimit(body)` — 15 s plus 1 s per 16 KiB (~128 kbps), capped at 3600 s (matching the
`server.requestTimeout` set in `server.ts`, enough to cover `MAX_BODY_BYTES` = 36 MiB on a slow
uplink). It is scaled because the same page sends a line of text and a 25 MiB file. An
attempt that was given over a minute was an upload, and is not repeated from byte zero (it fails
once, and Retry is one tap); a short one is retried under the same nonce like any dropped request.
`deliver()` also turns a *synchronous* throw from `post()` — `JSON.stringify` on a body too big to
build — into the same failure; it used to leave the bubble dimmed with nothing attached that could
ever change it. Only the send passes a `limit`: the other callers' requests are short.

The server's half is the log. `readBody` has an opt-in `logRefusals`, which only the send route
asks for because `api/login` is reachable without a session and a stranger must not be able to
write a line per malformed body. A 413, a 415, a 400 and a client that hung up mid-body each leave
one `[webui] POST /api/send: refused — …` line, the last with how many of the declared bytes had
arrived; and the `[in]` line says `(+N files)`. Before, a refused upload told the page and told
nobody else, and "the file never left the browser" and "the server threw it away" read the same.

## The local transcript cache

A transcript lives in the daemon's memory. That is still true, and it used to mean the page went
blank whenever the daemon did. Now the browser keeps a copy of each topic, and every way into a
topic starts from it. It buys three things:

- **A topic paints before the stream has answered** — on a reload, on a topic switch, on a link
  slow enough that the round trip is visible.
- **A stream resumes from the copy** instead of sending the whole topic again.
- **A daemon restart costs the conversation its liveness, not its contents.** The old messages
  stay on screen, above a divider that says where they came from, and the agent still has the
  context to carry on below them.

**One copy per topic, one version, one rule.** A copy says what it is a copy of: `last`, the id of
the last event it reflects — `<topic>.<run>.<seq>`, the stream's own ids, which each topic row and
`api/topic` carry too. `newer` (`cache-script.ts`) decides which of two copies is newer: the later
run (the daemon's start time in base 36, the sync's `epoch`), then the later event; a copy with no
`last` stands before every event of its run. A copy is the topic as it stands when its `last` is its
row's, or past it — a row reports its events up to 300 ms after them. Nothing else is compared:
`lastAt` moves only on a new message, and a streamed reply is one message edited to the end.

**Two layers behind one `put` and one `get`.** Memory keeps the eight topics most recently put, whole,
4000 messages between them: no database read, and all a browser without IndexedDB has. IndexedDB
keeps a record per topic, the message list as a JSON *string* so the byte budget below is measurable
(localStorage is too small: one topic with code blocks runs to hundreds of kilobytes against ~5MB for
the origin). `cachePut` reads the old record in the same readwrite transaction it writes in, and
writes only a copy at least as new; the page and the [service worker](#notifications) both write
through it, and memory keeps the same rule. So of two writers racing — the page on its way out of a
topic, a fetch that left before that, another tab, a push — the older never lands last. `vers`, the
newest copy the page knows of per topic (from every put, read and peek, and the worker's message),
is what decides how to open a topic and what to fetch without reading the database; `get` takes
memory unless `vers` says the database has newer. The topic on screen is put on the way out and
every 400 ms while it changes (a streamed reply upserts the same message every second or so), and
only once its sync, or the copy it was entered from, has said what it is.

**One way into a topic** (`enter`, on a switch and on loading the page). The copy goes up and the
stream opens with `?last=`: the daemon replays what came after and then sends `resumed`, which ends
the catch-up as a sync would (carrying `epoch`, plus `commands` on a client's first connect); when
its backlog no longer reaches, it falls back to a `sync` frame reconciled over what is on screen.
Direct page loads and reloads on a topic URL also wait up to 300 ms for `aa_cache` before opening
the stream so they resume with `?last=` instead of re-downloading the topic. A copy that is its
row's latest goes up without "Checking for anything said while you were away". With nothing to
resume from — no copy, one of another run, one cut to fit, or an empty room (whose choice of agents
only a sync carries) — the stream asks for a windowed `sync` and whatever copy there is is painted
as it comes. Memory is put up at once; the database is waited on only when it may hold a copy to
resume from, for at most 300 ms (a read is a few; mobile Safari's has been known to hang). The echoes
a copy carries are claimed as a sync claims them, and a send the previous page left unsure is judged
at the end of the replay (`settleOnResume`), never on the copy alone: the copy may predate the send.
Switching back to a 1000-message topic this way went from 85.0 KB and 3.7 s to a few hundred bytes
and 1.4 s, at 400 ms / 500 kbps in Chromium (2026-11-10).

**What needs the person is fetched before it is opened.** One rule: a topic whose stage is a question,
a failure or a finished reply (`NEEDS_ORDER`) — a scheduled run's and a sub-agent's too, each opened
from its own row or notification — that is not on screen and whose copy is not its row's latest is
fetched from `GET api/topic` and put. A topic this page left is no exception: left mid-turn, its copy
is the turn half done. Up to 20, in the order the needs-you rows are drawn, three at a time (the
median topic is 11 KB gzipped, so each fetch is mostly round trip), and only while the tab is visible
and its stream up. Each version of a row is fetched once: a failure is asked again a minute later, an
answer not until the row moves, even one that is not the row's version. A request that never comes
back is aborted after that minute. Nothing is fetched without IndexedDB: memory holds eight topics,
and fetching twenty into it would push them out and fetch them again for ever. The route is
read-only (no subscriber, no list event, no seen mark), and its answer can be 1.5 MB of JSON, so it
is gzipped on libuv's pool rather than with `gzipSync`, which would stall every stream in the process.

Through 3.13 the same topic could be on the page three times — held in memory when it was left, a
database record matched to its row by `lastAt`, a copy fetched before it was opened — and entering
took them in a fixed order, memory first, rather than the newest. The prefetch skipped what was held,
so the everyday case (send, look elsewhere while it works, tap the row when it turns green) put the
topic up as it was left and caught it up from the stream a second or two later; and an edit moves no
`lastAt`, so a copy of half a reply passed for current. Of 871 stream opens on the live gateway from
2026-11-17, 27% were full syncs, 41% resumes that replayed something (10 events in the median), 32%
replayed nothing. The measurement behind the earlier fixes opened only topics that had finished
before the page loaded, and counted messages rather than reading the last one.

**Messages are keyed `<epoch>:<id>`, not `<id>`, and that is load-bearing.** `nextId` counts from
`w1` per process, so a restarted daemon hands the same ids out again — verified on the wire: the
first message after a restart really is `w1` again. Keyed by id alone, that message would upsert
itself straight over a cached one and the transcript would quietly corrupt. `epoch` is the sync's
generation (`WebRoom`'s construction time); it is only ever compared for equality. A message from
another generation is *history*: it keeps its place at the top, it is never dropped by a
reconcile, and its buttons are stripped, because the process that would answer them is gone and
the id they name now means something else.

Cached messages of the CURRENT generation produce exactly the keys the incoming sync produces, so
the ordinary path — same daemon, cache matching the ring — reuses every node and writes no DOM at
all. The cache is a head start, not a second source of truth.

**Rotation, because a cache that only grows is the same bug more slowly.** A record holds a whole
topic (up to the daemon's own 1000 messages, within 2M characters — the tail when it is over, and
then without a `last`, since a resume would replay onto a hole), the least recently written topics
are evicted past 100, and a write refused for space drops everything but the topic being read and
tries once before the cache is written off for the session with one `console.warn`. The live
gateway's 200 kept topics, measured on 2026-11-17, ran to 356 messages and 817K characters at the
longest and 87K in the median, so whole topics cost a few megabytes. Writing them whole was measured
too: streaming 10 s into a 1000-message topic under 4× CPU throttling blocked the main thread 548 ms
against 490 ms with 200-message records — about 2 ms a write.

**A browser with no IndexedDB is a supported configuration.** Private windows and old engines
both produce one; memory is then the only layer, and `page.dom.test.ts` holds that.

**What is NOT cached: anything typed here.** The cache holds what the daemon sent and nothing else.
A message this page sent and has not had acknowledged lives in `aa_unsent` instead ([above](#built-for-a-bad-connection)):
a write coalesced into a 400ms window of an asynchronous database cannot promise to land before a
reload, and that promise is the whole point. A cache written by a page from before 2.4.2 may still
carry a failed message; `adopt` moves it into `aa_unsent` and the cache is rewritten without it.

**The echo of your own message is not rendered markdown.** `renderBody` escapes it and stops
there, where the agent's side goes through `web-markdown.ts`. What the operator typed is a
prompt: the exact characters are what the agent received, and this echo is where that gets
checked — a numbered list that markdown renumbered read as a different message from the one in
the compose box. `.b .raw` in `page.ts` carries the `pre-wrap` that keeps its line breaks, since
nothing turned them into tags.

## Switching topics

Leaving a topic and coming back used to cost two things. The transcript came back at the bottom
wherever it had been read, and the composer did not change at all: one textarea serves every
topic, so a half-written prompt followed you into the next one, and so did its attachments. A
screenshot pasted in one topic went out with whatever you sent in the next. Both are now per
topic, and both only do work at the moment of a switch.

**Where you were reading is kept as a message, not as a pixel offset.** On the way out,
`saveView` records the first message on screen and how far its top sits from the top of the
viewport. A scrollTop would not survive the way back in. The transcript is rebuilt from its copy —
from the database, only the tail of a topic too large for its budget — and then reconciled against
a ring of 1000. So on such a topic the sync inserts older messages *above* the one being read, and a restored
offset would land that many rows off. A binary search over `#log`'s children finds that message with one forced layout,
not one per message.

- **At the bottom means "follow along", and it is recorded as no entry at all.** A topic left at
  the bottom comes back at the bottom, with whatever was said while you were away on screen.
  Putting you back on the last message you saw would leave the new ones under the fold, which is
  the opposite of what you were doing.
- **`land` runs twice on the way in, and the second time is conditional.** It runs first when the
  copy paints, which is the first real paint, so there is no visible jump. It runs again when
  the sync lands, because the sync may have put the head of the topic above the message. The second
  run only happens if `scrollTop` is still what the first one left: once you have scrolled the
  cached transcript, it is not the page's to move. A reconnect's sync, as opposed to an entry's,
  keeps its old rule and only holds someone who is already at the bottom.
- **Leaving before the topic has loaded keeps the view that was being restored.** Otherwise
  passing through a topic on the way somewhere else would measure its placeholders, find no
  message, and forget where it had been read.
- **Memory only.** Nothing about a reload asks to be put back mid-transcript, and keeping it in
  memory means there is no write at all.

**The composer is swapped with the topic: text, caret and files** (`stashDraft` / `loadDraft`).
The text is also written to localStorage under `aa_drafts`, so a reload does not cost it. Files
are not written: they are base64, and a failed message that carried files is not retryable after a
reload for the same reason. A few decisions here are not obvious:

- **Writes happen when a topic is left, when a message is sent, when the page is hidden, and once
  typing has paused for a second. They never happen per keystroke.** The hidden transition is the
  last event every way out of a page reliably fires, so nothing typed is still only in memory by
  the time the browser may discard it. The pause is for the ways out that fire nothing — a renderer
  that crashes, a phone that kills the tab in the foreground — which used to cost the whole draft
  and now cost the last second of typing.
- **Each write is a read-modify-write of one key, not the whole map.** A second tab on the origin
  keeps drafts of its own, and writing this tab's map wholesale would put back drafts that tab
  has since sent.
- **A switch between two empty composers touches no storage and no DOM.** That is most switches.
  Storage is only consulted for a topic that had a draft or has one now. `grow()` measures the
  textarea, which forces a layout mid-switch, so it only runs when the text actually changes.
  `page.dom.test.ts` pins the no-storage half.
- **Over 64KB, a draft stays in memory only.** localStorage is one ~5MB budget for the origin, and
  a pasted log that filled it would also break the writes for the read marks and the drawer state.
- **A file is attached to the topic it was picked in.** `FileReader` answers a few turns after
  the paste or pick, and clicking another topic in between used to hand the file to the wrong
  conversation.
- **A topic's view, draft and unsent messages go with it**, on a delete, on "Clear all topics", and
  whenever the list stops carrying an id (`prune`). A clear that spared starred topics spares theirs
  too — `keepOnly` works from the list the server answered with, not from the stars this tab last
  drew.

Measured in Chromium on switches into a 250-message topic, 31 per run, compared with the code
before the change. `saveView` costs at most 0.1ms, which is the resolution of Chrome's timer.
`loadDraft` costs about 1ms, and only when the two
composers hold different text, which is `grow()`'s layout. Click to transcript painted was
84.6–90.7ms before and 88.6–92.6ms after, which is within run-to-run noise.

**Not solved here:** a voice recording is the one piece of composer state that still does not
follow its topic. Stop it after switching, and it goes to the topic on screen.

## Transport: SSE, not WebSocket

`GET api/events` is an event stream; the page uses the browser's own `EventSource`, which
reconnects by itself. Upstream is three ordinary POSTs. Node has no WebSocket server, so the
alternative meant a new dependency for one local page, and the only thing given up is
client→server streaming, which nothing wants.

One WebSocket does cross this server — the terminal's — but as bytes, not as a protocol. See
[the terminal pane](#the-terminal-pane).

Server→client events are **upsert by id**: a message the page already holds is replaced. One
event kind rather than separate send/edit kinds, because a client that reconnects mid-turn
receives an "edit" for an id it has never seen, and would have to treat it as an append
anyway.

Two consequences worth knowing:

- **`sendMessage` resolves whether or not anybody is watching.** The ring is the
  conversation; clients are a fan-out of it. An adapter that failed with no browser open
  would fail every turn started before someone opened the page — and the daemon would report
  that failure by posting into the same empty room.
- **An edit to an id the ring has evicted throws `MessageNotEditableError`**, not a silent
  success. `StreamBuffer` answers it by sealing and continuing in a fresh message. A silent
  success would have it record text as delivered that nobody can see.

**A stream that stops reading is cut** (since 2.47.0, `server.ts`). A phone put down with the page
open keeps its connection half-alive, and everything written to it used to wait in the daemon's
memory for good — 153 MB after 2000 posts in a test. A stream more than 2 MB behind for 60 s is
closed, and `EventSource` reconnects with its last event id and catches up from the backlog. Not a
plain size cap: a full sync of a long topic is about 3 MB on its own, so a slow link would be cut,
reconnect, receive the same sync and loop. The topic list (`announceTopics`) is serialised once for
every client and not sent at all when it has not changed; each client's gzip stream is its own, so
compression stays per client. `topics.json` gathers a streaming reply's touches into one write a
second, while creating, deleting, clearing and starring still write at once.

**The topic list travels as what changed** (`topic-rows`, since 2.56.0). It used to be the
whole list after every message posted anywhere, to every client — 34 KB of JSON at 200 topics,
2.5 KB gzipped, for one row's `msgCount` and `lastAt` — and since a message always moves those two,
the "has it changed" check never once found two lists equal. Now the room keeps the list every
attached client holds (`sent`) and sends the rows that differ, the ids that went, and the order only
when the page could not work it out: the page re-sorts by `lastAt` with ties left as they were
(`applyRows`), the store breaks a tie by insertion order, and `derivedOrder` runs the page's rule to
see whether they agree. A message elsewhere now costs every other page 0.07 KB on the wire instead
of 2.48 KB (`project-scripts/talkcode-webui-net/events.mts`, 2026-11-10). Three things make it hold:

- **Everyone is brought up to the list a newcomer is handed.** `subscribe` announces before it
  attaches, so a change nobody was told about (the liveness poll is the only announcer of an agent
  going away) reaches the others first, and the next change is worked out against one list for all.
  Installing a liveness lookup announces too, for the same reason.
- **A version (`tv`) names the list.** It moves with every change, attached clients or not; a sync
  carries it, the page sends it back on a resume, and a resumed stream is handed the whole list
  (`topics`) only when it moved — so a tab coming back to an unchanged sidebar costs nothing for it.
- **A kind of its own, not a variant of `topics`.** A page from before this that is still open
  across the upgrade ignores `topic-rows`; handed a `topics` with no list in it, it would have read
  "every topic is gone" and opened a new one.

Each row also carries `last`: the id of the topic's newest event, in the same
`<topic>.<run>.<seq>` shape the stream numbers events with and a snapshot reports. `lastAt` is
not a version — it moves only when something is posted, so a reply edited after it was sent left
the row looking unchanged and the page trusting a copy that was stale. `last` moves with every
event, and `emit` announces the list on a 300 ms throttle — the first change starts the clock and
later ones ride along, so a burst costs one list rather than one per event, and a stream that
never goes quiet still reports where it stands.

**The page reconciles; it does not rebuild — and syncs are windowed.** A `sync` (and `GET api/topic`)
carries only the latest tail window of a topic (up to 60 messages or 256 KiB, with a 10-message
floor) along with `totalCount`, `hasMore`, `oldestSeq`, and `recentNonces` (and on multiplexed
cold streams, the shared `topics` list, `tv`, and `commands` are sent only once per stream). Each
message in the sync is upserted by id and moved into place (`appendChild` on an existing node moves
it rather than cloning it); when `hasMore` is true, reconciliation runs in partial mode so older
messages already paged into the DOM above the window are preserved rather than pruned. `paint`
writes no DOM at all when the markup it builds matches what is there, so an unchanged message is
genuinely untouched — which also keeps a repaint from undoing the disabled state of a button the
click handler just set. Scrolling near the top fetches earlier pages via
`GET api/messages?t=<topic>&before=<seq>&limit=<n>` (strictly validated, capped at 100 per page),
prepends them while adjusting `scrollTop` by the height delta so the viewport does not jump, and
stops once `hasMore` reaches false; jumping to an unloaded older message pages backwards until the
target appears.

While a topic's first sync is in flight the log holds message-shaped placeholders (`.sk`).
They are only ever shown into an EMPTY log: a topic painted from cache has real content to read,
and a reconnect where the conversation is still on screen must not replace it with grey bars.

A full log has the opposite problem, and `.syncing` answers it. With the cache warm, entering a
topic is instantaneous — and then, a second or two later, everything said in it while you were
elsewhere lands in one frame, with nothing in between having suggested more was coming. So
`adopt` follows the cached transcript with a line saying what is still outstanding, at the bottom
where the missing messages will land, and `reconcile` takes it away when the sync arrives. It is
worded and sized as a line about the room rather than shaped like a message on purpose: most
syncs add nothing, and a message-shaped placeholder would have promised one. `paint` keeps it
last — anything painted while it is up, including a message typed into the gap, goes above it.

## The terminal pane

Off by default. Turned on, the chat header grows a `>_` button that opens a terminal **panel** at
the bottom of the conversation — a shell in this machine, in which any coding-agent CLI can be
run directly, TUI and all. It opens at half the chat's height, clamped so the header, the composer
and a few lines of transcript keep their room, with a divider above it: drag it (arrow keys work
too, a double-click goes back to half) and the panel keeps that height, in `localStorage`, across
a reload. The transcript and the composer stay on screen and usable throughout, which is the
difference between this and the full-height window it used to be.

**The daemon owns none of it.** It does not spawn a PTY and does not speak the terminal's
protocol; it proxies, behind the session cookie, to a [`ttyd`](https://github.com/tsl0922/ttyd)
already listening on a unix socket. The page embeds ttyd's own page in a same-origin iframe.

Why it is not built here, since "a terminal in the web UI" sounds like it should be: nothing in
this daemon has raw terminal output to offer in the first place. Both agent runtimes spawn their
child over plain pipes and read line-delimited JSON — a line that does not parse is *dropped*,
and the ACP handshake declares `terminal: false`. So the pane could never be a view onto the
agent; it has to be a second, parallel thing. Building that second thing meant a native PTY
binding (node-pty publishes no Linux prebuilds at all, so every Linux install would need a
compiler), xterm.js, a WebSocket server, scrollback, resize, reconnect and a mobile key bar.
ttyd is 1.3 MB of static binary that already does all of it, including CJK and IME handling this
page would otherwise have to re-earn. The cost of the trade is one config field and the operator
having to run ttyd; the benefit is that the feature added **no dependency to this package**.

What the pane shows is whatever that ttyd was told to run. That is exactly why it works with any
CLI — and also why nothing in it reaches the conversation: no transcript, no reverse CLI, no
topic history. The two share a topic id and nothing else.

### A panel per topic, and what its two buttons mean

The panel belongs to a topic, not to the page. Its title bar carries exactly two controls, and
the whole design is in the difference between them:

- **Minimize** hides it. The iframe stays mounted and its WebSocket stays up, so coming back is
  a repaint rather than a reconnect — and the switcher's marker stays lit.
- **Close** ends the session, after a confirmation. It is a server round trip, not a teardown,
  because dropping an iframe only hangs up on a shell that carries on without us.

Switching topics therefore does not move one panel around: each topic keeps its own, mounted
and attached until it is closed. The alternative — a single panel following whichever topic is
on screen — hangs up on the topic being left, which surprises (the terminal you minimized is
gone) and makes the marker meaningless, since at most one topic could ever be lit.

**Closed, the panel is parked — never `display:none`, and never `visibility` on an ancestor
alone.** A frame with no layout box is one a browser may throttle, freeze or discard, and a
discarded frame is a closed WebSocket; a parent's `visibility:hidden` is inherited, but the
iframe's own rule says `visible` and wins. So `paintFrames` is the one place that decides:
it toggles `on` on the current topic's frame, and parks the panel (`position:absolute` at its
last pixel height, `visibility:hidden`, `inert`) when nothing should be showing it. That is why
`openLib` and `closeLib` call it: a record from History is a second reason for the frame to be
off, and it is not a CSS class on the panel.

The marker itself is a `>_` glyph on the topic row, fed by `terminal-sessions.ts` counting the
**live connections** this daemon is proxying. Read it as "a page is attached to this topic's
terminal", not "a shell is alive over there" — those differ, and the difference is visible:
close every tab and every marker goes out while the sessions carry on. Counting connections is
the most this process can honestly know, because it is the only part of the terminal it touches.

Closing has to be a configured command for the same reason. A session survives a dropped
connection only because the operator's wrapper is `tmux new -A`; ttyd itself SIGHUPs its child.
Only they can say how that is reversed, so `terminal.endCommand` is theirs to write — and where
they have not written one, the window has **no close button at all** rather than one that
cannot work.

### Wiring

```yaml
platforms:
  web:
    type: webui
    token: ${WEBUI_TOKEN}
    terminal:
      enabled: true
      # Defaults to webui-term-<instance>.sock beside the daemon's own state.
      socket: /home/user/.config/fleetherd/webui-term-web.sock
      # Optional. Without it there is no close button — only minimize.
      # argv, never a shell string; {topic} is substituted into each element.
      endCommand: ["tmux", "-L", "aa-web", "kill-session", "-t", "aa-{topic}"]
```

and, outside this package, a ttyd on that socket:

```
ttyd -i <socket> -b /term -W -a -O -P 30 -T xterm-256color <wrapper> 
```

`-i` is a **unix socket, not a port** — nothing on the network can reach it, so the session
check in front of the proxy is the only way in rather than one of two. `-b /term` matches the
prefix route. `-a` lets the URL pass an argument to `<wrapper>`, which is how one ttyd serves a
terminal per topic; the daemon passes `?arg=<topic id>`.

The wrapper is expected to be `tmux new -A -s aa-<topic>` or equivalent. Without something
holding the session, ttyd forks a fresh process per connection and SIGHUPs it on disconnect — so
switching apps on a phone would kill whatever was running. With tmux, a drop is a redraw — and
`endCommand` is how the page gets to undo that on purpose.

### Security

Three things are load-bearing and none of them are obvious.

1. **An upgrade never reaches `route()`.** `createServer`'s request handler is not called for
   one, so the `OPEN`/`GUARDED` tables, the session check and the origin check simply do not
   apply. `upgrade()` in `server.ts` redoes all of it by hand. A WebSocket route added by
   editing those tables would be wide open while looking protected.
2. **For the handshake the Origin check is the only lock, not the second one.** A WebSocket
   handshake is exempt from the same-origin policy and carries cookies whatever `SameSite`
   says. So unlike `sameOrigin`, which lets a missing `Origin` through for curl's sake, the
   upgrade path *requires* one — no browser omits it on a handshake, and the curl-shaped caller
   that exemption exists for has no business here.
3. **`?arg=` is a browser string that reaches an exec.** It is checked against the topic store
   before ttyd sees it, and again by a pattern in the wrapper on the far side.
4. **`endCommand` is a second string from the browser reaching a command.** It runs through
   `execFile` with an argv array — no shell — so a substituted id is an argument and cannot
   become syntax however it is spelled. The `^[0-9a-f]{8}$` pattern and the topic-store check
   are the belt; the missing shell is the braces, and it is the one doing the work.

Two costs accepted knowingly. The iframe is **same-origin, which is not a sandbox**: an XSS in
ttyd's page would hold this session. A cross-origin frame would need `allow-same-origin` to keep
a session at all, which undoes the sandbox, so the alternative buys nothing — the trade is
ttyd's terminal against re-implementing it here. And turning this on moves the login token from
guarding *conversation with an agent* to guarding *an interactive shell*. The ceiling is the
same (the agent already has full tool access); the distance from a leaked token to arbitrary
commands is not.

### Things that bite here specifically

- **A FIN arrives as `end`, not `close`.** An `http.Server` socket whose peer hangs up keeps its
  own write side open and sits half-open indefinitely. Tearing down on `close` alone leaks a
  socket pair per closed terminal tab and leaves `server.close()` waiting on every one of them —
  measured, not theorised: the pair outlived a client `destroy()` by a full second and the close
  callback never fired. `terminal-proxy.ts` listens for `end` too, and `server.test.ts` pins it.
- **Do not re-compress the proxied response.** ttyd gzips its own 730 KB single-file page down
  to ~190 KB and says so in `Content-Encoding`. Sending that back through `body()` hands the
  browser a double-gzipped document.
- **No connection pool to ttyd.** `agent: false` on both proxied requests: a pooled idle socket
  is still a socket, so `server.close()` waits on it and ttyd holds a client it is not serving.
- **Mounted under a sub-path, ttyd's `-b` has to agree.** The page's iframe `src` is relative
  like every other URL here, so it follows the proxy prefix — but ttyd builds its own links from
  `-b`, which is a fixed string it cannot discover.
- **A blank pane with a healthy socket is usually the renderer.** ttyd defaults to xterm's WebGL
  backend, which paints nothing under a headless Chromium with no GPU (this is how the pane was
  first, wrongly, diagnosed as broken on mobile: the content was there, `tmux display` reported
  a correct 46×51 window, and only the pixels were missing). `-t rendererType=dom` is the first
  thing to try.
- **A minimized window is still a mounted iframe.** That is the point — the connection is what
  keeps the session attached and the marker lit — but it means visibility has to be a class on
  the iframe, never an unmount, and never the `hidden` attribute either: the rule that sizes an
  iframe (`display:block`) beats the user agent's `[hidden]{display:none}`, and the loser of
  that fight is not obvious from reading either rule.

## The file window

Off by default. Turned on, the chat header grows a folder button that opens a window over the
transcript: a directory tree on the left (a drawer on a phone), breadcrumbs and a filename search
above, and an editor on the right. It shows the files of **whichever machine the topic's agent runs
on** — this one, or a remote host — because `ConversationRegistry.workspaceForRef` answers that
with one interface on both (`daemon/workspace.ts`).

The work is in `daemon/file-panel.ts`; this directory owns the page and the routes. Three
decisions shape it:

- **Reach is a path rule, not a sandbox.** Each topic's working directory, the git
  repository it sits in (the git panel names files from the repository root), plus
  `platforms.<id>.files.roots`. A path from the page is normalized and must sit under one of them;
  a `..` that climbs out is refused, never clamped. Symlinks are followed and not resolved for
  that check — a workspace of links into mounted volumes is normal here — so what a link inside a
  root points at is writable through it. The ceiling is the agent's own tool access, which is why
  this is opt-in like the terminal.
- **A save is checked, and the file stays the file it was.** The write follows a symlink to its
  target, keeps the existing file's permission bits (a new file gets the umask default), writes a
  temporary beside it, fsyncs and renames. It carries the size, mtime and SHA-256 the page read.
  The hash is what catches a same-length edit inside one timestamp tick, and it is checked once
  before the temporary is written and once immediately before the rename. That is **a check before
  the write, not an atomic compare-and-swap**: a writer landing between the last check and the
  rename is overwritten. A mismatch comes back as a conflict, which the page puts to the person as
  reload / overwrite / cancel. Overwrite is an explicit `force`, not an unchecked default. Both
  machines implement the same rules (`remote/ops.go` `opEditWrite` is the host's half).
- **A save does not change bytes the person did not edit.** The read keeps a UTF-8 BOM in the text,
  and reports the file's line ending; the page normalizes CRLF to LF for the textarea (which would
  do it anyway) and puts CRLF back on save, so a file opened and saved untouched is the same bytes.
  A file that MIXES endings, or uses only CR, cannot be kept as it is by an editor: the page says
  above the editor which ending a save will write, instead of changing it quietly.
- **Folders are managed from the tree.** New file, new folder, rename and delete act on the file
  the editor holds, and a folder row carries its own rename and delete buttons. A folder is deleted
  only when it is empty — the daemon refuses anything else and the page shows its sentence ("That
  folder is not empty. Delete its contents first.") — and deleting the folder the open file lives
  in asks the same unsaved-changes question a close would before anything is sent.
- **What can be edited is decided by content, not by name.** ≤ 1 MiB, valid UTF-8, no NUL — past
  that (or for an image, which is shown as a `data:` URL up to 5 MiB) the file is shown with its
  details and no editor. Markdown gets a rendered preview tab, built by `web-markdown.ts` on the
  server, so the preview cannot be more permissive than a message.

A file can be opened from elsewhere: `window.openFileEditor(path)` takes a path relative to the
topic's working directory or absolute on that machine, and the git panel uses it.

Routes are `GET /api/files/list|read|search` and `POST /api/files/write|create|rename|remove`.
When the listed directory sits inside a git repository, `GET /api/files/list` attaches a `gitStatus`
code (e.g. `M`, `A`, `?`) to modified/untracked file and directory entries.
Every one answers 404 when the feature is off, and the page is told at render time (`FILES_OK`),
so a page older than the config has no button to press. A successful write is a log line naming
the operator, the machine and the file.

## The instruction editor

Off by default (`platforms.<id>.instructions.enabled`). Turned on, every agent's card lists what that
agent reads, from one `GET /api/instructions` per settings page drawn (`instrEnsure`): the gateway's
own files it gets (`common.md` and its harness layer's, `daemon/instructions.ts`), each marked with
who reads it and how many — the daemon's `reach`, which names the kind of agent only when no other
kind shares the layer and the layer's own name otherwise. Then, when its harness reads files of
its own, one **Its own files** row, because listing those reads the agent's machine. A layer file
left on disk after its last agent is deleted or renamed is listed too, once under the cards as
**Instructions no agent reads**: it has no card of its own, and opening it is how it gets cleared
before a future agent on that layer inherits it. Any row opens **the file window** in a second mode
on that agent's whole list — the shared files, then its own under a heading naming its machine — with
the same editor, dirty mark, conflict dialog and save, a fixed list instead of a directory, and what
makes no sense for one hidden (new, rename, delete, search, breadcrumbs). `fileSrc` is that mode;
`filesGet` and `filesPost` hand its requests to `instrGet`/`instrPost`, which is the whole of its
reach into the window's code, and each file carries its own scope (`global` or `agent`) for the
save. Its own files failing to list leaves the shared ones and says why under its machine's heading.
Escape closes the editor alone, over the settings page it came from, and closing it asks the list
again so a saved file shows as written.

There was a section of the gateway's files at the foot of the settings page until 3.15.0. With an
Instructions column on the agents beside it, that was two lists by one name, one of them a row per
harness, and it read as the same per-agent setting twice; listing each file under the agents that
read it says who an edit reaches, which is the one thing a shared file's row has to say.

The page never sends a path of its own. It names a target: a global file by name, or an agent and
a path it got from that agent's list — and the daemon (`daemon/instructions-panel.ts`) walks the
harness's own rules again on that machine for every read and write and refuses a path not among
them now. The window's "paths" are ids into the list (`g:<name>`, `a:<path>`).

Saving a global file places the composed text at once on every machine an agent that reads it is
configured for, and the answer says where it landed — a host that does not answer gets it at the
next agent start there, as it always did; a save that would put any agent over the 32 KiB cap is
refused before it is written. An agent's own file is written where it is, through
`Workspace.writeFile` with the version check; the gateway keeps no copy.

Routes: `GET /api/instructions` (the list), `GET /api/instructions/refs?agent=` (one agent's files,
which reads its machine), `GET /api/instructions/read`, `POST /api/instructions/write`. All 404
when the feature is off, whether or not a panel was handed over, and the page is told at render
time (`INSTR_OK`).

## Security

New trust boundary, so it is spelled out. The port binds every interface by default and what
is behind it is an agent with full tool access.

1. **One shared secret**, compared with `timingSafeEqual`, exchanged for a `randomUUID`
   session in an `HttpOnly; SameSite=Strict` cookie. Sessions are bounded and expire after a
   week of disuse; the page load re-issues the cookie so the browser's copy slides too. They
   survive a restart in `webui-sessions-<id>.json` (`0600`), which holds only an HMAC of each
   id keyed by the secret — so the file is not a list of usable cookies, and **rotating
   `token` is what logs everyone out** now that a restart no longer does. This is not
   per-person identity — everyone holding the secret is the same operator, and shares the
   conversation.
2. **Five guesses a minute per source**, then a lockout, so the secret cannot be ground down
   online.
3. **Two locks on CSRF**: `SameSite=Strict`, plus a required `application/json` content type
   (which a form or an `<img>` cannot produce without a preflight) and an `Origin`/`Host`
   agreement check.
4. **`web-markdown.ts` escapes everything before it builds a tag, and there is no raw-HTML
   passthrough.** This is the load-bearing one: what it renders is agent output, which
   carries the bytes of every file the agent read. An `<img onerror=…>` in a grepped file
   would otherwise execute on a page holding this session's cookie.
5. **Downloads are opaque tokens, served `attachment` + `nosniff` as
   `application/octet-stream`** — never the file's own type, so an agent-sent `.html` cannot
   render on this origin. A path never reaches the browser and the browser can never name one.
   The one exception is [a raster image](#showing-a-picture-instead-of-a-download), which is
   served as itself so the page can draw it; `nosniff` is what keeps that from being a hole,
   and SVG is deliberately not in the set. The operator's own sent pictures are served through
   the same table and the same headers. [The reader](#reading-a-file-instead-of-downloading-it)
   is not an exception: it never serves a file at all, only HTML built from one.
6. **Uploads become `data:` URLs**, the shape `adapter-telegram` already uses, so
   `daemon/attachment-io.ts` handles them through its existing branch and its SSRF guard has
   nothing to act on. A temp file and a `file://` URL would be refused by that guard outright.
7. **Three routes are open besides the page**: `manifest.webmanifest`, `icon.svg`, `icon.png`.
   They have to be — a browser fetches all three while deciding whether the site is
   installable, which happens before anyone signs in, and a 401 there is indistinguishable
   from "not installable". They carry the configured title and a drawing; the title is already
   in the `<title>` of the equally-open page, so this widens nothing.

   **So are the page's own script and stylesheet** — `assets/app-<hash>.js` and
   `assets/style-<hash>.css`, by those two names only (`OPEN`'s `only` predicate in `server.ts`):
   the page is a shell without them, and the gate it shows before sign-in is drawn and submitted
   by that script. They are the bytes the open page carried inline until Step 1A, so this widens
   nothing either. Everything else under `/assets/` — the code view and its chunks — stays behind
   the session.
8. **An upgrade is gated separately, because it has to be** — it never reaches `route()`, so
   nothing above applies to it automatically. See [the terminal pane](#the-terminal-pane).
9. **`script-src 'self'`, with no `'unsafe-inline'`: the only scripts are files this build
   wrote.** The page carries no inline script (its one `<script>` without `src` is the JSON boot
   config, which no browser executes) and no inline handler, so a script that got past
   `web-markdown.ts`'s escaping would not run. What `'self'` admits is what `GET /assets/<file>`
   serves — the page's own script and the code view (see [The code view](#the-code-view)). The
   asset route reads only `dist/webui-assets/`: one path segment, no leading dot, a `.js` or `.css`
   extension (each served under its own declared type), and the resolved parent must still be that
   directory. `style-src` is `'self' 'unsafe-inline'`: the stylesheet is one of those files, and
   the script and CodeMirror both still set styles inline.

   What keeps a file the agent sent from being that URL is point 5 — with its exception stated
   too: a download is `attachment` + `nosniff`, and its type is `application/octet-stream` unless
   it is one of the raster images `inlineImageType` admits, which are served as themselves so the
   page can draw them. An agent's `.js` is in the first group: a file to save, never something
   this origin parses or runs, and `server.test.ts` pins it. The reader serves no file at all — it
   sends HTML this daemon built from the bytes.

   **The claim stops at this file's own handlers.** `server.test.ts` reads `server.ts` and pins
   that only the asset route and `sw.js` — the fixed string in `sw.ts` — write a JavaScript
   content type. `/term/` is outside that promise: `proxyRequest` copies ttyd's headers verbatim,
   so what type the terminal page arrives as is ttyd's to decide, and a test boots a fake upstream
   answering `text/javascript` to show it is passed through untouched. Nothing loads `/term/` as a
   script (it is an iframe `src`), and the terminal needs the session like everything else — but
   "no JavaScript under this origin" would be a claim this daemon cannot keep, so it is not made.
10. **The file window is a second writer on the agent's machine, and is off unless asked for.**
   `platforms.<id>.files.enabled` puts the login secret in front of *writing files where the agent
   runs*; that is running commands by another route, so it is opt-in like the terminal, and with
   it off every `/api/files/…` route is 404 rather than a hidden button over live endpoints. The
   reach rule is the daemon's, not the page's: a normalized path under the topic's working
   directory, its git repository or a configured `files.roots`, with `..` refused (`daemon/file-panel.ts` `locate`).
   Symlinks are followed, so a link inside a root carries the write to its target — the same
   statement `docs/web-ui.md` makes to the operator, and the reason this is not sold as a sandbox.
   Every save is version-checked and every write is logged. Do not add a write route that skips
   that check, or a page-side path rule standing in for the daemon's.
11. **The instruction editor writes what every agent reads, and is off unless asked for.**
   `platforms.<id>.instructions.enabled` puts the login secret in front of the standing
   instructions of every agent on every platform and host — a change that is in force for sessions
   nobody on this page is watching. It reaches only the gateway's own files by name, and on an
   agent's machine only the files that agent's harness reads at that moment, re-derived by the
   daemon for every request (AGENTS.md, invariant 10). Do not add a route that takes a free path.

**Not solved here:** TLS (put a reverse proxy in front), and DNS rebinding — a `Host`
allowlist would break the reverse-proxy deployment this is expected to run behind, so the
shared secret is what stands in its place.

### Showing a picture instead of a download

Point 5 has an exception, and it is the only place in this directory where a file leaves the
daemon as its own type. An agent that takes a screenshot is expecting it to be *looked at*, and
a download that has to be found in a folder and opened in another application is not that.

`room.ts` `inlineImageType` is the whole of the decision — one closed list of raster formats,
read by both ends so the tag the page writes and the headers the server sends cannot disagree
about the same file. `server.ts` uses it to pick `Content-Type` and `inline`; `index.ts` uses it
to set `file.image`, which is what makes the page draw an `<img>` instead of only a link.

Three things hold it up:

- **No SVG.** An `.svg` is XML with `<script>` in it that a browser runs as a document. It is
  the one image format that is also code, and it stays an octet-stream attachment — as do
  `.pdf` (a document format browsers render, with its own scripting) and everything else.
- **`nosniff` is what makes trusting the extension safe.** A file merely *named* `.png` is
  served as `image/png` and the browser is then forbidden from sniffing a document back out of
  it. It renders as a broken image, which is the correct outcome; without that header the same
  file would be stored XSS on the origin holding this session's cookie.
- **The link stays.** The picture is drawn *above* the download link, never instead of it — the
  link is still the only way to get the bytes onto disk, and it is what a picture whose file has
  since been evicted from the download table degrades to (the page hides the broken frame).

Tapping a picture fills the screen with it. Deliberately not a new tab: installed as an app
this page has no tab bar to come back from, and leaving the app to look at a screenshot is the
same friction the feature exists to remove.

**Before it is sent, the composer shows what is attached and lets any of it be taken back.** A
picture is a 56px thumbnail that opens in the same full-screen view, and every attachment, picture
or not, has a × (44px under the narrow-screen layout). Two things about it are not obvious:

- **The thumbnail is a `data:` URL, not `URL.createObjectURL`.** The page's CSP (`server.ts`) has
  `img-src 'self' data:`, which refuses `blob:`. An object URL looks like the cheaper choice and
  would show every thumbnail as a broken frame. The fix is to use the scheme already admitted, not
  to widen the CSP for a preview.
- **A chip is built once per file and moved after that, never rebuilt.** Its URL is the whole file
  again, so rebuilding through `innerHTML` on every paste would re-parse and re-decode every
  screenshot already attached. The node is kept in a `WeakMap` rather than on the file object,
  because that object is the upload itself: `api/send` is `.strict()` and would refuse a message
  carrying one key too many. `page.dom.test.ts` pins both halves.

**Once sent, the operator's own pictures show in their message too** (since 2.4.0; before, only
their names did). The page drops the bytes once they are sent — they are in a request
body, and the same reason means a failed message that carried them cannot be retried after a
reload, see [built for a bad connection](#built-for-a-bad-connection) — so the daemon keeps the
copy. `room.ts` `submit`
hands each upload `inlineImageType` accepts to an `UploadStore` and publishes it through the same
download table and headers as a picture the agent sent; `renderBody` draws it as an `img.shot`
inside a `.shots` row, which is what the page already opens full-screen and hides on a 404. Four
things about it:

- **`index.ts` owns the disk**: `webui-uploads-<id>/` beside the topic file, one `0600` file per
  picture named by a UUID — the browser's name is never part of a path, only its extension.
- **Nothing outlives what can reach it.** The download table (200 entries, shared with the agent's
  files) is in memory, so the directory is emptied when the adapter is built, and an upload the
  table evicts is deleted then.
- **The write is async and the download waits for it** (`Download.ready`). The echo naming the URL
  goes out as the write starts, and the page can ask before it finishes; `ready` never rejects, so
  a failed write is a logged 404 — a hidden frame and the name chip, not a crash.
- **The local bubble draws names only; the echo brings the pictures.** Drawing them before the echo
  would put each file into that bubble as a `data:` URL, and a bubble restored after a reload is
  rebuilt from `aa_unsent`, which keeps the names and never the bytes — so it would show the picture
  until the next reload and then not. After a restart the cached echo's pictures 404 and hide,
  leaving the chips — the same degradation as an agent's evicted picture.

**A file the agent sends is served from a copy taken when it was sent** (since 2.12.1). Every other
platform uploads the bytes inside `sendFile`; this one reads them when someone clicks, and the path
may not live that long. For an agent on a [remote host](../../../docs/remote-hosts.md) it does not
live at all: `daemon.ts` `sendAgentFile` fetches the file into a temporary one and removes it as
soon as `sendFile` returns, so from 2.9.0, when remote hosts arrived, every such link answered 404 —
and a browser following a `download` link saves that JSON body as `<token>.json`, which is how it
was reported. So `room.ts` `publishCopy` has the `UploadStore` copy the file into the same directory
before `sendFile` returns, and the copy is `owned` like an upload: `0600`, named by a UUID alone,
deleted on eviction. A path that cannot be read now fails the agent's `send-file` instead of
publishing a link to nothing. The agent's own file is only ever read.

### Reading a file instead of downloading it

A report, a plan or a log the agent sends is meant to be read, and a download meant the downloads
folder and another application — on a phone, one that may not exist. Since 2.15.0 such a file has
been readable in place. Its name is now the way in, and **Download** beside the name is what the
name used to be: `#reader` is a window over the transcript — a dimmed backdrop, a box capped in both
directions, with the file's name, a Download link and a close button — rather than the opaque
full-screen page it was, so the conversation stays visible around the document being read.

It does not bend point 5, it goes round it. `GET view/<token>` (`server.ts` `view`) resolves the
same download token, reads at most `MAX_READ_BYTES` (512 KiB) of the file, and answers JSON:
`{ name, size, shown, html }` — plus `text`, the decoded head, for a `text` file and never for a
markdown one. The `html` is `reading.ts`'s — `renderWebMarkdown` for a `.md`, the
file's text through `escapeHtml` inside a `<pre class="src">` for everything else on its list — so
the page puts into its DOM exactly what it already puts there for every streamed reply, under the
same CSP. The page gives `text` to [the code view](#the-code-view) when it has one and otherwise
keeps the `<pre>`; both are the same cut of the same file. An `.html` or an `.svg` is on that list
*as source*: the browser never receives the file, so there is nothing that could render it.

- **`reading.ts` `readableKind` is the closed list, read by both ends** — the arrangement
  `inlineImageType` has. `index.ts` sets `file.view` (the URL, from `WebRoom.viewUrl`, next to where
  `f/<token>` is minted) only for a name it accepts, and the page makes the name a preview only
  where `view` is set. PDF and office formats are absent on purpose: their text is not in their
  bytes, so they need a renderer — the browser's PDF viewer, which is exactly what the download
  rule keeps off this origin, or several megabytes of library.
- **The name is trusted for the list, the bytes are checked anyway.** A NUL in the first 8000 bytes
  (git's `buffer_is_binary` test) answers 415 "that file is not text", which the reader shows.
- **A long file is cut, and says so.** At the last line break in the second half of the budget,
  else at a UTF-8 character boundary — never inside a character. The page writes "Showing the first
  512 KB of 2.0 MB" above it. In Chromium on 2026-10-31 a 2 MB log opened in under 200 ms.
- **No preview on history.** Its token died with the run that minted it, so `parseKept` drops
  `view` and the page leaves the name a plain download on a message from another generation, as it
  does buttons.
- **`readSeq`** discards an answer that arrives after its reader was closed — on a slow link, the
  first file would otherwise land under the second one's name. Closing empties the body, as the
  lightbox drops its picture.

The real-browser half — files delivered through the real adapter's `sendFile`, the name opened at
1280 and 390 px, the window's margins and dimmed backdrop, **Download** saving the file, no CSP
violation, the close button 44px on a phone — was checked in Chromium on 2026-11-04
(`project-scripts/talkcode-file-reader/e2e.mts`).

### The code view

A text file is shown in CodeMirror 6 with its grammar's colours, and the same bundle is what the
git diff panel and the file editor are built on (`codeview/`). It is the one built asset the page
loads on demand rather than with itself:
`src/platform/webui/codeview/` is bundled by `scripts/build-webui-assets.mjs` into
`dist/webui-assets/`, given a content-hashed name, and served by `GET /assets/<file>` behind the
session. Markdown keeps the rendered HTML — the code view is for what is read as source.

**`page.ts` `codeView()` is the only way in.** It resolves to the API below, or to null when
there is no bundle or the bundle would not load; the reader then keeps the `<pre>` the server
already sent, which is a complete answer rather than an error state.

```js
codeView(): Promise<{ editor, diff, highlighter } | null>
editor(parent, { doc, name, readOnly?, onChange?, onSave? }) → { getDoc, setDoc, focus, destroy }
diff(parent, { name, original, modified, layout, onSelect? }) → { setLayout, destroy }
highlighter(lang) → Promise<null | (code) → [[from, to, classes], …]>   // a reply's fence, see "Code blocks in a reply"
```

Five things about it are decisions, not detail:

- **The entry is a loader and nothing else** (`codeview/index.ts`). esbuild keeps what an entry
  chunk imports statically inside that chunk, and a dynamic chunk importing the same module gets a
  second copy rather than sharing it. Two copies of `@codemirror/state` are two `Compartment`
  types, so `compartment.reconfigure(...)` from one is an effect the other's editor ignores
  *silently* — which is how the first build rendered every file in one colour with no error
  anywhere (measured in Chromium, 2026-11-18). With the entry importing one dynamic chunk, the app
  and the grammars are siblings and share one copy.
- **The specifier is made absolute before `import()`.** `import('assets/x.js')` in an inline
  classic script (as the page's was until Step 1A — it is a linked classic script now) fails with "Failed to resolve module specifier" in Chromium (same date), so the
  page resolves `CODEVIEW` against `document.baseURI` first. That is still relative to the page's
  own URL, so a reverse proxy sub-path mounts the bundle under its prefix like every other URL here.
- **Each language is its own chunk.** Every extension in `codeview/app.ts` `LANG` is a dynamic
  import, so opening a `.go` file downloads the editor and the Go grammar, not the other fifteen.
  An extension with no grammar opens as plain text rather than as the wrong one.
- **The palette is the page's.** The theme reads `--bg`, `--fg`, `--dim` and `--line`, so the
  editor cannot drift from the page; the token colours are a dark set tuned against those, since
  there is no light page either. The reader hands it a full-height column (`#reader-body.cv`) —
  CodeMirror scrolls itself, and two nested scrollers is what makes a phone unusable.
- **`onSave` is `Mod-s`** (Control on Windows and Linux, Command on a Mac), and `onSelect` reports
  1-based line numbers plus the text of the main selection, or null when it is emptied. The diff
  rebuilds itself on `setLayout` because `MergeView` and a unified view are different objects —
  the package's own `reconfigure` does not change the layout.

A source checkout started with `node --import tsx src/cli.ts start` needs one
`npm run build:assets` first (it is part of `npm run build` for a release), and another after any
change under `client/`. Until that has run there is no script for the page to link, and the page
says so above its login form (`page.ts` `UNBUILT`) rather than offering one that does nothing; with
a build that has no code view, `CODEVIEW` is null and code files stay in the `<pre>`.

**The build writes `licenses.txt` beside the chunks.** CodeMirror and the lezer grammars keep
their licence in a LICENSE file rather than in header comments, so minification would otherwise
erase every notice while the tarball ships only this project's own LICENSE — MIT requires the
notice to travel with the copy. `scripts/third-party-licenses.mjs` reduces esbuild's metafile
input list to the packages that actually contributed a module, reads each one's licence verbatim,
and the build stops if any of them ships no licence file at all — the names are printed — or if the
file it wrote does not name them. It is not served by
`/assets/` (that route is `.js` and `.css` only); it ships in `dist`, which `package.json` `files` carries.

The reader's half was checked in Chromium on 2026-11-18: a `.ts` file highlighted with its gutter,
at 1280 and at 390 px (where it wraps and nothing overflows), no CSP violation in the console, and
a `diff()` drag reporting `{ side: 'old', from: 1, to: 2, text }` from a real selection.

### The other door: `sso.ts`

Point 1 above is a secret with no name on it. `sso.ts` is the alternative for a deployment
that already runs behind an identity-aware proxy: Cloudflare Access and Teleport's Application
Service both authenticate a *person* and state who it was in an RS256 JWT, so the daemon
verifies that signature instead of asking for a password of its own. One module covers both —
they differ only in a header name, a JWKS URL and which claim holds the person.

`admitted()` in `server.ts` is the whole of the wiring: cookie first (a map lookup), then the
assertion (possibly a key fetch). The `upgrade()` gate calls the same function, because an
upgrade still reaches none of `route()`.

Four things there are decisions rather than detail:

- **`from` is required.** The signature is what makes a forged header useless; the CIDR
  allowlist is what keeps a mistake in `jwksUrl`/`issuer`/`audience`/`allow` from being fatal.
  Belt and braces, the way `ipc/server.ts` has both 0600 and a token. Refusals log the source
  address precisely because that line is how the operator discovers what to configure.
- **`alg` is not negotiable.** Only `RS256`, refused by name before a key is even looked up —
  `none` and an HMAC keyed with the public key are the two classic ways a verifier is talked
  out of verifying, and neither is reachable if the algorithm is fixed.
- **`audience` has no default**, and neither does anything else that decides *who* gets in. A
  permissive default would accept any token the provider ever signed, including one minted for
  a different application of the same tenant.
- **Keys are cached and refetched on an unknown `kid`, with a 10-second cooldown.** That
  cooldown is also how long a real rotation is refused for, hence "short": it bounds the
  provider at six requests a minute under a stream of junk `kid`s, and bounds a rotation at ten
  seconds of the retries the page makes anyway. A provider that goes away does **not** drop the
  keys already held — a blip at the IdP must not be a dead page.
- **`jwksUrl` must be https** (loopback excepted, for a stub). Every guarantee above reduces to
  "these keys are really the provider's", and `http://` hands that to anyone on the path.
- **`from` prefixes are parsed strictly**, because `Number('')` is 0 and `BlockList` is happy
  with a `/0` rule: `"10.0.0.1/"` would have been "every address on the internet" written as a
  typo, and the startup log would still have printed it as one host. Every malformation throws.

**Two boundaries this does not cross.** Admission is per *request*: an attached event stream and
an open terminal WebSocket outlive both `exp` and a removal from `allow`, because nothing
re-verifies a connection that is already running. And the cookie fallback is the proxy's cookie,
whose `SameSite` this code does not set — which is why the terminal's proxied responses carry
`frame-ancestors 'self'` and `X-Frame-Options` (`terminal-proxy.ts`) and the page's own CSP does
too. Framing a live terminal from another site is the attack that would otherwise be left open
by a cookie the daemon does not control.

`sso.password: false` closes the shared-secret door. The page then renders a gate with no field
in it (see `PASSWORD_GATE` / `SSO_GATE` in `page.ts`): under SSO there is no secret that works,
so a password box answers an expired provider session with "that is not the right token" and
sends the operator hunting for a credential instead of signing in again. `doctor` fetches the
JWKS and says how many keys it found — worth running before closing that door, because with it
shut an IdP outage locks everyone out.

`scripts/verify-sso.mts` drives the whole path against a real socket and a real JWKS server;
the unit tests inject `fetch`, so that script is the only thing that exercises the network hop.

## Recording a voice message

The 🎤 button beside `+` records with `MediaRecorder` and sends the recording **the moment it
stops, as a message of its own**, leaving whatever is in the composer where it was. Both halves
matter: the daemon transcribes a message that is audio and nothing else (see
[`core/voice.ts`](../../core/README.md)), so a recording sent together with a half-typed draft would
be read as a file with a caption and handed to the agent untranscribed — and the draft is the
user's, so recording must not cost it.

- **Hidden where recording is impossible**: no `MediaRecorder`, or no `navigator.mediaDevices` —
  which is what a browser gives a page on plain `http://` anywhere but localhost. Behind the
  cloudflared/SSO entrance the page is https and the button is there.
- **The browser picks the format**, first supported of Ogg/Opus (Firefox), WebM/Opus (Chromium),
  MP4 (Safari). Chromium's WebM and MP4 were both transcribed correctly through newapi's
  google-ai-studio channel on 2026-09-25; the daemon identifies the container from the bytes
  either way, so the declared type is only a hint.
- **Esc throws a recording away.** Ten minutes stops and sends it, rather than discarding what
  was said.
- **A refused microphone says so** in the status line under the transcript, instead of the
  button simply not starting.
- The file goes up as an ordinary upload (`voice-<n>.webm`), typed `audio` by `toAttachment`
  in `room.ts`. With no `voice:` block in the daemon's config it is simply an audio attachment,
  saved and handed to the agent as a path.

## Installing it as an app

`manifest.ts` is what makes a phone offer "install" rather than "bookmark", and the page's
head carries the tags that go with it. Three things worth knowing before changing any of it.

**There is no service worker for installability, and adding one for that would be a mistake.** (There
is one for [notifications](#notifications), registered only when the operator turns them on, and it
caches nothing — which is the whole of the objection below.) Chrome
dropped the service-worker-with-a-fetch-handler requirement — the check was a proxy for "has
an offline story", sites defeated it with empty handlers, and it was removed rather than
tightened ([Chrome for Developers](https://developer.chrome.com/blog/update-install-criteria),
read 2026-09-20). What remains is HTTPS and a manifest. A worker here would also mean caching
the app shell, and the shell is never used without asking the daemon first: a stale copy after
an upgrade is a support question with no error message. It is cached by the browser, but under
`no-cache` and an ETag that is a hash of the rendered bytes ([below](#built-for-a-bad-connection)),
which a cache in a worker would bypass. If offline reading is ever wanted, the local
transcript cache above is the place for it, not a second copy of the shell.

**The icon exists twice on purpose.** `ICON_SVG` is the drawing; the base64 PNG beside it is
that same drawing rasterised to 192px, because iOS reads `<link rel="apple-touch-icon">` and
has never accepted SVG there, and an Android launcher that declines to rasterise SVG falls
back to a generated letter tile — which looks like a bug rather than a fallback. 1604 bytes
buys not having to know which builds those are. They can drift; the regeneration command is in
the comment above the base64, and `server.test.ts` at least asserts the bytes are still a
192×192 PNG.

**Every URL in the manifest is relative**, resolved against the manifest's own URL, for the
same reason `api/events` is: a reverse proxy may mount the daemon under a sub-path and an
absolute `/` walks straight out of it. `scope` and `start_url` come out right without the
daemon having to be told where it lives.

One thing deliberately *not* done: `viewport-fit=cover`. It would extend the page under the
status bar and the gesture bar, and while the composer pads for the bottom one, nothing pads
for the top — the clock would land on the chat header. The browser already insets correctly
without it. `page.test.ts` pins the viewport tag so this does not get added by reflex.

## Things that bite

- **Shutdown.** `server.close()` alone never returns: its callback waits for every connection
  to end, and an event stream by definition never does. `stop()` ends the streams itself
  (with a `bye` event, so the page closes its stream and retries on a back-off rather than on
  `EventSource`'s own schedule), then
  `closeIdleConnections` / `close` / `closeAllConnections`, behind a timeout. Get this wrong
  and Ctrl-C hangs the daemon forever, because the signal handler's `process.exit` lives in
  that promise's `finally`.
- **A reverse proxy must not buffer**, and must not strip `Content-Encoding` without
  re-adding it. `proxy_buffering off;` in nginx.
- **The client script is strictly typechecked and linted.** The entire `client/` tree — including
  the entrypoint `client/main.ts` — is covered by `client/tsconfig.json` and `eslint.config.js`.
  Server-side decisions still belong on the daemon side of the wire, and template-literal escaping
  still applies to `page.ts` and `page-body.ts`, where a literal `` ` `` or `${` is eaten by
  the surrounding template and becomes a module-load error. Behavioural changes in `client/` should
  arrive with unit or `page.dom.*.test.ts` coverage, and after editing anything under `client/`,
  run `npm run build:assets` before trying a source checkout: the daemon serves the bundle, not the
  source file.
- **The page can render nothing while the event stream is perfectly healthy**, and this has
  already shipped once. A client that names no topic sends `GET /api/events` with no `?t=`,
  and `stream()` answers for `topics.current()` — so the sync that comes back carries a topic
  id the page never asked for. Any filter of the form `ev.topic !== topic` therefore drops the
  only sync a first visit will ever get, and the symptom is an empty shell with data visibly
  arriving in the network panel. The client's `topic` is the empty string until a sync or a
  click sets it; a guard against a stale sync has to check that it is set at all first.
- **The narrow-screen breakpoint is stated twice** — the `@media(max-width:640px)` block and
  `NARROW` in the script — because CSS decides the layout and the script decides whether
  picking a topic should then close the drawer. They have to hold the same number. Under it
  the sidebar is a fixed-position drawer over the chat with a backdrop to dismiss it, heights
  are `dvh` so the collapsing URL bar does not push the composer off screen, the composer and
  the token field are 16px so Safari does not zoom in on focus and stay there, the composer
  wraps onto two rows (full-width input on the first, actions on the second with attach and
  mic on the left and Stop and Send on the right) so buttons do not squeeze the input box, the
  Send row clears the home indicator via `env(safe-area-inset-bottom)`, the drawer toggle is
  padded out to a 44px square (a `:not([hidden])` selector, because the rule sets `display` and would
  otherwise beat the UA's `[hidden]` rule while the drawer is open), and the input is not
  focused on open — the keyboard would take half the viewport before a word had been read.
- **The composer's two-row split is a container query, not a media query** — `#composer` carries
  `container-type:inline-size` and the rules live in `@container (max-width:480px)`. 2.39.0 keyed
  the split to the window's 640px, and one pixel above it the sidebar is still a column: at 641px
  the composer is 369px, the three buttons that are always there plus the gaps around them take
  156px, and the input is left 213px — while a 1024px window with both panels docked leaves the
  composer 512px. The narrower composer belongs to the wider window, so only the composer can
  tell them apart. With the sidebar at its default 240px that is a window of 641–752px; a wider
  window whose sidebar has been dragged wide splits too. The `@media(max-width:640px)` block
  keeps its own copy of the same four rules: a phone's composer is 616px at that width, wider
  than the threshold, and the split is the layout a phone shipped with.
- **Enter sends; where `narrow()` holds it writes a newline instead.** The two-row composer and
  this rule are decided by different numbers and are not the same thing: the rows come from the
  composer's width (480px or less, a container query, so a 641–752px window wraps), the newline
  from the window's (`narrow()`, 640px). A 641–752px window therefore has a two-row composer and
  still sends on Enter; a phone has both. 1.22.0 made it a newline at every width, and the half of
  that which was right is the phone: held upright there is no Shift key to hold, so Enter-to-send
  makes a multi-line prompt impossible to type rather than merely awkward, and a stray Enter costs
  a half-written one. Neither is true of a keyboard, where Shift-Enter is right there and every
  other chat app on the screen sends on Enter — so paying the phone's cost on a desktop bought
  nothing. `narrow()` is read per keypress, because rotating a phone and dragging a window both
  change the answer. Ctrl/Cmd-Enter sends on both.
- **A reverse proxy must not buffer.** nginx buffers SSE by default; the response carries
  `X-Accel-Buffering: no` and `Cache-Control: no-transform`, but a proxy configured to ignore
  them shows nothing until the turn ends, which reads exactly like a hung daemon. Set
  `proxy_buffering off;`.
- **A restart no longer empties the daemon's ring, and the agent still remembers everything.** The
  agent's session is persisted by `conversation-store.ts` and each topic's transcript by
  `TranscriptStore` ([above](#every-topic-keeps-its-transcript)), with the browser's own cache
  ([above](#the-local-transcript-cache)) behind it — the messages come back, above a divider saying
  where they came from. What none of them answers is an unstarred topic from before 2.13.0 that this
  browser never opened, or whose cache has rotated out, or whose file could not be read; those
  still have to be explained rather than rendered as a blank panel: `syncEvent` sets `stale` when a room holds no
  messages and the topic's persisted `lastAt` predates the `WebRoom`, and the page answers it
  with a line saying the topic is older than the daemon and the agent still has its context. It
  also covers the milder case of a topic created before the restart and never spoken in. The
  notice is only shown when there is genuinely nothing on screen — with cached messages up
  there, the divider is the honest version of the same sentence.

## Testing

Everything here is locally exercisable — no live network path, unlike the Satori profiles —
so it is tested rather than verified by hand: `web-markdown.test.ts` (escaping and stream
safety), `auth.test.ts` (constant-time compare, throttle, expiry), `protocol.test.ts` (strict
rejection), `room.test.ts` and `index.test.ts` (the adapter contract), `server.test.ts` (real
sockets: the auth gate, the CSRF locks, the download headers, and that `stop()` terminates
with a stream open), `page.test.ts` (the script parses with every build marker filled, the shell
carries no inline script for the CSP to refuse, the boot config holds what the server decided, and
nothing was eaten).

`server.test.ts` also holds the asset route: the immutable JavaScript and CSS headers, the page's
two files open before sign-in while the code view stays guarded, every spelling of a traversal that
must 404, and the pin that only `/assets/` and `sw.js` handle a JavaScript content type — with a fake ttyd serving one through `/term/` beside it, which
is what keeps that pin honest about its own scope. `page.dom.test.ts` drives the reader through a
fake `window.__fhCodeView` — an editor for a text file, destroyed when another file replaces it
and when the window closes — through a bundle that will not load (the `<pre>` returns, and the
console is warned exactly once however many files follow), and through a page with no bundle at
all.

**`page.dom.test.ts` runs outside the coverage run** (`npm run test:coverage` is two vitest
runs). Every test compiles the whole page script again in a fresh jsdom realm, and V8's precise
coverage keeps counters for every script it ever compiled, whatever `coverage.include` later
reports — so under `--coverage` the file's heap grew with its test count and the worker died at
the 258th of 623 (2026-11-18, after the git and file windows). Those counters measured nothing
anyway: what each test evaluates is the bundle, inlined into the page as a string, not the module
`src/**/*.ts` matches. The file
also closes each test's windows after it (`liveWindows`), which is what keeps the plain run near
800 MB; a test that opens a window outside `open()` should close it itself.

**What the tests load (`page.test-helpers.ts`).** The served page links its script and
stylesheet, CI runs without `npm run build:assets`, and jsdom fetches no subresource; so the helper
builds both with the same `buildClient()` the asset build calls — once per worker, the suite being
`isolate: false` — and puts them back inline where the shell links them. It offers the page in two
forms sharing one shell (and so one build hash): **built**, the bundle and stylesheet exactly as
shipped, which `open()` loads and the DOM tests run; and **source**, the files as written in
`client/`, which `renderPage()` returns for assertions about text — esbuild reprints both, so a
CSS rule or a line of script pinned as text must be read from the source. The helper's `renderPage`
and `servePage` keep the old positional signature (the code view's URL fifth).

The `page.dom.*.test.ts` files (`chrome`, `core`, `i18n`, `layout`, `sending`, `theme`, `topics`)
together with `page.dom.wb2-*.test.ts` and the colocated `client/features/**/*.test.ts` unit suites
cover the client script's *behaviour* (the legacy pre-workbench `page.dom.{editors,panels,library,settings}.test.ts`
files were retired once the workbench feature tests and `test/e2e/webui/` covered those views). `page.dom.*.test.ts` loads what the
daemon serves into jsdom, stubs `EventSource` and `fetch`, and drives the page through the
events `room.ts` actually emits — asserting on what a person would see: messages on screen, the
drawer open or shut, where the URL points. Add to it whenever you touch `page.ts`; the string
assertions in `page.test.ts` were green throughout the release that rendered nothing. The skills
page is driven there too: the list, an editor save carrying the version the detail read, the New
form, a revert, the two-tap archive, the copy mark on a row and on a skill's page (with and without
`navigator.clipboard`), the cached open and its silent refresh (drawn once when the answer is the
same, redrawn when it changed, quiet when it failed), the manual refresh over unsaved text, a list
answer a switch made stale (dropped and asked again), an archive suggestion in Reviews doing the
same with the window shut, a show re-opened after a switch interrupted it, two shows racing, a
refresh held behind a switch, the refresh button turning a silent request into a manual one, a
cache of the wrong shape or a malformed row, a daemon with no store keeping no cache, and a reload
that starts from `aa_skills`. So is the task form — **+** opening it from the daemon's defaults and Add sending `schedule add`'s
fields, a refusal kept on the form, the fields following the kind and session it is switched to,
a change of kind sending what the new kind runs with, and "Posts to" moving a task to another topic
or an id typed in. So is the settings page — the menu's quiet request, a
typed `/setting`, a row tap, a retired screen, and every way out — and the scheduled panel's
drawer is asserted by slicing the `@media(max-width:1023px)` block, since jsdom cannot evaluate
it. The Reviews tab is driven there too: the list (and the absence of a quota line), a review
opened for its changes
and undo command, the link back to a topic that exists and its absence when the topic is gone, the
inferred old record, all three empty states, and the pending suggestions: a Dismiss that posts
the suggestion and redraws from the answer, an Adopt that opens a topic with the draft and sends
nothing, the dismissal that follows a message carrying the draft, a draft replaced before sending
that leaves the suggestion alone, and a refused topic that says why. The two side panels are
driven as one component
there (`one panel component on both edges`):
both close with the same ×, both go inert while shut, Escape puts away the right and then the
left, each keeps its own width and clears it on a double-click, and the footer's two menus are
checked by the items they hold and what each item does — All settings, Skills, Close idle. The
pinned state row is driven on both lists: on screen with the panel shut, filtering from a chip
without opening it, surviving a reload, and leaving the Filter dot to the panel's groups. The
History tab is driven there as well: the two tabs and what each hides, the list read again on
selection without blinking, a second page appended from the cursor, a failed page kept beside its
button, an IME Enter, "30+", a search and the list coming back when the field is cleared; a
conversation opened with the transcript's own markup (compared bubble for bubble with `#log`), its
lines folding on their own, the cut note in the bar, the three read-only sentences and the topic
link following the list, every way back (Close, the Topics tab, a link out of the record, the topic
link), no seen mark and no paste or drop while covered, the phone drawer, nothing remembered over a
reload, a failed read, and the daemon with no library at all. Sixteen mutations of page.ts, one per
decision above, each fail a test there (`project-scripts/talkcode-history-tab/mutate.py`).

The terminal panel is driven there too: it docks under the composer with the transcript still
painted, a drag on its divider is the height it writes to `aa_term_h` and reads back on the next
page, the arrow keys and a double-click move it, and a topic switch leaves the frame mounted.

So is a topic row's agent legend: the title line without the tag, the legend's text, harness class
and full-id tooltip, the daemon's binding winning over the title's tag, the uncoloured fallback to
the tag and no legend without either, `@host` dropped only when the line below names that host, and
the same legend on the Sessions tab and a task's page — with the Agent chips and the search reading
the same answer. Its stylesheet (the split background, the shared palette) is pinned as text in
`page.test.ts`. Where it sits — on the frame line, clear of the dot, title, badge, fold, star and a
hovered ⋯, and of the row above — was measured in Chromium on 2026-11-20 at 1280 and 390 px
against the real `WebRoom` (`project-scripts/fleetherd-topic-row/`).

So are [code blocks](#code-blocks-in-a-reply), through a fake `highlighter` on `__fhCodeView`: Copy
and its check, Wrap surviving an edit, a finished reply coloured with its text unchanged, markup in
the code staying text, one request per language, a language with no grammar and a patch left as
they came, a running turn's newest message held plain until the turn ends or a newer one follows,
a re-render coloured again in the same task without a second parse, a failed grammar warned about
once, a page with no bundle, and the file reader. Ten mutations of page.ts, one per decision in that
section, each fail one of them.

Four things about it that are not obvious:

- **The stubs are installed in `beforeParse`**, before the inlined script runs. Evaluating the
  script a second time to hand it a global would register every listener twice. `indexedDB` is
  one of them — jsdom does not implement it at all, so the harness installs a `fake-indexeddb`
  factory. It can hand the SAME factory to a second page, which is how a reload, and a daemon
  restart under a page that is still open, are driven end to end; passing `idb: null` covers the
  browser that has none.
- **Do not assert CSS through the CSSOM.** jsdom does not evaluate `@media` at all, so
  `getComputedStyle` only ever reports the desktop cascade — and its CSS parser silently drops
  declarations it cannot parse (jsdom 27 discards `calc(… + env(safe-area-inset-bottom))`
  outright) while normalizing selector text, so assertions fail on rules that are perfectly
  correct. The narrow-screen rules are asserted by slicing the `@media` block out of the served
  CSS as text, which also proves they are *inside* it rather than leaking onto the desktop
  layout. The script's own `narrow()` branches do respond to `innerWidth` and are driven
  normally.
- **`jsdom` is pinned to `^27`**, because CI runs Node 20 and jsdom 28+ nests an undici that
  needs a newer one. Read the note in `package.json`'s `comments.pinnedDeps` before bumping it.
- **There is no layout, so scrolling is faked.** jsdom reports every rect and every `scrollHeight`
  as 0, so without help `atBottom()` is always true and nothing about [switching
  topics](#switching-topics) can be seen. `layout()` gives `#log` rows of a fixed height. It
  clamps `scrollTop` after every change to the log's children, as a browser does at its next
  layout. Without that clamp, a position set before a topic was left would still be sitting in
  the stub when the topic came back, and a page that restored nothing would pass. The fake shows
  *which* message a reader lands on. It cannot show whether the landing looks right, so that part
  was checked in real Chromium.

The suite is mutation-checked: restoring the sync-guard bug fails eight tests, removing the
backdrop element fails the whole file, and dropping the 16px field rule, the safe-area padding,
the collapsed-drawer offset or the narrow-screen focus guard each fails exactly the test that
names it — including when a rule is *moved out* of the `@media` block rather than deleted. The
same was done for switching topics: fifteen mutations, one per decision in that section, and
each fails the test written for it. And for the unsent store: seventeen mutations, each caught by
the test that names it. Its real-browser half was checked on 2026-10-24 in Chromium against the
real server behind a proxy that played the four failures (an Access 302 to another origin, a send
swallowed, an answer lost, the browser offline); the same run against the code before it lost the
draft and put the restored failure at the top.

### Real-browser E2E (`test/e2e/webui/`)

Layout, responsive breakpoints, drawers, and real SSE/login flows are covered by Playwright tests
under `test/e2e/webui/` (`smoke.spec.ts` plus reusable `harness.ts`, `fake-agent.mjs`, `seed.ts`,
and `fixtures.ts`). Each test run starts an isolated gateway in a temporary `HOME` on a random
loopback port with `FLEETHERD_*` and `TALKCODE_*` stripped from the child environment, backed by a
fake ACP stdio agent.

Build the web UI assets first, then run the suite:

```bash
npm run build:assets
npx playwright install chromium   # once, if using local Chromium
npm run test:e2e
```

To run against a remote Chromium instance over CDP instead of launching a local browser, set
`PW_CDP_URL` (and optionally `PW_CDP_HEADERS` as `Key: Value` lines or a JSON object):

```bash
PW_CDP_URL=http://127.0.0.1:9222 npm run test:e2e
```

Failure screenshots, traces, and videos (local/CI) are written under `test-results/webui-e2e/`.
In GitHub Actions, `.github/workflows/webui-e2e.yml` runs independently from `release.yml`.

## Icons

Nothing on this page is an emoji or a symbol glyph any more: every mark the page draws itself is a
hand-drawn inline SVG from `icons.ts` — 24×24, unfilled, stroked in `currentColor`, sized to 1em
by `.ic` so it takes the size of the glyph it replaced. A glyph is drawn by whatever font the
reader's system has: the page looked different on every machine, colour emoji ignored the
palette, and a symbol a font lacks is an empty box (why the power button was an SVG first).

The text that reaches every platform is unchanged — a chat message cannot carry an SVG, so core
and the daemon still write `✅`, `☑ EU`, `💻 Bash: …`. The swap happens where this page shows it:

- **Tool bubbles**, on the server: `renderWebToolLines(text, toolGlyph)`, so the markup is tested
  in TypeScript like the rest of the converter.
- **Menu marks** (`●` `☑` `☐` `⌂`), **page arrows** (`◀ Prev`, `Next ▶`, `‹`) and **lifecycle
  reactions** (`👀` `✅` `❌`), in the script: `clientIcons()` is written into it as `IC`, keyed
  by the glyph core and config write. A mark is a 1em icon where `labelWidth` counted one column,
  so a menu with marks adds the difference (`--mk`, `1em - 1ch`) to its column width.
- **The page's own controls** (☰, the gear, the star, a fold's arrow, ✓ in a list, the microphone
  and its stop square, `>_`), straight in the markup.

A glyph with no icon stays the text it is: an operator who sets `tools.emojiMap` or
`inbound.reactions` to other emoji sees those emoji. `icons.test.ts` fails if a default in
`config/schema.ts` gains a value with no icon. Copying a tool line copies its text without the
emoji, since an SVG has none; the conversation library keeps the text as it was sent.
