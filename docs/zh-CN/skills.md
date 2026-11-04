# 网关自己维护的技能

[English](../skills.md) | 简体中文

自管技能由网关自己保存，并下发给每台主机上的每个智能体——Claude Code、Codex、OpenCode、Antigravity、
CodeBuddy 和 AtomCode，本机的和远程的都算。你说「把这个记成技能」，当前智能体就能写一个；其他智能体下次启动时读到它。

```text
<配置目录>/skills/                 （~/.config/talkcode/skills/）
  deploy-check/
    SKILL.md                       技能本体：frontmatter（name、description）+ 正文
    references/                    可选：技能要读的参考资料
    templates/
    scripts/
  .usage.json                      来源、创建时间、最后使用、次数、哪些智能体用过、状态、是否钉住
  .archive/                        归档的技能，原样保留
  .history/                        每次改动前的版本，一条一个目录
```

以点开头的都是网关自己的账，不是技能。

## 命令

`talkcode skills <动作>` 是反向命令，智能体通过自带的 `talkcode` 技能和 `talkcode help skills`
找到它。它作用于整个网关，`--channel` 不适用。

| 动作 | 做什么 |
|---|---|
| `list` | 列出所有技能，含状态、钉住、次数、最后使用和用过它的智能体 |
| `show <名字> [文件]` | 看一个文件（默认 `SKILL.md`）和它的版本号；`patch` 必须带这个版本号 |
| `create <名字> --description "什么时候用它" [--body <正文>]` | 新建技能 |
| `patch <名字> --version <版本> --content <完整 SKILL.md>` | 替换 `SKILL.md`，只接受你读到的那个版本 |
| `write-file <名字> <路径> --content <内容>` | 在 `references/`、`templates/`、`scripts/` 下增加或替换文件 |
| `remove-file <名字> <路径>` | 删掉其中一个文件 |
| `archive <名字>` / `restore <名字>` | 移进 `.archive/`，或移回来 |
| `pin <名字>` / `unpin <名字>` | 让技能不参与（或重新参与）过期检查 |
| `history <名字>` | 每次内容改动，新的在前 |
| `revert <名字> <记录 id>` | 把某次改动前的文件放回去，本身也算一次新改动 |

### 规则

- **名字**用小写单词加连字符（`a-z`、`0-9`），最长 64 个字符。`talkcode` 和 `super` 是自带的两个技能，不能重名。
- **`SKILL.md`** 最大 20 KB，必须以 `---` 开头的 frontmatter 写明名字和一句非空的用途说明。智能体的技能菜单列的就是这两项。
- **附加文件**只能放在 `references/`、`templates/`、`scripts/`，单个最大 1 MB。脚本下发后带执行权限，其余只读。
- **先读后写。** `patch` 要带上 `show` 打印的版本号；中间技能被改过就拒绝，并告诉你当前版本——重新 `show`、把改动重新套上、用新版本号再 `patch`。
  `write-file` 和 `remove-file` 不要求版本号，但每次也会产生新版本。
- **不会真删。** `archive` 只是移动，`revert` 只是把旧快照放回去；两者都记在 `.history/` 里，回滚本身也能再回滚。

## 怎么到达智能体

每次启动智能体时，网关把在用的技能复制到智能体所在机器的 `~/.talkcode/skills/<名字>/`，再链接进这个智能体读技能的目录：

| 智能体 | 它的技能目录 |
|---|---|
| Claude Code | `~/.claude/skills` |
| Codex、OpenCode | `~/.agents/skills` |
| Antigravity（agy） | `~/.gemini/config/skills` |
| CodeBuddy Code | `~/.codebuddy/skills` |

副本是只读的，所以智能体想改技能只能走 `talkcode skills`——那里有版本、能回滚——不能直接改副本，否则下次启动会被覆盖。

只会改动或删除指向 `~/.talkcode/skills` 的链接。`~/.claude/skills/<名字>` 上是真实目录、真实文件，或者你自己建的链接，就原样保留，
日志会说明这个智能体拿不到网关的副本。内容没变不重写。归档的技能，下次启动时撤掉网关的副本和所有网关建的链接。

## 什么时候算用了一次

三个信号，都来自网关已经收到的事件：

1. 智能体以 `Skill` 工具调用这个技能（Claude Code、CodeBuddy）；
2. 一条消息以 `/<名字>` 开头；
3. 任何工具调用的参数里出现 `~/.talkcode/skills/<名字>/` 下的文件——Codex、OpenCode、agy、AtomCode 都是直接读文件来用技能，读它下面的参考资料或脚本也算。

同一轮里同一个技能只算一次。`talkcode skills` 本身是管理操作，不算使用。

## 过期与归档

网关每天检查一次：**14 天**没用标为过期，**30 天**移进 `.archive/`，并在该智能体下次启动时撤掉链接。
钉住的技能不受影响。归档的技能从不删除；`restore` 一条命令就能恢复，恢复后重新计时，归档时还会通知创建它的那个会话。

在终端里直接开的会话统计不到，这是唯一的盲区。在意的话把技能钉住，免得被自动归档。

## 任何智能体都能写

这是有意的——你说「把这个记成技能」，当场就能写——也是风险所在：自管技能会进入**所有**智能体的上下文，
一个智能体写技能，等于给其他智能体下指令。兜底是上面这些校验、改动历史和 `revert`、归档通知，以及 30 天自动归档。
访问白名单只放你信任的人。
