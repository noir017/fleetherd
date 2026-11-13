# api-agent

An ACP agent whose backend is an HTTP API. The daemon speaks ACP to it like any other harness;
this module speaks HTTP to the service.

```
fleetherd daemon ──ACP/stdio──► fleetherd api-agent antigravity ──HTTPS──► Interactions API
fleetherd daemon ──ACP/stdio──► fleetherd api-agent mailbox     ──HTTPS──► agent-mailbox relay ◄── Muse
```

The daemon is unchanged. config.yaml names the process under `harness: custom`:

```yaml
agents:
  - id: agapi
    harness: custom
    command: fleetherd
    args: [api-agent, antigravity]        # optional: --models a,b  --max-tokens N
    model: gemini-4-hydrogen
    env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" }
```

It runs on the gateway's own machine (no `host:`): it only calls the cloud API, so it needs
nothing from the agents' container. The key is read from `GEMINI_API_KEY` and nowhere else.

The mailbox backend, one entry per mailbox (user doc: `docs/mailbox.md`):

```yaml
  - id: muse
    harness: custom
    command: fleetherd
    args: [api-agent, mailbox, --url, "https://mailbox.example.com"]   # or MAILBOX_URL
    env: { MAILBOX_TOKEN: "${MUSE_MAILBOX_TOKEN}" }                  # the client token, env only
```

## Files

| File | What |
|---|---|
| `backend.ts` | The `ApiBackend` interface, the event union, `ApiAgentError`. No IO. |
| `server.ts` | The ACP side: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_config_option`; maps backend events to `session/update`. |
| `store.ts` | `sessionId → {lastInteractionId, environmentId, model}` on disk. |
| `antigravity.ts` | The first backend: Interactions API request/stream/SSE mapping. |
| `mailbox.ts` | The second: a turn is a message left in an agent-mailbox relay; deadlines, progress rows, between-turn replies. |
| `mailbox-relay.ts` | The relay's client side over fetch. |
| `sse.ts` | The SSE subset that API uses. |
| `fixtures/` | Redacted recordings the contract tests replay. |

Dependencies: Node built-ins and `@agentclientprotocol/sdk` only. The config path is resolved in
`commands/api-agent.ts`, so nothing here imports `config/`.

## The ACP surface, and why each piece

Probed against the gateway 2026-11-13 (`project-reports/acp-chat-shim-smoke-20261113.md`): these
six methods are all the daemon sends, and the capabilities below are what make it send the rest.

- **`initialize`** declares `loadSession: true` and `promptCapabilities.image` as the backend says
  (`ApiBackend.images`, default true). Without `loadSession` the daemon never reclaims an idle
  child (it would lose the context) and never resumes after a restart; with it, `session/load`
  restores the model and the continuation ids. A backend that declares no images gets pictures as
  attachment paths in the text, like any other file.
- **`session/new`** returns a fresh UUID and the model menu as `configOptions`
  (`{id:'model', category:'model', type:'select'}`) — none at all when the backend has no models,
  which is how the daemon knows there is no `/model` menu. `mcpServers` and `cwd` are ignored: this
  agent runs no local process, so the gateway's `send_file`/`schedule` tools have nowhere to go.
- **`session/load`** reads the record from disk and returns the menu. It does **not** replay
  history: only ids are stored, and the gateway drops updates that arrive before the first prompt
  anyway (a resumed session must not re-narrate itself into the chat).
- **`session/prompt`** runs one backend turn and streams `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update` and `usage_update`. It resolves
  `end_turn` or `cancelled`; a failure **rejects** with the sentence the user should read.
- **`session/cancel`** aborts the local turn at once and fires the backend's best-effort
  `cancel()`. The prompt still resolves — the gateway waits on the response, not the notification.
- **`session/set_config_option`** changes the model for later turns in this session and returns the
  updated menu. It does not touch the continuation ids: `agent_config.model` is per interaction
  (only an `agents.create` managed agent locks it), so a switch mid-conversation is legal.

`stdout` is the JSON-RPC transport and nothing else. Diagnostics go to stderr, which the daemon
forwards to its own log.

### Output between turns

A backend with `follow(sessionId, emit)` is handed, after each turn of a session ends (finished,
failed or stopped), a way to send updates with no prompt in flight; the daemon renders those as a
`⏱ background update` message (daemon/README.md, "Out-of-turn output becomes a follow-up
message"). The connection is the SDK's `onConnect` one, not a request's. Two rules come from the
daemon:

- **Not before the session's first turn in this process.** The daemon drops renderable updates
  from a child it has not prompted yet (`promptedYet`, so a resumed session cannot re-narrate
  itself). Output that arrives then must wait for the next turn — the mailbox shows it at the top
  of that turn's reply.
- **End a burst with `settled`.** In the default `once` delivery mode nothing is sent until the
  daemon decides the burst is over: 1.5 s after a `usage_update` carrying `cost`, else after three
  minutes of quiet. `settled` becomes that usage report, with `size: 0` so the footer ignores it.

`close()` is called when the connection goes; followers poll on timers, which must not keep the
process alive.

### When a turn ends without an answer

The daemon shows a rejected prompt as `❌ This turn failed: <message>` and keeps whatever text
already streamed. So every rejection leaving a handler is wrapped in a `RequestError` — anything
else becomes a bare "Internal error" on the wire, which is the one thing the user cannot act on.

| Case | What the chat says |
|---|---|
| continuation rejected **and the previous interaction is gone** (GET on it answers 404) | `context expired: … the session was reset, send the message again` |
| continuation rejected for any other reason (bad model/image/input) | the upstream error as-is; the session keeps its state, because the conversation is still usable |
| `status: "incomplete"` | `hit this turn's N-token cap … raise --max-tokens or ask for less at once` (the final usage is sent first) |
| 429 | `rate limited by the Antigravity API (429): <upstream message> (retry after Ns)` |
| 401/403 | `the Antigravity API rejected GEMINI_API_KEY …` |
| no key | `GEMINI_API_KEY is not set for this agent; add it to the agent's env in config.yaml` |
| stream lost | retried six times with backoff; a reconnect that delivers nothing twice ends it |

