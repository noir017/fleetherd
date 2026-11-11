# Running in a container

English | [简体中文](zh-CN/docker.md)

`ghcr.io/noir017/fleetherd` is the gateway alone: Node, the ssh client and fleetherd, with no
agent. Every agent runs on a [remote host](remote-hosts.md), so the container only needs to reach
those hosts over ssh and the chat platforms over HTTPS. Each release publishes `X.Y.Z` and moves
`latest`, for amd64 and arm64.

```yaml
# docker-compose.yml
services:
  fleetherd:
    image: ghcr.io/noir017/fleetherd:latest
    container_name: fleetherd
    restart: unless-stopped
    stop_grace_period: 32m           # room to finish the turns in progress (see Updating)
    environment:
      - TZ=Asia/Shanghai
    ports:
      - "127.0.0.1:8787:8787"        # the web UI, if you use it
    volumes:
      - ./config:/home/fleetherd/.config/fleetherd
```

```yaml
# config/config.yaml
version: 1
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}              # from config/.env
    host: 0.0.0.0                    # a published port arrives on the container's own interface
hosts:
  devbox:
    ssh: me@192.0.2.5:22
agents:
  - id: cc
    harness: claude
    host: devbox
routing:
  default: cc
access:
  allowFrom: ["web:owner"]
```

Then set up the key and the host as in [Remote hosts](remote-hosts.md#setting-up-a-host). The
key and `known_hosts` go in `config/ssh/` here, which is `~/.config/fleetherd/ssh/` in the
container. Generate the key inside the container so the files have the right owner:

```bash
docker compose run --rm fleetherd sh -c \
  'mkdir -p -m 700 ~/.config/fleetherd/ssh && ssh-keygen -t ed25519 -N "" -f ~/.config/fleetherd/ssh/id_ed25519 -C fleetherd'
docker compose run --rm fleetherd fleetherd doctor
docker compose up -d
```

## What to know

- **The account is uid 1001.** The mounted `config/` must belong to it. Build the image with
  `--build-arg UID=… --build-arg GID=…` (from `docker/Dockerfile`) to use another.
- **No agent runs inside.** The image leaves out the Claude Code binary that `harness: claude`
  would use locally (about 220 MB), so an agent without `host:` fails to start with "native binary
  not found".
- **The log is `docker logs fleetherd`** (`-t` adds timestamps). Nothing is written to a log file.
- **Restarting the container stops the agents it started on the hosts.** An update is a restart.
  The gateway first lets the turns in progress finish, as described under
  [Updating](#updating). See also [When the connection drops](remote-hosts.md#when-the-connection-drops).
- **The terminal pane** in the [web UI](web-ui.md#terminal) proxies to a ttyd over a unix socket.
  With ttyd on a host, mount a directory both containers share and point `terminal.socket` at the
  socket in it. The ttyd must run as the same uid as the gateway. `terminal.endCommand` runs in this
  container, so it reaches the host's tmux over ssh with the gateway's key:

  ```yaml
  terminal:
    enabled: true
    socket: /run/webui-term/webui-term.sock
    endCommand: [ssh, -F, none, -o, BatchMode=yes, -i, /home/fleetherd/.config/fleetherd/ssh/id_ed25519,
                 -o, UserKnownHostsFile=/home/fleetherd/.config/fleetherd/ssh/known_hosts,
                 -o, StrictHostKeyChecking=yes, me@devbox,
                 tmux, -L, web, kill-session, -t, "web-{topic}"]
  ```

## Updating

```bash
docker compose pull && docker compose up -d
```

Stopping the container sends the gateway SIGTERM. If a turn or a scheduled run is in progress, the
gateway waits for it to finish, for at most 30 minutes, and then stops. Meanwhile:

- each conversation with a turn running is told that the restart is waiting for it;
- a message that would start a new turn is not sent to the agent, and gets a reply saying to send
  it again once the gateway is back;
- messages to a conversation that is already working, `/stop`, and answers to questions work as
  usual;
- scheduled tasks do not start. A run that falls due while the gateway waits is run when it starts
  again.

Docker gives a container 10 seconds to stop, unless the compose file sets `stop_grace_period`, as
the example above does. A second SIGTERM, or SIGINT (`docker stop --signal SIGINT fleetherd`),
stops the gateway at once.

Or install `docker/fleetherd-host` as the host's `fleetherd` command
(`sudo install -m 755 docker/fleetherd-host /usr/local/bin/fleetherd`), which handles this for you:

```bash
fleetherd update        # pull; if the image changed, recreate, wait for the hosts, prune the old image
fleetherd update --dry-run
fleetherd status        # version, the turns and scheduled runs in progress, and a restart waiting for them
fleetherd logs          # docker logs -t --tail 200
fleetherd doctor        # anything else runs the fleetherd CLI inside the container
```

If a turn or a scheduled run is in progress, `update` and `restart` list them and let the gateway
finish them first. The rest goes on in the background and the command returns at once, so an agent
asked to update the gateway can end its own turn. The log is `update.log` in the compose directory.
`--force` stops the gateway at once, cutting off what is in progress. The compose file is read from
`~/apps/fleetherd` (`FLEETHERD_APP_DIR` changes it).
