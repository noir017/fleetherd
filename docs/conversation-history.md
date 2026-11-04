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
