---
name: fleetherd
description: >-
  Send a file to the user; schedule a prompt or a bash command to run later or repeatedly,
  surviving restarts; post to another chat or topic; read earlier messages in the
  conversation; before grepping harness logs or asking the user to repeat, search earlier
  conversations (every agent, every platform); reply to, edit, react to or delete a message;
  open a thread; ask with buttons; check what a voice message said; read, write and archive
  the skills every agent shares — all through the `fleetherd` command. Also for diagnosing or
  reconfiguring fleetherd itself, and the machines its agents run on.
---

# fleetherd

The `fleetherd` command on your PATH acts on the conversation you are answering in. It is
already authenticated for it, and every command targets it unless `--channel` names another.

If you have `send_file`, `schedule` and `skills` tools, they are the `send-file`, `schedule` and
`skills search` / `skills show` commands below — use the tools.

## Commands, by topic

Before using a topic, run `fleetherd help <topic>`: it prints that topic's commands, their
options and the rules that go with them, generated from the command itself, so it is always
current. `fleetherd help` lists the topics.

| topic | for |
|---|---|
| `files` | sending a file or image to the user |
| `schedule` | a prompt or a bash command that runs later or repeatedly, and survives restarts |
| `channels` | posting to another chat or topic, on any platform |
| `history` | reading earlier messages the user refers to ("the file I sent above") |
| `sessions` | searching every earlier conversation the gateway carried — all agents, all platforms |
| `messages` | an extra message, a quote-reply, editing, reacting, deleting |
| `threads` | opening a thread from a message |
| `ask` | a question with buttons that blocks until answered — only without a question tool of your own |
| `voice` | what a voice message actually said, when one reads like a mishearing |
| `config` | applying an edited config.yaml without a restart |
| `pods` | the machines agents run on: adding or removing one, the agents it declares, ssh between them |
| `skills` | the skills the gateway keeps for every agent: reading one, writing or changing one, archiving |
| `tasks` | handing parts of a job to other agents (sub-agents) that run in parallel — the person confirms starts according to `delegation.confirm` (every time, once per agent per conversation, or never); web UI only |

## Output and errors

Most commands print TOON on stdout, failures included (with exit code 1). `skills show`,
`task-read --reply` and `--turn <n> --full` print a header and then plain text; `ask` prints the
chosen label.

- `unsupported operation: …` — this platform cannot do that (editing, threads and buttons vary).
  Don't retry; fall back to the nearest thing that works, such as a new message instead of an edit.
- `FLEETHERD_TURN_TOKEN is not set` — this shell is not inside a fleetherd session, so
  these commands are unavailable here.
- `cannot reach the daemon` — fleetherd is not running; tell the user.

## Skills for every agent

A managed skill is one the gateway keeps and gives to every agent on every host. When the user
says "remember this as a skill", write it with `fleetherd skills create`; read it with `show`
before changing it — `patch` needs the version `show` printed, so a stale edit is refused rather
than silently undoing a newer one. Keep it about a kind of task, not about this conversation.
`fleetherd help skills` has the rules (names, size, the three file directories) and the history
commands.

## Diagnosing and configuring fleetherd

When the user reports fleetherd itself misbehaving ("Slack stopped responding", "add my
Telegram bot", "why can't you edit messages here?"):

```bash
fleetherd doctor
```

`doctor` is a read-only self-check — config validity, platform credentials, daemon socket, and
whether each agent harness is installed and signed in. Run it first and report what it finds.

- **Config file**: `$FLEETHERD_CONFIG_FILE` if set (you inherit the daemon's environment, so
  this is the file it loaded), else `~/.config/fleetherd/config.yaml`. **Before writing any
  config, read [references/config.md](references/config.md)**: it is the complete field reference,
  and the loader rejects keys that are not in it. Validate with `fleetherd doctor` afterwards.
- **Apply an edit with `fleetherd reload` — never restart the daemon yourself.** Reload applies
  everything except `platforms` at once and prints what changed (`fleetherd help config`). A
  platform change still needs a restart: you are running as a child of that daemon, so stopping it
  ends your own session mid-answer — tell the user to restart it.
- **`fleetherd setup`** is an interactive wizard for a person at a terminal. Don't run it — it
  waits for keyboard input you cannot give. Edit the config file instead.
