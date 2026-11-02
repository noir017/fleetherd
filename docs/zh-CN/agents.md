# 智能体

[English](../agents.md) | 简体中文

| Harness | 启动方式 | 额外安装 | 认证 |
|---|---|---|---|
| `claude` | 内置 [claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | 无 | `claude /login` 或 `ANTHROPIC_API_KEY` |
| `codex` | `codex-acp` | [@agentclientprotocol/codex-acp](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)（`npm i -g`） | Codex CLI 登录态 |
| `opencode` | `opencode acp` | OpenCode CLI | OpenCode 登录态 |
| `agy` | `agy --input-format stream-json` | Antigravity CLI | `agy` 的 Google 登录态（系统钥匙串） |
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
| `service`、`limit`、`connection`、`access`、`request` | 模型服务出错：故障、频率或用量限制、连接断开、登录问题、请求被拒。只有 Claude Code 会报这几种 |
| `provider` | 模型服务出错，但智能体没给出具体类型 |
| `hung` | 智能体 10 分钟没有任何输出 |
| `startup` | 智能体进程没能启动 |
| `preLaunch` | [启动前钩子](#启动前钩子)失败 |
| `restart` | 这一轮进行中网关停了（网关重新启动时发现） |
| `other` | 其他所有情况，包括不报失败类型的 harness 的所有失败 |

- 每次自动继续前都会先在聊天里说明（`↻ … sending "继续" in 30s (1/3)`），然后作为单独的一轮发出。
  等待期间你发任何消息、`/stop`、`/new` 或 `/kill` 都会取消它。
- 一轮正常结束会把计数清零。连续失败 `max` 次后，聊天里会说明不再继续，这个话题会被列为失败。
- 默认列表里没有 `access` 和 `request`，因为没登录、请求被拒，继续多少次也没用。
- `command` 在每次失败后运行，在智能体自己的机器上用 `bash -lc` 执行。失败信息以 JSON 放在
  `$TALKCODE_TURN_FAILURE` 里：`agent`、`conversation`、`reason`、`message`、`at`，安排了自动继续时还有
  `continuing`。它不影响这一轮，输出保存在 `~/.config/talkcode/hooks/<agent-id>/`。
- 被重启打断的一轮，网关回来后会在它的话题里说明（`⚠️ The gateway restarted before this turn
  finished`），不管有没有自动继续。

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
- 只影响会请求权限的智能体。实测 Codex（`agent` 模式）和 OpenCode 执行写文件的命令时都没有问；`agy` 不能设成 `ask`。

## Antigravity（`agy`）

`agy` 是唯一不说 ACP 的预设——它根本没有 ACP 模式——因此改用它自带的
[headless stream-json 协议](https://antigravity.google/docs/cli/headless/)驱动。
流式输出、工具气泡、多轮上下文、重启续接、skills、`/model`、`/context`、`/usage`
都与 ACP 预设一致；不同的是后三者从哪里取——agy 把它们各自发布在会话之外：

- **它自带的斜杠命令改由独立进程应答。** 在 stream-json 模式下，由 CLI 自己应答的
  斜杠（`/model`、`/usage`、`/credits` 等）会直接中止整个会话，因此守护进程用一次性
  的 `agy -p=/<name>` 回答这十一个命令，绝不转发进会话。其余输入——首先是你的
  **skills**——照常进入会话并正常展开。
- **上下文占用来自 agy 的输出流，额度和默认模型来自它的 CLI。** agy 1.4.7 起，每个
  模型步骤都会上报自己的 token 数，页脚拿它对比模型的上下文窗口来显示。agy 从不告诉
  窗口有多大，所以守护进程只认得实测过的模型（Gemini、Claude Sonnet/Opus 4.6、
  GPT-OSS 120B），其他模型不显示上下文数字。额度池，以及没配置模型时 agy 的默认模型，
  在这一轮进行的同时用 `agy -p=/usage` 和 `agy -p=/model` 取回——额度最多每分钟查
  一次，精度是整数百分比。
- **agy 低于 1.4.7 时，这三样都来自它的状态栏**：守护进程启动时先备份一次
  `~/.gemini/antigravity-cli/settings.json`，再把其中的 `statusLine` 指向自己的 shim，
  由它通过一条管道把数字交回守护进程，也照样为你的终端画出状态栏。agy 1.4.7 在无头
  模式下不再运行状态栏，但守护进程仍会安装这个 shim，供旧版本和你自己交互使用的 agy
  使用。设 `TALKCODE_NO_AGY_STATUSLINE=1` 可以不动这项配置。
- **skills** 从 `<cwd>/.agents/skills`、`~/.agents/skills`、
  `~/.gemini/antigravity-cli/skills`、`~/.gemini/skills`、`~/.gemini/config/skills`
  读取，所以 `/skills` 能列出它们，`/<名字> <请求>` 能直接调用。
- **`/new` 开启新对话**，与其他 harness 一致。停下当轮（`/stop`）会重启子进程并续接同一
  对话，因此上下文不会丢失。
- **一轮中途发的消息要等这一轮结束**：agy 的 stream-json 输入把每条消息当成单独的一轮，
  没有办法并入正在跑的那一轮。
- **你发的图片只以路径交给它。** stream-json 输入只收文字，所以走 ACP 的 harness 能直接看到图片，
  agy 拿到的是图片存放的位置。

守护进程的所有默认参数都可通过 `args` 覆盖（它们追加在默认值之后，而 agy 的
参数解析是后者生效）。

> [!NOTE]
> Google 的 FAQ 声明：用第三方工具访问 Antigravity 违反其服务条款，可能导致
> 账号封禁。本 harness 只调用 agy 官方自带的 headless 接口，且完全不接触你的
> 凭据（登录全程在 `agy` 内部完成），但守护进程终究是一个非 Google 客户端在
> 驱动你的账号——请自行判断。
