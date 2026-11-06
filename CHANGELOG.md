# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed

- **Antigravity (`agy`) now runs as `agy acp`, on the same runtime as every other harness.** agy 1.5
  ships an ACP server, so the stream-json protocol code written for it before is no longer what
  serves it, and agy gets what the ACP path already does: permission requests (`permissions: ask`
  now works for agy), `/stop` through `session/cancel` instead of killing the process, `/effort` on
  its Gemini models, pictures as images, and the `send_file` / `schedule` native tools. Measured on
  1.5.1 here and on a remote host before the switch: models named the `agy models` way
  (`gemini-3.8-flash-high`) are split into the model and its thinking level; the configured model is
  set again after every reload, which agy otherwise answers on its default; agy's own `⚠` warnings
  become notices instead of reply text, and a turn that ends on one — a spent quota, retries run out
  — now fails instead of passing as an answer; quota still comes from `agy -p=/usage`. One thing is
  coarser: agy reports usage once per turn, summed over its model calls, so the footer shows context
  only after a turn that ran no tool. The stream-json runtime stays as a fallback for an agent whose
  `env` sets `TALKCODE_AGY_RUNTIME: stream-json`, until every host has run the new one;
  conversations carry over in both directions.

## [2.39.0] - 2026-11-06

### Added

- **A sub-task can name its model, and goes to the asking agent unless told otherwise.** A
  sub-agent always ran on its agent's configured model, so a part that called for a cheaper or a
  stronger one could only be switched by hand in its topic, after its first turn had already run.
  `task-new --model <id>` now takes an id from that agent's `/model` list, checked the way
  `schedule add --model` checks it: one the agent does not offer is refused when proposed, with the
  list. The confirmation card and the card listing what started both name it, since the model
  decides what the part costs. It is applied before the first turn; a part that cannot switch to it
  does not start, says why in its topic and on the card, and never runs on another model instead.
  The topic keeps it afterwards, as if chosen there with `/model`. `--agent` is now optional: without
  it the part goes to the agent answering the conversation, which is what the `super` skill now
  does unless the person named another. [→](docs/sub-agents.md)
- **Sub-agent confirmation can ask each agent only once per conversation.** `delegation.confirm` —
  and `/setting delegation` — gained a middle tier, `first`. The first sub-task an agent is handed
  in a conversation still waits for Start on the card; once that card has been confirmed, later
  sub-tasks for that agent there start at once and post the record card, and a batch that mixes
  confirmed and new agents starts the former while putting only the latter on the card. The memory
  lives in the daemon's process, per conversation: a restart, another conversation, or a change of
  tier asks again, and a sub-agent's own topic still asks every time whatever the tier. `on` and
  `off` keep their meaning, including in existing config files. [→](docs/sub-agents.md)
- **The web UI draws sub-agent traffic as its own kind of bubble.** A card that hands work to a
  sub-agent — the confirmation card, the record of what started — and the task text a sub-agent's
  topic receives are marked **Sub-agent task** with a rail of their own; the `[sub-agent updates]`
  card is marked **Sub-agent report** and keeps its folded lines. The mark travels on the message
  itself (`SendOptions.kind`), so it survives a reload and a transcript restored after a restart,
  and every other platform shows the same text unchanged. [→](docs/web-ui.md)

### Changed

- **The web UI splits the composer into two rows on mobile screens.** Under narrow viewports (640px
  and below), the file upload, voice, Stop, and Send buttons shared the same flex row as the text
  box and squeezed it into a narrow sliver. The composer now wraps onto two rows below 640px: the
  textarea takes the full width across the first row, and the action buttons sit on the second row,
  with file attachment and voice recording on the left, and Stop and Send on the right. Desktop
  layouts and button states remain unchanged. [→](docs/web-ui.md)
