# 写给所有智能体的工作偏好

[English](../instructions.md) | 简体中文

把你希望智能体怎么跟你干活写下来一次——「用中文回答，结论先行」「删东西之前先报方案」——每个智能体都会读到：
Claude Code、Codex、OpenCode、Antigravity、CodeBuddy 和 AtomCode，本机的和每台[远程主机](remote-hosts.md)上的都算，
再算上你自己指定了指令文件的其它 harness（见下）。内容放在网关的一个目录里，网关搬到哪，它就跟到哪。

```text
<配置目录>/instructions/        （~/.config/fleetherd/instructions/）
  common.md      所有智能体
  claude.md      只给 Claude Code
  codex.md       只给 Codex
  …              opencode.md、agy.md、codebuddy.md、atomcode.md
  <layer>.md     其它智能体，按它的 instructions.layer（默认用它的 id）
```

每个智能体拿到的是 `common.md` 加上它自己那份，前者在前。两份都可以没有。按智能体分的那份，放只对某一种智能体
才说得通的规矩——比如一条为了它的 prompt 缓存定的规矩，计费方式不同的别的智能体不该照着做。

没有配置项：目录在，就启用；删掉目录，就关闭。

## 网关不认识的智能体

`custom` harness 的用户级指令文件，网关猜不出来。在智能体配置里写明它在哪，顺便可以指定它拿哪一层：

```yaml
agents:
  - id: mh
    harness: custom
    command: my-harness
    instructions:
      file: ~/.my-harness/AGENTS.md
      layer: my-harness
```

`file` 在智能体所在的那台机器上；`~` 按这个智能体运行时的 home 解析（`env.HOME` 覆盖也算），目录不存在就什么都不放。
`layer` 是 `<配置目录>/instructions/` 里 `common.md` 旁边那份的名字；不写就用智能体的 id——pod 里的智能体用
`pod.yaml` 里的 id，不带网关加的 `@host`。同一段配置在 `~/.fleetherd/pod.yaml` 里也能用。预设（`claude`、`codex` 等）
也可以写，用来指定被挪过位置的指令文件。

同一台机器上的两个智能体可以共用一个文件，但必须共用同一层：链接只能指向一份 `<layer>.md`，层不同的话，
这个文件会在两者之间来回易主，其中一个智能体读到的是另一个的文本。两个普通的 `claude` 智能体就是允许的
情形——它们共用 `claude.md`。`common` 不能作为智能体指定的层（大小写都不行）：每个智能体本来就会拿到它。

config.yaml 自己的两个智能体冲突，加载时会被拒绝（`/reload` 也一样，并继续按旧配置运行），报错点名两个
智能体、文件和各自的层。pod 里的智能体绝不能让网关起不来：同一个 `pod.yaml` 里两个智能体冲突，这个文件就
不生效——这台主机沿用上一次读到的内容，和别的坏行一样；pod 的智能体和同一台机器上 config.yaml 的智能体
冲突时，它照常留在配置里、照常能跑，只是不下发说明文件：什么都不写，那个链接也不动，守护进程日志里有一行
写明是哪个文件和哪个已经在投递它的智能体。

## 怎么到达智能体

每次启动智能体时，网关把拼好的内容写到智能体所在机器的 `~/.fleetherd/instructions/<智能体>.md`（只读），
再把这个智能体自己读的用户级指令文件链接过去：

| 智能体 | 它读的文件 |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Antigravity（agy） | `~/.gemini/config/AGENTS.md` |
| CodeBuddy Code | `~/.codebuddy/CODEBUDDY.md` |
| AtomCode | `~/.atomcode/ATOMCODE.md` |
| 其它 harness | 它自己的 `instructions.file` 写的文件，`~` 按这个智能体的 home 解析 |

智能体像读自己的设置一样读它——在对话开始之前读，你发的消息里不会多出任何东西；你在那台机器的终端里直接启动的
智能体也读得到。项目自己的 `AGENTS.md` 照旧叠加在上面。

改动在那台机器下次启动同一种智能体时生效；已经在跑的会话，用的还是它启动时读到的内容。

## 不会动的东西

