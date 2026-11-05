# `src/config/` — configuration

Owns the config file: its schema, loading, validation, `${VAR}` expansion, and the
v0→v1 migration. This is the bottom of the [dependency stack](../../AGENTS.md#layering) —
it imports only `platform/config-schemas.ts` (the per-platform credential schemas) and
nothing else from the project.

## Files

| File | Role |
|---|---|
| `schema.ts` | The zod schema, the frozen `EXPERIENCE` block, `Config` type, and accessor helpers |
| `load.ts` | Path resolution (`configDir`/`configPath`/`defaultSocketPath`), `loadConfig`, `readConfig` (validate without committing, for a live reload), `saveConfig`, `saveConfigPatch` |
| `env-expand.ts` | `${VAR}` expansion over the parsed tree + the `.env` sidecar loader |
| `migrate.ts` | v0 (`platform:` object) → v1 (`platforms:` map). Disposable by design. |
| `pods.ts` | `pods.json` — the agents each host's pod declared, as the daemon last read them (daemon/pods.ts) — and how they join `agents`: `<id>@<host>`, in the order of `hosts:`, never over an id config.yaml defines, a bad entry left out rather than failing the load, `podModels` folded into their `model` |

## The central design decision: a small user surface

The config file has exactly five sections — `platforms`, `agents`, `routing`,
`session`, `access` — plus the optional `display`, `stream`, `title`, `voice`, `hosts`,
`podModels`, `review` and `delegation`. Everything else that
*looks* like config (stream throttling, tool-bubble rendering, inbound merge windows,
attachment limits, reaction emoji, the IPC socket) is **not** user-configurable. It lives
in the frozen `EXPERIENCE` constant in `schema.ts` and is merged into every loaded
`Config` at load time.

```
UserConfig  (what config.yaml can contain, validated by ConfigSchema)
   + EXPERIENCE  (frozen constants, not in the file)
   = Config      (what the runtime reads: cfg.stream.*, cfg.tools.*, cfg.inbound.*, …)
```

The runtime still reads `cfg.stream.charThreshold` as if it were configured — only the
*file surface* dropped it. Changing one of those values is a **code change on purpose**.
They were removed because nobody tuned them and exposing them only bloated the file.

**So before adding a config field, ask which side of that line it falls on.** A
per-deployment decision (a credential, which agent answers where, who is allowed) goes
in `ConfigSchema`. A tuning knob for the streaming experience goes in `EXPERIENCE`.

`hosts` is on the user side for the same reason `voice` is: an address and a credential (an ssh
destination, a key, a known_hosts file). The link's tuning — heartbeat, back-off, buffer cap,
orphan timeout — is constants in `src/remote/` and `remote/`, not config.

`podModels` (`<id>@<host>` → a model name) is the gateway's say over the model of an agent a host's
pod declares — and only that: everything else about such an agent is the pod's (`pods.ts`), and a
map that could reach a command or an env would be the gateway reaching into how a host runs its
programs. It is folded into the merged agent's `model` in `mergePodAgents`, so every reader of
`model` gets the right answer without knowing it exists; `podAgentModels` keeps what the pod said,
for `/setting` to show and to fall back to. A key naming an agent config.yaml defines is ignored and
reported (that one is `agents[].model`), and pod.yaml's strict schema has no such field.

`agents[].hooks.turnFailed` is user-side like `hooks.preLaunch`, and kept out of `/setting` for the same reason: `command` is a shell command.

`review` is on the user side because "should anything review conversations on its own, and with
which agent" is a per-deployment decision — and one that spends the reviewer's quota. Its tuning
(the idle hour, the three-message floor, the 24-hour freshness rule, the back-off and its three
attempts) is constants in [`daemon/review.ts`](../daemon/review.ts), not config. Which agent and
which model are also `/setting` rows (`core/settings.ts`), since choosing them is a decision, not
plumbing.

`voice` is on the user side because it is a credential and an endpoint (the transcriber), plus
one decision — `confirm`, whether a transcript waits for a tap. Everything that tunes it (the
size cap, the card TTL, the retry and per-attempt deadlines) is a constant in `core/voice.ts` /
`daemon/voice.ts` rather than in `EXPERIENCE`, because a key `EXPERIENCE` owned would overwrite the
operator's `voice:` block at load.

`delegation` is on the user side because "may an agent start sub-agents without my tap" is a
per-deployment trust decision, not a tuning knob. Its one field is `confirm` (default `true`); the
card's gather window, text budget and update delay stay constants in
[`daemon/delegation.ts`](../daemon/delegation.ts). Off applies only where the person talks to the
agent directly — a sub-agent's own topic still confirms. It is the one setting with no reverse
command behind it: `/setting delegation` and the file are the only writers.

Two fields were deliberately promoted from `EXPERIENCE` to the user surface when they
turned out to be per-deployment decisions after all: `freeResponseChannels` and
`ignoredChannels` (now under `platforms.<id>.chat`) were dead config while frozen. The
gating rules split accordingly — see [`core/inbound-gate.ts`](../core/README.md).

`stream.enabled` was promoted for the same reason, and shows the shape that promotion
takes: only the DECISION crosses the line, not the tuning around it. Whether a reply is
typed out live or sent whole is a taste-and-platform judgement an operator makes once; the
numbers that pace a stream (`charThreshold`, `flushIntervalMs`, the backoff cap) stay
frozen next to it. `Config.stream` is therefore a deep merge of the two halves, exactly
like `session` — a plain `...EXPERIENCE` spread would drop the operator's value and it
would silently revert on the next restart (pinned by `display.test.ts`).

`session.idleTimeoutMs` was born on the user side for the same reason. It bounds how long
an idle conversation keeps its resident agent process, and the right answer is a property
of the machine, not of this project: `scope: per_thread` means every topic anyone has
messaged holds its own harness child (a Claude Code process is hundreds of MB), so a NAS
and a workstation genuinely want different numbers. The turn-level guardrail next to it
(`session.turnTimeoutMs`, the per-turn silence watchdog) stays frozen — nobody tunes that
per deployment. See [`daemon/README.md`](../daemon/README.md#conversation-lifetime) for
what reclaim does and the four conditions it requires.

`display.reactions.enabled` cannot live next to the emoji it controls: anything nested
under a key `EXPERIENCE` owns gets overwritten by `withExperienceDefaults`. That is why
the toggle is under `display` and the emoji stay in `inbound.reactions`.

## Load pipeline

Order matters and is fixed:

```
read file → YAML parse → v0 migration (in memory, warns)
          → ${VAR} expansion  ← happens ONCE, here
          → + the pods' agents (pods.json)
          → ConfigSchema.parse (zod, + superRefine cross-checks)
          → withExperienceDefaults
          → Config
```

The pods' agents join after expansion and before validation, both on purpose. After: an agent's
`env` is expanded once more when it is started (`daemon/agent-common.ts` expandEnv), from this
process's environment, so a pod's text must never go through expansion — `PodAgentSchema` refuses
`${` in it outright. Before: routing may name a pod's agent, and is checked like any other. That
is also why pods.json is a file and not the daemon's memory: routing has to resolve at startup,
before any host answers.

Expansion sits after parse and before validation for a reason: `setup` and
`saveConfig` operate on the **raw, unexpanded** object, so an expanded secret is never
written back to disk. Do not move it.

`${VAR}` resolves from `process.env` plus a `<configDir>/.env` sidecar (loaded without
overriding existing env vars). `$${VAR}` escapes to a literal `${VAR}`.

A live reload (`/reload`, see [`daemon/config-reload.ts`](../daemon/README.md)) reads both files again
through `readConfig`, which validates against a **candidate copy** of the environment and only
writes process.env when the caller commits — a file that fails to load leaves the process as it
was. Which keys came from the sidecar is remembered (`dotEnvDelta`), so a reload can change or drop
a value `.env` supplied while the process's own environment still wins over it.

A new top-level section must also be classified in `RELOAD_KIND` (`daemon/config-reload.ts`):
applied live, or reported as needing a restart. It is a `satisfies Record` over the schema's keys,
so leaving it out fails to compile. All missing
variables are collected and thrown as **one** error listing every config path — the
user fixes everything in one pass. Keep that aggregate style; it matches the zod error
report.

### Path resolution precedence

`configDir()` / `configPath()` resolve, highest first:

1. `TALKCODE_CONFIG_FILE` — an explicit file; its parent is the dir.
2. `TALKCODE_CONFIG_DIR` — a directory containing `config.yaml`.
3. `~/.config/talkcode/`.

The `--config <path>` flag works by *setting* `TALKCODE_CONFIG_FILE` on
`process.env` (see `cli.ts`), so the agent subprocess inherits it and its reverse
commands resolve the same config and socket. That is why the env var exists rather than
threading a parameter.

The config dir also holds `daemon.sock`, `conversations.json`, `attachments/`, and `bin/`
(the reverse-CLI shim).

## Who writes the file

Three writers, in increasing order of how much they claim:

| writer | scope |
|---|---|
| `saveConfigPatch` | one path at a time, comments and everything else preserved (yaml Document API) |
| `saveConfig` | a full rewrite — **drops comments**; only `doctor --migrate-config` uses it |
| the `/setting` chat command | `saveConfigPatch`, one scalar per invocation |

`/setting` is the one that changed the assumption that this file is only ever
hand-edited: config.yaml is now written **while the daemon is running**, from a chat
message. Eight fields are reachable that way (`routing.default`, `agents[].model`,
`delegation.confirm`, `session.idleTimeoutMs`, `session.scope`, `stream.enabled`, and
`voice.confirm` and `voice.cleanup` where a `voice:` block exists) and the rest are refused by
name — see
[`core/settings.ts`](../core/README.md#settingsts) for the table and
[`daemon/settings-store.ts`](../daemon/README.md#settings-storets) for the order the write
happens in. Two constraints from that path land here:

- `saveConfigPatch` treats `value: undefined` as **delete this key**, not "write null". An
  optional field serialized as `null` fails the next `ConfigSchema.parse`, so clearing
  `agents[].model` had to remove it.
- A write is validated against a candidate config *before* it touches the file. Nothing
  should be able to write a config.yaml that the next `loadConfig` rejects.

## Validation is fail-fast

`ConfigSchema.superRefine` enforces referential integrity at load, not at use:

- `routing.default` and every `pipeline[].use.agent` must name a real agent id.
- `pipeline[].when.platform` must name a real platform **instance** id (the `platforms`
  map key), not a platform type.
- Cross-field platform rules that a `discriminatedUnion` member cannot express:
  `slack` with `protocol: http` requires `signing`; `lark` with `protocol: http`
  requires `selfUrl`.

Without these, a typo surfaces much later as an obscure runtime error in whichever code
path first touches that id. Add new cross-field rules here, in `superRefine` — zod's
`discriminatedUnion` requires plain `ZodObject` members, so they cannot go in
`platform/config-schemas.ts`.

## Helpers other modules use

- `parseConfig(raw)` — validate + merge experience defaults. Used by tests.
- `platformInstances(cfg)` — the `platforms` map as `(id + entry)` objects, which is
  what the adapter factory consumes.
- `findAgent(cfg, id)` — agent lookup.
- `agentDisplayName(def, fallbackId)` — the **harness** name (`claude`, `opencode`),
  not the config id. The id is an operator's typing shorthand (`cc`, `oc`) and means
  nothing to someone reading the chat. `custom` falls back to the id, since its harness
  name says nothing either.
- `accessUnrestricted(cfg)` — the security signal. True when `allowFrom` is empty.
  `loadConfig` and `doctor` both warn on it. See
  [security invariants](../../AGENTS.md#security-invariants).

## Migration (`migrate.ts`)

v0 files had a single `platform:` object with Discord fields on the top level and other
platforms' credentials in an untyped `options` pocket. v1 is the typed `platforms:` map.

`loadConfig` migrates **in memory** with a one-line warning, so old files keep working.
`talkcode doctor --migrate-config` rewrites the file (backing up to
`config.yaml.bak` first).

This module is deliberately self-contained and **disposable**: delete it one major
version after v1 lands. Migration layers that never die grow into a swamp. Do not let
other code start depending on it.

## Tests

`display.test.ts`, `env-expand.test.ts`, `load.test.ts`, `migrate.test.ts`,
`save-load.test.ts`, `security.test.ts`.

`security.test.ts` pins `accessUnrestricted`, which gates the loudest warning in the
product. `save-load.test.ts` pins the round-trip that must not leak expanded secrets.

> Two tests in `load.test.ts` fail on Windows: they assert POSIX path separators.
> Pre-existing, platform-specific.
