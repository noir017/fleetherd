# AGENTS.md

Conventions for coding agents working in this repository. Read this first, then read
the `*.fras` map of whichever module you are touching to locate files, entrypoints,
and invariants before running broad searches, and read that module's `README.md` for
full contracts and design details — they live there, not here.

`README.md` / `README.zh-CN.md` and `docs/` are the *user*-facing docs. The READMEs stay
short — what it is, a screenshot, install, the smallest config, an index; each feature's
full description lives in its own page under `docs/`, with its translation at the same name
under `docs/zh-CN/`. A user-visible change updates both languages. This file and the module
READMEs are the *contributor*-facing docs.

`CLAUDE.md` is a symlink to this file, so Claude Code picks it up automatically. There is
one document, not two — edit `AGENTS.md`.

## What this project is

A gateway daemon that connects chat platforms (Discord, Telegram, Slack, Lark, QQ,
LINE, WeCom, DingTalk) — plus a browser UI it serves itself — to a local coding agent
(Claude Code, Codex, OpenCode via ACP, or Google's Antigravity CLI). A user messages the
bot; the agent runs on the operator's machine; its answer streams back into a single,
live-edited message.

Node ≥ 20, TypeScript ESM (`"type": "module"`, `module: NodeNext`), strict mode with
`noUncheckedIndexedAccess`. Not published to npm: a release is a GitHub Release carrying
`fleetherd-X.Y.Z.tgz` and its `SHA256SUMS`, which is what the deployment images install —
uniagent's, and `ghcr.io/noir017/fleetherd` (`docker/Dockerfile`, built by `image.yml` from
`release.yml`), the gateway alone for a container of its own.

