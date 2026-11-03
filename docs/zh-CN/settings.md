# 在聊天里改配置（`/setting`）

[English](../settings.md) | 简体中文

`/setting` 改的是 **config.yaml 本身**，所以一次改动既跨会话也跨重启 —— 这正是
它和 `/model` 的分工：`/model` 只覆盖当前这个会话，重置即失效。它替掉的是原来
那条路：登上机器、手改 YAML、重启守护进程 —— 而重启会杀掉所有常驻智能体。

| 改什么 | config.yaml 位置 | 接受的值 | 何时生效 |
|---|---|---|---|
| 默认智能体 | `routing.default` | 任一已配置的 agent id | 立即 |
| 某个智能体的默认模型 | `agents[].model` | 该智能体上报的模型、任意名字，或 `-` 清空 | 它的下一个会话（`/new` 可立刻开一个） |
| 空闲回收窗口 | `session.idleTimeoutMs` | `off`、`15m`、`4h` …… | 立即 |
| 会话粒度 | `session.scope` | `per_thread`、`per_channel`、`per_user`、`shared` | 重启后 |
| 流式输出 | `stream.enabled` | `on`、`off`（默认 `off`） | 立即 —— 下一条回复生效 |
| 确认语音识别结果 | `voice.confirm` | `on`、`off`（默认 `on`；仅在配了 `voice:` 时出现） | 立即 —— 下一条语音生效 |
| 整理语音识别结果 | `voice.cleanup` | `on`、`off`（默认 `on`；仅在配了 `voice:` 时出现） | 立即 —— 下一条语音生效 |

```
/setting                       →  整个设置面板（Web UI 是设置页，其他平台是按钮）
/setting idle                  →  这一项当前是什么、接受什么
/setting idle 4h               →  直接设，所有平台都能用
/setting model.cc opus         →  某个智能体开新会话时用的模型
```

在既能发按钮、又能改按钮的平台（Discord、Telegram、Slack、飞书），单独发
`/setting` 会弹出两级菜单 —— 点一项、点一个值，然后回到列表，新值就写在那一行
上。Web UI 里这两级是一个设置页：按用途分组的行，每行分别显示标签和完整的当前
值；点整行进入值列表，当前值带标记，Back 回到列表。其余平台上同样这四条命令按
文本用。模型太多会自动翻页；harness 认但没有上报过的名字（比如 `opusplan`）会
按你输入的原样保存。

每条回执都会说清**这次改动什么时候生效**，因为它们并不一样：会话粒度只写文件、
重启后才应用 —— 在会话还开着的时候换掉「什么算一个会话」，会悄悄把所有现存会话
换成另一个身份。

文件里其余部分仍然只在文件里改，而 `/setting` 会**点名拒绝**并说明原因，而不是
装作这个键不存在。其中最值得单独说的是 `access.allowFrom`：那一项填错一次，就
把你锁在唯一能用来修它的那个界面外面了。

写入走 YAML 文档接口，所以你的注释、键顺序和 `${VAR}` 模板都原样保留；而且写盘
前会先拿整份配置校验一遍 —— `/setting` 不会给你留下一份下次重启加载不了的
config.yaml。

[定时任务](scheduled-tasks.md)也在 `/setting` 里管理。
