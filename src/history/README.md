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
- `messages` — one row per prompt (`user`), reply (`agent`) or tool call (`tool`), each with
  the kind of the turn that produced it. A tool row is one line: `Bash: git status`.
- `messages_fts` — FTS5 over `tokenize.indexText(text)`, rowid = `messages.id`, `unicode61`.
- `imported` — one row per web UI transcript file already folded in. This is what makes the
  import idempotent; the transcript files themselves are rewritten every few seconds and must
  not be re-read into duplicate rows.

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
mixed). `store.test.ts` pins search in each of those, the scheduled ordering, read windows,
list, `0600`, and a write that fails without throwing. `import-webui.test.ts` pins the roles,
tool lines, kinds and idempotency. `daemon/history-record.test.ts` pins what a turn records
and that a library which throws on every write still answers.