## Session state

`<configDir>/api-agent/<backend>/<sessionId>.json` — **one file per session**, mode 0600
(directory 0700), written atomically (temp file + rename), files whose mtime is more than seven
days old pruned. configDir is the only path the gateway's container mounts as a volume, so it is
the only one that survives `fleetherd update`. One file per session rather than one map: every
agent process of a backend writes its own sessions, and a shared file meant two conversations
overwrote each other on every turn.

`lastInteractionId` is committed **only when a turn finishes** (or hits the token cap, which is
also a terminal answer). A `/stop` leaves it pointing at the last finished interaction: the user
never saw the stopped turn's answer, so the next message must not continue from it. The
environment id is committed as soon as the interaction is created — it is a sandbox, not the
conversation. Mid-turn writes name only the field they learned (`SessionStore.patch`), so a
`/model` switch made while a turn runs is not overwritten by the turn's snapshot.

## Adding a backend

Implement `ApiBackend` in a new file: `id`, `defaultModel`, `models` (empty for no menu),
`turn(request)` (an async generator of `BackendEvent`s, ending with `done` or throwing
`ApiAgentError`) and `cancel(interactionId, sessionId)` (best-effort; a rejection is only logged).
Optional: `images: false`, `follow` and `close` (above). Then add one arm to
`commands/api-agent.ts`, where the model list, the key's environment variable and the state file
name are decided. Nothing in `server.ts` changes.

`turn` receives the session's stored ids and yields `state` as soon as it has new ones; the server
persists them and hands them back next turn. Images arrive base64-encoded.

## Antigravity notes

- **Background, then follow.** `POST /interactions` with `background: true` returns the id, and
  `GET /interactions/{id}?stream=true` streams it. A foreground POST would be the stream, and the
  id is what `/cancel` takes. **Reconnection is replay, not resume**: measured 2026-11-13, no
  frame carries an `event_id` (0 of 292 in the recorded stream, 0 of 8 live), so the documented
  `?last_event_id=` has nothing to send; a reconnect starts again at `interaction.created` and the
  adapter skips the frames it already handled. A reconnect can also answer 400
  `Precondition check failed` — transient right after an abort, permanent once the interaction
  finished. The transient case is retried; the finished case is delivered from the interaction's
  own `steps[]`, so a stream lost after the answer was ready still ends the turn normally.
  A clean EOF before `[DONE]` is retried too, and a reconnect that delivers no new frames twice in
  a row ends the turn.
- **Text is `step.delta[text]`**; `thought_summary` becomes a thought (kept out of the reply);
  `thought_signature` is dropped — 172–1016 opaque characters per recorded turn.
