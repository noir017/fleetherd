# `src/platform/webui/` — the built-in web UI

A browser chat page the daemon serves itself, wired in as a ninth platform. No account, no
bot token, no upstream service: `talkcode start`, open the page, type.

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
still fails to compile until it is listed. The shape is the same one
[`daemon/agent-agy.ts`](../../daemon/README.md) uses: a sibling runtime, not a pretend member
of a protocol it does not speak.

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
| `page.ts` | The whole page (HTML + CSS + JS) as a module-level string |
| `manifest.ts` | The web app manifest and the icon, as strings, for the same reason `page.ts` is one |
| `webpush.ts` | Web Push, server half: the VAPID key, the subscribed devices, RFC 8291 encryption, the endpoint allowlist |
| `sw.ts` | The service worker (`sw.js`) as a string: shows a push, opens the topic when it is tapped — and nothing else |
| [`../web-markdown.ts`](../web-markdown.ts) | Markdown → escaped HTML; lives with the other converters |

`room.ts` is deliberately free of HTTP so the adapter's behaviour is testable without opening
a port — which is what `room.test.ts` and `index.test.ts` do.

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

**Past 64 topics the oldest one goes, unless something is holding on to it.** `topics.ts` used to
refuse the 65th outright, on the grounds that evicting a topic orphans its session. In use that
reached 64 in two weeks (a new-session scheduled task adds a topic per run), after which `+` did
nothing at all — the 409 never reached the screen — and every scheduled run fell back to posting
into the chat. Orphaning costs exactly what a `×` costs, which people press all the time; so now
`WebRoom.createTopic` evicts the least recently active topic first (`makeRoom`), logging its id and
title, since that line is the only way left to find the session it leaves behind.

