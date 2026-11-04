# `src/ipc/` — reverse commands

The channel that lets a running agent act on the chat beyond streaming text: send a
file, react, reply, open a thread, read history, ask a button question.

A reverse command never touches the platform API. It connects **back** to the daemon over
a unix socket, and the daemon resolves "which conversation is this?" from the turn token
and executes on the right adapter.

```
agent (Bash)                                  agent (native tool, via MCP)
  └─ talkcode send-file ./report.pdf      └─ send_file {path: "./report.pdf"}
        │  commands/reverse.ts                        │  commands/mcp.ts (talkcode mcp)
        │    → builds an IpcAction                    │    → ipc/tools.ts → the same spec's build
        └──────────────┬──────────────────────────────┘
                       │  ipc/client.ts → connects, sends {token, action} as one JSON line
                       ▼
    unix socket  (<configDir>/daemon.sock, umask 0o077 + chmod 0600)
        │
        ▼  ipc/server.ts  → parseIpcRequest (zod, strict)
    daemon.resolveChannel(token)  → token → session → activeChannel
    daemon.handleReverse(action, address)    → platform.sendFile(...)
        │
        ▼  {ok: true, data} back as one JSON line → rendered as TOON (stdout, or the tool result)
```

This module imports nothing from the project except `types.ts`.

## Files

| File | Role |
|---|---|
| `commands.ts` | `REVERSE_COMMANDS` — the single source of truth for the command catalog |
| `tools.ts` | `NATIVE_TOOLS` — the commands an agent also gets as native tools, as views of their specs |
| `protocol.ts` | The `IpcAction` union + its zod validation schema |
| `server.ts` | Daemon-side socket server |
| `client.ts` | CLI-side client used by short-lived reverse-command processes |

## `REVERSE_COMMANDS` is the single source of truth

One spec array drives four places, so they cannot drift:

- `cli.ts` registers commander subcommands from it (usage string, options, `build`).
- `talkcode help <topic>` renders each spec's usage and options onto the page its
  `topic` names (see below).
- `tools.ts` builds the native tools from the specs they name: a tool's parameters are the
  command's positionals and options, its parameter descriptions are the option descriptions, and
  its arguments go through the spec's own `build` — a tool call is validated exactly as the same
  command typed into a shell.
- `daemon.ts` `handleReverse` dispatches, with an exhaustive `never` guard.

**Adding a reverse command is two edits**: one arm in the `IpcAction` union
(`protocol.ts`) and one entry in `REVERSE_COMMANDS`, whose `topic` is required — a command
has to say which help page an agent will find it on. CLI registration and the help page
follow automatically, and a missing `handleReverse` arm **fails to compile**.
Do not add a command by hand-registering it in `cli.ts`. (`help` and `mcp` are the commands
registered there by hand: `help` is local and never reaches the daemon, and `mcp` is the tools'
front door rather than a command of its own.)

The catalog: `send-message`, `reply`, `edit-message`, `send-file`, `react`, `delete`,
`fetch-messages`, `create-thread`, `ask`, `voice-log`, `channels`, `sessions`, `schedule`, the
sub-agent `task-*` commands, `reload`, and `pods` / `pod-add` / `pod-remove` (the machines agents
run on, `daemon/pod-admin.ts`).

## What an agent is told: nothing. What it can find

The gateway puts no text of its own into the agent's prompt — no preamble, no reminder (see
"Nothing of the gateway's in the agent's prompt" in [AGENTS.md](../../AGENTS.md)). What an
agent can do here reaches it through its harness's own mechanisms, in three layers:

1. **Two native tools**, `send_file` and `schedule` (`tools.ts`). `talkcode mcp`
   (`commands/mcp.ts`) serves them over MCP on stdio, and the daemon lists that server in every
   ACP session's `session/new` (`daemon/agent-acp.ts` `acpMcpServers`), so the harness starts one
   per session. Same socket, same session token, same TOON answer as the shell command.
2. **The bundled skill** (`skill/SKILL.md`), whose one-line description is the only thing in
   context until an agent needs it. Its body sends the agent to `talkcode help`. The daemon
   links it into the skill directories the harnesses read (`daemon/skill-link.ts`).
3. **`talkcode help <topic>`**, the reference: each topic's commands rendered from the
   specs, plus its `notes` — the rules, the traps, the defaults.

### Why exactly two tools

