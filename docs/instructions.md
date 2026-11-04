# Your instructions, for every agent

English | [简体中文](zh-CN/instructions.md)

Write down once how you want to be worked with — *"answer in Chinese, lead with the conclusion"*,
*"propose a plan before deleting anything"* — and every agent reads it: Claude Code, Codex,
OpenCode, Antigravity, CodeBuddy and AtomCode, on this machine and on every
[remote host](remote-hosts.md). The text lives in one directory on the gateway, so moving the
gateway moves it.

```text
<config dir>/instructions/        (~/.config/talkcode/instructions/)
  common.md      every agent
  claude.md      Claude Code only
  codex.md       Codex only
  …              opencode.md, agy.md, codebuddy.md, atomcode.md
```

An agent gets `common.md` followed by its own file. Either may be missing. The per-agent file is
for rules that only make sense for one harness — say, one about its prompt cache that another
agent, billed differently, should not follow.

There is no setting: the directory existing turns it on, and deleting it turns it off.

## How it reaches the agent

Each time an agent starts, the gateway writes the joined text, read-only, to
`~/.talkcode/instructions/<agent>.md` on the machine the agent runs on, and links the harness's
own user-level instruction file to it:

| agent | its file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Antigravity (agy) | `~/.gemini/config/AGENTS.md` |
| CodeBuddy Code | `~/.codebuddy/CODEBUDDY.md` |
| AtomCode | `~/.atomcode/ATOMCODE.md` |

The harness reads it the way it reads its own settings — before the conversation, with nothing
added to your messages — and an agent you start from a terminal on that machine reads it too. A
project's own `AGENTS.md` still applies on top, as it always did.

An edit reaches an agent the next time one of its kind starts on that machine; a session already
running keeps what it read when it started.

## What it leaves alone

- **A file you already have there.** If `~/.claude/CLAUDE.md` is a real file, or a link of your
  own to somewhere else, it stays as it is, and the daemon log says that agent does not get the
  instructions. Move what is in it into `claude.md` and delete it; the next start puts the link in.
- **Codex's `AGENTS.override.md`**, which Codex reads instead of `AGENTS.md`.
- **A harness that has never run on that machine** — nothing is created for it.
- **Gemini CLI, DeepSeek Harness and any other `custom` command** — no known file, so nothing.

The text is capped at 32 KiB (Codex silently cuts an `AGENTS.md` beyond that); over it, nothing is
delivered and the log says so. Edit the files on the gateway, not the copies on the hosts: those are
read-only and are rewritten at the next start.
