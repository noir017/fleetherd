# fleetherd config file reference

Everything the operator can set lives in **one YAML file**. This document mirrors the
validation schema in the source (`src/config/schema.ts`, `src/config/platform-schemas.ts`);
keys not listed here do not exist — the loader rejects unknown or invalid fields with a
per-field error message, so don't invent keys.

## Location & lifecycle

- Active file: `$FLEETHERD_CONFIG_FILE` if set (you inherit the daemon's env, so
  this is the file the daemon loaded); else `$FLEETHERD_CONFIG_DIR/config.yaml`;
  else `~/.config/fleetherd/config.yaml`.
- Every string supports `${VAR}` expansion from the environment, and a `.env` file next
  to the config is loaded first — prefer `token: ${DISCORD_TOKEN}` + `.env` over pasting
  secrets into the YAML.
- After editing: run `fleetherd reload`. It validates first (reporting *all* schema
  errors at once) and applies nothing if the file does not load; otherwise everything
  but `platforms` takes effect at once. A `platforms` change needs the **user** to restart
  the daemon — never restart it yourself (you are its child process).

## Top-level shape

```yaml
version: 1          # literal 1 (v0 single-`platform:` files are auto-migrated;
                    # `fleetherd doctor --migrate-config` rewrites the file)
locale: en          # en (default) | zh-CN (gateway UI, chat menus, notifications, CLI)

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
  idleTimeoutMs: 3600000  # stop idle conversation's agent process after 1h; 0 = never

access:
  allowFrom: []     # identities "<instance-id>:<userId>"; EMPTY = anyone can drive
                    # a full-tool-access agent — fill this in shared deployments

Optional top-level sections (all omitted = off / defaults): `hosts`, `podModels`,
`podPermissions`, `review`, `skills`, `delegation`, `mcp`, `stream`, `display`, `title`,
`voice`, `workdir` (or shorthand `workdirSort`).
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

# Web UI — a built-in browser workbench served by the daemon (multi-topic sidebar,
# themes, i18n, Git changes, optional file editor, terminal, instructions editor, SSO, push).
type: webui
token: <shared secret the login page asks for>   # required
host: 0.0.0.0             # default; 127.0.0.1 keeps it to an SSH tunnel
port: 8787                # default
title: Chat               # default; the browser tab's title
sso:                      # optional: identity-aware proxy JWT auth (Cloudflare Access / Teleport)
  header: Cf-Access-Jwt-Assertion   # default (Teleport: Teleport-Jwt-Assertion)
  cookie: CF_Authorization          # optional fallback cookie (recommended for WS terminal)
  jwksUrl: https://team.cloudflareaccess.com/cdn-cgi/access/certs  # https (or loopback)
  issuer: https://team.cloudflareaccess.com
  audience: <app-aud-tag>
  claim: email            # default (Teleport: username)
  allow: [you@example.com]
  from: ["127.0.0.1"]     # required CIDRs/IPs of the proxy
  password: true          # default; set false once SSO is verified
terminal:                 # optional; off by default (security decision: interactive PTY)
  enabled: false
  socket: /path/to/term.sock        # optional unix socket to ttyd (default: <configDir>/term.sock)
  endCommand: [tmux, -L, web, kill-session, -t, "web-{topic}"]  # argv with {topic}
files:                    # optional; off by default (security decision: remote file writes)
  enabled: false
  roots: [~/projects]     # extra absolute or ~/... directories beyond each topic's cwd
instructions:             # optional; off by default (security decision: global agent instructions)
  enabled: false
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
autoRenameThread: true      # auto-rename thread/topic after the first turn (where supported)
```

DMs always get a response regardless of `requireMention` (frozen behavior).

## `agents[]`

