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

### From a chat: `talkcode pod-add`

An agent can do steps 1–3 itself (`talkcode help pods`):

1. `talkcode pods` prints `gatewayKey`, the authorized_keys line for the new host (the gateway makes
   its key the first time). It carries `restrict` and a `from=` of private address ranges.
2. On the host, append that line to `~/.ssh/authorized_keys`, and read its host key there — say
   `/etc/ssh/ssh_host_ed25519_key.pub` — rather than with `ssh-keyscan`: it is what every connection
   will be checked against.
3. `talkcode pod-add devbox me@10.0.0.5:22 --host-key "ssh-ed25519 AAAA…"` adds `hosts.devbox` to
   config.yaml (comments kept), pins the key in the gateway's known_hosts, reloads, and answers with
   the agents it found there.

`talkcode pod-remove devbox` takes a host out, with its agents. It is refused while config.yaml still
names it — agents written for it there, or routing that names one of its agents.

## Agents the host declares: `~/.talkcode/pod.yaml`

A host can say which agents it has, instead of config.yaml listing them. Then `hosts:` is all
config.yaml needs:

```yaml
# ~/.talkcode/pod.yaml, on the host
agents:
  - id: oc
    harness: opencode
    model: opencode/deepseek-v4.1-flash-free
    cwd: ~/workspace
  - id: cbc
    harness: custom
    command: codebuddy
    args: [--acp]
```

- Each one is named `<id>@<host>`: `oc` on `devbox` is `oc@devbox`, so routing, `/agent` and
  `talkcode task-new` use that. A host cannot take an id config.yaml or another host uses.
- The fields are an agent's fields from config.yaml, without `host`. Values are used as written:
  `${VAR}` is refused, because it would be filled in from the gateway's environment, which holds
  its tokens. A variable the agent needs belongs in the host's login environment.
- **No file:** the gateway looks on the host's login PATH for `claude-agent-acp`, `codex-acp`,
  `opencode`, `agy` and `codebuddy`, and offers the ones it finds as `cc`, `cx`, `oc`, `ag` and
  `cbc`, with default settings. An empty file means no agents. A host that config.yaml already
  places agents on is not looked at unless it has the file — it would offer each of them again.
- **When it is read:** when the gateway starts, and on every `/reload` (or `talkcode reload`).
  Change the file, then reload. What was read is kept in `pods.json` in the config directory, so
  a host that is down keeps its agents; so does a host whose file is wrong, and the reload's answer
  says what is wrong with it.
- **Its model can be set from the gateway.** `/setting model.oc@devbox <name>` (or its row on the
  web UI's settings page) writes `podModels` in the gateway's config.yaml, which wins over the
  `model:` the pod gives; clearing it there goes back to the pod's. In full, from highest:
  a conversation's `/model` → the gateway's `podModels` → `model:` in pod.yaml → the harness's
  default. The settings page says which one an agent's value comes from. Nothing else about a pod's
  agent can be set from the gateway, and a pod cannot set `podModels`: pod.yaml has no such field.

  ```yaml
  # config.yaml, on the gateway — written by /setting, or by hand
  podModels:
    oc@devbox: opencode/glm-5
  ```

### Pod-to-pod ssh: `peer:`

Hosts can ssh to one another without anyone setting up keys between them. A host whose pod.yaml
has `peer:` joins the mesh; after a `/reload`, from any host in it:

```bash
ssh devbox.pod            # a terminal; scp, rsync, git and -L/-R work as with any ssh host
```

```yaml
# ~/.talkcode/pod.yaml
peer:                     # join the mesh
  ssh: me@10.0.0.5:2222   # optional: how the other hosts reach this one, if not how the gateway does
```

The connections are plain OpenSSH between the hosts; the gateway carries none of it. What it does
is the setup: each host in the mesh gets a key of its own (made on the host, in
`~/.talkcode/ssh/id_ed25519`), and the gateway writes, beside it, the other hosts' keys
(`authorized_keys`, usable only from private address ranges), their host keys under `<host>.pod`
(`known_hosts`, taken from the gateway's own known_hosts — what it already checks them against) and
a `Host <host>.pod` block for each (`config`). Rewritten on every gateway start and `/reload`.

For a host to use those files, its sshd has to read the second `authorized_keys` and its ssh the
`config` — two lines, which the uniagent image already has:

```
# sshd_config
AuthorizedKeysFile .ssh/authorized_keys .talkcode/ssh/authorized_keys
AllowTcpForwarding yes        # for -L/-R; keys with `restrict` stay without it
# ssh_config (e.g. /etc/ssh/ssh_config.d/20-talkcode-pods.conf)
Include /home/<user>/.talkcode/ssh/config
```

Every host in the mesh can log in to every other: joining is the host's own decision (`peer:` is in
its file, not the gateway's config), and one host in it is as good as all of them to whoever gets
into it. Remove `peer:` and reload, and the host's files are emptied; the others stop trusting it.

### Renaming agents

Conversations and scheduled tasks remember the agent they belong to by id, so changing an id in
config.yaml alone sends every one of its topics back to the default agent, with a new session. To
rename, put a map in `agent-renames.json` in the config directory and restart the gateway:

```json
{ "oc2": "oc@devbox", "cc": "cc@devbox" }
```

On start, the ids change together in config.yaml (`agents`, `routing`), in every conversation and
in the scheduled tasks; the three files are first copied to `*.bak-renames-<time>`, and the map is
set aside as `agent-renames.json.applied-<time>`. To move an agent from config.yaml to its host's
`pod.yaml`, rename it to its `<id>@<host>` name this way, write the file on the host, then remove
the config.yaml entry and `/reload`.

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

`talkcode` works from a login shell too. Agents often run shell commands with `bash -lc` (codex
does), and a login shell rebuilds `PATH` from `/etc/profile` — so `talkcode` there is whatever the
machine installed, not the helper's copy. That one hands the command to the helper instead of
looking for a gateway config that is not on this machine. Only the reverse commands and `mcp` are
handed over: `help` and `--version` are answered on the host, and `start`, `setup` and `doctor` are
refused there.

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

The `talkcode` on the machine's own `PATH` (in the uniagent image, for one) is a separate install
from the helper the gateway puts on the host. The login-shell handoff needs both halves to come
from a release that has it: with only the image updated, the old helper cannot say where its shim
is and the CLI answers that the helper is too old; with only the gateway updated, the old CLI still
answers "config not found". Upgrade both.

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
- `agy` on its stream-json fallback shows no context numbers on a remote host when it is older than
  1.4.7.

## Security

The key in `~/.config/talkcode/ssh/` opens a shell on every host it is authorized on. That is the
same thing an agent on that host can do for anyone in `access.allowFrom`, so protect the gateway the
way you already must. The helper opens no network port: it talks over ssh and an owner-only socket
under `~/.talkcode/remote/run/`.
