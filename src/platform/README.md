# `src/platform/` — IM platform adapters

Everything platform-specific is funneled through one seam so that eight chat platforms
reuse one generic core. Adding a platform means writing **one profile file and one
schema** — no changes to `core/`, `daemon/`, the setup wizard, or `doctor`.

The ninth, [`webui/`](webui/README.md), is the exception that proves where the seam ends: it
is a browser page this daemon serves itself, so there is no bot, no gateway and no `Session`
to normalise. It implements `PlatformAdapter` directly and is dispatched before `PROFILES` in
`platform-factory.ts`. See its README for what that costs and where each cost is paid back.

## Architecture

```
      daemon  ──uses──►  PlatformAdapter        (adapter.ts — capability interface)
                            ▲   ▲
                            │   └──implemented directly by──►  webui/  (no Satori at all)
                            │ assembled by
                     satori-core.ts             (generic: lifecycle, inbound
                              │                  normalization, send/edit/delete,
                              │                  reactions, history)
                              │ delegates platform specifics to
                     PlatformProfile            (profile.ts — the seam)
                              ▲
        ┌──────────┬──────────┼──────────┬──────────┐
     discord   telegram     slack      lark    qq/line/wecom/dingtalk
                                (profiles/*.ts)
```

Three rules keep this from rotting:

1. **`satori-core.ts` never imports a concrete platform.** It depends only on
   `PlatformProfile`.
2. **Profiles never see the whole `Config`** — only their own typed `platforms.<id>`
   entry. `platform-factory.ts` guarantees the entry's `type` selected the profile, so
   profiles read credentials without narrowing.
3. **Satori-generic Bot methods are called directly by core**, not through the profile:
   `sendMessage`, `editMessage`, `deleteMessage`, `createReaction`, `deleteReaction`,
   `getMessageList` are consistent across adapters (verified against the Koishi message
   API). Only genuine differences go through the profile.

## Files

| File | Role |
|---|---|
| `adapter.ts` | `PlatformAdapter` + `PlatformCapabilities` — what `daemon/` sees |
| `profile.ts` | `PlatformProfile` — the seam every platform implements |
| `satori-core.ts` | Generic assembly of an adapter from a profile + one instance |
| `satori-file-url.ts` | Repairs an upstream `http.file()` collision that broke every Telegram download |
| `platform-factory.ts` | `type` → profile factory dispatch |
| `config-schemas.ts` | Per-platform credential schemas (+ `ChatGateSchema`) |
| `profile-helpers.ts` | Shared pure utilities for profiles |
| `profiles/*.ts` | The eight platform profiles |
| `webui/` | The ninth platform, which is not a profile — see its [README](webui/README.md) |
| `*-markdown.ts`, `markdown-tables.ts` | Per-dialect outbound markdown renderers |

`config-schemas.ts` is kept as a sibling module rather than inside each profile so that
**config loading never imports the heavy Satori adapter chain**. Keep it that way —
`config/schema.ts` imports this file.

## Capabilities, not platforms

`daemon/` and `core/` never branch on platform identity; they branch on
`PlatformCapabilities`. Current matrix:

| | Discord | Telegram | Slack | Lark | QQ | LINE | WeCom | DingTalk | Web UI |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `editMessage` | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| `reaction` | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ |
| `typing` | ✓ | ✓ | – | – | – | ✓ | – | – | ✓ |
| `reply` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `thread` | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| `standaloneThread` | – | ✓ | – | – | – | – | – | – | ✓ |
| `renameThread` | – | ✓ | – | – | – | – | – | – | ✓ |
| `buttons` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| `editButtons` | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| `slashCommands` | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ |
| `maxMessageLength` | 2000 | 4096 | 3000 | 10000 | 1000 | 5000 | 2000 | 3500 | 20000 |
| `menuPageSize` | 12 | 12 | 12 | – | – | – | – | – | 12 |
| `toolPreviewLimit` | – | – | – | – | – | – | – | – | 2000 |

**`editButtons` is not `editMessage && buttons`.** It is its own field because the
conjunction is right by accident and wrong in mechanism. Lark has both, yet its
`editMessage` posts `msg_type:'post'` through `im.message.update`, which cannot touch a
card — buttons live on a card and are replaced through `im.message.patch`. QQ and LINE
have buttons and no edit endpoint at all (LINE has no delete either, so not even
delete-and-repost is available). A caller that needs to advance a posted menu — the
paginated `/model` picker — checks this field and degrades to a text answer otherwise.