A topic is passed over when evicting it would *break* something rather than merely orphan it:
mid-turn, asking a question, an agent resident, a terminal attached, or the target of a scheduled
task that can still run (`PlatformAdapter.useScheduleLookup` — a task posts to a plain address and
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
  bounded by the 64 topics times 500 messages. A star now only keeps a topic from eviction and the
  sweep. Deleting, evicting or sweeping a topic removes its file, and a file whose topic is gone when
  the daemon starts is removed too.
- **Written within 3 s of a change, not 3 s after the last one.** The first change arms the write
  and later ones ride along, so a reply streaming for minutes is on disk every few seconds, and a
  kill mid-reply costs at most that much. `dispose` writes whatever is pending on the way out — but
  the 2026-10-31 case did not need it: the reply had been on disk for seven minutes.
- **Each message keeps the run it was said in** (`WebMessage.g`, that run's sync `epoch`), through
  any number of restarts. The page keys a message by `<generation>:<id>`, so this is what lets a
  restored message land on the copy its own cache has rather than beside it — a half-finished tool
  line is brought up to date, and the messages the page never received are added after it, in order
  (`page.dom.test.ts` pins this) — and what makes it history: no buttons, above the divider. Buttons
  are stripped on the server too, since the process that would answer them is gone.
- **The id counter starts past every restored id.** `nextId` restarts at `w1` each run, and the
  ring is a map by id, so a new `w5` would overwrite a kept one.
- **What is kept is what the ring had**: up to 500 messages. A file the agent sent comes back as
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
lookup instead (`PlatformAdapter.useWorkdirLookup`), and `topicList()` asks it — memoised for
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

**A row's ☆ and × take no room until they show.** On a pointer device they appear only under the
pointer, and until 2.11.1 they were merely `opacity:0` — still in the flex row, so every title in a
240px column got 129px and stopped in front of a 59px strip of nothing (measured in Chromium).
They now sit in one `.topic-acts` box that floats over the row's right end inside
`@media(hover:hover)`, on a fade into `--row-bg`, the row's own colour, which is why that colour
is a variable. A starred row at rest keeps the box in the layout, because its lit star is content
a title must not run under, and drops its × from it. Touch screens are untouched: no hover, so
the buttons are always on screen and keep their room. `page.dom.test.ts` pins the rules as text,
since jsdom has no layout; the widths above, and the title's 188px after, were measured in real
Chromium on 2026-10-30, along with where a click on either button lands once the row is hovered.

**The dot on each row is about the agent, not about the turn.** Four states, and two of them
exist because "a turn is running" turned out to be a bad proxy for both of the things a person
actually reads that column for:

| dot | means | where it comes from |
|---|---|---|
| grey | nothing resident — history, or a topic that will have to resume from a session id | the absence of the two below |
| dim blue | an agent child is up and idle | `PlatformAdapter.useLivenessLookup` |
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
sidebar footer beside Settings; it shows the count and is hidden at zero. Unlike the power button it is
not a typed command, and that is deliberate: a `/kill` per topic would leave an echo and an ack in
every room it touched, twenty messages for ten topics. Instead `POST api/topics/close-idle` carries
the ids, `WebRoom.closeIdle` hands each to the daemon (`PlatformAdapter.useIdleReclaim`), and the
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
countdown; agy's quota pools. The daemon pushes it (`PlatformAdapter.setStatus`, from
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

Closed, the strip is one line, shows only the quota pools the serving model spends from, and on a
narrow screen drops the token counts beside the meter (the percentage says the same). A tap opens
it: it wraps, and the other pools appear, dimmed.

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
  `PlatformAdapter.useAgentCatalog` → `ConversationRegistry.agentCatalogForRef` answers undefined
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

No online/offline mark on a machine, though one was considered: a host's link closes itself after
five idle minutes (`remote/connection.ts` IDLE_CLOSE_MS), so "not connected" mostly means "not used
lately", and marking it would grey out healthy machines.

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
only when the topic on screen is in `review` and the page is visible; the room stamps `Date.now()`.
It is compared with a turn's end, which is the daemon's time, and a phone's clock is nothing to
compare a server's with. Posting only on `review` keeps the traffic to one request per reply read.

**A menu is not a question** (`awaitingQuestion`). The room's `awaiting` set is "messages with live
buttons", which was the same thing while every such message was an ask. Since a new topic's choice of
agent is a tap that types `/agent` (2026-11-02), the daemon also posts the *directory* menu into a
conversation that has not started — and that menu, counted as a question, pinned the topic to the top
in green and pushed "Waiting on your answer" about a topic with no agent in it, which the operator had
just been looking at. The menu is a control for the operator's own next step, so `topicList` asks
`awaitingQuestion` instead: a message whose buttons are all a directory menu's (`core/workdir-menu.ts`)
does not make the topic `answer`. `awaiting` itself still holds it, because `inUse` must not evict a
topic with a clickable menu and idle reclaim must not close the agent under one. Unrecognised buttons
count as a question, so a new kind of ask is announced rather than silently missed.

**Sub-agent topics** (daemon/delegation.ts) carry `parent`, the topic whose agent opened them —
persisted, and the only record of the relation (`parentOf` / `childrenOf` on the adapter read it back).
`TopicStore.orphan` drops a `parent` that names a topic no longer there, on load and after every
delete or sweep, so the × on a parent never takes its children with it. The page nests them
(`topicRows`: what needs you first, then each root by state — working, resident, no agent — with a
starred row leading its unstarred peers inside a state, each followed by what it opened, depth-first;
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

A link to another topic is `?t=<id>` — the one relative link `web-markdown.ts` keeps — rendered with
`data-goto`, which the page intercepts to switch in place.

**Low attention** (2.20.0) is the same list drawn quieter, per browser (`aa_calm` in localStorage,
applied as the script starts so a reload does not flash the pulse back): `#app.calm` stops the
running dot's pulse and turns the unread count grey, and touches nothing that needs the person — the
amber dot still pulses, and the green rows above are unchanged. It is CSS over the same markup on
purpose: `page.dom.test.ts` checks that the rows are identical either way and that the stylesheet's
`#app.calm` rules are exactly those two, so a rule that quiets a question or a failure fails there.

**The sidebar footer is one row, two menus**: ⚙ Menu and ⋯ Manage (one row since 2.20.0, split
in two when the three buttons stopped fitting).
Menu holds All settings, Notifications, Low attention and Skills — things set once per device or
visited rarely. Manage holds Close idle and Clear all topics, and carries the idle count on its own
face so the number is still seen without opening anything. The two menus are the same box, opened
upward over the list, one at a time, and dismissed by a click outside either (the drawer's backdrop
included) or Escape, which also gives the focus back to the button that opened it (`setMenu`). The
footer is a size container: at the narrowest sidebar (180px) both words drop and the row
is ⚙ and ⋯(N) — the count is the one thing that stays.

## The two side panels

The topic list on the left and the scheduled work on the right are one component (`makePanel` in
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

## The scheduled-task panel

The clock at the right of the chat header toggles a panel of the gateway's scheduled work. It is
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

**Two tabs, at the foot of the panel.** **Sessions** is the topics a new-session run opened
(`Topic.scheduled`): the switcher leaves those out (`topicRows` filters them), so the tab is their
only listing and its × is the only delete. **Tasks** is the definitions and their controls. The tab
row is the panel's last line — literally the same `.panel-foot` the sidebar keeps its menus in — so
the two columns end together. Sessions needs no request of its own — the `topics` event that keeps
the switcher current carries their titles, state, message counts and unread marks, so a run that
starts or finishes moves the tab as it happens. Tapping a row opens the topic and leaves the panel
where it is. A run holding a question puts an amber dot on the clock (`#sched-alert`), because it
has no row in the switcher to show it there.

A task card is four lines, in the order the questions come: the name (with a state word only when
it is not the ordinary `active`), the schedule, the next run and the target, and the last run — red
only when it did not end `ok`. The prompt or command, the run mode and the bookkeeping are behind a
tap, so a column of tasks stays scannable.

**Data.** `useSchedulePanel` (`../adapter.ts`) hands the room the task list and the four
operations; the daemon builds it in `daemon/schedule-panel.ts` from `ScheduleService`, the same
service the agent's `schedule` commands and `/setting schedule` use. Two routes carry it:
`GET api/schedules` and `POST api/schedules/op`, the latter validated by
`ScheduleOpRequestSchema`. The task list pulls when the panel opens, after every action, and on a
timer while visible (5s while a run is in flight, 30s otherwise) — the daemon has no event for a
run finishing. Countdowns ("in 3h 12m") are computed from `nextAt` on the client; every other time
arrives formatted in the task's own zone.

**What it cannot do.** It does not create tasks. Creation is a sentence to an agent in a topic, and
letting the page POST a prompt or a command would put a bash injection surface behind the login
form. Deleting asks twice, like the chat menu, and a refusal from the daemon is shown as its own
sentence rather than a generic failure.

## The skills page

**Skills** in the ⚙ Menu at the foot of the topic list opens the gateway's managed skills — the
records `daemon/skills-store.ts` keeps and `talkcode skills` writes. It is a window over the
transcript, like the reader, rather than a third column: an editor and a history row need more
width than a sidebar, and the conversation stays visible around it. On a phone it takes the whole
screen.

**What it does.** The list is every skill with its status, pin and last use; **New** creates one
from a name, a one-line description and an optional body; a skill opens onto its files, a
`SKILL.md` editor and every recorded change. **Delete** archives it — **Restore** brings it back —
and there is no hard delete, here or in the store. Saving `SKILL.md` sends the version the page
read, so a stale edit is refused rather than overwriting a newer one; extra files go through
`write-file`. **Restore this version** is `revert`, and is itself recorded as a new change.

**Data.** `useSkillsPanel` (`../adapter.ts`) hands the room the list and every operation;
`daemon/skills-panel.ts` builds it from `skills-store.ts`, the same functions the reverse command
calls, and passes `notifySkillArchived` so an archive made here tells the conversation that created
the skill exactly as one made from a chat does. Two routes carry it: `GET api/skills` and
`POST api/skills/op`, the latter validated by `SkillOpRequestSchema` — a discriminated union with
no `delete` arm, so a body the page could not have sent is refused before it reaches the store.

**The page is a window, not a column.** `#skills` is one node with two views inside it (the list
and the open skill), opened from the sidebar footer and closed by the ×, Escape, or the backdrop.
Nothing about it is persisted: a management surface is opened on purpose, and one restored on load
would sit over a conversation nobody asked it to cover.

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
- **The worker caches nothing.** It has no `fetch` handler, so every request goes to the network as if
  it were not there; the [rule below](#installing-it-as-an-app) against a worker was about a cached
  app shell, and still holds. `sw.js` is served open (the browser re-checks it on its own schedule),
  `no-cache`, under a CSP of its own; the page's CSP gains `worker-src 'self'`, which names where a
  worker may come from and lets no same-origin file run as a page script.
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
| `settingsScreen` | ✓ | The only platform that declares it: `/setting` is drawn as grouped rows from the structured screen the daemon sends, not as the button grid. Every chat platform keeps the grid (see [Menus](#menus)) |
| `menuPageSize` | 24 | Core's ceiling, twice the chat platforms' 12. The page draws a menu as a grid (`menu()` in `page.ts`), so 24 is fewer rows here than 12 is on Telegram, and a page of long model ids is still one phone screen |
| `paceByLane` | ✓ | The only platform that declares it: each topic gets its own outbound budget instead of queueing behind every other topic's streaming |
| `slashCommands` | ✓ | *Received*, as ordinary text, exactly like Telegram — `registerCommands` only feeds the page's autocomplete |
| `slashNeedsAck` | – | There is no interaction to close out |
| `maxMessageLength` | 20000 | Not a platform limit. A ceiling so one runaway reply does not become an unbounded DOM node redrawn several times a second |
| `maxEditsPerMessage` | unset | Nothing here ever refuses an edit |
| `toolPreviewLimit` | 2000 | The only platform that declares one: see [Tool bubbles](#tool-bubbles) |

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
  the command and never the ✓ — the one part that says the tool is done.
- **The page** keeps which lines are open per message key, in script state rather than as a class
  on the element: a bubble is edited at every tool start and finish, and each edit rewrites its
  markup, so a class would snap shut at the next ✓. `foldLines` stamps the state into the markup
  before the `sig` comparison, so an open line costs no extra DOM writes. A click that ends a
  text selection does not toggle — copying part of a command is the other thing done here.

Real-browser layout (a folded row is one line high, the ✓ stays inside it, an opened row wraps
instead of widening the transcript) was checked in Chromium at 1280 and 390 px against a live
daemon on 2026-10-10; jsdom has no layout and cannot see any of it.

## Menus

Every message with buttons — `/cd`, `/model`, `/agent`, an `ask` — is drawn by `menu()` in
`page.ts` as a grid (2.14.0; before that, buttons wrapped like words and a page of directories was
a ragged block). Columns are sized from the widest label, so short names get more of them, and there
are never fewer than two: a label longer than half the row wraps inside its cell.

`/setting` is the exception, and it is not a menu at all. A chat app has only buttons, so its
settings rows squeeze the label and the value into one 40-character string; a page does not have
to. The daemon declares `settingsScreen` for this platform, builds the same menu as a
`SettingsScreen` (`WebMessage.settings`), and the page draws it in a window of its own
(`#settings-page`) instead of in the transcript: a section per group, a row per setting with the
label and its whole current value on separate lines, and a value list whose current option is lit
and ticked. Nothing on the page parses a label for it — the groups, values, current marks and
button ids all arrive as data, which is what makes a long model id readable instead of
`(harness …`.

The page opens from **All settings** in the ⚙ menu, or when the daemon answers a typed
`/setting`. The menu's request is sent with `quiet: true` (`SendRequestSchema`, `WebRoom.record`),
so the daemon gets the command but the transcript gets no row and the topic is not named
`/setting`; a typed command is the operator's own message and stays. The page is bound to the
topic it opened in and closes when that changes — the agent and model rows are that
conversation's — and its bar names that topic. A settings message is never painted: `upsert`,
`reconcile`, `adopt` and `paint` all skip one. A retired screen is marked `wasSettings` by
`room.revise` (only when it keeps no buttons — a message handed to the scheduled-task list is a
menu again and must show), so a reload cannot turn its farewell line into a chat message. Closing
the page records the message id, so a late edit does not reopen it; a new `/setting` is a new
message and does. `page.dom.test.ts` pins the list, the current mark, a row tap, Back and paging.

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

**Everything is compressed**, the event stream included — which is the part with a trap in it.
A gzip stream buffers until told otherwise, so each event is followed by an explicit
`Z_SYNC_FLUSH`. Without it the page receives nothing until the connection closes, which is
indistinguishable from a hung daemon. `server.test.ts` pins it, and the test hangs rather than
failing an assertion if the flush goes away — which is the honest reproduction.

**Sends are idempotent.** A POST can be accepted and still time out on a bad link, so the page
retries — which is only safe because each send carries a nonce the server remembers. The
daemon's own inbound dedup cannot help here: it keys on a message id, and a retry mints a fresh
one. That nonce comes back out on the echo (`WebMessage.nonce`), which is how the page knows
which of its local bubbles the echo is.

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
`sendLimit(body)` — 15 s plus 1 s per 64 KiB, capped at the 300 s Node's `http.Server.requestTimeout`
already allows a body. It is scaled because the same page sends a line of text and a 20 MB file. An
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
blank whenever the daemon did. Now the browser keeps its own copy, in **IndexedDB** — one record
per topic, holding the message list as a JSON *string* rather than an object graph, so the byte
budget below is measurable and nothing rests on how a structured clone treats these objects.
localStorage was the obvious alternative and is too small: one topic with code blocks in it runs
to hundreds of kilobytes against a ~5MB origin budget shared with everything else.

It buys two things:

- **A topic paints before the stream has answered** — on a reload, on a topic switch, on a link
  slow enough that the round trip is visible.
- **A daemon restart costs the conversation its liveness, not its contents.** The old messages
  stay on screen, above a divider that says where they came from, and the agent still has the
  context to carry on below them.

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

**Rotation, because a cache that only grows is the same bug more slowly.** The TAIL of a topic is
kept (200 messages, 512KB), the least recently written topics are evicted past 24, and a write
refused for space drops everything but the topic being read and tries once before the cache is
written off for the session with one `console.warn`. Writes are coalesced into a 400ms window:
a streamed reply upserts the same message every second or so and each one would otherwise
re-serialise the whole topic.

**A browser with no IndexedDB is a supported configuration.** Private windows and old engines
both produce one; the cache is the only thing that goes, and `page.dom.test.ts` holds that.

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
viewport. A scrollTop would not survive the way back in. The transcript is rebuilt from the cache,
which keeps the last 200 messages, and then reconciled against a ring of 500. So on a long topic
the sync inserts older messages *above* the one being read, and a restored offset would land that
many rows off. A binary search over `#log`'s children finds that message with one forced layout,
not one per message.

- **At the bottom means "follow along", and it is recorded as no entry at all.** A topic left at
  the bottom comes back at the bottom, with whatever was said while you were away on screen.
  Putting you back on the last message you saw would leave the new ones under the fold, which is
  the opposite of what you were doing.
- **`land` runs twice on the way in, and the second time is conditional.** It runs first when the
  cache paints, which is the first real paint, so there is no visible jump. It runs again when
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
84.6–90.7ms before and 88.6–92.6ms after, which is within run-to-run noise. The cache read
(~7ms), `adopt` (~20ms) and the sync handler (~35ms) are where a switch spends its time, and none
of them changed.

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

**The page reconciles; it does not rebuild.** A `sync` carries the whole topic, and the obvious
reading of that — empty `#log`, paint it again — is what made entering a topic jarring: the
scroll container was destroyed along with its position, so a topic already painted from the
session cache still flashed through blank on its way to looking identical, and every message
re-ran its entrance animation. Instead each message in the sync is upserted by id, moved into
place (`appendChild` on a node that already exists moves it rather than cloning it), and
anything the sync no longer carries is dropped. `paint` writes no DOM at all when the markup it
builds matches what is there, so an unchanged message is genuinely untouched — which is also
what keeps a repaint from undoing the disabled state of a button the click handler just set.

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

Off by default. Turned on, the chat header grows a `>_` button that opens a terminal **window**
over the transcript — a shell in this machine, in which any coding-agent CLI can be run
directly, TUI and all.

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

### A window per topic, and what its two buttons mean

The window belongs to a topic, not to the page. Its title bar carries exactly two controls, and
the whole design is in the difference between them:

- **Minimize** hides it. The iframe stays mounted and its WebSocket stays up, so coming back is
  a repaint rather than a reconnect — and the switcher's marker stays lit.
- **Close** ends the session, after a confirmation. It is a server round trip, not a teardown,
  because dropping an iframe only hangs up on a shell that carries on without us.

Switching topics therefore does not move one window around: each topic keeps its own, mounted
and attached until it is closed. The alternative — a single window following whichever topic is
on screen — hangs up on the topic being left, which surprises (the terminal you minimized is
gone) and makes the marker meaningless, since at most one topic could ever be lit.

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
      socket: /home/user/.config/talkcode/webui-term-web.sock
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
8. **An upgrade is gated separately, because it has to be** — it never reaches `route()`, so
   nothing above applies to it automatically. See [the terminal pane](#the-terminal-pane).

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
their names did). The page drops the bytes once they are sent — they are base64 in a request
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
`{ name, size, shown, html }`. The `html` is `reading.ts`'s — `renderWebMarkdown` for a `.md`, the
file's text through `escapeHtml` inside a `<pre class="src">` for everything else on its list — so
the page puts into its DOM exactly what it already puts there for every streamed reply, under the
same CSP. An `.html` or an `.svg` is on that list *as source*: the browser never receives the file,
so there is nothing that could render it.

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
the app shell, and the shell is served `no-store` on purpose: a stale copy after an upgrade is
a support question with no error message. If offline reading is ever wanted, the local
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
  (with a `bye` event, because `EventSource` reconnects after a *clean* close too), then
  `closeIdleConnections` / `close` / `closeAllConnections`, behind a timeout. Get this wrong
  and Ctrl-C hangs the daemon forever, because the signal handler's `process.exit` lives in
  that promise's `finally`.
- **A reverse proxy must not buffer**, and must not strip `Content-Encoding` without
  re-adding it. `proxy_buffering off;` in nginx.
- **`page.ts` is invisible to the toolchain.** Not typechecked, not linted — to TypeScript it is
  a string. So the script is kept stupid, uses string concatenation rather than template literals
  (a literal `` ` `` or `${` would be eaten by the surrounding template and become a module-load
  error), and any change that needs a new *decision* belongs on the other side of the wire. It
  is no longer untested, though: `page.dom.test.ts` runs it in jsdom, and a behavioural change
  in there should arrive with a test, because nothing else in the repo can see it.
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
  the token field are 16px so Safari does not zoom in on focus and stay there, the Send row
  clears the home indicator via `env(safe-area-inset-bottom)`, the drawer toggle is padded out
  to a 44px square (a `:not([hidden])` selector, because the rule sets `display` and would
  otherwise beat the UA's `[hidden]` rule while the drawer is open), and the input is not
  focused on open — the keyboard would take half the viewport before a word had been read.
- **Enter sends; under the narrow-screen layout it writes a newline instead.** 1.22.0 made it a
  newline at every width, and the half of that which was right is the phone: held upright there
  is no Shift key to hold, so Enter-to-send makes a multi-line prompt impossible to type rather
  than merely awkward, and a stray Enter costs a half-written one. Neither is true of a keyboard,
  where Shift-Enter is right there and every other chat app on the screen sends on Enter — so
  paying the phone's cost on a desktop bought nothing. `narrow()` is read per keypress, because
  rotating a phone and dragging a window both change the answer. Ctrl/Cmd-Enter sends on both.
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
with a stream open), `page.test.ts` (the script parses and nothing was eaten).

`page.dom.test.ts` is the one that covers the client script's *behaviour*. It loads what the
daemon serves into jsdom, stubs `EventSource` and `fetch`, and drives the page through the
events `room.ts` actually emits — asserting on what a person would see: messages on screen, the
drawer open or shut, where the URL points. Add to it whenever you touch `page.ts`; the string
assertions in `page.test.ts` were green throughout the release that rendered nothing. The skills
page is driven there too: the list, an editor save carrying the version the detail read, the New
form, a revert, and the two-tap archive. So is the settings page — the menu's quiet request, a
typed `/setting`, a row tap, a retired screen, and every way out — and the scheduled panel's
drawer is asserted by slicing the `@media(max-width:1023px)` block, since jsdom cannot evaluate
it. The two side panels are driven as one component there (`one panel component on both edges`):
both close with the same ×, both go inert while shut, Escape puts away the right and then the
left, each keeps its own width and clears it on a double-click, and the footer's two menus are
checked by the items they hold and what each item does — All settings, Skills, Close idle, Clear.

Four things about it that are not obvious:

- **The stubs are installed in `beforeParse`**, before the inline script runs. Evaluating the
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
