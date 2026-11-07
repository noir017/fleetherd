# 智能体

[English](../agents.md) | 简体中文

| Harness | 启动方式 | 额外安装 | 认证 |
|---|---|---|---|
| `claude` | 内置 [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | 无 | `claude /login` 或 `ANTHROPIC_API_KEY` |
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)（`npm i -g`） | Codex CLI 登录态 |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode 登录态 |
| `agy` | `agy acp` | Antigravity CLI 1.5+ | `agy` 的 Google 登录态（系统钥匙串） |
| `custom` | 你的 `command` + `args` | 任意 ACP 可执行文件 | 由智能体自身决定 |

每个智能体可设 `cwd`、`env`、`args`、尽力传递的 `model`、[启动前钩子](#启动前钩子)，以及[权限策略](#权限请求)。
设了 `host:` 就跑在另一台机器上、经 ssh 连接，见[远程主机](remote-hosts.md)。支持会话恢复
的智能体，上下文可跨重启保留；智能体自己声明的斜杠命令不会全局注册，而是通过
它的 `/<agent>` 菜单调出（见[聊天命令](chat-commands.md#智能体命令)）。
`doctor` 会逐一校验已配置的 harness。

## 启动前钩子

`hooks.preLaunch` 是一条命令。每次启动智能体进程之前，守护进程都会先跑它，
等它结束再启动。这包括会话的第一条消息、`/new`，以及空闲回收或崩溃后的重启。
智能体启动前必须就位的东西可以放在这里：

```yaml
agents:
  - id: boxed
    harness: custom
    command: docker
    args: [exec, -i, my-agent, my-agent, --acp]
    hooks:
      preLaunch: docker start my-agent >/dev/null
```

- 用 `bash -lc` 执行，工作目录是会话的目录，环境变量用智能体的 `env`。所有 harness
  都能用，不限于 `custom`。
- 每个智能体进程启动前跑一次。每个会话有自己的进程，所以钩子会跑很多次，
  要能重复执行。
- 非 0 退出或超过 60 秒没结束，这一轮就会失败，并附上它最后的输出，智能体也不会启动。
  下一条消息会重新尝试。
- 钩子运行期间发 `/stop` 会取消它。
- 它留在后台的进程（`ssh -fN`、`cmd &`）会继续运行，守护进程不会等它们。
- 最近 20 次的完整输出保存在 `~/.config/talkcode/hooks/<agent-id>/`。
- `${VAR}` 和其他配置字符串一样，在加载配置时展开。想让 shell 在运行钩子时再展开，
  就写 `$VAR`。

钩子不能在聊天里（`/setting`）修改，否则就等于允许从聊天里在你的机器上执行任意命令。

## 一轮失败之后

默认情况下，一轮失败会显示 ❌ 和原因，然后等你处理。`hooks.turnFailed` 可以多做两件事：
对那些通常会自己恢复的失败自动继续，以及跑一条命令来提醒你。

```yaml
agents:
  - id: cc
    harness: claude
    hooks:
      turnFailed:
        continue:
          on: [service, connection, limit, hung, restart]   # 默认值
          message: 继续          # 像你亲手输入一样发给智能体（默认：continue）
          max: 3                # 最多连续几次（默认 3）
          backoffMs: 30000      # 第一次等多久；每次翻倍，最多 10 分钟
        command: curl -s -d "$TALKCODE_TURN_FAILURE" https://ntfy.sh/my-topic
```

`on` 可以写的原因：

| 原因 | 发生了什么 |
|---|---|
| `service`、`limit`、`connection`、`access`、`request` | 模型服务出错：故障、频率或用量限制、连接断开、登录问题、请求被拒。Claude Code 会报这几种；harness 以 `refusal` 结束并写明原因时也会归到这几类 |
| `provider` | 模型服务出错，但智能体没给出具体类型 |
| `hung` | 智能体 10 分钟没有任何输出 |
| `startup` | 智能体进程没能启动 |
| `preLaunch` | [启动前钩子](#启动前钩子)失败 |
| `restart` | 这一轮进行中网关停了（网关重新启动时发现） |
| `other` | 其他所有情况，包括不报失败类型的 harness 的所有失败 |

- 每次自动继续前都会先在聊天里说明（`↻ … sending "继续" in 30s (1/3)`），然后作为单独的一轮发出。
  等待期间你发任何消息、`/stop`、`/new` 或 `/kill` 都会取消它。
- 一轮正常结束会把计数清零。连续失败 `max` 次后，聊天里会说明不再继续，这个话题会被列为失败。
- 默认列表里没有 `access` 和 `request`，因为没登录、请求被拒（包括没写原因的拒答），继续多少次也没用。
- `command` 在每次失败后运行，在智能体自己的机器上用 `bash -lc` 执行。失败信息以 JSON 放在
  `$TALKCODE_TURN_FAILURE` 里：`agent`、`conversation`、`reason`、`message`、`at`，安排了自动继续时还有
  `continuing`。它不影响这一轮，输出保存在 `~/.config/talkcode/hooks/<agent-id>/`。
- 被重启打断的一轮，网关回来后会在它的话题里说明（`⚠️ The gateway restarted before this turn
  finished`），不管有没有自动继续。

ACP 智能体也可能以 `stopReason: refusal` 结束一轮，而不是给出回答——CodeBuddy 在上游拒绝请求时
会这样，模型自己拒答时也会。写明原因的 refusal 一律算失败，即使这一轮已经输出过文字或开过工具：
是上游拒绝了这一轮，原因按普通服务故障归类（额度拒绝是 `limit`，默认列表会继续）。没写原因的
是模型自己拒答：只有这一轮没有任何可见输出才算失败，归为 `request`；已经先发过解释的（Claude
会把拒答解释当普通消息发出来）正常结束，那段解释就是回答。

## 权限请求

有的智能体在用工具前会先请求权限：Claude Code 在默认模式下，执行命令、改文件都会问。默认
（`permissions: auto`）守护进程会全部批准，智能体拥有完整工具权限，唯一的门禁是 `access.allowFrom`。
设成 `permissions: ask` 就改成问你：

```yaml
agents:
  - id: cc
    harness: claude
    permissions: ask
```

- 每个请求会在聊天里发一条消息，写着要执行的命令，按钮是智能体自己给的选项（「Allow」「Reject」等）。
  点按钮作答；直接打字的话，那句话会作为你的下一条消息交给智能体。
- 1 小时没人点就自动拒绝。智能体会被明确告知是没人回应，不是你拒绝的，这一轮继续进行。半小时时会提醒一次。
- `/stop` 会连同这一轮一起取消待处理的请求。
- 定时任务始终自动批准，因为没人在场作答。
- 没有按钮的平台（钉钉、企业微信）没法问，请求会被拒绝，同样会告诉智能体原因。
- 只影响会请求权限的智能体。实测 Codex（`agent` 模式）和 OpenCode 执行写文件的命令时都没有问；`agy` 执行命令前会问，在工作目录里写文件不问。

## Antigravity（`agy`）

`agy` 以 `agy acp` 运行——agy 从 1.5 起自带的 ACP 服务端——所以流式输出、工具气泡、
[权限请求](#权限请求)、多轮上下文、重启续接、`/model`、`/effort`、`/stop`、skills 和两个
[原生工具](agent-actions.md)都与其他 ACP harness 一致。不同之处：

- **它自带的斜杠命令改由独立进程应答。** `/usage`、`/credits` 以及 `agy -p /help` 列出的其余
  命令由 agy 的 CLI 应答，不归会话管——当成消息发进去，agy 会把它当成问题交给模型。守护进程改用
  一次性的 `agy -p=/<name>` 回答这些命令。
- **模型按 `agy acp` 的叫法。** `/model` 里是 `gemini-3.8-flash`，思考档位在 `/effort` 下（仅
  Gemini 有）。按 `agy models` 的旧写法（`gemini-3.8-flash-high`）写在 `model:` 里、或对话之前选过
  的，照样能用：会被拆成模型加档位。agy 在会话重新加载时会忘掉模型，守护进程每次加载后都会重新设上。
- **上下文数字来自 agy 的会话记录。** agy 每轮只报一次 token 用量，是这一轮所有模型调用的总和，
  只有只调一次模型的一轮，这个数才是上下文。调过工具的一轮，守护进程到智能体所在机器上读这个会话自己的
  记录（`~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript.jsonl`），取最后一次
  调用的数，一轮结束时读一次，进行中每隔几秒读一次；读不到这个文件时，这样的一轮不显示。agy 从不告诉窗口有多大，
  所以守护进程只认得实测过的模型（Gemini、Claude Sonnet/Opus 4.6、GPT-OSS 120B），或者用智能体的
  `contextWindow`；配了 `contextBudget` 时，按 agy 的压缩点显示。
- **压缩点可以挪：`contextBudget`。** agy 在哪儿压缩由 Google 按模型决定，随它启动时拉取的模型列表
  下发：Gemini 3.8 Flash 窗口 1M，却在 256k 压缩；Claude 4.6 在 160k。本机上没有任何办法改它——agy 的
  设置、`AGY_CLI_AUTO_COMPACT_OVERRIDE` 都不行。写上 `contextBudget: 900000`，守护进程会让 agy 走一个
  *中继*：智能体所在机器 127.0.0.1 上的一个监听端口，通过 `CLOUD_CODE_URL` 指给 agy。它把所有请求原样
  转发，包括流式的模型调用，只改一处：模型列表里，窗口（减去输出预留）装得下这个预算的模型，压缩点改成
  这个值，其余模型保持 Google 给的。智能体在 `env` 里自己设了 `CLOUD_CODE_URL` 的，照样生效——中继转发
  到那里。中继打不开时，智能体不带中继启动，按 Google 的值压缩，日志里写明原因。在 agy 1.5.2 上实测
  （2026-11-07），已确认 Gemini 3.8 Flash 上下文到 600k 可用。代价是每次模型调用带的上下文更长，额度
  用得更快。

  ```yaml
  agents:
    - id: ag
      harness: agy
      contextBudget: 900000
  ```
- **额度来自它的 CLI**：`agy -p=/usage`，与一轮同时进行，最多每分钟一次，精度是整数百分比。
- **agy 自己的警告是通知，不进回复正文。** 重试（「API error (attempt 1) …」）只提示一次；以警告收尾
  的一轮——额度用完、重试耗尽、服务器过载——按失败处理，`hooks.turnFailed` 能看到（归为 `provider`）。
- **一轮中途发的消息要等这一轮结束**：`agy acp` 没有并入正在跑的那一轮的办法。
- **skills** 从 `<cwd>/.agents/skills`、`~/.agents/skills`、
  `~/.gemini/antigravity-cli/skills`、`~/.gemini/skills`、`~/.gemini/config/skills`
  读取，所以 `/skills` 能列出它们，`/<名字> <请求>` 能直接调用。

`args` 追加在 `agy acp` 之后（见 `agy acp --help`）。

> [!NOTE]
> Google 的 FAQ 声明：用第三方工具访问 Antigravity 违反其服务条款，可能导致
> 账号封禁。本 harness 只调用 agy 官方自带的接口（`agy acp`），且完全不接触你的
> 凭据（登录全程在 `agy` 内部完成），但守护进程终究是一个非 Google 客户端在
> 驱动你的账号——请自行判断。`contextBudget` 走得更远：它的中继会经手 agy 的
> 请求，包括登录 token（只转发，不读取、不保存），并且改动了 Google 服务端
> 告诉 agy 的内容。