The project was called `agent-anywhere` — a fork of
[l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere), whose maintainer asked
for a distinct name — until 2.0.0 (2026-10-10), when the repository, package, command,
config directory and `TALKCODE_*` variables were renamed to `talkcode` in one step, with no
compatibility shims. It was `talkcode` until 3.0.0, renamed to `fleetherd` because too many
projects already went by names like it; that rename kept what was already running working
(see [Compatibility with the name talkcode](#compatibility-with-the-name-talkcode)). CHANGELOG
entries before 3.0.0, and the history of `noir017/agent-anywhere` and of this repository before
then, use the old names; read them as this project.

## Codebase Map (FRAS)

Use the two-layer FRAS map to navigate before repo-wide `rg`/`find`: pick the module
here (L1), then read its `*.fras` file (L2) for exact source files, entrypoints (`A:`),
dependencies (`R:`), and invariants (`S:`). Each module also owns a `README.md`
describing its contract, invariants, and how to extend it — do not duplicate that
content here. When adding, removing, or renaming a non-test source file or changing
its primary entrypoints, update the module's `*.fras` in the same commit.
Module documentation links: [config](src/config/README.md), [core](src/core/README.md), [platform](src/platform/README.md), [daemon](src/daemon/README.md), [api-agent](src/api-agent/README.md), [ipc](src/ipc/README.md), [history](src/history/README.md), [remote](src/remote/README.md), [remote-go](remote/README.md), [commands](src/commands/README.md), [scripts](scripts/README.md).

```fras
[config] -> src/config/config.fras | F:Config schema, loading, env expansion, and v0 to v1 migration | R:platform | A:configDir,loadConfig,readConfig,saveConfigPatch | S:See Security invariants items 1, 4
[core] -> src/core/core.fras | F:Platform-agnostic pure logic, gating, merging, streaming, and tool bubbles | R:config | A:InboundMerger,StreamBuffer,conversationKey,shouldRespond | S:Pure layer with zero IO and no global dependencies
[platform] -> src/platform/platform.fras | F:IM adapters, profile seam, per-dialect markdown, and web UI | R:config,core | A:createPlatformAdapter,createWebuiAdapter | S:See Security invariants item 7
[daemon] -> src/daemon/daemon.fras | F:Daemon coordinator, routing, turn runner, and agent runtimes | R:config,core,history,ipc,platform,remote | A:Daemon,TurnRunner | S:See Security invariants items 1, 2, 3, 5, 6, 8, 11
[api-agent] -> src/api-agent/api-agent.fras | F:ACP agent bridge over HTTP APIs (Antigravity, agent-mailbox relay) | A:createApiAgentApp
[ipc] -> src/ipc/ipc.fras | F:Reverse command Unix socket server and protocol | A:REVERSE_COMMANDS,parseIpcRequest | S:See Security invariants item 2
[history] -> src/history/history.fras | F:SQLite conversation library (<configDir>/history.db) and FTS5 search | A:HistoryStore
[remote] -> src/remote/remote.fras | F:Gateway-side SSH link and remote host process coordinator | A:HostConnection,RemoteHost | S:See Security invariants item 5
[remote-go] -> remote/remote.fras | F:Host-side static Go binary managing agents, shims, and relays | A:runAttach,startDaemon | S:See Security invariants item 5
[commands] -> src/commands/commands.fras | F:CLI entrypoints for setup, doctor, start, and reverse commands | R:api-agent,config,core,daemon,history,ipc,platform,remote | A:runDoctor,runStart
[scripts] -> scripts/scripts.fras | F:Development utilities for builds, release, stop, and SSO verification
```

### Additional components and notes

- `src/types.ts`: Domain data shapes shared across modules. Types only, no behavior.
- `src/legacy-name.ts`: Everything 3.0.0 still reads or writes under the name `talkcode`; `remote/legacy.go` is its Go twin ([below](#compatibility-with-the-name-talkcode)).
- `src/cli.ts`: Commander wiring. `start`, `setup` and `doctor` are lazy-imported: a remote agent's every command runs this binary on the gateway, and they would double what it loads.
- `src/api-agent/`: Backends include Antigravity and an agent-mailbox relay for custom harnesses (spawned by daemon as child processes).
- `src/history/`: Persists every conversation turn in `<configDir>/history.db`.
- `remote/`: Static Go binary per architecture built into `dist/remote-bin/`.
- `skill/`: Bundled agent skill ([SKILL.md](skill/SKILL.md)): how an agent finds the reverse CLI, linked into each harness's skill directory (`daemon/skill-link.ts`).
- `skill-super/`: Second bundled skill, `super` ([SKILL.md](skill-super/SKILL.md)): how an agent splits a job across sub-agents (`/super`, `daemon/delegation.ts`), linked the same way.
- `agy-plugin/`: Bundled plugin ([agy-plugin.ts](src/daemon/agy-plugin.ts)): a Stop hook that keeps an agy turn open while a command it put in the background runs, linked into `~/.gemini/config/plugins` (`daemon/agy-plugin.ts`).

## Layering

Dependencies point downward only. This is currently true and must stay true:

```
commands ──► daemon ──► platform ──► core ──► config
     ├────────┴──────────┴─────────► ipc
     │        ├────────────────────► remote
     │        └────────────────────► history
     └─────────────────────────────► history
```

Enforced facts, verifiable with grep:

- `core/` imports only `config/` (types) and `types.ts`. It never imports `platform/`,
  `daemon/`, or any Satori package. Core is pure: no clock, no `process.env`, no IO —
  all of those are injected. This is what makes it unit-testable without mocks of the
  IM stack.
- `platform/` imports only pure pieces of `core/` — `proxy.ts`, `conversation.ts`,
  `outbound-errors.ts`, `topic-stage.ts`, `workdir-menu.ts` — and never `daemon/`. Profiles never
  see the whole `Config`, only their own typed `platforms.<id>` entry. One platform also imports
  `config/load.ts`, for
  `configDir()` alone: `webui/` persists its topic list beside the daemon's own state files,
  and the alternative was a second copy of that path. The arrow already allows it
  (`platform ──► core ──► config`); it is named here because nothing else in `platform/`
  reaches for `config/` at runtime.
- `config/schema.ts` imports `platform/config-schemas.ts` (the per-platform credential
  schemas). That file is deliberately kept free of Satori imports so config loading
  never drags in the adapter chain.
- `ipc/` imports nothing from other modules except `types.ts` and `legacy-name.ts`.
- `legacy-name.ts` imports only Node built-ins, and any module but `core/` may import it: it is
  where the old name is read (an environment variable, a directory, a metadata key), and those
  reads happen at every layer. It goes in the next major (see below).
- `history/` imports only Node built-ins — nothing from the rest of the project — and only
  `daemon/` and `commands/` import it. It is IO plus pure tokenising with its paths injected,
  which is what lets it be tested without a daemon.
- `remote/` (the TypeScript one) imports nothing from other modules: it is transport. What is the
  daemon's to decide about a remote agent — the namespace, how its `fleetherd` command is run here,
  where the skill goes — lives in `daemon/remote-hosts.ts`. The one exception to "daemon only" is
  `commands/doctor.ts`, which uses its ssh argv to check hosts the way the daemon will reach them.
- `api-agent/` imports nothing from other modules: Node built-ins and `@agentclientprotocol/sdk`.
  It is the ACP *agent* side of a harness the daemon spawns, so it must not depend on the daemon
  that spawned it. `commands/api-agent.ts` is the only place that reads `configDir()`, to name the
  state file; the backend registry (models, key variable, file name) lives there too.
- `daemon/` is the only module allowed to depend on everything.

If a change requires an upward import, the design is wrong — move the pure part down
instead, or inject it as a dependency.

## Conventions

**Comments explain *why*, not *what*.** This codebase has an unusually high comment
density, and it is deliberate: nearly every non-obvious decision carries a comment
naming the constraint that forced it (a platform quirk, a protocol limitation, an
upstream bug). Match that. A comment restating the code is noise; a comment recording
why the obvious approach does not work is the point. When you discover a constraint the
hard way, write it down where the next reader will trip over it.

**Cite evidence for external behavior.** When code depends on a platform's documented
subset or an undocumented library internal, say so with the source and date (see
`platform/dingtalk-markdown.ts`, `platform/profiles/slack.ts`). Undocumented internals
get an explicit Hyrum's Law warning and a contract test.

**Single sources of truth.** Several lists are deliberately defined once and consumed
in many places. Extend the source, never a copy:
- `ipc/commands.ts` `REVERSE_COMMANDS` → CLI registration, the `fleetherd help` pages
  (`HELP_TOPICS`), the native tools' parameters and validation (`ipc/tools.ts`), the external MCP
  entrance's tools (`ipc/external-tools.ts`), the commands an agent on a remote host may run back
  here (`daemon/remote-hosts.ts`), docs.
- `core/command-translate.ts` `GENERIC_COMMANDS` → the registered slash menu + translation.
- `core/settings.ts` — the `/setting` table → the menu rows, the text list, value validation,
  the config path patched, and the ack sentence.
- `platform/config-schemas.ts` → validation, the setup wizard's prompts, doctor.
- `types.ts` domain types → mirrored zod enums with `satisfies` so drift fails to compile.

**Exhaustiveness over defaults.** Discriminated unions are switched exhaustively with a
`const _exhaustive: never` guard, so a new variant fails to compile rather than
silently falling through (see `daemon/daemon.ts` `handleReverse`).

**Degrade explicitly, never silently.** A missing platform capability either degrades
to the closest sensible behavior (no edit → chunked sends; no buttons in the renderer →
plain text) or throws a message written for the user. It never half-works. Truncation
and dropped items are logged, never silent.

**Nothing of the gateway's in the agent's prompt.** The agent reads what the user sent — the
message, a quoted line, an attachment's path — and nothing the gateway wrote about itself: no
preamble, no reminder, no instructions on how to work. What the agent can do here reaches it
through its harness's own mechanisms instead: three native tools over MCP (`commands/mcp.ts`), and
a skill (`skill/`) whose one-line description is all that sits in context. This was decided on
2026-10-09, after the injected hint had already shrunk from thirteen lines to three: any text the
gateway puts in front of the work tells the model what kind of job this is before it reads the
job, and no wording avoids that. A change that adds text to what an agent receives needs to say
why the harness could not carry it.

Four things reach an agent that the person did not type in that conversation. Two were decided on
2026-11-02, each kept to the one place it is for. An agent that started **sub-agents**
(`daemon/delegation.ts`) is told what they did in a `[sub-agent updates]` card, because no harness
can carry another conversation's state; it goes only to the conversation that opened those topics,
only about turns it handed them or that the person started or joined by writing in one, and is
shown folded there before it is sent. The person's turns were added on 2026-11-06, quoting what
they wrote above the result: until then such a turn was theirs alone, and the agent that opened the
topic went on summarising, reviewing or redoing work from a reply the person had already corrected
there. And
`hooks.turnFailed.continue.message` is sent after a failed turn — the operator's own words,
announced in the chat first, off unless configured. The third is `task-send --forward`'s: the reply
it carries into a topic arrives under a `↳ Forwarded from … · turn N` heading, a source label,
because those words are another agent's verdict and without it the agent would take them for the
person's instruction. The fourth, decided with the operator on 2026-11-20, is the review loop's
(`task-new --review-by`, delegation.ts): the same forward, sent by the gateway instead of a
coordinator — a part's reply to its reviewer, the reviewer's reply back to the part — under that
heading with the commit range or the verdict added to it, and no words of the gateway's around it.
It replaced the hops coordinators only relayed (126 of the 218 turns update cards woke them into, in
a week); the
reviewer and its text are on the card the person confirms. A sub-agent gets the task text it was
handed — and, when one is forwarded, that heading and the reply under it — and nothing else; how to
split a job and use the updates is
the `super` skill's
(`skill-super/`), read through the harness's own skill mechanism. (A standing dispatcher topic with
an `AGENTS.md` of its own shipped in 2.18.0 and was removed the same day: see delegation.ts for why.)

**Best-effort side effects don't break turns.** Reactions, headers, receipts, and menu
edits are `void`-and-`catch`: a failure is logged and the turn continues.

**Icons are inline SVG from `platform/webui/icons.ts`, never emoji.** An emoji is a font glyph:
it renders differently on every platform, cannot take `currentColor` or the text size, and where
the font lacks it the button is an empty box. `icons.ts` holds every icon the page shows — 24×24,
stroked in `currentColor` — and a new one goes into its `PATHS` rather than inline in the page;
text-only affordances like the terminal's `>_` stay text.

## Testing

Vitest, colocated: `foo.ts` is tested by `foo.test.ts` in the same directory. ~5540
tests across ~242 files. Most tests run with `isolate: false` (`vitest.workspace.ts`); add any new
test that uses `vi.mock()` to `ISOLATED_TESTS` there. The Go half (`remote/`) has its own `go test`,
colocated the same way.

```bash
npm test              # vitest run
npm run test:coverage # + v8 coverage with thresholds
npm run test:remote   # go vet + go test in remote/ (a release gate)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (flat config)
npm run build         # tsc → dist/, then fleetherd-remote for amd64 + arm64 → dist/remote-bin/
```

**Never run the full test suite (`npm test` or `npm run test:coverage`) locally.** Locally, run only
`typecheck`, `lint`, and the tests that cover your change — `npx vitest run <files>`, or
`npx vitest related <changed files> --run`. The full suite is heavy on shared containers and is run
exclusively by GitHub Actions (`ci.yml`) on push/PR. Testing and releasing are decoupled: neither
`npm run release` nor `release.yml` blocks on the full Vitest suite (2026-11-20).

Every test file runs with a HOME of its own (`vitest.setup.ts`): code under test makes directories
under the home it finds, and the suite runs on machines whose home is live. A test gateway or CLI
started from inside an agent must drop both `FLEETHERD_*` and `TALKCODE_*` of that agent's
environment — 3.0.0 reads either, and a `TALKCODE_REMOTE_SOCK` makes the CLI act as a host's agent.

Building, releasing and `src/remote/remote.integration.test.ts` need the Go toolchain (`go.mod`
names the version; CI installs it with `setup-go`). The integration test skips itself without one;
the build does not.

Coverage thresholds are enforced only where they earn their keep (`vitest.config.ts`):
`src/core/**` at 70%, `daemon/attachment-io.ts` and `ipc/protocol.ts` on the
security-critical guards. Pure-wiring entrypoints (`cli.ts`, `types.ts`) are excluded.

What is worth testing here: pure functions in `core/`, the parsers and renderers in
`platform/*-markdown.ts`, the security guards (`attachment-io.ts` SSRF checks,
`ipc/protocol.ts` validation, `conversation-token-registry.ts`), and routing/gating
decisions. What is not: Satori adapter plumbing and live network paths — there is no
integration harness, so those are verified by hand.

The one exception to "no browser, no DOM" is `platform/webui/page.dom.*.test.ts` (sharing
`page.dom.test-helpers.ts`), which runs the
web UI's client script in jsdom — `webui/client/legacy-app.ts`, bundled the way the asset build
bundles it (`page.test-helpers.ts`). Typecheck and lint still leave that file out until the
refactor plan's later steps split it into typed modules, so those tests are all that sees it — and
a page that renders nothing has already shipped green once. Behaviour changes to the client script
are expected to arrive with a test there; read
[its README](src/platform/webui/README.md#testing) first, because jsdom's handling of `@media`
and of duplicate declarations will otherwise mislead you.

Lint rules are machine-enforced discipline, not suggestions: zero `any` in non-test
code, no unused vars (`_`-prefix to opt out), `complexity ≤ 18`,
`max-lines-per-function ≤ 140`. Stylistic rules `warn`, correctness rules `error`.

> On Windows, two tests in `src/config/load.test.ts` fail on path separators
> (they assert POSIX paths). Pre-existing and platform-specific — not something your
> change broke.

## Security invariants

Do not weaken these without saying so explicitly in the PR:

1. **Agents run with full tool access by default.** With no `permissions` level (the default),
   `auto` or `full`, the daemon approves every ACP `session/request_permission`, and the only
   access gate is `access.allowFrom`; an empty allowlist means anyone who can message the bot can
   run commands on the operator's machine. `loadConfig` and `doctor` warn loudly about this; keep
   the warning. An agent at a level that asks — `plan`, `ask`, `edits` (`core/permission-levels.ts`)
   — puts each request to the user instead, scheduled runs included (an agent can schedule its
   own prompts), and a request that cannot be put to anyone — or that nobody answers — is
   declined, never approved (`daemon/agent-acp.ts` answerPermission). Keep that direction: a
   failure to ask must never turn into a yes.

   Since 2026-11-18 the level is also set from chat (`/setting permissions.<agent>`, the web UI's
   settings page), and it moves the harness's session mode as well as the gateway's answer. That
   is safe for the reasons `core/settings.ts` gives: only a person reaches `/setting` — it is read
   off a person's own inbound message, and nothing an agent sends, schedules or hands a sub-agent
   is parsed as a command — and anyone who can type there is in `access.allowFrom`, so already
   able to tap Allow on the agent's requests. Like invariant 6's tiers, that is an interface
   boundary: an agent on the gateway's own machine as the same user can edit config.yaml. Do not
   add a reverse command or an agent-reachable path that writes a level, and do not map a level
   to a harness mode that answers requests inside the harness (claude's `auto`, codex's `agent`):
   the gateway would be promising an answer it never gets to give.
2. **The IPC socket is the trust boundary.** Peer JSON is untrusted — it is validated
   with the zod schema in `ipc/protocol.ts` (`.strict()`, never `as IpcRequest`). The
   socket is created under umask `0o077` and chmod'd `0600`. Tokens are compared with
   `timingSafeEqual`.
3. **Inbound attachment URLs are user-controlled.** `daemon/attachment-io.ts` blocks
   SSRF: scheme check, loopback/internal/cloud-metadata rejection, and re-validation of
   *every* redirect hop (`redirect: 'manual'`). Size caps are enforced before download.
4. **Secrets never round-trip to disk.** `${VAR}` expansion happens once at load, after
   parse and before validation; `setup`/`saveConfig` operate on the raw unexpanded
   object. Proxy URLs are redacted before logging.
5. **A remote host is reached only as configured, and reaches back only through the reverse
   commands.** ssh is pinned (`remote/binaries.ts` sshArgs: `-F none`, the gateway's own key and
   known_hosts, strict host key checking with host certificates refused — a changed host key fails
   the connection). fleetherd-remote
   opens no network port of its own accord: ssh in, an owner-only unix socket out. The one listener
   it opens is a relay the gateway asked for (`remote/relay.go`, since 2.48.0, for an agy agent with
   `contextBudget`, or since 3.7.0 with `gatewayModels`): on 127.0.0.1 only, forwarding only to the
   upstream the gateway named — https, or http to loopback — and carrying the agent's own requests
   as they are, adding no credential of its own. The one connection it makes is a `connect` agent's
   (`remote/proc.go`, since 3.21.0): outbound, to the address that agent's definition names — the
   host's own `pod.yaml` or the gateway's config — carrying only that session's ACP. Which responses a relay changes, and how, is
   decided in the gateway (`daemon/relay.ts`); the host side never learns what any harness is. An
   agent on a host can run back
   here only the reverse commands, `mcp` and `help` (`ipc/commands.ts` isBridgedCommand),
   never `start`, `setup` or any other part of the gateway's administration — and what it runs
   still passes the IPC token check and `ipc/protocol.ts` validation like a local agent's command.
   The agents a host declares in its `pod.yaml` (`daemon/pods.ts`) are its own, named `<id>@<host>`
   so they can never stand in for another's, and their text is used as written — never
   `${VAR}`-expanded, which would hand a host the gateway's environment (`PodAgentSchema`).
   Two reverse commands do touch the gateway's setup, and only this much: `pod-add` / `pod-remove`
   (`daemon/pod-admin.ts`) add or remove a `hosts:` entry with its pinned key — the key is given by
   whoever adds the host, never fetched, so the gateway still learns no key by itself. A host joins
   the pod-to-pod ssh mesh (`daemon/pod-peers.ts`) only by its own `peer:`; the gateway then lets
   every member log in to every other, from private addresses only, vouching for each with the host
   key it pins itself. Opening one host to another is never the gateway's own initiative.
6. **No sub-agent starts without the person — unless the operator lowered the gate.**
   `delegation.confirm` has three tiers. `true` (the default): `task-new` only proposes, and every
   sub-task waits on a card that shows it in full until the person taps Start (`Delegation.putUp`,
   buttons only — a typed reply is the person's next message, never a yes), and nothing an agent
   says can start one. `'first'`: only an agent's first sub-task in a conversation waits on that
   card; once the person has tapped Start on a card containing it, later `task-new` calls for that
   agent in that conversation start at once and post the record card. That memory is in-process and
   per conversation — a restart or another conversation asks again, and changing the tier clears the
   record. `false`: every sub-task starts at once, and a card listing every one and its topic is
   still posted afterwards, without buttons — but the agent may now spend the operator's machines
   and money without being asked. All three reach only conversations the person talks to directly: a sub-agent's own topic (one with a
   parent) still puts up the card, so an agent cannot chain more agents without a tap. Only a person
   can change it: `/setting delegation` or `delegation.confirm: true | 'first' | false` in
   config.yaml; no reverse command reaches it. That is an interface boundary, not code enforcement:
   an agent on the gateway's own machine as the same user can edit config.yaml, which is invariant
   1's existing trust boundary. Either way a conversation acts only on the topics it opened
   (`Delegation.child`), so one agent cannot steer or stop another's.
7. **The web UI POSTs only to push services.** A push subscription's endpoint is a URL a browser
   chose, and the server sends to it; `webui/webpush.ts` allowedEndpoint holds it to HTTPS on the
   push services browsers use, at subscribe time and again before every send — the outbound twin
   of invariant 3.
8. **Any agent may write a managed skill, and every agent reads it.** `fleetherd skills` is not an
   operator-only command: an agent in any conversation can `create` or `patch` a skill, and at every
   agent start the gateway delivers the active ones to every host and links them into every
   harness's skill directory. So a skill is one agent writing instructions another agent will
   follow — the first such path in this project, and the reason the write side is not a plain file
   edit. What keeps it answerable: names, paths and `SKILL.md` are validated before anything is
   written; `patch` must carry the version `show` printed, so a stale edit is refused rather than
   silently undoing a newer one; every change is a commit in the skills repository and `revert`
   puts the files before it back; an archived skill is taken off every host; and the conversation that created a
   skill is told when it is archived. `access.allowFrom` remains the only gate on who can talk to
   the bot, so it is also the gate on who can write a skill — keep it to people you trust, and do
   not add another writer without the same validation and history.

   **The second writer is the automatic review** (`daemon/review.ts`, `docs/skills.md#auto-review`).
   It is not a person and has no conversation to be trusted in, so it is held to the same rules
   plus two of its own. It writes through the same `createSkill` / `patchSkill` / `writeSkillFile`
   calls — never a file edit — so every validation, version check and history entry above applies
   unchanged; a change that fails one is dropped and logged, never retried around it. And the
   reviewer itself cannot write: whoever reviews (`review.agent`, any agent; or `review.api`, an
   endpoint), its answer is text the gateway applies. What holds the reviewer, by route
   (`daemon/review-run.ts`, measured 2026-11-07; decided by the operator the same day):
   - **Tools off wherever the harness can turn them off.** An endpoint has none. claude runs with
     `_meta.claudeCode.options` `{tools: [], settingSources: [], strictMcpConfig: true}`; opencode
     with inline config `{"permission":"deny"}`; codex with its shell features off
     (`shell_tool`, `unified_exec`), which also takes away every read. agy stays on `agy -p` with
     `--settings` denying every permission class (`AGY_NO_TOOLS`), never
     `--dangerously-skip-permissions`: print mode without the flag still auto-approves file writes,
     `deny: ["*"]` denies NOTHING (`"*"` names a class literally, agy 1.5.0), and `agy acp` reads no
     settings at all (1.5.2) — so the list must name every class, and must grow when the CLI gains
     one. A `custom`, `gemini` or `dsh` reviewer has no switch the gateway knows; `review.args` is
     the operator's way to give it one.
   - **What cannot be turned off, writes and commands are held by refusal.** Every review runs as
     a session of its own in an empty temporary directory, with no MCP servers, and every
     `session/request_permission` is refused — never approved, never put to anyone. That is what
     stops codex's apply_patch (mode `read-only` makes it ask; the refusal cancels the turn, which
     is then a failed review). It holds only for a harness that asks: opencode and codex in full
     access ask for nothing, which is why their switches above are not optional.
   - **Reading outside that directory is accepted** where a harness keeps a read tool the gateway
     cannot remove. The reviewer is already given the conversation and every skill it needs; what
     it could read beyond that is the operator's machine, read by an agent the operator configured.
   Do not add a reviewer route that writes, approve a review's permission request, or drop a switch
   a harness honours.

   **The third writer is whoever can push to `skills.repo`** (`daemon/skills-repo.ts`,
   `docs/skills.md#the-repository`, since 2.42.0). With a shared repository configured, a person's
   commit reaches every agent the same way an agent's `patch` does, so write access to that
   repository is a gate on what every agent reads, beside `access.allowFrom`. It is held to the
   store's rules where it lands: a pulled skill that breaks them (`skillProblem` — no frontmatter, a
   name a harness would not list, over the size caps, a bundled skill's name) is not delivered, and
   `list` says why; and a pulled change can be told apart (its author is not `fleetherd*`, nor `talkcode*` from before 3.0.0) and
   `revert`ed like any other. The gateway reaches the repository the way it reaches a host
   (invariant 5): its own key and known_hosts, `-F none`, strict host key checking — it never learns
   the repository's key, and it never force-pushes: when both sides changed one file the
   repository's version wins and the gateway's commits are kept on a branch.

   **Only a person puts a skill into every agent's context** (since 2.42.0). A skill is resident —
   linked into every harness's skill directory — only when its frontmatter says
   `fleetherd-resident: "true"` (or `talkcode-resident`, read as the same key — either saying
   `"true"` makes it resident), and the store refuses a write by an agent or the review that changes
   that line (`skills-store.ts` assertResidentUnchanged); the web UI's page (a person) and a commit
   to the repository are the only ways to set it. Everything an agent or the review creates lands in
   the library, reached only through a search an agent chose to run. Keep it that way: an agent
   that can promote its own skill to resident is an agent writing every other agent's standing
   instructions. Like invariant 6's, this is an interface boundary, not code enforcement: an agent
   that holds the operator's push access to the repository can commit the line itself.

9. **The web UI's file window writes files on the agent's machine, and is off by default.**
   `platforms.<id>.files.enabled` is the fourth security decision in that schema, for the same
   reason the terminal is the third: with it on, the login secret stops guarding *talking to an agent* and
   starts guarding *writing files where the agent runs*, which is running commands by another route.
   With it off there is no button and every route answers 404 — the terminal's arrangement, not a
   hidden control over live endpoints. Reach is each topic's working directory, the git repository it sits in (so the git panel's
   Edit works from a subdirectory), and `files.roots`;
   a path is normalized and must land under one of them, and a `..` that climbs out is refused
   (`daemon/file-panel.ts` `locate`). Symlinks are followed and NOT resolved for that check, so
   whatever a link inside a root points at is writable through it — deliberate, because a workspace
   laid out as links into mounted volumes is the normal arrangement on these machines
   (`workdir-scan.ts`), and the operator is told so where they configure it. Every write goes
   through `Workspace.writeFile`, which both machines implement alike: it follows the link, keeps
   the file's mode (a new file gets the umask default), and refuses a save whose size, mtime or
   SHA-256 is not the one the page read — re-checked immediately before the rename, but still a
   check BEFORE the write, not an atomic compare-and-swap: a writer landing between that check and
   the rename is overwritten, and the dialog is the most this design offers. Say so where the
   operator reads it; do not describe it as locking. The person's overwrite is an explicit `force`. Every write is logged
   with who, which machine and which file. Do not add a route that writes without that check, a
   second root rule that resolves links, or a page-side path check standing in for the daemon's.

10. **The web UI's instruction editor writes what every agent reads, and is off by default.**
   `platforms.<id>.instructions.enabled` is the fifth security decision in that schema. With it on,
   the login secret guards the standing instructions of every agent on every platform and host:
   a change made there is in force for sessions nobody on the page is watching, in conversations
   that are not the page's — which a message to one agent never is. With it off there is no
   section and every `/api/instructions…` route answers 404, whether or not the daemon handed the
   page a panel. Reach is fixed by the daemon, never by the page (`daemon/instructions-panel.ts`):
   the gateway's own files by name (`common.md`, every layer a configured agent is placed on — an
   agent whose delivery is off still names its layer — and, as orphans, every other legal
   `<layer>.md` in that directory that is a regular file: a layer left behind by an agent that is
   gone; a name that differs from a known layer only in case is not a second layer, and a layer
   name is a plain file name or nothing — `config/instructions.ts` `isInstructionLayer` guards
   `instructionsHome` and `composeInstructions`, so a name with `/` or `..` never becomes a path).
   A known layer's file is followed through a symlink for both reading and writing — deliberate,
   because a dotfile kept in a repository and linked into place is the normal arrangement (the
   reason invariant 9 gives for the file window); `lstat` is used only to keep a link from being
   discovered as an orphan layer of its own. And on an agent's machine only the files that agent's
   harness reads at that moment — its rules, the files its instruction files reference, what its
   config lists (`instruction-imports.ts` `harnessSources`) — walked again on that machine for
   every read and write, so a reference taken out closes its file. That walk follows what the files
   say, so whatever a reference names is readable and writable through it, as the agent's own user:
   the text that names it is the operator's (or, for a host's own files, already the agent's to
   write), and the editor does not go beyond it. The gateway's delivered copies on a host are
   listed and never written here.
   Writes go through `Workspace.writeFile` with the same version check as the file window; a save of
   a global file is placed on every machine at once and refused before it is written if any agent
   would get more than the delivery cap; every write is logged with who, which machine and which
   file. Do not add a route that takes a free path, a write that skips the check, or a harness rule
   anywhere but `harnessSources`.

