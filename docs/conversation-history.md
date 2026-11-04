# Past conversations

English | [简体中文](zh-CN/conversation-history.md)

Every turn that goes through the gateway is kept in a local library, so an agent can look up
something that was said in another topic, on another platform, with another agent — days or
weeks later. It is the gateway's own record, not the harness's: the terminal session you start
yourself in Claude Code or OpenCode is not in it.

The library is `<config dir>/history.db`, a SQLite file the gateway creates on first start. It
is `0600`, beside `conversations.json`, and holds the same kind of text the agents' own session
files do.

## What is recorded

One row per fact, in the conversation it belongs to:

- the prompt a turn gave the agent — an attachment is recorded by file name only, never by
  content;
- the agent's reply, in full;
- every tool call, as one line (`Bash: git status`, `Read: src/daemon/turn-runner.ts`).

Work that happens outside a normal exchange is recorded too, with its kind: a scheduled task's
run (`schedule`), a sub-agent's topic or a `[sub-agent updates]` card (`subagent`), and output
an agent reports after its turn (`background`). A conversation takes the kind of its first turn;
the kind of a later turn is kept on that turn's rows.

**A write failure never fails the turn.** If the disk is full or the database cannot be opened,
the gateway logs it and answers as usual; the answer is the thing that matters, the index is
not.

## Turns

Every recorded row belongs to a turn. A turn is one piece of work the gateway gave an agent: the
prompt that opened it (or a mid-turn message merged into it), the tool calls it made, and the
reply it ended with. Each turn also has one row of its own, carrying:

- the agent that answered it, and the conversation's **generation** — a counter `/new` and `/cd`
  bump when they destroy the agent's session, so turns on either side of a reset can be told
  apart;
- when it started and ended;
- what started it: a person's message (`person`), a scheduled run (`schedule`), an automatic
  continue after a failure (`continue`), a task handed to a sub-agent (`delegate`), a
  `[sub-agent updates]` card (`update`), or output the agent reported after its turn
  (`background`);
- how it ended: `done`, `stopped` (`/stop`), `failed`, or `restart` — a turn the gateway never
  finished, found at the next start from the row still marked running. Its end time is then a
  lower bound: the newest message it managed to write.

Who owns which row:

- a message typed while a turn is running and merged into it belongs to **that** turn;
- output an agent reports after its reply was sealed is a turn of its own (`background`):
  filing it with the turn that asked would put words after that turn had ended;
- a scheduled run is a turn of its own (`schedule`), even when it speaks into a normal topic;
- a stopped turn keeps what it had written. The turn ran, and its partial reply is real.

An existing `history.db` is migrated in place: the `turn` column is added and left empty on old
rows, which read as turn `?`, outcome `unknown`. No turn is invented for them.

## Reading part of a conversation

```bash
talkcode sessions read '#12' --turn last
talkcode sessions read '#12' --turn done
talkcode sessions read '#12' --turns 3
talkcode sessions read '#12' --turn 2 --role agent
talkcode sessions read '#12' --since '#87'
talkcode sessions read '#12' --grep 超时
talkcode sessions read '#12' --role tool --tail 20
```

- `--role user|agent|tool` — only rows of that role.
- `--turn last|done|<n>` — the newest turn, the newest turn that ended normally, or turn number
  `n` counted from 1 in that conversation. `--turns <n>` takes the last `n`.
- `--since <message>` — rows after that message id (exclusive), from an earlier read.
- `--grep <text>` — rows containing this text, in this conversation only.
- `--tail <n>` — with `--role tool`, the newest `n` tool lines.

The filters combine (AND). A filtered read prints each row's turn number, that turn's outcome and
the agent that ran it. `--around` cannot be combined with them: it selects a window of its own.
Without any filter the output is exactly what it was before turns existed.

Every read is bounded: 500 rows and 200,000 characters. A read that hits a bound says how many
rows it left out and which end it cut — a tail read keeps the newest rows, an ordinary one keeps
the oldest.

## Searching it

```bash
talkcode sessions search 跨会话查询
talkcode sessions search git status --agent cc --days 30 --limit 20
talkcode sessions read '#12' --around '#87' --window 10
talkcode sessions list --days 7
```

`search` answers with the conversation id, the message id, the date, the title, the agent, the
platform and a matching excerpt. `read` takes the conversation id and prints it oldest first;
`--around <message>` shows a window of `--window` messages on each side (10 by default). `list`
is the recently active conversations.

Search is keyword search (BM25), not embeddings. Two details make it work in Chinese:

- **A run of Han characters is indexed as overlapping two-character words** — 「跨会话查询」
  becomes `跨会 会话 话查 查询`. SQLite's default tokenizer treats the whole run as one token
  and cannot find 「查询」 inside it; its `trigram` mode cannot match a two-character word.
  The split happens in JavaScript on the way in and on the way out, so a two-character search
  word is one of the indexed tokens.
- **A single character falls back to a substring match**, because one character is too common
  for a full-text hit to mean anything.

Scheduled-task output sorts after ordinary conversations, then by relevance, then newest
first — a noisy every-minute task would otherwise bury the conversation someone is looking
for.

## What is imported

The web UI has kept each topic's transcript on disk since 2.13.0
([Web UI](web-ui.md#what-to-expect)). On the first start with a library, those
transcripts are folded in, with their topic titles, so the history does not begin empty. The
import records each file once; a restart does not duplicate anything. Conversations on Telegram,
Discord, Slack and the rest cannot be read back from those platforms, so for them the library
begins the day it is turned on.

## Privacy

The file holds the full text of every prompt and reply, including whatever an agent read out
loud. That is the same sensitivity as the harnesses' own session files, which is why it is
`0600` and why the import and the library live in the gateway's config directory. Deleting
`history.db` deletes the library; the web UI transcripts are untouched, and a later start
imports them again (their once-only marks went with the file).