- **Web UI Side tasks merges Scheduled tasks and Sessions into a single tab.** The side panel footer
  previously had three tabs (Sessions, Tasks, Reviews), which crowded the bottom row in narrow viewports
  and treated runs as top-level peers of definitions. The footer now holds two main tabs — **Scheduled**
  and **Reviews** — with Scheduled subdivided into **Tasks** (default) and **Sessions** under the header.
  The outer Scheduled tab shows both task and session counts (e.g. "2 · 1", or task count alone when
  there are no sessions) and the waiting-on-answer amber alert, keeping background work visible even while
  on the Reviews tab. [→](docs/web-ui.md#side-tasks)
- **Clear all topics in the web UI moved from the Manage menu to an icon beside Topics.** Placed
  beside Close idle in the Manage menu at the foot of the sidebar, the two actions were too easy
  to misclick. Clear is now an icon button in the sidebar header directly following the "Topics"
  title, using the broom icon, with its title and aria-label reflecting whether unstarred or all
  topics will be cleared. The confirmation step remains in place, and Manage holds Close idle
  alone (showing a disabled "No idle agents" when none are idle). [→](docs/web-ui.md)

### Fixed

- **Telegram no longer stays offline for good when it cannot connect at startup.** One 502 from
  Telegram's `getMe` as the daemon started was enough: adapter-telegram never waits on its own
  startup, so the failure surfaced only as an `[unhandledRejection]` line, the poll loop — which
  holds the adapter's only retry — never began, and the bot sat in "connecting" until the next
  restart while the daemon reported the instance `started`. Startup now retries a 5xx, a 429, a
  network error or a timeout after 5 s, doubling to once a minute, until it connects, with one line
  per attempt naming the instance, the error and the wait — the same holds for the requests between
  `getMe` and the first poll, which failed the same way. A 401 or 404, a wrong token, is logged as an
  error once and not retried. The bot token, which plugin-http puts in the URL of a failed request,
  is cut from these lines. [→](docs/platforms.md#when-a-platform-does-not-connect)
- **An instance that has not connected a minute after start says so.** Every platform instance with
  no bot online 60 s after start now logs a warning naming each bot's state, and logs again when it
  connects. The connection-state lines that were meant to make a dropped bot visible — online,
  offline, reconnecting — had never been printed: they read the status off the event's session
  instead of its login, found nothing, and fell through to a debug line. They print now.
  [→](docs/platforms.md#when-a-platform-does-not-connect)

## [2.38.1] - 2026-11-06

### Fixed

- **The web UI's model switch is there as soon as a new topic has an agent.** It waited for the
  first reply: the line above the composer hides the switch while the new-topic agent list is up,
  and it tested that against the sync's snapshot of the empty room, which nothing after a tap on an
  agent replaced. So the model the first message went to could not be chosen at all. The switch
  now appears the moment an agent is picked; opening it starts that agent to ask for its list, as
  it already did for a topic with no session yet. [→](docs/web-ui.md)
- **The model and effort chosen for a conversation are remembered.** Both lived only in memory,
  so a daemon restart dropped them, and `/new` and `/cd` — which replace the session object holding
  them — quietly put the conversation back on the configured model while the status line still
  named the chosen one. The new web UI flow made that the common case: pick an agent, pick a model,
  pick a directory, and the first message ran on the default. Both are now written to
  `conversations.json` when a person picks them (typed, from a menu or the web UI's switch; never a
  scheduled task's `--model`), applied to every new session, and put back after a session is
  reloaded — a harness that reloads at its default model would otherwise have dropped the choice on
  the first idle reclaim. `/new`, `/cd` and restarts keep them; choosing another agent for the
  conversation forgets them, since its lists are different ones. [→](docs/chat-commands.md#model)

## [2.38.0] - 2026-11-05

### Added

- **Auto review can be turned on and tuned from chat and the web UI.** `review.agent` and
  `review.model` were config.yaml-only, so the feature could only be switched on from a shell on
  the machine that runs the daemon. `/setting review.agent <agy agent>` (or `off`) and `/setting
  review.model` now write the same fields through the same validated patch path as every other
  setting, and the web UI's settings page has a Reviews section for them. Only `agy` agents are
  offered or accepted, because a review is one `agy -p` with every tool denied; any other id is
  refused with the reason rather than saved to fail at the next sweep. The model follows the
  reviewer's own until one is set, and is chosen from that agent's list when it can be asked for —
  a name typed while no list is available is saved as typed, and the ack says so. The reviewer is
  checked against the agents the files actually declare — config.yaml plus each host's pod.yaml —
  before the write, so a row left over from a failed `/reload` is refused instead of producing a
  config the next start rejects. Both fields are read from the live config at the start of every
  sweep, so a change lands within a minute without a restart. [→](docs/settings.md)

### Changed

- **Automatic review no longer has a daily cap.** Ten reviews per UTC day was meant to bound a bug
  that kept finding candidates, but it spent the whole budget on the backlog the first time the
  feature was switched on: with sixteen eligible conversations, the first sweep took ten of them
  and the rest were never looked at that day. The cap is gone; one review still runs at a time,
  and a failure still backs off six hours. The same batch of messages gets at most three attempts —
  the third failure is recorded in the Reviews tab and the watermark moves past the batch, so an
  exhausted reviewer cannot retry it forever. What replaces the cap's other job — not replaying
  months of history on the first start — is a freshness rule: a conversation this feature has
  never seen is reviewed only if its newest message is under 24 hours old. With no counter, each
  conversation's watermark is the only guard left, so a mark that cannot be written to
  `reviews.json` is now kept in memory; a full disk used to leave the watermark unchanged and
  review the same conversation on every sweep. The web UI's Reviews tab no longer shows `x/10
  today` or a "quota used up" line, and the pointless `10 reviews already ran today` log line is
  gone.

## [2.37.0] - 2026-11-05

### Added

- **The web UI's side panel has a Reviews tab.** Automatic review used to be visible only when it
  changed a skill: the one line posted in the reviewed conversation, and nothing for the reviews
  that found nothing, only noticed a preference, or failed. Every review is now listed with the
  conversation it read, when, and what it produced — a skill created or updated, only preferences,
  a change the skill store refused, nothing found, or a failed run. Opening one shows each change
  with the reviewer's reason, whether it actually took effect (and the store's own sentence when it
  did not), the preference suggestions, the `talkcode skills revert` / `archive` command that undoes
  a change, and a link back to the reviewed topic while that topic still exists. The tab also shows
  today's quota (`3/10 today`) and, once it is used up, the local time reviews resume (the counter
  resets at UTC midnight). A review now records its result in `history.db` — a failed run included
  — so the reason a quiet conversation was never reviewed is answerable without the log. The ten
  reviews recorded before this only kept their raw answer; those are shown as *inferred*, and the
  detail says that whether the proposed changes landed was never written down. The tab is
  read-only: reviews are still written by the sweep through the skill store's own validation and
  history, and undo is the command the row names. [→](docs/skills.md#auto-review)

### Changed

- **Raised web UI limits to 200 concurrent topics and 1000 messages per topic.** The previous ceiling
  of 64 topics was reached in active environments, evicting older conversations while users easily
  navigate larger lists via pinned, starred, and "needs you" ordering. The message ring per topic is
  doubled from 500 to 1000 messages (estimated ~460 MB if all 200 topics were completely full at ~2.3 KB
  per message, with actual production usage well below that). [→](docs/web-ui.md)

- **The scheduled-task panel is now Side tasks.** It holds more than scheduled work — Sessions,
  Tasks and now Reviews — so its title, the clock's tooltip and its accessible name say what the
  column is rather than what one tab of it does. The icon stays the clock, because scheduled work
  is still most of what is in it. [→](docs/web-ui.md)

### Fixed

- **Operator control menus in the web UI no longer mark the topic as waiting on an answer.**
  Opening `/setting` (or scheduled task menus, `/model`, `/effort`, `/cd`, `/agent`, and command
  pickers) leaves messages with live buttons in the conversation. `awaitingQuestion` treated any
  button message other than the workdir menu as an unanswered question, pinning the topic to the
  top in green with an amber dot and pushing "Waiting on your answer" even after the settings dialog
  was closed. All recognized operator control menus are now exempted from question classification
  while remaining in `awaiting` so `inUse` and `closeIdle` retain their eviction and reclaim
  protections. Real questions (`ask`, permission requests, elicitation, sub-agent cards) and
  unrecognized buttons continue to be treated as questions. [→](docs/web-ui.md)

- **The web UI sidebar footer aligns Menu and Manage to opposite ends, with an inline SVG cleanup icon.**
  In 2.35.0, the sidebar footer moved `Close idle` into a new `Manage` menu but left `#manage-toggle`
  clustered to the left beside `#opts-toggle` because `#close-idle`'s `margin-left: auto` was not
  connected to the new button. `#manage-toggle` now connects `margin-left: auto`, cleanly aligning
  Menu to the left and Manage to the right. The button icon replaces `⋯` with an inline SVG broom icon
  rendered in `currentColor`, staying strictly monochrome across all operating systems and fonts while
  clearly representing housekeeping and cleanup. [→](docs/web-ui.md)

## [2.36.0] - 2026-11-05

### Added

- **Compound cron expressions in scheduled tasks.** `--cron` accepts multiple 5-field expressions separated by semicolons (e.g. `"20 9 * * 1-5; 35 9 * * 1-5; 0,30 10 * * 1-5"`), and schedules the earliest next run among them.

## [2.35.0] - 2026-11-05

### Added

- **Switch a topic's model from the web UI's status line.** The model named above the composer is a
  button: it lists what the topic's agent offers — the one in use ticked, the agent's default
  marked, a filter for a long list (opencode offers ~90) — and a tap switches the model for this
  topic, exactly as `/model <id>` does: a runtime choice, config.yaml untouched, and a typed `/model`
  afterwards says the same. A cold agent is started to ask, and the list says so meanwhile; a harness
  with no model choice says that instead. A 44px target on a phone. [→](docs/web-ui.md)

- **The default model of an agent a host's pod declares can be set from the gateway.** Since pods
  declare their own agents (`~/.talkcode/pod.yaml`, 2026-11-03), `/setting model.<id>@<host>` and its
  row on the web UI's settings page were refused — the agent is not in config.yaml — so the page
  listed rows that could not be saved. The value now goes to a new `podModels` map in config.yaml,
  which outranks the `model:` the pod gives and is outranked by a conversation's `/model`; clearing
  it goes back to the pod's. The settings page says whose value an agent has (*pod.yaml* or *set
  here*). It is a map of model names and nothing else: everything else about a pod's agent stays the
  pod's, and pod.yaml cannot set it. `/reload` applies a hand edit like any other model change.
  [→](docs/remote-hosts.md)

### Changed

- **The web UI's two side panels are one component.** The topic list and the scheduled-task panel
  had drifted into two sets of rules: the left slid with a margin transition and the right switched
  `display`, the left became a drawer at 640px and the right at 1023px, the drawers were 82vw/300px
  and 88vw/380px, each had its own backdrop at its own depth, and their headers ended in a
  different glyph. They now share one `makePanel`, one set of `.panel` rules and one backdrop:
  same header and footer rows, same ×, same 0.18s slide on both, `inert` while shut, Escape and the
  backdrop on both, and the same `min(88vw, 380px)` drawer. The breakpoints stay apart — a 240px
  list plus a 240–320px panel leave too little chat on a laptop, while the list itself is usable
  down to 640px — and so do the default widths.
- **The sidebar footer is Menu and Manage.** Three buttons in a 240px row overflowed, and "Close
  idle (N)" was the one that got cut. Settings became **Menu** and keeps All settings,
  Notifications, Low attention and Skills; the new **Manage** holds Close idle and Clear all
  topics, and shows the idle count on its own face so the number is still visible at a glance. The
  two menus open the same way, one at a time, and close on an outside click or Escape.

- **The web UI's settings page is a settings page.** It was the chat menu redrawn: ten rows all
  titled "Default model" in a two-column zig-zag, sub-agent confirmation filed among them, the topic
  named in the bar as though these were its settings, and every value the same blue text with a ›.
  Now it is one column of sections — Agents, Default model, Sub-agents, Conversations, Replies,
  Voice — and each setting is changed in place with the control that fits it: a switch for on/off, a
  segmented control or a dropdown for a short list (one tap, where the menu needed two and a Back),
  and a row per agent for the default models, named by the agent, showing its whole model id or
  *harness default* in grey, with the agent answering the current topic marked. The bar says these
  are saved to config.yaml for every topic; "next session" is said once for the model rows rather
  than on each, and *after restart* only where it applies. What each change did — saved, already set,
  refused and why — is a banner, and a request that never reached the gateway puts the control back
  and says so. Every row is listed, not the chat menu's first 20. Chat platforms' `/setting` menus
  are unchanged. [→](docs/settings.md)

### Fixed

- **`talkcode` works in an agent's login shell on a remote host.** codex runs the shell commands it
  is asked to run with `bash -lc`, and a login shell rebuilds PATH from `/etc/profile` — so on a
  host whose image installs talkcode (uniagent's does) `talkcode` became that full Node CLI, which
  looked for a config file on the host that does not exist and answered `config not found at
  ~/.config/talkcode/config.yaml; run talkcode setup first`. Every reverse command that agent ran
  in a shell was dead, while the same command worked through the tools server. The host's helper now
  tells each agent where its `talkcode` shim is (`TALKCODE_REMOTE_CLI`), and the full CLI, finding
  itself in an agent's shell on a host, hands its argv to that shim instead of reading a config. It
  hands over only what needs the gateway — the reverse commands and `mcp`; `help` and `--version`
  are answered on the host, and `start`, `setup` and `doctor` are refused there, before anything
  leaves the machine. Nothing changes where there is no host: without `TALKCODE_REMOTE_SOCK` the
  CLI is the CLI it was. [→](docs/remote-hosts.md)

- **`/model` on a custom harness that offers a model list opens the menu.** Every command to a
  `custom` agent was passed through, so on CodeBuddy `/model` became a prompt it answered with
  nothing, and the chat said "Ran /model, but there was no output to display". CodeBuddy declares a
  `model` option in its ACP session (22 models in 2.179.3), which is all the gateway's menu needs, so
  a custom agent that declares one now gets the menu, switching with `session/set_config_option`; the
  status-line switch and the settings page list its models too. One that declares none has `/model`
  passed through exactly as before. A first `/model` before the agent has started starts it to find
  out — the start forwarding it would have caused — and the answer is remembered.
  [→](docs/chat-commands.md)

- **The settings page lists any agent's models, not only the one answering here.** A model list
  comes with a running session, so only the agent answering the topic `/setting` was opened in, and
  only after it had replied, had one; every other model row was a page saying "type a name". The
  gateway now asks: from a session of that agent running anywhere, from what it learned earlier, or
  by starting one just to read the list and stopping it again (once per agent, while the page says
  *Asking … for its models*). A harness that offers no model choice, and an agent that does not
  start, are each named, and on the web UI a name can be typed into the screen itself, which also
  filters a long list as it is typed into. [→](docs/settings.md)

## [2.34.0] - 2026-11-05

### Added

- **Turns in the conversation library.** `history.db` now keeps one row per turn: the agent that
  answered it, the conversation's generation (bumped by `/new` and `/cd`, so the two sides of a
  reset are distinguishable), what started it (`person`, `schedule`, `continue`, `delegate`,
  `update`, `background`), its span, and how it ended (`done`, `stopped`, `failed`, or `restart`
  for a turn the gateway never finished). Every prompt, tool line and reply written in a turn
  carries it — imported transcripts and rows from before turns do not — so "which reply was
  that, and did it finish" is a fact recorded when it happened rather than reconstructed
  afterwards. `talkcode sessions read` gains `--role`, `--turn` (last | done | n), `--turns`
  (at most 100; the note says when it actually cut), `--since` (in write order; its note names
  the id to continue from; not combinable with `--turn`/`--turns`/`--tail`), `--grep` and
  `--tail`; a filtered read prints each row's turn, that turn's outcome and its agent. Without a
  filter the output is exactly what it was. An existing file is migrated in place: old rows keep
  a NULL turn and read as unknown rather than being guessed into a neighbour.
  [→](docs/conversation-history.md)
- **A scheduled task can keep one conversation per day.** `schedule add --session daily` opens a
  topic on the first run of each local day and sends the rest of that day's runs into it, so a
  briefing can build on itself without a new topic every hour or a context that grows for a week.
  The day is counted in the task's own time zone by each run's already-written rules: the day of
  its planned time, so a catch-up after midnight still joins the day it was meant for, and the
  topic is named with that date. The topic is remembered in `schedules.json`, so restarting the
  gateway mid-day does not open a second one; a topic deleted during the day is reopened on the
  next run — a platform that cannot report whether it still exists is caught when a post into it
  fails, which clears the record. It needs a cron and a platform that can open a topic with no
  message to reply to (the web UI, a Telegram forum group), refused at registration otherwise;
  Telegram's ordinary groups are knowable only at run time, so a run there fails and says why,
  and consecutive runs failing the same way report it once rather than on every run. A failed
  create fails the run and says so, because the alternative (a throwaway conversation) is one the
  person cannot reply into. `fixed` and `new` are unchanged.
- **A scheduled task can name its model.** `schedule add --model <id>` gives a new- or
  daily-session task its own model instead of whatever its agent's config happens to carry; the
  previous way was to duplicate a whole agent entry just to change `model`, and keep every other
  field in step by hand. The id is checked at registration against the agent's own `/model` list
  (the caller's session for its own agent, a throwaway one for another), and a name it does not
  offer is refused with the list, so the agent can fix it in the same turn. Each run applies it
  through the `/model` path before the first request, with the session started first: a harness
  that refuses it fails that run and says why, instead of the best-effort fallback an operator's
  configured model gets. In a daily topic a `/model` typed by a person during the day wins, and
  keeps winning across a restart: the task records that the topic was set by hand and stops
  applying its own model. A fixed-session task runs in a person's conversation, whose model is that
  conversation's own, so `--model` is refused for it. [→](docs/scheduled-tasks.md)

- **Sub-agent starts can be left unconfirmed.** By default `task-new` still only proposes: every
  sub-task waits on a card listing all of them until the person taps Start. `/setting delegation
  off` (or `delegation.confirm: false`) removes that tap — each sub-task starts as the agent
  proposes it, and a card listing every one and its topic is posted afterwards, without buttons,
  so the chat still shows what an agent started on its own. `task-new` answers with the topic it is
  running in, and a sub-task that could not start is returned as a failure instead of reported as
  running. Only a person can change the switch: `/setting` or the file, never a reverse command.
  It applies only where the person talks to the agent directly — in a sub-agent's own topic,
  `task-new` still waits for a tap, so agents cannot chain more agents without one.
  [→](docs/sub-agents.md)

- **`task-read` reads the conversation library, and a cut update card points at the whole text.**
  A sub-agent's topic is read from `history.db` now, with the same `--role`, `--turn`, `--turns`,
  `--since` and `--grep` as `sessions read` — one definition, `READ_FILTER_OPTIONS` — while its own
  `--tail` still means the last lines of each message. `--reply` gives the last turn that ended
  normally, its reply whole: the card that sends the parent there carried only 4,000 characters of
  it. A failed turn's error is kept whole in that turn's record (`turns.detail`, up to 200,000
  characters) instead of its first 500, and `--turn <n>` reads it, so an error longer than the card
  is no longer unreadable. The card names the turn it quoted — a background burst after it would
  otherwise be "the last turn" by the time the parent reads — and `--turn <n> --full` returns that
  turn whole, past the 20,000-character cut a `--full` log read keeps. The `super` skill hands
  review to a sub-agent — the agent that split the
  job reads the verdict, not the diff — and asks each sub-agent for a conclusion-first reply under
  2,000 characters. [→](docs/sub-agents.md)

### Changed

- **The scheduled-task panel is a drawer on a phone.** Below 640px it took the whole screen, which
  made it a mode rather than a glance: the clock opened a surface with no chat behind it and the
  only way out was the ×. It is now the same drawer the topic sidebar is, on the other edge —
  sliding in from the right over a dimmed chat, at most 88% of the screen wide, dismissed by the
  backdrop, the ×, Escape or the clock. Below 1024px it keeps the slide; the docked column is
  unchanged, and only a docked panel is restored on a reload.
- **`/setting` is a page of its own in the web UI.** It used to arrive as a message in the
  transcript drawn as a settings screen: the screen was right, the message was not — opening
  settings left a row in the conversation, and changing one thing later meant scrolling back to
  it. The page opens from **All settings** in the ⚙ menu at the foot of the topic list, or by
  typing `/setting`, and never enters the transcript; the command you type stays as your message.
  It names the topic it is bound to, because the agent and model rows are that conversation's,
  and switching topics puts it away. The rows, values, validation and writes are still the
  daemon's (`core/settings.ts` and the existing apply path) — the page only draws the screen the
  daemon already sends. Every other platform keeps its button grid.
- **A finished sub-agent no longer lights the sidebar green.** A topic a `/super` job opened took
  the same green "unread reply" dot as a conversation the person is expected to read when its turn
  ended — but its reply goes to the agent that opened it, which acts on it and reports, so the row
  was pointing at work nobody had to pick up. It now keeps the ordinary idle/online grey (dim blue
  while its agent is resident); its blue "working" and amber "question" dots are unchanged, and
  the topic that opened it still turns green when the agent's answer is waiting to be read.

## [2.33.0] - 2026-11-05

### Added

- **A skills page in the web UI.** The gateway's managed skills could only be read and edited by
  asking an agent to run `talkcode skills`, which is a fine way to write one and a poor way to see
  what exists. The sidebar footer now has a **✦ Skills** button: every skill with its status, pin
  and last use; **New** to create one; an editor for `SKILL.md` and for the files under
  `references/`, `templates/` and `scripts/`; the recorded history with **Restore this version**;
  and **Delete**, which is the store's `archive` — the skill moves into `.archive/` whole and
  **Restore** brings it back, because there is no hard delete and this page does not add one.
  Every write goes through `skills-store.ts`, the same functions the command uses, so the name and
  path rules, the version `patch` demands and the `.history/` snapshot are the same; an archive
  made here also tells the conversation that created the skill. [→](docs/skills.md)

### Changed

- **The sub-agent update card carries the whole answer.** The `[sub-agent updates]` card a parent
  agent receives quoted 600 characters of a finished sub-agent's reply, flattened to one line, and
  the first 120 characters of a question or a failure; a review, a conclusion-first one included,
  lost its verdict, and the parent had to open the topic and read it again — the exact cost the
  card exists to remove. The card now quotes the reply a turn ended on, the question a sub-agent is
  waiting on, or the error a turn failed with, in full and with its line breaks and lists, and no
  longer repeats a reply's first line beside it. One entry carries at most 4,000 characters and one
  card 8,000 across a burst (`CARD_ITEM_CHARS`, `CARD_TOTAL_CHARS` in `delegation.ts`), both hard
  limits. A cut adds one line the gateway writes — the text's full length, where it stopped, and
  where the rest is: a reply or question stays in the topic (`task-read <topic> --full`), while a
  failed turn's error only exists as the opening of its ❌ notice, and the cut says that instead of
  pointing at text nobody kept. Apart from the sub-agents' own words, the card adds only one-line
  notes: the cut notice, `no reply` when a turn left no text, and the folded line for sub-agents
  past the first 20. No summary or instruction about the work is added.

## [2.32.0] - 2026-11-04

### Added

- **Quiet conversations review themselves.** The managed skills learn from what actually happened:
  when a conversation has been idle for an hour and the person has said at least three things
  since the last review, the gateway has an `agy` agent read it and propose `create`, `patch` and
  `write-file` changes, plus any preference it noticed. The moment is idle reclaim's own — the
  review runs once the agent process is stopped — and the three edges come with it: `/kill` and
  `/new` are reviewed an hour later, a restart backfills what went quiet while it was down, and a
  conversation whose agent can never be reclaimed is reviewed with its process still up.
  Scheduled tasks, sub-agents and reviews themselves are never reviewed. The reviewer has no
  tools: one `agy -p` in an empty temporary directory with every permission class denied — print
  mode without `--dangerously-skip-permissions` still auto-approves file writes on agy 1.5.0, and
  `deny: ["*"]` denies nothing at all (both measured 2026-11-04), so the explicit deny list is what
  makes the reviewer unable to touch a file. Its prompt travels on stdin as one stream-json frame,
  not in argv: Linux caps one argument at 128 KB, and a long conversation plus the skills it used
  is more than that. Only the gateway writes, through `talkcode skills`'
  own rules: a patch must carry the version the reviewer was given, and a change the store refuses
  is dropped and logged. One review runs at a time, at most
  ten a day; a failure waits six hours. When something changed, one line appears in the reviewed
  conversation with the `revert` command; no change, no line. Reviews are filed in the conversation
  library as `review` sessions, which search and `list` leave out. Off unless `review.agent` names
  an agy agent. [→](docs/skills.md#auto-review)

## [2.31.0] - 2026-11-04

### Added

- **Past conversations, searchable from any agent.** Everything the gateway carries is now kept
  in `<config dir>/history.db`: the prompt a turn gave its agent (attachments by name only), the
  reply in full, and one line per tool call. `talkcode sessions search <words>`, `read <session>`
  and `list` let an agent find what was said in another topic, on another platform, with another
  agent — the knowledge that used to die with each conversation's context. Search is BM25 over
  keyword text; Chinese works because every run of Han characters is indexed as overlapping
  two-character words (`跨会话查询` → `跨会 会话 话查 查询`) on the way in and on the way out —
  SQLite's default tokenizer treats the run as one token, and `trigram` cannot match a
  two-character word (measured on 3.53.4). A single character falls back to a substring match.
  Scheduled-task output sorts after ordinary conversations, so a noisy task cannot bury the
  conversation someone is looking for. The web UI's kept transcripts are folded in once on the
  first start; the file is `0600`, and a failed write is logged rather than allowed to fail the
  turn it describes. [→](docs/conversation-history.md)
- **Skills the gateway keeps for every agent.** An agent could write a file where it happened to
  run, but a skill worth keeping is one the next agent on the next host also gets. `talkcode
  skills` now owns that: `create`, `patch`, `write-file`, `remove-file`, `archive`, `restore`,
  `pin`/`unpin`, `history` and `revert`, with the gateway's directory (`<config dir>/skills/`) as
  the one copy. Each spawn copies the active skills to `~/.talkcode/skills/<name>/` on the agent's
  machine and links them into its harness's skill directory — only ever repointing or removing a
  link that points back into that directory, so an operator's own skill of the same name is left
  alone. `patch` must carry the version `show` printed, which is what stops a half-read edit from
  silently undoing a newer one; every content change keeps the previous files in `.history/`, and
  `revert` puts them back. Use is counted from the events the gateway already receives — a `Skill` tool
  call, a message starting with `/<name>`, or a tool touching a file under the skill's directory —
  once per turn, and `talkcode skills` itself does not count. After 14 days unused a skill is
  marked expired; after 30 it is moved into `.archive/` and taken off every agent, with a line in
  the conversation that created it. Pinned skills are exempt, and nothing is deleted. Because any
  agent can write one and every agent reads it, this is the first feature that lets an agent
  change another agent's instructions; the security notes say so. [→](docs/skills.md)

## [2.30.0] - 2026-11-04

### Added

- **Your instructions, for every agent.** How the operator wants to be worked with had to be
  written into each harness's own file on each machine — `~/.claude/CLAUDE.md` here, a hand-copied
  `AGENTS.md` there — and the copies drifted. Now it is one directory on the gateway,
  `<config dir>/instructions/`: `common.md` for every agent, and `claude.md`, `codex.md`,
  `opencode.md`, `agy.md`, `codebuddy.md`, `atomcode.md` for what suits only one (a rule about one
  harness's prompt cache is not a rule for the others). At every agent start the gateway joins the
  two, writes the result read-only to `~/.talkcode/instructions/` on that machine, and links the
  harness's own user-level instruction file to it — each location probed by asking the harness for
  a word planted there. It reaches the agent the way the harness's own settings do, with nothing
  added to the conversation, and reaches an agent started from a terminal too. A real file or the
  operator's own link at that path is left alone and logged; with nothing to deliver, a link of ours
  is taken back, so deleting the directory turns it off. The remote side gains an atomic write, an
  ownership check on links, and a `removeLink` that only removes its own. [→](docs/instructions.md)

## [2.29.0] - 2026-11-04

### Changed

- **A file the agent sends opens in a window, and its name is the way in.** Clicking the name of a
  Markdown file, a log or any other file the server can render used to download it; the **Preview**
  button beside it was the way to read it. The name now opens the preview, and the button beside it
  is **Download**, which is what the name used to do. The preview itself is a window over the
  conversation — a dimmed page behind a capped box — instead of an opaque full-screen page, so the
  transcript stays visible around the document and a click on the dimmed page closes it.

## [2.28.1] - 2026-11-04

### Fixed

- **The agent tag in a topic row dims with its title instead of sitting at one fixed grey.** The
  tag's `#6b7683` was tuned against an idle row, so beside the `#dcdcdc`/`#fff` title of a running
  or selected topic it read as disabled — the row's own metadata looking switched off in the two
  states most worth reading. It now inherits the title's colour at 85%, one step below whatever
  state the row is in, in the sidebar and in the scheduled panel's Sessions list.

## [2.28.0] - 2026-11-04

### Changed

- **The scheduled panel stays where it was put.** It used to be a side glance: it closed itself on
  every topic switch unless a pin held it open, and the pin was a second switch to understand for
  one behaviour. It is now open until it is closed — switching topics, opening a run from Sessions
  and reloading all leave it in place (`aa_sched_open`) — and a first visit starts with it closed.
  The pin is gone; the close button, Escape and the clock are the three ways to put it away, and
  each is remembered.

- **Its tabs moved to the foot of the panel, Sessions first.** They choose between two views of one
  column rather than heading its content, so they sit where the topic sidebar keeps its own row —
  same padding and type size, so the two columns end on the same line. The heading no longer carries
  a clock glyph; the clock is already the button that opens the panel.

- **The Tasks list says one thing per line.** Each card used to give its name, state, cron line,
  next run, run mode, target and last result the same weight, with a mark on the last one. It now
  reads name (with a state word only when it is not active), schedule, next run and target, last
  run — red only when it failed — with the prompt, run mode and bookkeeping behind a tap. Delete is
  quiet until the pointer is on it.

## [2.27.2] - 2026-11-04

### Changed

- **The topic list is ordered by what each topic is doing, and a /super dispatcher counts as
  working while its sub-agents are.** A dispatcher hands its job to topics of its own and then sits
  idle between turns, so its row — now the only one on screen, since sub-agent topics are folded
  away by default — was the one row that looked dead while the work ran. It is drawn as running
  (dot, title, chat header), sorts with the working group, and is no longer offered by "Close
  idle". Below the green needs-you group the list is ordered the way it is read: working, an agent
  that is up and idle, then one with no process behind it; a starred row leads its unstarred peers
  inside a state, and the daemon's most-recently-active order holds below that. Sub-agent topics
  start folded under the topic that opened them; opening one is remembered per browser.

## [2.27.1] - 2026-11-04

### Fixed

- **The web UI's three column headers are one height.** The topics bar, the topic title and the
  scheduled panel's bar each sized to their own content: the sidebar's `+` made its bar 44px and
  the panel's second line — the task/session summary — made that one 56, so the three bottom
  borders landed on three different rows and the panel's tabs started a line below the chat. All
  three now share `--headh` (42px; 49 on a phone, where the chat header's drawer toggle makes the
  bar taller for a finger), and the panel keeps its summary by tightening its leading instead of
  growing the bar.

## [2.27.0] - 2026-11-04

### Changed

- **The web UI's scheduled panel lists the runs, not just the tasks, and gives the topics back.**
  A new-session task opens a topic for every run, and those topics used to land in the ordinary
  switcher beside the person's own conversations — a column that grew by one row per run and said
  nothing about where the row came from. They now carry a `scheduled` mark (persisted, and adopted
  once for the runs an older install already has from their `[agent] ⏰ …` titles) and are left out
  of the switcher. A second tab in the panel, **Sessions**, lists them with their state and unread
  count; tapping one opens it, and its × deletes it. The tab needs no request of its own: the topic
  list the page already receives carries everything it draws.

- **The panel is narrower, and the operator can size it.** Its default column is
  `clamp(240px, 20vw, 320px)` rather than up to 380px, because it is a glance at background work
  rather than a second chat. The left edge is a drag handle, kept in this browser like the
  sidebar's width, and double-clicking it restores the default.

## [2.26.0] - 2026-11-04

### Added

- **The web UI has a scheduled-task panel of its own.** The clock at the right of the chat header
  opens a column listing every task the gateway has registered: what it runs, when it runs next,
  where its output goes, and how the last run ended. A task opens for its full prompt or command,
  and can be paused, resumed, run now, or deleted (two taps) — through the same service the agent's
  `schedule` commands and `/setting schedule` use, so a change made here is a change made there.
  The panel is hidden by default; 📌 pins it open across topic switches and reloads, and without
  the pin a topic switch puts it away. It is a column at 1024px and wider and a slide-over below
  that, so it never takes the chat's room on a phone. It does not create tasks: that stays a
  sentence to an agent in a topic.

## [2.25.0] - 2026-11-04

### Changed

- **`/setting` on the web UI is a settings screen, not a wall of buttons.** The bare command used
  to arrive as the same button grid every chat app gets: each row squeezed its label and value into
  one 40-character string, so a phone showed `Default model · cc · (harness …` with the value cut
  off and no way to tell a heading from a choice. The page now draws the same menu as grouped rows:
  the label on one line, the whole current value underneath it — wrapping rather than ellipsising —
  and the whole row as the target. A row opens its values in the same shape, the current value lit
  and ticked, and Back returns to the list. Rows are at least 44px tall; a wide screen may show two
  or three side by side inside a group. Chat platforms are unchanged: the daemon sends them the
  same text and buttons, and attaches the structured screen only to a platform that declares it.

### Fixed

- **A `/super` proposal keeps every part, however far apart the calls are.** `task-new` calls were
  batched by a three-second window, so an agent that made one call per step — the normal shape —
  produced one card per call, each replacing the one before, and the person's Start covered only the
  last one. On 2026-11-03 a three-part job ran as one part, twice. The card now stays open until the
  person answers: a later call re-renders it with its item on it, and only Start, Cancel or a
  message from the person ends the proposal. A message drops it too, so "use cbc instead" starts a
  fresh card rather than appending to the items it means to replace.
- **`task-agents` lists the agent answering the conversation first.** `task-new` has no default, and
  the first usable row is what an agent takes — which was whatever the config listed first (`cc`
  here), even in conversations cbc was answering. The conversation's own agent now leads the list,
  already on this machine with the same checkouts and tools; the other agents on that machine follow.

## [2.24.1] - 2026-11-03

### Fixed

- **A web UI topic you are still setting up no longer asks for attention.** Picking an agent in a new
  topic is a tap that types `/agent`, and the daemon answers with the directory menu — which the page
  counted as a question. So a topic with no agent in it yet pinned itself to the top of the sidebar in
  green, turned its dot amber, and pushed "Waiting on your answer", all while you were choosing a
  directory in it. The menu is a control for your own next step, not something an agent is blocked
  on, so it no longer puts the topic in the needs-you list or notifies. A real question still does.
- **The sidebar's agent tag no longer eats the topic's name.** A remote agent's id is `<id>@<host>`,
  and the tag in front of every title is that id — 15 characters of a 240px column spent naming a
  machine the line below already names, which left rows reading `[cbc@uniagent] Oracle A…`. The row
  now shows just the agent's id, dimmed, and keeps the whole name on hover. A tag whose machine the
  directory line does not name keeps its host: it is the only place on the row that says it.

## [2.24.0] - 2026-11-03

### Fixed

- **CodeBuddy Code gets the bundled skills, and the dead link it was left with is swept away.**
  The links were made for claude, codex, opencode and agy only; a `custom` harness — how CodeBuddy
  is configured — got none, so the operator had linked `~/.codebuddy/skills/{talkcode,super}` by
  hand into `~/.talkcode/remote/<version>/skill`. That directory is deleted on upgrade, and nothing
  repointed a link no spawn was responsible for: both hosts ended up with a dangling link, and every
  CodeBuddy session ran without the skill (no `/super` either) — including the one that would have
  used `talkcode send-file`. A `custom` harness whose command is `codebuddy` now maps to
  `~/.codebuddy/skills` like the others, so the next spawn repoints it; and once per version each
  known skill directory is swept for links into a version directory that is gone, so a mapping
  dropped in a later release cannot leave a link dead forever.

## [2.23.0] - 2026-11-03

### Added

- **A sub-agent's turn can be watched while it runs.** `tasks` said only `stage: working` until the
  turn ended, so a sub-agent 150 tool calls deep was a black box whose only diagnostic was its
  host's transcript; `task-read` then cut every message at 1500 characters, which on an accumulated
  tool bubble shows the oldest commands and hides the one running now. `tasks` now carries the tool
  it is running, its step count, how long the turn has gone and the context it has used;
  `task-status <topic>` gives one topic's last three tool calls; `task-read --tail <n>` shows the
  newest lines and `--full` the whole message (20k each, 80k in all, with what was left out said in
  the answer rather than silently dropped).
- **`task-send --interrupt` stops a turn and sends the correction as the next one.** A message sent
  mid-turn reaches the turn only on harnesses that take input there (claude, codex); agy has no such
  input, so a correction queued behind a long tool loop and changed nothing. `--interrupt` ends the
  turn first and hands the message to the next one, with the conversation's context kept.

### Fixed

- **`task-send` no longer says a message joined a running turn when it was only queued.** It
  answered "joined" whenever the conversation was busy, whether or not the harness could take input
  mid-turn — so an agent that sent "stop reading code, check the log" was told its words had been
  seen while the sub-agent kept running `sed`. The answer now distinguishes joined, queued behind
  the turn, and started.

## [2.22.0] - 2026-11-03

### Added

- **An agent can add a machine to the gateway: `talkcode pod-add`.** Adding a host meant editing
  the gateway's config.yaml, scanning the host's key into its known_hosts and copying the gateway's
  key into the host's authorized_keys, all by hand on the gateway. Now `talkcode pods` prints the
  line the new host needs, `talkcode pod-add <name> <user@address:port> --host-key "<key>"` writes
  the `hosts:` entry and pins the key, reloads, and answers with the agents it found there;
  `talkcode pod-remove` takes a host out. The host key is given, read on the host, never fetched:
  the gateway still never learns a key by itself. See `talkcode help pods`.
- **Hosts can ssh to one another: `peer:` in a host's pod.yaml.** Every pair of machines that needed
  to reach each other needed keys, known_hosts entries and an ssh alias set up by hand, in both
  directions. A host with `peer:` now joins a mesh: each gets a key of its own, made on the host,
  and the gateway writes the others' keys, host keys and a `Host <name>.pod` block into
  `~/.talkcode/ssh/` on every reload, so `ssh <name>.pod` — scp, rsync, git, -L/-R included — works
  between any two of them. The connections are direct; the gateway only sets them up. The host keys
  are the ones the gateway already checks each host against. The host's sshd and ssh have to read
  those files (two lines, already in the uniagent image). See
  [Remote hosts](docs/remote-hosts.md#pod-to-pod-ssh-peer).

## [2.21.0] - 2026-11-03

### Added

- **A remote host can declare its own agents, in `~/.talkcode/pod.yaml`.** With several hosts,
  config.yaml carried every agent of every machine, the same three entries copied per host with
  only the id and `host` changed, plus a routing line per id — and each new machine meant editing
  all of it on the gateway. Now a host lists its agents where they run, and the gateway names them
  `<id>@<host>` (`oc@devbox`). A host with no file is looked at instead: each harness command on its
  login PATH becomes an agent with default settings. The file is read when the gateway starts and
  on every `/reload`; what was read is kept in `pods.json`, so a host that is down — or whose file
  has a mistake, which the reload's answer names — keeps the agents it had. `${VAR}` is refused in
  that file, since it would be filled in from the gateway's environment, where the bot tokens are.
  See [Remote hosts](docs/remote-hosts.md#agents-the-host-declares-talkcodepodyaml).
- **Renaming an agent keeps its conversations.** An id was also the key every conversation and
  scheduled task remembered its agent by, so changing it in config.yaml sent all of its topics back
  to the default agent with a fresh session. `agent-renames.json` in the config directory renames
  ids in config.yaml, conversations and scheduled tasks together when the gateway starts, after
  backing up the three files.

### Fixed

- **A comment on a config.yaml line the gateway changes stays on it.** `/setting` (and now a
  rename) replaced the whole value, so `model: x  # the cheap one` lost its comment the first time
  the model was set from the chat. A scalar is now changed in place.

## [2.20.0] - 2026-11-03

### Added

- **Low attention, for a web UI with several agents working at once.** Turned on in the sidebar's
  new Settings menu, a running topic's dot stays bright blue but stops pulsing, and unread counts
  turn from a bright blue pill to grey. With a few agents running, the list never stopped moving —
  a pulse per running topic, and counts climbing with every message a turn posted — and none of it
  was anything to act on. What is left standing out is what needs you: a question (its amber dot
  still pulses), a failed turn and an unread reply, still moved to the top in green. Kept per
  browser, and off until turned on.

### Changed

- **The web UI's sidebar footer is one row**: ⚙ Settings, and Close idle (N) while any agent is
  idle. Notifications, Low attention and Clear all topics are in the Settings menu. The footer was
  a column of full-width buttons, three rows already and a fourth on the way, for things set once
  per device or used rarely; Close idle stays outside because its count is worth seeing at a glance.

## [2.19.3] - 2026-11-02

### Fixed

- **A tool row says what the tool actually did, on CodeBuddy Code too.** Every cbc tool drew as
  `⚙️ Tool: "Bash"` — no command, no per-tool emoji — for its whole life, so a turn's tool list said
  nothing about the turn. cbc announces each call before its parameters (`{title: "Bash", kind:
  "other", rawInput: {}}`, already `in_progress`) and streams the command after, and the row was
  drawn from that announcement and never redrawn. It now follows the call's later frames: the
  command, the tool's real name (`ToolSearch`, `DeferExecuteTool`) and its emoji land as they
  arrive, a parameter that has not streamed yet no longer shows as `{"command":""}`, and a call
  whose title only repeats its name reads `💻 Bash` instead of `💻 Bash: "Bash"`.

## [2.19.2] - 2026-11-02

### Added

- **Stop a whole /super job from where it started.** `/stop` (and Stop) in a topic now also stops
  every sub-agent it started that is still working, theirs included, and each says where it was
  stopped from. Stop is shown there while any of them works. The agent's own turn ends as soon as
  it has handed the parts out, so until now there was nothing to press: Stop was hidden, `/stop`
  answered "Nothing is running here", and stopping the job meant opening every sub-agent's topic.

- **The web UI's sidebar can be resized.** Drag its right edge; the width is kept in the browser,
  and a double-click on the edge puts the default back. At a fixed 240px most topic titles were cut
  off after a few words — "[ag2] 状态：小说与内容…" — which made topics of the same agent hard to
  tell apart. On a phone the sidebar is still a drawer the width of the screen.

### Changed

- **What needs you is the topic's own row, moved to the top and in green**, instead of a separate
  "Needs you" block above the list. The block repeated each topic's title, so a topic waiting on you
  was on screen twice and read as two conversations. The order is unchanged — questions, failures,
  unread replies — the dot still says which, and hovering a row shows the line the block used to.

## [2.19.1] - 2026-11-02

### Fixed

- **`/super` is in the web UI's command list.** 2.19.0 shipped it as a skill only, and the list
  above the composer offers the gateway's own commands, never an agent's skills — so the one way to
  start sub-agents had to be typed from memory. It is now there, and once chosen the row says what
  it takes (`/super <job>`) and what it does, which a phone never showed (the description was a
  hover title). It forwards to Claude Code, Codex, OpenCode and Antigravity, each checked against a
  real job; the `gemini` and `dsh` harnesses, which get no skills from the gateway, say it is not
  supported. On Telegram and the other chat apps it stays out of the menu, and typed there it is
  answered in one line instead of spending a turn on a refusal: sub-agents need the web UI's nested
  topics.

## [2.19.0] - 2026-11-02

### Added

- **Sub-agents: `/super <job>`.** The agent you are talking to splits the job, hands the parts to
  other agents that work in parallel, checks what they did and reports once — so you follow one
  topic instead of four. Each part gets a topic of its own, nested under the one that started it in
  the web UI's sidebar (▾ folds them away), where you can read it and talk to that agent directly.
  Nothing starts until you tap Start on a card that shows every part in full; to change it, say
  what instead. With agents on several machines, it prefers the ones on its own. The agent that
  started them is told when one finishes, fails or asks something (a folded 🔔 line shows exactly
  what), but not about turns you start in a sub-agent's topic yourself; and a sub-agent's finished
  replies and failures stay out of Needs you and notifications, since that agent reads them for
  you. Any agent can do the same when asked to split work, without `/super`. Web UI only. See
  docs/sub-agents.md.

### Removed

- **The dispatcher topic (📥), and `dispatcher:` in config.yaml**, added in 2.18.0. A standing
  router earns its keep sorting a team's requests — whose is this, is it new, which repository — and
  one person already knows which topic a message belongs in, so it mostly retold what the topics
  had said, at the cost of a model turn each time. What it was for is now sub-agents, started from
  the topic you are in. A config.yaml that still has `dispatcher:` no longer loads: delete the two
  lines. Needs you, notifications and `hooks.turnFailed` stay as they were.

## [2.18.0] - 2026-11-02

### Added

- **A dispatcher topic.** One person can only watch a few conversations at once: over a
  month on this deployment, the topics written to in an hour were two at the median and four at the
  90th percentile, and with five or more open, a reply to the one waiting took twice as long. So the
  checking now has an owner. Set `dispatcher.agent` and that agent answers a pinned **📥 Dispatcher**
  topic in the web UI. Tell it what you want: it opens a topic for each piece of work, hands it your
  words exactly as written, and comes back in 📥 with a link when one has a result, a question or a
  failure. Topics that are fine are not mentioned. On Claude Code it has no tools of its own — no
  shell, no files — so it cannot drift into doing the work itself. Its instructions are an
  `AGENTS.md` in a directory of its own that you can edit. See docs/dispatcher.md.
- **The web UI lists what needs you.** Above the topics, **Needs you** shows each topic waiting on
  an answer, a failure, or a reply you have not read, with its first line, and nothing else. A reply
  leaves the list once you have looked at it; a failed topic's dot stays red until something runs
  there again.
- **Notifications on your phone, with the page closed.** The web UI can send push notifications to
  any browser that turns them on (Chrome, Edge, Firefox; Safari once added to the home screen). A
  phone puts the page to sleep the moment it is put down, so until now nothing reached it until it
  was opened again. What notifies is what needs you; something you are reading when it happens does
  not. The content is encrypted for the device and is a topic's name and one line.
- **A failed turn can carry on by itself.** `agents[].hooks.turnFailed.continue` sends your own
  words (say, 继续) after the failures you name — an upstream outage, a dropped connection, a hung
  agent, a restart — with a doubling wait, up to a few times in a row, announcing each one first.
  Anything you send calls it off. `turnFailed.command` runs a command of yours after every failure,
  with the details as JSON, to alert you however you like.
- **A turn cut off by a restart says so.** When the gateway stops in the middle of a turn — an
  update that waited its 30 minutes, or a crash — the topic now says so when it is back, the topic
  is listed as failed, and `turnFailed` can continue it. Before, the last thing it said was that the
  restart would wait for it.

### Changed

- **MCP tool calls show the tool's name** (`send_file`, `task_new`) in their bubble instead of a
  bare "Tool".

## [2.17.0] - 2026-11-02

### Added

- **A new web UI topic lets you pick its agent.** It used to open on a blank page, and choosing
  anything but the default agent meant knowing `/agent` and tapping through machines, then agents.
  Now, with more than one agent configured, a new topic lays them all out, grouped by machine: each
  card says what the agent is (Claude Code, Codex, OpenCode, Antigravity, or a custom agent's
  command) and its model, if one is set. One tap and that agent answers the topic. Typing straight
  away still works, and the card marked **default** is the agent it reaches. The cards go as soon as
  anything is said.

### Changed

- **Choosing an agent with `/agent` asks where it should work**, on every platform, as `/cc` already
  did. In a topic that has not started yet, `/agent oc2` — typed, picked from the `/agent` menu, or
  tapped on the web UI's new topic — is now followed by the directory menu, where before the agent
  simply started in its root folder.

### Fixed

- **The web UI's topic list shows a topic's new machine and directory straight away.** Under each
  topic's title is where it works, and after `/agent` or `/cd` that line could keep naming the old
  machine and folder until the next message, because the page was only told about the list while
  the old answer was still remembered. It now follows within moments, and a change that lands
  late — a `/cd` on a remote host lists the folder first — shows within 20 seconds.
- **A web UI topic is no longer named after a command.** An unnamed topic takes its name from the
  first thing said in it, which for a topic set up with `/agent oc2` or `/cd quantlab` was that
  command. It is now named from the first message that is not a command.

## [2.16.0] - 2026-10-31

### Added

- **The web UI can close every idle agent at once.** An agent's process stays up after its turn
  until the idle timeout reclaims it, which is what the dim blue dot beside a topic shows, and
  closing them meant opening each topic and pressing its power button. **Close idle agents (N)**,
  above Clear at the bottom of the topic list, lists every topic whose agent it would close —
  title, machine and directory — and asks before doing it, then shows which were closed. Each
  conversation is kept: the next message in a topic starts its agent again where it left off. A
  topic that starts working while you are looking at the list is left running rather than cut
  off, because the gateway checks again, with the same rules its own idle timeout uses, at the
  moment it acts. Starred topics are closed like any other. Nothing is posted into the topics.

## [2.15.1] - 2026-10-31

### Fixed

- **A web UI topic whose agent is working shows it.** The dot beside the topic, the "running"
  label and the Stop button all follow the agent's typing indicator, and the gateway sends that
  through the same write budget as everything else, dropping it whenever the budget is spent —
  right for a chat app, whose indicator fades by itself and is sent again 8 seconds later, but on
  the web UI it is a switch, and a dropped one stayed off. Up to 2.13 every topic shared one
  budget, so a topic whose agent was busy while another topic was streaming could stay dim for its
  whole turn; replaying the real write budget on a fake clock, not one of 38 signals got through in
  five minutes. 2.14.0 gave each topic its own budget, which left the case where a turn starts
  while its own topic is still sending the last one's output. The web UI's indicator is no longer
  rationed at all; it costs nothing, since the page is only told when it changes.

## [2.15.0] - 2026-10-31

### Added

- **The web UI can show a file the agent sent without downloading it.** A report, a plan or a log
  the agent sends is meant to be read, and until now reading one meant the downloads folder and
  another app — on a phone, an app that may not be there. Markdown, plain-text and source files now
  have a **Preview** button beside their name, which opens the file over the conversation: Markdown
  rendered the way replies are, with headings, tables and code blocks, and anything else as plain
  text, wrapped to the screen. The browser never receives the file itself, only HTML the gateway
  built from it and escaped the way it escapes every reply, so an `.html` or `.svg` the agent sends
  is shown as its source and cannot run. A file over 512 KB shows its first 512 KB and says so; the
  reader's **Download** link gets the rest. PDFs, office documents and other binary files have no
  preview and stay downloads. Preview lasts as long as the download link does, which is until the
  gateway restarts.

## [2.14.0] - 2026-10-31

### Changed

- **The web UI's menus are laid out as a grid, and a page holds 24 instead of 12.** `/cd`,
  `/model`, `/setting`, `/agent` and an agent's questions drew their buttons wrapped like words,
  so a page of directories was a ragged block whose columns moved on every row, and on a phone one
  or two buttons a row in no order. Each menu is now a grid sized from its widest label: several
  columns of short names on a desktop, never fewer than two on a phone, with a long model id
  wrapping inside its cell. The current choice is lit instead of marked by a grey dot, and Prev,
  Next and Back sit on a row of their own under the choices instead of among them. With the rows
  that much shorter, a page holds 24 in the web UI; a page of long model ids is still one phone
  screen. The chat platforms keep their 12.

### Fixed

- **A tap on a web UI menu no longer waits for other topics to finish writing.** Every web UI
  topic shared one outbound budget, the one-write-a-second-per-chat limit that keeps Telegram from
  answering 429. A browser has no such limit, but its topics all live on one channel, so whenever
  other topics were streaming, the menu's response queued behind them: about a second with one
  other topic busy, five with three. Each web UI topic now has a budget of its own, and the tapped
  button lights up at once, so the tap shows before the answer arrives. Chat platforms are
  unchanged: a Telegram forum's topics still share their chat's limit, as Telegram requires.

## [2.13.0] - 2026-10-31

### Changed

- **The web UI keeps every topic through a restart, not only starred ones.** A page that has gone
  quiet, such as a phone put down mid-turn, hears nothing more, so what the agent said after that
  was only in the gateway's memory, and an update took it. The page came back showing the turn
  stopped halfway, at a tool still running, though the reply had finished minutes before. The agent
  still had it and could summarise it, but the reply itself was gone. Since 2.5.0 the gateway had
  kept starred topics on disk. Now it keeps every topic, written within a few seconds of each change,
  so after a restart a topic comes back in every browser with everything said in it. A part this
  browser never received is filled in where it belongs, above the divider. This costs a write every
  few seconds for each topic in which something is being said, and at most 500 messages per topic
  on disk. Deleting, evicting or clearing a topic removes its copy. A star now only keeps a topic
  from being removed to make room and from "Clear unstarred topics". Topics that were not starred
  before this release have nothing kept, so they come back as before.

## [2.12.1] - 2026-10-31

### Fixed

- **A file an agent on a host sends to the web UI can be downloaded again.** The gateway fetches
  such a file from the host into a temporary one and deletes it once it has been sent. Every other
  platform has uploaded it by then, but the web UI only noted where the file was and read it when
  the link was clicked, so the link answered 404 — and the browser saved the error as a `.json`
  file. This was so for every file an agent on a host sent since remote hosts arrived in 2.9.0. The
  web UI now copies a file when it is sent and serves the copy, which also means a file the agent
  changes or deletes afterwards downloads as it was sent. Copies are kept as long as the link is,
  the last 200 files. A path that cannot be read now fails the agent's `send-file`, instead of
  posting a link that leads nowhere. Links sent before this release still lead nowhere; ask the
  agent to send the file again.

## [2.12.0] - 2026-10-30

### Changed

- **Restarting the gateway lets the turns in progress finish first.** Stopping the container, which
  is how the gateway is updated, stopped the agents on the hosts at once, so a turn in progress was
  cut off halfway. `talkcode update` therefore refused to run while anything was in progress, and
  had to be tried again until nothing was. Now a SIGTERM that finds a turn or a scheduled run in
  progress waits for it, for at most 30 minutes, before the gateway stops. Each busy conversation is
  told the restart is waiting for it. A message that would start a new turn gets a reply instead,
  since a turn started then would only make the wait longer or be cut off. Messages to a busy
  conversation, `/stop` and answers work as usual. Scheduled tasks do not start, and a run that
  falls due meanwhile is run when the gateway is back. A second SIGTERM, or SIGINT, stops at once.
  The host's `talkcode update` and `restart` no longer refuse: with work in progress they let the
  gateway finish it and go on in the background, logging to `update.log`, and return at once, so
  an agent that runs them can end its own turn. `--force` stops at once, as before. Docker gives a
  container 10 seconds to stop, so the host command passes a longer timeout, and the compose
  example in [Running in a container](docs/docker.md) sets `stop_grace_period`. The host command is
  not in the image, so it has to be installed again (`docker/talkcode-host`).

## [2.11.2] - 2026-10-30

### Fixed

- **The first thing asked of a host after a quiet spell no longer fails as "restarted".** The
  gateway closes a connection nobody has used for five minutes, and the host's talkcode-remote exits
  ten minutes after that, so the next request reaches a new one. The gateway then fails everything
  the old one was running, which is right — but it failed the new request with it, which had never
  reached the old one. That request was whatever came first: the directory list behind a bare `/cc`
  (which then answered with Claude's command list, and only the next `/cc` got the menu), a
  scheduled task (`talkcode-remote on host "uniagent" restarted`), or starting the agent for a
  message. A new process or request now waits for the connection and goes to the new daemon. And a
  bare `/cc` or `/new` whose last directory list failed now reads it again, waiting up to five
  seconds as for a list never read, instead of answering from the failure.

## [2.11.1] - 2026-10-30

### Fixed

- **Topic titles in the web UI's sidebar use the whole row.** On a computer, a row's ☆ and ×
  appear only under the pointer, but they were only made transparent, so they kept their place:
  every title was cut off about a quarter of the way short of the column's edge, in front of an
  empty strip. They now appear over the end of
  the row when it is hovered, and take no room otherwise; a starred row keeps room for its star
  alone. Phones are unchanged, since without hover the buttons are always shown.

## [2.11.0] - 2026-10-30

### Added

- **The web UI's sidebar says which machine each topic's agent runs on.** The line under a topic's
  title showed only its directory, and two agents of one harness on two hosts usually work in
  directories of the same name, so their topics read `workspace` alike and the agent id in the
  title was the only way to tell them apart. An agent on a remote host now has the machine in front
  of the directory (`devbox · workspace`), with `devbox:/home/user/workspace` on hover. The name
  is the agent's `group`, else its `host` — the one the `/agent` menu already groups it under — and
  is read from the current config, so it follows an agent that `/reload` moved. Agents on the
  gateway's own machine show the directory alone, as before.

## [2.10.0] - 2026-10-30

### Added

- **The names routing rules give agents are in the slash menu and `/help`.** An agent command
  selects the first agent of its harness, so a second one — an opencode on another host beside the
  local one — has none, and a `when: { command: oc2 }` rule gives it a name. Typed, that already
  worked, but nothing on screen said the name existed: the menu and the web UI's suggestions
  offered `/oc` and nothing for the other agent, and `/help` left it out. Those names are now
  registered and listed, described by the agent they select ("Use oc-a2 (opencode on devbox)").
  Only a rule whose one condition is the command counts, and only ahead of the first rule that
  matches on something else: the menu is the same in every chat, so it offers only names that route
  the same way in all of them. A rule naming something the menu already has (`/oc`, `/opencode`,
  `/help`) adds nothing.

## [2.9.2] - 2026-10-29

### Fixed

- **A bare `/cc` offers the directory menu for an agent on a host from the first time.** In a new
  conversation, `/cc` alone asks which directory to work in. For an agent on a host, the gateway
  has to list that directory over the link first, and it kept the list only in memory. So after
  every restart, the first new conversation per host got Claude's own command list instead, and
  the menu came back only on the next try. The same happened to the menu that follows `/new`.
  This went unnoticed while agents ran beside the gateway, and showed up the day every agent moved
  to a host. The gateway now reads every remote agent's directory as it starts and after `/reload`.
  If a list is still missing, it waits for it, up to five seconds, before it answers.

## [2.9.1] - 2026-10-29

### Added

- **A container image of the gateway alone: `ghcr.io/noir017/talkcode`.** Since 2.9.0 every
  agent can run on a remote host, so the gateway itself needs only Node and an ssh client, and can
  live in a small container of its own. The image installs the Release tarball, pinned by its
  `SHA256SUMS` line, so it holds the same bytes as `npm i -g <release URL>`. It leaves out the
  Claude Code binary that a local `harness: claude` would run, about 220 MB per architecture. Each
  release now publishes `X.Y.Z` and moves `latest`, for amd64 and arm64. See
  [Running in a container](docs/docker.md).
- **`talkcode update` on the machine that runs that container** (`docker/talkcode-host`, installed
  as the host's `talkcode` command). Updating the container restarts the gateway, and a restarting
  gateway stops the agents it started on its hosts. So before anything else, `update` and `restart`
  read the gateway's log for turns and scheduled runs still in progress, and refuse while there are
  any. `--force` goes ahead anyway; `--dry-run` only reports. After the restart they wait until
  every host is connected again, then remove the image that was replaced. Anything else, such as
  `talkcode doctor`, runs the talkcode CLI inside the container.

### Fixed

- **A host that presents a host certificate can be reached.** The gateway pins a host's key, but
  OpenSSH negotiates a host certificate first when the server has one. It then checks the key inside
  the certificate, which need not be the host key. A Teleport agentless node is such a host: its
  sshd carries a second key with a Teleport-signed certificate. So the key the docs tell you to
  check never matched, and every connection failed with "Host key verification failed". The gateway
  now leaves certificates out, and the server presents its plain host key.
- **`talkcode doctor` checks a remote agent where it will run.** It looked for the harness command
  on the host's login `PATH`, even for an agent whose `env` sets its own `PATH`, and failed a host
  that worked. It now looks in that `PATH`. Its agy status-line and Claude transcript checks also
  read this machine's disk for agents that run on a host; those agents now say they are checked
  there.
- **No more `spawn agy ENOENT` when the gateway starts.** For an agy on a host, the model list was
  first asked for on the gateway's own machine. That happened before the hosts were registered, so a
  gateway without agy logged an error at every start. The list still arrived later from the host.
  The hosts are now registered first, and an agy on a host is never asked for here.

## [2.9.0] - 2026-10-29

### Added

- **Agents on other machines: `hosts:` and `agents[].host`.** An agent can now run on any Linux host
  the gateway reaches over ssh, and the chat cannot tell the difference: replies stream, files go
  both ways, and `/cd`, `/skills`, `/usage`, the model, effort, context and cache countdown all
  work. Running `ssh host claude-agent-acp` as a `custom` agent was tried first (2026-10-28). The
  agent answered, but everything the gateway does besides piping its stdio broke: native tools,
  reverse commands, attachments, the cache countdown, agy's `/stop`. A dropped connection also took
  the agent down with it. So the gateway now installs a small helper on the host by itself,
  talkcode-remote: one static Go binary of about 4 MiB per architecture, carried inside the release
  tarball. The helper owns the agents and does the filesystem and command work locally, over one
  connection per host. It is deliberately simple. Reverse commands, MCP and the command table stay
  in TypeScript and are not copied: the `talkcode` command on a host hands its argument list back
  to the gateway, which runs its own CLI with it. Hooks and an agent's scheduled `--bash` tasks run
  on the agent's host. Files you send are placed there, and files it sends are fetched from there.
  The agent's environment is the host account's login environment, so the model keys in its
  `.bashrc` are there; nothing from the gateway's own environment is sent. ssh is pinned to the
  gateway's own key and known_hosts with strict checking, and the helper opens no network port. See
  [Remote hosts](docs/remote-hosts.md).
- **Agents keep working through a dropped connection.** The helper is a resident process on the
  host, not part of the ssh session. While the link is down the agent keeps running, and what it
  writes waits on the host (up to 64 MiB) until the connection is back. Messages and `/stop` sent
  meanwhile wait on the gateway the same way. Both sides number what they send and resend what the
  other has not acknowledged, so nothing is lost or delivered twice. The gateway's heartbeat
  notices a dead route within about 15 seconds and reconnects with a growing pause, from 1 to 30
  seconds. The silence is not counted against the agent, and an outage longer than 10 seconds is
  announced in the conversation, as is its end. Measured end to end with a real Claude Code: a
  30-second command, a route black-holed for 35 seconds in the middle of it, and the reply arrived
  a second after the route came back.
- **A gateway upgrade retires the old helper.** Each version installs its own helper on a host,
  named by the package version plus the binary's hash. The first connection from an upgraded
  gateway stops the previous version's helper and its agents, and removes its directory once no
  gateway uses it. A restarted gateway stops the agents its previous run had started. If that run
  died without stopping them, the restart stops them on its first connection, made at startup. A
  host that hears from no gateway for a day stops that gateway's agents.
- **`/agent`: choose any agent, grouped by machine.** `/cc` and the other agent commands name a
  harness, so with Claude Code on two machines they could only reach the first. `/agent` shows the
  machines, then the agents on the one you pick. `/agent <id>` chooses one directly. Agents are
  grouped by the new `agents[].group`, else by their host. A topic with a session keeps its agent,
  as with `/cc`.
- **`talkcode doctor` checks each host**: the key and known_hosts, a real connection, and the agents'
  commands on the host's login `PATH`.

### Fixed

- **An agent that cannot be started now says why.** A harness command missing from `PATH` used to
  fail the turn as "ACP connection closed", with the real reason only in the daemon log. The chat
  now gets that reason.

## [2.8.0] - 2026-10-28

### Added

- **An agent can ask you before it runs a tool: `permissions: ask`.** Claude Code asks for permission
  before commands and file edits in its default mode, and the daemon has always answered every one
  of those requests with "allow" on your behalf. That is still the default (`permissions: auto`).
  An agent set to `ask` puts each request in the chat instead, as a message showing the command,
  with the agent's own options as buttons. A request nobody answers within the hour (the same clock
  as the agent's questions, with the same half-hour reminder) is declined. The agent is told it went
  unanswered, not that you refused. The protocol has no field for that, and Claude Code's adapter
  turns a plain "reject" into "User refused permission to run tool", so the decline travels as an
  error message the adapter hands to the model verbatim. A contract test pins that behaviour of the
  adapter. A request that cannot be put to anyone, for example on a platform without buttons, is
  declined the same way with the reason given. It is never approved. Scheduled runs are approved as
  before, since nobody is there to answer, and `/stop` cancels a pending request with its turn.
  When measured, Codex (in its `agent` mode) and OpenCode ran a file-writing command without asking,
  so this changes nothing for them, and `agy`, which has no such requests, cannot be set to `ask`.

## [2.7.0] - 2026-10-28

### Added

- **`/reload` applies an edited config.yaml without restarting the daemon.** Until now every edit to
  the file took a restart, and a restart ends every conversation's agent process, including the
  one that made the edit. That process is a child of the daemon, so it cannot even restart the
  daemon itself without cutting its own answer off. `/reload` in any chat, or `talkcode reload`
  from an agent, re-reads `config.yaml` and `.env` and copies the result into the running daemon,
  then replies with what changed. Agents, routing, access, session, display, title and voice take
  effect at once. An agent whose definition changed restarts its process on each conversation's
  next message and resumes its session there. A turn already running finishes first, and a harness
  that cannot resume a session is left on its old definition until `/new` rather than restarted
  blank. Conversations bound to a removed agent move to whichever agent routing picks now, and the
  slash menu is registered again if the set of agent commands changed. `platforms` is the one
  section that still needs a restart, because the adapters connect with those credentials once,
  and the reply says so. A file that does not load changes nothing, `process.env` included, and the
  reply names the field that is wrong. Variables from `.env` are listed by name, never by value.

## [2.6.0] - 2026-10-28

### Added

- **An agent can run a command of yours before it starts: `hooks.preLaunch`.** Some agents need
  something in place before their process can start: a container started, a tunnel opened, a checkout
  pulled. Until now the only way to do that was to point a `custom` harness at a wrapper script,
  which gave up the presets' own handling and had to keep its own output off the protocol pipe. The
  daemon now runs the command itself, under `bash -lc` in the conversation's directory with the
  agent's `env`, before every start of the agent's process: the first message, `/new`, a respawn after
  an idle stop or a crash. It works for every harness. It blocks. A non-zero exit, or a hook still
  running after 60 seconds, fails the turn with the last of its output and the agent is not started,
  because an agent on a half-prepared machine is worse than none. `/stop` cancels it quietly, and a
  session closed mid-hook spawns nothing. Something the hook leaves running in the background (`ssh
  -fN`, `cmd &`) is not waited for and keeps running. Full output goes to
  `<configDir>/hooks/<agent>/`. The field is deliberately not in `/setting`: editing it from chat
  would be remote shell execution. Only this one hook exists for now. Events inside a session already
  have the harness's own hooks, and the gateway-only events (a failed turn, a platform reconnect) are
  waiting for a concrete use.

## [2.5.2] - 2026-10-27

### Fixed

- **agy's footer and the web UI's status strip show its context, model and quota again.** All three
  used to come from agy's status line, which the daemon points at a shim that hands them back over a
  pipe. agy 1.4.7 stopped running the status line in headless `-p` runs — the only mode its
  stream-json protocol works in — so from that upgrade on, every agy reply carried just the agent's
  name, and the strip lost its context bar and quota pools. The same release started reporting each
  model step's token count in the stream, and that is now where the context comes from. It is the
  step's count, with the cached part added back (agy leaves it out, so a Claude turn that hit the
  cache read as a few hundred tokens), and not the one in agy's `result`, which is a running total over the whole
  conversation and would have climbed past the window in a conversation that never came near it.
  agy still names no window size, so the window is looked up from the ones measured off its own TUI
  status line (Gemini, Claude Sonnet/Opus 4.6, GPT-OSS 120B); any other model shows no context
  numbers rather than a guessed percentage. The quota pools, and agy's default model when none is
  configured, are fetched with `agy -p=/usage` and `agy -p=/model` while the turn runs. Each takes
  about three seconds, so the quota is asked at most once a minute, and it comes in whole
  percentages, which is all that command prints. An agy older than 1.4.7 still reports through the
  status line, and the shim is still installed for it and for your own interactive agy.

## [2.5.1] - 2026-10-27

### Fixed

- **The web UI application icon (`icon.png`) is no longer truncated with a white bottom half.** The
  rasterized 192×192 PNG embedded in `manifest.ts` was originally produced using headless Chrome with
  `--window-size=192,192`. In Chrome's `--headless=new` mode, window-size sets the outer browser window
  dimensions rather than the inner viewport, so standard window decorations (about 87px) were subtracted,
  leaving only 105px of viewport height. The top half of the SVG prompt was rendered while the bottom 87px
  fell outside the painted area and showed default white canvas. The PNG has been re-rasterized from `ICON_SVG`
  without window decoration clipping, restoring the full dark background and blue cursor.

## [2.5.0] - 2026-10-24

### Added

- **A starred web UI topic keeps what was said in it across a restart.** A star used to keep the
  topic's row and nothing in it: the daemon holds transcripts in memory, so a restart or a container
  rebuild emptied every topic, starred or not. The browser's own copy was supposed to cover that, and
  for the topics worth starring it is the wrong place. It keeps the 24 topics most recently written
  in that browser, so a topic you starred and open once a week is exactly the one it has dropped, and
  a phone that never opened it has nothing. Two starred topics came back empty that way after a
  rebuild. The daemon now writes each starred topic's transcript to its own file beside the topic
  list (`webui-transcripts-<id>/`, readable only by you), within three seconds of any change and at
  once when you star it, and reads it back on start. After a restart it is there in every browser,
  above the line that says it is from before the restart, with its buttons removed, since the
  process that would have answered them is gone. Unstarring or deleting the topic removes the file.
  Unstarred topics are unchanged, and the notice an emptied one shows now says that a star is what
  keeps one. Checked against the real adapter stopped and rebuilt on the same directory, in Chromium,
  with and without a browser cache. Transcripts already lost are not recovered by this. The agent
  still has their context.

## [2.4.2] - 2026-10-24

### Fixed

- **A prompt sent from the web UI is no longer lost when the connection goes away mid-send.** When
  a Cloudflare Access session lapses, every request is answered with a redirect to its sign-in page
  on another origin, so the send fails, the stream cannot reconnect, and a reload is the only way
  back in — and the page lost messages to that reload in three ways. One still in flight at the
  reload was in no store at all and was simply gone. One that had already failed came back from the
  transcript cache, but the first sync sorted it above the whole topic, which on a long topic is as
  good as gone. And one still in flight when you switched to another topic, if it then failed, had
  no bubble left to turn red. Every send is now written to the browser's localStorage before the
  request leaves, and kept until the daemon has it. After a reload it is back under the
  conversation, where you land. If it was still in flight when the page went away it says it is not
  confirmed, until the sync says whether it arrived. If it never did, it turns red with **Retry**,
  which now works after a reload for anything that was text alone. A message that carried files
  still offers Copy and Discard, since the files are not kept. Checked in jsdom and against the real
  server in Chromium, through a proxy playing Cloudflare Access, a dead link, a lost answer and an
  offline browser. It has not been run behind the real Access entrance.

### Changed

- **The web UI saves your draft once you stop typing for a second**, as well as when you leave the
  topic or the page is hidden. Those two are the last events a page that goes away normally fires,
  but a tab that crashes, or one a phone kills while it is on screen, fires neither, and that used to
  cost the whole draft.
## [2.4.1] - 2026-10-21

### Fixed

- **A web UI message that never got an answer no longer sits grey for ever.** The grey bubble means
  "still being sent", and the page waited on the request with no limit: `fetch` has none, and only a
  network error or a 5xx was retried. A request that simply went quiet — a tunnel that took the body
  and stopped — therefore left the message grey with no red edge and no **Retry**, and the text was
  gone from the composer. Now an attempt is abandoned after 15 seconds, plus one more per 64 KiB of
  what is being sent up to five minutes (the most Node lets a body take anyway, so a 20 MB
  attachment on a slow uplink is not cut off in the middle), and the message turns red with Retry,
  Copy and Discard. A short message is retried twice first, under the same nonce, so one that had in
  fact landed is not sent twice; an attempt that was given over a minute is an upload and fails
  once, since starting it over from its first byte twice more is a quarter of an hour of waiting.
  The same failure now covers a body the browser cannot build into one string, which used to throw
  out of the send and leave the bubble grey. The page's timeout is exercised in jsdom with a
  stubbed `fetch`; it has not been run against a real browser and tunnel.

### Changed

- **A send the web UI's server refuses, or loses, now leaves a line in the log.** A 413, a 415 or
  a 400 told the page and nobody else, and a client that hung up in the middle of a body came out
  of the route as `request failed` with a stack trace — which is what every abandoned upload would
  have become once the page started abandoning them. Each is now one `[webui] POST /api/send:
  refused — …` line; the hang-up says how many of the declared bytes had arrived. Only the send
  route logs it: `api/login` is open to strangers. The `[in]` line also ends `(+N files)`, so "did
  it arrive with its attachment" can be answered from the log; before, a file sent without text
  logged an empty line.

## [2.4.0] - 2026-10-19

### Added

- **A picture you send reaches the agent as a picture, not as a path it may or may not open.**
  Every picture used to be saved and named in the prompt by its path, and what happened next was
  the agent's call: Claude Code spent a Read call on a screenshot it then looked at, or answered
  about one it never saw. Now Claude Code, Codex and OpenCode are given each picture as an image in
  the prompt itself — on all platforms, and for a message joined into a running turn as well as for
  a new one. Measured on cc and cx: two screenshots sent together had their codes read back, in
  order, with no tool call at all. The path line is unchanged, so an agent that wants the file still
  has it. Whether a harness gets pictures is decided by what it says it accepts when it starts
  (`promptCapabilities.image`), not by its name; one that does not, and Antigravity, whose input is
  text only, keep the path and the daemon log says so. Only PNG, JPEG, GIF and WebP, at most 3.75 MB
  each and 15 MB across the pictures sent together: past that a picture goes by path, also logged.
  The type is read off the file's bytes rather than taken from the platform. An image labelled as
  the wrong type is rejected by the model API, and since the prompt stays in the session's history,
  every later turn in that session would be rejected too. A picture whose pixels do not decode was
  tried on both cc and cx and left the session working. The cost is context: each picture is now
  in it from the start, up to about 4.8k tokens for a large screenshot, even when the agent would
  not have looked.
- **The web UI shows the pictures you sent, not just their names.** A screenshot pasted into a
  message used to become a file name once sent, so there was no checking what it had shown. Now the
  sent message has it as a thumbnail, up to 160px high and side by side when they fit, and a tap
  fills the screen. The daemon keeps that copy only while it runs, in `webui-uploads-<id>/` beside
  the topic list: the folder is emptied at startup, and a picture is deleted once the 200-file
  download table lets it go. So after a restart, a message from before it keeps the name and the
  picture is hidden, the same as a file the agent sent. The bubble shown while the message is still
  being sent has names only, and the pictures come with the daemon's copy a moment later. Drawing
  them sooner would put each whole file into that bubble, and that bubble is what the page saves if
  the send fails.

## [2.3.0] - 2026-10-17

### Added

- **A voice message is also written up as the message you meant, and that is what ✅ Send sends.**
  A transcript is word for word, and nobody speaks a request the way they would type it: the agent
  was handed every "then — then, put that, put it on the…" and every correction made mid-sentence
  along with the request. Now, after transcribing, the gateway asks the same model to rewrite the
  transcript — fillers, repeats and stutters dropped, "A — no, B" kept as B, misheard names fixed,
  three or more steps numbered — without summarizing anything away or adding anything that was not
  said. The card shows the cleaned-up version first and the words as heard beneath it, with a
  🗣️ Send as spoken button for when the rewrite got it wrong. The rewrite is a second, text-only
  request that never hears the audio: asking for both in one request with the recording was tried
  first, and on a three-second clip the transcriber answers with "no speech" it invented an entire
  request — "act as a code review expert and refactor this in Go" — as both versions. A cleanup
  that fails leaves the transcript standing and the card says why. On by default
  (`voice.cleanup`); `/setting cleanup off` goes back to word-for-word, live. It costs a second
  request per voice message, which matters on a free tier with a daily cap.
- **`voice.vocabulary`: the names your deployment says out loud.** The transcriber is told a few
  names to expect (talkcode, Claude Code, Codex…), but a deployment's own — its hosts, its
  services — were spelled by ear: "Unraid" came back as 安瑞 and 昂立. The list is added to the
  built-in one, and both the transcription and the cleanup are given it.

### Fixed

- **A transcriber answer that came back empty is retried, not reported as "no speech".** The
  transcriber is told to answer `[no speech]` for silence precisely so that silence and a missing
  answer can be told apart, but an empty answer was read as silence all the same, and the user was
  told their recording had nothing in it. Upstream returns one now and then (2 calls in 18 on
  2026-10-17) for recordings it transcribes on every other attempt. `blockReason: OTHER` is retried
  too: one model behind the `gemini-3-flash` alias returned it for an ordinary voice note on 6 calls
  of 7 in one minute and on none of the next 5.

## [2.2.2] - 2026-10-10

### Changed

- **A subagent's tool lines name it once, not on every line.** Since 2.0.1 each line a subagent
  produced led with `↳` and its name, cut to sixteen characters — and the name was repeated on all
  of them. A subagent's tools usually come as one long unbroken run, so on a phone half of every
  row was the same label and the command it was there to show had shrunk to `Bash: "cd /h…`;
  fifteen rows of one subagent's work told you its name fifteen times and almost nothing else. Now
  the first line of a run carries the name and the lines under it keep only the `↳`
  (`↳ 💻 Bash: "cd /home/user/…"`), so the width goes to the command. The name comes back wherever
  it is needed to tell lines apart: when the owner changes — the main agent, or another subagent
  running in parallel — and at the top of every new tool message, since the line it would refer
  to may have scrolled away. Every platform gets this, not only the web UI: in the chat apps, where a
  long line wraps instead of being cut, the label alone was enough to push a line onto a second row.

## [2.2.1] - 2026-10-10

### Fixed

- **An agy turn that replied is no longer reported as failed because of an error it already got
  past.** agy's end-of-turn `result` describes the whole conversation, not the turn — its turn
  count, duration and token usage are running totals, and its status follows suit: once a
  conversation has had one API error, even one agy retried successfully four seconds later, every
  later turn in it ends `status: ERROR` with that same error, restarted process or not. The
  gateway believed it, so on 2026-10-10 a scheduled run delivered its full report and was then
  marked ❌ (its schedule recorded as failed), and every turn in that topic afterwards got the
  same ❌ under a normal reply. The gateway now reads the stream instead: an ERROR result fails the
  turn only when the turn did not end in the agent's own reply — when its last output was an
  error step, a tool, or nothing. A turn that hit an error and then replied gets one ⚠️ line
  saying so; a turn where agy is only repeating an older error gets a line in the log and nothing
  in the chat. Real failures — retries exhausted, a run cut off mid-tool, nothing written — still
  end in ❌ with agy's reason.

## [2.2.0] - 2026-10-10

### Added

- **The web UI shows the whole tool command, folded until you ask for it.** A tool bubble's line
  carried the first 40 characters of a command on every platform (`tools.previewLimit`), which on
  a phone keeps a run of tools one line each — and also cut almost every command before the part
  that told two of them apart: a dozen rows of `cd /home/user/workspace/project-scripts...`. The
  web UI now receives up to 2000 characters per line and does the cutting itself, at the edge of
  the bubble, so a wide screen shows as much as fits and the ✓ and duration at the end of a line
  stay in view. Click a row to read it in full, and again to fold it; **Show all** under the bubble
  opens every row, including those the agent adds after it is pressed, and stays put while the
  bubble is still being edited. Commands are also shown verbatim now — a `*.ts` or a `foo_bar`
  in one was being read as markdown emphasis. Chat apps are unchanged: they show the text as sent,
  so there the short preview is still the right one.

## [2.1.0] - 2026-10-10

### Changed

- **A message sent while the agent is working no longer stops it.** Until now every message that
  arrived mid-turn cancelled the turn and started it again with the new input, so "also check the
  docs" cost a half-finished test run, and the only way to add something without losing the work
  was to wait. It now goes where Claude Code's own CLI puts what you type while it works: to the
  agent, which reads it at its next natural point — after the command it is running, before its
  next step — and answers it in the same reply. Probed on 2026-10-10 with a message sent six
  seconds into a thirty-second foreground command: claude (another `session/prompt`, which Claude
  Code queues and absorbs at the tool boundary) and codex (`_session/steering`, codex's
  `turn/steer`) both let the command finish and answered both requests in one reply. opencode
  rejects a second prompt over ACP and agy runs it as a separate turn, so on those two the message
  waits and is sent as soon as the turn ends — still without stopping anything. Slash commands
  always wait for the turn to end, since a command only runs at the start of a message. `/stop` is
  now the one way to stop a turn, and also the way out of a question whose options all fit badly,
  which used to be "type anything". The frozen `inbound.interruptOnNewMessage` switch is gone.

## [2.0.1] - 2026-10-10

### Changed

- **The README is an introduction again, and the manual moved to `docs/`.** At 680 lines it described
  every feature in full, so what a newcomer needs — what this is, what it looks like, how to install
  it — sat above forty screens of `/effort` levels and SSO claims. It now holds that, a screenshot
  of the web UI taken from a real Claude Code turn, the smallest working config, and an index. Each
  feature's description moved to its own page under `docs/` with its wording kept, and the Chinese
  to the same name under `docs/zh-CN/`. Three statements that had gone stale were corrected on the way: the web
  UI's topics are in a sidebar, not a row across the top (since 1.14.0); a daemon restart no longer
  empties the page, because the browser keeps its own copy of each topic (since 1.21.0); and the
  Chinese description of topic naming, which still said the name was chosen after the first answer,
  now matches the English — it is asked for as the turn starts.

### Fixed

- **A subagent's tool calls no longer pass for the main agent's.** When Claude Code hands work to a
  subagent, every tool call the subagent makes arrives tagged with the call that spawned it, but the
  gateway ignored the tag and drew those calls exactly like the main agent's own — so a background
  subagent's half-hour of fetching and backtesting read as the main agent doing eighty things it
  never did, in the same bubble. Its lines now lead with `↳` and the subagent's name, the short
  description the main agent gave the job (`↳ 回测按分红选股的收益与回撤 · 💻 Bash: "python3 …"`),
  which also tells two parallel subagents apart. The bubble for the spawning call itself now waits
  for that description and shows it, where it used to show whichever argument streamed in first —
  typically `{"subagent_type":"general-purpose"}`, which named nothing. A subagent's own narration
  stays out of the reply as before: the adapter keeps it internal, and the main agent's account of
  what the subagent found is what you read. Only the `claude` harness reports attribution; the
  others are unchanged.

## [2.0.0] - 2026-10-10

### Changed

- **The project is now talkcode, and every name it answers to changed with it.** It began as a fork
  of [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere) and kept that project's
  npm package name, `agent-anywhere-cli`, which belongs to the upstream maintainer: the npm badge
  and the `npm install -g agent-anywhere-cli` line in this README installed his 0.3.x, not this.
  He asked for a distinct name, and a new package name under the old project name would only have
  moved the confusion, so everything was renamed in one step:
  - the command, `agent-anywhere` → `talkcode` — and with it every reverse command an agent runs
    (`talkcode send-file`, `talkcode help`, …);
  - the config directory, `~/.config/agent-anywhere` → `~/.config/talkcode`, and the auto-created
    agent workspaces, `~/.agent-anywhere/agents/<id>` → `~/.talkcode/agents/<id>`;
  - the environment variables, `AGENT_ANYWHERE_*` → `TALKCODE_*`;
  - the package, `agent-anywhere-cli` → `talkcode`, so the release asset is `talkcode-X.Y.Z.tgz`
    and a global install lives at `$(npm root -g)/talkcode`;
  - the bundled skill and the MCP server, both now `talkcode`, which is also the name of the
    skill's link in each harness's skill directory;
  - the repository, now [noir017/talkcode](https://github.com/noir017/talkcode). Releases up to
    1.40.0 stay attached to `noir017/agent-anywhere`, which also still carries the branches of
    the pull requests open against upstream.

  **Nothing reads the old names** — no fallback to the old config directory, no alias for the old
  command, no `AGENT_ANYWHERE_*` honoured. There was one deployment, and its image's start script
  moves it across once; anything else has to move by hand: `mv ~/.config/agent-anywhere
  ~/.config/talkcode`, fix any absolute path inside `config.yaml` that names the old directory
  (the web UI terminal's `socket:` is the usual one), delete the stale `agent-anywhere` links in
  `~/.claude/skills` and `~/.agents/skills`, and `npm uninstall -g agent-anywhere-cli`. The two
  packages no longer share a command name, so installing talkcode does not displace the old one.
- **Installation is from the GitHub Release tarball.** talkcode is not on npm; the README now says
  so and installs `talkcode-X.Y.Z.tgz` by URL.

### Removed

- **The npm publish workflow.** It was fenced to the upstream repository and never ran here, and
  there is no npm package to publish to.

## [1.40.0] - 2026-10-09

### Changed

- **Nothing of the gateway's goes into the agent's prompt any more.** Every session used to open
  with a `<system-reminder>` in front of your first message — "Your replies reach the user
  automatically — just answer normally", the `send-file` command, and a pointer to
  `agent-anywhere help`. It had already been cut down from thirteen lines, but any text the gateway
  puts there tells the model what kind of job this is before it has read the job, and no wording
  avoids that. It is gone, and so are the two other places the gateway spoke to the agent in its own
  voice. A scheduled prompt no longer arrives prefixed with `[⏰ scheduled task …]`: it is the
  prompt the agent registered, sent as written, and the notice in your chat still says it ran. An
  attachment the agent has to open is now `[Attachment name: path (mime)]`, without "use the Read
  tool to view it when needed" — an instruction on how to work, naming a tool agy does not have.
  OpenCode and dsh are no longer told about `ask` up front; their models find it through the skill
  below, or ask in plain text.

### Added

- **`send_file` and `schedule` are native tools.** What the reminder used to teach now reaches the
  agent the way any capability does: every ACP session — Claude Code, Codex, OpenCode — is handed a
  small MCP server, `agent-anywhere mcp`, and the two tools sit in its tool list (Claude Code shows
  `mcp__chat__send_file`). They are the CLI commands behind a different door: the same validation,
  the same socket and session token, the same answers. Only these two, because a tool's definition is
  context paid on every request — on Claude Code these two measure about 1,030 input tokens
  (cached), where the reminder was about 80: one is the thing a text reply cannot carry, the other
  the thing an agent gets wrong unless it knows — asked for "every morning at 8", it reaches for its
  own scheduler, which dies with its process. Codex keeps MCP tools behind its own tool search, so
  it tends to find the same commands through the skill instead; the result is the same.
- **The bundled skill is linked for you.** The rest of the CLI — other chats, history, replies,
  edits, threads, button questions, voice transcripts — is found through `skill/SKILL.md`, which
  the daemon now symlinks where each configured harness that has been run on the machine reads
  skills: `~/.claude/skills` for Claude Code, `~/.agents/skills` for Codex and OpenCode,
  `~/.gemini/config/skills` for Antigravity. Each was checked by asking the model what it could
  see — Antigravity, for one, does not read the directory its own help names. The link points into the installed
  package, so the skill appears only where the daemon runs and is always the running version's own.
  Antigravity gets the skill but not the tools: it has no per-session way to add them, and the
  gateway will not edit its global MCP config. A real `agent-anywhere` directory already in one of
  those places — from `npx skills add`, say — is left alone with a warning; delete it to get the
  linked one. `AGENT_ANYWHERE_NO_SKILL_LINK=1` turns linking off.

## [1.39.0] - 2026-10-09

### Added

- **The web UI shows what you are about to send, and lets you take any of it back.** Until now an
  attachment in the composer was its file name and nothing else. You could not check a pasted
  screenshot before it went, and you could only get rid of one pasted by mistake by sending it,
  because switching topics keeps the draft along with its files. Now a picture appears as a
  thumbnail that opens full-screen when tapped, and every attachment, picture or not, has a × that
  removes it from the message. On a phone the × is a 44px target.

  The thumbnail is a `data:` URL rather than an object URL. The page's CSP has `img-src 'self'
  data:`, so a `blob:` URL would be refused and every thumbnail would show as a broken frame. Each
  chip is built once per file and then moved. A thumbnail's URL is the whole file again in base64,
  and rebuilding every chip on each paste would re-parse and re-decode every screenshot already
  attached. A picture the browser cannot decode (HEIC outside Safari) keeps its name and loses the
  broken frame. In the transcript, your sent message still shows its attachments as names. The
  page does not keep the bytes once they are sent, for the reason a failed message cannot be retried
  after a reload.

## [1.38.0] - 2026-10-08

### Added

- **The web UI shows the agent's live status above the composer.** One line: agent, model and
  effort; a context meter with tokens used; the session's cost; for claude, when the prompt cache
  expires; for agy, its quota pools with time to refill. The footer appended to each reply has the
  stable part of this, but only once per reply. The strip stays current between replies, which is
  when you decide whether to send the next message before the cache goes cold. Tap the strip to
  see the details: it wraps, and agy's pools that the current model is not using appear, dimmed.
  Fields a harness does not report are left out, not shown as zero. On a phone the token counts
  are hidden until the strip is tapped.

  Nothing is polled. The daemon pushes a status only when something it already handles changes it:
  an ACP `usage_update`, a frame from agy's status line, the end of a turn. Repeats are dropped and
  each topic gets at most one update every 2 seconds. Conversations on other platforms do none of
  this work. The browser counts down from absolute times with a timer that runs twice a minute,
  and only while a countdown is on screen and the tab is visible. Status events are not numbered
  and are not kept in the reconnect backlog, so a long turn cannot push the messages a reconnect
  needs out of it.

  claude's cache expiry is read from Claude Code's own session transcript, once per finished model
  cycle. That is the only source: headless Claude Code (which is how claude-agent-acp runs it)
  never runs a `statusLine` command. On 2.1.291 a whole turn produced zero calls. ACP does not carry
  the cache's 5-minute/1-hour TTL either. The transcript is Claude Code's private format, so if it
  changes, the strip loses its cache segment and shows nothing wrong. `doctor` reports whether each
  claude agent's transcript directory exists.

### Changed

- **No sender name reaches the agent anymore, in any conversation.** Messages from groups and
  threads used to arrive as `[<name>] text`, so that an agent could tell speakers apart. That
  never applied here: `access.allowFrom` admits one person, so the name only put their own
  handle at the start of every turn. It also reached further than intended. The prefix was
  skipped only for conversations of kind `direct`, and a Telegram private chat with topics
  enabled reports `thread`, so ordinary DMs carried the name too, as did a one-person Lark topic
  group. A quoted reply now reads `(replying to: "…")` without the quoted author, for the same
  reason. Group chats themselves still work exactly as before. Only the names are gone.

### Fixed

- **agy's status line is now set up on a machine where agy was first used after the daemon
  started.** The daemon points agy's `statusLine` at its own script, but it used to do that only at
  startup, and it skips any home where agy has never run. On a new machine the container starts the
  daemon before anyone logs agy in, so every agy turn reported no context usage until the next
  restart. The check now runs again before each agy process is started.

## [1.37.0] - 2026-10-08

### Added

- **Web UI topics can be starred.** A ☆ sits beside each topic's `×`. A starred topic is never
  removed to make room (see below), survives "Clear all topics" (the button reads "Clear unstarred
  topics" while any are starred), and is listed first in the sidebar. Its transcript cache, draft
  and terminal window survive the sweep on the page as well. The `×` still deletes a starred topic,
  and its confirmation says the topic is starred. The star is saved in the topic file only when it
  is set, so existing files are unchanged.

### Changed

- **A full web UI topic list now makes room instead of refusing.** The list holds 64 topics. The
  65th used to be refused, on the grounds that removing a topic leaves its agent session behind.
  On 2026-10-08 that limit was reached after two weeks of normal use, and `+` silently stopped
  working: the server answered `409 Conflict` and the page ignored it. Scheduled tasks that open a
  new topic per run had been falling back to posting into the chat for the same reason. Now the
  topic that has been quiet longest is removed first, and the log names it with its id and title,
  because that line is the only remaining way to find the session it leaves behind (in
  `conversations.json`, exactly as after a `×`). A topic is skipped if removing it would break
  something: a turn is running, a question is waiting for an answer, an agent process is still
  resident, a terminal is attached, or a scheduled task that can still run posts into it. Starred
  topics are always skipped.

### Fixed

- **The web UI says why a new topic could not be opened.** A refused `+` now shows the daemon's
  own explanation ("every one of the 64 topics is starred or in use; unstar or delete one before
  opening another"), and the daemon logs the refusal. Before, the page dropped the error and the
  daemon logged nothing, so the only trace was a 409 in the browser's network panel.

## [1.36.3] - 2026-10-06

### Fixed

- **cc no longer reports "hung" while Claude Code is retrying a failing API.** On 2026-10-06 the
  API gateway first left a request hanging for five minutes, then answered `500` and a run of
  `503`s. Claude Code kept retrying the whole time, but said nothing over ACP, so after ten
  minutes the turn failed with "sent no update for 600000ms; treating it as hung" and the agent
  process was killed. claude-agent-acp does report every retry, as a typed failure record, but
  only to a client that asks for those records when it connects, and the gateway never asked. It
  now asks, for the `claude` harness only. A retrying turn stays alive, and the chat gets one
  notice per cause (`⚠️ cc: Retrying Claude, attempt 2 of 10.`), not one per attempt. If the
  retries run out, the turn fails with the provider's own error text instead of a guess about a
  hang. Asking for the records also changes how the adapter reports a failed turn: it now ends
  the turn normally and puts the failure in metadata. The gateway reads that, so a failed turn is
  still reported as failed. A background task's failure, which the adapter used to write into the
  agent's own text, is posted as a notice. Failures the adapter replays from a resumed session's
  history are logged and not posted, since they are old news.

## [1.36.2] - 2026-10-03

### Fixed

- **agy's `/model` list now shows models added since the daemon started.** The list was read
  from `agy models` once, when the daemon started, on the assumption that it only changes when
  agy is upgraded. It does not: Google serves it, and on 2026-10-03 an agy binary that had not
  changed since 09-29 offered Claude Opus 5.5 while a daemon started on 09-29 still showed the
  older list, and `/model claude-opus-5-5-medium` answered "No model matches". Only a restart
  fixed it. Every `/model` now asks `agy models` again (about a second and a half, while the
  typing indicator is on) before answering. If that run fails or comes back empty, the previous
  list is kept, so a brief network failure does not turn into "this harness offers no model
  selector". The same refresh also recovers a startup fetch that failed, which used to leave
  `/model` broken until a restart.

## [1.36.1] - 2026-09-30

### Fixed

- **`/usage` and `/context` no longer interrupt a running turn.** Both were passed to the agent
  like any other message, so with `interruptOnNewMessage` on (the default) asking how much a turn
  had cost cancelled it. On cc that meant a Bash call running the test suite was killed so that
  Claude Code could answer `/usage` locally in under 50 ms, and the work then sat stopped until
  someone noticed and typed "继续". While a turn is running, or a message is still inside its merge
  window, the gateway now answers these itself, on every harness that would otherwise have been
  sent them (claude, codex, gemini, custom): `/context` with the same numbers the footer uses, and
  `/usage` with the context, the session's cumulative cost as of the last finished turn (claude
  reports it; codex does not, and the reply says so) and how long the turn has run. The reply ends
  with a line saying it is the gateway's snapshot and that sending the command again once the turn
  ends gets the agent's own, fuller answer. An idle conversation still gets the agent's own answer.
- **A command typed while the agent has a question on screen is no longer taken as the answer.**
  Sending `/usage` while cc waited on a button question used to file the literal text "/usage"
  away as the reply to that question. A command from the registered menu is now treated as a
  command, so the question stays on screen for its real answer. Text that merely starts with a
  slash, like a path, still answers the question.

## [1.36.0] - 2026-09-30

### Changed

- **A topic keeps the agent it started with.** Naming another agent (`/oc …`, or `/oc` alone) in
  a topic whose agent already has a session used to switch the topic over in place. That was
  unused — none of the 335 conversations on the live deployment had ever held two agents'
  sessions — and what it produced was a topic whose tag, header and history named one agent while
  another answered it with none of that context. It is now refused, and the refusal is a handover
  note: the answering agent's session id and working directory, in code spans so a tap copies
  them. To carry the work on with another agent, open a new topic with that agent's command and
  give it the id; it can read the earlier conversation off disk itself (a Claude Code session id
  is the transcript's file name). A topic with no session yet — a new one, one whose first turn
  never got a session started, or one `/new` has just cleared — still takes whichever agent you
  name. The menu entries now read "Use claude" rather than "Switch to claude".

### Added

- **Scheduled tasks.** Asked for "every morning at 8, …" or "in half an hour, run the backup", an
  agent now registers a task the gateway keeps, in `<configDir>/schedules.json`. The harnesses have
  schedulers of their own, but those live in the harness process, which the gateway reclaims after
  an idle hour and restarts on every upgrade, so a daily job set up that way was gone by lunchtime.
  There are three kinds. A prompt in a **fixed session** is a turn in the conversation it was
  registered from, answered by that conversation's agent, so context builds up and you can follow
  up in place; it lives 24 hours and is then marked expired. A prompt in a **new session** starts a
  fresh session every run, in a new topic where the platform can open one (web UI, Telegram
  forums, Discord), and has no time limit. A **bash** task is run by the gateway itself, and its
  exit code, duration and the end of its output are posted, with the full log attached when it is
  long. Output can go to any chat the gateway has answered in, on any platform. A run the gateway
  missed by less than an hour, because it was restarting, is made once when it comes back; an
  older one is recorded as missed. A run that comes due while the previous one is still going is
  skipped. A scheduled turn never cuts off what you are in the middle of: it waits behind the
  running turn and behind your queued messages. Every change posts a card with the task's details,
  written by the gateway, not retold by the agent, so what you read is what will run. `/setting`
  gains a **⏰ Scheduled tasks** button listing every task with its next and last run, with pause,
  resume and a two-tap delete; `/setting schedule pause|resume|delete|run <id>` does the same where
  there are no buttons. The harness schedulers are left enabled, because the gateway does not edit
  an agent's toolbox; the help page tells the agent which one survives.
- **The agent's instructions load on demand: `agent-anywhere help <topic>`.** The hint injected
  into a session's first turn gains one line. It points at `agent-anywhere help` and names the
  three things an agent could not guess the gateway does: scheduled tasks, posting to other chats,
  and chat history. Each help page prints its commands, rendered from the command catalog so they
  cannot drift, and its rules. A command now has to name the page it is documented on. This is the
  skill pattern done in the CLI, because every harness here has a shell and not all of them load
  skills. MCP tools would have been the opposite: only Claude Code defers their definitions, and
  opencode, codex and agy would carry every schema in every request. Tested 2026-09-30 against a
  throwaway daemon: asked in plain words to run a command in two minutes, Claude Code read
  `agent-anywhere help`, then `help schedule`, then registered the task correctly, told nothing
  beyond the pointer line. `help <command>` still shows one command's flags, and `--help` still
  lists everything.
- **`agent-anywhere channels`, and `--channel` that can name another platform.** An agent could
  post to another chat only on the platform it was answering on: an address alone cannot say
  which platform it is on, so every `--channel` went to the caller's own instance, and an agent
  answering on the web UI had no way to reach Telegram. A target can now carry its instance —
  `tg:5865716608/8068`, `web:main/21316953` — and `channels` lists every chat and topic the gateway
  has answered in, in exactly that form: chat roots first, then the most recent topics, with their
  titles and agents, filterable by platform or text. The list comes from `conversations.json`
  because most platforms cannot enumerate a bot's chats (the Telegram Bot API has no call for it),
  which is also why it only holds places someone has actually talked to the bot in. The store now
  records each conversation's lane and last use for this; records from before the upgrade are read
  off their keys until their next turn writes both. An unqualified `--channel` means exactly what it
  did, including ids that contain a colon.

## [1.35.0] - 2026-09-29

### Changed

- **Web UI: coming back to a topic puts you where you were reading.** Switching topics used to
  land every transcript at the bottom, so reading back through a long answer, checking another
  topic, and returning meant finding the place again by hand. The page now remembers the message
  at the top of the screen when you leave, and how far it was scrolled, and puts you back on it.
  That is a message, not a scroll offset, because on a long topic the transcript comes back from a
  200-message cache and the sync then adds older messages above it: in Chromium, on a
  250-message topic, the same message comes back to within a pixel after both the cache and the
  sync. A topic you left at the bottom still comes back at the bottom, with whatever arrived while
  you were away on screen. Once you have scrolled a topic that is still loading, the sync that
  finishes it no longer pulls you back. The position is kept in memory only, so a reload still
  opens at the bottom.

### Fixed

- **Web UI: each topic has its own composer.** One text box served every topic, so a half-written
  prompt followed you into the next topic. So did its attachments, and a screenshot pasted in one
  conversation went out with the next message sent in another. Text, caret position and
  attachments now belong to the topic they were typed in. The text is also saved in the browser,
  so a reload keeps it. It is saved when you switch topics, send, or put the page in the
  background, never on each keystroke. Attachments stay in memory, for the same reason a failed
  message cannot be retried after a reload. A draft over 64 KB stays in memory too, so it cannot
  fill the browser's storage. Deleting a topic, or clearing all of them, throws its draft away.
  Neither change costs anything measurable: switching between two empty composers touches no
  storage and no DOM, and in Chromium a switch into a 250-message topic took 88.6–92.6 ms
  afterwards, against 84.6–90.7 ms before, which is within run-to-run noise.

## [1.34.2] - 2026-09-29

### Fixed

- **A failed turn no longer throws away the answer it had already written.** Reply text is sent
  when its segment completes, at the next tool call or when the turn ends, so the part after the
  last tool, which is usually the conclusion, sits in a buffer until the very end. When a turn
  failed, the gateway posted `❌ This turn failed` and dropped that buffer. On 2026-09-29 a web-UI
  conversation lost a complete 613-character answer this way: the model finished at 10:21, and at
  10:31 the only thing the page gained was the ❌. A failed turn now sends what it has first, with
  no footer (like an interrupted one), and then the failure. This applies to every failure, not
  only timeouts.
- **Claude Code turns no longer hang for ten minutes when the message is answered inside a
  background report.** When a background task finishes, Claude Code starts a turn of its own to
  report it. A message sent during that turn gets folded in and answered there. But
  claude-agent-acp files that turn's result as Claude Code's own work, so the message's request
  never completes (upstream issue #1145, still open and unfixed in 0.84.0). The answer arrived,
  then the conversation sat on "running" until the silence watchdog failed it as hung. Most
  occurrences went unnoticed because sending another message cancels the stuck turn; this one
  surfaced because the user waited. The adapter still reports the origin of each result, so a
  turn that sees a background cycle end and then 30 seconds of silence now ends normally. It
  sends no cancel, so a message that was only queued behind that cycle is not cut short: if its
  reply comes later than that, it still arrives, as a background update. And a turn now ends only
  on its own prompt's completion, so the late completion the adapter delivers at the next message
  cannot end that next turn early.

## [1.34.1] - 2026-09-26

### Fixed

- **A long reply is cut between blocks, not wherever the message ran out.** A reply longer than
  the platform's limit went out as several messages, cut at the last line break that fit — so a
  4,632-character Telegram reply split its closing list of four questions into 1–2 at the bottom of
  one message and 3–4 at the top of the next. The section heading and half the list scrolled out of
  sight, and it read as if part of the reply had gone missing; the agent, asked about it, then
  guessed "truncated", although every character had been delivered. A cut now prefers a blank line
  or the line before a heading, as long as the message stays at least three quarters full, and
  never leaves a heading or a bold-only title line as a message's last line. Replaying that reply,
  the second message now starts at the heading with all four questions under it, in the same number
  of messages. Over the 308 long replies on the operator's machine, cuts inside a list fell from 110
  to 67 at QQ's 1000-char limit, and titles stranded at the bottom from 29 to 6, for 0.6 % more
  messages; at Telegram's limit the count did not change. A continuation also no longer opens with
  the newline it was cut at.

## [1.34.0] - 2026-09-25

### Added

- **Voice messages.** A voice note — or an audio file sent without a caption, or a recording from
  the web UI's new 🎤 button — is transcribed and shown in the chat as a `🎙️ Voice transcript` card
  with ✅ Send / ✖ Cancel before anything reaches the agent. Send hands the words on as if they had
  been typed; the agent is not told they were spoken, because the person who spoke has just read
  and approved them. Typing instead of tapping replaces the transcript, `/stop` and `/new` call it
  off, and an untouched card expires after 30 minutes — each of which the card then says, so
  scrolling back always shows which messages came from a voice and whether they were sent.
  `voice.confirm: false` (or `/setting voice off`, live) sends each transcript on at once, still
  posting the labelled card first; that is meant for once recognition has earned trust, which is
  why confirmation is the default. Audio with a caption is left alone — "trim this" plus an mp3 is
  an instruction about a file — and without a `voice:` block nothing changes. The transcriber is any
  Gemini `generateContent` endpoint; verified against newapi's google-ai-studio channels with real
  Telegram, Chromium WebM and Chromium MP4 recordings. Its latency there is erratic rather than slow
  (the same six-second note took 1.3 s on one call and 65 s on another), so a stalled attempt is
  abandoned and retried instead of waited out, and a 503 "high demand" is retried too.
- **`agent-anywhere voice-log`** lists the conversation's recent transcripts — what was heard, what
  became of it, and the saved audio file — for the turn where a message reads like a mishearing.
  Every transcription is also logged to `<configDir>/voice-log.jsonl` (0600). It is deliberately not
  advertised in the agent's prompt; `--help` and the bundled skill document it.

### Fixed

- **A voice note with no caption no longer puts the whole recording into the prompt as base64.**
  When a message had no text, the adapter's own `content` was used instead — and adapters build that
  by serializing the message's elements, so for a Telegram voice note it was
  `<audio src="data:audio/opus;base64,…"/>`. A 25 KB voice note reached the agent as 34,000
  characters of base64, above the attachment line that already pointed at the saved file. The
  fallback now applies only to a message with neither text nor attachments.

## [1.33.2] - 2026-09-24

### Fixed

- **An agent reporting back on background work shows as running, and `/stop` stops it.** Claude
  Code ends its turn once it has put a long job in the background, and when the job finishes it
  picks up again on its own — that is the `⏱ background update` message. None of it held the typing
  indicator, which is what every "running" signal is read from, so on the web UI a conversation
  running minutes of deploy commands showed a topic marked idle, no "running" label and no Stop
  button. `/stop` typed by hand answered "Nothing is running here" under tool bubbles that were
  still appearing, because from the daemon's side no turn was open. A background update now holds
  the indicator from its first output until it is sealed. `/stop` sends the harness a cancel even
  with no turn open (claude-agent-acp interrupts that work too; checked against a live session,
  which answered the next message normally), marks the tool it was running ✗, and answers
  `⏹ Stopped the background work`. While the agent is only waiting on a background process, the
  topic stays idle and `/stop` still says nothing is running: no model call is in progress, so there
  is nothing for a stop to reach, and the background job is not touched.
- **A background update's footer names the model and effort again.** It read `cc · 429k / 1M (43%)`
  directly under a reply footed `cc · 429k / 1M (43%) · opus-5-5 · high`. The harness reports both
  once, when the session starts, and only a turn was being told them — so a background update fell
  back to config, which for the `claude` harness names no model at all.

## [1.33.1] - 2026-09-23

### Fixed

- **An agy conversation left on agy's default model names that model in the footer again.** The
  footer took agy's model from the `init` event agy opens every session with, and until agy 1.2
  that event named the model even when nobody had chosen one. On agy 1.2.9 it names one only when
  `--model=` asked for it — so every conversation on agy's default showed its context numbers and
  no model, and the `/model` menu could not mark which one was current. agy still reports its
  default to the status line, so the model now comes from there, respelled as the id `agy models`
  lists (`Claude Sonnet 4.6 (Thinking)` becomes `claude-sonnet-4-6`) so it reads the same as a
  model picked from the menu.
- **agy's context numbers describe the turn they are printed under.** agy refreshes the snapshot
  it hands its status line only after a reply is done — measured at ~260ms after the turn ended —
  and the footer read it the moment the turn ended, so it always showed the count from one step
  earlier: `0` on a conversation's first turn. The runtime now waits for that refresh, for at most
  1.5 seconds.

### Changed

- **agy's status line reports straight to the daemon, over a pipe, instead of through files.** The
  shim the daemon installs as agy's `statusLine` used to write one JSON file per conversation for
  the daemon to read back, and none was ever deleted (39 had piled up on the machine that prompted
  this). It now writes each snapshot to a fourth descriptor the daemon opens when it starts agy,
  which agy passes on to the shim. Each snapshot therefore reaches exactly the agy process it came
  from, and the daemon can wait for the next one — which is what the fix above needed. The old
  directory is removed on startup. agy does not document that it passes the descriptor on (1.2.9
  does), so if a later release stops, the daemon says so in its log once rather than letting the
  footer quietly lose its numbers. Under an agy you start yourself, the shim only draws the status
  line, as before.

## [1.33.0] - 2026-09-23

### Added

- **`/kill` ends the agent's process and keeps the conversation.** `/stop` asks the agent to stop,
  and an agent stuck inside a tool call never answers — until now the only command that could
  still end it was `/new`, which also threw away everything you were trying to keep. `/kill`
  ends the process the way the idle timeout already does: the next message starts a fresh one
  that reloads the session and carries on. Mid-turn it stops the turn first and drops anything
  queued behind it, so the queue cannot start the agent straight back up. An agent that cannot
  reload its session (its harness does not offer `session/load`, or no session id has been
  recorded for it yet) is left running and says so, rather than quietly turning `/kill` into
  `/new`.
- **The web UI has buttons for both.** Beside the topic's title, a power button — shown while an
  agent process is up, the same moment the sidebar dot is lit — sends `/kill`; beside Send, a
  **Stop** button — shown while a reply is running — sends `/stop`. They send the command exactly
  as typing it would, so it appears in the transcript with its answer, and a half-written message
  in the composer stays where it is.

## [1.32.0] - 2026-09-23

### Added

- **`/effort` shows and changes how hard the agent thinks, from the chat.** On claude, codex and
  opencode: `/effort` alone opens a menu of the levels with the current one marked (a line of text
  on LINE, QQ and the other platforms that cannot edit buttons), and `/effort high` — or any
  unique start of one, `/effort x` for `xhigh` — switches it for the conversation from the next
  message on. No turn is spent: all three expose the level as the same ACP config option that the
  footer already reads (checked against each on 2026-09-23), so the gateway sets it directly.

  The levels belong to the model, not the harness, so they change with `/model` and a model can
  have none. opencode offers them only for models with reasoning variants; codex only for models
  in the installed codex-cli's own catalog — `gpt-6-luna` is missing from 0.155.1's and present in
  0.156.1's. In those cases `/effort` names the model and what would change it rather than a bare
  "not supported". A `/model` keeps your level where the new model offers it and leaves it alone
  where it does not.

  The choice survives the agent being stopped for idleness, and that took work: claude and codex
  both come back from a reload at their default level, not the one you left them on, so the
  gateway sets it again each time the agent restarts. It ends with `/new` or a restart of the
  daemon itself (so, in a container, with every upgrade), like a `/model` choice.
  agy has no such setting — its thinking variants are separate models, chosen with `/model` — and
  now says so directly instead of starting a one-shot `agy` process to print "not adjustable".

## [1.31.2] - 2026-09-23

### Fixed

- **Claude turns work when the daemon uses the global Claude Code binary.** The daemon strips
  inherited Claude session markers before starting an agent, but that also removed
  `CLAUDE_CODE_EXECUTABLE`, the path needed after the SDK's bundled binary was removed. Keep
  that one variable while continuing to strip the markers that trigger nested-session rejection.

## [1.31.1] - 2026-09-23

### Fixed

- **A web UI topic stops showing amber once you have written into it.** `/cc` offers a
  directory menu; typing `hello` instead of tapping one got an answer, yet the topic kept pulsing
  "awaiting you" indefinitely. Amber meant "a message here still carries buttons", and an ignored
  menu is never retired — its buttons stay, and stay clickable, which is right; the dot claiming
  the topic was blocked on you was not. Your own message now ends every wait that was on screen.
  A real question loses nothing by this: text sent while one is pending is taken as its answer,
  and a question asked after your message marks the topic again.

## [1.31.0] - 2026-09-23

### Fixed

- **The web UI no longer asks for the password after every update.** Sessions lived only in the
  daemon's memory, and in a container every release is a restart, so each upgrade signed
  everyone out. They now persist beside the topic list in `webui-sessions-<id>.json` (`0600`).
  The file holds an HMAC of each session id keyed by the configured `token`, not the ids
  themselves, so reading it does not sign anyone in — and changing `token` is now the way to
  log every browser out. Separately, the cookie's own one-week `Max-Age` is renewed whenever
  the page loads: the server already slid the session on every use, but the browser still
  dropped the cookie a week after login however often the tab was used.

## [1.30.0] - 2026-09-23

### Added

- **The footer shows the reasoning effort beside the model.** `cc · 18k / 1M (2%) · opus-5-5 ·
  high`. Effort changes what a reply costs and how long it takes as much as the model does, and
  until now the only way to learn which level a session was on was to ask it. The level is the
  one the harness reports, not one the config claims, so a `/effort` mid-session shows up on the
  next reply. It is on by default as a new `effort` entry in `display.footer.fields`; a config
  that lists its fields explicitly keeps exactly the line it had, and gets it by adding `effort`.

  Claude, Codex and OpenCode all report it (checked against each on 2026-09-23). They name the
  option differently (`effort`, `reasoning_effort`) but file it under the same ACP category,
  `thought_level`, which is what the footer reads. The segment is left out rather than guessed in
  three cases: OpenCode on a model without reasoning variants, which offers no level at all; a
  harness sitting at `default`, which names no level and would only look like one; and agy, which
  has no such setting (`agy -p=/effort` answers "not adjustable") and puts it in the model name
  instead, e.g. `Claude Sonnet 4.6 (Thinking)`.

## [1.29.0] - 2026-09-23

### Fixed

- **Claude model requests use a current Claude Code runtime.** The Claude ACP adapter bundles its
  own Claude Code binary; upgrading the global `claude` command does not update that runtime. The
  adapter now bundles Claude Code 2.1.280, required by current models.

## [1.28.0] - 2026-09-22

### Added

- **The web UI shows a picture the agent sent, instead of only naming it.** A screenshot arrived
  as a link called `shot.png`, and looking at it meant downloading it, finding it in a folder and
  opening it somewhere else — three steps to see something the agent had just produced *so that
  you would look at it*. Images now draw in the bubble, capped so a 4K screenshot does not push
  the rest of the transcript off the fold, and tapping one fills the screen. Not a new tab:
  installed as an app there is no tab bar to come back from, so leaving the app would have been
  the same friction in a different shape. The download link stays underneath — it is still the
  only route onto disk, and it is what a picture whose file has since been evicted degrades to.

  This bends the rule that every published file leaves the daemon as `application/octet-stream;
  attachment`, which exists so an agent-sent `.html` cannot render on the origin holding the
  session cookie. The exception is a closed list of raster formats decided in one place
  (`inlineImageType`), read by both the page and the server so they cannot disagree about the
  same file. SVG is deliberately not in it — it is XML with `<script>` in it that a browser runs
  as a document, the one image format that is also code — and neither is PDF. What makes trusting
  the extension safe is `nosniff`, which pins a file merely *named* `.png` to the type we
  declared: it renders as a broken image rather than as a document. Inline responses also carry
  `default-src 'none'; sandbox`, for the browser that ignores the other two headers.

  Your own uploads are still shown as named chips rather than thumbnails. They are base64 in the
  request body and never stored, which is the same reason a failed message cannot be retried
  after a reload.

## [1.27.0] - 2026-09-22

### Changed

- **The web UI's topic dot says what the topic is doing, rather than whether a turn is open.**
  Two states were being painted as something they are not. A question on screen kept the running
  blue, because the turn it belongs to *is* still open and still typing — so the one row on the
  sidebar that needed you to look at it looked exactly like the one grinding through a build. And
  a topic whose turn had ended went grey immediately, alongside every topic from last week, even
  though its agent was still resident with the whole conversation in memory and would answer the
  next message instantly.

  So the dot is now about the agent rather than about the turn: grey when nothing is resident,
  dim blue when a child is up and idle, blue and pulsing while a turn runs, amber and pulsing
  while a question is waiting on you. The header follows the same order and says "awaiting you"
  where it used to say "running", because during an ask both are true and only one of them is
  worth the space.

  The waiting state is derived in the page's own room rather than asked of the daemon, since it
  already holds the fact — every ask, elicitation round and menu arrives as a message with
  buttons and is retired by stripping them. Residency is a new lookup the daemon hands to
  adapters that can show it (`useLivenessLookup`, the same seam as the directory label), answered
  from the same `reclaimState` the idle sweeper consults, so the sidebar and the sweeper cannot
  disagree about what is running. That one is polled, and it is the only polled thing in the
  module: everything that turns it on already announces the list, and nothing announces it going
  off — an idle reclaim fires on a timer in a conversation nobody is touching, and a child that
  crashed is quieter still.

## [1.26.0] - 2026-09-21

### Added

- **The terminal is a window now, one per topic, and the switcher says which topics have one.**
  The pane was a mode: opening it swapped the transcript, leaving it tore the iframe down, and a
  topic switch dragged the single pane along behind you. Every one of those is wrong once you
  keep a terminal around for more than a minute — going back to the chat to read something meant
  hanging up on whatever was running, and there was nowhere on the page that said a terminal
  existed at all.

  So the pane grew a title bar with two controls that mean deliberately different things.
  **Minimize** hides the window and does nothing else: the iframe stays mounted and its
  WebSocket stays up, so coming back is a repaint rather than a reconnect and a redraw.
  **Close** ends the session, after a confirmation, and is a server round trip rather than a
  teardown — because dropping an iframe only hangs up on a shell that carries on without us.
  Windows are keyed by topic and outlive a switch, which is not a convenience: a single window
  following whichever topic is on screen would hang up on the one being left, and that alone
  would make the new marker meaningless, since at most one topic could ever be lit.

  The marker is fed by the daemon counting the terminal WebSockets it is proxying — a thing it
  already had in its hands, and the most it can honestly know. It says *a page is attached to
  this topic's terminal*, which is not the same claim as *a shell is alive over there*: close
  every tab and every marker goes out while the sessions carry on. Asking the far side the
  stronger question would mean teaching this process what is behind the socket, which is the one
  thing `terminal-proxy.ts` exists to avoid.

- **`terminal.endCommand`, so the close button can exist at all.** A session survives a dropped
  connection only because the operator's wrapper is `tmux new -A`; ttyd itself SIGHUPs its child.
  Undoing that is therefore *their* arrangement to describe, so it is configuration — an argv
  array with `{topic}` substituted, run through `execFile` with no shell, which is what makes a
  browser-supplied id an argument rather than syntax. Where no command is configured the window
  has no close button rather than one that cannot work, and the route answers 501 rather than
  pretending. Hard-coding `tmux kill-session` here instead would have traded "works with any
  backend" for "works with the one we guessed".

## [1.25.0] - 2026-09-21

### Added

- **Single sign-on for the web UI: the proxy in front can be the door.** The page's login was one
  shared secret — no name on it, no expiry, and no way to revoke it for one person while leaving
  it working for another. That is the right size of lock for a loopback bind and the wrong one for
  a page published to the internet, which is where this one increasingly is. A new `sso:` block
  points the daemon at an identity-aware proxy's public keys: Cloudflare Access and Teleport's
  Application Service both authenticate a *person* — SSO, MFA, an access list maintained where the
  operator maintains everything else — and state the result in an RS256 JWT. The daemon verifies
  that signature and lets the named person in. One module covers both providers because they
  differ only in a header name, a JWKS URL and which claim holds the person.

  `from` is a required field and not an optional hardening step, which is the design decision
  worth recording. The signature is already what makes a forged header useless; the CIDR
  allowlist is what keeps a mistake in `jwksUrl`, `issuer`, `audience` or `allow` from being
  fatal — the same belt-and-braces the IPC socket gets with both 0600 and a token. It costs one
  line of YAML and turns "my verification must be perfect" into "and you must also be the proxy".
  For the same reason nothing that decides *who* gets in has a default: a permissive `audience`
  would accept a token the provider minted for some other application of the same tenant.

  `sso.password: false` then closes the shared-secret door, and the page renders a gate with no
  field in it — under SSO there is no secret that works, so a password box turns "your session
  with the identity provider expired" into "that is not the right token" and sends the operator
  looking for a credential instead of signing in again. `doctor` now fetches the JWKS and reports
  how many keys it found, because a URL with a typo in it fails closed at 3am on a phone rather
  than at the terminal where it was written.

### Changed

- **The web UI and the terminal pane now say who may frame them** (`frame-ancestors 'self'`, plus
  `X-Frame-Options` on the proxied terminal responses). This was survivable while the only
  credential was a `SameSite=Strict` cookie the daemon sets itself — a third-party frame simply
  got the login page. Under SSO the admitting cookie belongs to the proxy in front and its
  attributes are not this code's to choose, so a live terminal could otherwise be framed and
  clicked on from another site.
- **The terminal pane's handshake checks its `Origin` before its identity, and whether a topic
  exists only after it.** Admission can now cost a key fetch, and making a cross-origin handshake
  wait for one before being told no was a slower refusal for no reason — while answering "no such
  topic" *before* admission would have been an existence oracle for topic ids that did not exist
  before. The set of handshakes that succeed is unchanged.

## [1.24.0] - 2026-09-21

### Added

- **A raw terminal in the web UI, for any coding-agent CLI at all.** Turned on, the chat header
  grows a `>_` button that swaps the transcript and composer for a real shell on the machine the
  daemon runs on — so a CLI with no ACP adapter, or one that only exists as a full-screen TUI, is
  now reachable from the same page as everything else. Each topic gets its own terminal.

  It could not have been built by tapping the agent, which is the thing worth recording here:
  neither runtime has raw terminal output to offer. Both spawn their child over plain pipes and
  read line-delimited JSON, a line that does not parse is *dropped*, and the ACP handshake
  declares `terminal: false`. So the pane is a second, parallel thing rather than a view onto the
  first — which is exactly why it works with any CLI, and also why nothing in it reaches the
  conversation: no transcript, no reverse CLI, no topic history.

  The daemon implements none of it. It proxies, behind the same session cookie, to a `ttyd` the
  operator runs on a unix socket, and embeds ttyd's page in a same-origin iframe. Writing it here
  instead would have meant a native PTY binding — node-pty publishes no Linux prebuilds at all,
  so every Linux install would suddenly need a compiler — plus xterm.js, a WebSocket server,
  scrollback, resize, reconnect and a mobile key bar. ttyd is 1.3 MB of static binary that already
  does all of that, with CJK and IME handling this page would otherwise have to re-earn. **The
  feature adds no dependency to this package.** Off by default: it moves the login token from
  guarding a conversation with an agent to guarding a shell, which is the same ceiling by a much
  shorter path. See the web UI section of the README for the ttyd invocation, and note that the
  wrapper wants `tmux new -A` around it — without something holding the session, ttyd forks a
  fresh process per connection and SIGHUPs it on disconnect, so switching apps on a phone would
  kill whatever was running.

  The gate this needed is not the one already there. A WebSocket upgrade never reaches the request
  handler, so the `OPEN`/`GUARDED` route tables, the session check and the origin check do not
  apply to it at all — a route added by editing those tables would be wide open while looking
  protected. The upgrade path therefore redoes all of it by hand, and is stricter in one place: a
  handshake is exempt from the same-origin policy and carries cookies whatever `SameSite` says, so
  there the `Origin` check is the only lock rather than the second one, and a request that names
  no origin is refused rather than waved through as it is elsewhere. The `?arg=` that selects the
  topic is a browser string that reaches an exec, so it is checked against the topic store before
  ttyd sees it and again by a pattern in the wrapper.

## [1.23.0] - 2026-09-21

### Changed

- **Enter sends again on a desktop; on a phone it still writes a newline.** 1.22.0 made Enter a
  newline at every screen width, and the half of that which was right is the phone: held upright
  there is no Shift key to hold down, so Enter-to-send does not make a multi-line prompt awkward,
  it makes one impossible to type. Neither half of that argument survives a keyboard, where
  Shift-Enter is right there and every other chat app on the screen sends on Enter — so what the
  one-behaviour-everywhere rule actually bought was the phone's problem paid for on a desktop
  that never had it. The layout already knows which of the two it is, so the composer now asks it:
  under the narrow-screen breakpoint Enter writes a newline, above it Enter sends and Shift-Enter
  writes the newline. It is read per keypress, so rotating a phone or dragging a window changes it
  with the layout. Ctrl/Cmd-Enter still sends on both.

### Fixed

- **Opening a topic from the local cache now says it is still waiting.** The transcript comes back
  out of the browser's cache instantly, which is the point of it — but the daemon's own sync is
  still a second or two away, and everything said in that topic while you were reading another one
  arrives in one frame with nothing in between having suggested more was coming. The existing
  placeholders could not answer this: they stand in for a transcript that is not there, and this
  one is. So a cached transcript is now followed by a line saying what is still outstanding, at
  the bottom where the missing messages are going to land, and it goes away when the sync arrives.
  It is deliberately a line about the room rather than another message-shaped placeholder: most
  syncs add nothing, and a placeholder would have promised one.

## [1.22.0] - 2026-09-20

### Added

- **The web UI can be installed as an app.** Chrome, Edge and Safari will now offer "install" or "add to home screen" rather than a bookmark, and what opens is a standalone window with no URL bar, its own launcher icon, and the status bar drawn in the app's own colour instead of framing it in white. The daemon serves a web app manifest and an icon — a `>_` prompt, which is what is on the other end — from three new routes alongside the page.

  Two decisions inside it are worth stating. There is **no service worker**, and one should not be added to make this work: Chrome dropped that requirement because the check was only ever a proxy for "has an offline story" and sites defeated it with empty fetch handlers, and a worker here would mean caching the app shell — which is served `no-store` precisely so that an upgrade cannot leave a stale copy behind. And the three routes are reachable **without signing in**, because a browser fetches them while deciding whether the site is installable, which is before anyone has signed in; a 401 there is indistinguishable from "not installable", with nothing in the UI to say so. They carry the configured title and a drawing, and the title is already in the `<title>` of the equally-open page.

  Every URL in the manifest is relative, so a daemon mounted under a sub-path by a reverse proxy still installs to the right place.

### Changed

- **Enter in the web UI's composer writes a newline; Ctrl/Cmd-Enter sends.** This is the inverse
  of the chat-app convention and is deliberate. The composer is most often reached from a phone,
  where there is no Shift key to hold down — Enter-to-send did not make a multi-line message
  awkward there, it made one impossible to type. What gets written into this box is prompts,
  which run to several lines more often than chat messages do, and losing a half-composed one to
  a stray Enter is the more expensive of the two mistakes. The shortcut is the same at every
  screen width rather than a narrow-screen special case: a send key that changes under you when
  the window is resized is worse than either choice on its own. The Send button's tooltip names
  the shortcut, since the keystroke is no longer the one people arrive expecting.

### Fixed

- **The web UI's drawer toggle is big enough to hit with a thumb.** On a narrow screen the `☰` in
  the chat header is the only way back to the topic list, and it was drawn at the desktop icon
  size — a 26×21 target, well under what every mobile interface guideline asks for. It is now a
  44px square with a larger glyph, and the header's vertical padding gives way to it, so the title
  bar goes from 42px to 49px rather than to 56.

## [1.21.0] - 2026-09-20

### Added

- **The web UI keeps its own copy of the conversation, so a restart no longer empties the page.** The daemon's transcript is memory and stays that way; what changed is that the browser now writes down what it has seen, in IndexedDB — one record per topic, a rotating 200 messages and 512KB each, 24 topics, evicted least-recently-written-first. Two things follow from it. A topic paints from the last visit before its stream has answered, which on a slow link is the difference between reading and waiting. And when the daemon comes back, the messages from before it went away stay on screen above a divider saying where they came from, instead of the room going blank under an apology.

  The part that makes this safe is not the storage, it is the key. Message ids are counted per process and start again at `w1`, so a restarted daemon hands out ids a cached transcript is already using — the first reply after a restart really is `w1` again. A sync therefore now carries an `epoch`, the daemon's generation, and the page keys every message by `<epoch>:<id>`. Cached messages from an older generation are *history*: they keep their place, no reconcile drops them, and their buttons are stripped, because the process that would answer them is gone and the id they name now means a different message. Cached messages from the CURRENT generation produce exactly the keys the sync produces, so the ordinary path reuses every node and writes no DOM at all — the cache is a head start, not a second source of truth. A browser with no IndexedDB (a private window, an old engine) loses the cache and nothing else.

- **A message typed in the web UI is on screen before the request leaves, and stays there if the request fails.** It used to be drawn only when the daemon echoed it back, so there was a visibly empty transcript for the length of the round trip — and on a POST that failed after its retries the text was simply gone: cleared out of the composer, never in the conversation, nowhere left to copy it from. The bubble is now local first: dimmed while the request is in flight, taken over by the echo when it arrives (the same DOM node, claimed by the send nonce, so nothing re-runs the fade-in or moves the scroll), and on failure edged red with **Retry / Copy / Discard** under it. Retry re-posts the original nonce, which the server already dedupes, so retrying something that actually landed cannot double it. A failed message survives a reload; its Retry does not, because the body it would re-send carries attachments as base64 and that does not belong in a transcript cache — the restored bubble offers Copy rather than pretending it can re-send files it no longer has.

### Fixed

- **The web UI's message cache no longer fills up with the same message.** Every streaming edit arrives as an upsert of one id, and the old per-topic cache appended each one instead of replacing it, so a single long answer could occupy most of the 40 slots a topic had.

## [1.20.0] - 2026-09-20

### Changed

- **The `codex` harness is no longer bundled, and now points at a different adapter.** Two changes that only make sense together. The adapter moved from Zed's `@zed-industries/codex-acp`, deprecated upstream, to `@agentclientprotocol/codex-acp`; and it stopped being a dependency of this package, so it is installed alongside the daemon the way `opencode` and `dsh` already are. The packaging half is the reason the migration is not free: the new adapter declares `@openai/codex` as an ordinary dependency, whose platform binary is ~284 MB unpacked, and nothing justifies putting that inside every `npm i -g agent-anywhere-cli` for a harness most installs never configure — particularly when the operator who *does* configure it has already installed and logged into the codex CLI by hand. Net effect for everyone not using codex: this package is 209 MB smaller. For everyone using it: one `npm i -g @agentclientprotocol/codex-acp`, which `doctor` now names when the command is missing.

  The old adapter was worth leaving behind on its own merits. Probed side by side against the same gateway: it advertised 6 commands to the new one's 42, reported no model list at all (so `/model` had only a stale selector two model generations old), had no equivalent of `/usage`, `/skills` or `/mcp`, and prefixed its first answer with `Model metadata for <model> not found. Defaulting to fallback metadata` — not on stderr, but inside the agent's message text, which is to say in the user's chat bubble.

### Added

- **`/usage`, `/compact`, `/mcp` and `/review` now work on codex, and `/context` and `/model` are answered for it.** The generic command table had nothing at all under `codex`, deliberately, because the adapter of the day could not be probed and a guessed native name is worse than an honest "unsupported". The new one can be, so the entries are a capture rather than a guess: `/usage` translates to codex's `status`, the rest keep their names, and `/context` and `/model` are answered by the gateway itself from `usage_update` and the session's `model` config option. Two holes remain and stay honest — `/doctor`, which codex has never had, and `/init`, which it *did* have until the new adapter dropped it.

  One asymmetry is worth knowing before you go looking for it: codex exposes reasoning effort as part of the model id (`gpt-5.6-terra[high]`), but only in a list the `/model` menu does not read, and feeding a suffixed id back is rejected outright. Effort is a `model_reasoning_effort` line in codex's own `config.toml`, and it has to sit above the first `[table]` header or TOML quietly makes it that table's key.

- **`/skills` lists codex's skills.** It read nothing for codex before, because the per-harness directory table had no entry for it and an absent entry degrades to an empty catalogue. The four directories now scanned were established by planting a uniquely-named marker skill under each candidate inside an isolated `HOME` and reading the adapter's own command list back — it publishes every skill as `$name` — rather than by assuming codex looks where claude looks. It does not: a marker under `~/.claude/skills` was ignored, while `.codex/skills` and `.agents/skills`, each at both the home and the project level, all came back.

  `.agents/skills` is the one that would have been missed by analogy and the one that carries the actual content. On the machine this was built for, `~/.codex/skills` holds only codex's six bundled skills — which this feature excludes on principle, since "the skills I installed" is what `/skills` answers — and all 25 real ones live in `~/.agents/skills`, the cross-vendor location the agy harness already scanned. A codex entry naming only the `.codex` paths would have reported an empty catalogue on a machine that visibly has skills, which is the confidently-wrong answer this feature was written to avoid rather than a smaller version of the right one.

### Fixed

- **The web UI shows your own message exactly as you typed it.** It used to run the operator's text through the same markdown renderer as the agent's, which is wrong for the one text on that page whose exact characters matter: what you send is a prompt, and the echo above the compose box is where you check what the agent actually received. Rendering hid the difference, and did it most visibly on numbered lists — "1. … 2. …" with a line in between that markdown does not read as a list item came back as "1. … 1. …", because the interruption ends the first list and the second one renumbers from the top. Your side is now escaped and shown verbatim, with its line breaks intact. Every other platform in the gateway already behaved this way; the web UI is the only one that renders its own inbound, so it was the only one that could disagree with the user about what they had sent.

- **A numbered list that resumes after an interruption keeps counting in the web UI.** The same renumbering, on the agent's side of the conversation, where it is not fixable by refusing to render: a numbered list broken by a paragraph, a code block or an indentation change is two `<ol>`s to any markdown parser, and the second one started at 1 regardless of what the agent wrote. It now carries `start`, so the numbers on screen are the numbers in the text.

## [1.19.0] - 2026-09-20

### Added

- **The web UI's sidebar can forget every topic at once.** A restart leaves the switcher full of rows that open onto nothing (see below), and deleting a dozen of those one `×` at a time is not a feature. *Clear all topics* sits in a footer under the list rather than beside the `+` in the header, because it is a misclick away from throwing every room away and a one-character icon next to "new topic" is not where that belongs. It confirms, then sweeps the list and lands in the fresh topic that replaced it, dropping the page's own per-topic caches and read marks with it — a cache left behind would repaint messages for ids the daemon has forgotten. What it deliberately does *not* do, exactly like the per-topic `×` it repeats, is end the agent sessions: their bindings in `conversations.json` outlive the rows. It clears a list.

### Fixed

- **A web UI topic from before the last restart opened onto nothing, and said nothing about it.** The topic list is a file and the transcript is memory, so a restart turns every older topic into a row that opens onto a blank panel — and a blank panel rendered faithfully is indistinguishable from a page that failed to load. That is how it was reported: the sidebar has history in it, clicking through shows nothing, and the event stream can be watched arriving with the transcript genuinely empty. Keeping transcripts across restarts is a different feature with different questions attached; what was wrong here was the silence. A sync for a room that holds no messages and whose last activity predates the running daemon now says so, and the page answers with a line explaining that transcripts are kept in memory only and that the agent still has its context — so the conversation reads as one that can be carried on rather than one that was lost.

## [1.18.1] - 2026-09-19

### Fixed

- **Entering a topic in the web UI went blank, then snapped the whole conversation into place.** Two things were wrong and they compounded. Nothing was shown while the first sync was in flight, so the panel was simply empty for however long the network took; and when the sync landed it emptied `#log` and rebuilt every message from scratch — which destroyed the scroll container along with its position, so even a topic already painted from the local cache flashed through blank on its way to looking identical. The transcript is now reconciled by id: a message that did not change is left alone (the paint writes nothing when the markup it builds matches what is already there), one that moved is moved rather than re-created, and only what the server no longer has is removed. In the gap before the first sync the panel holds message-shaped placeholders instead of nothing, so the real conversation replaces something of the same shape rather than appearing out of an empty box. New messages fade in over 180ms; both the fade and the placeholders' breathing are dropped under `prefers-reduced-motion`.

  A resync after a dropped connection no longer yanks the reader to the bottom either — which was invisible before only because the rebuild had already thrown their position away. Opening a topic still lands at the bottom, that being the one case where it is what you want.

## [1.18.0] - 2026-09-19

### Fixed

- **A question the agent asked with "select all that apply" could only be answered with one option.** The wire shape for a multi-select question was parsed correctly — `type: 'array'`, options under `items.anyOf` — and then collected with the ordinary one-tap question and sent back as a single-element array, so the model asked for several answers and was told one. The round is now a stateful bubble: every option carries its own checkbox, a tap toggles it and repaints the row, and a Done button sitting one index past the options resolves with everything ticked, in the order the agent listed them rather than the order they were tapped. Done with nothing ticked says so and leaves the question up — there is no answer to give, and doing nothing at all reads as the bot ignoring the tap. Because all of that rests on repainting buttons that are already posted, it happens only where the platform can replace them (Discord, Telegram, Slack, Lark, the web UI); on LINE and QQ the round stays one tap and the message says why, pointing at typing, which genuinely carries several answers since a typed reply travels under the question's own free-text field and the harness prefers it over the enum.

- **In the web UI, a button stayed greyed out for a second and a half after every click.** The page disables a button the moment it is pressed and re-enables it only when the message repaints, and message edits are deliberately held so a streaming reply is not re-broadcast on every flush. Those two are fine apart and wrong together: an edit carrying buttons is never streaming progress but always the acknowledgement of a tap — a menu page turn, a question being retired, a multi-select tick — so it is now sent at once. On a multi-select, where ticking and unticking land on the same button, holding it was not a delay but a broken control.

## [1.17.1] - 2026-09-19

### Fixed

- **A double quote in anything the web UI put inside an HTML attribute broke the element it was in.** The page's escaping helper set `textContent` and read `innerHTML` back, which escapes `<`, `>` and `&` — right for element content, and one character short for the inside of a double-quoted attribute, which is the other thing it was used for. A directory name containing a quote (legal on every filesystem this runs on) ended the new topic row's `title=` early and spilled the rest of the path into the tag; the same held for a slash command's description in the autocomplete. The helper now escapes the quote as well. Not a way in — everything it renders is the operator's own paths and their own command list, and agent output goes through `web-markdown.ts`, which never builds a tag from it at all.

## [1.17.0] - 2026-09-19

### Added

- **The web UI takes an image straight off the clipboard.** Ctrl-V (⌘-V) of a screenshot attaches it to the message being composed, which is the fastest way there is to show an agent what you are looking at — the alternative was saving the screenshot to a file first so the picker had something to point at. Every engine names a pasted screenshot `image.png`, so each paste is renamed `pasted-1.png`, `pasted-2.jpeg` as it is taken: two identical names would otherwise reach the agent as two attachments it cannot tell apart. The listener is on the document rather than on the textarea, because the composer is not focused after clicking a topic or a button and a paste that reaches nothing looks like a broken feature. A paste carrying no file is left alone, so pasting text into the composer still works the ordinary way.

- **Each topic in the web UI's sidebar says which directory it is working in.** A row carried only a title, so several topics open on different projects were told apart by remembering which was which. The row now has a second line with the project directory's name, and the full path on its tooltip — two checkouts of one project share a last segment. Deliberately not a copy kept beside the title: the daemon owns the answer and `/cd` moves it, so the adapter is handed a *lookup* (`PlatformAdapter.useWorkdirLookup`, optional and implemented only here — a chat platform has nowhere to put this) and asks per render, memoised for a few seconds because the list is rebuilt on every message. A directory changed with `/cd` is on the sidebar within seconds, and a topic that has never run still shows the root its agent would start in.

### Changed

- **Your own messages in the web UI now sit on a tinted panel instead of behind a hairline rule.** A 2px border and a 10px indent were all that separated the two sides of the conversation, and scanning back through a long transcript for where your own question ended and the answer began was harder than it should be. Own messages get a cool-tinted background; the agent's side stays flat on the page background. Only one side is marked deliberately — marking both would move the problem rather than solve it — and the quote rail and code blocks inside the panel are lifted a step so they do not disappear into the tint.

## [1.16.0] - 2026-09-19

### Changed

- **Agent questions (`ask`) wait up to 1 hour, post a 30-minute reminder notice, and reclaim the resident process upon timing out.**
  - The previous 10-minute timeout caused questions to close prematurely if the operator stepped away, while an indefinite wait would tie up hundreds of megabytes of resident agent memory indefinitely.
  - Clarifying questions now remain open for 1 hour by default (matching `session.idleTimeoutMs`). If unanswered after 30 minutes, an intermediate reminder notice is automatically posted to the channel.
  - When the 1-hour window expires without a response, buttons are retired, the question is marked timed out, and the resident agent child process is reclaimed cleanly. When the user eventually responds, the conversation is automatically rehydrated from stored session state (via ACP `session/load` or agy `--conversation`) and their answer is processed as normal.

- **Repository metadata and README links now point at this fork rather than at the repository it came from.**
  - `repository`, `homepage` and `bugs` in `package.json` still named the upstream repo, so `npm bugs` opened their tracker and the npm page linked to their code. The README badge rendered *their* CI status, and the `npx skills add` one-liner installed *their* skill rather than the one in this tree — the four references a reader is most likely to act on all pointed at a different project. All now point here.
  - Both READMEs credit the origin in their License section. `LICENSE` is unchanged and still carries the upstream copyright notice, which is what MIT asks for and what covers this tree too.

## [1.15.1] - 2026-09-19

### Fixed

- **The web UI showed an empty page while its event stream was working perfectly.**
  - Opening the UI at its own address — no `?t=` on the URL, which is how anyone reaches it the first time — rendered nothing at all: no messages, no topic list, no title. The stream was connected and the `sync` event was arriving; the browser was throwing it away.
  - The stale-sync guard added alongside the 1.15.0 message cache compared the event's topic against the client's own, but a first visit has no topic yet — the server is the one that picks it, precisely because the client named none. Comparing against the empty string discarded the only `sync` that visit was ever going to receive, and the page had no second chance to ask. The guard now only fires once the client is actually on a topic, so the server's choice is accepted and written into the URL for the reload after it.

### Changed

- **The web UI is usable on a phone held upright.**
  - It was laid out for a desktop and only conceded a narrow screen the sidebar's position. On a portrait handset the composer sat under the collapsing URL bar, tapping it zoomed the page in and left it there, the Send row hid behind the home indicator, and the topic drawer covered the chat with nothing but the one button it obscured to dismiss it.
  - Below 640px the sidebar is now a fixed drawer sized to the screen with a backdrop that closes it, viewport heights are stated in `dvh` so the composer stays where the browser chrome actually ends, the composer and token fields are 16px because Safari zooms in below that and never zooms back out, the Send row clears the home indicator via `env(safe-area-inset-bottom)`, and the input is no longer focused on open — the keyboard took half the screen before anything had been read.

## [1.15.0] - 2026-09-19

### Added

- **Topics in the web UI can be deleted directly from the sidebar.**
  - An inline delete button (`×`) appears on hover next to each topic in the sidebar. Clicking it prompts for confirmation, then removes the topic from persistent storage, cleans up the room's in-memory state, and broadcasts the updated topic list to all connected clients.
  - Deleting the currently active topic automatically navigates to the next available topic in the list, or mints a new one if none remain, ensuring the client is never stranded in an invalid room.
  - The HTTP server guards topic deletion with session authentication and CSRF origin verification, supporting both `POST /api/topics/delete` and `DELETE /api/topics`.

### Changed

- **Web UI scrollbars match the dark theme.**
  - Custom scrollbar styles (`scrollbar-color`, `scrollbar-width: thin`, and `::-webkit-scrollbar` with subtle dark thumb and transparent track) eliminate the jarring contrast between default bright system scrollbars and the pitch-black background across all browsers.
  - `color-scheme: dark` is declared on `:root` to ensure native system controls and browser-level overlays default to dark mode.

- **Topic switching is instant via client-side LRU message caching.**
  - Switching topics previously incurred a noticeable delay while the client tore down its event stream, initiated a new HTTP connection, and waited for the server's compressed `sync` event.
  - The browser now maintains a bounded LRU cache (capped at 10 recent topics and 40 messages each, synchronized to `sessionStorage`) of recent message history. When switching to a cached topic, its messages and status render in 0ms, followed by an immediate background stream reconnect that seamlessly reconciles any newer messages from the server.

## [1.14.0] - 2026-09-18

### Changed

- **The web UI switches to a collapsible left sidebar, distinguishes running from finished topics, and badges unread messages.**
  - Topic navigation moves from the top header bar to a dedicated left sidebar (`#sidebar`) displayed as a vertical list. The sidebar can be collapsed to maximize chat space using `◀` and re-opened via `☰` from the chat header, remembering the user's preference in `localStorage`.
  - Active turns are visually distinct from finished sessions: topics running an agent turn show a bright pulsing status indicator and highlighted title, while finished/idle topics show greyed-out titles and muted status dots.
  - Topic entries in the sidebar badge unread message counts in real-time. Background topics increment unread counts as messages arrive and clear as soon as the user selects the topic.


## [1.13.0] - 2026-09-18

### Added

- **The web UI has topics, and they work the way a Telegram forum topic does.** A row of names
  across the top switches between parallel conversations; each has its own agent session and its
  own context, and each names itself from what it turned out to be about. `+` opens one, the agent
  can open one for itself with `agent-anywhere create-thread`, and write into one with
  `--channel main/<topic id>`.

  A topic is a LANE on the one channel rather than a channel of its own, and the difference is the
  naming: `retitleLane` refuses any address with no lane, so `capabilities.renameThread` can only
  ever be true for a lane. A channel-per-topic design would have given the same conversation
  separation and left the automatic naming permanently inert.

  The `kind` stays `direct` even though a lane is set, which looks wrong and is not. `shouldRespond`
  answers a DM at step 3 and only reaches its mention requirement at step 6; a `kind: 'thread'`
  message that is not a DM, has no active session yet and carries no @ falls through to that step —
  and `chat.requireMention` defaults to true, so the FIRST message in every new topic would have
  been dropped without a word. A DM that has lanes is a shape the gateway already knows: a Telegram
  DM topic is exactly this.

  The topic list is persisted next to the daemon's own state, and that is not cosmetic: losing it
  would leave every one of those conversations still bound and still resumable in
  `conversations.json` under `<instance>#main#<topic id>`, and unreachable because nothing knew the
  ids any more.

  **Upgrading resets the web UI's existing conversation, once.** Its key was `<instance>#main#`
  with no lane; a topic makes it `<instance>#main#<id>`, so the old one is no longer looked up. It
  is one platform, one version old, and a migration shim for a shape published a day earlier costs
  more than starting the conversation again.

- **The web UI is usable on a weak, high-latency link.** Three changes, and together they took a
  thirty-second streamed answer from 13 updates and ~2.6 KB to 3 updates and ~600 bytes:

  Replies are announced when they settle rather than on every flush. Each streaming flush
  re-renders the whole message, so announcing all of them sent the same growing body over and over.
  The settle window is 1500ms *because* `EXPERIENCE.stream.flushIntervalMs` is 1200ms — anything
  below that expires between every pair of edits, announcing each one separately and saving
  nothing. Any non-edit event flushes what is held first, so a tool bubble's final state still
  arrives above the text that followed it.

  A dropped stream resumes. Every event now carries a sequence number as the SSE `id:` field and
  each topic keeps a backlog, so `EventSource`'s own reconnect is answered with the handful of
  events that were missed instead of the entire conversation — which is what every network blip
  used to cost.

  Everything on the wire is compressed, the event stream included. That one has a trap in it: a
  gzip stream buffers until told otherwise, so each event is followed by an explicit
  `Z_SYNC_FLUSH`; without it the page receives nothing until the connection closes, which reads
  exactly like a hung daemon. The test that pins it hangs rather than failing an assertion if the
  flush goes away.

  Sends carry a nonce, so the page can retry one that timed out without risking a double post. The
  daemon's own inbound dedup cannot cover this — it keys on a message id, and a retry mints a fresh
  one.

### Fixed

- **`agent-anywhere create-thread` tells you the thread it just made.** It never has, on any
  platform: the daemon returned the adapter's `{address}` verbatim while the CLI reads
  `data.threadId`, so the command printed an empty id and the help line under it read "send into
  this thread by passing `--channel`" with nothing after it. The daemon now answers in the shape
  the protocol declares, formatting the address the same way `--channel` parses it back — a bare
  channel where a thread is a channel of its own, `<channel>/<lane>` where it is a lane — so the
  help line is true wherever it is printed. Found while making that command do something real on
  the web UI, where it opens a topic.


## [1.12.0] - 2026-09-18

### Added

- **A built-in web UI, so the gateway is usable with no chat platform at all.** Every way into this
  daemon so far needed a bot registered somewhere first — an account, a token, a console, and in
  three cases a public callback URL. `type: webui` needs a port and a password. The daemon serves a
  plain dark chat page itself; you open it, type the token once, and get the same conversation every
  other platform gets: streaming in-place edits, tool bubbles, lifecycle reactions, the `/model`,
  `/cd` and `/setting` button menus, `ask` questions, and attachments in both directions.

  It is deliberately not a Satori adapter. `satori-core.ts` assembles a platform around a `Bot` —
  resolve one, call `bot.sendMessage`, normalise a `Session` — and here the daemon owns both ends of
  the conversation; forced through the profile seam, every method would be a stub around state the
  module holds anyway. So it implements `PlatformAdapter` directly and `platform-factory.ts`
  dispatches it before `PROFILES`, which is typed `Record<Exclude<PlatformType, 'webui'>, …>` so the
  next Satori platform still fails to compile until it is listed. The cost of leaving that seam is
  that everything `satori-core` did for free has to be done again — the `chat.channels` allowlist,
  the `[in]` log line, `measureRendered`, and typed outbound failures — and each is re-implemented
  with a comment naming it, because the failure mode of forgetting one is silence rather than an
  error. `src/platform/webui/README.md` lists all of them.

  The page is one conversation: no sidebar, no room list, no threads, `/new` to start over. Markdown
  is rendered server-side by a new converter alongside the other seven (`web-markdown.ts`), and that
  converter is the repo's only XSS boundary — what it renders is agent output, which carries the
  bytes of every file the agent read, so it escapes every character before building a tag and passes
  no raw HTML through, ever. Transport is server-sent events rather than a WebSocket: Node ships no
  WebSocket server, the browser ships `EventSource`, and the only thing given up is client→server
  streaming, which nothing wanted.

  Security, stated plainly because the defaults are deliberate. `host` is `0.0.0.0`, because a
  gateway for reaching your agent from elsewhere is not useful bound to loopback — which is safe
  only because `token` is mandatory. There is no TLS; put a reverse proxy in front before this
  crosses a network you do not control (and turn its response buffering off, or server-sent events
  arrive all at once at the end of the turn). The secret is compared with `timingSafeEqual` and
  rate-limited to five guesses a minute per source; sessions are `HttpOnly; SameSite=Strict` cookies
  held in memory. Files the agent sends are reachable only through an opaque token and always served
  `attachment` + `nosniff` as `application/octet-stream`, so an agent-sent `.html` can never render
  on this origin. Uploads become `data:` URLs — the shape `adapter-telegram` already produces, so
  they travel the attachment pipeline's existing branch and its SSRF guard has nothing to act on.
  `doctor` gained a check for the three ways this ends up configured but dead: a port already held,
  a non-loopback bind, and an `access.allowFrom` that does not list `<instance id>:owner` — the last
  of which otherwise presents as a page that accepts your messages and never answers one.

### Fixed

- **A conversation on a platform that cannot rename anything no longer pays for a title it will
  throw away.** `nameConversation` summarised a topic name with a model call and only then asked
  `retitleLane` whether the rename could happen — and `retitleLane` refuses both a platform without
  `capabilities.renameThread` and any address with no lane. So QQ, LINE, WeCom and DingTalk, which
  declare no rename at all, and every plain channel on the four platforms that do, spent one
  title-summarising call per new conversation on a string nothing ever read. The capability check now
  happens before the call rather than after it. `retitleLane` still re-checks both conditions itself,
  because `/title` owes the user a sentence naming which one fired, and the two answers send them
  looking in different places.


## [1.11.2] - 2026-09-17

### Fixed

- **Telegram images reach the agent.** Every inbound photo, document and voice note was dropped, and
  almost silently: the log carried one `TypeError: Invalid URL … input: '/photos/file_10.jpg'` and
  the agent simply received a message with no attachment. Two upstream packages disagree, each
  reasonable alone — `adapter-telegram` asks for a file by its API-relative path against an
  `endpoint` carrying the bot token, and `@satorijs/core`'s `http/file` listener runs `new URL()` on
  whatever it is handed. `plugin-http` emits that listener *before* it resolves the path, so satori
  sees `/photos/…`, throws, and the adapter turns the throw into an image element with no `src` at
  all. Not fixable by upgrading: those are the current releases of both (checked 2026-09-17).

  A listener prepended to the same event resolves relative paths first, so satori's own only ever
  sees the absolute URLs it was written for. It is pinned by a contract test that reproduces the
  upstream bug itself, so the day upstream guards that call, the test fails and this workaround can
  be deleted.

  Fixing that exposed the layer behind it. adapter-telegram does not return a link — it downloads the
  file with the bot token and inlines it as `data:<mime>;base64,…`, a shape the attachment pipeline
  had never actually been handed, because nothing had ever got that far. The downloader now returns
  such bytes directly (the SSRF guard has nothing to act on — no host, no DNS, no request — so only
  the size cap applies, and it is enforced), and the ingest names the file from its mime instead of
  the last `/`-separated chunk of the URL, which for one of these is a slice of base64. The failure
  lines quote a truncated form too: quoting a `data:` URL back would paste the entire image into the
  prompt as base64, through the error path, past every size limit meant to prevent exactly that.

## [1.11.1] - 2026-09-17

### Fixed

- **A rate-limited opencode no longer reads as a hung agent.** Reported 2026-09-17: every `oc` turn
  sat at "typing" for ten minutes and then failed with `agent "oc" sent no update for 600000ms;
  treating it as hung and aborting this turn`. The agent was not hung — opencode's free model pool
  was rate-limiting it and opencode was retrying internally, reporting that neither over ACP nor on
  its stderr (which the daemon already forwards; `grep -c "Rate limit" daemon.log` → 0). The only
  record on the machine was opencode's own log file, and the daemon's ACP session id appears in it
  verbatim, so one conversation's errors can be picked out of a log shared by all of them.

  A turn now asks that log. While it runs, each distinct reason is announced once as its own message
  (`⚠️ oc hit an error and is retrying: AI_APICallError: Rate limit exceeded…`), so a ten-minute wait
  explains itself in the first minute instead of at the end. If it does time out, the reason is
  appended to the failure message — read *before* the subprocess is reaped, since disposing it
  destroys the session id the lookup needs.

  Deliberately does not end the turn early: a logged error means something went wrong, not that the
  turn is lost, and opencode often retries and wins. Nothing is guessed either — a moved log, a
  renamed field or an unparsable line yields no reason and the message stays exactly what it was.
  Only opencode has a probe; claude rejects the prompt with its own reason already, and agy speaks
  no ACP. The seam (`daemon/harness-log.ts`) is per-harness so the next silent one is a table entry.

## [1.11.0] - 2026-09-17

### Added

- **agy gets its skills back, and they were never really the problem.** The harness was launched with
  `--disable-slash-commands` because a slash in a stream-json session can kill it — and that is true,
  but of eleven names, not of every `/`. Re-probed on agy 1.2.0: a skill slash expands and answers
  normally, an unrecognised one reaches the model as plain text, and only the commands agy's own CLI
  intercepts are fatal (`status:ERROR` and process exit 2, which takes the conversation's child and
  every turn queued behind it). Those eleven are exactly what `agy -p /help` lists, so the flag is
  gone and the names are kept out of the session by name instead. Typing `/some-skill do the thing`
  on agy now does what it does on claude.

  The same eleven are no longer refused either: each is answered by a one-shot `agy -p=/<name>` run
  in the conversation's directory, which is what agy's error message recommends. `/usage` therefore
  reports real quota — pools, percentages left, and when each resets — and `/credits`, `/effort`,
  `/config` and the rest answer in chat instead of "not supported". No model is invoked and no turn
  is spent: the CLI answers these from local state.

- **`/skills` finds agy's skills.** Five locations, which are agy's own rather than a guess:
  `<cwd>/.agents/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`
  and `~/.gemini/config/skills`. Asking agy instead was tried first and is not usable — `agy -p
  /skills` answers with six entries here and omits all 25 under `~/.agents/skills`, skills it
  nonetheless expands when they are typed.

- **The footer finally shows agy's context usage.** agy reports no token counts over its protocol,
  which is why `/context` on it answered "not supported" and the footer had nothing to print. It does
  publish them — to whatever `statusLine` command its settings name, in headless runs as well as the
  TUI (45 invocations across one measured two-turn session, the count climbing from zero to a real
  number). The daemon now installs a shim into that setting and reads the snapshot back at the end of
  each turn, so `used / size` reaches the same footer path the ACP harnesses use and `/context`
  answers like it does everywhere else.

  This writes to another product's config file, which nothing else here does, so: the previous
  settings are backed up once, every other key is preserved, the shim still draws a status line for
  the terminal (the same two lines this machine's operator had), and `AGENT_ANYWHERE_NO_AGY_STATUSLINE=1`
  turns the whole thing off. `doctor` reports whether the setting is wired, since that is the only
  explanation for an agy conversation with no numbers.

## [1.10.0] - 2026-09-14

### Fixed

- **Typing an answer no longer kills the question — or the ones after it.** When the agent asks with
  buttons and none of the options fit, the only usable answer is to type one. That message went to
  the inbound merger, whose job is to interrupt the running turn — and the running turn is the one
  blocked on the question. So on a form that asked three things, answering the second in words threw
  away the first two answers, never asked the third, and re-ran the reply as a fresh instruction
  stripped of the context that made it an answer. Reported from a real session; reproducible on every
  multi-question form.

  A message arriving while a question is on screen is now recorded as the answer to that question and
  consumed there, so the form carries on to the next one. The words travel back under the question's
  own free-text field — `question_<n>_custom`, which claude-agent-acp declares beside every question
  and prefers over the enum — rather than being passed off as an option the model listed; that
  distinction is why the parser now keeps a field it used to drop. Two messages deliberately keep
  their old meaning: one carrying an attachment (the field takes a string, so the image could only be
  dropped in silence), and one answering a question whose form declared no free-text field at all (an
  MCP server's own elicitation). Both interrupt, as before — which is also the way out of a question
  you cannot answer. `/stop`, `/new` and the daemon's other commands are still read as commands.

- **An answered question stops looking like an open one.** The bubble is now edited on every exit —
  tapped, typed, timed out, `/stop`, `/new`, or any interruption of the turn it belonged to — with
  the buttons cleared and the outcome written onto it. Two things were wrong before: the edit went
  through `editMessage`, which only drops components on Discord and Telegram, so on Slack and Lark
  the buttons of an already-answered question stayed clickable against a request that no longer
  existed; and a turn cancelled while blocked on a question left that question behind entirely,
  pinning the agent's child process for the rest of the ten-minute ask timeout.

## [1.9.1] - 2026-09-12

### Fixed

- **A turn reads in the order it happened again.** Tool bubbles are painted asynchronously so that a
  rate-limited chat cannot stall the reply behind a progress write — but the painter runs one write
  *behind* the turn's side-effect chain, so a tool's bubble could be posted below the body text of
  the segment that came after it. A transcript read "now let me check the profile" → "found it,
  three profiles declare it" → and only then the search that found them. Reproduced with no rate
  pressure at all: the normal case, not a congestion edge.

  The fix rests on a distinction that keeps it cheap: only a SEND takes a position in the chat, while
  an edit rewrites a message that already has one. So the body now waits for a bubble to be *placed*
  before sending its next message, and for nothing else — a late ✓ still lands late and unordered, as
  it always did. At most one wait per bubble, started when the tool is registered and therefore
  overlapping the tool's own run, and bounded at two seconds: past that the reply goes on and the
  bubble lands where it lands. Order is what gets given up under a paused chat, never the answer.

  The reason this survived a careful review of that file is worth recording: `tool-flood.test.ts`
  drives the whole stack but asserts on `[...sends, ...edits]` — a shape in which interleaving
  cannot be expressed. The new `render-order.test.ts` logs every write to one array in the order the
  platform saw it.

## [1.9.0] - 2026-09-12

### Changed

- **A menu page holds what the platform can carry, not what the tightest platform can.** Page size
  was one constant (6) shared by `/cd`, `/model` and `/setting`, and a shared constant has to be the
  smallest of the platforms' limits — LINE bundles at most 4 buttons per template, QQ 5 per row. So
  a ten-project workspace was two pages, and *choosing a directory* meant paging, every time, on the
  phone the command exists for. It is now a per-profile capability (`menuPageSize`): Discord,
  Telegram and Slack declare 12, which is one page for a typical workspace and still well inside
  Discord's 25-component message limit. A profile that declares nothing keeps the conservative 6,
  because the way a too-large page fails is the platform rejecting the whole message.

  The resolved size is frozen with the menu when it is posted. A click arrives later, and re-reading
  the size then would draw page boundaries the message on screen was never built with — `Next ▶`
  would skip or repeat entries.

  The `page 1/N` counter now appears only when there is more than one page, which the `/setting`
  menu has always done. On a menu that fits, it was a line of noise above the answer.

- **`/cd` leads with the projects you actually work in.** The list was alphabetical, which is the
  one ordering guaranteed to ignore what the user does: the two projects being worked on this week
  sat wherever the alphabet put them. Directories are now ranked by frecency — how often each has
  been chosen, with every past choice discounted by its age at a fortnight half-life. Neither
  simpler answer works: a visit counter never forgets, so last quarter's project outranks this
  morning's forever, and a plain "most recently used" lets one curious click displace the project
  someone has lived in all month.

  Kept in `<configDir>/workdir-usage.json`, two numbers per directory (exponential decay is
  memoryless, so a running total is a complete stand-in for an unbounded visit log). Separate from
  `conversations.json` because how often a directory is used is a fact about the machine, not about
  one topic — a brand-new conversation gets the benefit on its first menu. A use is counted only
  where a move actually happened, so re-picking the directory already in use (how the menu is
  dismissed) and tapping one that has since been deleted both score nothing. The agent's root keeps
  the first slot: it is the way out of a project rather than one of them. With no usage file the
  order is the scan's alphabetical one, exactly as before.

## [1.8.2] - 2026-09-11

### Fixed

- **`/skills` puts each skill on its own line.** It joined them with commas, which turns 26 names
  into a wall of text with nothing to scan down and no way to pick one out at a glance — unusable
  on the phone the command exists for. The justification given for it was compactness, and that was
  simply wrong: one-per-line only trades `, ` for `\n`, so the real list went from 709 characters to
  684. There was never anything to trade away.

## [1.8.1] - 2026-09-11

### Changed

- **`/skills` reads the skill directories instead of asking the agent.** 1.8.0 answered from
  `available_commands_update`, the list a harness pushes when it BUILDS a session. That list is
  authoritative and it is also missing exactly when someone wants it: the daemon holds it in
  memory, so every restart empties it and the first `/skills` after an update answers "has not
  reported any commands" until some conversation happens to run a turn. Observed within the hour
  on 1.8.0's own deploy, asked in a fresh Telegram topic — the update restarts the daemon, which
  is precisely when a user goes looking.

  Disk has neither problem: it is readable before any agent has started and it survives a restart.
  A skill is a directory containing `SKILL.md`, found under `~/.claude/skills` and the
  conversation's own `<cwd>/.claude/skills` for claude, and under whatever `skills` names in
  `opencode.json` for opencode. Entries are followed through symlinks, because 25 of the 26 here
  are links into a shared tree and an `lstat` check would find none of them.

  What it lists changed with the source, and for the better: the harness's own bundled commands
  are gone. 1.8.0 showed 58 entries for claude, of which only 26 were installed skills and the
  rest (`/compact`, `/deep-research`, …) ship with the product and are already reachable from the
  menu or the harness picker. "The skills I installed" is both what was asked for and the only
  thing disk can answer honestly.

  The cost, taken knowingly: this reads another tool's private layout, so a harness that moves its
  skills directory silently empties the catalogue. An empty answer therefore names the directories
  it searched, and a harness with no known location (agy, dsh) says that rather than implying the
  skills are missing.

## [1.8.0] - 2026-09-11

### Added

- **`/skills` lists the commands the current agent actually offers.** The platform menu is one
  fixed set derived from config, so a harness's own commands — skills above all — have never
  appeared in it, and the only way to see them was the bare agent command (`/cc`), which first
  wants a directory and only then shows a button menu. That left the 26 skills this machine shares
  between claude and opencode effectively undiscoverable from a phone.

  It answers with text, not buttons, and that is the design rather than a shortcut. claude reports
  65 commands here while Discord caps an interactive message at 25 buttons, so a picker is a paging
  UI, and paging through 66 entries to find a name is worse than reading a list. The deeper reason
  is that buttons cannot carry free text: a tapped one would have to park a pending selection on
  the conversation and wait for the next message to complete it, buying a state machine, an expiry
  policy, and a bug where an unrelated message arrives first and gets absorbed. None of it is
  needed — typing `/server-ops check the disk` already reaches the agent untouched, because a name
  outside the generic vocabulary passes straight through. Invocation was never the gap; discovery
  was.

  The list is everything the agent reported minus what the gateway menu already covers (58 of
  claude's 65 here, 1.2 kB — one message on every platform). It is deliberately not narrowed to
  "skills": ACP carries no marker for one, `available_commands_update` sends only
  `{name, description, input}`, and the skill directories cannot stand in for it either, since
  claude reads a tree of symlinks while opencode reads a different tree named in its own config and
  the two sets differ. A hand-kept blacklist of built-ins would rot on every harness release, so
  the catalogue says what it is instead of guessing.

  An agent that has reported nothing gets a reply naming both causes, because the daemon cannot
  tell them apart: no session has been built yet (the list arrives on session build, not at
  startup), or the harness reports none at all — agy speaks no ACP, and dsh sends no
  `available_commands_update`.

## [1.7.1] - 2026-09-11

### Fixed

- **A daemon restart no longer re-narrates the whole conversation into the chat.** Resuming a
  stored session replays its entire history as ordinary `session/update` notifications, and the
  gate that suppresses them (`promptedYet`) was a race: the flag is written by the sender just
  before `prompt()`, but read by the reader at dequeue time, and between the two there are only a
  handful of microtask ticks. The reader dropped whatever it reached in that window and rendered
  everything after it as if it were the new turn's own output.

  The window is proportional to the history, so this was never a rare race — it was one a
  conversation is guaranteed to lose once it gets long enough. Observed on 2026-09-11 after
  restarting into 1.7.0: exactly five replayed updates were suppressed and the remainder, hours of
  conversation, was re-sent to Telegram as one reply.

  The gate is now a fence the reader itself releases. By the time `session/load` returns, every
  replayed notification is already queued — the agent emits them before answering and one JSON-RPC
  stream is ordered — so the replay is a finite buffered prefix and "the reader has caught up" is
  decidable: race each read against a macrotask, which can only win when nothing is buffered.
  `runTurn` waits on that before setting the flag. The regression test replays three hundred
  messages, where the old gate leaks two hundred and ninety-six.

  Not caused by 1.7.0 — the race predates it, and the release only supplied a conversation long
  enough to expose it. The existing test replayed two messages, which always won.

### Changed

- **`ask` is advertised again on harnesses that cannot ask for themselves.** 1.7.0 dropped it from
  the injected hint on the grounds that the model's own question tool had replaced it, which is
  true only where that tool exists. `opencode` and `dsh` send no elicitations, so the change
  silently cost them their buttons: a model that wanted a decision could only ask in prose. The
  `inject` flag now distinguishes `'always'` from `'no-native-ask'`, so claude still gets a
  one-line hint and the others get `ask` back.

## [1.7.0] - 2026-09-11

### Added

- **The agent can ask you a question, and wait.** The daemon now advertises ACP's
  `elicitation.form` capability at `initialize` and renders the resulting
  `elicitation/create` requests as buttons in the chat.

  This was not a missing feature so much as one the gateway had been switching off. The
  claude adapter gates the model's own `AskUserQuestion` tool on that capability
  (`disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"]`), so every session
  this daemon ever opened ran with the model's question tool disabled — and the workaround, an
  `ask` reverse command plus the longest entry in the injected hint, existed to replace what one
  line of the handshake had removed. Now the model uses the tool it already knows and nothing is
  injected to teach it.

  Each option's rationale is rendered into the message body above the buttons, because that text
  ("you already run pgvector here, so reusing it costs nothing") is often the most useful part of
  the question and no platform's button label can hold a sentence. Multi-question forms are asked
  one round at a time, and abandoned on the first unanswered round rather than collecting answers
  the agent cannot use. A turn with a question outstanding is no longer treated as hung: the
  silence watchdog re-arms while waiting on a person, which it previously did not, and would have
  aborted the turn mid-decision.

  The capability value must be an object (`{ form: {} }`), not `true` — verified against the ACP
  schema and both harnesses. `form: true` is accepted by claude and by dsh, but opencode
  validates it strictly and rejects the whole `initialize` with `-32602`, which would have taken
  down every opencode session rather than just its elicitations.

  Probed live: `claude` sends real elicitations; **`opencode` 1.18.27 and `dsh` 0.1.2-rc.1 send
  none** (opencode sends no reverse requests at all, not even `session/request_permission`). On
  those two the model asks in prose and ends its turn, which the user answers in the next
  message — no code needed for the fallback.

### Changed

- **The per-turn hint is one line instead of thirteen.** It used to list all nine reverse
  commands with their full usage: roughly 350 tokens of chat-bot operating manual, in the *first
  text block* of every session's opening turn, ahead of whatever the user had actually asked. The
  cost was the framing more than the tokens — a model that opens by reading how to react with
  emoji and page through message history has been told what kind of job this is before it sees
  the job.

  Most of the list was also redundant. Plain text already streams into the chat, so `send-message`
  and `reply` are slower ways to do what happens by itself; `edit-message` duplicates the message
  the daemon already live-edits; `ask` is now the harness's own tool; and `react` / `delete` /
  `create-thread` / `fetch-messages` describe a chat client's chrome rather than the work. What
  remains is `send-file`, the one act the text channel cannot perform.

  The other eight commands are **not removed**. They are still registered, still in
  `agent-anywhere --help`, and still work when typed or scripted — a new `inject` flag on
  `ReverseCommandSpec` governs only what reaches the prompt, so `REVERSE_COMMANDS` stays the
  single source of truth.

- **A DM no longer prefixes every message with your name.** The `[<authorName>] ` prefix exists
  so an agent in a busy group can tell two speakers apart; in a one-to-one conversation it named
  the only human present, on every turn, and opened each turn with chat-transcript formatting
  instead of the question. It is now added in groups and threads only.

  Keyed on the conversation kind rather than on "does this batch contain two speakers": a batch is
  one merge window wide, so in a busy group two people usually land in different batches, and the
  per-batch test would have dropped the names in exactly the conversation that needs them.

## [1.6.0] - 2026-09-09

### Changed

- **A topic takes its name while the turn is still running.** 1.5.0 asked for the name after a
  turn ended successfully, which made it arrive one whole turn late — and a turn is not a moment:
  the ones worth opening a topic for run for minutes, and you spend all of them looking at a topic
  column that still says whatever the topic was created as.

  Nothing in the naming path needed the turn's outcome. The seed is the opening message and the
  lane is recorded before the agent is asked anything, so the call now starts there and the rename
  lands as soon as the model answers — a second or two in, beside the work rather than after it.
  Everything else is unchanged: once per conversation, same endpoint, same fallback, still never
  awaited by the turn.

  One behaviour goes with it. The old trigger required a *successful* turn, so that a topic could
  not be labelled with something that failed; a conversation whose first turn errors is now named
  anyway. That guard was on the wrong text — the name comes from the request, which is no less what
  the topic is about for the harness having failed to answer it, and a topic whose first turn broke
  is exactly the one you need to find again in the column. Slash-command turns are still skipped.

## [1.5.0] - 2026-09-09

### Changed

- **A topic is now named once, by a model, from its opening message.** 1.3.1 named a topic by
  following the harness's ACP `session_info_update` title, and 1.4.0 shipped a fallback for the
  three harnesses out of four that emit none — the first 39 characters of the opening message. Both
  produced names the user could not navigate by. The harness title is regenerated as a session
  moves on, so a topic drifted to whatever had been discussed most recently rather than what the
  topic is for; and the fallback is a substring, not a summary, so `帮我看下这个报错` and the first
  line of a pasted stack trace both became topic names.

  Naming now happens exactly once per conversation — after its first successful turn, from the whole
  opening message — and never again until `/title` or `/new`. The harness's title is no longer read
  at all: `AgentStreamHandlers.onTitle` and the `session_info_update` case in the ACP translator are
  gone, and the notification falls through to `default: break`.

  The summary comes from any OpenAI-compatible endpoint, configured under a new top-level `title`
  block:

  ```yaml
  title:
    llm:
      baseUrl: http://newapi:3000/v1
      apiKey: ${OPENAI_API_KEY}
      model: gemini-3-flash-lite
      timeoutMs: 45000            # optional
  ```

  One call per conversation, ~60 tokens, 1-4s on a flash-tier model, and nothing waits on it — the
  reply has already been delivered. Leave `title.llm` out and the name is the 1.4.0 substring, which
  is also what a failed call falls back to, so naming never depends on the endpoint being up.

- **`/title auto` now re-arms naming instead of releasing a pin.** With naming gated on "does this
  conversation have a name on record", releasing the pin would have changed nothing. It now forgets
  the recorded name, so the next reply names the topic afresh; the lane keeps its current name in
  the meantime, because a topic briefly called nothing is worse than one briefly called the wrong
  thing.

## [1.4.0] - 2026-09-09

### Fixed

- **Tool progress no longer disappears during a long run of tool calls.** IM platforms cap a
  message two ways — how long it may be, and how often it may be rewritten. The length half was
  fixed for the tool bubble in 1.1.1; the rewrite half never was. Under `accumulate` grouping the
  renderer edited one bubble on every tool start *and* every tool finish, with no throttle and no
  backoff, and `paint()` rethrew anything that was not a `MessageNotEditableError`. A run of
  back-to-back tool calls is therefore two writes per tool into one chat: Telegram answered
  `429 Too Many Requests`, the rethrow was swallowed by the render chain as one
  `[turn] render side effect failed:` line, and the update was gone for good — nothing re-triggers
  a paint until the next tool event, so the bubble froze on stale progress. One daemon run logged
  78 of them, with `retry after` climbing to 229 seconds.

  Painting is now asynchronous and retried. `onToolStart`/`onToolFinish` update the line set and
  return, off the turn's side-effect chain, so a rate-limited chat can no longer stall the reply
  behind a progress bubble. Any failure that is not a seal keeps every piece of state and arms a
  retry, and delivery is tracked by a revision watermark rather than a boolean — a ✓ recorded while
  a write is in flight was not delivered by that write, and the old flag claimed it was.

- **All outbound writes to one chat now share one budget.** The 429s were never any single
  writer's fault. `StreamBuffer` throttled itself to ~1 edit/1200 ms, `ToolRenderer` did not
  throttle at all, and the reactions, acks, menus and the agent's own `agent-anywhere send-message`
  calls were unmetered by construction — but the platform counts all of them as a single stream per
  chat, so no writer could see the quantity actually being limited. A new `core/outbound-pacer.ts`
  (token bucket per chat, one FIFO, in-place coalescing of queued edits) is applied once to every
  adapter in `Daemon`'s constructor, so all ~38 outbound call sites are metered without touching
  any of them. Keyed on `platform:channel` and never the thread, because a Telegram forum topic
  shares its parent chat's flood budget.

  Under congestion the lanes differ: the reply is never dropped however long it waits, a tool
  bubble may be superseded by a newer paint or dropped once stale, and a typing beat is dropped
  immediately. A finishing turn stops *waiting* for its bubbles after `outbound.finalizeWaitMs`
  without cancelling them, so a chat paused for 229 s can no longer hold the turn — and the user's
  ✅ — open for the same 229 s. `stop()` drains the queue before the adapters go down.

- **A stated `retry_after` is obeyed instead of guessed at.** `stream.maxBackoffMs` defaults to
  10 s, which is a blind guess about how long a rate limit lasts and was 22× short of the 229 s
  Telegram actually asked for. Profiles now translate their own failures through a
  `PlatformProfile.classifyError` seam applied to *every* outbound call, so Telegram's 429 becomes
  a typed `RateLimitedError` carrying the number and both writers wait exactly that long. The
  number is recovered by regex over the error message because `@satorijs/adapter-telegram` rethrows
  a fresh `Error` and discards `parameters.retry_after`; `telegram.contract.test.ts` fails loudly
  if that format ever changes. Lark's `230072` mapping moves behind the same seam and now covers
  sends and card patches, not just `editMessage`.

- **A backoff holds back the character threshold too.** `StreamBuffer` gated only its idle timer on
  the backoff, so a rate-limited stream that kept producing text still retried every
  `stream.charThreshold` characters — deepening the limit rather than letting it expire.

- **Running the test suite no longer breaks the reverse CLI of the daemon on the same machine.**
  `ensureReverseCliShim()` derives the shim from `process.argv[1]` — a good clue to "how was I
  launched", but only when the process really is the CLI. In a vitest worker `argv[1]` is
  tinypool's worker entry, and the shim is written to `~/.config/agent-anywhere/bin`, a path shared
  with whatever daemon is running on that machine. So `npm test` repointed the live daemon's shim
  at a test-runner entry, and because that directory leads every agent's `PATH`, every
  `send-message` / `ask` / `send-file` from every live conversation began failing instantly with a
  stack from inside tinypool. The shim is now written only when `argv[1]` is recognisably this CLI
  (a global-install symlink, `dist/cli.js`, or `src/cli.ts`); anything else leaves the file
  untouched and falls back to whatever `PATH` already offers.

## [1.3.1] - 2026-09-08

### Fixed

- **Topic names now start with the agent, and no longer leak the speaker's name.** Two problems
  reported against 1.3.0's rename. Names are shaped `[<agent>] <subject>` — `[cc]`, `[oc]`, `[dsh]`,
  `[agy]` — because a column of topics named only after their subject says nothing about who is
  answering in each, which is the first thing you need when several run at once. And a leading
  bracketed group is stripped before the tag goes on: `mergePrompt` prefixes every message with
  `[<authorName>] ` so an agent can tell speakers apart in a group batch, and the harness summarised
  that into the title, producing topics called `[no id] 合并到main并重试` after the user's own
  Telegram display name. Stripping repeatedly also makes the shaping idempotent, so re-titling
  replaces the tag rather than stacking another.

- **`/oc`, `/dsh` and `/agy` topics are named at all.** Only `claude` emits ACP
  `session_info_update`; opencode carries the variant in its schema and never sends one, dsh lacks
  it, and the agy protocol has no notion of a title — so three agents out of four kept their
  creation-time topic name no matter how long they ran. A conversation nothing has named now takes
  one from the user's own opening message after its first successful turn. Strictly subordinate: a
  real harness title always overrides it, and it never fires for a slash command or a failed turn.

## [1.3.0] - 2026-09-08

### Added

- **A conversation's topic takes the name the agent gave it.** A Telegram forum topic keeps whatever
  name it was created with for as long as it exists, so a topic-per-task workflow ends up as a
  column of names typed before any of the work happened. Meanwhile the harness has been generating
  an accurate title the whole time and reporting it over ACP as `session_info_update` — which the
  gateway dropped on the floor (`translateUpdate`'s `default: break`). The title now renames the
  topic, through a new `renameThread` capability on the platform layer implemented for Telegram via
  `editForumTopic`. Off with `platforms.<id>.autoRenameThread: false`.

  Two things were needed to make the signal arrive at all. First, claude-agent-acp sends the
  notification from its turn-end idle handler, which runs *after* the code that settles the prompt —
  so it lands in the SDK's update queue behind the `stop` that ended the read loop, and the next
  turn's `drainResidualUpdates` discarded it unread. The daemon log showed exactly this as
  "dropped 1 residual update(s)" after every single turn; the drain now salvages a title out of the
  residue before clearing it. Second, the title is generated in a background task, so it describes
  the turn *before* the one that reports it — one turn late by construction.

  Only the ACP harnesses report a title (`claude` observed; `opencode`'s schema carries the variant;
  `dsh` does not, and the agy protocol has no notion of one), so a conversation with no title is the
  normal case rather than a failure.

- **`/title`** — name the current topic by hand, `/title auto` to hand naming back to the agent, or
  bare to see what it was last called. A name set this way is *pinned*: the automatic rename stops
  following the harness for that conversation, because an explicit command that the next turn
  silently reverts is indistinguishable from a broken one. Note what cannot be guarded: Telegram
  offers no way to read a topic's current name back, so a rename done in the Telegram UI is
  invisible to the gateway and will be overwritten by the next new title.

### Fixed

- **`dsh` was registered as a harness but not reachable as a command.** `/dsh` was missing from the
  agent-command table, and `/model` / `/context` reported "not supported" for it despite its ACP
  bridge exposing both. (Committed before this release was cut; recorded here so the release notes
  are complete.)

- **`/model` works before a conversation's first turn.** Under ACP the model list arrives in the
  `session/new` response, so `modelSelector()` had nothing to report until a turn had run — and
  `/model` answered "No model selector on this session yet — send a message, then /model". That was
  wrong in the flow it broke most: the directory menu invites picking a project and then a model, and
  `/cd` makes it worse than a fresh conversation by disposing the session, so even an established
  conversation lost its list. `AgentSession` gained `ensureSession()`, and the gateway now starts the
  session to answer the question — the same child the next message would have started anyway, with no
  prompt sent and no context spent. Fixed in the shared layer, so it covers `cc`, `oc` and `dsh`
  alike (`agy` was unaffected: it reads its list from `agy models`, though a `/model` in the first
  moments after a daemon start could previously race the prefetch, which is fixed too).

  A failure to start now reports its real reason ("must be logged in…") instead of sending the user
  to do the one thing guaranteed to fail the same way.

  `/setting`'s model row is deliberately NOT warmed: doing it there would spawn a child to answer
  `/setting banana`, and warming at the click instead would mean making the daemon's synchronous
  menu path async.

- **A second child could be spawned for one ACP session.** `ensureStarted` assigns `active` only at
  the *end* of startup, so with two callers — a turn beginning and a `/model` warm-up — the second
  would see no session, spawn its own child and overwrite `proc`, leaving the first as an orphan that
  no `dispose` could reach while still holding the harness's session. Concurrent callers now share
  one in-flight startup.

- **`ask` no longer looks broken when someone takes more than two minutes to answer.** The default
  timeout was 120s, which is well inside the time it takes to read a notification, switch apps and
  think — and the failure was silent, since `ask` prints an empty line on timeout exactly as it does
  when nothing was chosen. An agent could not tell "nobody clicked" from "this command does not
  work", and would stop using `ask` at all. The default is now 10 minutes, a timeout writes an
  explicit note to stderr, and the hint injected into agent prompts documents both `--timeout` and
  what a blank answer means. The timeout constant also moved to `ipc/protocol.ts`: the daemon and the
  CLI each held their own copy of `120_000` (the CLI sizes its socket deadline from it), and tuning
  one without the other makes the CLI abandon a question the daemon is still waiting on.


## [1.2.1] - 2026-09-06

### Added

- **`dsh` (DeepSeek Harness) harness preset.** The gateway can now drive DeepSeek Harness over ACP
  (`harness: dsh`), the same way it drives opencode — `dsh --profile acp` is the dsh equivalent of
  `opencode acp`. dsh's ACP bridge encodes its model selector as a JSON string (`["provider","model"]`)
  rather than the "provider/model" spelling agent-anywhere uses everywhere else, so the daemon
  translates between the two at every model boundary: a configured `agents[].model` is JSON-encoded
  before `set_config_option` (a bare string is rejected as "unknown model option"), and the `/model`
  menu decodes dsh's values back to "provider/model" for display and for typing a switch. Note dsh
  ignores the ACP `_meta.model` hint entirely, so the model is enforced through the protocol's own
  setter, exactly as for opencode.

- **`/model` support for the `agy` (Google Antigravity CLI) harness.** The AGY harness previously
  answered `/model` with "not supported" because its stream-json protocol has no in-process model
  switch. It now supports runtime model inspection and switching using a kill-and-respawn strategy:
  the available model choices are discovered via `agy models` and cached at factory startup, and
  `/model` (both the paginated button menu and `/model <name>` substring matching) switches the model
  by terminating the resident child and respawning on the next turn with `--model=<new>` and
  `--conversation=<id>`. Conversation context is retained across the switch through agy's native
  conversation recovery.

## [1.2.0] - 2026-09-05

### Added

- **`/cd`: choose the directory a conversation works in.** `agents[].cwd` was the only answer to
  "where does this agent work", so a machine with a dozen projects on it was reachable one project
  at a time, by editing config.yaml and restarting every resident agent. The directory is now a
  property of the CONVERSATION, recorded in `conversations.json` next to the binding and read by
  both runtimes at spawn — so one topic can be about one project and the next about another.

  The candidate list is derived, not declared: the agent's own `cwd` plus the directories one level
  inside it (`daemon/workdir-scan.ts`), so a new project appears in the menu by existing on disk and
  nothing in config can drift out of date with what is there. `/cd` alone opens a paginated button
  menu on the page holding the current directory; `/cd <part of a name>` switches by substring on
  every platform. Both surfaces are built from `core/workdir-menu.ts`, the same split `/model`
  already used.

  The question is asked at the two moments it costs nothing: a bare agent command (`/cc`, `/oc`,
  `/agy`) in a conversation that has never run, and right after `/new`. A conversation already under
  way still gets the harness command list it always got — and "already under way" is read from the
  stored session id rather than from a live child, so an idle-reclaimed conversation resumes where it
  left off instead of being asked to re-pick.

  Moving starts a fresh session in the new directory, which the menu says before the tap: a session
  is pinned to the directory it was created in (ACP takes `cwd` at `session/new`, agy at spawn), so
  the move cannot reach a running process. Every agent's session id is dropped, not just the bound
  one's — the directory belongs to the conversation, so a later `/oc` must not resume opencode's
  thread from the old project. Re-picking the directory already in use (marked ●) costs nothing.

### Changed

- **`/new` keeps the conversation's binding and its working directory.** It always meant "clear the
  context", but for a conversation driven entirely by commands — one whose in-memory state had not
  been built yet — it also dropped the persisted binding. Both are re-recorded now; only the history
  is gone.

- **The footer's `cwd` field reports the directory actually serving the turn**, rather than
  `agents[].cwd`, which after a `/cd` is no longer the same thing.

## [1.1.2] - 2026-09-05

### Added

- **`contextWindow` per-agent override for the footer's context size.** claude-agent-acp carries a
  hardcoded model table and falls back to a 200k window for any id missing from it — so with
  `ANTHROPIC_MODEL=claude-opus-5` (absent from the table) the footer read `/ 200k`, while a session
  that happened to be on `claude-opus-4-8` (present) read `/ 1M`. The same agent showed two different
  windows depending only on which model the session landed on, even though the gateway serves 1M for
  both. The real limit is a local fact, so it is now stated in local config rather than probed: set
  `contextWindow: 1000000` on the agent and `usage_update`'s `size` is overridden before it reaches
  the footer. Unset = trust the harness's number (unchanged behavior).

### Fixed

- **`/model` no longer reports "No model selector" after an idle reclaim.** The choice list is read
  from the session's last-reported config options, but idle reclaim cleared them along with the child
  it stopped — so a conversation that had been talking for an hour, then went quiet past
  `session.idleTimeoutMs`, answered `/model` as if it had never started. `resetHandles` now keeps
  `liveConfigOptions` across a reclaim (only the live model name, which each new child re-reports, is
  cleared), and `setModel` on a stopped child records the choice as the conversation's preference
  instead of throwing `no live session yet` — the same `modelPreference` that already survives a
  crash and is re-applied when the next turn spawns a child. The next spawn refreshes the list either
  way.

## [1.1.1] - 2026-09-05

### Fixed

- **Tool bubbles no longer vanish on a long turn.** A bubble that accumulated past the platform's
  per-message limit is now sealed and continued in a new one, the same way the message body already
  was.

  `core/README.md` has always documented three reasons a message is sealed — budget spent, full,
  not editable — and said the tool bubble follows the same rule. It followed two of them. There was
  no length limit in `ToolRendererOptions` at all, so under `accumulate` grouping the bubble simply
  grew: every tool start and finish repainted it, and a turn with enough tools eventually wrote past
  what one message can hold. Telegram answers `MESSAGE_TOO_LONG` to the edit and `text is too long`
  to the send. Neither is a `MessageNotEditableError`, so `paint()`'s recovery did not catch them and
  rethrew instead — the render side-effect chain swallowed the rejection, and the whole block of tool
  progress disappeared, leaving one `[turn] render side effect failed:` line in the log. One
  operator's daemon log had accumulated 2083 of them.

  `maxMessageLength` and `measureLength` are now wired into the renderer alongside `maxEdits`, from
  the same platform capabilities the body stream already uses — so the length is measured on the
  RENDERED text, which matters wherever markdown rendering expands it (Telegram turns tables into
  bullets, roughly 1.4x). Two cases a seal alone cannot fix are handled explicitly: when the lines
  carried over still overflow, the oldest go first, because those are the ones already readable in
  the sealed bubble above; and a single line longer than the entire limit — a `verbose`-mode JSON
  dump — is clamped, on the grounds that delivering part of it beats having the platform reject all
  of it.

## [1.1.0] - 2026-09-05

### Changed

- **Replies are no longer streamed by default.** A reply now arrives as a whole message once each
  part of it is finished, split across several messages when it exceeds the platform's per-message
  limit. Live streaming is still available as `stream.enabled: true`.

  Streaming was costing more than it returned. Every flush spends a message edit, platforms cap
  those per message — Feishu allows 20, then refuses *that message* permanently — and so the reply
  most likely to run out of edits partway through delivery was the long, considered one that
  mattered most. 1.0.0 made that survivable by sealing the exhausted message and continuing in a new
  one, but the honest fix is not to spend the edits at all: sent-once text has no such ceiling, and
  the only limit left is message length, which splits cleanly.

  The turn does not go quiet in exchange. `TurnRunner` already completes the body buffer at every
  tool boundary, so each finished text segment is sent as it happens — a turn that uses tools still
  reports as it goes, alongside the session header bubble, the 👀 reaction, and the tool bubbles,
  which do still refresh in place.

  The switch is `stream.enabled` (default `false`), also reachable as `/setting stream on|off` and
  in effect on the next reply. It is ignored on platforms that cannot edit messages (QQ, LINE,
  WeCom, DingTalk), which have always delivered whole segments. The knobs that *pace* a stream
  (`charThreshold`, `flushIntervalMs`, the backoff cap) stay frozen in `EXPERIENCE` — only the
  decision crossed onto the user surface, which is why `Config.stream` is now a deep merge of the
  two halves the way `session` already was. A plain spread would have dropped the operator's value
  and reverted it on the next restart; `display.test.ts` pins that, since it is the third feature
  to walk into that trap.

### Added

- **`/setting stream on|off`.** `stream` used to be refused by name with a reason that was not even
  true of it ("not in config.yaml at all — frozen in the code"), which was correct for the
  throttling knobs and wrong for the one field an operator actually decides. It is a fifth editable
  setting now, `live` like the default agent: `TurnRunner` resolves the delivery mode per turn, so
  the next reply uses the new value with no restart and a turn already in flight finishes as it
  started.

### Fixed

- **`agent-anywhere --version` reports the version that is actually installed.** It was a string
  literal and had been wrong for four minor releases — a 0.11.0 install answered `0.2.0`. That is
  worse than having no flag, because it is the first thing you check when a deployment misbehaves:
  it sent an investigation of a live daemon looking for a stale install that did not exist. The
  uniagent image had already worked around it by asserting on the installed `package.json` instead,
  with a comment noting that `--version` "will always pass". Now read at runtime, correct both as
  `dist/cli.js` and under `tsx src/cli.ts`.

## [1.0.0] - 2026-09-05

### Fixed

- **A long reply is no longer truncated where the platform stops accepting edits.** Feishu/Lark
  caps in-place edits at 20 per message and then answers `230072` forever, and streaming a reply
  spends one edit per flush — so any answer past roughly twenty flushes hit the cap mid-delivery.
  What followed was worse than the cap itself: the buffer treated the rejection as a rate limit,
  backed off, "degraded", and on the final flush — the one carrying the complete answer plus footer
  — re-edited that same dead message, swallowed the error, and reported the turn complete. The user
  was left with a reply cut off mid-sentence, a ✅ on it, and no indication anything was missing.
  Observed twice in one evening on a 4.7k-character answer, of which 1.5k arrived.

  The delivery layer now models **one logical reply as an ordered run of messages**, only the last
  of which is still edited. A message is *sealed* — immutable, never touched again — when it fills
  `maxMessageLength`, when its edit budget is spent, or when the platform refuses an edit; in all
  three cases the sealed text counts as delivered and streaming continues into a fresh message.
  Because the length limit and the edit budget are now the same concept ("this message can take no
  more"), `sealedText + open.text` is always exactly what the user can see: nothing is re-sent and
  nothing is lost. Overflow chunks also stream as they arrive instead of waiting for turn end.

  Two things had to exist for that to work. Platforms declare their cap as a capability
  (`maxEditsPerMessage`; Lark: 20), so a message is sealed *before* the platform starts refusing
  rather than after a wasted round trip. And a rejection that means "this message is finished" is
  now a distinct type (`MessageNotEditableError`, translated from Lark's `230072` in the profile)
  instead of being indistinguishable from a rate limit — a distinction only the platform can draw,
  and the one the old code was missing. Genuinely transient failures still back off and keep the
  message open; the final flush, having no later flush to recover, seals and sends the remainder
  rather than leaving the answer truncated.

- **Tool bubbles no longer freeze mid-run on the same cap.** `accumulate` grouping spends an edit
  per progress update, so a ten-tool turn is exactly Lark's twenty. Past that the bubble stopped
  updating with no error in channel — a turn doing real work looked hung. Bubbles now seal on the
  same rule, carrying the lines the frozen bubble doesn't already show (still running, or finished
  since the last write) into a new bubble; lines already fully rendered are dropped rather than
  repeated, so bubbles don't grow by the whole history.

- **Outbound failures log their actual reason.** Satori's `MessageEncoder` throws an
  `AggregateError` whose own `.message` is empty, with the real HTTP error inside `.errors`, so the
  tool-bubble path printed `[turn] render side effect failed:` and nothing after the colon. The
  unwrapping that the stream sink already did is now shared (`describeOutboundError`) and used
  everywhere outbound errors are logged. A sealed message logs as ordinary bookkeeping rather than
  as an error, since the writer continues in a new message.

- **The config-path tests pass on a Windows checkout.** They asserted literal POSIX strings against
  values built with `path.join`/`path.resolve`, so they only ever tested that the suite was running
  on POSIX — and since `npm run release` gates on `npm test`, two green-elsewhere failures blocked
  cutting a release from Windows entirely. The precedence rules they exist to pin are unchanged.

### Removed

- **`stream.maxFailuresBeforeFallback`** and the "degrade to whole-message send" path it drove.
  Sealing replaces it, and it cannot express what the failure actually was. Configs carrying the
  key are unaffected (unknown keys are ignored).
- **`stream.mode`** (`auto` | `edit` | `chunk`) — read by nothing. How a reply is delivered follows
  from what the platform can do (`editMessage`, `maxMessageLength`, `maxEditsPerMessage`), not from
  a preference, and a knob that silently does nothing is worse than no knob.
- **The streaming cursor** (`StreamBufferOptions.cursor`) and `StreamSink.delete`. The cursor had
  already been hardcoded off; both existed only to service the degraded path's "delete the frozen
  preview, or edit the cursor off it" cleanup, which no longer exists — a sealed message is
  complete text, not a frozen preview needing repair.

## [0.11.0] - 2026-09-04

### Added

- **`/setting` changes config.yaml from chat.** A handful of fields in that file are not
  deployment plumbing at all but a decision someone makes on a Tuesday — which agent answers by
  default, what model an agent should start with, how long an idle conversation keeps its process —
  and they were paying the heaviest edit cost in the product: reach the machine, edit YAML, restart
  the daemon, and lose every resident agent child in the process. Those are exactly the fields that
  stayed on the user surface instead of being frozen into `EXPERIENCE`, so the cost was falling on
  the values most likely to be adjusted.

  Four are editable (`routing.default`, `agents[].model` per agent, `session.idleTimeoutMs`,
  `session.scope`), as a two-level button menu where a message's buttons can be replaced, and as
  `/setting <key> <value>` on every platform. Every answer states **when** the change lands,
  because they differ: three take effect immediately, a model applies to the agent's next session,
  and the scope is written but deliberately NOT applied — changing what counts as one conversation
  while conversations are open would silently re-identify all of them, so the file is updated and
  the restart is named.

  What it will not touch is refused *by name*, with the reason, rather than answered "no such
  setting": `access.allowFrom` (one wrong value locks you out of the surface you would use to fix
  it), credentials (a chat log is the wrong place for them), `routing.pipeline` (a rule is a
  structure, not a value a picker can offer), and the frozen `EXPERIENCE` knobs (not in the file at
  all). A real config key deserves better than being told it does not exist.

  Writes go through the YAML document, so comments, key order, hand-edited siblings and `${VAR}`
  templates survive byte-identical, and a change is validated against the whole config *before* the
  file is touched. That check is the point rather than a precaution: this is the only command that
  writes the file the daemon needs in order to start, so a value that parses but fails the schema's
  cross-checks would otherwise leave a deployment that runs until someone restarts it.

## [0.10.0] - 2026-09-04

### Changed

- **A channel entry now covers that channel's topics** — in `chat.channels`,
  `freeResponseChannels` and `ignoredChannels` alike. All three matched the textual address
  exactly, and a whole-chat entry deliberately excluded the chat's lanes on the grounds that each
  topic is its own conversation. That reasoning is right about identity and wrong about these
  lists, which a Feishu **topic-mode group** (话题模式群) makes unmissable: there a topic id is
  minted per root message, so the chat id — the only thing an operator can write down — matched
  nothing at all. `channels: [oc_xxx]` silenced the bot in the very chat it had just been pointed
  at, `freeResponseChannels` could not exempt it from the @mention rule, and `ignoredChannels`
  could not block it; all three failed by doing nothing, which is the hardest failure to read.
  It also disagreed with routing, where `when.channelId` has always covered a channel's topics.

  `<chat>/<thread>` still names exactly one lane, and nothing else changed. What is no longer
  expressible is "the chat root but not its topics" — nobody asked for it, and the previous
  spelling of it was a trap.

### Fixed

- **A Feishu rich-text message is no longer ignored outright.** adapter-lark's decode handles
  `text/image/audio/media/file` and lets everything else fall off the end of the switch, so a
  `msg_type: 'post'` — what a Feishu client sends whenever the message mixes formatting or embeds
  an image — reached the gateway with empty content and was dropped by the inbound gate as
  `empty`. From the chat it looked like the bot ignoring a message that had just @-mentioned it,
  and there was nothing in the log to contradict that reading.

  The profile now rebuilds the content in the same `internal/session` hook that already learns
  topic reply anchors, and two parts of that are load-bearing rather than tidy. A post's `at`
  carries a placeholder (`@_user_1`) with the real `open_id` in the message's `mentions` array, so
  passing it through verbatim would have left mention detection permanently blind in rich text —
  the message would still be dropped in any group that requires a mention. And embedded images
  are addressed exactly like a standalone image message, so they download through the same route
  as everything else, names included. `sticker`, `share_chat` and `merge_forward` are still
  empty, now on purpose and with the reason recorded: Feishu's resource API excludes 表情包, and a
  forwarded bundle needs another API call to read.

- **A Feishu image or file now reaches the agent instead of a "failed to download" line.**
  adapter-lark decodes inbound media into `internal:lark/<selfId>/im/v1/messages/…/resources/…`,
  satori's internal-URL form, which nothing but the bot can resolve — while the daemon's
  downloader speaks http(s) only, deliberately, because it re-validates every hop of a
  user-controlled URL against SSRF. So every attachment anyone sent the bot on Feishu was
  swallowed by that guard and reported as a network flake. Lark is the only one of the eight
  adapters that does this (the other seven emit public https links), and now the only one with a
  `fetchAttachment` override: a profile gets first refusal on each URL and fetches its own
  through the authenticated client, returning `undefined` for anything it does not own.

  The SSRF model is unchanged — those requests go to the endpoint the operator configured, with
  the bot's own token, and the only user-controlled part is a path segment, validated against
  Feishu's id alphabet so a crafted event cannot address a different endpoint. The size cap still
  applies, enforced after the fetch because that route reports no `content-length` to pre-check.

  Two things had to be recovered along the way, because a Feishu attachment declares neither a
  name nor a mime type anywhere the adapter surfaces. The filename comes from the raw event body
  (a `file` message states it; the profile caches it by `file_key` in the same `internal/session`
  hook that already learns topic reply anchors), and for an image — which has no name at all —
  the extension and mime are sniffed from the leading bytes, since the adapter's binary route
  discards the response headers. Without an extension the agent receives a blob it cannot open,
  and guessing `.jpg` for a png is worse than looking. A text file sent on Feishu is now inlined
  into the prompt like anywhere else, because the readable-text decision is re-taken once the
  name is known.

## [0.9.0] - 2026-09-04

### Added

- **The footer now names the model on `agy` conversations.** agy reports the model it is serving
  exactly once, in its `init` frame, and that field was being read for the conversation id and
  thrown away — so the footer fell back to `agents[].model`, i.e. whatever the operator had typed
  in config, and printed nothing at all when they had typed nothing. The value is now stored on the
  session and replayed at the top of every turn (the footer reads a per-turn record, so one emit at
  spawn would have named the model on the first turn and on no other). What the footer prints is
  now agy's own resolved id, including the default nobody configured.

  Still unsupported, and deliberately: `/model` on an agy conversation answers "not supported"
  rather than opening the menu. agy exposes no model selector and no way to switch in-process — the
  model is fixed by `--model=` at spawn — so a menu there could only offer a switch it cannot make.

### Fixed

- **`/context` no longer promises numbers that are never coming.** A harness reports context only as
  ACP `usage_update`, and opencode sends one only for a model whose context window it knows. A model
  declared in a custom `provider` block with no `limit.context` therefore reports nothing at all —
  not a zero window, no notification — so the footer's context segment stayed absent and `/context`
  answered "No context numbers yet — they arrive with the first reply. Send a message, then
  /context." forever, sending the user in a circle. That sentence is still right before the first
  turn; after one has finished, `/context` now says the numbers were not reported and, on opencode,
  names the fix (a `limit` block on that model in `opencode.json`). Verified on opencode 1.18.27 in
  the same session: `opencode/big-pickle` reports `{used, size: 200000}`, a custom-provider model
  reports nothing, and adding `limit.context` to it makes the numbers appear.

- **`/new` and an agent rebind now clear the context snapshot they invalidate.** `/context` reads
  the last `usage_update` and labels it with the currently bound agent, but the snapshot outlived
  both resets — so after `/new` it reported the size of the context that reset had just destroyed,
  and after `/oc` it showed claude's numbers under opencode's name. Both now forget it, which puts
  the pair back in the honest empty state until the new context reports its own.

## [0.8.0] - 2026-09-04

### Added

- **`/stop` ends the current turn without ending the conversation.** Until now the only way to stop
  a running agent from chat was `/new`, which also destroys the context — so "stop, that's the wrong
  file" cost you the whole conversation you were in the middle of. The only other interrupt,
  `inbound.interruptOnNewMessage`, fires as a side effect of sending another message rather than
  because anyone asked. Everything underneath was already there (`AgentSession.abort()`, the
  per-turn `AbortController`, TurnRunner's interrupted branch that keeps the partial reply and drops
  the footer); what was missing was a way to ask for it. `/stop` is intercepted before the merger,
  like `/new`, so it works mid-turn, and it answers with what it actually stopped — a turn, a
  message still inside the merge window, or nothing — because one ack for all three outcomes is how
  a stop command earns a reputation for not stopping anything. The queued backlog is dropped rather
  than promoted to the next turn: those messages were written for the turn being stopped.

- **Idle conversations release their agent process (`session.idleTimeoutMs`, default 1 h).**
  `scope: per_thread` means every topic anyone has ever messaged holds its own resident harness
  child, and a Claude Code process is hundreds of MB; nothing ever reclaimed them, so the only
  ways down were `/new` and restarting the daemon. The hooks for this had been sitting unused since
  the beginning — `InboundMerger.onIdle` documented as "drives idle reclaim" and never wired,
  `PendingAsk.conversationId` documented as an "eviction-guard anchor" with no eviction to guard
  against.

  What made it safe to finish is that reclaim is no longer a new risk: since `conversations.json`
  started recording each agent's own session id per conversation, killing a child and resuming it is
  exactly what a **daemon restart** already does to every conversation at once. This does it to one
  idle conversation on purpose. The conversation, its binding, its token, its stored session ids and
  even the session handle (and with it a runtime `/model` choice) all survive; the next message
  respawns the child and resumes through the harness's own reload — verified available on all three
  harnesses in use (claude and opencode advertise ACP `loadSession`, agy replays `--conversation`).

  It fires only when the conversation is quiet past the deadline AND the merger is idle AND the
  daemon holds no pending `ask` for it AND the session says it can resume. The second condition is
  the one that matters most: the clock starts when the last turn ENDED, so a task that runs for
  hours — subagents included — is never a candidate while it runs. A reverse command counts as
  activity too, so an agent that finished its turn and left a background job reporting through
  `agent-anywhere send` keeps its child. A harness that cannot reload a stored session is left
  resident and said so once, rather than having its context quietly restarted.

## [0.7.0] - 2026-09-04

### Changed

- **`/model` now opens the menu on `claude` too, instead of forwarding to claude's own.** It looked
  like the "a native spelling always wins" rule protecting claude's answer, and it was not: probed
  live against claude-agent-acp 0.58.1, the adapter does not advertise `model` among its commands
  at all, so a forwarded `/model` was a plain prompt — it spent a turn and printed
  `Current model: Opus 4.8 (1M context) … Usage: /model <name>`, text you then had to type against.
  The same session exposes the selector as a config option that `session/set_config_option`
  switches, which is exactly what the gateway already does for opencode. So `/cc` conversations get
  the same tap-to-switch menu, and no turn is spent. The trade: only the options the protocol lists
  can be picked, while claude's prose names a few more aliases (`opusplan`, `best`, a full model
  id) — those stay reachable through `agents[].env.ANTHROPIC_MODEL`.

- **The footer names the model that is running, with its version.** It read `opus[1m]` — the alias
  from `ANTHROPIC_MODEL`, which says which family answers but not which release, so it looked
  identical before and after Opus 4.8 shipped. Neither the option id nor its display name ("Opus")
  carries a version; the description does, verbatim: `Opus 4.8 with 1M context · …`. The footer now
  reads `opus-4-8`. `[1m]` drops out with it and nothing is lost — the context segment beside it
  already reads `/ 1M`, so the qualifier was saying twice what one number says. A `default` pin
  resolves the same way, to whatever it currently points at rather than to the word "default".
  Harnesses whose descriptions state no version (opencode writes none) keep the previous label.

## [0.6.0] - 2026-09-04

### Added

- **`/model` is now a menu you can page through.** It could already show the live model and
  switch by substring, but not *list* — the list is what a phone user actually wants, and
  93 models was past both the 25-button cap and what reads as a message. A bare `/model`
  now posts the models the agent offers as buttons, opening on the page holding the current
  one (naming what you are on is half the question), with ◀ ▶ turning the page on the same
  message and a tap switching the model. `/model <part of a name>` is untouched and still
  works everywhere, including the platforms that get no menu.

  A menu is a snapshot and a click is a later event, so everything the menu assumed is
  re-checked before anything switches: the conversation still exists, the same agent still
  answers it, there is a live selector, and — the load-bearing one — the harness still
  offers that model. The harness can rebuild its list mid-session, and a button index
  resolved against a stale list would otherwise switch to a model nobody saw. Each of those
  gets its own sentence on the menu itself; none of them is a silent no-op, because on a
  button that is indistinguishable from a dead one.

  Reaching Discord, Telegram, Slack and Lark, where a sent message's buttons can be
  replaced. QQ and LINE have no message-edit endpoint at all, so a menu there could never
  be paged *or* retired — its buttons would outlive their own ack — and they keep the text
  answer, which was always the complete answer rather than a degraded one.

### Fixed

- **A mid-session model switch no longer leaves `/model` describing the old one.** The
  harness reports `config_option_update` when its model changes, and the daemon forwarded
  the new name to the footer but dropped the option list that came with it — so the
  session's own selector kept reporting whatever `session/new` had said. The footer was
  right and everything reading the selector was one switch behind.

## [0.5.1] - 2026-09-03

### Fixed

- **An agent command for a harness you never configured no longer dies silently.** `/agy hi`
  in a deployment with no `harness: agy` agent resolved to nobody, so the prefix survived and
  the message reached the *bound* agent still spelled `/agy hi` — which ran it as one of its
  own slash commands, found nothing, and answered "ran a command, but there was no output to
  display". The gateway now names the gap ("No agy agent is configured here…") and runs no
  turn. A `when.command` rule and a configured harness both still outrank the check, so an
  operator's own alias is untouched. Startup also logs the agent commands config produces and
  the agent each selects, which is where the cause is visible.

### Changed

- **One phrasing for every agent command in the platform menu.** `/agy` read "Switch this
  conversation to agy" while `/cc` and `/oc` read "Switch to claude — alone, lists its own
  commands", so a single menu described the same action two ways. All of them now open with
  `Switch to <harness>`, and only a harness that has a command list to show keeps the clause
  about the bare form.

## [0.5.0] - 2026-09-03

### Added

- **`/model` and `/context` now work on opencode**, answered by the gateway itself. Both
  were in the generic vocabulary only to be *refused* there, because the translation layer's
  single mechanism is text: it rewrites `/x` and hands it to the agent as a prompt, so a
  capability the harness exposes over the protocol instead of as a slash command reads as
  "not supported". Probed live against opencode 1.18.18, both are there — a
  `usage_update {used, size}` on every turn, and a `model` select carrying its full 93-model
  list that `session/set_config_option` switches.

  `/context` prints the last snapshot the agent reported, in the same format the footer uses.
  `/model` shows the live model, and `/model <substring>` switches it for that conversation —
  93 models is far past a button menu's 25 and past what is readable as a list, but
  `/model sonnet-5` is one thumb-typed token. An ambiguous query lists the candidates instead
  of guessing. The choice survives the agent child being rebuilt — a crash or an idle eviction
  re-applies it over `agents[].model` on the next `session/new` — and is cleared by `/new` or a
  rebind to another agent, like the rest of that agent's per-conversation state.

  A native spelling still wins: `/model` on claude reaches claude's own model UI. And the
  fallback is a harness LIST rather than a flag, populated only from what was probed — `agy`
  speaks no ACP, so it keeps the honest "not supported" instead of a "no numbers yet" that
  would never resolve.

- **A Feishu topic (话题) is its own conversation.** Lark was the one platform with a real
  thread model that agent-anywhere flattened: the profile reported no lane, so every topic in
  a chat collapsed onto the chat root — one session, one agent binding, and every reply posted
  outside the topic that asked for it. Topics now behave exactly like Telegram topics and Slack
  threads: their own conversation key under `scope: per_thread`, their own `/oc` binding, the
  participated-thread mention exemption, and an address (`<chat>/<thread>`) that
  `chat.channels`, `freeResponseChannels` and `--channel` all accept.

  Getting *into* one is the awkward part, and worth writing down: Feishu's send API has no
  `receive_id_type` for a topic, so a message can only enter by replying to another message
  already inside it. The profile therefore remembers a reply anchor per topic — learned from
  every inbound message and refreshed by every send — and looks one up through the thread
  history API only on a cold miss (a fresh daemon, or a reverse command aimed at a topic
  nobody has spoken in yet). A topic with no reachable anchor raises an error naming it rather
  than quietly posting the agent's answer to the whole chat. `sendFile` carries the lane twice
  on purpose: the adapter's encoder posts the caption and the file separately and drops the
  quote in between, so a single one would thread the caption and leak the file.

  `autoThread: perTurn` works on Lark too. Unlike Telegram, Feishu cannot name an empty topic
  — one exists only once a message opens it — so the thread name is posted as that opening
  message.

### Fixed

- **Clicking a harness-picker button did nothing.** `/oc` posted opencode's commands as
  buttons and a tap produced no reply, no reaction, and no change to the menu. Two causes,
  both silent by construction:

  Telegram's Satori adapter sets `session.messageId` to the **`callback_query` id** on a
  click — not a message id at all — while `ButtonInteraction.messageId` is contractually the
  message the button is on. The click ack (`→ /customize-opencode`) therefore edited a
  non-existent message, 400ed, and was swallowed by the best-effort `catch`; the same bogus
  id also killed the 👀/✅ lifecycle reactions on the resulting turn. So the command *did*
  run, with every trace of it having run suppressed. The ack now edits the menu message
  captured at send time, and the Telegram profile corrects the field at the source
  (`rawCallbackMessageId`).

  Second, a click on an expired menu — the one-shot already consumed, or the daemon restarted
  since (`pendingPicks` is in-memory) — returned silently, which from the chat looks exactly
  like a dead button. It now says so.

  The whole click path had no test coverage; it does now (`daemon/picker-click.test.ts`).

## [0.4.0] - 2026-09-03

### Changed (breaking) — the registered command menu

- **Agent commands are short, and they work without config.** The per-harness entries
  registered into the platform menu were the harness enum value leaking into the UI
  (`/claude`, `/opencode`) — long to type on a phone, and *inert*: they only switched agents
  if an operator had separately hand-written a `when: { command: oc }` rule, so on a fresh
  install tapping one forwarded the literal text `/opencode` to whichever agent was bound.

  They are now `/cc`, `/oc`, `/cx`, `/gm`, `/agy` (claude, opencode, codex, gemini,
  Antigravity), and the daemon resolves them itself — each selects the first configured agent
  of that harness. A hand-written `when.command` rule still outranks the built-in table, so
  existing configs behave exactly as before. The full harness name (`/opencode`) is still
  accepted when typed; it is simply no longer registered, so it costs no menu slot.

- **A bare agent command now opens that harness's own command menu.** `/oc <prompt>` switches
  and asks, as always; `/oc` alone switches and then lists opencode's own commands as buttons
  — which is what `/opencode` used to do. This replaces two things with one: the old picker
  refused to run unless the conversation was *already* on that harness, answering "does not
  apply here, switch with `/<agent>` first" — advice the command itself can now just follow.
  A harness that reports no command list (`agy`) confirms the binding instead of posting an
  empty menu.

  Supersedes 0.3.0's "a bare `/oc` rebinds and says so instead of acking usage".

- **`/agy` is registered.** It had been skipped entirely on the grounds that it reports no
  command list, which conflated "has a menu to show" with "is worth naming" — leaving the one
  harness a user most needs to reach by name with no entry at all. Those are now separate
  fields on the harness table.

  Supersedes 0.3.0's note that agy "gets no `/agy` picker entry": it has a registered command
  now, and only the menu half remains unavailable.

### Added

- **`/help`** — lists every command this gateway understands: its own (`/new`, `/clear`,
  `/help`), one line per configured agent, and the generic vocabulary **filtered to what the
  agent answering right now actually supports**, so it never advertises a `/compact` that the
  next tap will refuse. Built from the same tables that drive registration, so the help text
  and the platform menu cannot drift apart. Answered by the gateway; a harness's own `/help`
  remains one tap away inside its agent-command menu.

## [0.3.0] - 2026-09-03

### Changed (breaking) — conversations, topics and agent binding

- **A topic is now a conversation, and the agent answering it is sticky.**

  The bug: in one Telegram topic, `/oc hi` was answered by opencode and the very next plain
  message by claude — two agents, two empty contexts, one place. The agent id led the session
  key (`<agentId>:<platform>:c:<channel>`) *and* `routing.pipeline` was re-resolved on every
  message, so a follow-up matching no rule fell through to `routing.default` and computed a
  different key. The agent was part of a conversation's identity rather than a property of it,
  so a sticky binding was not expressible.

  Now the key carries no agent. A `when.command` rule (`/oc …`) **binds** the conversation;
  every plain message after it stays with that agent until someone types another `/<agent>`.
  Config chooses a conversation's first agent, the user chooses it thereafter. A bare `/oc`
  rebinds and says so instead of acking usage.

- **Switching agents never restarts your work.** `conversations.json` records, per conversation,
  the bound agent *and* each agent's own session id — so `/oc` → `/cc` → `/oc` resumes
  opencode's existing thread rather than starting the task over. The gateway is a chat client in
  front of the agent; only an explicit `/new` discards context, and it clears the whole
  conversation. Pre-existing `sessions.json` is migrated on first start, so nothing in flight
  restarts on upgrade.

- **`session.scope` now defaults to `per_thread`** (was `per_channel`), and `per_thread` finally
  does something: it was a verbatim copy of `per_channel`, differing only in a letter of the key.
  A Telegram topic / Slack thread / Discord thread is its own conversation, with the channel root
  separate. Set `scope: per_channel` for the old folding behavior.

- **Conversation identity is a struct, not a string.** A topic is a `(channel, thread)` pair, but
  the domain had one opaque `channelId`, so the pair was smuggled through as `"<chat>:<topic>"` —
  built in 5 places, decoded in 17, validated in none. Every path that forgot to decode sent to
  the wrong place, and because Telegram truncates a malformed `chat_id` leniently in private
  chats, half those failures were silent successes. `ConversationRef`/`ConversationAddress`
  replace it; the string form survives only for the `--channel` flag (`<channel>` or
  `<channel>/<thread>`) and the store key, each with one validating parser.

- **The platform seam is one method.** `isDirect`, `isThread`, `inboundChannelId` and
  `decodeChannelKey` collapse into `resolveConversation`, called on all three inbound paths, so a
  profile can no longer wire messages and forget button clicks, and the routing view cannot
  disagree with the addressing.

### Fixed (each previously reachable)

- **Slack threads were invisible inbound.** `isThread()` hardcoded `false` while the outbound side
  emitted thread addresses, so a reply typed inside a thread was routed as channel traffic — and
  answered in the channel.
- **`when.serverId` never matched.** `guildId` was never populated on the message path.
- **A native slash could route differently from the same text typed by hand.** The synthesized
  message carried no `isDirect`/`isThread`/`guildId`, so `when.chat` always read `group`.
- **`when: {chat: private}` had stopped matching** during this refactor (config says `private`,
  the domain says `direct`); caught by a ported test, fixed with an explicit mapping.
- **Telegram `create-thread` from inside a topic** sent `chat_id: "-100123:99"` (400 in a group,
  silent truncation in a DM) and returned a malformed triple whose lane parsed to `NaN`. It was
  the one outbound path that never decoded, and had no test.
- **`autoThread` opened a thread and abandoned it**: the user's first reply inside started a
  fresh, empty conversation. The thread is now adopted by the conversation that opened it.
- **`sendFile` received a decoded channel while every sibling received an undecoded one** — a
  contract mismatch waiting to be got wrong.

### Added
- **`harness: agy` preset**: Google's Antigravity CLI (the Gemini CLI successor). Unlike every
  other preset, `agy` has no ACP mode at all, so it is driven over its own documented headless
  `stream-json` protocol by a sibling runtime (`daemon/agent-agy.ts`) implementing the same
  `AgentFactory` contract — streaming, tool bubbles, multi-turn context, post-restart resume
  (via `--conversation`) and interrupt all behave as they do for the ACP harnesses. Requires the
  `agy` CLI on PATH; auth reuses its own Google sign-in from the OS keyring.

  Its own slash commands are disabled by default (`--disable-slash-commands`): in stream-json
  mode a CLI-answered slash such as `/model` aborts the entire session, which chat users would
  trip constantly. Pass `args: ["--disable-slash-commands=false"]` to opt back in. All default
  flags are overridable through `args`. Consequently agy gets no `/agy` picker entry and the
  generic vocabulary reports "unsupported" for it, rather than forwarding a name that would
  kill the session.

  Note: Google's FAQ states that third-party access to Antigravity violates its Terms of
  Service. This harness calls only agy's official headless interface and never handles
  credentials, but the daemon is still a non-Google client driving the account.

- **Text command routing**: `routing.pipeline` rules with `when.command` now match the leading
  `/name` of plain message text, so command routing works on every platform — no native
  slash-command support needed (previously `when.command` could never match: the command field
  was never populated on the message path). A rule that matches via `command` consumes the
  prefix — the routed agent receives only the rest of the message — and a bare `/name` is
  acked with a usage hint instead of starting an empty turn. Commands matching no rule still
  pass through to the agent untouched (`/model` etc. keep working).

- **`harness: opencode` preset**: OpenCode via its native ACP mode (`opencode acp`, per the
  ACP registry's official launch spec). Requires the opencode CLI on PATH; auth reuses its
  own login state.

- **DingTalk (钉钉) platform** (`type: dingtalk`, via `@satorijs/adapter-dingtalk`): org-internal
  robot with Stream mode by default (outbound WebSocket — no public callback URL), or
  `protocol: http` for a classic webhook. Outbound messages are `sampleMarkdown`, with agent
  CommonMark pre-rendered to DingTalk's markdown subset (tables→bullets, block regrouping for
  the "single `\n` is not a line break" quirk) and sent past the adapter's escaping encoder.
  DMs and group chats both work (group messages reach a robot only when @-mentioned, which the
  mention gate honors). No edit/reaction/typing/buttons — streaming degrades to chunked sends,
  and `ask` is unavailable on this platform.

- **Contributor documentation**: a root `AGENTS.md` (conventions, layering rules, security
  invariants, and an index) plus a `README.md` per module — `src/config`, `src/core`,
  `src/platform`, `src/daemon`, `src/ipc`, `src/commands`, `scripts`. Deliberately distributed
  rather than one file: each module's contract, invariants and extension steps live next to the
  code they describe, so a coding agent reading one module gets its rules without the other six.

### Fixed
- **noEdit platforms never delivered any reply** (DingTalk/QQ/LINE/WeCom — every platform without
  in-place message editing): the StreamBuffer's degraded path recorded mid-stream accumulations as
  "already delivered" without sending them, so the end-of-turn whole-send was skipped as
  "unchanged" and the agent's reply silently vanished. Masked in tests by the old non-empty
  streaming cursor (production streams with `cursor: ''`, making the mid-stream and final renders
  identical). The agent replied every time — the buffer just never flushed it.

- **`harness: codex` actually works now**: it spawned `codex acp`, but the codex CLI has no such
  subcommand — "acp" fell into the TUI, which dies headless with "stdin is not a terminal", so
  every turn failed with "ACP connection closed". The harness now spawns Zed's
  [codex-acp](https://www.npmjs.com/package/@zed-industries/codex-acp) adapter (a declared
  dependency, platform binary resolved directly); auth reuses the codex CLI's own login state.

### Changed
- ~~**Session keys are agent-qualified** (`<agentId>:<platform>:c:<channelId>` …)~~ — superseded
  within this same unreleased cycle, and never shipped. Agent-qualifying the key did stop one
  agent from capturing a channel forever, but it made the agent part of a conversation's
  *identity*: `/oc hi` and the plain message after it became two conversations in one place. The
  conversation refactor above keeps the property that motivated it (two agents in one channel
  don't share a context) while making the conversation, not the agent, the thing being named.

## [0.2.0] - 2026-07-10

### Added
- **Config reference for agents** (`skill/references/config.md`): a complete, schema-accurate
  reference for `config.yaml` (per-platform credentials, routing, session scopes, `access.allowFrom`,
  and what is deliberately not configurable), so an agent can safely edit the gateway config when
  asked from inside the chat.
- **README "Agent skill" section** with a one-line install via
  [vercel-labs/skills](https://github.com/vercel-labs/skills):
  `npx skills add https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g`.

### Changed
- **Bundled skill rewritten** against the actual implementation: per-command output contracts
  (`messageId` returns, TOON examples, `count: 0` empty state), platform capability fallbacks
  (`reply` degrades to a plain send; `edit-message`/`create-thread`/`ask` fail with
  `unsupported operation`), error handling (`error:`/`help:` on stdout), and a new
  gateway-diagnostics section (`doctor`, config editing, why the agent must never restart
  the daemon it runs inside).
- README reordered install-first: Features → Quick start → Agent skill → Platforms → Configuration.

## [0.1.0] - 2026-07-10

### Changed (design)
- **Removed the per-agent `permission` policy.** The daemon is a headless ACP client and now
  auto-approves every tool call — agents always run with full tool access. Restricting tools, if
  wanted, is delegated to the harness (via `agents[].args`/`env`). The daemon's only access control
  is `access.allowFrom` (who may trigger an agent at all).

### Security
- **Access-control warning.** Because agents always have full tool access, an empty `access.allowFrom`
  means anyone who can message the bot can drive them. `agent-anywhere start` and `agent-anywhere doctor` now warn
  loudly on an empty allowlist (non-blocking); the setup wizard prompts for it.
- **SSRF: redirects are re-validated.** Attachment downloads follow redirects manually and re-run the
  private-address guard on every hop (previously a 3xx could bounce past the initial check).
- Proxy URLs are credential-redacted before logging; session tokens are compared in constant time.

### Changed (agent CLI / AXI)
- **Command surface tightened.** Removed `send-image` (it was a strict subset of `send-file` — both
  encode via `h.file`, so the image never inlined) and `typing` (the daemon already maintains a typing
  keep-alive for the whole turn, so a manual command was dead weight). Added `edit-message <id> <text>`
  so an agent can update a message it sent earlier (e.g. a progress line) in place.
- **`agent-anywhere` with no args now runs `doctor`** (read-only self-check), not `start` — a bare invocation
  shows live state instead of accidentally launching a daemon (AXI §8). `start` is now an explicit
  subcommand; `doctor` prints a `bin:`/`description` header (AXI §10). Start the daemon with `agent-anywhere start`.
- **`fetch-messages --fields attachments`** now emits a separate `attachments[]{messageId,type,url,name}`
  table so an agent can download referenced images/files by URL; a hint flags messages that have
  attachments when the column wasn't requested.
- **Reverse commands now speak [TOON](https://toonformat.dev/) on stdout** (via `@toon-format/toon`),
  not raw JSON — ~40% fewer tokens for the agent that reads them. Conversion happens only at the CLI
  output boundary (`commands/reverse.ts`); the daemon keeps speaking plain JSON over IPC.
- **`fetch-messages` output is now AXI-shaped**: a minimal default schema (`messageId,userId,content`),
  opt-in extra columns via `--fields` (validated; `attachments` renders as a count), per-row content
  truncation to 500 chars (with a count of how many were clipped), a `count` aggregate, paging/widening
  `help` hints, and a definitive empty state (`count: 0` + note) instead of an ambiguous `[]`.
- **Errors go to stdout, structured.** Reverse-command failures, unreachable-daemon hints, usage errors,
  and the top-level catch now emit a TOON `error:`/`help:` on stdout (commander's stderr is redirected),
  so the invoking agent can actually read and act on them. `create-thread`/`send-message`/`reply` etc.
  return actionable fields (`threadId` + a `--channel` hint; `messageId` for follow-ups).

### Added
- **Hung-agent watchdog** (`session.turnTimeoutMs`, default 10 min): aborts a turn after prolonged
  agent silence and reaps the subprocess, so a stuck agent can't pin a session forever.
- In-channel error notices: a failed turn now posts a readable reason, not just a ❌ reaction.
- Bot offline/disconnect/reconnect logging in the Satori adapter.
- Test coverage tooling (`npm run test:coverage` with thresholds), ESLint flat config (`npm run lint`),
  and a GitHub Actions CI workflow (typecheck + lint + test + coverage).
- Table-driven tests for the security-critical pure functions (SSRF guard, filename sanitizer,
  permission gate, IPC request parser, token registry) and the config security gate.
- `LICENSE` (MIT) and this changelog.

### Changed
- Removed dead type imports across platform profiles; tightened a few `let`→`const`.
