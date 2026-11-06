# 智能体在聊天里能做什么

[English](../agent-actions.md) | 简体中文

## 向你提问

当智能体需要一个它替你做不了的决定时，它会**问**——以按钮的形式发进聊天，然后等你点：

> **这个项目用哪个数据库？**
> **PostgreSQL** — 你这台机器已经在跑 pgvector，直接复用零成本。
> **MySQL** — 生态更广，但本机还没有现成实例。
>
> `[ PostgreSQL ]` `[ MySQL ]`

这是模型自己的提问工具，不是网关外挂的功能：守护进程在握手时声明 ACP 的
`elicitation.form` 能力，而这正是解锁 Claude Code `AskUserQuestion` 的开关——不声明的话
适配器会把那个工具直接禁用。整个过程**没有向提示词注入任何东西**。

**选项都不合适时，直接打字回答就行。**问题还挂在屏幕上时发的消息，会被记成对那道题的回答，
而不是开启新一轮——所以一次问三件事的表单仍然会把三件事问完，哪怕你用自己的话回答了第二题。
无论点按钮还是打字，提问那条消息都会被就地编辑：按钮撤掉，并写上你的回答。
实在不想回答，用 `/stop`（或 `/new`）把问题撤掉。

不实现 elicitation 的 harness——`opencode` 1.18.27 与 `dsh` 0.1.2-rc.1——可以用 `ask` 这条
CLI 给你弹按钮，模型通过内置 skill 找到它；再不行就用纯文本把问题问出来并结束这一轮，
你在下一条消息里回答即可。

## 在聊天中行动

纯文本回答自动流式返回。网关**不往**智能体读到的内容里加任何东西——没有开场白，也不提醒它
自己跑在哪里；它拿到的就是你的话和你的附件。回答之外它还能做的事，和别的能力一样，经由它
自己的 harness 送到它面前：

- **两个原生工具** `send_file` 和 `schedule`，所有走 ACP 的智能体（Claude Code、Codex、
  OpenCode、Antigravity……）都有：守护进程给每个会话挂一个小的 MCP server，它们就和别的工具一样出现在
  智能体的工具列表里。
- **一个 skill** 管其余的——发到别的聊天、读聊天记录、回复、编辑、话题、按钮提问、语音转写。
  守护进程把内置的 [skill](../../skill/SKILL.md) 软链到各 harness 读 skill 的地方——Claude Code 是
  `~/.claude/skills`，Codex 和 OpenCode 是 `~/.agents/skills`，Antigravity 是 `~/.gemini/config/skills`
  ——只给在这台机器上跑过的 harness。
  用到之前，它只占每个 skill 都占的那一行描述；正文指向 `talkcode help <主题>`——`files`、
  `schedule`、`channels`、`history`、`messages`、`threads`、`ask`、`voice`、`tasks`——打印该主题的命令
  和规则。旁边还链着第二个 skill `super`：你发 `/super` 时，它告诉智能体怎样把活拆给[子代理](sub-agents.md)。

Antigravity（`agy`）改用 `agy acp` 运行后也有这两个工具；在它的
[stream-json 回退方式](agents.md#回退到-stream-json)下只有 skill——那种模式没有按会话添加工具的途径，
而网关不会去改 agy 的全局 MCP 配置——同样的两件事在 skill 里以 CLI 命令的形式提供。为什么正好两个工具、被它替换掉的提示词注入
是怎么退场的，见 [`src/ipc/README.md`](../../src/ipc/README.md)。

**图片就是图片。** 你发的截图或照片会以图片的形式直接交给 Claude Code、Codex 和 OpenCode，
智能体不用去打开文件就能看到；消息里照样写着它存在哪里，智能体要原文件时用得上。支持 PNG、
JPEG、GIF、WebP，单张约 3.75 MB 以内、一起发出的图片合计 15 MB 以内；超出的、其他格式的（比如
HEIC），或者发给 Antigravity stream-json 回退方式的，只给路径——也就是 2.4.0 之前所有图片的待遇。
Antigravity 也会收到图片本身，不过看不了图的模型（GPT-OSS）会说看不了，只能靠路径。

`schedule` 工具登记的是什么，见[定时任务](scheduled-tasks.md)。
