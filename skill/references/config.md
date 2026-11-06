# talkcode config file reference

Everything the operator can set lives in **one YAML file**. This document mirrors the
validation schema in the source (`src/config/schema.ts`, `src/platform/config-schemas.ts`);
keys not listed here do not exist — the loader rejects unknown or invalid fields with a
per-field error message, so don't invent keys.

## Location & lifecycle

- Active file: `$TALKCODE_CONFIG_FILE` if set (you inherit the daemon's env, so
  this is the file the daemon loaded); else `$TALKCODE_CONFIG_DIR/config.yaml`;
  else `~/.config/talkcode/config.yaml`.
- Every string supports `${VAR}` expansion from the environment, and a `.env` file next
  to the config is loaded first — prefer `token: ${DISCORD_TOKEN}` + `.env` over pasting
  secrets into the YAML.
- After editing: run `talkcode reload`. It validates first (reporting *all* schema
  errors at once) and applies nothing if the file does not load; otherwise everything
  but `platforms` takes effect at once. A `platforms` change needs the **user** to restart
  the daemon — never restart it yourself (you are its child process).

## Top-level shape

```yaml
version: 1          # literal 1 (v0 single-`platform:` files are auto-migrated;
                    # `talkcode doctor --migrate-config` rewrites the file)

platforms:          # map of instance-id -> platform entry; at least one required.
  discord-main:     # id: 1-32 chars [a-z0-9_-], starts alphanumeric. Routing and
    type: discord   #     access.allowFrom reference THIS id, not the type.
    token: ${DISCORD_TOKEN}
  telegram-bot:     # same type twice under different ids = multi-account
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:             # at least one
  - id: claude
    harness: claude
    cwd: ~/projects/main

routing:
  default: claude   # must reference an existing agents[].id
  pipeline: []      # ordered; first fully-matching rule wins

session:
  scope: per_thread    # per_thread | per_channel | per_user | shared

access:
  allowFrom: []     # identities "<instance-id>:<userId>"; EMPTY = anyone can drive
                    # a full-tool-access agent — fill this in shared deployments
```

## `platforms.<id>` — per-platform entries

Discriminated on `type`. Credential fields are required and validated at load.

```yaml
# Discord
type: discord
token: <bot token>
intents: 12345            # optional gateway-intents override; MUST keep MESSAGE_CONTENT
commandGuildId: <guildId> # optional: register slash commands per-guild (instant) vs global (~1h)

# Telegram
type: telegram
token: <bot token from BotFather>

# Slack
type: slack
appToken: xapp-...        # app-level token (Socket Mode)
botToken: xoxb-...        # bot OAuth token (send/reactions)
protocol: ws              # ws = Socket Mode (default, no public URL) | http = Events API
signing: <signing secret> # required when protocol: http

# Lark / Feishu
type: lark
appId: <App ID>
appSecret: <App Secret>
endpoint: feishu          # feishu (cn, default) | lark (global)
protocol: ws              # ws (default) | http (webhook; then selfUrl is required)
# http-only extras: selfUrl, path, encryptKey, verificationToken, verifyToken,
#                   verifySignature, host, port

# QQ
type: qq
appId: <AppID>
secret: <AppSecret>       # the clientSecret, NOT a platform token
botType: public           # public | private (required)
sandbox: false
intents: 12345            # optional; must include INTERACTIONS for button clicks
protocol: websocket       # websocket (default) | webhook

# LINE
type: line
token: <channel access token>
secret: <channel secret>
selfUrl: https://example.com   # required public URL; LINE POSTs to <selfUrl>/line
host: 127.0.0.1                # local listen host (default shown)
port: 8080                     # local listen port (default shown)

# WeCom
type: wecom
corpId: <CorpID>
agentId: <AgentID>
secret: <AppSecret>
token: <callback verification token>
aesKey: <EncodingAESKey>
selfUrl: https://example.com   # required; callback path is <selfUrl>/wecom
host: 127.0.0.1
port: 8080

# DingTalk
type: dingtalk
appkey: <AppKey / Client ID>
secret: <AppSecret / Client Secret>
agentId: 123456           # optional; only resolves the bot's display name/avatar
protocol: ws              # ws = Stream mode (default, no public URL) | http = webhook
# http-only extras: host, port (DingTalk POSTs to <public host>/dingtalk)

# Web UI — a browser page the daemon serves itself. No bot, no account, no upstream
# service. One conversation only: no threads, no room list.
type: webui
token: <shared secret the login page asks for>   # required
host: 0.0.0.0             # default; 127.0.0.1 keeps it to an SSH tunnel
port: 8787                # default
title: Chat               # default; the browser tab's title
# Its identity for access.allowFrom is "<this instance id>:owner".
# It binds every interface and speaks plain HTTP: the token is the only protection.
# Two instances cannot share a host:port — config validation refuses it.
```

