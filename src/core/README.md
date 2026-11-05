# `src/core/` — platform-agnostic logic

The pure layer. Every decision here is made from its inputs alone: **no clock, no
`process.env`, no IO, no globals.** Anything time- or IO-dependent is injected
(`now()`, `schedule()`, `download()`, `save()`).

That constraint is the whole point of the module. It means every branch is reachable in
a unit test without mocking the Satori stack or an agent subprocess, and it is why
`core/` sits below `platform/` and `daemon/` in the
[dependency stack](../../AGENTS.md#layering). `core/` imports only `config/schema.ts`
(for types) and `types.ts`.

**Do not add an import of `platform/` or `daemon/` here.** If a piece of logic needs a
platform capability, take it as a parameter or a DI interface — that is how
`StreamBuffer` gets `StreamSink`, `ToolRenderer` gets `BubbleSink`, `InboundMerger` gets
`MergerDeps`, and `ingestAttachments` gets `AttachmentIngestDeps`.

## `conversation.ts` — what "where" means

The type the whole gateway is organized around. A chat platform's location is not always
one id: a Telegram topic and a Slack thread are a `(channel, lane)` **pair**, where the
lane is a separate wire parameter. `ConversationRef` models that as a struct
(`platform` / `channel` / `thread?` / `space?` / `kind` / `user`), and
`ConversationAddress` is the subset an outbound call puts on the wire.

It replaced a composite string (`"<chat>:<topic>"` stuffed into a single `channelId`)
that was built in 5 places, decoded in 17, and validated in none — so any path that
forgot to decode sent to the wrong place, silently in private chats. The string form now
survives at exactly two boundaries, each with one tested formatter and one **validating**
parser: the `--channel` CLI flag and the persisted store key.

`conversationKey(scope, ref)` carries **no agent id**. That absence is deliberate and is
the fix for the reported bug: when the agent led the key, `/oc hi` and the plain message
after it were two conversations in one topic. Who answers is a mutable property *of* a
conversation, not part of its name — see [`daemon/README.md`](../daemon/README.md).

## Files

| File | Role |
|---|---|
| `conversation.ts` | Conversation identity: `ConversationRef` / `ConversationAddress`, the key function, the address parser, and the platform-qualified target (`tg:586/8068`) `--channel` accepts |
| `channel-list.ts` | `talkcode channels` as data: the places a turn has run, in the qualified id form, roots first then recent topics |
| `schedule.ts` | Scheduled tasks as data: building one from `schedule add`, when it runs next, catch-up and expiry, every sentence about one |
| `schedule-menu.ts` | `/setting` → ⏰ Scheduled tasks: the list, one task, the delete confirmation, their button ids |
| `inbound-gate.ts` | "Should we respond to this message?" — a pure decision tree |
| `inbound-merger.ts` | Per-conversation state machine: coalesce bursts, hand mid-turn messages to the turn or queue them, `/stop` |
| `stream-buffer.ts` | Outbound text: throttled in-place editing, chunking, backoff, degradation |
| `tool-renderer.ts` | Tool-call bubbles: 4 modes × 2 grouping strategies |
| `outbound-pacer.ts` | One write budget per chat: token buckets, one FIFO, in-place edit coalescing |
| `outbound-errors.ts` | The four failure classes the delivery layer needs from the platforms |
| `runtime-footer.ts` | The `cc · 18k / 1M (2%) · claude-opus-4-5` tagline |
| `busy-snapshot.ts` | The gateway's own `/usage` answer while a turn runs, and the note saying whose answer it is |
| `attachment-ingest.ts` | Inbound attachment orchestration (download/save injected) |
| `voice.ts` | Voice messages as data: what counts as one, container sniffing, the transcriber request and response, the confirmation card, the log fold |
| `command-translate.ts` | The generic slash vocabulary and its per-harness translation |
| `skills-catalog.ts` | `/skills`: the bound agent's own commands as text |
| `settings.ts` | `/setting` as data: which config.yaml fields are editable, what they accept, when a change lands |
| `model-menu.ts` | `/model` as data: paging, labels, button ids, matching, and every string it says |
| `effort-menu.ts` | `/effort` as data: the one-page level menu, prefix matching, and the per-harness "no levels" answers |
| `workdir-menu.ts` | `/cd` as data: the same shape, for the directory a conversation works in |
| `paging.ts` | The platform-imposed shape of a button menu: page size, page arithmetic, label budget |
| `frecency.ts` | How often a thing was chosen, discounted by how long ago — what orders the `/cd` list |
| `button-id.ts` | The `<prefix><reqId>:<n>` button id grammar every menu shares |
| `topic-stage.ts` | Where a conversation stands for a person (answer / failed / review / retrying / working / idle), from facts alone; the line that goes with it; the continue backoff |
| `agent-menu.ts` | `/agent` and the web UI's new-topic catalog: agents grouped by machine, matching a typed name |
| `title-namer.ts` | A topic's automatic name: the request to the namer model, cleaning its answer, the fallback from the first message |
| `proxy.ts` | The one impure file — see below |

`proxy.ts` is the deliberate exception: it patches undici's global dispatcher and the
`ws` package so outbound HTTP/WebSocket honor `HTTPS_PROXY`. It reads env and mutates
globals, which no other file here does. It lives in `core/` because `platform/` is its
only consumer and it has no platform-specific content; `redactProxyUrl` (which strips
credentials before logging) is pure and tested.

## `inbound-gate.ts`

`shouldRespond(msg, config, context)` → `{ respond, reason }`. The `reason` string is
stable and asserted in tests and printed in logs — treat it as an interface.

Gating config is **split in two on purpose**:

- The deployment-facing half comes from `platforms.<id>.chat`:
  `requireMention`, `freeResponseChannels`, `ignoredChannels`, `allowBots`.
- The frozen half comes from `EXPERIENCE.inbound.gating`:
  `respondInDirect`, `threadParticipationExempt`.

`ConversationRegistry.gateFor(platformId)` assembles both into one `GateConfig`, per platform
instance. An unknown instance id falls back to "mention required" — the safe default.

Both channel lists are matched with `addressSelects` (`conversation.ts`), not string equality:
an entry naming a chat covers the chat **and its topics**, while `<chat>/<thread>` names one
lane. That is the same rule routing's `when.channelId` has always used, and it is not a
convenience — in a Feishu topic-mode group every message carries a freshly minted topic lane, so
under exact matching the chat id (the only thing an operator can write down) matched nothing:
`channels` silenced the bot in the allowlisted chat, and neither list could reach it.

`GateContext.hasActiveSession` is a proxy for "the bot is already participating in this
thread". The caller must read it **before** creating a merger, or it is always true once
a session exists and the thread-participation exemption is distorted. That ordering
constraint lives in `ConversationRegistry.route`; do not move the read.

## `inbound-merger.ts`

One instance per session. A three-phase state machine:

```
idle ──ingest──► collecting ──window elapsed──► running ──turn ends──► idle
                      ▲                            │  ▲
                      └──── queued batch ◄─────────┘  └── joined (steer)   (messages arriving mid-turn)
```

- **Collecting**: a sliding merge window (`mergeWindowMs`, default 1.5 s) coalesces
  rapid consecutive messages into one turn, capped by `maxMergeWindowMs` (5 s) so a
  steady typist cannot starve the turn forever.
- **Running**: a new message **never cancels the turn**. It is offered to the running turn
  (`deps.steer` → `SteerOutcome`): `joined` means the agent took it and will see it at its next
  natural point (between tool calls), so it is not run again and gets the turn's ✅/❌; `refused`
  sends it to the queue, which holds the **latest batch** — never dropped, never unbounded — and
  starts it as a fresh turn once this one ends. Offers are decided on a chain, strictly in arrival
  order, and once a message is queued everything after it queues too, so nothing overtakes it. An
  offer still undecided when its turn ends starts the next turn itself; until it is decided
  `isIdle()` stays false and `onIdle` is held back, so the registry never reclaims the child that
  next turn needs. Which harnesses can take a message mid-turn, and how, is the runtime's business
  (see [`daemon/acp-steering.ts`](../daemon/acp-steering.ts)).
- **Interrupt** is `/stop` (`interrupt()`) alone — through 2.0.0 every new message did it
  (`interruptOnNewMessage`). It trips the turn's `AbortSignal`; `TurnRunner` reads it to finalize
  the partial reply cleanly — no footer, no ✅ (a user must not see a ✅ on a turn that never
  finished, including on a message that had joined it). The queued backlog, and any message still
  being offered, is dropped.
- **Lifecycle reactions**: 👀 received, ✅ done, ❌ error, gated by `reactionsEnabled`
  (`display.reactions.enabled`) independently of the emoji themselves, which stay
  frozen.
- **`runningSince()`**: when the running turn began, on the injected clock — undefined while idle
  *or* collecting, since a batch in its merge window is busy but has not started. Read only by a
  busy `/usage`, to say how long the turn has been going.
- **Solo turns** (`enqueueSolo`): input nobody typed — a scheduled task firing. It runs as a
  batch of one, is never offered to a running turn, waits behind it and behind the user's
  own queued messages (a person waiting outranks a clock), gets no reactions, and resolves with
  how its turn ended. A message typed while it runs is offered to it like to any turn: the person
  is there, the schedule is not. `/stop` stops a running solo turn but keeps queued ones, since the
  backlog it drops is what the user typed.

## `schedule.ts` and `schedule-menu.ts`

Scheduled tasks as data — see [`daemon/README.md`](../daemon/README.md#scheduled-tasks) for the
running half. `buildTask` turns `schedule add` into a task or into a sentence naming the flag and
the fix (the reader is an agent that retries with whatever it is told). `decide` is the whole
timing policy: the next planned time strictly after the last one handled, catch-up to the
LATEST missed time within an hour, a fixed-session window of 24 h. Times are computed with
[croner](https://github.com/hexagon/croner) (MIT, no dependencies, time-zone and DST aware) given
an explicit reference date; nothing here reads a clock, and croner is constructed without a
callback so it arms no timer. `--at` accepts relative (`+30m`), clock (`08:00`, the next time the
clock reads it), wall-clock (`2026-10-01 08:00`, in `--tz`) and zoned ISO forms; a zoneless ISO
time is read as wall-clock in `--tz`, never silently as UTC. Displayed times carry seconds when
they are not on a minute — `11:28` for a run due at 11:28:28 once led the registering agent to
tell the user the task would fire early.

`schedule-menu.ts` is the `/setting` → ⏰ task menu: list, one task, the delete confirmation,
and the append-only `sca:` action indices (a posted menu's buttons carry them).

## `stream-buffer.ts`

The most subtle file in the module. It buffers one turn's reply text and delivers it,
in one of two modes.

### `'once'` — the default (`stream.enabled: false`)

```
push … push … complete({footer}) ─▶ [ message ][ message ]…
```

Nothing goes out until the buffer completes; then the accumulated text is split by
`maxMessageLength` and sent as one message, or several. No message is ever edited.

This is the default because live editing costs more than it returns. Every flush spends an
edit and platforms cap them per message — Feishu allows 20 and then refuses *that message*
forever — so the reply most likely to run out of edits mid-delivery is the long, considered
one that matters most. Finished text sent once has no such ceiling: the only limit left is
message length, which splits cleanly.

The turn is not silent in the meantime. `TurnRunner` completes the body buffer at every
tool boundary and rotates in a fresh one, so a turn that uses tools reports as it goes —
each finished text segment arrives as its own message, alongside the session header bubble,
the 👀 reaction, and the tool bubbles (which *do* refresh in place).

### `'live'` (`stream.enabled: true`)

```
[ sealed ][ sealed ][ open ]
                       ↑ still edited in place as text arrives
```

Dual-trigger throttle: flush when `charThreshold` (200) chars accumulate **or**
`flushIntervalMs` (1200 ms) elapses since the last write. 1200 ms tracks the ~1 edit/sec
rate limit most IM platforms impose. Requires `capabilities.editMessage`, so the daemon
resolves the mode from `stream.enabled` **and** the capability: a platform that cannot edit
(QQ, LINE, WeCom, DingTalk) always gets `'once'`, which also fits its 1–2 message quota.

### Sealing (both modes)

A message is **sealed** — immutable, never touched again — for one of three reasons, all
handled identically:

| reason | trigger |
|---|---|
| full | the text outgrew `maxMessageLength` |
| budget spent | `maxEditsPerMessage` in-place edits used up |
| not editable | the platform rejected an edit with `MessageNotEditableError` |

Sealing is never a failure: the sealed text counts as delivered and delivery continues into
a fresh message, so `sealedText + open.text` is always exactly what the user can see.
Nothing is re-sent, nothing is lost. In `'once'` mode only the first reason can occur, which
is why that mode cannot lose the tail of a reply at all.

Folding the edit budget into the same concept as the length limit is what makes that
invariant hold — both are just *"this message can take no more"*. The previous design had
only "back off, then degrade to whole-message send", which could not express *permanently
un-editable*: past Lark's cap the final flush re-edited the dead message, swallowed the
rejection, and reported the turn complete. Everything after the cap was lost, and the user
saw a reply truncated mid-sentence with a ✅ on it.

- **First write sends** (to obtain a `MessageRef`); later writes **edit in place**. Text
  already on screen verbatim skips the API call — and, importantly, does not spend budget.
- **Transient failures** (rate limit, network) back the interval off exponentially up to
  `maxBackoffMs` and keep the message open. Only the platform can say a failure is
  permanent, which is what `MessageNotEditableError` is for (see `outbound-errors.ts`).
  When the platform states a **number** (`RateLimitedError.retryAfterMs`), that number wins
  over `maxBackoffMs`: the cap is a guess about how long a limit lasts, and Telegram has
  been observed asking for 229 s against a 10 s default. The backoff holds back **both**
  triggers, not just the timer — gating only the timer left the char threshold as an open
  door, so a stream that kept producing text retried every `charThreshold` characters
  straight through the wait and deepened the limit instead of letting it expire.
- **The final flush never gives up**: with no later flush to recover, any failure it can
  route around is routed around — it seals the open message and sends the remainder rather
  than leaving the answer truncated.
- **Chunking** splits overflow without breaking code fences. Critically, it splits the
  **raw** text while the platform limit applies to the **rendered** output — so
  `measureLength` (wired to `PlatformAdapter.measureRendered`) reports the post-render
  length of a raw substring. A Telegram table→bullets rewrite expands ~1.4×; WeCom
  counts UTF-8 bytes, not chars. Without this a chunk overflows after rendering.
- **Where a cut lands** is a reading decision, not just a fitting one. A cut prefers a
  block boundary (a blank line or a title follows) as long as the message stays at least
  ¾ full, then the last line break; it never leaves a title — an ATX heading or a
  bold-only line — as a message's last line. The ¾ floor bounds the cost at a third more
  messages, which matters where each one spends quota (QQ, LINE). The newlines at a seam
  are consumed, not sent, so no continuation opens with a blank line — in both modes and
  whatever sealed the previous message.
- **`[SILENT]`** as the entire reply suppresses all output.

## `outbound-errors.ts`

The vocabulary the delivery layer needs from the platforms. It started as two words and is
now four, because two turned out to hide two different distinctions:

| class | meaning | what the writer does |
|---|---|---|
| *(untyped)* | transient, unquantified — 5xx, socket reset | back off blindly, keep the message |
| `MessageNotEditableError` | permanent, **message**-scoped | seal it, continue in a new message |
| `RateLimitedError` | transient, **chat**-scoped, and *quantified* | wait exactly `retryAfterMs` |
| `WriteDroppedError` | never attempted — the pacer discarded it | state is untouched; write again |

Profiles translate their own codes through `PlatformProfile.classifyError`: Lark maps
`230072`, Telegram maps `429` (and recovers `retry after N` from the message text, because
satori's adapter throws away `parameters.retry_after` — see the contract test). Everything
else stays untyped on purpose, so a rate limit never fragments a reply into extra messages.

`retryAfterMsOf(e)` reads the stated wait, walking `AggregateError.errors` for it — the
profile's typed error can reach the writer as a *child* rather than as the thrown value.

Also home to `describeOutboundError`, which walks the same tree — satori's
MessageEncoder throws an AggregateError whose own `.message` is empty, so logging
`e.message` yielded a blank reason and failing tool bubbles logged as
`[turn] render side effect failed: ` with nothing after the colon.

## Sealing vs. pacing

The two concepts most easily confused, and conflating them is exactly the mistake the old
`ToolRenderer.paint()` encoded when it rethrew a 429:

|  | **sealing** | **pacing** |
|---|---|---|
| scope | one message | one chat |
| duration | permanent | temporary |
| question | "can this message take more?" | "can this chat take more *right now*?" |
| answer | continue in a NEW message | wait, then send the SAME thing |
| lives in | `stream-buffer.ts` / `tool-renderer.ts` | `outbound-pacer.ts` |

The three sealing rules stay three. Pacing is not a fourth: a rate limit never means a
message is finished, and treating it that way either fragments a reply into extra messages
or — the bug that was actually shipped — drops the write entirely.

## `outbound-pacer.ts`

One write budget per chat, shared by *everything*: the reply, the tool bubbles, the
reactions, the acks, the menus, and the agent's own reverse commands. The platform counts
them as a single stream, so a per-writer throttle cannot bound them no matter how it is
tuned — the quantity being limited is a sum, and no summand can see it. That is how a
`StreamBuffer` politely throttled to 1 edit/1200 ms and a `ToolRenderer` with no throttle at
all combined into 78 × `429 Too Many Requests` in one daemon run, `retry after` reaching
229 seconds.

```
submit(job) ─▶ [ per-chat FIFO ] ─▶ bucket (chat) ─▶ bucket (instance) ─▶ run()
                     │
                     └─ a queued EDIT is replaced in place by a newer edit to the same message
```

- **Keyed on `<platformInstance>:<channel>`, never the thread.** A Telegram forum topic
  shares its parent chat's flood budget; keying by lane would hand every topic a full
  allowance and reproduce the flood one level down. The exception is a platform that declares
  `paceByLane` — the web UI, which has no flood budget at all and puts every topic on one
  channel, so on the channel key a menu tap in one topic queued behind every other topic's
  streaming. `daemon/paced-adapter.ts` builds the key; this module only sees the string.
- **Token bucket, not a fixed interval.** An idle chat writes immediately; a busy one
  paces. `burst` is sized so a whole ordinary turn goes out with no delay at all and only
  sustained traffic is metered — the failure this exists to prevent was hundreds of writes,
  not a dozen.
- **Coalescing needs no API.** An edit is a statement about a message's final content, so
  two queued edits to one message collapse to the newer; a send creates a new object whose
  ref the caller needs back, so a send is never coalesced. The replacement keeps the queue
  **position** the older version earned, which is what keeps a bubble above the text
  submitted after it.
- **Only some writes may be dropped.** `reply` never is, however long the lane is stuck.
  `progress` (tool bubbles) is dropped when superseded or stale — the next paint carries
  the current state, and a bubble showing where the agent was eight seconds ago is worse
  than one that skips ahead. `typing` is dropped the moment it cannot go out immediately.
- **A drop is reported, never swallowed.** `WriteDroppedError` leaves the caller's state
  untouched, which is what makes "a progress update is never lost" structural rather than
  lucky.

The pacer is pure; `daemon/paced-adapter.ts` applies it to every `PlatformAdapter` method
and is the one place a `RateLimitedError` becomes a lane pause.

## `tool-renderer.ts`

Renders tool progress as bubbles *separate from the body*: `{emoji} {tool}: "{preview}"`.

The line format is read back by one consumer: the web UI's `renderWebToolLines`
(`platform/web-markdown.ts`) splits a finished line's ` ✓ 1.2s` off its end, so a folded row
cuts the command and not the mark. A change to the suffix or to `formatDuration` fails
`web-markdown.test.ts` rather than the page; the preview length itself is the larger of
`tools.previewLimit` and the platform's `toolPreviewLimit` (the web UI asks for 2000).

Two variants of the line, both read back by the same splitter. A preview that only repeats the
name is left out (`💻 Bash`, not `💻 Bash: "Bash"`): harnesses that title a call with the tool's
own name fall back to that title before the parameters stream. And `onToolStart` may arrive
**twice for the same `index`** — a harness that announces a call before its parameters, then
sends them — in which case the second rewrites the row in place instead of adding one. That is
how a CodeBuddy Code row stops reading `Tool: "Bash"` and starts naming the command; under
`separate` grouping there is no line set to rewrite, so the repeat is dropped rather than posted
as a second run. See `daemon/agent-acp.ts` `upgradeToolRow` for what makes a call re-emit.

A tool a **subagent** ran (`ToolEvent.agent` set) is drawn `↳ {subagent} · {emoji} {tool}:
"{preview}"`, and the lines under it from the same subagent just `↳ {emoji} {tool}: "{preview}"`:
the name is written once per run, and again wherever the owner changes and at the top of every
bubble. That is decided in `renderBlock`, not when a line is added, because a seal or `fitBlock`
changes which line is on top. The marker is text, not indentation or styling, because it has to
survive every renderer — chat markdown collapses leading whitespace, and only the web UI could
style a line. The name is cut to 16 characters so the preview after it stays visible, and `new`
mode compares owner + name, so a subagent's `Bash` right after the main agent's is not swallowed
as a repeat. Where the attribution comes from is `daemon/agent-acp.ts` `claudeAttribution`.

Four modes: `off`, `all`, `new` (dedupe consecutive same-name calls), `verbose`
(append full args JSON). Two groupings:

- `separate` — one new message per tool call.
- `accumulate` (default) — edit all progress into **one** bubble, multi-line, refreshed
  in place; `onToolFinish` updates the matching line to `✓/✗ + duration` using the
  event's `index`. Requires `editBubble`; degrades to `separate` when absent.

`accumulate` spends one edit per update, so a ten-tool turn is 20 edits — exactly Lark's
cap. The bubble is therefore **sealed** on the same three rules as a message in
`StreamBuffer` — budget spent, full, not editable: stop editing it, carry the lines whose
state it does not already show (still running, or finished since the last write) into a
fresh bubble, and keep going. Lines already fully rendered are dropped rather than
repeated, so bubbles don't grow by the whole history.

The "full" rule is why `maxMessageLength` and `measureLength` are wired in alongside
`maxEdits`. Without them a busy turn grew one bubble until the platform refused the write
outright — Telegram answers `MESSAGE_TOO_LONG` to the edit and `text is too long` to the
send — and because neither is a `MessageNotEditableError`, `paint()` rethrew and the whole
block of progress was dropped with only a `[turn] render side effect failed:` line to show
for it. When the surviving lines *alone* still overflow (a burst of parallel tools, none
finished), the oldest go first: they are the ones already readable in the sealed bubble
above. A single line over the limit — a verbose-mode JSON dump — is clamped, because
delivering part of it beats having the platform reject all of it.

The renderer owns **only** the bubbles. The message body belongs to `StreamBuffer`.
`TurnRunner` coordinates the handoff: complete the current body buffer, emit the bubble,
then rotate in a fresh body buffer so trailing text becomes a new message instead of
editing the one above the bubble.

### Painting is asynchronous, and a failed write is never lost

Sealing answers "this bubble can take no more". It does not answer "this **chat** can take
no more right now", and the renderer used to have no answer for that at all: it repainted
synchronously on every tool start *and* every finish, with no throttle, and rethrew
anything that was not a `MessageNotEditableError`. Under a run of back-to-back tool calls
that is two writes per tool into one chat. Telegram answered `429`, the rethrow reached the
turn's side-effect chain, and the update was gone — nothing re-triggers a paint until the
next tool event, so the bubble sat frozen on stale progress for minutes.

So `onToolStart` / `onToolFinish` are now `void`: they mutate the line set and return, and a
single painter drains it. Three consequences worth knowing:

- **Nothing blocks the reply.** Painting is off `TurnRunner`'s side-effect chain, so a
  paused lane cannot stall the body text behind a progress bubble. `finalize` calls
  `settle(finalizeWaitMs)`, which stops *waiting* without *cancelling* — a queued write
  still lands, just after the ✅.
- **Every failure that is not a seal arms a retry**, at the platform's own `retryAfterMs`
  when it named one, else an exponential backoff. A write the pacer discarded
  (`WriteDroppedError`) is treated identically: not delivered, therefore still pending.
- **Delivery is a revision watermark, not a flag.** `deliveredRev` is the highest revision
  of the line set that actually reached the platform. A `finishDelivered` boolean was
  correct only while writes were synchronous: a ✓ recorded *while* a paint is in flight is
  not delivered by that paint, and marking it so would let the next seal drop a line the
  user never saw finish. For the same reason `resetSegment()` defers its clear until the
  segment's final state has landed.

`onToolStart` used to return "did a new bubble appear", documented as driving the segment
break. `TurnRunner` never read it, and it cannot be answered synchronously now. It is gone.

### One thing is still ordered: taking a position

Asynchronous painting bought a flood fix and sold a reordering, and the second half went
unnoticed for a while because no test looked at interleaving. The painter runs one write
*behind* the turn's side-effect chain, so the bubble for a tool could be posted after the
body text of the segment that came next — a turn reading "now let me check the profile" →
"found it, three profiles declare it" → and only then the search that found them. With no
rate pressure at all; the normal case, not a congestion edge.

`placed(timeoutMs)` is the barrier, and the distinction it rests on is what keeps it cheap:
**only a SEND takes a position in the chat.** An edit rewrites a message that already holds
one, so a late ✓ is harmless and stays off the chain exactly as before. So `TurnRunner`
waits for placement — and for nothing else — before sending the next body message: at most
one wait per bubble, started the moment the tool is registered and therefore overlapping the
tool's own execution.

Bounded, like `settle`, and with the same preference: past the deadline the reply goes on
and the bubble lands where it lands. Order is what gets given up under a paused chat; the
answer never is.

## `command-translate.ts`

Read the header comment in the file — it records the bug that motivated the design.

The problem: native platform slash commands are **global** (Telegram `setMyCommands` is
per-bot, Discord per-application), while agents are **per-session**. Registering the
union of what every agent reports produces a menu that cannot say who owns an entry, and
an entry invoked from it routes like any other message — i.e. to `routing.default`, not
to the agent that offered it. Concretely: opencode's `customize-opencode` was landing on
the `claude` agent.

The fix, four layers, all fixed at startup from config alone:

1. `DAEMON_COMMANDS` (`/new`, `/clear`, `/stop`, `/kill`, `/setting`, `/help`) — intercepted before any
   agent. `/new` and `/stop` are separate because they answer separate asks: both end the running
   turn, only `/new` also ends the conversation. `/kill` is the rung between them — it ends the
   agent's process and keeps the conversation, for the harness `/stop`'s cooperative cancel cannot
   reach. `/setting` is the odd one out — it is the only
   command whose effect outlives the conversation, because it writes config.yaml (see
   [`settings.ts`](#settingsts)).
2. `GENERIC_COMMANDS` — a small fixed vocabulary meaning the same thing everywhere,
   translated to the target harness's native spelling at invocation time. One entry also depends
   on the platform: `/super` (`nested`) needs topics nested under one another, so it is registered,
   listed in `/help` and accepted only where the platform has them (`CommandSurface`, which
   `daemon/delegation.ts` `commandSurface` reads off the adapter) — the web UI.
3. `HARNESS_COMMANDS` — one agent command per configured harness (`/cc`, `/oc`, `/agy`).
   `/oc <prompt>` switches the conversation and asks; bare `/oc` switches and offers that
   agent's own commands, which are the ones not registered globally.
4. `routeCommandSpecs` — the names `routing.pipeline` gives particular agents
   (`when: { command: oc2 }`): the agent command of an agent the harness table cannot name, such
   as a second opencode on another host. Only a rule whose one condition is the command, and only
   ahead of the first rule with no command condition — the menu is global, so it offers only names
   that route the same way in every chat. Names layers 1-3 already answer are left to them, which
   keeps an old `when.command: opencode` rule from bringing back a slot the short names saved.

`translateCommand` returns `passthrough` (not generic — forward untouched, power users
can type native names), `translated` (forward as the native name), `local` (**the daemon
answers it, no turn** — see below), or `unsupported` (**refuse with a message, run no
turn**). Refusing is the feature: `/compact` on a harness with no compact is a mistake
worth naming, not a prompt worth a turn on.

Provenance of the table is documented per harness and must stay honest: `claude` and
`opencode` were captured live over ACP; `gemini` is unverified; `codex` is deliberately
**empty**, because inventing a native name would send a command the agent may silently
misinterpret — strictly worse than telling the user it is unsupported.

### The `local` fallback

The table's only mechanism is TEXT: it rewrites `/x` and hands it to the agent as a
prompt. So a capability the harness exposes over the **protocol** rather than as a slash
command has no native name to translate to, and used to read as "not supported" — even
though the gateway could answer it outright. Four do:

| command | why there is no native name to translate to | what answers it |
|---|---|---|
| `/context` (opencode, dsh) | opencode's `/compact`-family commands are TUI-only; ACP mode never sees them | the last `usage_update {used, size}` the agent sent, the same numbers the footer prints |
| `/context` (agy) | agy's protocol carries no token counts at all — it hands them to whatever `statusLine` command its settings name, headless runs included | the snapshot the shim from `daemon/agy-statusline.ts` pushes to the daemon over a pipe — the latest frame mid-turn, the settled one once the turn has ended |
| `/usage` (agy) | agy's own CLI answers it, and forwarding that name into the session **kills the session** | a one-shot `agy -p=/usage`, rendered as quota bars |
| `/model` (opencode, claude, agy) | opencode and claude expose the selector as a config option; agy reads it from `agy models` and switches via kill-and-respawn with `--model` and `--conversation` | `ConversationRegistry.applyModelCommand` via `AgentSession.modelSelector()` / `setModel()` |
| `/effort` (claude, codex, opencode) | all three expose the level as a config option in category `thought_level` (ids differ: `effort`, `reasoning_effort`); none advertises a command for it | `ConversationRegistry.applyEffortCommand` via `AgentSession.effortSelector()` / `setEffort()` |

### `HARNESS_CLI_ANSWERED` — the names that must not be forwarded

A separate list from the vocabulary above, answering a different question: not "can this
be translated" but "would sending this anywhere near the agent break it". On `agy` the
eleven commands its own CLI answers (`agy -p /help` prints them) end the stream-json
session and every turn behind it — `status:ERROR`, process exit 2 — so `isCliAnsweredCommand`
diverts them to a one-shot process instead. Everything else, skills above all, passes
through untouched; both halves of that were probed on agy 1.2.0 and the evidence is in the
file. It is a static copy of a list the CLI can produce, and the header says what that
costs if agy ever adds a twelfth.

`/model` has two surfaces, both built from `model-menu.ts` so they cannot disagree about
what happened. On a platform that can post buttons **and** edit them afterwards, a bare
`/model` opens a paginated menu — on the page holding the current model, since "what am I
on" is half the question. Everywhere else it prints the summary line it always did.
`/model <part of a name>` stays a pure text path on all eight platforms.

Both surfaces go through `ConversationRegistry.warmModelSelector`, which **starts the session**
when there is no list yet. Under ACP the list arrives in the `session/new` response, so a
conversation that has not run a turn has none — and the old answer, "No model selector on this
session yet, send a message then /model", was wrong in the flow it broke most: the `/cd` menu
invites picking a project and then a model, and `/cd` disposes the session, so even an established
conversation lost its list. Starting a child to answer the question brings forward the one the next
message would have started anyway; nothing is prompted and no context is spent. A failure to start
reports its real reason (`modelStartFailedText`), and `modelNoSelectorText` now means what it says:
this harness offers no model choice at all.

`/setting`'s model row deliberately does NOT warm — it reads through `peek`. Warming there would
spawn a child to answer `/setting banana`, and warming at the button click instead would mean making
the daemon's synchronous settings-menu path async.

`modelMenuSurface()` requires both capabilities, and the second is the interesting one: on
a platform that cannot edit (LINE, QQ) a menu could never be paged and — worse — never
retired, so after a pick its buttons would sit live above the ack answering "expired"
forever. A text answer there is not a degraded menu; it is the whole answer.

Two rules keep this honest:

- **A native spelling wins.** `/context` on claude still reaches claude's own `/context`,
  which knows more about claude than this gateway does. The fallback fills a hole; it
  never covers a harness that solved the problem itself. The one exception is a busy
  conversation, and only for the two session queries — see
  [below](#session-queries-while-busy). `/model` on claude looks like an
  exception and is not: probed live, the adapter does not advertise `model` at all, so a
  forwarded `/model` is a plain prompt — it spends a turn and prints
  `Current model: … Usage: /model <name>`, i.e. text to type against — while the same
  session exposes the selector as a config option the daemon can switch in one tap. The
  cost is that only the options the protocol lists can be chosen; claude's prose names
  more aliases (`opusplan`, `best`, a full model id), which stay reachable through
  `agents[].env.ANTHROPIC_MODEL`.
- **`local` is a harness LIST, not a flag**, populated only from what was probed live.
  `agy` speaks no ACP — it reports no usage numbers — so claiming a local
  answer for `/context` there would hand the user "no numbers yet, send a message first" forever. An
  honest "not supported" beats an answer that never arrives.

### Session queries while busy

`/usage` and `/context` are marked `query` in `GENERIC_COMMANDS` (`isSessionQuery`): they ask
*about* the session and do no work *for* it. Forwarding one is still what the table does, and a
forwarded command is just another inbound message — which through 2.0.0 meant it cancelled the
running turn (`interruptOnNewMessage`). Seen live on 2026-09-30: a cc turn running typecheck + the
full suite was cancelled mid-Bash by a `/usage` that Claude Code answered in under 50 ms without
calling the model, and the work stayed stopped until the user typed "继续". A mid-turn message no
longer cancels anything, but a command never joins a running turn (it has to start a prompt to run
as one), so a forwarded `/usage` would now wait out the whole turn instead.

So while the conversation's merger is not idle, `ConversationRegistry.answersWhileBusy` keeps a
forwarded query (translated, or passed through to `custom`) out of the session, and the gateway
answers from what it already holds: `/context` with the same `describeContext` the `local`
harnesses always get, `/usage` with `busy-snapshot.ts` — the live context numbers, the last
cumulative cost the harness reported (claude-agent-acp only, attached to its result-tied
`usage_update`; probed to survive a `session/load`), and how long the turn has run. Every such
answer ends with `busyNote`, which says the snapshot is the gateway's and how to get the
harness's own once the turn ends. Collecting counts as busy too: a command forwarded inside the
merge window is glued onto the waiting message and stops being a command.

Idle conversations are unchanged — the harness's own answer knows more (claude's adds per-model
tokens, cache and API time). `local` and `unsupported` answers are unchanged too: neither touches
the session, and a snapshot of a harness with no `/usage` would answer a question nobody asked it.

The same registered vocabulary is also why a pending question (`answersPendingQuestion`) no longer
takes a generic command as its answer: a tapped `/usage` is someone asking the gateway, not answering
the agent. Only registered names — `TEXT_COMMAND_RE` needs whitespace after the name, so a path like
`/srv/data` is not command-shaped and still answers "where should it go?".

`/model` matches on any substring that picks exactly one model, because opencode offers
93 of them: far past a button menu's 25 and past what is readable as a list, but
`/model sonnet-5` is one thumb-typed token. An ambiguous query lists the candidates
rather than guessing — picking one silently would change which model answers.

`/effort` (`effort-menu.ts`) is `/model`'s shape with two deliberate differences. Its list
is a handful of levels, so the menu has no pages — a list longer than one page on the
posting platform falls back to text rather than drawing past the limit. And a level is
matched by PREFIX, not substring, because the words contain each other: `high` is inside
`xhigh`, so a substring rule would make every non-exact query ambiguous, while a prefix
keeps `/effort x` meaning `xhigh`. The levels belong to the current *model*, not the
harness — opencode offers them only for models with reasoning variants, codex only for
models in the installed codex-cli's catalog — which is why "no levels" is a per-harness
sentence naming the model and the way out, not one line for everyone.

`custom` always passes through — nothing is known about a user-supplied executable, so
rejecting its commands would break a working setup on a guess.

### `HARNESS_COMMANDS`

The single source for what each harness's command is called, which spellings resolve to
it, and whether a bare invocation can show a menu.

| harness | registered | also accepts | bare form |
|---|---|---|---|
| `claude` | `/cc` | `/claude` | its command menu |
| `opencode` | `/oc` | `/opencode` | its command menu |
| `codex` | `/cx` | `/codex` | its command menu |
| `gemini` | `/gm` | `/gemini` | its command menu |
| `agy` | `/agy` | — | binding ack |
| `custom` | — | — | — |

Short names because these are typed on a phone, mid-conversation, many times a day;
`/opencode` was the harness enum value leaking into the UI. The full harness name stays
as an unregistered alias so existing muscle memory and any `when: { command: opencode }`
already in a config keep working — it simply costs no slot in the platform menu.

**`name` and `picker` are separate fields on purpose.** Registering a command and having
a command list to show are different questions, and `agy` is the case that proves it: it
reports no command list and runs with `--disable-slash-commands`, so a bare `/agy` could
only ever say "none yet" — but switching a conversation *to* agy is the useful half, and
skipping registration entirely left the one harness a user most needs to reach by name
with no menu entry at all. `custom` is absent from both: the harness name carries no
meaning to a reader and the executable advertises no stable command set.

`agentForCommand` resolves a command to the **first configured agent of that harness**,
which is what lets a registered command work with no `routing.pipeline` entry. Before
this, `/oc` meant something only because an operator had hand-written
`when: { command: oc }`, so a fresh install registered a menu whose agent commands were
inert and reached the bound agent as the literal text `/oc`. A pipeline rule still
outranks the table — see `daemon/routing.ts` `resolveAgent`.

`unconfiguredHarnessCommand` is the other side of that lookup: a name that IS in the
vocabulary but selects nothing here, because this deployment configures no agent of that
harness. `daemon/conversation.ts` answers it instead of forwarding — a declined name keeps
its `/agy` prefix, so the bound agent would run it as one of its own slash commands, find
nothing, and produce no output at all.

`buildHelpText` renders `/help` from these same tables, so a command cannot reach the
platform menu without reaching the help text. It filters the generic section to what the
*currently bound* harness actually supports, because listing `/compact` to an opencode
user who will be told "not supported" the moment they tap it is precisely the silent
degradation this project avoids.

## `settings.ts`

`/setting` as data. One `SETTINGS`-style table drives the menu rows, the text list, value
validation, the config path that gets patched, and the ack sentence — so a settings screen
cannot list a field it will not write, or write one it never listed.

The editable set is deliberately narrow (`model` expands to one row per configured agent):

| key | config path | accepts | takes effect |
|---|---|---|---|
| `agent` | `routing.default` | a configured agent id | **now** — `resolveAgent` re-reads it per message |
| `model` / `model.<agent>` | `agents[<id>].model` | the agent's reported list, any name, or `-` to clear | **next agent session** — the value is read at spawn |
| `delegation` | `delegation.confirm` | `on` / `off` | **now** — read per `task-new`; `off` starts each sub-task at once and posts a card without buttons, in a conversation with no parent |
| `idle` | `session.idleTimeoutMs` | `off`, `<n>m`, `<n>h` | **now** — the sweeper is re-armed |
| `scope` | `session.scope` | the four `SessionScope` values | **on restart** — file only |
| `stream` | `stream.enabled` | `on` / `off` | **now** — `TurnRunner` resolves the delivery mode per turn |
| `voice` | `voice.confirm` | `on` / `off` | **now** — read when each transcript is ready. A row only where a `voice:` block exists |
| `cleanup` | `voice.cleanup` | `on` / `off` | **now** — read when each voice note's transcription starts. A row only where a `voice:` block exists |

`scope` is the one that is written but not applied, and that is the interesting decision.
The scope decides how `conversationKey` is computed, so changing it live would silently
re-identify every existing conversation: the next message in a topic would land in a brand
new one with no context, while the old agent child sat resident until reclaim. Writing the
durable answer and saying "on restart" is the honest version.

`model` is the only per-target setting, and its option list has a condition worth
remembering: a model list exists only on a **live ACP session**, and a conversation has at
most one — so buttons are offered for the agent answering *here*, and any other agent's
model is set by typing the name. The empty case gets a sentence naming which condition is
missing (`settingTypedOnlyHint`), never a blank menu. An unrecognized name is **accepted**
rather than refused: the selector is not the set of names a harness takes (claude documents
`opusplan`, `best`, a full model id, none of which the ACP config option lists), so the ack
says it was not advertised instead.

What is **not** editable is refused *by name* (`NOT_EDITABLE`), with the reason, rather than
answered "no such setting" — a real config key deserves better than being told it does not
exist. `access.allowFrom` is out because one wrong value locks the operator out of the
surface they would use to fix it; credentials because a chat log is the wrong place for
them; `routing.pipeline` because a rule is a structure, not a value a picker can offer; and
the `EXPERIENCE` knobs because they are not in the file at all.

The write half lives in [`daemon/settings-store.ts`](../daemon/README.md) — this module
decides, that one touches the file.

## `skills-catalog.ts`

The rendering half of `/skills`; the data comes from [`daemon/skills-scan.ts`](../daemon/README.md),
which reads the skill directories off disk. Read the header comments in both — between them
they record why this is text rather than a picker, and why it is disk rather than the agent's
own ACP report.

The short version of each. **Text, not buttons:** 26 skills are installed here against
Discord's cap of 25 buttons per message, so a picker is a paging UI first; and buttons cannot
carry free text, so a tapped one would have to park a pending selection and wait for the next
message to complete it, buying a state machine and an expiry policy. None of that is needed,
because typing `/server-ops check the disk` already reaches the agent — a name outside the
generic vocabulary passes through untouched (`ConversationRegistry.route`). Invocation was
never the gap; discovery was.

**Disk, not the agent's report:** `available_commands_update` is authoritative but only exists
once a session has been built, and the daemon holds it in memory — so every restart emptied it
and the first `/skills` after an update reported nothing. Disk is readable cold.

Names only, no descriptions, **one per line**. A skill's `description` frontmatter is written
for a model deciding whether to load it and runs to hundreds of characters (`server-ops` alone
is over 300), so 26 of them fit in no platform's message. One-per-line costs nothing over a
comma-joined run — it trades `, ` for `\n`, 560 bytes against 709 — and a comma-joined run of
26 names is unscannable on a phone. The daemon still chunks the result, for a machine with more
skills than any seen so far.

## `paging.ts`

Page size, page arithmetic and the label budget, shared by the `/model`, `/setting` and
`/cd` menus. Page navigation **wraps** rather than disappearing at the edges — hiding ◀ on
the first page shifts every other button by one position between pages, and a disabled
button does not exist on Telegram at all.

**The page size comes from the platform, not from here.** `PAGE_SIZE` (6) is only the
default for a profile that declares no `menuPageSize`, because the limits are nowhere near
each other: Discord allows 25 components per message, Telegram's inline keyboard is
effectively unbounded but costs one screen row per button, LINE bundles at most 4 per
template. One shared number has to be the smallest of those, and the smallest is what made
`/cd` page through a ten-project workspace two items at a time. `resolvePageSize` applies
the default and clamps a declared number to `PAGE_SIZE_MAX` (22 — Discord's 25 minus the
three buttons a menu adds beyond its items).

Every function here takes the size as a parameter, and the daemon **freezes** the resolved
number alongside the option snapshot when it posts a menu (`PendingModelMenu.pageSize` and
its siblings). A click arrives later; re-deriving the size then would compute page
boundaries the message on screen was never drawn with, so `Next ▶` would skip or repeat
entries.

## `frecency.ts`

`decayedScore` / `bumpedScore` / `rankByFrecency` — the ordering behind the `/cd` menu, so
the projects this machine actually works in come first. Alphabetical is the one ordering
guaranteed to ignore what the user does, and on a phone that meant paging to reach the
directory you reach every day.

Neither half of the obvious pair works on its own: a plain visit counter never forgets, so
last quarter's project outranks this morning's forever; a plain timestamp forgets
everything else, so one curious click displaces the project someone has lived in all month.
The score is therefore a sum over past visits, each discounted by its own age with a
fortnight half-life.

That sum looks like it needs every visit's timestamp. It does not: exponential decay is
memoryless, so decaying the running total to `now` and adding 1 gives exactly the same
number as decaying each visit separately — which is why
[`daemon/workdir-usage.ts`](../daemon/README.md) stores two numbers per directory instead
of a log that grows forever. That identity is the whole design and is not visible from
reading either function, so `frecency.test.ts` pins it against a brute-force sum.

`now` is a parameter, like every other clock in `core/`.

## `attachment-ingest.ts`

Pure orchestration; `download` and `save` are injected (the real IO, including the SSRF
guards, lives in [`daemon/attachment-io.ts`](../daemon/README.md)). Platform CDN URLs
expire, so attachments are downloaded and cached. Readable text ≤ `maxInjectBytes`
(100 KB) is inlined into the prompt; anything larger or binary gets a local path for the
agent to open itself. Above `maxDownloadBytes` (25 MB) nothing is fetched and only a
metadata line is emitted.

`download` may report a `name` and a `contentType` alongside the bytes, and both are
**fallbacks** — what the message element declared wins. They exist because the platforms whose
media needs a platform-specific fetch (Lark) are exactly the ones whose elements declare
neither, so the fetch is the only place either can be learned: a Feishu image has no filename at
all. Learning them late changes two decisions, which is why they are not merely logged — what
the saved file is called, and whether this was readable text after all.

**Pictures are also returned as bytes** (`images`), for a harness that takes them as prompt blocks
(see `promptBlocks` in [`daemon/`](../daemon/README.md)). Each keeps its path line unchanged. Only
what was sent *as* a picture qualifies (element type `image`, or an `image/*` mime), and only
PNG/JPEG/GIF/WebP, ≤ 3.75 MB each and 15 MB together — the strictest per-image cap among the APIs
a relay might front, and room left in a 32 MB request for the history. The type comes from the
bytes (`sniffImageType`), never the platform's label: a mismatched `media_type` is a 400, and a
prompt already in the harness's history is re-sent on every later turn of that session. Whatever
misses a cap or the format list is reported in `heldBack` for the daemon to log.

## `runtime-footer.ts`

Renders the trailing tagline from `FooterField`s, joined by ` · `, empty when no field is
available. `formatTokens` uses the same units the harnesses and Claude Code's own status
line use (`18k`, `324k`, `1.2M`) so numbers are comparable across surfaces. The home
directory is **passed in**, not read — that is the module's purity rule in miniature.

The context fields require the harness to report ACP `usage_update`. A harness that
does not renders no context segment rather than a guessed number.
The `effort` field is the same bargain: it prints only a level the harness reported, and
nothing for a harness with no level or one sitting at `default`.

## Tests

One test file per non-trivial file here. This module carries the repo's only enforced
coverage floor: **70%** statements/branches/functions/lines on `src/core/**`
(`vitest.config.ts`). When you add logic here, add the test — the threshold will fail CI
otherwise, and that is intended.
