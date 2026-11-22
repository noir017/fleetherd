# Callers from outside: the MCP entrance

English | [简体中文](zh-CN/external-mcp.md)

A program outside the gateway — a web agent such as Gemini's, reached through an MCP proxy — can
search your [skills](skills.md), read your [conversation library](conversation-history.md), and
propose [sub-tasks](sub-agents.md) to your agents, through an MCP server the gateway serves over
HTTP. Nothing it proposes starts until you tap Start in the web UI.

It is off until config.yaml has an `mcp:` block.

```yaml
mcp:
  host: 127.0.0.1        # default; keep it on loopback or a private network — there is no TLS
  port: 8790             # default
  # platform: web        # the web UI its topics open in (default: the first webui instance)
  callers:
    - name: gemini                          # shown in its topics and cards
      tokenEnv: FLEETHERD_MCP_GEMINI_TOKEN  # the variable holding its token — never the token
      tools: [skills, tasks, sessions]
      # agents: [gemini-task]               # optional: let this caller attach sub-tasks directly to live topics bound to these agents
      # trusted: true                       # optional (default false): opt-in full trust for operator-controlled callers
```

Put the token in the config directory's `.env` (or the gateway's environment):

```sh
FLEETHERD_MCP_GEMINI_TOKEN=<at least 24 random characters, e.g. openssl rand -hex 32>
```

The caller then talks MCP (Streamable HTTP) to `http://<host>:<port>/mcp` with
`Authorization: Bearer <token>`.

## What a caller can do

Three tools, and only the ones listed for it:

- **`skills`** — `search` and `show`. A caller reads the library; it cannot create, change or
  archive a skill. A skill limited to some hosts or harnesses (`fleetherd-hosts`,
  `fleetherd-harnesses`) does not reach it. Its searches are logged like any agent's, under
  `external:<name>`.
- **`sessions`** — read-only access to the gateway's conversation library (`list`, `search`,
  `read`), opt-in per caller. `read` accepts a conversation `#id`, a full topic key (such as
  `web:main/2e233c24`), or an unambiguous 8-character short topic id, and supports the same read
  filters (`reply: true`, `around` / `window`, `role`, `turn`, `turns`, `since`, `grep`, `tail`,
  `limit`). It never writes or runs a turn.
- **`tasks`** — sub-tasks, one `action` at a time:

  | action | what it does |
  |---|---|
  | `open` | opens a topic of its own in the web UI, named `[<caller>] <title>`; returns its id |
  | `agents` | who can take a sub-task, and the directories each can start in; with `agent`, that one in full — its models, every setting with its values and notes, its permission level, how busy it is (a session of it is started to ask, running no prompt) |
  | `new` | proposes one sub-task in that topic: `topic`, `agent`, `text` (and `cwd`, `title`, `model`, `option` — the agent's own settings as `key=value`, comma-separated, e.g. `account=alice@example.com`) |
  | `list` | with `topic`, its sub-tasks and where each stands; without, the caller's own topics |
  | `status` / `read` / `stop` | one sub-task, by the topic id `list` printed; `read` with `reply: true` is what it concluded |

  There is no way to write into a running sub-task, send a file, or schedule anything.

## In the web UI

The topic the caller opens is yours to watch, and nothing in it runs an agent:

- Every sub-task waits on a card there until you tap **Start** — whatever `/setting delegation`
  says. **Cancel** refuses it; the caller does not read the topic, so a typed reply reaches nobody.
- Each started sub-task gets a topic nested under it, where you can talk to that agent as usual.
- When one ends, fails or asks, a 🔔 line says so in the caller's topic. The caller is not told;
  it checks with `list` and `read`.
- Anything you type there is answered by the gateway, not an agent. `/stop` there stops every
  sub-task under it.
- No agent can write there: messages, files, questions and scheduled tasks aimed at it are
  refused. What appears in it comes from the gateway.

A caller sees and stops only sub-tasks under topics it opened itself, and holds at most 10 topics
at a time — the web UI makes room for a new topic by dropping your oldest unstarred one, and a
caller must not be able to push yours out. Deleting one of its topics frees a place.

When a caller also lists `agents:` (e.g. `agents: [gemini-task]`, matching both `gemini-task` and
`gemini-task@<host>`), a hosted `connect` agent running in a live topic can pass that topic's id
directly to `tasks new` / `list` instead of calling `open`. Proposals still wait on a Start card
and `task-send` remains disabled, while sub-tasks attach under that conversation and notify the
bound agent there when they finish.

## Trusted callers (`trusted: true`)

For an operator-controlled agent behind a private MCP proxy, set `trusted: true` on its `callers` entry:

- **`tasks`**: unlocks `send` (`interrupt` / `forward`), `new` automatic review loops (`reviewBy` / `review` / `rounds`), full `read` filters (`role` / `turns` / `since` / `grep`), and honours `/setting delegation` on `hosted` (`agents:`) topics.
- **`skills`**: unlocks full CRUD and history in place (`create`, `patch`, `write-file`, `remove-file`, `list`, `categories`, `history`, `revert`, `archive`, `restore`, `pin`, `unpin`), including changing `fleetherd-resident`.
- **Additional tools** (permitted in `tools` only when `trusted: true`):
  - `schedule`: full scheduled-task management (`add`, `list`, `show`, `edit`, `pause`, `resume`, `run`, `rm`);
  - `send_file`: upload a file or image into a `topic` or `channel`;
  - `messages`: `channels`, `send`, `reply`, `edit`, `react`, `delete`, `fetch`, `thread`, `ask`, `voice_log`;
  - `gateway`: `pods`, `pod_add`, `pod_remove`, `reload`.

## Revoking a caller

Remove it from `callers` (or its variable from `.env`) and `/reload`: its next call is refused.
Changing `host` or `port` also takes effect on `/reload`.

## Notes

- The web UI's login secret is never a caller's token: a caller whose variable holds it, holds
  fewer than 24 characters, or is unset is refused, and the daemon log says why.
- Requests carrying an `Origin` header are refused — no browser has a reason to call this.
- A caller reads pages and mail nobody vetted, so treat what it proposes as written by whoever
  wrote those: read the card before you tap Start.