11. **The external MCP entrance lets a program outside the gateway propose work, and only
   propose it** (`daemon/external-mcp.ts`, `docs/external-mcp.md`). Its callers are
   neither a person nor an agent the gateway started: a web agent behind an MCP proxy, reading pages
   and mail nobody vetted, so whatever it asks for may have been written by whoever wrote those. It
   is off without an `mcp:` block, and it borrows nothing from the web UI. What holds it:
   - **A token per caller**, named in config by its environment variable and never written there,
     compared in constant time over SHA-256 digests (no early exit, no length leak), read from the
     environment on every request — so removing a caller or its variable and `/reload` revokes it.
     A token under 24 characters, or equal to a web UI login secret, is refused, never accepted on
     a weaker check. A request with an `Origin` header is refused (no browser has a reason to call).
   - **Two tools, and only those listed for the caller.** `skills` is `search` and `show`; every
     write is refused at the tool and again in the daemon (`ipc/external-tools.ts`,
     `daemon/external-calls.ts`), so a caller never adds to what every agent reads (invariant 8).
     `tasks` is the sub-agent commands minus `task-send` — refused in `Delegation.handleExternal`
     too — because a sub-agent has a shell and a running turn takes what is sent to it: an injected
     instruction must not reach one without a tap. No `send_file`, no `schedule`.
   - **Every sub-task waits on the card**, in the caller's own coordination topic, whatever
     `delegation.confirm` says (`Delegation.startsAtOnce`): invariant 6's lowered tiers are about
     agents the person talks to, not a caller from outside. A typed reply there reaches no agent
     (the daemon answers it, `ExternalCalls.intercept`), so Cancel is the only no, and nothing is
     ever started by text.
   - **Ownership is the topic.** A caller acts only from topics it opened
     (`<configDir>/external-topics.json`), and reaches a sub-task only through the platform's record
     of its parent. Another caller's topic and a topic that does not exist get the same refusal.
     A caller holds at most `MAX_TOPICS_PER_CALLER` topics (`daemon/external-calls.ts`): the web UI
     evicts the oldest unstarred topic to make room, and a caller opening topics in a loop must not
     push out the person's.
   - **No turn runs in a coordination topic, and only the gateway writes there.** Sub-agent updates
     are shown there and never sent as a prompt (`Delegation.tell`); the caller polls with `list`
     and `read`. An agent cannot post into one either: the reverse commands that write to a target
     are refused there (`COORDINATION_WRITE_ACTIONS` in `daemon/daemon.ts`, with a test that fails
     when a new command taking `--channel` is neither listed nor exempted), and a scheduled task —
     prompt or bash — cannot be added, moved or run there (`ScheduleService`). The caller's topics
     are recorded by platform and address (`external-topics.json` v2), never by conversation id,
     so a `/reload` that changes `session.scope` does not lose them, and an external call carries
     that address all the way down instead of deriving ownership from a conversation key.
   It reaches no host: the entrance runs in the daemon and touches only the skill library and the
   sub-agent commands. Do not add a tool to it that writes, sends into a running turn, or starts
   anything without the card; do not let it share a credential or a port with the web UI.