A tool's definition is context the agent pays for whether or not it is used. Measured 2026-10-09
(`project-scripts/aa-native-tools/probe-tokens.mjs`): on Claude Code these two add about 1,030 input
tokens to every request — cached after the first, but every request; the `<system-reminder>` they
replace was about 80. Codex 0.159.2 lazy-loads MCP tools behind its own `tool_search` and OpenCode
2.0.26 exposes them inside its code tool, so there they cost less. So a tool has to be something an
agent can neither do without nor guess exists:

- `send_file` is the one act a text reply cannot perform: a file has to be uploaded, not
  described.
- `schedule` is the one capability agents reliably get wrong without being told. Asked for "every
  morning at 8", a model reaches for its own harness's scheduler, which lives inside the agent
  process and dies with it — the gateway stops idle sessions after an hour, and on every restart.

The skill documents these two as CLI commands as well, and an agent that does not see the tools up
front takes that route: in the 2026-10-09 end-to-end run, Claude Code called `mcp__chat__send_file`
and `mcp__chat__schedule`, OpenCode called `tools.chat.send_file`, and Codex — whose tool list
starts without them — read the skill and ran `talkcode send-file`. Same command, same result.

The rest stay CLI commands behind the skill:

| Command | Why it is not a tool |
|---|---|
| `send-message`, `reply` | The agent's plain text already streams into the chat. A command to send text is a slower way to do what happens by itself. |
| `edit-message` | The daemon already live-edits the turn's message. |
| `react`, `delete`, `create-thread`, `fetch-messages` | Chat-client chrome, not the work the agent was asked to do. |
| `channels` | Only needed to post somewhere other than here, which is rare and always deliberate. |
| `voice-log` | A confirmed voice transcript reaches the agent as the user's own typed words — the user read and approved them — so advertising that some messages were spoken would only invite second-guessing text that was already checked. It exists for the rare turn where a message reads like a mishearing. |
| `ask` | On `claude` the model asks with its own question tool over ACP `elicitation/create`, rendered as the same buttons. `opencode` and `dsh` have no such tool (probed 2026-09-11: neither sends any reverse request); their models find `ask` through the skill, or ask in prose. |

### The task commands are commands, not tools

`task-agents`, `tasks`, `task-new`, `task-send`, `task-read` and `task-stop` (sub-agents —
daemon/delegation.ts) are reverse commands on the `tasks` help page, found through the skills: the
`talkcode` skill's table, and the `super` skill (`skill-super/`), which is what `/super` loads.
2.18.0 served them as native tools to one dispatcher session (`mcp --dispatch`); with any agent able
to start sub-agents, the same reasoning as above applies — six schemas on every request of every
agent, for the few turns that split a job. They take no `--channel`: each acts from the asking
conversation, on a topic it opened, named as `topic`.

### How it got here

Until 1.40 a `<system-reminder>` went in front of the first turn of every session. It started as
all nine commands with full usage — about 350 tokens of chat-bot operating manual ahead of what
the user asked — was cut to `send-file`, `ask` where needed, and one line pointing at
`talkcode help` (2026-09-11 and 2026-09-30), and was removed on 2026-10-09. The pointer had
worked — asked in plain Chinese to "run this command in two minutes", claude ran `help`, `help
schedule` and a correct `schedule add` — but three lines opening with "your replies reach the user
automatically" still told the model what kind of job this was before it read the job. Any text
the gateway puts there does that; the harness's own tool list and skill list do not.

`CHANNEL_OPTION` (`-c, --channel <id>`) is appended to every command. Empty means "the
current conversation", which is the default an agent should almost always use — the
`--channel` override exists for pushing proactively somewhere else.

Its value is `<channel>` or `<channel>/<thread>`, so an agent can target one topic or
thread rather than only a channel root. `server.ts` parses it through `parseTarget`, which
**validates**: a malformed value fails at the boundary with the input named,
instead of reaching a platform API as a garbled id (Telegram answers those with an opaque
400 far from the cause).

