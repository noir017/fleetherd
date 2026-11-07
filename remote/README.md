# `remote/` — talkcode-remote

The half of talkcode that runs on a machine whose agents a gateway drives over ssh. Go, standard
library only, built as one static binary per architecture (`npm run build` →
`dist/remote-bin/talkcode-remote-linux-{amd64,arm64}`, via `scripts/build-remote.mjs`). The user
documentation is [docs/remote-hosts.md](../docs/remote-hosts.md); the gateway side is
[src/remote/](../src/remote/README.md). This file is the contract between them.

## Why it exists, and why it is dumb

Running an agent over `ssh host claude-agent-acp` works — ACP is stdio — and it was tried first
(2026-10-28). Everything the gateway does *besides* piping the agent's stdio broke: it reads
transcripts and logs off its own disk, writes inbound attachments there, lists `/cd` directories,
links its skill, runs hooks, signals agy with SIGINT (which `ssh -T` does not forward), and its
agents' `talkcode` command dials a local unix socket. And an ssh connection that drops takes the
agent with it.

So a helper runs on the host: it owns the agents (a dropped connection costs them nothing), does
the filesystem and command work locally, and carries everything over ONE connection per host. It is
deliberately dumb: it knows how to start processes, move bytes and touch files, and nothing about
ACP, agy, reverse commands or MCP. Those stay in TypeScript, defined once. In particular the
`talkcode` command on a host is this binary under that name, and all it does is hand its argv,
stdin and turn token back to the gateway, which runs its own CLI with them (`shim.go`). A relay
(`relay.go`) is dumb the same way: it forwards an agent's API calls on the host and shows the
gateway the responses it named; what to change in them is decided over there.

## Processes on a host

```
ssh ──► sh -c '<bootstrap>' ──► talkcode-remote attach ──unix socket──► talkcode-remote daemon
         (picks the build)       (one per connection)                    (one per gateway+version)
                                                                           ├─ agent processes
                                                                           ├─ relays (127.0.0.1, when asked)
                                                                           └─ socket for the shim
```

- **attach** (`attach.go`) lives exactly as long as one ssh connection. It checks its own sha256
  against the one the gateway passed (`TCR-BADSUM` → the gateway uploads again), makes sure the
  daemon for this gateway runs *at this version* — asking a daemon of any other version in the same
  namespace to shut down first, which is how an upgrade retires the old one, and SIGKILLing it if it
  will not — removes version directories no running daemon uses, prints `TCR-READY`, then pipes
  bytes. Serialized per namespace by a flock, so a reconnect racing a slow attach cannot start two.
- **daemon** (`daemon.go`) is started detached (its own session; sshd's SIGHUP does not reach it).
  It holds the reliable link state, the agents (`proc.go`), the one-shot operations (`ops.go`) and
  the shims' connections. Idle with no gateway for 10 minutes: exits. No gateway for 24 hours:
  stops its agents and exits.
- **Agents** get the user's LOGIN environment (`shellenv.go`: `$SHELL -i -l -c '<self> dumpenv'`,
  parsed between markers, re-read after a minute), the gateway's per-agent overlay, the shim's
  directory first on PATH, `TALKCODE_REMOTE_SOCK`, and `TALKCODE_REMOTE_CLI` — the shim's absolute
  path, for the full Node CLI a login shell's PATH reset can land on instead (`bash -lc` re-reads
  /etc/profile, which rebuilds PATH; the CLI then hands its argv to the shim rather than looking for
  a gateway config). Commands are looked up on that PATH, not the daemon's. Started from one locked
  OS thread with Pdeathsig, so a crashed daemon takes its agents with it.

Layout, all owner-only: `~/.talkcode/remote/<version>/{talkcode-remote,bin/talkcode,skill/}`,
`~/.talkcode/remote/run/<ns>/daemon.{sock,pid,lock,log}`. `<ns>` is the gateway's id
(`<configDir>/remote-id`), so two gateways on one account never share a daemon. `<version>` is the
package version plus 12 hex of the binary's sha256 — a rebuild under an unchanged version number is
still a new version.

## Bootstrap (text, before `TCR-READY`)

The gateway's ssh command is `sh -c '<script>'` (POSIX sh, no single quotes, so a fish or zsh login
shell parses it the same). The script maps `uname -m` to a build, runs `attach` if that build is
installed, and otherwise prints `TCR-NEED <arch>`; the gateway then uploads the build over a second
ssh (`cat > tmp && chmod && mv`) and tries again. Lines it does not recognise are skipped — an rc
file that prints a banner on a non-interactive shell is not fatal. `TCR-ERROR <reason>` ends the
attempt with that reason.

## Frames

Everything after `TCR-READY`, and everything on the daemon's socket:

```
u32 BE header length · u32 BE body length · header (JSON object) · body (raw bytes)
```

Header ≤ 1 MiB, body ≤ 16 MiB. One flat header type (`Header` in `frame.go`, `FrameHeader` in
`src/remote/frame.ts`); zero values are omitted.

## Reliability

Frames that carry state are **sequenced**: `s` is the sender's next number, and the frame is kept
until the peer acknowledges it. `a` on any frame acknowledges the peer's frames up to that number.
**Control** frames (`hello`, `welcome`, `ping`, `pong`, `ack`) are unnumbered and never kept.

