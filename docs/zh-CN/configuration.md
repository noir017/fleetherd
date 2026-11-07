# 配置

[English](../configuration.md) | 简体中文

`~/.config/talkcode/config.yaml`，或用 `--config <path>` 指定。`talkcode setup` 会写出一份能用的；
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
    ssh: me@10.0.0.5:22
    # identityFile: ~/.config/talkcode/ssh/id_ed25519   （默认）
    # knownHostsFile: ~/.config/talkcode/ssh/known_hosts （默认）

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
```

`${VAR}` 从环境变量及 `<配置目录>/.env` 展开，YAML 本身可以提交进仓库。

> [!WARNING]
> 除非设成 [`permissions: ask`](agents.md#权限请求)，智能体拥有完整工具权限。`access.allowFrom` 留空意味着任何能给机器人发消息的人
> 都能在你的机器上执行命令——共享部署务必填写白名单。

其余配置在用到它的地方讲：各 harness 的选项见[智能体](agents.md)，网页端的 `terminal:`、`sso:`
见[网页端](web-ui.md)，`title:` 见[话题命名](topic-names.md)，`voice:` 见[语音消息](voice.md)，`hosts:` 和
`agents[].host` 见[远程主机](remote-hosts.md)，`agents[].hooks` 见
[智能体](agents.md#启动前钩子)，`review:` 和 `skills:` 见[技能](skills.md)，`delegation:` 见
[子代理](sub-agents.md)。
其中几项也能在聊天里直接改、不用重启——见[在聊天里改配置](settings.md)。

## 守护进程运行时改配置

改完文件，在任意聊天里发 `/reload`。如果是智能体改的配置，它也可以执行 `talkcode reload`（这是反向命令，
只能在会话里用）。守护进程会重新读取 `config.yaml` 和 `.env`，并回复改了什么：

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

所有命令均接受 `-c, --config <path>`，并将结构化输出写到 stdout。