Either form can be **qualified** with a platform instance — `<instance>:<channel>[/<thread>]`,
e.g. `tg:5865716608/8068` — to post on a platform other than the caller's. An address alone
cannot say which platform it is on, so before this every override went to the calling
conversation's own instance, and an agent answering on the web UI had no way to post to
Telegram. The prefix is recognised only when it is a **configured** instance id (the server
is constructed with the set), because channel ids may themselves contain `:`; an unqualified
value means exactly what it always did. `talkcode channels` prints ids in the
qualified form: every place a turn has run, from `conversations.json` (most platforms cannot
enumerate a bot's chats — the Telegram Bot API has no such call), channel roots first, then
the most recent topics. See `core/channel-list.ts`.

## The trust boundary

**The peer is an arbitrary short-lived process and its JSON is untrusted.** The agent
subprocess is what connects, but nothing about the socket guarantees that.

So `server.ts` validates structure at runtime with `parseIpcRequest` before dispatch, and
never casts `as IpcRequest`. A malformed or missing field would otherwise carry
`undefined` all the way down to the platform call layer. The schema uses `.strict()` to
reject extra fields, narrowing the trusted input surface, and each arm maps one-to-one to
an `IpcAction` variant — kept aligned at compile time via `z.infer`.

Optional `channelId` is `z.string().min(1)` rather than plain optional: an empty string is
illegal, not a synonym for unset. It stays a *string* on the wire and is parsed into a
`ConversationAddress` at dispatch — the protocol keeps one textual form, the daemon works
in the domain type.

Other hardening in `server.ts`:

- The socket is created under `umask(0o077)` **before** `listen()`, then chmod'd `0600`.
  The umask is what actually closes the hole — the file is created at `listen()` time
  under the ambient umask, leaving a world-accessible window that a later chmod alone
  cannot prevent. The chmod stays as a fallback for umask residue.
- `MAX_LINE_BYTES` (1 MiB) caps a single request line.
- `IDLE_TIMEOUT_MS` (30 s) drops connections that hang without sending, avoiding fd
  leaks.
- Per-connection `error` handlers, so one bad connection cannot take down the server.

Token comparison happens in `SessionTokenRegistry` (`timingSafeEqual`, see
[`src/daemon/README.md`](../daemon/README.md)), not here — this module delegates both
token validation and channel resolution to the handler.

## Client timeouts

`client.ts` reads the token from `TALKCODE_TURN_TOKEN`, injected by the daemon when
it spawned the agent. A missing token returns a clear structured error rather than
hanging: reverse commands are only meaningful inside a daemon-driven turn.

Timeout precedence is deliberate:

- `TALKCODE_IPC_TIMEOUT_MS` accepts only finite positive numbers. A bad value
  (`NaN`, negative, non-numeric) is **warned about and ignored**, not silently swallowed
  into `undefined` — otherwise a valid `0` and a garbage `NaN` are indistinguishable and
  an operator's misconfiguration gets no feedback.
- Blocking commands pass an explicit larger `timeoutMs`; the effective value is
  `max(env, explicit)`, so a small operator-set env cannot truncate a long wait and make
  the client give up before the daemon does. `ask` relies on this.
- Otherwise: env, or a 10 s default.

## Capability gating in the handler

`daemon.ts` `handleReverse` decides per action how to handle a platform that lacks the
capability. The three outcomes are chosen per action, not uniformly:

- **Degrade** — `reply` on a platform without native replies becomes a plain send. The
  message still reaches the channel with the closest available semantics.
- **Throw a written message** — `edit-message` and `create-thread`. Editing cannot be
  degraded to a fresh send (different message, wrong semantics), so the user gets
  `unsupported operation: …` instead of a low-level adapter stack.
- **Throw rather than return empty** — `ask` on a platform without buttons. Returning
  `{ chosen: null }` would look like "the user declined" and mask the real problem.

If you add an action, pick one of these three and say why in a comment.

## Output format

Reverse commands print **TOON** (`@toon-format/toon`) to **stdout**, never stderr —
stdout is the agent's only data channel. A tool call gets the same text as its result: `commands/reverse.ts`
renders an answer once (`renderResult`) and both front doors print it. `cli.ts` reroutes commander's usage and
validation errors to stdout for the same reason, and the top-level catch emits
`{ error }` structured rather than throwing a stack.

`fetch-messages` truncates each row's content at 500 chars with a `…` marker, keeping a
history dump token-bounded.

## Tests

`protocol.test.ts` — the validation schema, with an enforced coverage threshold
(`vitest.config.ts`) because it is the trust boundary. `tools.test.ts` — that a tool's schema says what its
command accepts and that a call builds the action the shell command would. `server.ts` and `client.ts` are
exercised indirectly through the daemon tests; the socket paths themselves have no
integration harness.
