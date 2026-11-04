# 写给所有智能体的工作偏好

[English](../instructions.md) | 简体中文

把你希望智能体怎么跟你干活写下来一次——「用中文回答，结论先行」「删东西之前先报方案」——每个智能体都会读到：
Claude Code、Codex、OpenCode、Antigravity、CodeBuddy 和 AtomCode，本机的和每台[远程主机](remote-hosts.md)上的都算。
内容放在网关的一个目录里，网关搬到哪，它就跟到哪。

```text
<配置目录>/instructions/        （~/.config/talkcode/instructions/）
  common.md      所有智能体
  claude.md      只给 Claude Code
  codex.md       只给 Codex
  …              opencode.md、agy.md、codebuddy.md、atomcode.md
```

每个智能体拿到的是 `common.md` 加上它自己那份，前者在前。两份都可以没有。按智能体分的那份，放只对某一种智能体
才说得通的规矩——比如一条为了它的 prompt 缓存定的规矩，计费方式不同的别的智能体不该照着做。

没有配置项：目录在，就启用；删掉目录，就关闭。

## 怎么到达智能体

每次启动智能体时，网关把拼好的内容写到智能体所在机器的 `~/.talkcode/instructions/<智能体>.md`（只读），
再把这个智能体自己读的用户级指令文件链接过去：

| 智能体 | 它读的文件 |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Antigravity（agy） | `~/.gemini/config/AGENTS.md` |
| CodeBuddy Code | `~/.codebuddy/CODEBUDDY.md` |
| AtomCode | `~/.atomcode/ATOMCODE.md` |

智能体像读自己的设置一样读它——在对话开始之前读，你发的消息里不会多出任何东西；你在那台机器的终端里直接启动的
智能体也读得到。项目自己的 `AGENTS.md` 照旧叠加在上面。

改动在那台机器下次启动同一种智能体时生效；已经在跑的会话，用的还是它启动时读到的内容。

## 不会动的东西

- **那个位置上你自己已有的文件。** 如果 `~/.claude/CLAUDE.md` 是一个真实文件，或者是你自己指向别处的链接，
  它会原样保留，守护进程日志会说明这个智能体拿不到偏好。把里面的内容挪进 `claude.md` 再删掉它，下次启动就会链接上。
- **Codex 的 `AGENTS.override.md`**：有它时 Codex 读它而不读 `AGENTS.md`。
- **从没在那台机器上运行过的智能体**：不会替它创建任何东西。
- **Gemini CLI、DeepSeek Harness 以及其他 `custom` 命令**：不知道它们读哪个文件，所以什么都不放。

内容上限 32 KiB（`AGENTS.md` 超过这个大小，Codex 会不声不响地截掉）；超出时一个字都不下发，日志里会说明。
要改就改网关上的文件，别改主机上的副本：副本是只读的，下次启动会被重写。