## Adding things

- **A platform** → `platform/config-schemas.ts` (schema) + `platform/profiles/<name>.ts`
  (profile) + one line in `platform-factory.ts`. No wizard or daemon change needed.
  See [src/platform/README.md](src/platform/README.md). A platform that is *not* a chat
  service has no profile: it implements `PlatformAdapter` directly and is dispatched before
  `PROFILES`, as `platform/webui/` is — read
  [its README](src/platform/webui/README.md) first, because the work is not the adapter but
  the list of things `satori-core.ts` was doing for you.
- **An agent harness** → an arm in `AgentDefSchema.harness` + `resolveHarness` in
  `daemon/agent-acp.ts` if it speaks ACP. A harness that did not would need a sibling runtime
  implementing `AgentFactory`, wired where `start.ts` builds the factory — nothing does today.
  A service with an HTTP API is neither: it is a backend of `src/api-agent/`, which *is* an ACP
  agent the daemon spawns as `custom` (see [its README](src/api-agent/README.md)).
  See [src/daemon/README.md](src/daemon/README.md).
- **A reverse command** → an arm in the `IpcAction` union + an entry in
  `REVERSE_COMMANDS`, whose required `topic` puts it on a `fleetherd help` page; CLI
  registration and the help page follow automatically, and a missing `handleReverse` arm fails
  to compile. Do not make it a native tool (`NATIVE_TOOLS` in `ipc/tools.ts`) by default: every
  tool's schema rides along in every request on every harness, so a tool has to be something an
  agent can neither do without nor guess exists. See [src/ipc/README.md](src/ipc/README.md).