- **那个位置上你自己已有的文件。** 如果 `~/.claude/CLAUDE.md` 是一个真实文件，或者是你自己指向别处的链接，
  它会原样保留，守护进程日志会说明这个智能体拿不到偏好。把里面的内容挪进 `claude.md` 再删掉它，下次启动就会链接上。
- **Codex 的 `AGENTS.override.md`**：有它时 Codex 读它而不读 `AGENTS.md`。
- **从没在那台机器上运行过的智能体**：不会替它创建任何东西。
- **没写 `instructions` 的 `custom` 命令**：不知道它读哪个文件，所以什么都不放。写一个（见上）网关就会去放。

内容上限 32 KiB（`AGENTS.md` 超过这个大小，Codex 会不声不响地截掉）；超出时一个字都不下发，日志里会说明。
要改就改网关上的文件，别改主机上的副本：副本是只读的，下次启动会被重写。

## 在 Web UI 里编辑

打开约束编辑器后，Web UI [设置页](settings.md) **Agents** 下每张智能体卡片都会列出它读的所有文件：先是它从网关拿到的，
再是它所在机器上它自己的。点一行就在[文件窗口](web-ui.md)同一个编辑器里打开这个智能体的整份列表——保存方式一样，
也一样会检查文件在你打开之后有没有被别人改过。网关上的文件不再单独列一节：`common.md` 出现在每张卡片上，
每个智能体的层文件——`claude.md`，或者它 `instructions` 指定的层（默认是它的 id）——出现在每个读它的卡片上，
都标明有几个智能体在读——改它会影响到的就是这些。

```yaml
platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    instructions:
      enabled: true
```

默认关闭，理由和文件窗口一样，而且更进一步：打开后，谁拿到 Web UI 的登录，谁就能改**所有**智能体读的内容——
每个平台、每台主机，包括页面上没人在看的对话。只在登录的防护配得上这件事的地方打开。

**网关上你自己的文件。** `common.md`，加上这个智能体的层文件——`claude.md`，或者它 `instructions` 指定的层
（默认是它的 id）——排在最前面、标为共用。保存时目录不存在就先建出来——也就启用了这个功能——然后把新内容**立刻**
放到每台配置了读它的智能体的机器上，编辑器会说明放到了哪里。连不上的主机，下次那里启动智能体时拿到。会让任何一个
智能体超过 32 KiB 的保存，在写之前就被拒绝。已经在跑的会话，用的还是它启动时读到的内容。

**每个智能体自己的文件。** 自己机器上还会读自己约束文件（网关放的那份之外）的智能体，会把这些文件列在共用文件下面
（卡片上是一行 **Its own files**，因为列出它们要去读那台机器）。它们属于那台机器：在原地读、原地存，网关不留副本。

| 智能体 | 列出什么 |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` 用 `@path` 引用的文件（按 Claude Code 的读法最多四层），以及 `~/.claude/rules/**/*.md` 和它们引用的文件 |
| CodeBuddy Code | `~/.codebuddy/CODEBUDDY.md` 和 `~/.codebuddy/rules/`，规则同上 |
| Antigravity（agy） | `~/.gemini/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.gemini/config/GEMINI.md`、`~/.gemini/config/rules/**/*.md`（启动时不读的会标出来：只有 frontmatter 写了 `trigger: always_on` 的才读），以及它们用 `@[label](path)` 引入的文件——只有一层 |
| OpenCode | `~/.config/opencode/opencode.json` 里 `instructions` 列出的文件（相对路径只列名字不打开：OpenCode 会从每个对话自己的目录往上找） |
| Codex | `~/.codex/AGENTS.override.md`，有的话——Codex 会读它**而不是** `AGENTS.md`，所以它在的时候，上面那些约束到不了 Codex |

引用了但还不存在的文件也会列出，保存时就创建。引用指向网关自己的副本时，会列出来但要在它上面的共用文件里改。编辑器只会
打开智能体当下真正读的文件：每次读和存都在那台机器上重新算一遍列表，所以删掉一条引用，那个文件也就打不开了。
每次保存都记日志，写明哪台机器、哪个文件。
