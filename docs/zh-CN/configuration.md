# 配置

[English](../configuration.md) | 简体中文

`~/.config/fleetherd/config.yaml`，或用 `--config <path>` 指定。`fleetherd setup` 会写出一份能用的；
本页讲向导不问的那些——多个智能体、路由、同一平台多个账号。

```yaml
version: 1

platforms:                    # 命名实例；键即实例 id
  discord-main:
    type: discord             # discord|telegram|slack|lark|qq|line|wecom|dingtalk|webui
    token: ${DISCORD_TOKEN}   # 所有字符串支持 ${VAR}
    chat:
      requireMention: true    # 群聊需 @ 机器人
  telegram-bot:               # 同类型出现两次 = 多账号
    type: telegram
    token: ${TELEGRAM_TOKEN}

agents:                       # 至少一个；路由按 id 选取
  - id: claude
    harness: claude           # claude|codex|opencode|agy|custom
    cwd: ~/projects/main
  - id: codex
    harness: codex
  - id: ag
    harness: agy               # 也用它来复盘闲置对话（见下文）
  - id: claude-devbox
    harness: claude
    host: devbox              # 跑在另一台机器上，见远程主机
    group: 构建机              # /agent 按它分组（默认按主机）

hosts:                        # 可选；智能体所在的机器，经 ssh 连接
  devbox:
    ssh: me@192.0.2.5:22
    # identityFile: ~/.config/fleetherd/ssh/id_ed25519   （默认）
    # knownHostsFile: ~/.config/fleetherd/ssh/known_hosts （默认）

routing:
  default: claude
  pipeline:                   # 有序；首个匹配生效
    - when: { platform: telegram-bot }
      use: { agent: codex }
    - when: { command: codex } # "/codex fix the tests" → codex 智能体
      use: { agent: codex }

session:
  scope: per_thread           # per_thread|per_channel|per_user|shared
  idleTimeoutMs: 3600000      # 闲置 1 小时后停掉该会话的智能体进程；0 = 从不

access:
  allowFrom: ["discord-main:123456"]   # <实例id>:userId；留空 = 任何人

review:                       # 可选；不指定复盘者就是关闭
  agent: ag                   # 任意智能体；或者 api: {url, key, model} 用 OpenAI 兼容接口
  model: gemini-3.8-flash-high

skills:                       # 可选；自管技能共用的 git 仓库
  repo: ssh://git@git.example:22/you/agent-skills.git

workdir:                      # 可选；目录选择菜单（/cd、/new）
  sort: name                  # name（按字母序，默认）| frecency（按使用频率加权）
```

`${VAR}` 从环境变量及 `<配置目录>/.env` 展开，YAML 本身可以提交进仓库。

