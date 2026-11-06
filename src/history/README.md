# `src/history/` — the conversation library

Every turn the gateway carries, in `<configDir>/history.db`, so an agent can search what was
said before — in another topic, on another platform, with another agent. The `talkcode
sessions` commands read it (`ipc/commands.ts`), and so does `task-read` for a sub-agent's topic
(`daemon/delegation.ts`); `TurnRunner` writes it through one optional `recordHistory` dep
(`daemon/turn-runner.ts`, enriched in `daemon/conversation.ts`).

The module imports nothing from the rest of the project: it is IO plus pure tokenising, and
its paths are injected. That is what makes it testable without a daemon, and what keeps the
library from reaching into the conversation registry.

## Files

| File | Role |
|---|---|
| `store.ts` | `HistoryStore`: schema, writes, search, read, list, the import ledger |
| `tokenize.ts` | Han bigrams, query terms, FTS expression, excerpts — pure |
| `import-webui.ts` | The one-time fold-in of `webui-transcripts-*` (platform/webui/README.md) |
| `record.ts` | `HistoryEvent` / `HistoryRecorder` — what a turn hands the library |

## The schema

- `sessions` — one per conversation key, with platform, title, agent, host, directory, kind
  and its span. The first `kind` recorded wins: a normal topic a fixed-session scheduled task
  later speaks into stays a normal topic, and the scheduled turn is marked on its rows.
- `turns` — one row per turn:

  | column | meaning |
  |---|---|
  | `id` | what `messages.turn` points at |
  | `session_id` | the conversation it happened in |
  | `seq` | 1-based order within that conversation; what `--turn <n>` and the printed turn number mean |
  | `agent` | the agent that answered it (the binding when it started) |
  | `generation` | the conversation's counter, bumped by `/new` and `/cd`. Tells turns on either side of a reset apart without the harness's own session id, which a fresh session does not have yet |
  | `trigger` | `person` \| `schedule` \| `continue` \| `delegate` \| `update` \| `background` — the sender the daemon put on the batch, or a follow-up burst |
  | `started_at`, `ended_at` | epoch ms. `ended_at` on a `restart` turn is a lower bound: the newest message it wrote |
  | `outcome` | `done` \| `stopped` \| `failed` \| `restart`, or NULL while running |
  | `detail` | why it failed, the whole message the turn was thrown with (bounded at 200k characters); empty otherwise. This is what `task-read --turn <n>` reads when an update card cuts an error — the card names the turn |

- `messages` — one row per prompt (`user`), reply (`agent`) or tool call (`tool`), each with
  the kind of the turn that produced it and `turn` = `turns.id`. A tool row is its line
  (`Bash: git status`) and, when they say more, the call's whole arguments as JSON under it
  (`record.ts` toolText, cut at 100k with a note); the output is not kept. `call` is the harness's
  `toolCallId`: a second write with the same call in the same conversation and turn rewrites that
  row (text and index) instead of adding one, keeping the time the call started. A harness that
  streams arguments re-emits the start on every change (`agent-acp.ts` upgradeToolRow), and before
  this every emission was a row — one CodeBuddy Write was twelve copies. `turn` and `call` are NULL
  on rows imported or written before they existed; a NULL turn reads as "unknown", never as a
  guessed turn.
- `messages_fts` — FTS5 over `tokenize.indexText(text)`, rowid = `messages.id`, `unicode61`.
- `imported` — one row per web UI transcript file already folded in (with how many rows it
  took). `importSession` takes nothing of a conversation the library already has: the import
  runs at startup before anything is recorded, so such a conversation was recorded live, and
  until 2026-11-06 every topic opened after the library existed came back as a second copy at the
  next restart (94 conversations, 10,087 rows on the live gateway). This is what makes the
  import idempotent; the transcript files themselves are rewritten every few seconds and must
  not be re-read into duplicate rows.
- `reviews` — one row per automatic review, keyed by its `review` session, holding what the
  answer did: the reviewed conversation's key, title and lane, the outcome
  (`changed` \| `preferences` \| `refused` \| `proposed` \| `nothing` \| `failed`), each change
  with `applied` / `error` / `revertId`, the preference suggestions, and the changes the shape
  check rejected. `changes`, `preferences` and `invalid` are JSON text. A review recorded before
  this table existed has no row here — its raw answer in `messages` is all there is, and
  `daemon/review-panel.ts` marks what it infers from that as inferred. `recordReview` upserts by
  session, and a failed run writes the row too (with `error`), which is why a failure is visible in
  the web UI's Reviews tab and not only in the log.

### Which turn owns which row

