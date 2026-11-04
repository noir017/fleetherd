# `src/commands/` — CLI entry points

What `talkcode` can do. `cli.ts` (one level up) wires these into
commander; this module implements them.

| Command | File | Purpose |
|---|---|---|
| `setup` | `setup.ts` | Interactive configuration wizard |
| `doctor` | `doctor.ts` | Environment self-check — **the default command**. its probe of each remote host, in the PATH each agent will really have, is `daemon/host-probe.ts` (the daemon reads pods with it too) |
| `start` | `start.ts` | Run the daemon |
| *(reverse)* | `reverse.ts` | The agent-facing chat actions |
| *(reverse wiring)* | `reverse-cli.ts` | Registers `REVERSE_COMMANDS` on commander — the one place an omitted optional positional's `undefined` is filtered out before `build()` |
| `mcp` *(hidden)* | `mcp.ts` | The same actions as native tools: an MCP server on stdio, started by the agent's harness |

## `doctor` is the default

Running `talkcode` with no arguments runs `doctor`, not `start`. It is read-only,
so triggering it accidentally is safe — unlike starting a daemon. It also means a bare
invocation shows live state, which is what someone typing the command blind usually
wants.

Checks, in order:

1. Config file exists and is valid (and, with `--migrate-config`, rewrite a v0 file to
   v1 — backing up to `config.yaml.bak` first).
2. Platform instances configured.
3. Platform credentials usable (Discord tokens are verified live).
4. Platform adapter connectivity (placeholder).
5. **Security: access control** — warns when `access.allowFrom` is empty. Non-blocking,
   but loud. See [security invariants](../../AGENTS.md#security-invariants).
6. ACP SDK installed.
7. Agent harness commands reachable — resolves each configured harness's executable,
   including the bundled `claude-agent-acp` / `codex-acp` entries and `agy` on PATH.
8. IPC socket path usable.

`locateCommand` does the PATH scan by hand rather than shelling out to `which`, so the
check behaves the same regardless of shell.

When adding a harness or a platform, add its reachability check here — `doctor` is where
a user finds out something is missing, and a silent gap becomes a confusing runtime
failure later.

## `setup` is schema-driven

The wizard does **not** contain a per-platform switch. It reads
`PLATFORM_SCHEMAS[type].shape` and asks for every field that is not wrapped in
`ZodOptional`/`ZodDefault` — i.e. every field the operator *must* supply — using each
field's zod `.describe()` as the prompt label. Required enums become a select; required
strings become a non-empty input. `type` is the discriminator and is skipped.

**So adding a platform needs no wizard change.** This replaced a per-platform switch that
had accumulated hacks (lark and qq were forced to carry a placeholder `token` because the
old schema required one). Do not reintroduce a branch here — if a platform needs
something the schema cannot express, fix the schema.

Experience parameters are never asked one by one: the defaults are the product, and
advanced users edit the YAML. `PLATFORM_NOTES` holds the few post-prompt hints that
genuinely help (Slack Socket Mode vs Events API, Lark endpoint choice, DingTalk
protocol).

`setup` writes the **raw, unexpanded** config, so `${VAR}` references survive and no
expanded secret is ever written to disk. See [`src/config/README.md`](../config/README.md).

## `start`

Read config → provision the reverse-CLI shim → build one adapter per configured platform
instance → open the session store → build the agent factory → run the daemon.

Two deliberate choices:

- **The shim is provisioned up front**, before anything else, so a problem fails loudly
  at startup rather than on the agent's first `talkcode` call mid-conversation.
  (`agent-acp` refreshes it per spawn as well.)
- **`unhandledRejection` and `uncaughtException` are logged, never fatal.** This is a
  long-running daemon; an occasional network blip — a transient TLS drop while sending a
  reaction — must not take down the process. Log and keep running.

`start` is **lazy-imported** by `cli.ts` (`import('./commands/start.js')`) because it
pulls in the whole Koishi + ACP SDK stack. Keeping it off the eager path is what makes
`--help`, `setup`, `doctor`, and every reverse command start fast — and reverse commands
run on *every* agent action, so their startup cost is not academic. Do not import
`start.ts` (or anything under `daemon/`) at the top level of `cli.ts`.

## `reverse.ts`

Executes one reverse command: load config → resolve the socket → `callDaemon` → print
the result as TOON on stdout. See [`src/ipc/README.md`](../ipc/README.md) for the
protocol and for how the command catalog stays in sync.

Rendering is separate from printing — `renderResult` returns `{ stdout, stderr? }` — because the
same answer also goes back as a native tool's result (`mcp.ts`). Text that names a next step is
worded for both front doors ("pause, resume, run or rm by its id"), not in shell syntax.

Two details that exist for correctness, not style:

- **`resolvePathArg`** expands a leading `~` and resolves against the agent's working
  directory: this process's CWD for a shell command (the agent spawned it), the session's
  directory for a tool call (`mcp.ts` gets it from the daemon). Either way the resolved absolute
  path is the file as the agent sees it. The daemon's CWD may
  differ, and the path later becomes a `file://` URL — a relative path or `~` would
  produce a malformed address like `file://./x.png` on the daemon side. Resolve here, not
  there.
- **Everything goes to stdout**, including errors. Stdout is the agent's only data
  channel; a message on stderr is a message the agent cannot read.

## `mcp.ts`

`talkcode mcp` is an MCP server on stdio serving `send_file` and `schedule`
([`src/ipc/README.md`](../ipc/README.md#why-exactly-two-tools) says why those two). The daemon
lists it in every ACP session, and the harness starts one per session as its own child.

- **Hand-rolled**, not `@modelcontextprotocol/sdk`: four stateless methods (`initialize`, `ping`,
  `tools/list`, `tools/call`), and `handleMcpMessage` stays a pure function the tests drive.
- **Configured by its environment only** — `TALKCODE_TURN_TOKEN`, `TALKCODE_SOCKET`,
  `TALKCODE_CWD`, all written into the server's ACP entry by the daemon. It never loads
  config.yaml: a harness may start MCP servers with an environment of its own choosing, so the
  `${VAR}`s the config expands may simply not be there.
- **No `instructions`** in `initialize`. Claude Code would put them in the system prompt, which is
  the gateway text this server exists to avoid.
- An unknown tool is a JSON-RPC error; bad arguments and daemon refusals are tool results with
  `isError`, because those are for the model to read and correct.
- stdout is the protocol stream; anything else goes to stderr.

## Tests

`mcp.test.ts` drives `handleMcpMessage` with the daemon faked at the IpcAction boundary. The rest
of the module has no test files: its logic is thin dispatch over `config/`, `ipc/`, and
`daemon/`, all of which are tested directly, and the remainder (inquirer prompts, live
credential probes, process signal handling) has no meaningful unit-test seam.
`cli.ts` is excluded from coverage for the same reason.

If you add real decision logic here, extract it as a pure exported function and test it —
`doctor`'s check predicates are the natural candidates.
