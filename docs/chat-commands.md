# Chat commands

English | [简体中文](zh-CN/chat-commands.md)

Registered as native slash commands where the platform supports them (Telegram,
Discord, Slack), and equally usable as plain text everywhere else.

| | |
|---|---|
| `/help` | everything below, for the agent currently answering |
| `/new`, `/clear` | start a fresh conversation (clears context) |
| `/stop` | stop the current turn — or background work reporting in after one — keeping the conversation |
| `/kill` | end the agent process, keeping the conversation — the next message resumes it |
| `/cd` | choose the directory this conversation works in — see [Working directory](working-directory.md) |
| `/agent` | choose which agent answers this topic, by id, grouped by machine — see [Remote hosts](remote-hosts.md#choosing-an-agent-agent) |
| `/title` | name this topic; it is named automatically otherwise — see [Topic names](topic-names.md) |
| `/setting` | change a saved setting in config.yaml — see [Settings from chat](settings.md) |
| `/reload` | apply an edited config.yaml without restarting — see [Configuration](configuration.md#changing-it-while-the-daemon-runs) |
| `/cc`, `/oc`, `/cx`, `/gm`, `/agy` | one per configured harness — see [below](#agent-commands) |
| `/compact`, `/context`, `/model`, `/effort`, `/usage`, `/doctor`, `/mcp`, `/init`, `/review` | a generic vocabulary, translated to each harness's own spelling — see [below](#generic-commands) |
| `/super <job>` | split a job across agents working in parallel — web UI only, see [Sub-agents](sub-agents.md) |

`/usage` and `/context` sent while the agent is in the middle of a turn are answered by the
gateway itself — context, cost so far, how long the turn has run — instead of being passed to the
agent, where they would wait for the whole turn to end. Send them again once it finishes for the
agent's own, fuller answer.

## Sending while the agent works

A message sent while the agent is in the middle of a turn **does not stop it**. Like typing into
Claude Code's own CLI while it works, the message is handed to the agent, which reads it at its
next natural point — after the command it is running finishes, before it decides what to do next —
and answers it as part of the same reply:

```
you    run the full test suite
agent  ⚙ npm test …                  ← still running
you    and check the docs build too   ← the tests keep running
agent  All 2070 tests pass, and the docs build is clean.
```

Not every agent can take a message mid-turn. Where one cannot, the message waits and is sent as
soon as the turn ends — still without stopping anything:

| Harness | A message sent mid-turn |
|---|---|
| `claude` | joins the running turn |
| `codex` | joins the running turn |
| `opencode` | waits for the turn to end |
| `agy` | waits for the turn to end |

Slash commands (`/compact`, …) always wait for the turn to end: a command only runs as one at the
start of a message. To actually stop the agent, use **`/stop`** — it is the only thing that does.
Anything you sent that had not reached the agent yet is dropped with it.

## Agent commands

An **agent command** is named after its harness — `/cc` claude, `/oc` opencode,
`/cx` codex, `/gm` gemini, `/agy` Antigravity. Only the harnesses you configure
are registered. It does two things:

```
/oc fix the failing test    →  answer this conversation with opencode, and ask it
/oc                         →  choose opencode, then ask WHERE (a new conversation),
                               or list opencode's own commands (an ongoing one)
```

The binding is **sticky**: everything after `/oc` keeps going to opencode. And
once that agent has a session in the topic, **the topic keeps it** — naming a
different agent there is refused, with the session id and working directory of
the one that is answering. To carry the work on with another agent, open a new
topic, start it with that agent's command, and hand it the id: it can read the
earlier conversation itself. `/new` clears a topic, after which any agent can
take it. The full harness name (`/opencode`) still works if you type it — it is
just not registered, so it costs no slot in the platform menu.

An agent the harness table cannot name — a second opencode, say, on another
[host](remote-hosts.md) — gets a name of its own from a routing rule:

```yaml
routing:
  pipeline:
    - when: { command: oc2 }
      use: { agent: opencode-devbox }
```

`/oc2` then does for that agent what `/oc` does for the first opencode, and it is
registered too, listed in `/help` by the agent it selects. Only a rule whose one
condition is `command` is registered, and only if it comes before every rule that
matches on something else: the menu is the same in every chat, and an earlier
`when: { platform: … }` rule would answer `/oc2` itself in the chats it covers.

A name whose harness you have **not** configured (`/agy` with no `harness: agy`
agent) is answered with exactly that, and runs no turn — otherwise it reaches
whichever agent is bound still spelled `/agy …`, which reads it as one of its own
slash commands, finds nothing, and replies that a command ran and produced no
output.

The bare form is also how you reach a harness's *own* commands
(`/customize-opencode`, and friends) — once the conversation is under way. They
are deliberately not registered globally: native slash is per-bot while agents
are per-conversation, so a merged menu could neither say who owned an entry nor
route it to them. A harness that reports no command list (`agy`) simply confirms
the switch.

## Generic commands

Generic commands are rewritten to the target harness's native spelling
(`/compact` → gemini's `/compress`), and a harness with no equivalent says so
instead of spending a turn on a prompt it will misread.

Some of them the gateway answers itself where the harness has no command for it,
because the capability is there over the protocol rather than as a slash:
`/context` prints the last usage the agent reported, `/model` shows and switches
the model, and `/effort` shows and switches the reasoning effort.

### `/model`

`/model` alone opens a **paginated button menu** of the models the agent offers,
starting on the page holding the current one; ◀ ▶ turn the page on the same
message, and tapping a model switches it for that conversation. On Discord,
Telegram, Slack and Lark, which is where a message's buttons can be replaced —
elsewhere it prints the same summary line as before. `/model <part of a name>`
switches by substring on every platform, listing the candidates when the query is
ambiguous rather than guessing. Both work on `opencode` and `claude`; neither
advertises a `/model` command, and both expose the selector over ACP.

A `custom` agent — your own ACP program — gets the same menu when its session
declares a `model` option (CodeBuddy does), and otherwise `/model` is passed to it
as typed, as every command to a custom agent is. The first `/model` in a
conversation whose agent has not started yet starts it to find out, which is the
same start the forwarded message would have caused.

The model you pick is remembered for the conversation, not just for the running
agent: it is still in force after `/new`, after `/cd`, after the agent was stopped
for idleness and after a daemon restart — the gateway sets it again on the new
session where the harness would have started on its default. Choosing another agent
for the conversation forgets it, since the next agent's list is a different one.

### `/effort`

`/effort` works the same way on `claude`, `codex` and `opencode`: alone it opens a
menu of the levels with the current one marked (a line of text where buttons
cannot be edited), and `/effort high` — or any unique start of a level, `/effort x`
for `xhigh` — switches it for the conversation from the next message on. The
levels come from the model, not the harness, so they change with `/model`, and a
model can have none: opencode offers them only for models with reasoning variants,
and codex only for models in the installed codex-cli's own catalog (on 0.155.1,
`gpt-6-luna` is not one; 0.156.1 knows it). The reply says which case you are in.
The choice is remembered like the model's: it survives the agent being stopped for
idleness — the gateway re-applies it, since claude and codex come back at their
default level — and `/new`, `/cd` and a daemon restart, until another agent is chosen.
`agy` offers levels only on its Gemini models (none on its stream-json fallback).
