<div align="center">

# talkcode

**让你的编码智能体进驻每一个聊天软件。**

[![CI](https://github.com/noir017/talkcode/actions/workflows/ci.yml/badge.svg)](https://github.com/noir017/talkcode/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) | 简体中文

</div>

一个网关守护进程，将聊天平台接入你的编码智能体——支持
[Agent Client Protocol](https://agentclientprotocol.com) 的 Claude
Code、Codex、OpenCode，以及 Google 的 Antigravity CLI。给机器人发消息，
智能体在你自己的机器上运行，回答以流式写入同一条消息、原地编辑。

本项目 fork 自 [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere)，2.0.0 之前名为
`agent-anywhere`。

![内置网页端：Claude Code 找出并修好一个挂掉的测试，含工具调用、回答，以及上下文与花费状态栏](docs/images/webui.png)

<p align="center"><sub>内置网页端——不需要任何聊天平台。同样的对话在 Telegram、Discord、Slack、飞书等平台上也一样。</sub></p>

```text
 Discord ───┐
 Telegram ──┤     ┌──────────────────────┐
 Slack ─────┤     │        daemon        │       ┌─► claude
 Lark ──────┤     │  routing · sessions  │◄─────►├─► codex
 QQ ────────┼────►│  streaming · access  │       ├─► opencode
 LINE ──────┤     └──────────▲───────────┘       ├─► agy
 WeCom ─────┤                │ unix socket       └─► custom
 DingTalk ──┤                └─ talkcode CLI (send-file / ask / react …)
 网页端 ────┘  （守护进程自带的浏览器页面——不用注册机器人，也不用账号）
```

## 特性

- **八个平台，一个进程** —— Discord、Telegram、Slack、飞书、QQ、LINE、企业微信、钉钉；支持多账号。[→](docs/zh-CN/platforms.md)
- **也可以一个平台都不用** —— 就是上图的[网页端](docs/zh-CN/web-ui.md)，一个共享密钥或你的 SSO 登录，可选开终端。
- **任意 ACP 智能体，外加 agy** —— Claude Code、Codex、OpenCode、Antigravity 或 `custom`；按平台、频道、用户或命令路由。[→](docs/zh-CN/agents.md)
- **原生流式体验** —— 消息原地编辑、工具调用气泡、生命周期回应表情。
- **干活时也能发消息** —— 一轮中途发的消息并入正在跑的这一轮，不会打断它，和在 Claude Code 自己的命令行里边跑边打字一样；要停用 `/stop`。[→](docs/zh-CN/chat-commands.md#智能体干活时发消息)
- **附件处理** —— 你发的图片和文件自动下载并交给智能体。
- **跑在别的机器上的智能体** —— 智能体可以跑在网关经 ssh 能连到的任意 Linux 主机上；断网时继续干活，`/agent` 按机器选择。[→](docs/zh-CN/remote-hosts.md)
- **话题即会话** —— Telegram 话题、飞书话题、Slack 线程、Discord 子区，各自绑定智能体、各自的[工作目录](docs/zh-CN/working-directory.md)，并[自动命名](docs/zh-CN/topic-names.md)。
- **持久会话** —— 重启不丢；`/new`、`/stop`、`/kill`；闲置的智能体进程会释放，下一条消息再从原处恢复。[→](docs/zh-CN/chat-commands.md)
- **在聊天中行动** —— 智能体可发文件、发按钮提问、引用回复、加回应、读历史。[→](docs/zh-CN/agent-actions.md)
- **子代理和待办列表** —— `/super <任务>`：智能体把活拆开，经你确认后交给几个智能体在挂在它下面的话题里同时干，再检查结果、汇报给你。网页端列出所有在等你的事，还能推送到手机。[→](docs/zh-CN/sub-agents.md)
- **失败后自动继续** —— 上游故障导致一轮失败时，可以用你自己的话自动继续，并跑一条命令提醒你。[→](docs/zh-CN/agents.md#一轮失败之后)
- **定时任务** —— 「每天早上 8 点……」会变成网关自己保存的任务，重启不丢。[→](docs/zh-CN/scheduled-tasks.md)
- **工作偏好，所有智能体通用** —— 你希望怎么干活写一次，每台主机上的每个智能体都读得到；只适合某一种智能体的，另写一份给它。[→](docs/zh-CN/instructions.md)
- **会自己写自己的技能** —— 说「把这个记成技能」，智能体就建一个网关自己保存的技能，下发到每台主机上的每个智能体，有版本、能回滚，长期不用自动归档；指定复盘智能体后，闲下来的对话还会自己复盘。[→](docs/zh-CN/skills.md)
- **语音消息** —— 自动转写，先给你看，确认后再发。[→](docs/zh-CN/voice.md)
- **精简配置** —— 五个部分，支持 `${VAR}` 与 `.env` 展开；值得在聊天里改的那几项用 [`/setting`](docs/zh-CN/settings.md) 直接改。

## 快速开始

talkcode 没有发布到 npm。请安装[最新 Release](https://github.com/noir017/talkcode/releases/latest)
附带的 tarball，`X.Y.Z` 换成它的版本号：

```bash
npm install -g https://github.com/noir017/talkcode/releases/download/vX.Y.Z/talkcode-X.Y.Z.tgz

talkcode setup    # 向导：选平台、填凭据、选智能体
talkcode doctor   # 自检
talkcode start    # 给机器人发消息即可
```

`harness: claude` 复用本机的 `claude /login` 登录态——个人使用无需 API key。

<details>
<summary><strong>或者让你的智能体代劳</strong></summary>

把下面这段粘贴给 Claude Code（或任何编码智能体）：

```text
Set up https://github.com/noir017/talkcode for me: install the CLI
from the latest GitHub release's talkcode-X.Y.Z.tgz (npm i -g <its URL>;
it is not on npm), then follow the skill bundled in the installed
package (skill/SKILL.md, under `npm root -g`/talkcode) to configure
and start it.
```

</details>

最小可用的 `~/.config/talkcode/config.yaml` 就是网页端加一个智能体：

```yaml
version: 1
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}       # 网页登录时要输的密码；${VAR} 也会读 <配置目录>/.env
agents:
  - id: claude
    harness: claude
    cwd: ~/projects
routing:
  default: claude
access:
  allowFrom: ["web:owner"]
```

然后打开 `http://<host>:8787`。其余的——更多平台、多个智能体、路由——见[配置](docs/zh-CN/configuration.md)。

> [!WARNING]
> 智能体拥有完整工具权限。`access.allowFrom` 留空意味着任何能给机器人发消息的人
> 都能在你的机器上执行命令——共享部署务必填写白名单。网页端默认在所有网卡上以明文
> HTTP 监听；要让它离开你掌控的网络之前，先读[对外暴露](docs/zh-CN/web-ui.md#对外暴露)。

## 文档

| | |
|---|---|
| [配置](docs/zh-CN/configuration.md) | config.yaml 全貌、`${VAR}` 与 `.env`、CLI |
| [智能体](docs/zh-CN/agents.md) | 各 harness、各需装什么、Antigravity 怎么驱动 |
| [平台](docs/zh-CN/platforms.md) | 各聊天平台能做什么、不能做什么 |
| [网页端](docs/zh-CN/web-ui.md) | 话题、终端、安全地对外暴露、单点登录 |
| [聊天命令](docs/zh-CN/chat-commands.md) | `/new` `/stop` `/kill`、智能体命令、`/model`、`/effort` |
| [远程主机](docs/zh-CN/remote-hosts.md) | 经 ssh 跑在别的机器上的智能体、`/agent`、断网时会怎样 |
| [在容器里运行](docs/zh-CN/docker.md) | 只含网关的镜像，智能体全在主机上 |
| [工作目录](docs/zh-CN/working-directory.md) | `/cd`：一个话题一个项目 |
| [话题命名](docs/zh-CN/topic-names.md) | `/title` 与自动命名 |
| [在聊天里改配置](docs/zh-CN/settings.md) | `/setting`：不重启就改 config.yaml |
| [语音消息](docs/zh-CN/voice.md) | 转写与确认 |
| [定时任务](docs/zh-CN/scheduled-tasks.md) | 定时跑提示词或命令 |
| [子代理](docs/zh-CN/sub-agents.md) | `/super`：把一件活拆给几个智能体并行干 |
| [以前的对话](docs/zh-CN/conversation-history.md) | `talkcode sessions`：搜索网关经手过的所有对话 |
| [网关自己维护的技能](docs/zh-CN/skills.md) | 所有智能体共用的技能：写、版本、归档、恢复 |
| [工作偏好](docs/zh-CN/instructions.md) | 一份给所有智能体的工作偏好，外加每种智能体各自一份 |
| [智能体能做什么](docs/zh-CN/agent-actions.md) | 按钮提问、发文件、内置 skill |

## 参与开发

[AGENTS.md](AGENTS.md) 记录了代码约定、分层规则与安全不变量，并索引了各模块文档
（[config](src/config/README.md) · [core](src/core/README.md) ·
[platform](src/platform/README.md) · [daemon](src/daemon/README.md) ·
[ipc](src/ipc/README.md) · [commands](src/commands/README.md)）。改代码前请先读它。

## 许可证

[MIT](LICENSE)

本项目起初是 [l0ng-ai/agent-anywhere](https://github.com/l0ng-ai/agent-anywhere) 在 `3d855f8`
处的一个分支，原作者的架构设计（尤其是 platform 的 profile 抽象层）至今仍是这套代码的骨架，
此后在其基础上做了大量扩展。上游的 MIT 版权声明保留在 [LICENSE](LICENSE) 中，该声明同时
覆盖两边的代码。
