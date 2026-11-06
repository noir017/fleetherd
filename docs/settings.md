# Settings from chat (`/setting`)

English | [简体中文](zh-CN/settings.md)

`/setting` edits **config.yaml itself**, so a change outlives the conversation and
the daemon — the counterpart to `/model`, which overrides one conversation until
it is reset. The alternative it replaces is reaching the machine, editing YAML,
and restarting, which stops every resident agent.

| what | in config.yaml | accepts | takes effect |
|---|---|---|---|
| default agent | `routing.default` | any configured agent id | immediately |
| an agent's default model | `agents[].model`, or `podModels` for an agent a host's pod declares | that agent's reported models, any name, or `-` to clear | its next agent session (`/new` starts one) |
| confirm sub-agent starts | `delegation.confirm` | `on`, `first`, `off` (default `on`) | immediately — the next `task-new` in a topic you talk to directly. `first` asks once per agent per conversation and remembers in memory only, so a restart, another conversation, or a change of tier asks again; a sub-agent's topic still confirms every time |
| idle reclaim window | `session.idleTimeoutMs` | `off`, `15m`, `4h`, … | immediately |
| conversation scope | `session.scope` | `per_thread`, `per_channel`, `per_user`, `shared` | after a restart |
| live streaming | `stream.enabled` | `on`, `off` (default `off`) | immediately — the next reply |
| confirm voice transcripts | `voice.confirm` | `on`, `off` (default `on`; only with a `voice:` block) | immediately — the next voice message |
| clean up voice transcripts | `voice.cleanup` | `on`, `off` (default `on`; only with a `voice:` block) | immediately — the next voice message |
| auto review | `review.agent` | `off`, or an `agy` agent id | immediately — the next sweep, within a minute |
| review model | `review.model` | the reviewer's reported models, any name, or `-` to follow the reviewer's own | immediately — the next review |

```
/setting                       →  the whole screen (a settings page in the web UI, buttons elsewhere)
/setting idle                  →  what that one accepts, and its current value
/setting idle 4h               →  set it, on any platform
/setting model.cc opus         →  the model an agent starts its sessions with
```

Where buttons can be posted *and* replaced (Discord, Telegram, Slack, Lark) the
bare form opens a two-level menu — tap a setting, tap a value, and the screen
returns to the list with the new value on it. Everywhere else the same commands
work as text. A long list of models is paged, and a name your harness accepts but
never advertised (`opusplan`) is taken as typed.

In the web UI `/setting` is a settings page: **All settings** in the ⚙ menu at the
foot of the topic list opens it, and typing `/setting` does the same. It is one
column of sections — Agents, Default model, Sub-agents, Conversations, Replies,
Voice, Reviews — and each row is changed in place with the control that fits it:

- **on/off** (sub-agent confirmation, live streaming, the two voice switches) is a
  switch: one tap writes it;
- **a short list** is a segmented control (idle reclaim: off, 15m, 1h, 4h, 12h) or a
  dropdown (default agent, conversation scope), written as soon as you pick;
- **a model** is a row per agent, named by the agent, with its whole model id — or
  *harness default* in grey when none is set. The agent answering the topic you
  opened the page from is marked *this topic*. Tapping a row opens that agent's
  models, with the current one ticked, and a field that filters them as you type
  and takes a name the list does not have (**Use**).

What each change did is said in a banner at the top — saved, already set, or why
it was refused — and a request that never reached the gateway puts the control
back and says so. The page says where these live — config.yaml, every topic —
because none of them is the topic's own: `/model` and `/agent` are how one topic
differs. A change applies at once unless its row says otherwise: the model rows
apply from each agent's next session, and conversation scope is marked *after
restart*. The page is not a message in the transcript: a typed `/setting` stays as
your message, the page does not.

**Any agent's model list, not only the one answering here.** A list comes from a
running session of that agent, so where none is running the gateway starts one just
to ask, then stops it — a second or two, once per agent until it is redefined — and
the screen says *Asking … for its models* meanwhile. An agent whose harness offers
no model choice, or that does not start, says which, and a name can still be typed.

**An agent a host's pod declares** (`<id>@<host>`, see [remote hosts](remote-hosts.md))
is set the same way. Its value is written to `podModels` in the gateway's config.yaml,
over the `model:` in the host's pod.yaml, and the row says whether the value is the
pod's or set here; clearing it goes back to the pod's. Which model a conversation
starts with, from highest: its `/model` → `podModels` → pod.yaml → the harness's
default.

**Auto review** is set here too. `/setting review.agent ag@uniagent` turns it on,
`/setting review.agent off` turns it off, and the row offers only `agy` agents: a
review is one `agy -p` with every tool denied, so any other harness is refused
rather than saved to fail at the next sweep. `/setting review.model` gives reviews
a model of their own; left unset, reviews use the reviewer's own model, which the
row says as *agent's own*. The list offered is that reviewer's, and when it cannot
be obtained the name is taken as typed. Both fields are read from the live config
at the start of every sweep, so a change lands within a minute — no restart. The
reviewer is checked against the agents config.yaml and each host's pod.yaml
actually declare, not only against the running config, so a row left behind by a
failed `/reload` is refused instead of being written into a file the next start
would reject. See [auto review](skills.md#auto-review).

Each answer says **when** the change lands, because they differ: the scope is
written but not applied until a restart, since changing what counts as one
conversation while conversations are open would silently re-identify all of them.

The rest of the file stays hand-edited on purpose, and `/setting` says so by name
rather than pretending the key does not exist. `access.allowFrom` is the one worth
spelling out: one wrong value there locks you out of the very surface you would
use to fix it.

Writes go through the YAML document, so your comments, key order and `${VAR}`
templates survive untouched, and a change is validated against the whole config
before the file is written — `/setting` will not leave you a config.yaml that
fails to load on the next restart.

`/setting` is also where [scheduled tasks](scheduled-tasks.md) are managed.
