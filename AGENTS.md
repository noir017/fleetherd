# AGENTS.md

Conventions for coding agents working in this repository. Read this first, then read
the README of whichever module you are about to change — the details live there, not
here.

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
`talkcode-X.Y.Z.tgz` and its `SHA256SUMS`, which is what the deployment images install —
uniagent's, and `ghcr.io/noir017/talkcode` (`docker/Dockerfile`, built by `image.yml` from
`release.yml`), the gateway alone for a container of its own.

The project was called `agent-anywhere` — a fork of
[l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere), whose maintainer asked
for a distinct name — until 2.0.0 (2026-10-10), when the repository, package, command,
config directory and `TALKCODE_*` variables were renamed in one step, with no compatibility
shims. CHANGELOG entries before 2.0.0 and the history of `noir017/agent-anywhere` use the
old names; read them as this project.

## Module map

Each module owns a `README.md` describing its contract, invariants, and how to extend
it. Do not duplicate that content here.

| Module | Responsibility | Doc |
|---|---|---|
| `src/config/` | Config schema, loading, `${VAR}` expansion, v0→v1 migration | [README](src/config/README.md) |
| `src/core/` | Platform-agnostic pure logic: conversation identity, gating, merging, streaming, tool bubbles, footer, attachments, command vocabulary | [README](src/core/README.md) |
| `src/platform/` | IM adapters: the profile seam, 8 Satori platform profiles, per-dialect markdown renderers, and `webui/` — a browser page the daemon serves, implementing `PlatformAdapter` directly | [README](src/platform/README.md) |
| `src/daemon/` | The running system: routing, conversations, turn orchestration, agent runtimes (ACP + agy) | [README](src/daemon/README.md) |
| `src/ipc/` | Reverse-command protocol over a unix socket (agent → daemon → chat) | [README](src/ipc/README.md) |
| `src/history/` | The conversation library: every turn in `<configDir>/history.db`, searchable by keyword (Han bigrams in JS, BM25), plus the web UI transcript import | [README](src/history/README.md) |
| `src/remote/` | The gateway's side of agents on other machines: one reliable link per host over ssh | [README](src/remote/README.md) |
| `remote/` | talkcode-remote, the host side of that link — **Go**, a static binary per architecture, built by `npm run build` into `dist/remote-bin/` | [README](remote/README.md) |
| `src/commands/` | CLI entry points: `setup`, `doctor`, `start`, reverse commands | [README](src/commands/README.md) |
| `src/types.ts` | Domain data shapes shared across modules. Types only, no behavior. | — |
| `src/cli.ts` | Commander wiring. `start` is lazy-imported to keep `--help`/`doctor` fast. | — |
| `scripts/` | Dev utilities (`stop.mjs` kills stray daemons, `probe.mjs` Discord gateway probe) | [README](scripts/README.md) |
| `skill/` | The bundled agent skill: how an agent finds the reverse CLI. The daemon links it into each harness's skill directory (`daemon/skill-link.ts`) | [SKILL.md](skill/SKILL.md) |
| `skill-super/` | The second bundled skill, `super`: how an agent splits a job across sub-agents (`/super`, `daemon/delegation.ts`). Linked the same way | [SKILL.md](skill-super/SKILL.md) |

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
- `ipc/` imports nothing from other modules except `types.ts`.
- `history/` imports only Node built-ins — nothing from the rest of the project — and only
  `daemon/` and `commands/` import it. It is IO plus pure tokenising with its paths injected,
  which is what lets it be tested without a daemon.