### Fields shared by every platform entry

```yaml
chat:                       # response gating for this instance
  channels: []              # listen allowlist; empty = all channels
  requireMention: true      # group channels need an @mention
  freeResponseChannels: []  # channels that respond without a mention
  ignoredChannels: []       # channels fully ignored
  allowBots: none           # respond to other bots: none | mentions | all
slash: true                 # register platform-native slash commands (where supported)
autoThread: off             # off | perTurn (open one thread per turn; thread-capable platforms)
threadAutoArchiveMinutes: 1440  # Discord accepts only 60 | 1440 | 4320 | 10080
```

DMs always get a response regardless of `requireMention` (frozen behavior).

## `agents[]`

```yaml
- id: claude            # unique; referenced by routing
  harness: claude       # claude | gemini | codex | opencode | agy | custom
  command: /path/bin    # required only when harness: custom (any ACP-speaking executable)
  args: []              # extra CLI args appended to the harness command
                        # (harness-specific switches go here, e.g. claude's --setting-sources)
  cwd: ~/projects/main  # working dir; empty = auto workspace at ~/.talkcode/agents/<id>
  model: <model-id>     # best-effort; whether it applies depends on the harness
  env:                  # env vars injected into the agent subprocess; ${VAR} expands
    ANTHROPIC_API_KEY: ${MY_KEY}
  permissions: auto     # auto (default) | ask — see below
  host: devbox          # runs on hosts.devbox (see `hosts` below); absent = this machine
  group: build boxes    # the label /agent groups it under; default its host
  hooks:
    preLaunch: docker start my-agent   # bash -lc, run to completion before every spawn
    turnFailed:                        # optional: what happens after a failed turn
      continue:                        # absent = never continue automatically
        on: [service, connection, limit, hung, restart]   # (default) which failures
        message: continue              # (default) sent to the agent as the user's words
        max: 3                         # (default) in a row, 1-10
        backoffMs: 30000               # (default) first wait; doubles, capped at 10 min
      command: notify-me.sh            # bash -lc after every failure; JSON in $TALKCODE_TURN_FAILURE
```

Notes:
- `harness: claude` with no API key reuses the machine's `claude /login` session.
- `harness: agy` (Google Antigravity CLI) runs as `agy acp`, agy's own ACP server (agy 1.5
  or later). Needs `agy` on PATH (`agy install`) and one interactive sign-in; headless runs
  never prompt. `/model` and `/effort` are answered by the gateway from the session's own
  config options; the names agy's CLI owns (`/usage`, `/credits`, …) run as one-shot processes
  rather than being sent to the session. `args` are appended after `agy acp`.
- `permissions: auto` (the default) approves every tool request the agent asks about, so it
  runs with full tool access and the only gate is `access.allowFrom`. `permissions: ask` puts
  each request to the user as buttons in the chat; one nobody answers within an hour is
  declined, and the agent is told no one answered (not that the user refused). Scheduled runs
  are always approved. Only harnesses that ask at all are affected — Claude Code and `agy` do
  in their default modes; Codex and OpenCode did not ask when measured.
- `hooks.preLaunch` runs before every start of the agent's process; a non-zero exit or 60s
  without finishing fails the turn and the agent is not started. See docs/agents.md.