The web UI column is what a browser is: everything true. Its topics are lanes, the same shape
as a Telegram forum topic, which is also why it is the second platform after Telegram that can
rename one — `retitleLane` refuses any address without a lane, so a design that gave each topic
a channel of its own would have left `renameThread` permanently inert.

**The adapter methods that are not in the matrix are not capabilities.**
`useWorkdirLookup` hands an adapter a way to *ask* the daemon which directory the conversation
at one of its addresses works in, and only the web UI implements it: a chat platform has
nowhere to put the answer, while the page's topic switcher has a second line per row and,
without this, nothing to put in it. Optional rather than flagged — an adapter that does not
implement it is simply never asked, the same shape `fetchAttachment` uses. Pull rather than
push because the answer moves (`/cd`, a rebind) and because a restart leaves conversations that
have a directory and no in-memory state at all; see the doc comment on the method for the rest.

`useLivenessLookup` is the same seam for a different question: is an agent child still resident
behind this conversation? A turn ending does not end the agent, so without it a topic that went
quiet a minute ago and one whose child was reclaimed an hour ago are the same grey row. Pull for
one more reason on top of the directory's: nothing *announces* a reclaim — it happens on a timer,
in a conversation by definition nobody is touching — and a child can also exit on its own.

`useIdleReclaim` hands over an action instead of a question: end the agent process behind a
conversation if it is idle — the idle sweeper's reclaim, asked for now. It is the web UI's "Close
idle agents". The page's idea of idle is a dot that can be seconds old, so the daemon applies the
sweeper's own gates (no turn, no pending question, a runtime that can resume) and refuses
otherwise; the conversation is kept either way.

`useScheduleLookup` is the third question, and the only one that is not decoration: does a scheduled task
still post into this conversation? The web UI evicts its least recently active topic once it holds
64, and a task's target is a plain address nothing rewrites when the topic behind it goes — so the
answer decides what may be evicted, not what a row looks like. It is read only at that moment.

`useSchedulePanel` is the other half of that answer: the whole task list and the four operations
(pause, resume, run now, delete), handed to a platform that can draw them — the web UI's side
panel. It is the one seam here that is a surface rather than decoration, so the page pulls it when
it opens, after every action, and on a timer while it is visible; nothing announces a run
finishing, and a push would invent an event the daemon does not otherwise need. The operations go
through `ScheduleService.op`, the same validation the agent's `schedule` commands and
`/setting schedule` use, and a refusal comes back as a sentence rather than a throw because it is
the page's to show.

`setStatus` is the fourth, and runs the other way: the daemon *pushes* the agent's live status
(model, context, cost, cache expiry, quota) for a conversation, and only the web UI shows it — in a
strip above its composer. Push rather than pull, the reverse of the three lookups and for the
reverse reason: every value changes at a moment the daemon already sees (a `usage_update`, a status
frame, a turn ending) and nothing changes it in between, so a lookup would have to be polled
forever for an answer that only moves while an agent is talking. The daemon's
`status-board.ts` drops repeats and throttles before calling it; an implementation may treat every
call as a change. It may throw on a bad address — the caller swallows that.