- **A config field** → `config/schema.ts`. But first ask whether it belongs in the
  frozen `EXPERIENCE` block instead: the user-facing surface is deliberately five
  sections, and tuning knobs nobody adjusts were removed on purpose.
  See [src/config/README.md](src/config/README.md).
- **A `/setting` entry** → the table in `core/settings.ts`, plus an arm in
  `applyToConfig` (`daemon/settings-store.ts`), which is exhaustive so the live-apply
  behavior cannot be left undecided. Only fields where a chat-side edit is *safe* belong
  there; the deliberate exclusions and their reasons are in the same file.
  See [src/core/README.md](src/core/README.md#settingsts).

## Compatibility with the name talkcode

3.0.0 renamed everything, but what already ran under the old name keeps running. Each shim below
reads or writes the old name only through `src/legacy-name.ts` or `remote/legacy.go`; **the next
major removes them** — delete both files, fix what stops compiling, delete the tests that name the
old spelling, and drop the CHANGELOG/AGENTS notes that point here. Until then, a change that
touches one of these places keeps both names working.

| What | Old name still honoured | Where |
|---|---|---|
| CLI | `talkcode` as an alias of `fleetherd`: package `bin`, the reverse-CLI shim (`<configDir>/bin/talkcode`), the host-side link `<version>/bin/talkcode`, the host wrapper (`/usr/local/bin/talkcode` → `fleetherd`) | `package.json`, `daemon/reverse-cli-shim.ts`, `remote/attach.go`, `docker/fleetherd-host` |
| Environment | `TALKCODE_*` read when `FLEETHERD_*` is unset; agents (local and remote), hooks and the host daemon's agents get both names, because a host may run a CLI older than 3.0.0 | `envOf` / `withLegacyNames`, `remote/legacy.go` |
| Config directory | `~/.config/talkcode` used as it is when `~/.config/fleetherd` does not exist, logged once; never moved (a bind mount, absolute paths in config.yaml) | `defaultConfigDir`, `config/load.ts` |
| Host directory | `~/.talkcode` moved to `~/.fleetherd` with a link left at the old name: on every host by the bootstrap, on the gateway's own machine at start; links that name the old path count as the gateway's own | `remote/connection.ts`, `migrateHostDir`, `isUnderEitherName`, `remote/ops.go` `under` |
| Skill metadata | `talkcode-resident` / `-category` / `-hosts` / `-harnesses` read; the resident guard (invariant 8) treats both spellings as one key, either `"true"` meaning resident | `skills-store.ts` `metaValue` / `residentOf` |
| Skills repository | commits authored `talkcode*` are the gateway's; `Talkcode-` trailers read like `Fleetherd-` ones | `skills-git.ts`, `webui/client/legacy-app.ts` skillHistRow |
| Skill links | the bundled skill's old `talkcode` link is taken back where `fleetherd` is linked; `talkcode` stays a reserved skill name | `skill-link.ts`, `remote-hosts.ts`, `skills-store.ts` |
| Transcripts | `talkcode skills …` and `~/.talkcode/skills/…` count as skill use and administration | `skill-usage.ts`, `review-prompt.ts` |
| Remote host | a `talkcode-remote` daemon or version directory is retired like a `fleetherd-remote` one | `remote/attach.go` |
| Host wrapper | `TALKCODE_APP_DIR`, `~/apps/talkcode`, a container named `talkcode`, either package's version | `docker/fleetherd-host` |

Not compatibility but history: CHANGELOG entries before 3.0.0, and the name paragraph above.

## Git

- Branches: `main` is the only branch, and work lands on it. `dev` was the integration branch
  through 1.15.1; it was deleted on 2026-09-29 (everything on it was already in `main`), so do
  not recreate it. This also means CI (`ci.yml`, which only triggers on `main`) sees your work
  before a release does.
- Merges use `--no-ff` (a real merge commit), never fast-forward.
- Commits carry no AI attribution or generated-with trailers.
- User-visible changes get a `CHANGELOG.md` entry under `## [Unreleased]`
  (Keep a Changelog format). The entries are prose explaining the *why*, matching the
  comment style — see the existing ones before writing yours.

## Shipping

**Do not stop at "the change is written" and wait to be told to commit.** Once the work is
done and verified, carry it to the last step you are able to reach, and say where you
stopped. Half-delivered work is the expensive state: the operator has to reconstruct what
you did before they can finish it.

Deployment spans two repositories and three steps. **Do steps 1 and 2. Never do step 3.**

Since 2026-10-29 the gateway runs in a container of its own (`fleetherd`, from
`ghcr.io/noir017/fleetherd`) on the gateway host, and every agent runs in the `uniagent` container
beside it as a [remote host](docs/remote-hosts.md). The operator's notes for that pair are in
`~/apps/fleetherd/README.md` on the host (`~/apps/talkcode/` on a host set up before 3.0.0).

| # | step | who |
|---|---|---|
| 1 | `npm run release -- X.Y.Z --push` → pushes `main` + the tag → `release.yml` publishes a GitHub Release (tarball + `SHA256SUMS`) and calls `image.yml`, which publishes `ghcr.io/noir017/fleetherd:X.Y.Z` and `:latest` | **you** |
| 2 | in the `uniagent` repo: `gh workflow run bump-fleetherd.yml -f version=X.Y.Z` → multi-arch image to GHCR. The gateway no longer runs there, but the `claude-agent-acp` on that host's `PATH` is the one bundled in this package, so the bump keeps the adapter in step with the gateway's contract tests | **you** |
| 3 | on the gateway host: `fleetherd update` | **the operator, by hand** |

**Step 3 is not yours, and not because of caution.** The gateway in that container serves the
conversation that asked for the change, and a restarting gateway stops the agents it started on
its hosts. It waits for the turns in progress first, so an update lands only once the turn that
asked for it is over: the session issuing the update never sees it happen. You cannot verify your
own deploy; you can only report that it is ready. The operator may hand you a run of it explicitly;
that covers that run only. A go-ahead for one update is not one for the next — on 2026-11-18 an agent
took it so, ran the next update itself from a session the restart then stopped, and the gateway was
down for nine hours.

Notes that decide whether steps 1–2 are even correct:

- **`npm run release` is the whole of "commit + compile".** It stamps the CHANGELOG, bumps
  `package.json`, runs typecheck/lint/test:remote/build as local gates (without the full Vitest
  suite, which runs asynchronously in `ci.yml`), commits, and tags — and deliberately does **not**
  push. Do not hand-roll those edits: four things have to agree and every way they can disagree
  fails *after* the tag is public.
- **A code change must take a new version number.** The image pins the tarball's SHA256, so
  re-cutting an existing version produces different bytes under the same tag and simply
  fails to bake in.
- **Docs- and tests-only changes do not get a release.** Commit and push them and stop
  there: the image bakes a published tarball, so nothing that cannot reach `dist/` can
  reach the running daemon, and burning a version number on it only adds noise between the
  releases that mean something.
- **Verify before releasing, not after.** `npm run release` runs the gates, but gates are
  not verification — exercise the changed behaviour first. The one thing you genuinely
  cannot exercise is a running daemon (see step 3); say so plainly instead of implying it
  was checked.

Report what you did in the order it happened, with the version, and end with the exact
command the operator needs for step 3 — which is `fleetherd update`, run on the gateway
host, verbatim. It is the host-side wrapper in `docker/fleetherd-host`, installed as
`/usr/local/bin/fleetherd` (with `talkcode` linked to it); do not expand it into the `docker compose pull && up -d` it runs,
and do not reconstruct some other invocation from memory. `uniagent update` is a separate
command for the agents' container, which the operator runs on their own schedule; a release
needs it only when it changed the `@agentclientprotocol/claude-agent-acp` dependency (step 2's
note) — say so in the report when it did. If this line ever stops being true, fix it here
rather than guessing at the call site.

**The first release under this name, 3.0.0, needs the operator once more**, before step 3 works:
the image and the container's home moved, so the compose file written for talkcode has to change.
The steps are in `docker/fleetherd-host`'s header (`fleetherd --help` prints them): install the new
wrapper and link `talkcode` to it; in the compose file, `ghcr.io/noir017/talkcode` →
`ghcr.io/noir017/fleetherd` and every mount target under `/home/talkcode` → `/home/fleetherd`
(`./config:/home/fleetherd/.config/fleetherd`), keeping the service's key; in config.yaml, every
absolute path into `/home/talkcode` the same; then `fleetherd update`. The wrapper refuses to
update or restart on a compose file that still names either old one, and a gateway that finds no
config exits with an error rather than starting empty. Say so in the report of that release.

> **Running the test suite touches this machine's live daemon.** `ensureReverseCliShim()`
> writes `~/.config/fleetherd/bin/fleetherd` (and `bin/talkcode`), a path shared with whatever daemon
> is actually running here, and that directory leads its agents' `PATH`. It now refuses to
> write unless `argv[1]` really is this CLI (`isCliEntry`) — before that guard, a test run
> repointed the shim at vitest's worker entry and every live `send-message` / `ask` /
> `send-file` failed with a stack from inside tinypool. If you touch that file, keep the
> guard and keep `reverse-cli-shim.test.ts` green.
