# 在容器里运行

[English](../docker.md) | 简体中文

`ghcr.io/noir017/fleetherd` 只有网关本身：Node、ssh 客户端和 fleetherd，不带任何智能体。所有智能体都跑在
[远程主机](remote-hosts.md)上，所以这个容器只需要能经 ssh 连到那些主机、经 HTTPS 连到聊天平台。每次发版都会
发布 `X.Y.Z` 并更新 `latest`，提供 amd64 和 arm64 两种架构。

```yaml
# docker-compose.yml
services:
  fleetherd:
    image: ghcr.io/noir017/fleetherd:latest
    container_name: fleetherd
    restart: unless-stopped
    stop_grace_period: 32m           # 留时间让正在跑的轮次跑完（见「更新」）
    environment:
      - TZ=Asia/Shanghai
    ports:
      - "127.0.0.1:8787:8787"        # 用网页端时才需要
    volumes:
      - ./config:/home/fleetherd/.config/fleetherd
```

```yaml
# config/config.yaml
version: 1
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}              # 取自 config/.env
    host: 0.0.0.0                    # 发布的端口转到容器自己的网卡上，不是回环地址
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

然后按[远程主机](remote-hosts.md#配置一台主机)里的步骤配好密钥和主机。密钥和 `known_hosts` 放在这里的
`config/ssh/`，也就是容器里的 `~/.config/fleetherd/ssh/`。在容器里生成密钥，文件的属主才对：

```bash
docker compose run --rm fleetherd sh -c \
  'mkdir -p -m 700 ~/.config/fleetherd/ssh && ssh-keygen -t ed25519 -N "" -f ~/.config/fleetherd/ssh/id_ed25519 -C fleetherd'
docker compose run --rm fleetherd fleetherd doctor
docker compose up -d
```

## 需要知道的

- **运行账号是 uid 1001。** 挂进去的 `config/` 必须属于它。想换成别的 uid，用 `docker/Dockerfile` 加
  `--build-arg UID=… --build-arg GID=…` 自己构建。
- **容器里不跑智能体。** 镜像去掉了 `harness: claude` 在本机运行时要用的 Claude Code 二进制（约 220 MB），
  所以没写 `host:` 的智能体会启动失败，报 "native binary not found"。
- **日志用 `docker logs fleetherd` 看**（加 `-t` 显示时间）。不写日志文件。
- **重启容器会停掉它在各主机上起的智能体。** 更新就是一次重启。网关会先让正在跑的轮次跑完，见[更新](#更新)。
  另见[断网时](remote-hosts.md#断网时)。
- **[网页端](web-ui.md#终端)的终端面板**通过 unix socket 代理到一个 ttyd。ttyd 在某台主机上时，挂一个两个容器
  共用的目录，把 `terminal.socket` 指向其中的 socket。ttyd 必须和网关用同一个 uid 运行。
  `terminal.endCommand` 在这个容器里执行，所以要用网关的密钥经 ssh 去关主机上的 tmux：

  ```yaml
  terminal:
    enabled: true
    socket: /run/webui-term/webui-term.sock
    endCommand: [ssh, -F, none, -o, BatchMode=yes, -i, /home/fleetherd/.config/fleetherd/ssh/id_ed25519,
                 -o, UserKnownHostsFile=/home/fleetherd/.config/fleetherd/ssh/known_hosts,
                 -o, StrictHostKeyChecking=yes, me@devbox,
                 tmux, -L, web, kill-session, -t, "web-{topic}"]
  ```

## 更新

```bash
docker compose pull && docker compose up -d
```

停止容器时，网关收到的是 SIGTERM。如果有轮次或定时任务正在跑，网关会等它们跑完再停，最多等 30 分钟。等待期间：

- 每个有轮次在跑的会话会收到一句提示，说明重启在等它；
- 会开启新轮次的消息不交给智能体，网关回一句「等它回来后再发一次」；
- 发给正在工作的会话的消息、`/stop`、对问题的回答都照常处理；
- 定时任务不再启动。等待期间到点的那次，会在网关重新启动后补跑。

Docker 默认只给容器 10 秒时间停止，除非 compose 文件像上面的例子一样设了 `stop_grace_period`。再发一次
SIGTERM，或者发 SIGINT（`docker stop --signal SIGINT fleetherd`），网关会立刻停止。

也可以把 `docker/fleetherd-host` 装成宿主机上的 `fleetherd` 命令
（`sudo install -m 755 docker/fleetherd-host /usr/local/bin/fleetherd`），它会替你处理这些：

```bash
fleetherd update        # 拉镜像；镜像变了就重建容器、等各主机连回来、清掉旧镜像
fleetherd update --dry-run
fleetherd status        # 版本、正在跑的轮次和定时任务，以及有没有重启在等它们
fleetherd logs          # docker logs -t --tail 200
fleetherd doctor        # 其余参数都交给容器里的 fleetherd CLI
```

有轮次或定时任务正在跑时，`update` 和 `restart` 会列出它们，并让网关先跑完。后面的步骤转到后台进行，命令立刻返回，
这样即使是让智能体去更新网关，它这一轮也能先结束。日志在 compose 目录下的 `update.log`。`--force` 会立刻停掉网关，
切断正在跑的东西。compose 文件默认读 `~/apps/fleetherd` 里的（`FLEETHERD_APP_DIR` 可以改）。