- **Tools** are the sandbox's `code_execution_call` / `code_execution_result` steps, drawn as a
  tool row with the command and its output.
- **Usage** is `step.stop.usage.total_tokens` (cumulative, reported on several steps) against the
  model's documented 1,048,576-token window.
- **Models**: the six values `agent_config.model` accepts (2026-11-13). Carbon and Argon are
  labelled "(paid tier)": the free tier answers them with a 429 and an upgrade prompt.
- **`--max-tokens` defaults to 200000.** A turn is a whole agent loop: the recorded harness spends
  ~5.3k input tokens before it answers, and a one-command turn used 11k. The probe's 20k is a test
  setting, not a working one; 200k bounds a runaway loop to a fifth of the window. The API's cap is
  best-effort and answers `status: "incomplete"`.
- **Cancellation is best-effort.** `/cancel` only works while the interaction is `in_progress`;
  delayed attempts returned 400 (probed at 2.5s, 4.5s, 8s). The local turn stops either way.

## Mailbox notes

- **The relay** is agent-mailbox (a Cloudflare Worker, its own repository). Client side: `send`,
  `replies` (cursor per session; passing it confirms and deletes), `cancel` (withdraws a message not
  yet fetched, else queues a `cancel` for the agent). Every answer carries the agent's polling
  status — `last_poll_at`, `fetched_upto` — which is how "not picked up" is told from "picked up,
  thinking".
- **Turn ids are ours** (`state.lastInteractionId`, so `/stop` can name the turn). A delivery is
  retried with the same id, and the relay files a repeat under the first copy.
- **Progress is a tool row**, `progress: "<text>"` (kind `other`, the text as `rawInput.prompt`,
  one of the keys the daemon previews a row by). Not a thought: the daemon never shows
  `agent_thought_chunk`, so a progress line sent as one would not be seen at all.
- **Two deadlines**, both said in the chat: no pickup in `--pickup-timeout` (120 s) → withdraw, then
  fail with when the agent last polled; picked up but silent for `--silence-timeout` (300 s) → end
  the turn with what arrived and a note. The second must stay under `session.turnTimeoutMs`
  (frozen at 600 s); the CLI refuses a value that is not.
- **Replies outside the turn**: a reply for another turn read during a turn is held and sent after
  it; between turns the follower polls every 20 s. Progress of a turn that is over is dropped.
  Replies waiting when nobody followed (no process, or before the first turn) open the next reply.
- **Attachments**: the daemon appends them under `---\nAttachments:` (turn-runner.ts buildPrompt;
  the test pins the separator). The text before it is sent, and the reply says the rest was not.
- **Polling cost**: every poll is a request against the relay's daily quota; 2 s in a turn and 20 s
  between turns is the trade (the agent itself polls every 5 s, so faster buys nothing).

## Limits

No local files, no reverse commands (`send_file`, `schedule`), no MCP, no skills, no mid-turn
steering (a message sent while a turn runs waits for the next one). Non-image attachments reach the
model as a local path it cannot read. Free-tier interactions are kept for a day; a continuation
whose interaction is really gone (the API answers 404 when asked for it) is reported and the
session reset, so the next message starts a new context. Any other failure of the continuation is
reported as it is, with the session kept.

## Testing

- `sse.test.ts` — the parser: chunk splits, multi-byte characters, `[DONE]`.
- `antigravity.test.ts` — contract tests replaying the recorded SSE (`fixtures/*.sse`, from
  `project-scripts/antigravity-agent-probe/` on 2026-11-13): mapping, request body, continuation,
  429/400/incomplete, reconnection, cancel. Re-recording means replacing the fixture and the
  expectations together.
- `store.test.ts` — persistence, 0600, pruning, corrupt file.
- `mailbox.test.ts` — the mailbox backend against an in-memory relay and a moved clock: a turn,
  both deadlines, retry, `/stop` before and after pickup, attachments (with the separator pinned
  to turn-runner.ts), late replies at the next turn, the between-turn follower. The end-to-end run
  against a real relay, a fake Muse and a gateway is outside the repository
  (`project-scripts/muse-mailbox/e2e.mjs`).
- `server.test.ts` — a real ACP client (`@agentclientprotocol/sdk`'s in-process `connectWith`)
  driving the app with a fake backend: capabilities, menu, updates, cancel, expiry, load; and a
  backend with no menu, no pictures and a `follow` that sends between turns.