- `remote/` (the TypeScript one) imports nothing from other modules: it is transport. What is the
  daemon's to decide about a remote agent — the namespace, how its `talkcode` command is run here,
  where the skill goes — lives in `daemon/remote-hosts.ts`. The one exception to "daemon only" is
  `commands/doctor.ts`, which uses its ssh argv to check hosts the way the daemon will reach them.
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
- `ipc/commands.ts` `REVERSE_COMMANDS` → CLI registration, the `talkcode help` pages
  (`HELP_TOPICS`), the native tools' parameters and validation (`ipc/tools.ts`), the commands an
  agent on a remote host may run back here (`daemon/remote-hosts.ts`), docs.
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
through its harness's own mechanisms instead: two native tools over MCP (`commands/mcp.ts`), and
a skill (`skill/`) whose one-line description is all that sits in context. This was decided on
2026-10-09, after the injected hint had already shrunk from thirteen lines to three: any text the
gateway puts in front of the work tells the model what kind of job this is before it reads the
job, and no wording avoids that. A change that adds text to what an agent receives needs to say
why the harness could not carry it.

Two things reach an agent that the person did not type in that conversation, each decided on
2026-11-02 and each kept to the one place it is for. An agent that started **sub-agents**
(`daemon/delegation.ts`) is told what they did in a `[sub-agent updates]` card, because no harness
can carry another conversation's state; it goes only to the conversation that opened those topics,
only about turns it handed them, and is shown folded there before it is sent. And
`hooks.turnFailed.continue.message` is sent after a failed turn — the operator's own words,
announced in the chat first, off unless configured. A sub-agent gets the task text it was handed
and nothing else; how to split a job and use the updates is the `super` skill's (`skill-super/`),
read through the harness's own skill mechanism. (A standing dispatcher topic with an `AGENTS.md`
of its own shipped in 2.18.0 and was removed the same day: see delegation.ts for why.)

**Best-effort side effects don't break turns.** Reactions, headers, receipts, and menu
edits are `void`-and-`catch`: a failure is logged and the turn continues.

## Testing

Vitest, colocated: `foo.ts` is tested by `foo.test.ts` in the same directory. ~2930
tests across 141 files. The Go half (`remote/`) has its own `go test`, colocated the same way.

```bash
npm test              # vitest run
npm run test:coverage # + v8 coverage with thresholds
npm run test:remote   # go vet + go test in remote/ (a release gate)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (flat config)
npm run build         # tsc → dist/, then talkcode-remote for amd64 + arm64 → dist/remote-bin/
```

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

The one exception to "no browser, no DOM" is `platform/webui/page.dom.test.ts`, which runs the
web UI's inline client script in jsdom. That script is a TypeScript string, so typecheck, lint
and every other gate are blind to it — and a page that renders nothing has already shipped
green once. Behaviour changes to `webui/page.ts` are expected to arrive with a test there; read
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

