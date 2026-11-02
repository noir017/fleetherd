# Remote hosts

English | [简体中文](zh-CN/remote-hosts.md)

An agent can run on another machine. The gateway reaches that machine over ssh, installs a small
helper there by itself, and drives the agent through it. The chat looks the same as with an agent
on the gateway's own machine: replies stream, files go both ways, `/cd`, `/skills` and the footer
work. When the network between the two drops, the agent keeps working; its output is held on the
host and delivered when the connection is back.

```yaml
hosts:
  devbox:
    ssh: me@10.0.0.5:22           # user@host[:port]
agents:
  - id: cc-dev
    harness: claude
    host: devbox                  # runs on devbox
    cwd: ~/work                   # a path on devbox
  - id: cc
    harness: claude               # runs here, as before
```

## Setting up a host

1. **A key for the gateway.** By default the gateway uses `~/.config/talkcode/ssh/id_ed25519`
   (`identityFile` changes it):

   ```bash
   mkdir -p ~/.config/talkcode/ssh && chmod 700 ~/.config/talkcode/ssh
   ssh-keygen -t ed25519 -N '' -f ~/.config/talkcode/ssh/id_ed25519 -C talkcode
   ```

2. **Let it in on the host**, in `~/.ssh/authorized_keys`, limited to the gateway's address:

   ```
   restrict,from="203.0.113.7" ssh-ed25519 AAAA… talkcode
   ```

   `restrict` turns off port forwarding, agent forwarding and terminals. The gateway needs none of
   them: everything goes over the one command it runs.

3. **Trust the host's key** in `~/.config/talkcode/ssh/known_hosts` (`knownHostsFile` changes it).
   The gateway checks it strictly and never learns a new one by itself. Compare the fingerprint
   with the one on the host (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) before adding it:

   ```bash
   ssh-keyscan -p 22 10.0.0.5 >> ~/.config/talkcode/ssh/known_hosts   # [10.0.0.5]:2222 for another port
   ```

   It is the host's plain key that is checked. Host certificates (a Teleport node's, for one) are
   not used, so a `@cert-authority` line does not help.

4. **Install and sign in to the agent on the host**, as you would to use it there in a terminal:
   `npm i -g @agentclientprotocol/claude-agent-acp` for `claude` (the gateway's own copy is for
   its own machine), `npm i -g @agentclientprotocol/codex-acp` for `codex`, the OpenCode or
   Antigravity CLI for `opencode` and `agy`.

5. **Check it:** `talkcode doctor` connects to every host and looks for the agents' commands there.

The host must be Linux on x86-64 or arm64, with a POSIX `sh`. Nothing else is needed on it.

## Where things happen

| | For an agent with `host:` |
|---|---|
| The agent process | on the host, in its `cwd` (default `~/.talkcode/agents/<id>` there) |
| Its environment | the host account's **login** environment (what `bash -il` sets up, `.bashrc` included) plus the agent's `env`. Nothing from the gateway's own environment is passed. |
| `hooks.preLaunch` | on the host |
| Files you send it | copied to `~/.talkcode/attachments/` on the host, and named by that path |
| Files it sends you (`send_file`, `talkcode send-file`) | fetched from the host |
| `talkcode …` commands it runs | on the host's `PATH`, carried back to the gateway |
| A `--bash` task it schedules | on the host |
| `/cd`, `/skills` | list the host's directories and skills |
| The `talkcode` skill | placed in the harness's skill directory on the host |

## When the connection drops

- The agent keeps working on the host. What it writes is kept there (up to 64 MiB per gateway,
  far more than a long turn) and delivered, in order, when the connection is back. Messages you
  send meanwhile, and `/stop`, are delivered the same way.
- A lost connection is noticed within about 15 seconds and retried with a growing pause (1 second
  up to 30). If it lasts longer than 10 seconds the conversation says so, and says so again when it
  is back. The turn is not failed for the silence.
- Restarting the gateway stops the agents it had started on the hosts. Stopped with SIGTERM, as a
  container is, it first waits for the turns in progress to finish (see
  [Updating](docker.md#updating)). A gateway that died without stopping them stops them the moment
  it starts again.
- A host that hears nothing from its gateway for 24 hours stops that gateway's agents.

## Versions

Each gateway version installs its own helper on a host, under `~/.talkcode/remote/<version>/`.
When an upgraded gateway connects, the previous version's helper is stopped, and its directory is
removed once no gateway uses it. The helper is about 4 MiB; a gateway brings both builds with it
and downloads nothing.

## Choosing an agent: `/agent`

`/cc`, `/oc` and the other agent commands name a harness, so with two Claude Code agents on two
machines they reach only the first. `/agent` reaches any agent by id: it shows the machines, then the
agents on the one you pick. `/agent cc-dev` chooses one directly. As with `/cc`, a topic that already
has a session stays with its agent; in one that has not started yet, choosing an agent is followed by
the directory menu, as a bare `/cc` is. In the web UI a new topic lays every agent out by machine,
one tap each — see [Web UI](web-ui.md).

Agents are grouped by `group:` if they have one, else by their host, else under "this machine":

```yaml
agents:
  - { id: cc-dev, harness: claude, host: devbox, group: build machines }
```

The web UI's sidebar uses the same name, in front of the directory under each topic.

## Limits

- A host where systemd-logind ends a user's processes at logout (`KillUserProcesses=yes`) also
  ends the helper when the last ssh connection closes. Run `loginctl enable-linger <user>` there.
- `CLAUDE_CONFIG_DIR` set by the host's shell setup is not visible to the gateway. Set it in the
  agent's `env` if you use it, or the footer has no cache countdown for that agent.
- `agy` older than 1.4.7 shows no context numbers on a remote host.

## Security

The key in `~/.config/talkcode/ssh/` opens a shell on every host it is authorized on. That is the
same thing an agent on that host can do for anyone in `access.allowFrom`, so protect the gateway the
way you already must. The helper opens no network port: it talks over ssh and an owner-only socket
under `~/.talkcode/remote/run/`.