`setActivity`, `seenAt`, `parentOf` and `childrenOf` are what one person running many conversations
needs from a platform that lists them (daemon/turn-outcomes.ts, daemon/delegation.ts). `setActivity`
is pushed like `setStatus`, and for the same reason: how a turn ended and whether a continue is
scheduled change only at a turn's start and end. `seenAt` is a read — when the person last looked at
a conversation, which only a platform that draws its own page can know (no chat app reports that a
bot's message was read). `parentOf` / `childrenOf` read back which conversation opened which
(`createThread`'s `under`): the platform's record is the only one, so deleting a topic ends the
relation, and both must not throw — they are asked about conversations that may have gone. All four
are web-UI-only today. A missing `seenAt` reads as "cannot tell"; a missing `parentOf` means no
sub-agents on that platform, and `task-new` there is refused rather than opening topics nobody could
tell apart from the rest.

**`toolPreviewLimit` only ever raises the preview.** Turn-runner hands the tool renderer the larger
of it and the operator's `tools.previewLimit`, so a platform declares one only if it can fold a long
tool line itself — a chat app shows the text as sent, and there a short preview is the only thing
keeping a run of tools one line each. It travels with the other half of that arrangement,
`sendMessage`'s optional `SendOptions` (`MessageKind`: `tools`, `dispatch`, `report`), which every
adapter but the web UI ignores. See the web UI's [Tool bubbles](webui/README.md#tool-bubbles) and
[Sub-agent bubbles](webui/README.md#sub-agent-bubbles).

**`menuPageSize` is a declaration, not a preference.** It says how many items one page of
a button menu (`/cd`, `/model`, `/setting`) may hold here, and the limits are nowhere near
each other: Discord allows 25 components per message, Telegram's inline keyboard is
effectively unbounded but costs one screen ROW per button (one per row — a shared row
squeezes long labels into unreadable slivers), LINE bundles at most 4 per template, QQ 5
per row. A dash above means the profile declares nothing, which core reads as the
conservative `PAGE_SIZE` (6) rather than as "no limit" — the failure mode of guessing high
is the platform rejecting the whole message, so a platform nobody has measured stays small.
Lark is a deliberate dash: its cards are hand-built here and it publishes no citable
element cap for a card's action module. `core/paging.ts` clamps whatever is declared to
what one Discord message can physically carry.

**`renameThread` is not `thread` either**, for the same shape of reason. Four platforms
report `thread: true` and give four different answers to "can this lane be renamed":
Telegram forum topics can (`editForumTopic`), Slack `thread_ts` lanes have no name at all,
and Discord threads would need a different endpoint. It also requires an `address.thread` —
renaming "the whole channel" is a different and much more dangerous operation than renaming
a lane, and no caller wants it, so the Telegram profile refuses a thread-less address before
the API call. Used by the automatic topic rename and `/title`; see
[daemon/README.md](../daemon/README.md) for where the name comes from.

**`standaloneThread` is not `thread` either.** `thread: true` says the platform has lanes;
this says a lane can be opened with no message to hang it on, which is what a scheduled run
has. Telegram's `createForumTopic` and the web UI's topics can; Slack's `thread_ts`, Discord's
`startThreadFromMessage` and Lark's `reply_in_thread` all need a real message. A scheduled
run that asks anyway either fails or names the channel instead of a new lane, and a daily
task would persist that as its day's topic. `schedule add --session daily` refuses a target
without this; Telegram declares it because a forum supergroup can, even though an ordinary
group cannot — a run there fails and says so.

Three capability fields are easy to conflate:

- **`slashCommands`** means "can *receive* slash commands".
- **`canRegisterSlashAtRuntime`** (default true) means "can *register* them at
  runtime". Slack is explicitly `false` — its slash commands are registered
  out-of-band via the App config panel or manifest, so `registerCommands` is a runtime
  no-op and the daemon skips the pointless call (logging it once).
- **`slashNeedsAck`** means the platform requires an answer to close out the
  interaction. Discord does (its adapter auto-emits a DEFERRED response and the UI reads
  "the application did not respond" until a followup lands). Telegram-style platforms
  deliver slash as an ordinary message with nothing to close, where a receipt is pure
  noise.

`maxSlashCommands` caps a registration batch; the excess is registered as nothing but
**logged**, and still invokable by typing.

## `classifyError` — the platform's failures in the core's words

A profile declares ONE translator from its own error vocabulary into
[`core/outbound-errors.ts`](../core/README.md#outbound-errorsts), and `satori-core` applies
it around every outbound call the adapter makes.

One translator, not one per method, because the alternative was tried and rotted: Lark's
`230072` → `MessageNotEditableError` mapping lived inside `editMessage` and nowhere else, so
the identical rejection raised by a card patch reached the writers as an anonymous transient
and was retried forever. Two profiles use it today — Lark for `230072`, Telegram for `429`
(recovering the flood wait from the message text, since satori's adapter throws away
`parameters.retry_after`; pinned by `telegram.contract.test.ts`).

Be conservative about what you translate *into*. A permanent failure wrongly typed as a rate
limit merely wastes a retry; a permanent one typed as transient loses the message — and
typing an ordinary `400` as either turns a loud one-time error into a silent retry loop.
Return the error unchanged when nothing matches.

## `resolveConversation` — the one place a platform describes its thread model

Some platforms need more than a channel id to address a message. A Telegram forum topic
and a Slack thread are a `(channel, lane)` **pair**: the lane is a separate wire
parameter (`message_thread_id`, `thread_ts`), not part of the channel id. A Discord
thread is not — it has its own snowflake and every API call targets it directly.

One method covers all three:

```ts
resolveConversation(session): { channel, thread?, space?, kind }
```

- `channel` **must** be a complete API target on its own. Telegram's adapter reports a
  group topic's `channel.id` as the bare `message_thread_id` and puts the chat in
  `guild.id`, so the profile has to swap them back — echoing `channel.id` would address a
  nonexistent chat.
- `thread` is set **only** when addressing needs an extra wire parameter. A Discord
  thread is `kind: 'thread'` with **no** `thread`.
- `kind` is the sole thread/DM witness for routing and gating.

Lark is the fourth: a Feishu topic (话题) is `(chat_id, thread_id)`. The adapter reports
neither half as a lane — `channel.id` and `guild.id` are both the chat id — so the profile
recovers `thread_id` from the referrer the adapter picks off the event (`larkThreadIdOf`).

It replaced four methods (`isDirect`, `isThread`, `inboundChannelId`, `decodeChannelKey`)
that were derived independently from the same session and could therefore disagree — a
message routed as a thread but replied to as a plain channel, or the reverse. Telegram
needed a dedicated test just to police the agreement, and Slack failed it silently
(`isThread` hardcoded `false` while its outbound side emitted thread addresses). One
method cannot contradict itself.

`satori-core` calls it on **every** inbound path — message, button click, slash command —
so a profile cannot wire it for messages and forget the interactions. That omission is
why buttons clicked inside a Telegram topic used to resolve to the chat root, leaving a
blocking `ask` unmatched until it timed out.

### Addressing, outbound

Every outbound method takes a `ConversationAddress` (`{ channel, thread? }`), never a
string. The lane used to be smuggled through as `"<chat>:<topic>"` inside the channel id —
built in 5 places, decoded in 17, validated in none — and every path that forgot to decode
sent to the wrong place. Worse, Telegram truncates a malformed `chat_id` **leniently** in
private chats: `ok=true`, message in the chat root, nothing logged.

A profile that reports a `thread` must implement the overrides that can carry it
(`sendMessage`, `sendFile`, `typing`, …). If it doesn't, `satori-core`'s generic path
**throws** rather than silently posting to the channel root — see the guard in
`assertNoLane`.

Telegram and Slack put the lane on the wire as a parameter (`message_thread_id`,
`thread_ts`). **Lark cannot**: `im/v1/messages` has no `receive_id_type` for a topic, so the
only documented way in is `im.message.reply(<a message in the topic>, { reply_in_thread })`.
Its profile therefore keeps a `thread_id → message id` cache (`LarkTopicRouter`), fed by every
inbound topic message and every send it makes, and falls back to the thread history API on a
cold miss. A platform whose lane needs a *lookup* rather than a parameter should copy that
shape rather than reach for an undocumented endpoint.

## Inbound attachments: a URL is not always fetchable

`attachmentMeta` normalizes what a media element *declares* (mime, size). What it cannot fix is
an element whose URL nothing outside the bot can resolve: adapter-lark decodes an inbound image
or file into `internal:lark/<selfId>/im/v1/messages/<id>/resources/<key>?type=…`, satori's
internal-URL form. The daemon's downloader speaks http(s) only — deliberately, since it
re-validates every hop of a user-controlled URL — so every Feishu image and file reached the
agent as `[Attachment … failed to download]`.

The optional `fetchAttachment(bot, url)` is the way out: the profile gets first refusal on each
URL and returns `undefined` for anything it does not own, so a platform mixing public CDN links
with private ones needs no branch of its own. Lark is the only one of the eight that needs it
(the other seven emit public https links — verified by grepping their adapters for
`getInternalUrl`).

It also returns `name` and `mime`, because the platform that needs the hook is the platform
whose elements carry neither: a Feishu **image** message has no filename anywhere, and the
adapter's binary route drops the response headers, so both are recovered inside the profile —
the filename from the raw event body (a `file` message states it, and the profile caches it by
`file_key` in the same `internal/session` hook that learns topic anchors), the mime and
extension by sniffing magic bytes. An extension-less blob is a file the agent cannot open, and
guessing `.jpg` for a png is worse than looking.

The opposite case is a URL that is not a location at all. adapter-telegram downloads an inbound
file with the bot token and inlines it as `data:<mime>;base64,…`, so for Telegram every photo,
document and voice note arrives *as its own bytes*. Two layers had to learn that: the downloader
returns them directly (the SSRF guard has no host to check and no request to make — only the size
cap applies), and the ingest names the attachment from its mime rather than the last `/`-separated
chunk of the URL, which here is a slice of base64. The failure lines quote a truncated form for the
same reason: quoting a `data:` URL back would paste the whole file into the prompt.

A third layer had to learn it too, and was the costliest miss. When the element walk in
`satori-core.ts` finds no text it used to fall back to the adapter's own `content` — which the
adapters build by **serializing the elements** (adapter-telegram: `segments.join("")`), so for a
voice note with no caption the "text" was `<audio src="data:audio/opus;base64,…"/>`, the whole
recording. That string became the prompt: a 25 KB voice note reached the agent as 34,000
characters of base64 (2026-09-18). The fallback now fires only when the walk found neither text
nor an attachment.

Audio elements keep their own attachment type (`audio`) rather than folding into `file`: a
Feishu voice note declares no mime and no name, so the element type is the only thing that says
it is audio before it is downloaded — and the daemon needs to know that to transcribe it.

Getting that far first needs `satori-file-url.ts`, which repairs an upstream collision: adapter-telegram
asks for a file by its API-relative path (`/photos/file_13.jpg`) against an `endpoint` carrying the
token, and `@satorijs/core`'s own `http/file` listener runs `new URL()` on that path *before*
`plugin-http` resolves it — throwing `ERR_INVALID_URL` and killing every Telegram file download
before it starts. A listener prepended to the same event resolves relative paths first, so satori's
only ever sees absolute URLs. It is pinned by a contract test that reproduces the upstream bug, and
both the fix and this paragraph can go once upstream guards that call.

## Inbound content an adapter leaves empty

An adapter that decodes only some of a platform's message types produces a session with **no
content**, and an empty message is dropped by the inbound gate (`empty`) before anything else
looks at it. That failure is invisible from the outside: the bot ignores a message that plainly
@-mentioned it, and nothing is logged.

adapter-lark decodes `text/image/audio/media/file` and nothing else, so Feishu **rich text**
(`msg_type: 'post'` — sent whenever a message mixes formatting or embeds an image) arrived empty.
The Lark profile rebuilds it in its `internal/session` hook (`larkPostElements`), which works
because satori's `dispatch` emits that event *before* the typed `message` event, and `elements` is
a Session accessor over the same storage core normalizes from. It is the one place a profile
**writes** to a session; if you copy the pattern, keep the citation and the test, since an
ordering change upstream would silently restore the bug.

Two details are load-bearing rather than cosmetic. A post's `at` carries a placeholder
(`@_user_1`), with the real `open_id` in the message's `mentions` array — unresolved, it can never
equal the bot's selfId, so `detectMention` would be permanently blind in rich text. And a post's
embedded images are addressed exactly like a standalone image message, so the attachment fetch
above needs no special case for them.

Still empty on purpose, with the reason written down at the call site: `sticker` (Feishu's
resource API excludes 表情包), `share_chat`, `merge_forward`.

## Markdown: one converter per dialect

Agents emit standard CommonMark. Almost no IM platform renders it. Each converter
documents its target dialect's supported subset **with the doc source and a verification
date** — keep doing that.

| Converter | Output | Notes |
|---|---|---|
| `discord-markdown.ts` | raw markdown | Discord renders CommonMark natively; **only** GFM tables are rewritten to bullets. Everything else passes byte-for-byte. |
| `telegram-markdown.ts` | Satori `h()` tree | The adapter serializes + escapes it (`parse_mode=html`). Hand-rolling Telegram-HTML is an escaping minefield and a malformed one is a 400. |
| `slack-markdown.ts` | mrkdwn string | Different dialect: `*bold*` single-asterisk, `<url|text>` links, no headings, no tables. Bypasses the adapter's `escape()`, so this file owns escaping. |
| `lark-markdown.ts` | Lark md string | Preserves `\n` (Lark's `md` segment treats them as breaks). No tables, headings, or blockquotes. |
| `dingtalk-markdown.ts` | DingTalk md string | A single `\n` is **not** a line break — lines are regrouped into blocks joined by `\n\n`. |
| `plaintext-markdown.ts` | plain text | LINE, QQ, WeCom render nothing; markers are stripped and structure flattened into readable lines. |
| `web-markdown.ts` | escaped HTML | The built-in web UI. The one target that renders everything — tables stay tables. Also the repo's only XSS boundary: it escapes every character of input before building a tag, and passes no raw HTML through, ever. |
| `markdown-tables.ts` | shared | The table→bullets degrade shared by the string-emitting converters. |

**Stream safety is mandatory.** Every converter runs on *every* streaming edit, not just
the final flush. A half-received `**bold` (no closing `**`) must degrade to literal
characters, never to a dangling open marker or an unbalanced tag. The inline parsers
only rewrite a construct once they see its **closing** delimiter; unclosed input
accumulates as escaped literal text. Code fences are tracked so a table-looking line
inside a ``` block is never rewritten, and a GFM table is only rewritten once **both**
its header and its `|---|` separator have arrived.

Send and edit must run the identical converter, or the message flickers between two
renderings between edits.

## `profile-helpers.ts`

Collapses only **identical** decisions across profiles: outbound id extraction,
attachment meta extraction, the thread-less `resolveConversation` shape
(`plainConversation`, shared by lark/qq/line/wecom/dingtalk), button message fragments,
Satori button-interaction mounting, and the CJS-default-import unwrap
(`resolveDefaultPlugin`) that all seven adapters need.

Where platform SDKs genuinely differ — whether a reply carries a quote, `ts` validation
on thread creation — each profile keeps its own. Prefer reusing a helper before
hand-writing, but do not force two different decisions into one helper.

`installHttpService` matters more than it looks: most adapters declare
`static inject = ['http']`, and without the http service provided first, cordis
**silently suspends the plugin** and never instantiates the bot — no bot, no error.

## ⚠️ Slack depends on undocumented internals

`@satorijs/adapter-slack` and `@satorijs/core` are pinned to **exact** versions in
`package.json` (2.5.0 and 4.6.0). This is not caution, it is a load-bearing constraint:

`adapter-slack`'s Socket Mode `WsClient.accept()` handles only `hello` and `events_api`
frames and **completely ignores** `interactive` (block_actions) and `slash_commands` —
neither dispatching nor ACKing them. The adapter exposes no interaction events at all.
So the Slack profile wraps `bot.adapter.accept`, appends its own socket `message`
listener after each open/reconnect, and parses and ACKs those frames itself. It also
reads the underlying socket from two spots that are implementation detail, not API:
`WsClientBase.start()` assigning `this.socket` before calling `accept()`, and the
`WsClient` constructor setting `bot.adapter = this`.

Any minor upgrade may change this **without error**, silently dropping button and slash
reception. Mitigation: frame parse/normalize is extracted into the pure functions
`parseSlackInteractiveFrame` / `parseSlackSlashFrame`, pinned by
`profiles/slack.contract.test.ts`. **Before upgrading either package you must manually
regress Slack button and slash reception — no CI covers the live path.** Interaction
receiving works only in Socket Mode (`protocol: ws`); under `http` the adapter mounts
only the events endpoint.

## Adding a platform

1. Add a schema to `config-schemas.ts` and one arm to the discriminated union.
   Required fields (not wrapped in `optional`/`default`) become **the setup wizard's
   prompts automatically**, using each field's `.describe()` as the label — that is why
   adding a platform needs no wizard change.
2. Write `profiles/<name>.ts` implementing `PlatformProfile`. Declare capabilities
   honestly: an unimplemented optional method means the platform does not support it,
   and core degrades or throws clearly based on the declaration. Overstating a
   capability produces low-level adapter errors in the user's chat.
3. Add one line to `PROFILES` in `platform-factory.ts`.
4. Pick a markdown strategy: reuse `plaintext-markdown.ts` if the platform renders
   nothing; otherwise write a converter documenting the dialect's subset with sources.
5. If the platform's message limit counts something other than characters (UTF-8 bytes,
   post-render length), implement `measureRendered` — otherwise chunks overflow after
   rendering.
6. If inbound media arrives as anything but a public http(s) URL, implement
   `fetchAttachment` — see the section above. A URL the generic downloader cannot fetch
   degrades to a "failed to download" line in the prompt, which reads like a network
   flake rather than a missing adapter method.
7. For button events, follow the decision table in `profile.ts`'s `mountButtonEvents`
   doc, top-down: use `mountSatoriButtonInteraction` if the adapter exposes the generic
   `interaction/button` event; only if it does not, hand-write a socket/internal hook —
   and document the internal behavior you depend on, as Slack does.

Then add a `profiles/<name>.test.ts`. Every existing profile has one; nine of the
module's sixteen test files are profile tests.

None of the above applies to a platform that is not a chat service — one with no bot, no
gateway and no `Session` to normalise. That is a `PlatformAdapter` implemented directly and a
branch in `platform-factory.ts` before `PROFILES`, which is what [`webui/`](webui/README.md)
is. Read its README before writing a second one: the interesting part is not the adapter, it
is the list of things `satori-core.ts` was silently doing for you.