- `hooks.turnFailed.continue.on` takes: `service`, `limit`, `connection`, `access`, `request`
  (Claude Code's own failure kinds), `provider`, `hung` (silent past the turn timeout),
  `startup`, `preLaunch`, `restart` (the gateway went down mid-turn), `other`. Each continue is
  announced in the chat first; anything the user sends, `/stop`, `/new` or `/kill` calls it off,
  and a turn that ends normally resets the count. See docs/agents.md.

## `hosts` — machines agents run on

```yaml
hosts:
  devbox:
    ssh: user@10.0.0.5:22022   # the gateway logs in with ~/.config/talkcode/ssh/id_ed25519
                               # and checks the host against ~/.config/talkcode/ssh/known_hosts
```

Don't add one by hand: `talkcode pod-add` writes the entry and pins the host key together, and
`talkcode pods` prints the line the machine needs in its authorized_keys (`talkcode help pods`).
A host usually declares its own agents in `~/.talkcode/pod.yaml` on it — the gateway names them
`<id>@<host>` and they are not in this file; edit that file and `talkcode reload`.

## `routing`

First rule in `pipeline` whose `when` conditions **all** match wins; no match falls
through to `routing.default`. Referential integrity is checked at load: `use.agent`
must exist in `agents`, `when.platform` must be an existing platform **instance id**.

```yaml
routing:
  default: claude
  pipeline:
    - when:                     # all provided fields must match; omitted = no constraint
        platform: discord-main  # platform INSTANCE id (the platforms map key)
        serverId: "123"
        channelId: "456"
        userId: "789"
        chat: private           # private (DM) | group | thread
        isBot: false
        command: review         # leading /name of the message text (leading / optional here)
      use:
        agent: codex
        scope: per_user         # optional per-route session-scope override
```

`command` matches the leading `/name` of the message **text**, so it works on every
platform — no native slash-command support needed (native slash invocations arrive as
the same `/name input` text). When a rule matches via `command`, the router consumes
the prefix: the agent receives only the rest (`/cx fix it` → codex gets `fix it`).
Commands matching no rule pass through to the agent untouched (that's how agent-native
commands like `/model` keep working).

A `when.command` rule also **binds** the conversation to that agent: `/cx fix the
tests` routes to codex, and every plain message after it stays with codex until someone
types another `/<agent>`. Config chooses a conversation's *first* agent; the user
chooses it thereafter.

You do **not** need a rule to reach a configured harness by name. Each one already has a
built-in command — `/cc` claude, `/oc` opencode, `/cx` codex, `/gm` gemini, `/agy`
Antigravity (the full harness name is accepted too) — which selects the first configured
agent of that harness. A bare `/oc` binds and then lists that agent's own commands; on a
harness that reports none (`agy`) it just confirms the binding.

A command naming a harness you never configured (`/agy` with no `harness: agy` agent)
is answered with that fact and runs no turn — it would otherwise reach the bound agent
with its `/agy` prefix intact and be swallowed as an unknown command of that agent's own.

Write a `when.command` rule when you want something the built-ins cannot express: an
alias of your own, or pointing a name at a *second* agent of the same harness. A rule
matching on `command` outranks the built-in table.

Switching agents never discards context. Each conversation remembers every agent's own
session separately, so `/codex` → `/claude` → `/codex` resumes codex where it left off.
Only `/new` clears anything, and it clears the whole conversation.

## `session.scope`

What counts as one conversation (i.e. what shares an agent's context):

| value | one conversation per |
|---|---|
| `per_thread` | thread / Telegram topic / Slack thread — plus the channel root, separately (default) |
| `per_channel` | channel, with all its threads folded in |
| `per_user` | user, wherever they write |
| `shared` | whole deployment |

Conversations live for the daemon's lifetime; `/new` (sent in chat) clears one.

State lives in `<configDir>/conversations.json`: per conversation, the bound agent plus
each agent's own session id. A pre-0.3 `sessions.json` is migrated automatically on
first start, so in-flight work survives the upgrade.

## `stream.enabled`

```yaml
stream:
  enabled: false   # default
```

`false` (default): each finished part of a reply is sent as a whole message, split across
several when it exceeds the platform's per-message limit. `true`: the reply is typed out by
editing one message in place as text arrives.

Off is the default because every streaming flush spends a message edit and platforms cap
those per message — Feishu allows 20, then refuses that message permanently — so a long
reply is the one that runs out of edits partway through delivery. Sent-once text has no such
ceiling. Either way the turn is not silent: a finished text segment is sent at every tool
boundary, and tool bubbles refresh in place regardless.

Ignored on platforms that cannot edit messages (QQ, LINE, WeCom, DingTalk). Also settable
from chat with `/setting stream on|off`, which takes effect on the next reply.

## `access.allowFrom`

Identity format `"<platform-instance-id>:<userId>"`, e.g. `"discord-main:325041233"`.
Empty list = unrestricted, and the daemon only warns. Since agents run with full tool
access (Bash, file writes), an empty allowlist in a public channel means anyone there
can execute code on this machine — always fill it for shared deployments.

## Not configurable (don't add these)

Streaming/edit *throttling* (`charThreshold`, `flushIntervalMs`, backoff), tool-bubble
rendering, inbound merge windows, attachment size limits, lifecycle reaction emojis, turn
timeout, and the IPC socket path are frozen in code (`EXPERIENCE` in `src/config/schema.ts`),
not config surface. If the user asks to tune them, explain it requires a code change, not a
config edit.

Note the split: `stream.enabled` (above) IS config surface — whether to stream at all is the
operator's decision — while the numbers that pace a stream are not.
