# Configuration

English | [简体中文](zh-CN/configuration.md)

`~/.config/talkcode/config.yaml`, or `--config <path>`. `talkcode setup` writes a working one;
this page covers what the wizard does not ask about — several agents, routing, more than one
account per platform.

```yaml
version: 1

platforms:                    # named instances; the key is the instance id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk|webui
    token: ${DISCORD_TOKEN}   # every string supports ${VAR}
    chat:
      requireMention: true    # group channels need an @mention
  telegram-bot:               # same type twice = multi-account
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:                       # at least one; routing picks by id
  - id: claude
    harness: claude           # claude|codex|opencode|agy|custom
    cwd: ~/projects/main
  - id: codex
    harness: codex
  - id: ag
    harness: agy               # also the one that can review conversations (see below)
  - id: claude-devbox
    harness: claude
    host: devbox              # runs on another machine — see Remote hosts
    group: build machines     # how /agent groups it (default: its host)

hosts:                        # optional; machines agents run on, reached over ssh
  devbox:
    ssh: me@10.0.0.5:22
    # identityFile: ~/.config/talkcode/ssh/id_ed25519   (default)
    # knownHostsFile: ~/.config/talkcode/ssh/known_hosts (default)

routing:
  default: claude
  pipeline:                   # ordered; first match wins
    - when: { platform: telegram-bot }
      use: { agent: codex }
    - when: { command: codex } # "/codex fix the tests" → codex agent
      use: { agent: codex }

session:
  scope: per_thread           # per_thread|per_channel|per_user|shared
  idleTimeoutMs: 3600000      # stop an idle conversation's agent process after 1h; 0 = never

access:
  allowFrom: ["discord-main:123456"]   # <instanceId>:userId; empty = anyone

review:                       # optional; off unless an agy agent is named
  agent: ag                   # one agy -p on that agent's machine reviews a quiet conversation
  model: gemini-3.8-flash-high
```

`${VAR}` expands from the environment plus a `<configDir>/.env` sidecar, so
the YAML can be committed.

> [!WARNING]
> Agents run with full tool access unless set to
> [`permissions: ask`](agents.md#permission-requests). An empty `access.allowFrom` lets anyone
> who can message the bot run commands on your machine — fill it in any
> shared deployment.

The rest is described where it is used: each harness's options in [Agents](agents.md), the web
UI's `terminal:` and `sso:` in [Web UI](web-ui.md), `title:` in [Topic names](topic-names.md),
`voice:` in [Voice messages](voice.md), `hosts:` with `agents[].host` in
[Remote hosts](remote-hosts.md), `agents[].hooks` in [Agents](agents.md#pre-launch-hook),
`review:` in [Skills](skills.md#auto-review), and `delegation:` in
[Sub-agents](sub-agents.md). A handful of fields can also be changed from chat, without a
restart — see [Settings from chat](settings.md).

## Changing it while the daemon runs

Edit the file, then send `/reload` in any chat. An agent that made the edit can run
`talkcode reload` instead (a reverse command, so only from inside a conversation). The daemon re-reads
`config.yaml` and `.env` and replies with what changed:

```
config.yaml reloaded.
- agents: added oc2; changed cc
- applied: routing
- conversations: 1 restart their agent on the next message
```

- Everything except `platforms` takes effect at once. A `platforms` change (a token, a new
  instance) is reported as needing a daemon restart.
- A changed agent restarts its process on each conversation's next message and resumes the
  session there. A reply already in progress finishes first. An agent whose harness cannot resume a
  session stays on its old definition in conversations that already use it, until `/new`.
- A new `model:` is picked up by new sessions only, as with `/setting`: a resumed session keeps
  the model it was on. `/new` starts one on the new model.
- Conversations bound to a removed agent move to whichever agent routing picks now.
- If the file does not load, nothing changes, and the reply says what is wrong.

## CLI

| Command | |
|---|---|
| `setup` | configuration wizard |
| `doctor` | self-check (default); `--migrate-config` upgrades v0 files |
| `start` | run the daemon |
| `<reverse-command>` | chat actions for the agent — see [Acting in the chat](agent-actions.md#acting-in-the-chat) |

All commands accept `-c, --config <path>` and print structured output to
stdout.