```yaml
- id: claude            # unique; referenced by routing
  harness: claude       # claude | gemini | codex | opencode | dsh | agy | custom
  command: /path/bin    # required when harness: custom (unless connect: is set)
  connect:              # harness: custom only, in place of command (persistent TCP ACP daemon)
    url: tcp://127.0.0.1:9100
    tokenFile: ~/.config/my-agent/token  # optional file read on the agent's machine
    meta: {}                             # optional extra _meta passed on initialize
  args: []              # extra CLI args appended to the harness command
                        # (harness-specific switches go here, e.g. claude's --setting-sources)
  cwd: ~/projects/main  # working dir; empty = auto workspace at ~/.fleetherd/agents/<id>
  model: <model-id>     # best-effort; whether it applies depends on the harness
  instructions:         # optional: custom instruction file path & layer (not allowed with connect)
    file: ~/.my-agent/AGENTS.md
    layer: my-agent     # optional; defaults to agent id (cannot be "common")
  options:              # optional: pinned ACP session config options (strings/numbers/booleans)
    fast: false
  contextWindow: 1000000  # optional: override context-window size (tokens) shown in footer
  contextBudget: 512000   # optional: compaction target in tokens (64000-2000000, agy only)
  env:                  # env vars injected into the agent subprocess; ${VAR} expands
    ANTHROPIC_API_KEY: ${MY_KEY}
  permissions: auto     # plan | ask | edits | auto | full (unset = harness default + auto-approve)
  host: devbox          # runs on hosts.devbox (see `hosts` below); absent = this machine
  group: build boxes    # the label /agent groups it under; default its host
  quotaCommand: ~/bin/pool-quota   # bash -lc on the agent's machine; prints agy's /usage table
  gatewayModels: [gemini-*]        # agy behind AGY_LLM_GATEWAY_URL only: models it is offered (globs)
  hooks:
    preLaunch: docker start my-agent   # bash -lc, run to completion before every spawn
    turnFailed:                        # optional: what happens after a failed turn
      continue:                        # absent = never continue automatically
        on: [service, connection, limit, hung, restart]   # (default) which failures
        message: continue              # (default) sent to the agent as the user's words
        max: 3                         # (default) in a row, 1-10
        backoffMs: 30000               # (default) first wait; doubles, capped at 10 min
      command: notify-me.sh            # bash -lc after every failure; JSON in $FLEETHERD_TURN_FAILURE
```

Notes:
- `harness: claude` with no API key reuses the machine's `claude /login` session.
- `harness: agy` (Google Antigravity CLI) runs as `agy acp`, agy's own ACP server (agy 1.5
  or later). Needs `agy` on PATH (`agy install`) and one interactive sign-in; headless runs
  never prompt. `/model` and `/effort` are answered by the gateway from the session's own
  config options; the names agy's CLI owns (`/usage`, `/credits`, …) run as one-shot processes
  rather than being sent to the session. `args` are appended after `agy acp`.
- `permissions` accepts five levels (`plan`, `ask`, `edits`, `auto`, `full`) and sets both the
  harness session mode and how the daemon answers ACP `session/request_permission`. Unset keeps
  the harness's own mode and auto-approves every request (`access.allowFrom` is the only gate);
  `auto` and `full` also approve. `plan`, `ask`, and `edits` put each request to the user as
  buttons in chat — including scheduled runs — and any request that cannot be shown or goes
  unanswered is declined, never approved. Live-editable via `/setting permissions.<agent>`.
- `quotaCommand` is for an agent whose harness cannot report its quota — agy through a model
  gateway (`AGY_LLM_GATEWAY_URL` in `env`), or anything behind a pooled proxy. It prints one
  tab-separated row per pool (pool, window, remaining %, ISO reset), as `agy -p=/usage` does; the
  status strip reads it beside a turn, at most once a minute, and agy's `/usage` answers with it.
  See docs/agents.md.
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
    ssh: user@192.0.2.5:22022   # the gateway logs in with ~/.config/fleetherd/ssh/id_ed25519
                               # and checks the host against ~/.config/fleetherd/ssh/known_hosts
    # identityFile: ~/.config/fleetherd/ssh/id_ed25519
    # knownHostsFile: ~/.config/fleetherd/ssh/known_hosts
