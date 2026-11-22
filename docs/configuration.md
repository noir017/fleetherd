# Configuration

English | [简体中文](zh-CN/configuration.md)

`~/.config/fleetherd/config.yaml`, or `--config <path>`. `fleetherd setup` writes a working one;
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
    harness: agy               # also reviews quiet conversations (see below)
  - id: claude-devbox
    harness: claude
    host: devbox              # runs on another machine — see Remote hosts
    group: build machines     # how /agent groups it (default: its host)

hosts:                        # optional; machines agents run on, reached over ssh
  devbox:
    ssh: me@192.0.2.5:22
    # identityFile: ~/.config/fleetherd/ssh/id_ed25519   (default)
    # knownHostsFile: ~/.config/fleetherd/ssh/known_hosts (default)

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

review:                       # optional; off unless a reviewer is named
  agent: ag                   # any agent; or api: {url, key, model} for an OpenAI-compatible endpoint
  model: gemini-3.8-flash-high

skills:                       # optional; the managed skills' shared git repository
  repo: ssh://git@git.example:22/you/agent-skills.git

workdir:                      # optional; directory choice menus (/cd, /new)
  sort: name                  # name (alphabetical, default) | frecency (usage-weighted)
```

`${VAR}` expands from the environment plus a `<configDir>/.env` sidecar, so
the YAML can be committed.

> [!WARNING]
> Agents run with full tool access unless given a
> [permission level](agents.md#permission-levels) that asks. An empty `access.allowFrom` lets anyone
> who can message the bot run commands on your machine — fill it in any
> shared deployment.

The rest is described where it is used: each harness's options in [Agents](agents.md), the web
UI's `terminal:` and `sso:` in [Web UI](web-ui.md), `title:` in [Topic names](topic-names.md),
`voice:` in [Voice messages](voice.md), `hosts:` with `agents[].host` in
[Remote hosts](remote-hosts.md), `agents[].hooks` in [Agents](agents.md#pre-launch-hook),
`review:` and `skills:` in [Skills](skills.md), `delegation:` in
[Sub-agents](sub-agents.md), and `mcp:` in [Callers from outside](external-mcp.md). A handful of fields can also be changed from chat, without a
restart — see [Settings from chat](settings.md).

## Changing it while the daemon runs

Edit the file, then send `/reload` in any chat. An agent that made the edit can run
`fleetherd reload` instead (a reverse command, so only from inside a conversation). On POSIX hosts
outside a conversation — scripts, systemd, or the Docker host wrapper (`fleetherd reload`) — send
`SIGHUP` to the daemon (`kill -HUP <pid>` or `docker kill -s HUP fleetherd`). The daemon re-reads
`config.yaml`, `.env`, and remote pods, logs the summary, and (when triggered from chat/CLI) replies
with what changed:

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

All commands accept `-c, --config <path>` before the command (`fleetherd -c <path> start`) and
print structured output to stdout. After the command, `-c` is that command's own: `--channel` for
the chat actions.

## Windows

fleetherd runs natively on Windows (PowerShell or Command Prompt) with **Node.js ≥ 22** for local
agents and all chat platforms / Web UI. For a full POSIX toolchain, **WSL2** is also supported and
behaves like Linux.

### Prerequisites (native Windows)

- **Node.js ≥ 22** on `PATH`.
- **Git for Windows** if you use the Web UI Git panel, per-turn file diffs, or the managed skill
  repository.
- **Windows Developer Mode** (Settings → System → For developers) is optional, but recommended if
  you use [standing instructions](instructions.md): directory skills use NTFS junctions (no elevated
  privileges needed), while instruction files are linked as file symlinks.

### Behavior differences on native Windows

- **IPC transport**: the daemon listens on a per-config-directory Windows named pipe
  (`\\.\pipe\fleetherd-<hash>`) instead of a Unix domain socket. You can still override it via
  `ipc.socketPath`.
- **Reverse CLI shims**: `fleetherd` and `talkcode` shims are provisioned under
  `<configDir>\bin\` as both `.cmd` wrappers (for `cmd.exe` / PowerShell) and POSIX `#!/bin/sh`
  scripts (for Git Bash / MSYS2 subshells).
- **Config reload**: Windows does not use `SIGHUP` for reload; trigger hot reload with `/reload` in
  chat or `fleetherd reload` from inside an agent session.
- **Scheduled shell tasks & `quotaCommand`**: local shell tasks run via `%ComSpec% /d /s /c`
  (Command Prompt) instead of `bash -lc`.

### Known OS boundaries

- **Remote SSH hosts (`hosts:`)**: the gateway itself can run on Windows and connect over OpenSSH
  to Linux remote hosts, but the remote host helper binary (`fleetherd-remote`) targets **Linux
  (amd64 / arm64)** only — a Windows machine cannot act as a `hosts:` remote target.
- **Web UI docked terminal**: the optional `terminal:` panel expects a `ttyd` + `tmux` Unix socket
  bridge (Linux / macOS / WSL2).
- **Antigravity background-wait plugin**: `agy-plugin/wait-background.sh` is a POSIX shell hook; on
  native Windows `agy` still runs, but long background commands will not hold the turn open.
