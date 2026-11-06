# Agents

English | [简体中文](zh-CN/agents.md)

| Harness | Launches | Extra install | Auth |
|---|---|---|---|
| `claude` | bundled [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | none | `claude /login` or `ANTHROPIC_API_KEY` |
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) (`npm i -g`) | Codex CLI's login |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode's login |
| `agy` | `agy acp` | Antigravity CLI 1.5+ | `agy` Google sign-in (OS keyring) |
| `custom` | your `command` + `args` | any ACP executable | your agent's |

Each agent takes `cwd`, `env`, `args`, a best-effort `model`, a
[pre-launch hook](#pre-launch-hook), and a [permission policy](#permission-requests). With
`host:` it runs on another machine, reached over ssh — see [Remote hosts](remote-hosts.md). Sessions
persist where the agent supports it; the commands an agent advertises are
reachable through its own `/<agent>` menu rather than registered globally (see
[Chat commands](chat-commands.md#agent-commands)). `doctor` verifies every configured harness.

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
- The full output of the last 20 runs is kept in `~/.config/talkcode/hooks/<agent-id>/`.
- `${VAR}` is expanded when the config loads, like every other string. Write `$VAR`
  for the shell to expand when the hook runs.

The hook cannot be changed from chat (`/setting`). Doing that would be the same as
running a shell command on your machine from chat.

## When a turn fails

By default a failed turn shows ❌ and the reason, and waits for you. `hooks.turnFailed` can do
more: continue automatically after failures that usually pass on their own, and run a command
to alert you.

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
        command: curl -s -d "$TALKCODE_TURN_FAILURE" https://ntfy.sh/my-topic
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
- `access` and `request` are not in the default list, because continuing does not fix a missing
  sign-in or a request the provider refuses — including a refusal that names no cause.
- `command` runs after every failure, on the agent's own machine, under `bash -lc`. The failure is
  in `$TALKCODE_TURN_FAILURE` as JSON: `agent`, `conversation`, `reason`, `message`, `at` and, when a
  continue was scheduled, `continuing`. It does not affect the turn, and its output is kept in
  `~/.config/talkcode/hooks/<agent-id>/`.
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

## Permission requests

Some agents ask before running a tool: Claude Code does for commands and file edits in its
default mode. By default (`permissions: auto`) the daemon approves every such request, so the
agent runs with full tool access and `access.allowFrom` is the only gate. Set `permissions: ask`
to be asked instead:

```yaml
agents:
  - id: cc
    harness: claude
    permissions: ask
```

- Each request appears in the chat as a message with the command and the agent's own options as
  buttons ("Allow", "Reject", …). Answer by tapping; a typed reply goes to the agent as your next
  message instead.
- Nobody answering within an hour declines the request. The agent is told nobody answered, not
  that you refused, and the turn continues. A reminder is posted after half an hour.
- `/stop` cancels a pending request together with the turn.
- Scheduled runs are always approved: nobody is there to answer.
- A platform without buttons (DingTalk, WeCom) cannot ask, so requests there are declined, again
  with the agent told why.
- Only agents that ask are affected. Codex (mode `agent`) and OpenCode ran a file-writing command
  without asking when measured; `agy` asks before commands, not before writing in its working
  directory, and cannot be set to `ask` on its [stream-json fallback](#falling-back-to-stream-json).

## Antigravity (`agy`)

`agy` runs as `agy acp`, the ACP server agy ships since 1.5, so streaming, tool bubbles,
[permission requests](#permission-requests), multi-turn context, post-restart resume, `/model`,
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
- **Context numbers only after a turn without tools.** agy reports token usage once per turn,
  summed over every model call in it: for a turn of one call that is the context, for a turn that
  ran tools it is not, and the footer then shows none. agy never says how big the window is, so the
  daemon knows it only for the models it was measured on (Gemini, Claude Sonnet/Opus 4.6, GPT-OSS
  120B), or from the agent's `contextWindow`.
- **Quota comes from its CLI**: `agy -p=/usage`, run alongside a turn at most once a minute, in
  whole percentages.
- **agy's own warnings are notices, not reply text.** A retry ("API error (attempt 1) …") is said
  once, as a notice. A turn that ended on a warning — a spent quota, retries run out, an overloaded
  server — fails with it, so `hooks.turnFailed` sees it (as `provider`).
- **A message sent mid-turn waits for the turn to end**: `agy acp` offers no way to join one.
- **Skills** are read from `<cwd>/.agents/skills`, `~/.agents/skills`,
  `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills` and
  `~/.gemini/config/skills`, so `/skills` lists them and `/<name> <request>` runs one.
- **The status line.** On startup the daemon backs `~/.gemini/antigravity-cli/settings.json` up
  once and points its `statusLine` at the daemon's own shim, which draws a status line for your own
  interactive agy (and reports usage on an agy older than 1.4.7 under the fallback below). Set
  `TALKCODE_NO_AGY_STATUSLINE=1` to leave the setting alone.

`args` are passed after `agy acp` (see `agy acp --help`).

### Falling back to stream-json

Until the ACP runtime has run on every host, the previous one is still there: agy driven over its
own [headless stream-json protocol](https://antigravity.google/docs/cli/headless/). Put an agent
back on it through its `env` — in config.yaml, or in a host's `pod.yaml` — and `/reload`:

```yaml
agents:
  - id: agy
    harness: agy
    env:
      TALKCODE_AGY_RUNTIME: stream-json
```

The conversation carries over in both directions: both runtimes resume the same agy conversation.
On stream-json, `permissions: ask` is refused, there is no `/effort`, a `/stop` restarts the child,
context comes from each model step, and pictures go by path only. Its flags (`--model`,
`--conversation`, `--dangerously-skip-permissions`, …) come first and `args` after them; agy's flag
parsing is last-wins.

> [!NOTE]
> Google's FAQ states that accessing Antigravity with third-party tools violates
> its Terms of Service and may lead to account suspension. This harness only
> calls agy's own official interfaces (`agy acp`, or its headless mode on the fallback) and never handles your credentials
> (sign-in stays entirely inside `agy`), but the daemon is still a non-Google
> client driving your account — decide accordingly.