1. **Agents run with full tool access by default.** Under `permissions: auto` (the default)
   the daemon approves every ACP `session/request_permission`, and the only access gate is
   `access.allowFrom`; an empty allowlist means anyone who can message the bot can run
   commands on the operator's machine. `loadConfig` and `doctor` warn loudly about this; keep
   the warning. An agent set to `permissions: ask` puts each request to the user instead, and
   a request that cannot be put to anyone — or that nobody answers — is declined, never
   approved (`daemon/agent-acp.ts` answerPermission). Keep that direction: a failure to ask
   must never turn into a yes.
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
   the connection). talkcode-remote
   opens no network port: ssh in, an owner-only unix socket out. An agent on a host can run back
   here only the reverse commands, `mcp` and `help` (`daemon/remote-hosts.ts` isBridgedCommand),
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
6. **No sub-agent starts without the person.** `task-new` only proposes: every sub-task waits on
   a card that shows it in full until the person taps Start (`Delegation.putUp`, buttons only — a
   typed reply is the person's next message, never a yes), and nothing an agent says can start one.
   A conversation acts only on the topics it opened (`Delegation.child`), so one agent cannot steer
   or stop another's. Spawning agents is spending the operator's machines and money; an agent that
   could do it unasked would be an agent with powers nobody granted.
7. **The web UI POSTs only to push services.** A push subscription's endpoint is a URL a browser
   chose, and the server sends to it; `webui/webpush.ts` allowedEndpoint holds it to HTTPS on the
   push services browsers use, at subscribe time and again before every send — the outbound twin
   of invariant 3.

## Adding things

- **A platform** → `platform/config-schemas.ts` (schema) + `platform/profiles/<name>.ts`
  (profile) + one line in `platform-factory.ts`. No wizard or daemon change needed.
  See [src/platform/README.md](src/platform/README.md). A platform that is *not* a chat
  service has no profile: it implements `PlatformAdapter` directly and is dispatched before
  `PROFILES`, as `platform/webui/` is — read
  [its README](src/platform/webui/README.md) first, because the work is not the adapter but
  the list of things `satori-core.ts` was doing for you.
- **An agent harness** → an arm in `AgentDefSchema.harness` + `resolveHarness` in
  `daemon/agent-acp.ts` if it speaks ACP, or a sibling runtime implementing
  `AgentFactory` if it does not (as `agent-agy.ts` does).
  See [src/daemon/README.md](src/daemon/README.md).
- **A reverse command** → an arm in the `IpcAction` union + an entry in
  `REVERSE_COMMANDS`, whose required `topic` puts it on an `talkcode help` page; CLI
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

Since 2026-10-29 the gateway runs in a container of its own (`talkcode`, from
`ghcr.io/noir017/talkcode`) on the gateway host, and every agent runs in the `uniagent` container
beside it as a [remote host](docs/remote-hosts.md). The operator's notes for that pair are in
`~/apps/talkcode/README.md` on the host.

| # | step | who |
|---|---|---|
| 1 | `npm run release -- X.Y.Z --push` → pushes `main` + the tag → `release.yml` publishes a GitHub Release (tarball + `SHA256SUMS`) and calls `image.yml`, which publishes `ghcr.io/noir017/talkcode:X.Y.Z` and `:latest` | **you** |
| 2 | in the `uniagent` repo: `gh workflow run bump-talkcode.yml -f version=X.Y.Z` → multi-arch image to GHCR. The gateway no longer runs there, but the `claude-agent-acp` on that host's `PATH` is the one bundled in this package, so the bump keeps the adapter in step with the gateway's contract tests | **you** |
| 3 | on the gateway host: `talkcode update` | **the operator, by hand** |

**Step 3 is not yours, and not because of caution.** The gateway in that container serves the
conversation that asked for the change, and a restarting gateway stops the agents it started on
its hosts. It waits for the turns in progress first, so an update lands only once the turn that
asked for it is over: the session issuing the update never sees it happen. You cannot verify your
own deploy; you can only report that it is ready.

Notes that decide whether steps 1–2 are even correct:

- **`npm run release` is the whole of "commit + compile".** It stamps the CHANGELOG, bumps
  `package.json`, runs typecheck/lint/test/build as local gates, commits, and tags — and
  deliberately does **not** push. Do not hand-roll those edits: four things have to agree
  and every way they can disagree fails *after* the tag is public.
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
command the operator needs for step 3 — which is `talkcode update`, run on the gateway
host, verbatim. It is the host-side wrapper in `docker/talkcode-host`, installed as
`/usr/local/bin/talkcode`; do not expand it into the `docker compose pull && up -d` it runs,
and do not reconstruct some other invocation from memory. `uniagent update` is a separate
command for the agents' container, which the operator runs on their own schedule; a release
needs it only when it changed the `@agentclientprotocol/claude-agent-acp` dependency (step 2's
note) — say so in the report when it did. If this line ever stops being true, fix it here
rather than guessing at the call site.

> **Running the test suite touches this machine's live daemon.** `ensureReverseCliShim()`
> writes `~/.config/talkcode/bin/talkcode`, a path shared with whatever daemon
> is actually running here, and that directory leads its agents' `PATH`. It now refuses to
> write unless `argv[1]` really is this CLI (`isCliEntry`) — before that guard, a test run
> repointed the shim at vitest's worker entry and every live `send-message` / `ask` /
> `send-file` failed with a stack from inside tinypool. If you touch that file, keep the
> guard and keep `reverse-cli-shim.test.ts` green.
