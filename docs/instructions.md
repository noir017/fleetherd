# Your instructions, for every agent

English | [简体中文](zh-CN/instructions.md)

Write down once how you want to be worked with — *"answer in Chinese, lead with the conclusion"*,
*"propose a plan before deleting anything"* — and every agent reads it: Claude Code, Codex,
OpenCode, Antigravity, CodeBuddy and AtomCode, on this machine and on every
[remote host](remote-hosts.md). The text lives in one directory on the gateway, so moving the
gateway moves it.

```text
<config dir>/instructions/        (~/.config/fleetherd/instructions/)
  common.md      every agent
  claude.md      Claude Code only
  codex.md       Codex only
  …              opencode.md, agy.md, codebuddy.md, atomcode.md, wad.md
```

An agent gets `common.md` followed by its own file. Either may be missing. The per-agent file is
for rules that only make sense for one harness — say, one about its prompt cache that another
agent, billed differently, should not follow.

There is no setting: the directory existing turns it on, and deleting it turns it off.

## How it reaches the agent

Each time an agent starts, the gateway writes the joined text, read-only, to
`~/.fleetherd/instructions/<agent>.md` on the machine the agent runs on, and links the harness's
own user-level instruction file to it:

| agent | its file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Antigravity (agy) | `~/.gemini/config/AGENTS.md` |
| CodeBuddy Code | `~/.codebuddy/CODEBUDDY.md` |
| AtomCode | `~/.atomcode/ATOMCODE.md` |
| web-agent-driver (`wad`, a web agent driven in a browser) | `~/.wad/AGENTS.md` — wad puts it before a new web conversation's first message |

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

## Editing them in the web UI

With the instruction editor turned on, the web UI's settings page ends with an **Instructions**
section for the gateway's files, and a row opens one in the same editor the
[file window](web-ui.md) uses — the same save, and the same check that the file did not change
since you opened it. Each agent's own files are a field on that agent's row under **Agents**.

```yaml
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    instructions:
      enabled: true
```

It is off by default for the file window's reason, one step further: with it on, whoever has the
web UI's login can change what **every** agent reads, on every platform and every host, in
conversations nobody on the page is watching. Turn it on only where the login is as well guarded as
you would want that to be.

**Your files on the gateway.** `common.md` and the file for each kind of agent you have configured
(a file that exists is listed too). Saving one creates the directory if it is not there yet — which
turns the feature on — and places the new text **at once** on every machine an agent that reads it
is configured for; the editor then says where it went. A host that does not answer gets it the next
time an agent starts there. A save that would put any agent over 32 KiB is refused before anything
is written. Sessions already running keep what they read when they started.

**Each agent's own files.** On its own row under **Agents**, an agent whose harness reads instruction
files of its own on its machine — besides the one the gateway places — has an **Instructions** field
that opens the list. These files belong to that machine: they are read and saved where they are, and
the gateway keeps no copy.

| agent | what is listed |
|---|---|
| Claude Code | files `~/.claude/CLAUDE.md` references with `@path` (four levels deep, as Claude Code reads them), and `~/.claude/rules/**/*.md` with what they reference |
| CodeBuddy Code | the same for `~/.codebuddy/CODEBUDDY.md` and `~/.codebuddy/rules/` |
| Antigravity (agy) | `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/rules/**/*.md` (marked when it is not read at start: only a rule whose frontmatter says `trigger: always_on` is), and the files they include with `@[label](path)` — one level |
| OpenCode | the files the `instructions` list in `~/.config/opencode/opencode.json` names (a relative entry is named but not opened: OpenCode looks it up from each conversation's directory) |
| Codex | `~/.codex/AGENTS.override.md`, when there is one — Codex reads it **instead of** `AGENTS.md`, so while it exists the instructions above do not reach Codex |

A reference to a file that is not there yet is listed, and saving it creates the file. The
gateway's own copy, if a reference points at it, is listed but edited above instead. The editor only
ever opens what the agent's harness reads at that moment: it works the list out again on that
machine for every read and save, so taking a reference out closes its file. Every save is logged
with the machine and the file.
