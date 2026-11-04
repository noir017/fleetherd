# `src/history/` — the conversation library

Every turn the gateway carries, in `<configDir>/history.db`, so an agent can search what was
said before — in another topic, on another platform, with another agent. The `talkcode
sessions` commands read it (`ipc/commands.ts`); `TurnRunner` writes it through one optional
`recordHistory` dep (`daemon/turn-runner.ts`, enriched in `daemon/conversation.ts`).

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
  | `detail` | why it failed, capped; empty otherwise |

- `messages` — one row per prompt (`user`), reply (`agent`) or tool call (`tool`), each with
  the kind of the turn that produced it and `turn` = `turns.id`. A tool row is one line:
  `Bash: git status`. `turn` is NULL on rows imported or written before turns existed; they
  read as "unknown", never as a guessed turn.
- `messages_fts` — FTS5 over `tokenize.indexText(text)`, rowid = `messages.id`, `unicode61`.
- `imported` — one row per web UI transcript file already folded in. This is what makes the
  import idempotent; the transcript files themselves are rewritten every few seconds and must
  not be re-read into duplicate rows.

### Which turn owns which row

- **A turn's own rows** are the prompt that opened it, every tool line it produced, and the reply
  its render sealed. They are written with the id `startTurn` returned.
- **A mid-turn message** that the harness accepted (`TurnRunner.steer`) belongs to the running
  turn: the agent is still working on the same answer. A message the harness refused is not
  written there — it becomes the next turn and is recorded then, once.
- **Background output** (a follow-up burst after the reply was sealed) is a turn of its own with
  `trigger: background`, opened when the burst first renders and closed when the runtime seals
  it. Filing it with the turn that asked would place it after that turn's end.
- **A scheduled run** is its own turn (`schedule`), even in a normal topic. The conversation's
  `kind` still comes from its first turn; the trigger and the rows say what this run was.
- **`/new` and `/cd`** bump `generation`. `seq` keeps counting across them: the number identifies
  a turn within the conversation, the generation says which agent session it ran on.
- **A turn the process never finished** (a drain that ran out of time, a crash) is still marked
  running in the file when the next process opens it. The constructor marks every such turn
  `restart` — being one process per config directory is what makes that read unambiguous — and
  leaves its end time at the newest message it wrote.

The `messages.turn` column is added by `migrate()` with `ALTER TABLE`, without a default and
without a back-fill. `turns` is created empty by the same `CREATE TABLE IF NOT EXISTS` block, so
an upgraded file opens without a rewrite and its old rows stay unknown.

## Reading part of a conversation

`read(session, opts)` has three shapes: no filter (the whole conversation, unchanged), `around`
(the old window), and the filters — `role`, `turn` (`last`/`done`/`<seq>`), `turns` (last n),
`since` (message id, exclusive), `grep` (text, this conversation only) and `tail` (newest n tool
lines, only with `role: 'tool'`). They combine with AND. A filtered result adds each row's turn
number, that turn's outcome and agent; the unfiltered result keeps its original five fields
because `sessions read <id>` must not change under anyone.

A turn/tail/since read is a tail: when the 200k character budget cuts it, the newest rows are
kept and the note says how many older ones went. A role/grep read is not, and drops later rows
like the unfiltered read. Both bounds (500 rows, 200k characters) are reported, never silent.

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
maxChars)` is the tail a review is given: rows after the watermark, cut from the oldest end to a
character budget, with the count of the person's own messages and the newest id (where the next
review starts). Scheduled and sub-agent rows are left out — they share a topic with a person's
conversation but are not what the person said — and `background` output is kept. The two methods
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
of the top), then relevance, then newest. `review` rows are excluded, for the review sessions
that will write here later.

## Tests

`tokenize.test.ts` pins the split (two-character words, one-character fallback, English,
mixed). `store.test.ts` pins search in each of those, the scheduled ordering, read windows, read
filters and their truncation notes, the turns table (old-file migration, every trigger and
outcome, `restart` on reopen, turn selection), list, `0600`, and a write that fails without
throwing. `import-webui.test.ts` pins the roles, tool lines, kinds and idempotency.
`daemon/history-record.test.ts` pins what a turn records — including background output as its own
turn and the generation after `/new` — and that a library which throws on every write still
answers. `daemon/turn-trigger.test.ts` pins which sender becomes which trigger.
