# Your instructions, for every agent

English | [简体中文](zh-CN/instructions.md)

Write down once how you want to be worked with — *"answer in Chinese, lead with the conclusion"*,
*"propose a plan before deleting anything"* — and every agent reads it: Claude Code, Codex,
OpenCode, Antigravity, CodeBuddy and AtomCode, on this machine and on every
[remote host](remote-hosts.md), plus any other harness you point at its own file (below). The text
lives in one directory on the gateway, so moving the gateway moves it.

```text
<config dir>/instructions/        (~/.config/fleetherd/instructions/)
  common.md      every agent
  claude.md      Claude Code only
  codex.md       Codex only
  …              opencode.md, agy.md, codebuddy.md, atomcode.md
  <layer>.md     any other agent, by its instructions.layer (its id by default)
```

An agent gets `common.md` followed by its own file — a [private agent](agents.md#private-agents) its own
file alone. Either may be missing. The per-agent file is
for rules that only make sense for one harness — say, one about its prompt cache that another
agent, billed differently, should not follow.

There is no setting: the directory existing turns it on, and deleting it turns it off.

## An agent the gateway does not know

A `custom` harness's user-level instruction file is not something the gateway can guess. Name it in
the agent's config, and optionally the layer it gets:

```yaml
agents:
  - id: mh
    harness: custom
    command: my-harness
    instructions:
      file: ~/.my-harness/AGENTS.md
      layer: my-harness
```

`file` is on the agent's machine; `~` is resolved against the home that agent runs as (an
`env.HOME` override included), and nothing is placed unless its directory exists. `layer` names the
file beside `common.md` in `<config dir>/instructions/`; unset, it is the agent's id — a pod's agent
uses the id in its `pod.yaml`, without the `@host` the gateway adds. The same block works in
`~/.fleetherd/pod.yaml`. A preset (`claude`, `codex`, …) takes it too, for a harness whose file has
been moved.

Two agents on one machine may share a file only if they share a layer: the link can point at one
`<layer>.md`, so with two layers the file would take turns belonging to each of them and one agent
would read the other's text. Two ordinary `claude` agents are the case this allows — they share
`claude.md`. `common` is not a layer an agent can name, in any case: every agent already gets it.
Paths are compared as written, after `~` is resolved and `..` collapsed — not as files: a path that
reaches the same file through a symbolic link is not recognised as the same one, so keep both
agents' paths spelled the same way.

A clash between two of config.yaml's own agents is refused when the file is loaded (and by
`/reload`, which then keeps the old config running), naming both agents, the file and their layers.
A pod's agents can never stop the gateway: two of one `pod.yaml`'s agents that clash make that file
not apply — the host keeps what was read before, like any other bad line — and a pod agent that
clashes with a config.yaml agent on the same machine stays configured and keeps running, but its
instructions are not delivered: nothing is written and the link there is left alone, and a line in
the daemon log names the file and the agent that already delivers it.

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
| Another harness | the file its agent's `instructions.file` names, with `~` from that agent's home |

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
- **A `custom` command with no `instructions`** — no known file, so nothing. Name one (above) to
  have the gateway place it.

The text is capped at 32 KiB (Codex silently cuts an `AGENTS.md` beyond that); over it, nothing is
delivered and the log says so. Edit the files on the gateway, not the copies on the hosts: those are
read-only and are rewritten at the next start.

## Editing them in the web UI

With the instruction editor turned on, each agent's card under **Agents** on the web UI's
[settings page](settings.md) lists every file that agent reads: the gateway's files it gets, then
its own on its machine. A row opens the agent's whole list in the same editor the
[file window](web-ui.md) uses — the same save, and the same check that the file did not change
since you opened it. There is no list of the gateway's files apart from the agents: `common.md` is
on every card, and the agent's layer file — `claude.md`, or the layer its `instructions` names (its
id by default) — on every card that reads it, each marked with who reads it and how many, because
that is who an edit reaches. A layer that only its own kind reads says *every Claude Code agent*;
when another kind shares it, or one of that kind reads a different layer, it says *the claude layer*
instead — and a file no agent reads says so.

An agent whose delivery is off — a pod's agent whose file another agent on that machine already
delivers with a different layer — says **Not delivering** on its card instead of listing that file
among the ones it gets. Its layer file stays in the list and editable, and **Its own files** still
opens, so the clash can be fixed from the page. If no other agent reads that layer, the file is
listed under **Instructions no agent reads**, like any layer with no reader.

A [`connect` agent](agents.md#an-agent-that-is-already-running-connect) has no instruction file on its machine: `common.md` and `<id>.md`
(without a pod's `@host`) are sent in its `initialize` when each session starts. Its card lists those
two files all the same and counts it among their readers, and a save says it gets the new text with
its next session.

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

**Your files on the gateway.** `common.md` and the agent's layer file — `claude.md`, or the layer
its `instructions` names (its id by default) — listed first as shared. Saving one creates the
directory if it is not there yet — which turns the feature on — and places the new text **at once**
on every machine an agent that reads it is configured for; the editor then says where it went. A
host that does not answer gets it the next time an agent starts there. A save that would put any
agent over 32 KiB is refused before anything is written. Sessions already running keep what they
read when they started.

**A layer whose agent is gone.** Deleting or renaming the last agent that read a layer — a custom
layer, or a preset one like `codex` — leaves its `<layer>.md` in the directory. It stays listed,
once, as **Instructions no agent reads** — under the Agents cards, or at the foot of the page when
there are no agent cards. Open it and save it empty, so a later agent given that layer does not
inherit the old text. The gateway does not delete the file for you. On a case-sensitive filesystem,
a file that differs from a known layer only in case — `Codex.md` beside `codex.md` — is not listed
as an orphan layer either; delete it by hand.

**Each agent's own files.** An agent whose harness reads instruction files of its own on its
machine — besides the one the gateway places — lists them under the shared ones (on the card, as one
**Its own files** row, since listing them reads that machine). These files belong to that machine:
they are read and saved where they are, and the gateway keeps no copy.

| agent | what is listed |
|---|---|
| Claude Code | files `~/.claude/CLAUDE.md` references with `@path` (four levels deep, as Claude Code reads them), and `~/.claude/rules/**/*.md` with what they reference |
| CodeBuddy Code | the same for `~/.codebuddy/CODEBUDDY.md` and `~/.codebuddy/rules/` |
| Antigravity (agy) | `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/rules/**/*.md` (marked when it is not read at start: only a rule whose frontmatter says `trigger: always_on` is), and the files they include with `@[label](path)` — one level |
| OpenCode | the files the `instructions` list in `~/.config/opencode/opencode.json` names (a relative entry is named but not opened: OpenCode looks it up from each conversation's directory) |
| Codex | `~/.codex/AGENTS.override.md`, when there is one — Codex reads it **instead of** `AGENTS.md`, so while it exists the instructions above do not reach Codex |

A reference to a file that is not there yet is listed, and saving it creates the file. The
gateway's own copy, if a reference points at it, is listed but edited in the shared files above it. The editor only
ever opens what the agent's harness reads at that moment: it works the list out again on that
machine for every read and save, so taking a reference out closes its file. Every save is logged
with the machine and the file.
