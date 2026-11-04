<div align="center">

# talkcode

**Your coding agent, in every chat app.**

[![CI](https://github.com/noir017/talkcode/actions/workflows/ci.yml/badge.svg)](https://github.com/noir017/talkcode/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

English | [简体中文](README.zh-CN.md)

</div>

A gateway daemon that connects chat platforms to your coding agent — Claude Code,
Codex, OpenCode (via the [Agent Client Protocol](https://agentclientprotocol.com)),
or Google's Antigravity CLI. Message the bot; the agent runs on your machine and
streams its answer into a single, live-edited message.

Forked from [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere); this project
was called `agent-anywhere` until 2.0.0.

![The built-in web UI: Claude Code finding and fixing a failing test, with its tool calls, its answer, and the context and cost footer](docs/images/webui.png)

<p align="center"><sub>The built-in web UI — no chat platform needed. The same conversation works in Telegram, Discord, Slack, Lark and the rest.</sub></p>

```text
 Discord ───┐
 Telegram ──┤     ┌──────────────────────┐
 Slack ─────┤     │        daemon        │       ┌─► claude
 Lark ──────┤     │  routing · sessions  │◄─────►├─► codex
 QQ ────────┼────►│  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┤                └─ talkcode CLI (send-file / ask / react …)
 Web UI ────┘  (a browser page the daemon serves itself — no bot, no account)
```

## Features

- **Eight platforms, one daemon** — Discord, Telegram, Slack, Lark, QQ, LINE, WeCom, DingTalk; multi-account. [→](docs/platforms.md)
- **Or no platform at all** — the [web UI](docs/web-ui.md) above, behind one shared token or your SSO, with an optional terminal.
- **Any ACP agent, plus agy** — Claude Code, Codex, OpenCode, Antigravity, or `custom`; routed by platform, channel, user or command. [→](docs/agents.md)
- **Native streaming** — in-place edits, live tool-call bubbles, lifecycle reactions.
- **Send while it works** — a message sent mid-turn joins the running turn instead of stopping it, as typing into Claude Code's own CLI does; `/stop` stops. [→](docs/chat-commands.md#sending-while-the-agent-works)
- **Attachments** — images and files you send are downloaded and handed to the agent.
- **Agents on other machines** — an agent can run on any Linux host the gateway reaches over ssh; it keeps working through a dropped connection, and `/agent` picks one by machine. [→](docs/remote-hosts.md)
- **Topics are conversations** — a Telegram or Feishu topic, a Slack or Discord thread, each with its own agent, its own [directory](docs/working-directory.md) and an [automatic name](docs/topic-names.md).
- **Persistent** — conversations survive restarts; `/new`, `/stop`, `/kill`; idle agents are released and resumed on the next message. [→](docs/chat-commands.md)
- **The agent acts in the chat** — sends files, asks with buttons, replies, reacts, reads history. [→](docs/agent-actions.md)
- **Sub-agents, and a list of what needs you** — `/super <job>`: the agent splits a job, hands the parts to other agents that work in parallel in topics nested under it — once you confirm — then checks and reports. The web UI lists what is waiting on you and can notify your phone. [→](docs/sub-agents.md)
- **Failed turns can carry on** — continue automatically after an upstream outage, with your own words, and run a command to alert you. [→](docs/agents.md#when-a-turn-fails)
- **Scheduled tasks** — "every morning at 8, …" becomes a task the gateway keeps, surviving restarts. [→](docs/scheduled-tasks.md)
- **Your instructions, for every agent** — write once how you want to be worked with; every agent on every host reads it, plus a file per agent for what only suits one. [→](docs/instructions.md)
- **Voice messages** — transcribed, shown to you, and sent on once you confirm. [→](docs/voice.md)
- **Small config** — five sections, `${VAR}` and `.env` expansion; [`/setting`](docs/settings.md) edits the fields worth changing from chat.

## Quick start

talkcode is not on npm. Install the tarball attached to the
[latest release](https://github.com/noir017/talkcode/releases/latest), with `X.Y.Z` its version:

```bash
npm install -g https://github.com/noir017/talkcode/releases/download/vX.Y.Z/talkcode-X.Y.Z.tgz

talkcode setup    # wizard: platform, credentials, agent
talkcode doctor   # self-check
talkcode start    # message your bot
```

`harness: claude` reuses this machine's `claude /login` session — no API key
needed for personal use.

<details>
<summary><strong>Or let your agent set it up</strong></summary>

Paste into Claude Code (or any coding agent):

```text
Set up https://github.com/noir017/talkcode for me: install the CLI
from the latest GitHub release's talkcode-X.Y.Z.tgz (npm i -g <its URL>;
it is not on npm), then follow the skill bundled in the installed
package (skill/SKILL.md, under `npm root -g`/talkcode) to configure
and start it.
```

</details>

The smallest useful `~/.config/talkcode/config.yaml` is the web UI and one agent:

```yaml
version: 1
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}       # the password the page asks for; ${VAR} also reads <configDir>/.env
agents:
  - id: claude
    harness: claude
    cwd: ~/projects
routing:
  default: claude
access:
  allowFrom: ["web:owner"]
```

Then open `http://<host>:8787`. Everything else — more platforms, several agents, routing —
is in [Configuration](docs/configuration.md).

> [!WARNING]
> Agents run with full tool access. An empty `access.allowFrom` lets anyone
> who can message the bot run commands on your machine — fill it in any
> shared deployment. The web UI speaks plain HTTP on every interface by default;
> read [Exposing it](docs/web-ui.md#exposing-it) before it leaves a network you control.

## Documentation

| | |
|---|---|
| [Configuration](docs/configuration.md) | config.yaml in full, `${VAR}` and `.env`, the CLI |
| [Agents](docs/agents.md) | the harnesses, what each needs installed, how Antigravity is driven |
| [Platforms](docs/platforms.md) | what each chat platform can and cannot do |
| [Web UI](docs/web-ui.md) | topics, the terminal, exposing it safely, single sign-on |
| [Chat commands](docs/chat-commands.md) | `/new` `/stop` `/kill`, agent commands, `/model`, `/effort` |
| [Remote hosts](docs/remote-hosts.md) | agents on other machines over ssh, `/agent`, what happens when the network drops |
| [Running in a container](docs/docker.md) | the gateway-only image, with every agent on a host |
| [Working directory](docs/working-directory.md) | `/cd`: one topic per project |
| [Topic names](docs/topic-names.md) | `/title` and automatic naming |
| [Settings from chat](docs/settings.md) | `/setting`: editing config.yaml without a restart |
| [Voice messages](docs/voice.md) | transcription and confirmation |
| [Scheduled tasks](docs/scheduled-tasks.md) | prompts and commands on a schedule |
| [Sub-agents](docs/sub-agents.md) | `/super`: split a job across agents working in parallel |
| [Past conversations](docs/conversation-history.md) | `talkcode sessions`: search every conversation the gateway carried |
| [Your instructions](docs/instructions.md) | one set of standing instructions for every agent, plus one per agent |
| [What the agent can do](docs/agent-actions.md) | button questions, sending files, the bundled skill |

## Contributing

[AGENTS.md](AGENTS.md) holds the conventions, layering rules, and security invariants,
plus an index of the per-module docs ([config](src/config/README.md) ·
[core](src/core/README.md) · [platform](src/platform/README.md) ·
[daemon](src/daemon/README.md) · [ipc](src/ipc/README.md) ·
[commands](src/commands/README.md)). Start there before changing code.

## License

[MIT](LICENSE)

This project began as a fork of [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere)
at `3d855f8`, and the original architecture — the platform profile seam in particular — is still
recognisable underneath. It has grown a long way past that point since. The upstream MIT copyright
notice is retained in [LICENSE](LICENSE), which covers both codebases.