```

Don't add one by hand: `fleetherd pod-add` writes the entry and pins the host key together, and
`fleetherd pods` prints the line the machine needs in its authorized_keys (`fleetherd help pods`).
A host usually declares its own agents in `~/.fleetherd/pod.yaml` on it — the gateway names them
`<id>@<host>` and they are not in this file; edit that file and `fleetherd reload`.
Gateway-side overrides for pod agents live in `podModels` and `podPermissions` (usually managed
via `/setting model.<id>@<host>` and `/setting permissions.<id>@<host>`):

```yaml
podModels:
  claude@devbox: claude-sonnet-4-6
podPermissions:
  claude@devbox: edits
```

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

## Additional optional sections

```yaml
delegation:
  confirm: true            # true (default) | first | false (also /setting delegation)

review:                    # automatic skill review of quiet conversations (set agent OR api)
  agent: ag                # any configured agent id
  model: <model-id>        # optional model override (agent reviewer only)
  args: []                 # optional extra args (custom / gemini / dsh reviewers only)
  # api:                   # alternative to agent: OpenAI-compatible /chat/completions
  #   url: https://api.example.com/v1
  #   key: ${REVIEW_API_KEY}
  #   model: <model-id>

skills:                    # optional shared Git repository for managed skills
  repo: ssh://git@git.example.com:22/you/agent-skills.git
  branch: main             # default
  # identityFile: ~/.config/fleetherd/ssh/id_ed25519
  # knownHostsFile: ~/.config/fleetherd/ssh/known_hosts

mcp:                       # external HTTP MCP entrance (absent = disabled)
  host: 127.0.0.1          # default (loopback only; no TLS)
  port: 8790               # default (cannot collide with any platform port)
  platform: web            # optional webui instance id (default: first webui)
  callers:
    - name: web-agent      # 1-32 chars [a-z0-9_-], starts alphanumeric
      tokenEnv: MCP_TOKEN  # env var NAME (>=24 chars, must differ from webui token)
      tools: [skills, sessions, tasks]
      # trusted: true      # opt-in (default false): unlocks skills writes, tasks send/review,
                           # and tools: schedule | send_file | messages | gateway
      # agents: [claude]   # optional: propose sub-tasks directly in these agents' topics

display:
  header: { enabled: false }
  footer:
    enabled: false
    fields: [agent, context, model, effort]  # subset of agent|model|context|contextPct|effort|cwd
  reactions: { enabled: true }

title:
  llm:                     # optional OpenAI-compatible /chat/completions for topic naming
    baseUrl: https://api.example.com/v1
    apiKey: ${TITLE_API_KEY}
    model: <flash-model>
    timeoutMs: 45000       # default

voice:                     # absent = voice notes handled as plain file attachments
  confirm: true            # default; also /setting voice
  cleanup: true            # default; also /setting cleanup
  vocabulary: [fleetherd]  # domain terms for STT + cleanup
  transcriber:
    format: openai-audio   # gemini (default) | openai-audio
    baseUrl: https://api.groq.com/openai/v1
    apiKey: ${VOICE_STT_KEY}
    model: whisper-large-v3-turbo
    language: en           # optional ISO-639-1 hint (openai-audio only)
    timeoutMs: 90000       # default
  cleaner:                 # optional dedicated text model for voice.cleanup
    format: openai         # openai (default) | gemini
    baseUrl: https://api.example.com/v1
    apiKey: ${VOICE_CLEANER_KEY}
    model: <fast-text-model>
    timeoutMs: 30000       # default

workdir:
  sort: name               # name (default) | frecency (or top-level workdirSort: frecency)
```

## Not configurable (don't add these)

Streaming/edit *throttling* (`charThreshold`, `flushIntervalMs`, backoff), tool-bubble
rendering, inbound merge windows, attachment size limits, lifecycle reaction emojis, turn
timeout, and the IPC socket path are frozen in code (`EXPERIENCE` in `src/config/schema.ts`),
not config surface. If the user asks to tune them, explain it requires a code change, not a
config edit.

Note the split: `stream.enabled` (above) IS config surface — whether to stream at all is the
operator's decision — while the numbers that pace a stream are not.