- `hello {proto, epoch, recv}` — gateway → daemon, first frame of a link connection. `epoch` is
  random per gateway process; `recv` is the highest sequence it has from the daemon.
- `welcome {proto, version, instance, resumed, recv, home, pid, os, arch}` — the answer. With the
  same epoch as before, `resumed: true`: both sides drop what the other already has (≤ `recv`) and
  resend the rest, in order. With a different epoch the daemon first stops everything the previous
  gateway started and starts numbering from zero: `resumed: false`. A gateway that had state and
  gets `resumed: false` knows the daemon lost it (restarted) and fails everything it had in flight
  — what it had sent; a new process or request waiting for that connection goes to the new daemon.
- Duplicates (`s` ≤ received) are dropped; a gap is a corrupt stream and the connection is closed.
- Acks go out after 64 KiB received or 100 ms, whichever first, or ride on any frame sent meanwhile.
- The newest link connection wins: a daemon that gets a `hello` while it has a link closes the old
  one (a dead route not yet noticed).
- Back-pressure: past 64 MiB unacknowledged, the daemon stops reading agents' output, so agents
  block on a full pipe rather than anything being dropped. Only process output waits; the reader
  that processes acks never does.
- The gateway pings every 5 s and drops a connection silent for 15 s.

## Sequenced frames

Gateway → daemon:

| frame | fields | |
|---|---|---|
| `spawn` | `id cmd args cwd env unset` | start a process; `env` is an overlay on the login environment |
| `stdin` | `id` + body | bytes for its stdin (queued until it exists) |
| `stdin-end` | `id` | close its stdin |
| `signal` | `id sig` | `SIGINT`/`SIGTERM`/`SIGKILL`/…; held until the start completes |
| `rpc` | `rid op …` (+ body) | one operation, below |
| `rpc-cancel` | `rid` | cancel it (kills a `run`'s process group) |
| `cli-out` | `cid fd` + body | output for a shim |
| `cli-exit` | `cid code` | a shim's command finished |
| `relay-res` | `xid error` + body | what a relay serves for that response: the body; the original when the body is empty or there is an `error` |
| `shutdown` | | stop everything and exit |

Daemon → gateway:

| frame | fields | |
|---|---|---|
| `spawned` | `id pid` | |
| `out` | `id fd` + body | fd 1 or 2 |
| `exit` | `id code` or `signal`, or `error` | `error` = it never started (e.g. not on PATH) |
| `rpc-ok` / `rpc-err` | `rid res` (+ body) / `rid error` | |
| `cli-open` | `cid argv cwd token env` | an agent ran `talkcode …` (or its harness started `talkcode mcp`) |
| `cli-in` / `cli-in-end` | `cid` (+ body) | the shim's stdin |
| `cli-gone` | `cid` | the shim went away before `cli-exit` |
| `relay-req` | `id xid path` + body | a relay's response on a path the gateway named, uncompressed; served unchanged if no `relay-res` comes within 15 s |

## Operations (`rpc`)

Paths may start with `~/`, resolved against the host's home.

| `op` | fields | result |
|---|---|---|
| `stat` | `path` | `{exists, dir, size, mtimeMs}` (following links) |
| `listDir` | `path` | `{entries: [{name, dir}]}` (following links) |
| `mkdirp` | `path mode` | |
| `readFile` | `path offset max` | `{size}` + body: up to `max` bytes from `offset` |
| `readTail` | `path max grep fields` | body: the last `max` bytes as whole lines, only those containing a `grep` string, each JSON line cut down to `fields` (dotted paths) |
| `writeFile` | `path mode append atomic` + body | written (or appended) owner-only, directories created; `atomic` replaces the file in one rename (one frame, no append) |
| `ensureLink` | `target path requires owned` | `{outcome, detail}` — skill-link.ts's rules; with `owned`, an existing symlink is repointed only if it points inside that directory |
| `removeLink` | `path owned` | `{outcome, detail}` — the symlink removed only if it points inside `owned` (`removed`), else `kept` / `absent` |
| `removePath` | `path owned` | `{removed, path}` — one file or directory tree removed only if `path` is strictly inside `owned`; the parent is resolved through symlinks first, and the path itself is not followed |
| `listFiles` | `path` | `{files: [relative, …]}` — every non-directory entry, slash-separated, without following symlinks |
| `relay` | `id upstream paths` | `{url}` — a loopback HTTP relay to `upstream` (https, or http to loopback) that forwards everything as it is, streams included, except responses on `paths`, which go to the gateway first (`relay-req`). The same spec under the same id returns the same relay; a different one replaces it. Closed with everything else a gateway started |
| `run` | `argv` or `bash`, `cwd env unset timeoutMs merge max`, optional body | `{code, signal, timedOut, cancelled, truncated, spawnError, stderr}` + body (the output's end). A non-empty request body is the child's stdin, then closed — a prompt too long for one argv entry (Linux caps it at 128 KB) travels that way |

## Testing

`go test ./...` (or `npm run test:remote`, a release gate) runs the frame and link units and the
daemon end to end over its socket, the version replacement with real processes, and the login
environment capture against a real bash. `src/remote/remote.integration.test.ts` runs the gateway
side against this binary through a local `sh` standing in for ssh, which is the contract test.
