# Settings from chat (`/setting`)

English | [简体中文](zh-CN/settings.md)

`/setting` edits **config.yaml itself**, so a change outlives the conversation and
the daemon — the counterpart to `/model`, which overrides one conversation until
it is reset. The alternative it replaces is reaching the machine, editing YAML,
and restarting, which stops every resident agent.

| what | in config.yaml | accepts | takes effect |
|---|---|---|---|
| default agent | `routing.default` | any configured agent id | immediately |
| an agent's default model | `agents[].model` | that agent's reported models, any name, or `-` to clear | its next agent session (`/new` starts one) |
| confirm sub-agent starts | `delegation.confirm` | `on`, `off` (default `on`) | immediately — the next `task-new` in a topic you talk to directly; a sub-agent's topic still confirms |
| idle reclaim window | `session.idleTimeoutMs` | `off`, `15m`, `4h`, … | immediately |
| conversation scope | `session.scope` | `per_thread`, `per_channel`, `per_user`, `shared` | after a restart |
| live streaming | `stream.enabled` | `on`, `off` (default `off`) | immediately — the next reply |
| confirm voice transcripts | `voice.confirm` | `on`, `off` (default `on`; only with a `voice:` block) | immediately — the next voice message |
| clean up voice transcripts | `voice.cleanup` | `on`, `off` (default `on`; only with a `voice:` block) | immediately — the next voice message |

```
/setting                       →  the whole screen (a settings page in the web UI, buttons elsewhere)
/setting idle                  →  what that one accepts, and its current value
/setting idle 4h               →  set it, on any platform
/setting model.cc opus         →  the model an agent starts its sessions with
```

Where buttons can be posted *and* replaced (Discord, Telegram, Slack, Lark) the
bare form opens a two-level menu — tap a setting, tap a value, and the screen
returns to the list with the new value on it. In the web UI the same two levels
are a page of its own: **All settings** in the ⚙ menu at the foot of the topic
list opens it, and typing `/setting` does the same. Rows are grouped by what
they decide, each showing its label and its whole current value, and tapping a
row opens its values with the current one marked; Back returns to the list. The
page is bound to the topic it was opened in — the agent and model rows are that
conversation's — and its bar names that topic. It is not a message in the
transcript: what you type stays as your message, the page does not. Everywhere
else the same commands work as text. A long list of models is paged, and a name your harness
accepts but never advertised (`opusplan`) is taken as typed.

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
