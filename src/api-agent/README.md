# api-agent

An ACP agent whose backend is an HTTP API. The daemon speaks ACP to it like any other harness;
this module speaks HTTP to the service.

```
fleetherd daemon ──ACP/stdio──► fleetherd api-agent antigravity ──HTTPS──► Interactions API
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

## Files

| File | What |
|---|---|
| `backend.ts` | The `ApiBackend` interface, the event union, `ApiAgentError`. No IO. |
| `server.ts` | The ACP side: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_config_option`; maps backend events to `session/update`. |
| `store.ts` | `sessionId → {lastInteractionId, environmentId, model}` on disk. |
| `antigravity.ts` | The first backend: Interactions API request/stream/SSE mapping. |
| `sse.ts` | The SSE subset that API uses. |
| `fixtures/` | Redacted recordings the contract tests replay. |

Dependencies: Node built-ins and `@agentclientprotocol/sdk` only. The config path is resolved in
`commands/api-agent.ts`, so nothing here imports `config/`.

## The ACP surface, and why each piece

Probed against the gateway 2026-11-13 (`project-reports/acp-chat-shim-smoke-20261113.md`): these
six methods are all the daemon sends, and the capabilities below are what make it send the rest.

- **`initialize`** declares `loadSession: true` and `promptCapabilities.image: true`. Without
  `loadSession` the daemon never reclaims an idle child (it would lose the context) and never
  resumes after a restart; with it, `session/load` restores the model and the continuation ids.
  Images are declared because the backend forwards them inline.
- **`session/new`** returns a fresh UUID and the model menu as `configOptions`
  (`{id:'model', category:'model', type:'select'}`). `mcpServers` and `cwd` are ignored: this
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

### When a turn ends without an answer

The daemon shows a rejected prompt as `❌ This turn failed: <message>` and keeps whatever text
already streamed. So every rejection leaving a handler is wrapped in a `RequestError` — anything
else becomes a bare "Internal error" on the wire, which is the one thing the user cannot act on.

| Case | What the chat says |
|---|---|
| continuation rejected (400/404 on a turn with `previous_interaction_id`) | `context expired: … the session was reset, send the message again` |
| `status: "incomplete"` | `hit this turn's N-token cap … raise --max-tokens or ask for less at once` |
| 429 | `rate limited by the Antigravity API (429): <upstream message> (retry after Ns)` |
| 401/403 | `the Antigravity API rejected GEMINI_API_KEY …` |
| no key | `GEMINI_API_KEY is not set for this agent; add it to the agent's env in config.yaml` |
| stream lost | retried six times with backoff, then `lost the Antigravity stream …` |

## Session state

`<configDir>/api-agent/antigravity.json`, mode 0600 (directory 0700), written atomically
(temp file + rename), records unused for seven days pruned. configDir is the only path the
gateway's container mounts as a volume, so it is the only one that survives `fleetherd update`.

`lastInteractionId` is committed **only when a turn finishes** (or hits the token cap, which is
also a terminal answer). A `/stop` leaves it pointing at the last finished interaction: the user
never saw the stopped turn's answer, so the next message must not continue from it. The
environment id is committed as soon as the interaction is created — it is a sandbox, not the
conversation.

## Adding a backend

Implement `ApiBackend` in a new file: `id`, `defaultModel`, `models`, `turn(request)` (an async
generator of `BackendEvent`s, ending with `done` or throwing `ApiAgentError`) and
`cancel(interactionId)` (best-effort, never throws). Then add one arm to
`commands/api-agent.ts`, where the model list, the key's environment variable and the state file
name are decided. Nothing in `server.ts` changes.

`turn` receives the session's stored ids and yields `state` as soon as it has new ones; the server
persists them and hands them back next turn. Images arrive base64-encoded.

## Antigravity notes

- **Background, then follow.** `POST /interactions` with `background: true` returns the id, and
  `GET /interactions/{id}?stream=true` streams it. A foreground POST would be the stream, and the
  id is what `/cancel` takes. The GET **replays from event zero**, so a reconnect skips the frames
  already handled (counted, because the recorded frames carry no id).
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

## Limits

No local files, no reverse commands (`send_file`, `schedule`), no MCP, no skills, no mid-turn
steering (a message sent while a turn runs waits for the next one). Non-image attachments reach the
model as a local path it cannot read. Free-tier interactions are kept for a day; an expired
continuation is reported and the session reset, so the next message starts a new context.

## Testing

- `sse.test.ts` — the parser: chunk splits, multi-byte characters, `[DONE]`.
- `antigravity.test.ts` — contract tests replaying the recorded SSE (`fixtures/*.sse`, from
  `project-scripts/antigravity-agent-probe/` on 2026-11-13): mapping, request body, continuation,
  429/400/incomplete, reconnection, cancel. Re-recording means replacing the fixture and the
  expectations together.
- `store.test.ts` — persistence, 0600, pruning, corrupt file.
- `server.test.ts` — a real ACP client (`@agentclientprotocol/sdk`'s in-process `connectWith`)
  driving the app with a fake backend: capabilities, menu, updates, cancel, expiry, load.
