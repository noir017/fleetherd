# Agents

English | [简体中文](zh-CN/agents.md)

| Harness | Launches | Extra install | Auth |
|---|---|---|---|
| `claude` | bundled [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | none | `claude /login` or `ANTHROPIC_API_KEY` |
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) (`npm i -g`) | Codex CLI's login |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode's login |
| `agy` | `agy acp` | Antigravity CLI 1.5+ | `agy` Google sign-in (OS keyring), or a [model gateway](#through-a-model-gateway) |
| `custom` | your `command` + `args`, or a [`connect`](#an-agent-that-is-already-running-connect) address | any ACP executable or service | your agent's |

A service that is only an HTTP API needs no harness of its own:
[`fleetherd api-agent`](#http-apis-api-agent) wraps it as an ACP agent you start as `custom`. One
that already speaks ACP over TCP is [connected to](#an-agent-that-is-already-running-connect)
instead of started.

Each agent takes `cwd`, `env`, `args`, a best-effort `model`, pinned
[session options](#pinned-session-options), a [pre-launch hook](#pre-launch-hook), a
[permission level](#permission-levels), a [quota command](#quota-command), a
[private](#private-agents) flag, and — for a harness the gateway does not know —
[its own instruction file](#its-own-instruction-file). With
`host:` it runs on another machine, reached over ssh — see [Remote hosts](remote-hosts.md). Sessions
persist where the agent supports it; the commands an agent advertises are
reachable through its own `/<agent>` menu rather than registered globally (see
[Chat commands](chat-commands.md#agent-commands)). `doctor` verifies every configured harness.

## Pinned session options

`options` sets the agent's own ACP session config options — the ones the chat has no command for,
by the id the harness reports (`context`, `fast`, `mode`). Each is applied when a session starts
and again after a model switch, before the conversation's own `/effort`, so a level chosen in chat
still wins. An id the current model does not offer is skipped with a line in the log, never forced:
the set belongs to the model, and switching model reshapes it.

```yaml
agents:
  - id: cur
    harness: custom
    command: cursor-agent
    args: [acp]
    options:
      context: 500k
      reasoning_effort: xhigh
      fast: false
```

A `custom` agent whose command is named `cursor-agent` is also told that this client can render a
*parameterized* model picker. Cursor's ACP server then reports the model, its context size, its
reasoning effort and its fast mode as separate options instead of one pre-combined variant per
model — which is what makes `/effort` work there, and what `options` above is pinning. With the
plain list, a combination cursor did not pre-combine (500k / extra high / fast off, say) cannot be
chosen at all. The binary has to be named `cursor-agent`; a symlink under another name keeps the
pre-combined list, and the pins above are then skipped with a log line.

## Its own instruction file

`instructions` names the user-level file this agent's harness reads on its machine — the way a
`custom` harness gets the [standing instructions](instructions.md) — and the layer it gets beside
`common.md`:

```yaml
agents:
  - id: mh
    harness: custom
    command: my-harness
    instructions:
      file: ~/.my-harness/AGENTS.md
      layer: my-harness
```

`~` is resolved against the home the agent runs as (`env.HOME` included); `layer` defaults to the
agent's id, and a pod's agent uses its `pod.yaml` id without `@host`. Nothing is placed unless the
file's directory exists. See [Your instructions, for every agent](instructions.md).

## Private agents

A private agent works without anything the other agents share, and leaves nothing behind for them.

```yaml
agents:
  - id: cc-private
    harness: claude
    private: true
    env:
      HOME: /home/me/private-home
    instructions:
      file: ~/.claude/CLAUDE.md
      layer: cc-private
```

- **It is given no skill.** Neither the bundled skills nor the [managed](skills.md) ones are placed
  for it, its `skills` tool is left out, and `fleetherd skills` refuses it.
- **It gets its own instructions alone.** No `common.md`: only its layer — the harness's
  (`claude.md`), or the one `instructions.layer` names, which is how it gets a layer of its own.
- **Nothing shared reads it.** Its sub-tasks, and their reviewers, must be private agents too; the
  [automatic review](skills.md#auto-review) skips its conversations; and `fleetherd sessions` hides
  them from every agent that is not private, and from [external callers](external-mcp.md).

What its harness reads by itself is not the gateway's to withhold: the MCP servers, hooks and skills
installed in the home it runs in — a memory service wired in as a hook and an MCP server, say. So
give it a home of its own with `env.HOME`. Its harness reads its config there, and the gateway
places the agent's files there too. Put in that home only what it should have: its harness's config
without those servers and hooks, and links to what it needs of yours (`~/.gitconfig`, `~/.ssh`).
The gateway warns when it loads a private agent with no `env.HOME`.

A [`connect`](#an-agent-that-is-already-running-connect) agent reads no home here: beside its
instructions it has whatever its own service gives it, so say in its layer what it should not use.

This keeps things from being handed to the agent; it is not a sandbox. The agent still runs as your
user, and with a shell it can read your home and reach any service you can. Keep private work in a
topic of its own, too: the review and `sessions` judge a conversation by the agent that last
answered in it, so switching one topic between a private agent and another mixes the two.

## An agent that is already running (`connect`)

A service that is already running and speaks ACP over TCP — such as web-agent-driver's daemon — is
reached rather than started: `connect` takes the place of `command` on a `custom` agent.

```yaml
agents:
  - id: gemini-task
    harness: custom
    connect:
      url: tcp://wad:7790          # dialled from the agent's machine: this one, or its host
      tokenFile: ~/.wad/token      # optional; read there, sent in initialize _meta
      meta:                        # optional; sent in initialize _meta as written
        wad: { site: gemini-task, profile: main }
    permissions: ask
```

Each session opens its own connection, and it is that session's stdin and stdout: ending the
session (`/kill`, End agent, an idle reclaim) sends the `session/cancel` for a running turn first,
then half-closes the connection. With `host:` (or in a pod's `pod.yaml`) the host's fleetherd-remote
does the dialling, so an address only that machine reaches — a container on its private network —
works, and nothing runs there per session.

The agent is told who it is in `initialize`'s `_meta`: `meta` as written, plus
`fleetherd: { token, host, instructions }` — the contents of `tokenFile`, the name of the agent's
machine, and the [standing instructions](instructions.md) for it (common.md + `<id>.md`, the id
without a pod's `@host`), which a harness would have read from a file of its own. So `command`,
`args`, `env` and `instructions` do not apply; `cwd`, `permissions`, `quotaCommand` and the rest do.
A connect agent cannot run [reviews](sub-agents.md), which need a process of their own.

When the connection drops — the service restarting, a network blip — the turn waits it out rather
than failing: the address is dialled again for up to two minutes (after 1, 2, 4, 8, then every 15
seconds), the session is loaded again, and the turn picks up where the service left it. Nothing is
said for a blip; past 10 seconds one ⚠️ line, and a ✅ once it is back. The message is never sent a
second time on the gateway's own: a service that declares `_meta.fleetherd.promptId` in its
`initialize` gets an id with every prompt, the same for a Resend of it, and takes each prompt once; one
that declares only `reconnectTurn` is picked up once the turn showed reply text, and otherwise fails as
before. Only when the two minutes are over does the turn fail with ❌ and its Reconnect / Resend (or
Retry) buttons. A message whose dial was refused goes out once the service answers.

## Pre-launch hook

`hooks.preLaunch` is a command the daemon runs, and waits for, before every start
of the agent's process: the first message of a conversation, `/new`, and a respawn
after an idle stop or a crash. Use it for whatever has to be in place first:

```yaml
agents:
  - id: boxed
    harness: custom
    command: docker
    args: [exec, -i, my-agent, my-agent, --acp]
    hooks:
      preLaunch: docker start my-agent >/dev/null
```

- It runs under `bash -lc`, in the conversation's working directory, with the
  agent's `env`. It works with every harness, not only `custom`.
- It runs once for every agent process. Each conversation has its own process, so the
  hook runs many times. Make it safe to run again.
- If it exits non-zero, or is still running after 60 seconds, the turn fails with
  the last of its output and the agent is not started. The next message tries again.
- `/stop` while it runs cancels it.
- Anything it leaves running in the background (`ssh -fN`, `cmd &`) keeps running.
  The daemon does not wait for it.
- The full output of the last 20 runs is kept in `~/.config/fleetherd/hooks/<agent-id>/`.
- `${VAR}` is expanded when the config loads, like every other string. Write `$VAR`
  for the shell to expand when the hook runs.

The hook cannot be changed from chat (`/setting`). Doing that would be the same as
running a shell command on your machine from chat.

## When a turn fails

By default a failed turn shows ❌ and the reason, and waits for you. Where the chat can show
buttons, the ❌ carries **Retry**, which sends that turn's messages again (attachments too), and —
with more than one agent configured — **Retry with another agent**, which asks which one first.
Tapping either calls off an automatic continue that is waiting. Another agent takes over the topic
if it has no session yet; otherwise the topic keeps its agent and the messages go to a new topic for
the other one, in the same directory when both run on one machine. The buttons go away once a later
turn runs. WeCom and DingTalk have no buttons: there the ❌ is text only.

If the agent never received the message — its process did not start, or its host could not be
reached — the ❌ says so, and the message is sent again along with whatever starts the next turn:
your next message, an automatic continue, a sub-agent update. Retry sends it instead, never both.
A scheduled run's prompt, the continue message and a slash command are not carried over. None of
this survives a gateway restart.

When an agent's process does not start, the ❌ says which of two things happened: it gave no answer
to `initialize` (check the launch command and the machine), or it answered and then `session/new`
failed or got no answer (the command is fine; look at the model backend, relay or network behind
it). Either quotes the last lines the agent wrote to stderr.

`hooks.turnFailed` can do more: continue automatically after failures that usually pass on their
own, and run a command to alert you.

```yaml
agents:
  - id: cc
    harness: claude
    hooks:
      turnFailed:
        continue:
          on: [service, connection, limit, hung, restart]   # the default
          message: 继续          # sent to the agent as if you typed it (default: continue)
          max: 3                # in a row (default 3)
          backoffMs: 30000      # first wait; doubles each time, at most 10 minutes
        command: curl -s -d "$FLEETHERD_TURN_FAILURE" https://ntfy.sh/my-topic
```

What `on` can name:

| reason | what happened |
|---|---|
| `service`, `limit`, `connection`, `access`, `request` | the model provider failed: an outage, a rate or usage limit, a dropped connection, a sign-in problem, a refused request. Reported by Claude Code, and by a harness that names the cause of a `refusal` |
| `provider` | the model provider failed in a way the agent did not classify |
| `hung` | the agent sent nothing for 10 minutes |
| `startup` | the agent's process could not be started |
| `preLaunch` | the [pre-launch hook](#pre-launch-hook) failed |
| `restart` | the gateway stopped while the turn was running (found when it starts again) |
| `other` | anything else, including every failure of harnesses that report no kind |

- Each continue is announced in the chat first (`↻ … sending "继续" in 30s (1/3)`), then sent as a
  turn of its own. Anything you send meanwhile, `/stop`, `/new` or `/kill` calls it off.
- A turn that ends normally resets the count. After `max` failures in a row the chat says it
  will not continue again, and the topic is listed as failed.
- A `limit` belongs to the agent's account, so the agent's conversations wait for it together:
  when the wait is over one of them is continued first, and the rest go once it gets through (or
  any turn on that agent ends normally). If it hits the limit again the wait doubles. The agent
  gets `max` continues for one limit, not `max` per conversation; when they are used up, every
  conversation waiting on it is left for you. While an agent is over its limit, sub-agent updates
  for a topic it answers wait too — the topic says so once — and are sent when the limit lifts.
  That last part applies even to an agent with no `continue` set.
- `access` and `request` are not in the default list, because continuing does not fix a missing
  sign-in or a request the provider refuses — including a refusal that names no cause.
- `command` runs after every failure, on the agent's own machine, under `bash -lc`. The failure is
  in `$FLEETHERD_TURN_FAILURE` as JSON: `agent`, `conversation`, `reason`, `message`, `at` and, when a
  continue was scheduled, `continuing`. It does not affect the turn, and its output is kept in
  `~/.config/fleetherd/hooks/<agent-id>/`.
- A turn cut off by a restart is said in its topic when the gateway is back (`⚠️ The gateway
  restarted before this turn finished`), whether or not anything continues it.

An ACP agent can also end a turn with `stopReason: refusal` instead of answering — CodeBuddy does
this when its upstream rejects the call, and a model that declines does too. A refusal that names
its cause is always a failed turn, even if the turn had already streamed text or opened a tool: the
provider rejected the turn, and the cause is classified like any provider failure (a quota rejection
is `limit`, so the default list continues it). A refusal with no cause is the model declining: it
fails only when the turn showed nothing, and says `request`; one that already explained itself —
Claude sends its refusal explanation as an ordinary message first — is a normal end, because that
explanation is the answer.

## Permission levels

`permissions` decides how much an agent may do without you. A level sets two things at once: the
session mode its harness runs in, which decides what the harness asks about, and what the gateway
does with what it asks — approve it, or put it to you as buttons in the chat.

| level | the gateway | the harness's mode |
|---|---|---|
| `plan` | asks you | its plan mode: it plans before it acts |
| `ask` | asks you | the mode that asks before edits and commands |
| `edits` | asks you | the mode that takes edits in its working directory and asks before commands |
| `auto` | approves | the mode in which it asks rather than decides on its own |
| `full` | approves | its no-prompt mode: nothing is asked, and no sandbox |

```yaml
agents:
  - id: cx
    harness: codex
    permissions: ask
```

Each harness reports its modes itself, and a level is offered only where the harness has a mode
for it — except `ask`, which a harness reporting no modes at all still gets (footnote 2). Measured
on 2026-11-18:

| harness | `plan` | `ask` | `edits` | `auto` | `full` |
|---|---|---|---|---|---|
| Claude Code (`claude`) | `plan` | `default` | `acceptEdits` | `default` | `bypassPermissions`¹ |
| Codex (`codex`) | — | `read-only` | `workspace-write` | `workspace-write` | `agent-full-access` |
| OpenCode (`opencode`) | `plan` | — | — | `build` | — |
| CodeBuddy (`custom`) | `plan` | `default` | `acceptEdits` | `default` | `bypassPermissions` |
| agy, gemini, dsh | — | —² | — | (unchanged) | — |

¹ Not offered when claude-agent-acp runs as root outside a sandbox: Claude Code refuses it there.
² `ask` is offered to these too, though they report no mode for it. Only the gateway's half
applies: every request the harness does make is put to you, and whatever it does without asking is
not stopped. On agy (1.5.1, measured 2026-11-06) that means it asks before a command and writes
files without asking.

- Leaving `permissions` out is what every agent had before levels existed: every request approved,
  and the harness left in the mode it is in — the mode a running session reports, or the pinned
  `options.mode` when there is none. The row shows the level that adds up to,
  marked unset because nothing is stored: `full` when that mode is `bypassPermissions`,
  `agent-full-access` or CodeBuddy's `fullAccess` (nothing is asked at all), `auto` otherwise —
  the gateway approves what is asked. Setting `auto` explicitly puts the harness in the mode the
  table gives.
- `/setting permissions.<agent> <level>` changes it from chat, or the agent's card on the
  [settings page](settings.md); a pod's agent is written to `podPermissions`. A change applies at
  once: running sessions are switched to the new mode, and the next request is answered the new way.
  The harness can still move its own mode — Claude Code leaves `plan` when you approve its plan —
  and a session that starts again (`/new`, a restart, an idle reclaim) starts in the level's mode.
- `fleetherd api-agent` (`harness: custom`, `args: [api-agent, …]`) is the one agent with a single
  level. It only calls a cloud API, runs nothing on this machine and never sends a permission
  request, so `auto` is the only level it offers; any other is refused with that reason.
- Each request appears in the chat as a message with the command and the agent's own options as
  buttons ("Allow", "Reject", …). An edit or a write also shows what it will change — the diff, or
  the text that goes into the file — so the answer is about the change and not only its name. A
  request to leave plan mode shows the plan itself. Answer by tapping; a typed reply goes to the
  agent as your next message instead.
- Nobody answering within an hour declines the request. The agent is told nobody answered, not
  that you refused, and the turn continues. A reminder is posted after half an hour.
- `/stop` cancels a pending request together with the turn.
- Scheduled runs ask too. They used to be approved, but an agent can schedule its own prompts, so
  one set to ask could have approved itself by asking later.
- A platform without buttons (DingTalk, WeCom) cannot ask, so requests there are declined, again
  with the agent told why.

What each mode does is the harness's, and what was measured on 2026-11-18 in a turn that wrote a
file and ran a command:

- **Codex.** `read-only` and `workspace-write` ask before the edit and the command. Its commands
  run in its own sandbox, and where the sandbox cannot start (a container without user namespaces)
  a command fails unless Codex asks to run it outside — which it does not always do. There `full` is
  the level that runs commands. With no level set Codex stays in its `agent` mode, whose own
  reviewer refused the edit and the command without asking anyone.
- **OpenCode.** Its modes are agents, not permission modes: `build` asks nothing unless
  opencode.json sets `permission` to `ask`, and `plan` only reads.
- **CodeBuddy.** `plan` asks before every action, read-only commands too, and offers to leave plan
  mode on the card.
- **agy.** Its modes are not used. They could not be read on the day (its login had expired), and
  its `default` mode, when last measured, asked before commands but wrote into its working
  directory without asking. That is why `ask` is offered for it and says so: the requests agy does
  make still reach you, and its writes do not wait.

## Quota command

The web UI's status strip shows an agent's usage quota when its harness reports one:

- **agy** through `agy -p=/usage`.
- **claude signed in to a claude.ai subscription** reports its five-hour and weekly windows as it
  spends them — `Claude 5h 73% (1h 30m)`, `Claude wk 40% (2d 3h)`, and `Claude Opus wk` or the
  like for a plan with a per-model weekly limit. It reports a window only when it moves, so the
  strip can be a turn behind.
- **claude behind a relay** (`ANTHROPIC_BASE_URL` in its environment) reports nothing, so the
  gateway asks: from the agent's machine, with the agent's own URL and key
  (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`), a one-token `/v1/messages` to
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` (default `claude-haiku-5-5`), read for the
  `anthropic-ratelimit-unified-*` headers a relay in front of subscription accounts passes on. It
  is sent at a session's first output and when a turn ends, at most every 8–12 minutes (at random)
  — never while the agent is idle, so it cannot open a five-hour window early. A relay that answers
  without those headers is not asked again until the agent is redefined; a failed probe shows
  nothing, is logged once, and backs off from 15 minutes to 2 hours. It needs `bash` and `curl`
  on the agent's machine; the key goes to curl on its standard input, never on a command line.

`quotaCommand` supplies the quota when the harness cannot — agy through a
[model gateway](#through-a-model-gateway), or any agent behind a proxy that pools several accounts —
and replaces whatever the harness reports. It is a `bash -lc` command, run on the agent's machine
with the agent's environment, beside a turn and at most once a minute. It prints what
`agy -p=/usage` prints, one tab-separated row per pool — pool, window, remaining percentage, reset
time:

```
Gemini Models	Five Hour Limit Remaining	54%	2026-11-14T08:13:48Z
Claude	Weekly Limit Remaining	24%	2026-12-02T12:00:00Z
```

A pool is named by its first column: `Gemini …` is Gemini and agy's `Claude and GPT models` is 3P,
as agy names them; any other name is shown as written, so `Claude` and `Claude Opus` are the pools
claude reports by itself. A trailing `(…)` is a note, or with a single word in it the account. A
window is weekly, five-hour, one-hour or daily; a row with another is left out and logged. On agy
the command also answers `/usage`. One that fails or prints nothing leaves the last reading in
place.

```yaml
agents:
  - id: ag
    harness: agy
    quotaCommand: ~/.local/bin/pool-quota

When a proxy pools several accounts with sticky sessions (such as CLIProxyAPI), set
`quotaAccountHeader` so each conversation shows only the account that actually handled its requests
instead of an average across the pool. Have `quotaCommand` print JSON rows with `account` (human
label) and optional `accountKey` (opaque upstream id); the daemon observes the named response header
through a loopback relay without buffering streams and scopes the status strip to that account:

```yaml
agents:
  - id: ag
    harness: agy
    quotaCommand: ~/.local/bin/cpa-antigravity-quota --json
    quotaAccountHeader:
      header: X-CPA-TRACE-ID
      pattern: '^[^-]+-([^-]+)-'
```
```

## Antigravity (`agy`)

`agy` runs as `agy acp`, the ACP server agy ships since 1.5, so streaming, tool bubbles,
[permission requests](#permission-levels), multi-turn context, post-restart resume, `/model`,
`/effort`, `/stop`, skills and the two [native tools](agent-actions.md) work as on the other ACP
harnesses. What differs:

- **Its own slash commands run as separate processes.** `/usage`, `/credits` and the rest of what
  `agy -p /help` lists are answered by agy's CLI, not its session — sent as a message, agy hands
  them to the model as a question. The daemon answers those names with a one-shot
  `agy -p=/<name>` instead.
- **Models are named as `agy acp` names them.** `/model` offers `gemini-3.8-flash`, with its
  thinking level under `/effort` (Gemini only). A model written the older way, as `agy models`
  lists it (`gemini-3.8-flash-high`), still works in `model:` and in a conversation's earlier
  choice: it is split into the model and the level. agy forgets the model when a session is
  reloaded, so the daemon sets it again after every reload.
- **Where the context numbers come from.** From 1.5.8 on, agy reports its context after every model
  call, and the footer follows it. Earlier versions report token usage once per turn, summed over
  every model call in it, which is the context only for a turn of one call. For a turn that ran
  tools the daemon then reads the last call's figure from the session's own transcript
  (`~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl`), on the
  agent's machine, at the end of the turn and every few seconds while it runs; if that file cannot
  be read, such a turn shows none. Either way the footer measures against the point where agy
  *compacts*, well below the window: 256k for Gemini 3.8 Flash (a 1M window, which is what 1.5.8
  reports), 160k for Claude Sonnet/Opus 4.6, 80k for GPT-OSS 120B. A model outside those is shown
  against the window agy reports, and with no numbers where it reports none.
- **Only stdio MCP servers reach its tool list.** `agy acp` takes the servers in `session/new` —
  the gateway's own `chat` among them — and shows the model the stdio ones. An HTTP or SSE server
  sent the same way is accepted and then ignored: agy never connects to it, and its `initialize`
  declares no `mcpCapabilities` at all (probed 2026-11-13 on 1.5.7). agy's own config can hold an
  HTTP server, and its generic `call_mcp_tool` reaches that by name, but the server never appears
  in the model's list — so an agent that must use one has to be told the server and tool names in
  its instructions.
- **Where it compacts can be moved: `contextBudget`.** agy compacts where Google tells it to, per
  model, with the model list it fetches when it starts, at the figures above. Nothing on the
  machine overrides that — not agy's settings, not `AGY_CLI_AUTO_COMPACT_OVERRIDE`. With
  `contextBudget: 900000` the daemon starts agy behind a *relay*: a listener on 127.0.0.1 of the
  agent's machine, which agy is pointed at through `CLOUD_CODE_URL`. It forwards every request as
  it is, the streamed model calls included, and changes one thing: in that model list, each model
  whose window can hold the budget (its window less its output reserve) is told to compact there;
  the others keep Google's figure. An agent that sets its own `CLOUD_CODE_URL` in `env` keeps it —
  the relay forwards there. If the relay cannot be opened the agent starts without one, on Google's
  figure, and the log says why. Measured on agy 1.5.2 (2026-11-07); a Gemini 3.8 Flash context of
  600k was confirmed to work. Every model call then carries a longer context, so quota runs out
  sooner. With both `contextWindow` and `contextBudget` set, `contextWindow` is what the footer
  shows; the relay still moves where agy compacts. Through a [model gateway](#through-a-model-gateway)
  agy fetches no model list from Google, so there is nothing to rewrite: no relay is started, and
  the log says so.

  ```yaml
  agents:
    - id: ag
      harness: agy
      contextBudget: 900000
  ```
- **Quota comes from its CLI**: `agy -p=/usage`, run alongside a turn at most once a minute, in
  whole percentages — or from the agent's [`quotaCommand`](#quota-command) when it has one.
- **agy's own warnings are notices, not reply text.** A retry ("API error (attempt 1) …") is said
  once, as a notice. A turn that ended on a warning — a spent quota, retries run out, an overloaded
  server — fails with it, so `hooks.turnFailed` sees it (as `provider`).
- **A command it puts in the background is waited for.** agy runs a command in the foreground for
  10 seconds at most, then moves it to the background and ends the turn; what it did once the
  command finished never reached the chat, and a step that needed permission stopped it outright.
  The daemon links a plugin into `~/.gemini/config/plugins/fleetherd` whose Stop hook keeps the
  turn open instead, silently, until the command finishes: its result, and whatever agy does next,
  arrive in the same reply. While it waits the turn shows as running and the model is not called.
  After 20 minutes with nothing new the model is let go once — it usually says the task is still
  running — so the daemon does not take the quiet for a hang. `/stop` ends the wait. agy lets a
  hook continue a turn ten times, so a turn whose commands finish more often than that stops
  waiting after the tenth. The hook is added beside your own `~/.gemini/config/hooks.json`, and
  does nothing in an agy you run yourself, which waits for its tasks already.
- **A message sent mid-turn joins it**, as with Claude Code: agy takes it at the next tool
  boundary, or at once while the turn waits for a background command, and one reply answers both.
  To interrupt instead, send `/stop` first; the message you send next starts a fresh turn.
- **Skills** are read from `<cwd>/.agents/skills`, `~/.agents/skills`,
  `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills` and
  `~/.gemini/config/skills`, so `/skills` lists them and `/<name> <request>` runs one.

### Through a model gateway

agy can send its model calls to a Gemini-API gateway instead of Google, with no sign-in: set
`AGY_LLM_GATEWAY_URL` and `AGY_LLM_GATEWAY_API_KEY` in `env` (a gateway on another machine must be
`https`). It then offers whatever the gateway's `/v1beta/models` lists, so a model the gateway adds
is there without an agy update — and it starts a session on the first of them, so pin `model:`. A
model agy already knows is sent without its level suffix (`gemini-3.8-flash` with a thinking level,
for `gemini-3.8-flash-high`), and the gateway has to answer to that name; one it does not know is
sent as listed. `agy -p=/usage` prints nothing (give the agent a [`quotaCommand`](#quota-command)),
`contextBudget` has no effect, and agy compacts where it decides — about 256k for Gemini 3.8 Flash,
whatever window the gateway reports. Measured on agy 1.5.8 (2026-11-14).

agy keeps at most 32 models it does not know and drops the rest. A proxy that lists every model of
every provider it serves, in no fixed order, therefore loses a different half each time — a new
model included. `gatewayModels` narrows the list first: a list of `*`-globs on the model id, kept
by a relay (as for `contextBudget`, a listener on 127.0.0.1 that forwards everything else as it is)
that filters the gateway's model list on its way to agy. A model the gateway adds is offered as soon
as it matches. A filter that would leave nothing is ignored, and the log says so.

```yaml
agents:
  - id: ag
    harness: agy
    model: gemini-3.8-flash-high
    gatewayModels: [gemini-*]
    quotaCommand: ~/.local/bin/pool-quota
    env:
      AGY_LLM_GATEWAY_URL: https://gateway.example
      AGY_LLM_GATEWAY_API_KEY: ${GATEWAY_KEY}
```

`args` are passed after `agy acp` (see `agy acp --help`).

> [!NOTE]
> Google's FAQ states that accessing Antigravity with third-party tools violates
> its Terms of Service and may lead to account suspension. This harness only
> calls agy's own official interface (`agy acp`) and never handles your credentials
> (sign-in stays entirely inside `agy`), but the daemon is still a non-Google
> client driving your account — decide accordingly. A `contextBudget` goes
> further: its relay carries agy's requests, sign-in token included (forwarded,
> never read or kept), and changes what Google's server tells agy. A
> `gatewayModels` relay carries the gateway's key the same way.

## HTTP APIs (`api-agent`)

A service that is only an HTTP API can still be an agent: `fleetherd api-agent <backend>` wraps it
as an ACP agent, and the daemon starts it as a `custom` harness without knowing anything about the
service.

```yaml
agents:
  - id: agapi
    harness: custom
    command: fleetherd
    args: [api-agent, antigravity]      # optional: --models a,b   --max-tokens N
    model: gemini-4-hydrogen
    env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" }
```

- **Two backends**: `antigravity` (below) and `mailbox`, for an agent that can only poll, such as
  Muse — see [Agents that only poll](mailbox.md).
- **Antigravity is the first backend** (Google's Interactions API). Its six models are offered in
  `/model`, with `gemini-4-hydrogen` as the default; Carbon and Argon are labelled "(paid tier)"
  because the free tier answers them with a 429 and an upgrade prompt.
- **What works**: streaming text, the sandbox's code-execution steps as tool rows, `/model`,
  `/stop`, multi-turn context, context across a daemon restart or an idle reclaim, and images.
- **What does not**: local files, the `send_file`/`schedule` tools, MCP, skills, and mid-turn
  steering (a message sent while a turn runs waits for the next one). A non-image attachment
  reaches the model as a local path it cannot read.
- **Failures are written to be read in the chat.** A continuation is declared expired only when
  the API says the previous interaction is gone (a 404 when asked for it); then the session is
  reset and the message says to resend. A 400 about the request itself (a bad model, image or
  input) is reported as it is and the session keeps its state. Hitting the token cap names the cap;
  a 429 carries the upstream message and `retry-after`.
- **`/stop` stops the turn here at once.** The server-side cancel is best-effort: the API only
  accepts it while the interaction is still running.
- **State**: one file per session, `<configDir>/api-agent/antigravity/<sessionId>.json` (0600,
  files unused for seven days are dropped). It holds the interaction and environment ids that make
  the next turn a continuation.
- **`--max-tokens` defaults to 200000.** One turn is a whole agent loop, and the recorded harness
  spends ~5.3k input tokens before it says anything; the API's cap is best-effort and answers
  `status: "incomplete"`.