- **A turn's own rows** are the prompt that opened it, every tool line it produced, and the reply
  its render sealed. They are written with the id `startTurn` returned.
- **A mid-turn message** the harness accepted belongs to the running turn when the outcome is
  `joined`: the agent is still working on the same answer. `detached` means the harness had
  already finished the turn and started one of its own; its answer arrives as a background burst,
  so the prompt is written with NO turn rather than into the turn that just ended. A message the
  harness refused is not written there — it becomes the next turn and is recorded then, once.
- **Background output** (a follow-up burst after the reply was sealed) is a turn of its own with
  `trigger: background`, opened when the burst first renders and closed when the runtime seals
  it. Filing it with the turn that asked would place it after that turn's end. The reason the
  runtime gives `close()` decides the outcome: `done` when it finished (a completed result, or
  quiet), `stopped` when `/stop`, a new turn taking the lane, or the child exiting cut it off.
- **A scheduled run** is its own turn (`schedule`), even in a normal topic. The conversation's
  `kind` still comes from its first turn; the trigger and the rows say what this run was.
- **`/new` and `/cd`** bump `generation`. `seq` keeps counting across them: the number identifies
  a turn within the conversation, the generation says which agent session it ran on.
- **A turn the process never finished** (a drain that ran out of time, a crash) is still marked
  running in the file when the next process opens it. The constructor marks every such turn
  `restart` — being one process per config directory is what makes that read unambiguous — and
  leaves its end time at the newest message it wrote.

The `messages.turn` and `messages.call` columns are added by `migrate()` with `ALTER TABLE`,
without a default and without a back-fill (`call` with a partial index on `(session_id, call)`). `turns` is created empty by the same `CREATE TABLE IF NOT EXISTS` block, so
an upgraded file opens without a rewrite and its old rows stay unknown.

## Reading part of a conversation

