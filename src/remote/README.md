# `src/remote/` — the gateway's side of remote hosts

How the gateway reaches a machine that runs its agents: one reliable link per host over ssh, to
talkcode-remote on the other end. The protocol, and why the host side is shaped the way it is, are
in [remote/README.md](../../remote/README.md); the user docs in
[docs/remote-hosts.md](../../docs/remote-hosts.md).

Imports nothing from the rest of the project. `daemon/remote-hosts.ts` builds the hosts from
config and supplies what is the daemon's to decide (the namespace, the reverse-command bridge, the
skill); the runtimes reach a host through `daemon/agent-common.ts`.

| File | Responsibility |
|---|---|
| `frame.ts` | The frame codec, incremental decoder. |
| `link.ts` | `ReliableLink`: sequence, keep, acknowledge, resend — the mirror of `remote/link.go`. Survives every reconnect. |
| `connection.ts` | `HostConnection`: the ssh process, bootstrap and upload, handshake, heartbeat, reconnect with back-off, and the `up`/`down`/`reset` events. |
| `host.ts` | `RemoteHost` (processes, operations, the shim bridge, relays and the transforms that answer them) and `RemoteChild`, a process shaped like the parts of `ChildProcess` the runtimes use. |
| `binaries.ts` | Where the builds are (`dist/remote-bin/`), their version names, and the pinned ssh argv. |

## Invariants

- **Down is not dead.** Everything is queued while a connection is down and delivered on the next
  one; processes keep running on the host. Only `reset` (the host's daemon came back without our
  state) fails what was in flight. Code that waits on a host while a person waits on it (a menu, a
  status read) passes a timeout instead of assuming the link is up.
- **A reset fails only what the old daemon was given.** The frames of something already running
  (stdin, a signal, a cancel) queue in the link; a NEW process or request waits in `RemoteHost`
  for a connection instead (`whenUp`), so the one that sets off a reconnect to a restarted daemon —
  the next request after any quiet spell, since an idle connection closes and the host's daemon
  then exits — goes to the new daemon rather than being failed as "restarted" with the rest.
- **A first contact fails fast.** Before a host has ever answered, a request waits for the first
  connection and rejects with its reason; after that, requests queue through outages. A wrong key or
  address should be said, not retried silently forever.
- **Order is the link's.** A process's stdin and signals are written in the order they were issued,
  and `RemoteChild` holds them until its `spawn` is out — the daemon would otherwise drop stdin for
  an id it does not know yet.
- **The gateway's environment never crosses.** Spawn and run take an overlay; the base is the
  host's login environment.
- **ssh is pinned** (`sshArgs`): `-F none`, the gateway's own key and known_hosts, strict host key
  checking, BatchMode, and no host certificates. A connection never depends on an ssh config the
  gateway did not write, and a changed host key fails it. Certificates are refused because the pin
  is a KEY: a host that also has one (a Teleport agentless node) would otherwise answer with the
  certificate's key, which is not the one known_hosts holds.

## Testing

`remote.test.ts` covers the codec, the link and the ssh argv as units.
`remote.integration.test.ts` builds the real talkcode-remote and drives it through a transport that
runs the host script under a local `sh` with its own HOME — everything but ssh itself: the install,
agents over stdio, a connection killed mid-run and resumed with input typed during the outage, a
daemon that restarted during an outage (what it ran is gone, what was asked for meanwhile runs on
the new one), the operations, the shim bridge, a new epoch stopping the old agents, and a new
version retiring the old daemon and its directory. Skipped where there is no Go toolchain (CI has
one).
