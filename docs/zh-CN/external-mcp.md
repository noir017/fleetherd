# 外部调用方：MCP 入口

[English](../external-mcp.md) | 简体中文

网关之外的程序——比如经 MCP 代理接进来的 Gemini 这类网页智能体——可以通过网关在 HTTP 上提供的 MCP
服务，搜索你的[技能](skills.md)、只读查询[会话库](conversation-history.md)、向你的智能体提议[子任务](sub-agents.md)。它提议的任何事，你在网页端点 Start 之前都不会开始。

config.yaml 里没有 `mcp:` 块时，这个入口是关着的。

```yaml
mcp:
  host: 127.0.0.1        # 默认；只放在回环或内网上——这里没有 TLS
  port: 8790             # 默认
  # platform: web        # 它的话题开在哪个网页端实例（默认：第一个 webui 实例）
  callers:
    - name: gemini                          # 显示在它的话题和卡片上
      tokenEnv: FLEETHERD_MCP_GEMINI_TOKEN  # 存它 token 的环境变量名——不是 token 本身
      tools: [skills, tasks, sessions]
      # agents: [gemini-task]               # 可选：允许该调用方把子任务直接挂到已绑定这些智能体的真实话题下
      # trusted: true                       # 可选（默认 false）：显式信任该调用方，开放完整读写与运维能力
```

token 放在配置目录的 `.env` 里（或网关的环境变量里）：

```sh
FLEETHERD_MCP_GEMINI_TOKEN=<至少 24 个随机字符，比如 openssl rand -hex 32>
```

调用方用 MCP（Streamable HTTP）访问 `http://<host>:<port>/mcp`，带上 `Authorization: Bearer <token>`。

## 调用方能做什么

三个工具，且只有给它列出的那几个：

- **`skills`** —— `search` 和 `show`。调用方只能读技能库，不能新建、修改或归档技能。限定了主机或
  harness 的技能（`fleetherd-hosts`、`fleetherd-harnesses`）对它不可见。它的搜索和智能体的一样记日志，
  记在 `external:<名字>` 下。
- **`sessions`** —— 只读查询网关的会话库（`list`、`search`、`read`），按调用方显式授权开启。`read`
  支持会话 `#id`、完整话题键（如 `web:main/2e233c24`）或无歧义的 8 位短话题 ID，并支持相同的过滤参数
  （`reply: true`、`around` / `window`、`role`、`turn`、`turns`、`since`、`grep`、`tail`、`limit`）。
  只读不写，也不触发任何轮次。
- **`tasks`** —— 子任务，每次一个 `action`：

  | action | 作用 |
  |---|---|
  | `open` | 在网页端开一个它自己的话题，名为 `[<调用方>] <标题>`；返回话题 id |
  | `agents` | 哪些智能体能接子任务，各自能在哪些目录启动；带 `agent` 时列出那一个的全部信息——模型、每个设置的取值和说明、权限级别、忙闲（会起一个它的会话来问，不跑任何提示词） |
  | `new` | 在那个话题里提议一个子任务：`topic`、`agent`、`text`（另有 `cwd`、`title`、`model`、`option`——智能体自己的设置，写成 `key=value`，多个用逗号隔开，如 `account=alice@example.com`） |
  | `list` | 带 `topic` 时列出它的子任务和各自进度；不带时列出调用方自己的话题 |
  | `status` / `read` / `stop` | 某个子任务，用 `list` 打印的话题 id；`read` 加 `reply: true` 是它的结论 |

  没有办法往正在跑的子任务里插话、发文件或建定时任务。

## 在网页端

调用方开的话题由你来看，里面不跑任何智能体：

- 每个子任务都先在那里出一张卡片，等你点 **Start**——不管 `/setting delegation` 怎么设。**Cancel** 就是拒绝；
  调用方不读这个话题，在里面打字回复不会传到任何人。
- 开跑的子任务各自开一个话题挂在它下面，你可以照常和那个智能体对话。
- 子任务结束、失败或提问时，调用方的话题里会出一行 🔔。调用方不会被通知，它自己用 `list` 和 `read` 查。
- 你在里面打的字由网关回答，不会交给智能体。在那里发 `/stop` 会停掉它下面的所有子任务。
- 智能体不能往里写：发往这个话题的消息、文件、提问和定时任务都会被拒绝。里面出现的内容都来自网关。

调用方只能看到、只能停掉它自己开的话题下的子任务；同时最多持有 10 个话题——网页端开新话题时会挤掉你最久没动、
没加星的话题，不能让调用方把你的话题挤掉。删掉它的一个话题就空出一个名额。

如果调用方额外配置了 `agents:`（例如 `agents: [gemini-task]`，同时匹配 `gemini-task` 与
`gemini-task@<host>`），跑在真实话题里的 `connect` 智能体可以直接把当前话题 id 传给 `tasks new` / `list`，
无需先调 `open` 新建空协调话题。子任务提议仍必弹 Start 确认卡、仍禁用 `task-send`，但子任务会直接挂在当前对话下，
完成后也会自动唤醒该智能体汇报结果。

## 完整信任模式（`trusted: true`）

对由你本人直接控制、走私有 MCP 代理接入的主力智能体（如 `gwt`），可在对应 `callers` 项加上 `trusted: true`：

- **`tasks`**：开放 `send`（含 `interrupt` / `forward`）、`new` 支持 `reviewBy` / `review` / `rounds` 自动审核闭环、`read` 补齐 `role` / `turns` / `since` / `grep`；在 `agents:` 命中的真实话题下遵循网关的 `/setting delegation` 设置（不再强制每次弹 Start 卡）。
- **`skills`**：在同一个工具里开放完整读写与管理（`create / patch / write-file / remove-file / list / categories / history / revert / archive / restore / pin / unpin`），可修改 `fleetherd-resident`。
- **扩展工具**（仅 `trusted: true` 时允许在 `tools` 中配置）：
  - `schedule`：定时/循环任务完整管理（`add / list / show / edit / pause / resume / run / rm`）；
  - `send_file`：往指定 `topic` / `channel` 发送文件或图片附件；
  - `messages`：`channels / send / reply / edit / react / delete / fetch / thread / ask / voice_log`；
  - `gateway`：`pods / pod_add / pod_remove / reload`。

## 吊销调用方

从 `callers` 里删掉它（或从 `.env` 里删掉它的变量），再 `/reload`：它的下一次调用就会被拒。
改 `host` 或 `port` 也是 `/reload` 后生效。

## 说明

- 网页端的登录密钥不能当调用方的 token：变量里放的是登录密钥、不到 24 个字符或者没设置的调用方都会被拒，
  守护进程日志里写明原因。
- 带 `Origin` 头的请求一律拒绝——浏览器没有理由调用这里。
- 调用方读的是没人审过的网页和邮件，它提议的内容要当作是那些内容的作者写的：点 Start 前先看卡片。