> [!WARNING]
> 除非设了会问人的[权限等级](agents.md#权限等级)，智能体拥有完整工具权限。`access.allowFrom` 留空意味着任何能给机器人发消息的人
> 都能在你的机器上执行命令——共享部署务必填写白名单。

其余配置在用到它的地方讲：各 harness 的选项见[智能体](agents.md)，网页端的 `terminal:`、`sso:`
见[网页端](web-ui.md)，`title:` 见[话题命名](topic-names.md)，`voice:` 见[语音消息](voice.md)，`hosts:` 和
`agents[].host` 见[远程主机](remote-hosts.md)，`agents[].hooks` 见
[智能体](agents.md#启动前钩子)，`review:` 和 `skills:` 见[技能](skills.md)，`delegation:` 见
[子代理](sub-agents.md)，`mcp:` 见[外部调用方](external-mcp.md)。
其中几项也能在聊天里直接改、不用重启——见[在聊天里改配置](settings.md)。

## 守护进程运行时改配置

改完文件，在任意聊天里发 `/reload`。如果是智能体改的配置，它也可以执行 `fleetherd reload`（这是反向命令，
只能在会话里用）。在会话之外的 POSIX 宿主机环境（脚本、systemd 或 Docker 宿主机包装命令 `fleetherd reload`）
中，可以直接向守护进程发送 `SIGHUP`（`kill -HUP <pid>` 或 `docker kill -s HUP fleetherd`）。守护进程会重新读取
`config.yaml`、`.env` 和远程节点 `pod.yaml`，在日志中打印变更摘要，并在聊天/CLI 触发时直接回复改了什么：

```
config.yaml reloaded.
- agents: added oc2; changed cc
- applied: routing
- conversations: 1 restart their agent on the next message
```

- 除 `platforms` 外都立即生效。`platforms` 的改动（换 token、加实例）会提示要重启守护进程才生效。
- 改了定义的智能体，在每个会话的下一条消息时重启进程，并接上原来的会话。正在进行的回复会先跑完。
  如果某个智能体的 harness 不支持恢复会话，已经在用它的会话会继续用旧定义，直到 `/new`。
- 新的 `model:` 和 `/setting` 一样只对新会话生效：接上的旧会话沿用原来的模型，发 `/new` 才会用新模型。
- 绑定在已删除智能体上的会话，会改由路由现在选中的智能体接手。
- 文件加载失败时什么都不会改，回复里会说明哪里错了。

## CLI

| 命令 | |
|---|---|
| `setup` | 交互式配置向导 |
| `doctor` | 自检（默认命令）；`--migrate-config` 升级 v0 配置文件 |
| `start` | 运行守护进程 |
| `<反向命令>` | 供智能体使用的聊天操作，见[在聊天中行动](agent-actions.md#在聊天中行动) |

所有命令均接受写在命令之前的 `-c, --config <path>`（`fleetherd -c <path> start`），并将结构化输出写到 stdout。写在命令之后的 `-c` 归该命令自己：聊天动作里是 `--channel`。

## Windows 支持

fleetherd 可在原生 Windows（PowerShell 或命令提示符）上直接运行（需 **Node.js ≥ 22**），支持本机智能体、所有聊天平台和内置网页端。如需完整 POSIX 工具链，也可运行在 **WSL2** 中（行为与 Linux 一致）。

### 前置条件（原生 Windows）

- 已安装 **Node.js ≥ 22** 并加入 `PATH`。
- 如需使用网页端 Git 变更面板、每轮文件改动摘要或自管技能仓库，请安装 **Git for Windows**。
- 如需使用[统一工作偏好](instructions.md)，建议开启 **Windows 开发者模式**（设置 → 系统 → 开发者选项）：目录技能使用 NTFS Junction（无需管理员权限），而单文件指令依赖文件符号链接。

### 原生 Windows 下的行为差异

- **IPC 通信**：守护进程默认监听按配置目录隔离的 Windows 命名管道（`\\.\pipe\fleetherd-<hash>`），而非 Unix 域套接字；仍可通过 `ipc.socketPath` 手动覆盖。
- **反向 CLI 垫片**：在 `<configDir>\bin\` 下同时生成 `.cmd`（供 `cmd.exe` / PowerShell 使用）和 POSIX `#!/bin/sh` 脚本（供 Git Bash / MSYS2 子 shell 使用），覆盖 `fleetherd` 与 `talkcode` 两个命令名。
- **配置热重载**：Windows 不使用 `SIGHUP` 触发重载，请通过聊天中的 `/reload` 或智能体会话里的 `fleetherd reload` 重载配置。
- **定时 Shell 任务与 `quotaCommand`**：本机定时命令和配额命令通过 `%ComSpec% /d /s /c` 执行，而非 `bash -lc`。

### 已知系统边界

- **远程 SSH 主机（`hosts:`）**：网关本身可运行在 Windows 上并通过 OpenSSH 连接远端 Linux 主机，但远端助手二进制 `fleetherd-remote` 仅支持 **Linux（amd64 / arm64）**，Windows 机器不能作为 `hosts:` 远端受控节点。
- **网页端内嵌终端**：可选的 `terminal:` 面板依赖基于 Unix 套接字的 `ttyd` + `tmux` 桥接（仅限 Linux / macOS / WSL2）。
- **Antigravity 后台等待插件**：`agy-plugin/wait-background.sh` 为 POSIX Shell 钩子；在原生 Windows 上 `agy` 仍可正常运行，但后台长任务不会自动保持回合开启。