`read(session, opts)` has three shapes: no filter (the whole conversation), `around` (the old
window), and the filters — `role`, `turn` (`last`/`done`/`<seq>`), `turns` (last n,
capped at 100 with a note only when the cap really dropped turns), `since` (message id,
exclusive), `grep` (text, this conversation only), `tail` (newest n tool lines, only with
`role: 'tool'`) and `limit` (the newest n rows, any role — `task-read`'s default 10). They combine
with AND, except `since` with `turn`/`turns`/`tail`/`limit`: those read from the newest end and
`since` resumes forward from an id, so the combination is refused rather than given one of the two
meanings. `done`
means the newest normally-ended turn of the conversation's CURRENT context, which the daemon
passes as `current(key)` — the live binding and the generation `/new`/`/cd` last set. Inferring
it from the newest turn row is wrong exactly after `/new`: that row is the generation the person
just discarded. A `/new` followed by an agent switch starts a new context, and its "last
completed turn" must not be the previous agent's answer; when nothing has finished there yet the
read is empty with a note saying so. Explicit `turn` numbers and `turns` are not scoped — they
ask for a turn, not for "the last one". A filtered result adds each row's turn number, that
turn's outcome and agent; the unfiltered result keeps its original five fields because
`sessions read <id>` must not change under anyone.

`turnRecord(key, which, current)` is one turn's row without its messages: its number, end time,
outcome, agent and the failure detail. `task-read --turn <n>` shows it — that is where the whole
error of a failed turn is read, because the update card carries only 4,000 characters of it and the
chat's ❌ notice only 300. A conversation with no turns answers `undefined` (nothing has run yet);
a turn number that names no turn still throws.

Direction follows what the filter is for. A turn/tail/turns read is a tail: when the 200k
character budget cuts it, the newest rows are kept and the note says how many older ones went.
A `--since` read is a head — it resumes from a watermark, so the earliest rows after it are kept
and the note names the last id returned, which is the next call's `--since`. It orders by `id`,
not by time, because the cursor is an id and the two are not the same order: a web UI transcript
imported later has new ids and old timestamps, so ordering by (ts, id) while resuming by id
repeats rows on one page and skips them on the next. A role/grep read drops later rows like the
unfiltered read. Both bounds (500 rows, 200k characters) are reported, never silent.

**Folding.** A read that does not choose rows by `role` or `grep` — the unfiltered one and every
turn/since/limit read — turns each run of consecutive tool rows into one row (`ToolRunFolder`): a
single call becomes its first line, a longer run `[37 tool calls: Bash ×20, Edit ×12]`. Tool rows
were 94% of what was recorded on 11-04..06, so an unfolded read was a page of commands and the
500-row bound was spent before the conversation got going. A run breaks at any other row and where
the turn or kind changes. The folded row carries the run's oldest id (`--around` lands on it) and,
internally, its newest (`last_id`, where a `--since` read resumes, so a page never ends inside a
run). Folding cannot let SQL apply the row bound, which counts folded rows, so a folding read
(`foldingScan`) fetches in growing batches — the first sized for the bound, each next one starting
after the last row read (a row-value keyset, not OFFSET) — folds rows as they arrive, and stops once
it holds one folded row more than the bound: every row before that one is closed, so the answer is
the one a whole scan gives. It still reads at most 20k rows, with only the head of each tool row.
Until 2026-11-07 it always read those 20k, and `task-read`'s ten rows of a long topic cost 44 ms
rather than 2. `FOLD_NOTE` is said only when a returned row is folded. `role: 'tool'`, `grep` and `around` are not folded: they ask for the
calls, a match inside one, or a window.

A session row's `messages` count is filled in only by `list`, `read` and `reviewSessions`, the
reads that print it. `sessionOf` leaves it out: the review sweep asks it of every stored
conversation once a minute, for `lastAt` and `kind`, and the count walked each one whole.

WAL, `synchronous = NORMAL`. The file, and its `-wal`/`-shm` companions, are chmod'd `0600`:
this is the same kind of text the harnesses' own session files hold.

## Why the tokenising is in JavaScript

SQLite's `unicode61` tokenizer treats a run of Han characters as one token, so 「跨会话查询」
can never be found by searching 「查询」; `trigram` can, but cannot match a two-character word
(both measured 2026-11-04 on SQLite 3.53.4, the version Node 24 bundles). So a Han run becomes
its overlapping bigrams before it reaches SQLite — `跨会 会话 话查 查询` — and a query is split
the same way, which makes a two-character search word an indexed token. A one-character run has
no bigram; it is indexed as itself and searched with LIKE.

`node:sqlite` is loaded through `createRequire` in `store.ts`, not a static import: Vite (which
runs the tests) strips the `node:` prefix before consulting its builtin list, and Node 24 lists
this module only in the prefixed form. The comment there is the full reason.

## What a review reads

`sessionOf(key)` is one conversation's row without its messages, and `reviewWindow(key, afterId,
maxChars)` is what a review is given: what the person and the agent said after the watermark — no
tool rows — with every message of the person kept first, then the agent's replies newest-first to
the character budget, each message cut to its head and tail at 8k; plus the count of the person's
own messages, the newest id (where the next review starts), and `skillCalls`, the span's tool rows
that name a skills path or the Skill tool, which the review reads for the skills used and written.
Tool rows were 76% of what 42 reviews were given and the person's words 0.6%; replayed without
them, every message the person sent reached the reviewer. Scheduled and sub-agent rows are left
out — they share a topic with a person's conversation but are not what the person said — and
`background` output is kept. The two methods
exist here, rather than as ad-hoc SQL in the daemon, so the "three things since last time" rule is
tested against a real database.

## Recording is best-effort; searching is not

`session`, `message`, `setTitle` and `importSession` swallow a failure into a log line. A full
disk must never fail the turn it was describing — `TurnRunner` guards the call a second time,
for a recorder that throws. `search`, `read` and `list` do throw: a broken search is something
an agent asked for and must be told about.

## Search ordering

`ORDER BY (kind = 'schedule'), bm25(...), ts DESC` — scheduled output after everything else
(the trap Hermes hit: an every-minute task's high-frequency words push real conversations out
of the top), then relevance, then newest. `review` rows are excluded, and so are tool rows unless
`tools` asks for them (`sessions search --tools`): at 94% of the rows, they buried every word the
person and the agent used under the commands that happened to contain it.

## Tests

`tokenize.test.ts` pins the split (two-character words, one-character fallback, English,
mixed). `record.test.ts` pins a tool row's text. `store.test.ts` pins search in each of those
(tool rows only with `tools`), the scheduled ordering, read windows, read filters and their
truncation notes, one row per call and the `call` migration, folding in every read shape (and that
a batched fold reads only as far as it needs, answers exactly as a whole scan, and keeps the 20k
cap), the plans of `list` and the restart sweep, the
review window's order and its skill calls, the turns table (old-file migration, every trigger and
outcome, `restart` on reopen, turn selection), list, `0600`, and a write that fails without
throwing. `import-webui.test.ts` pins the roles, tool lines, kinds, idempotency, and that a topic
recorded live is not imported again.
`daemon/history-record.test.ts` pins what a turn records — including background output as its own
turn and the generation after `/new` — and that a library which throws on every write still
answers. `daemon/turn-trigger.test.ts` pins which sender becomes which trigger.
