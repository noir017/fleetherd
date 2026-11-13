# 只能轮询的智能体（信箱）

有些智能体调不到。Meta 的 Muse 跑在它自己的云端 VM 里：能每隔几秒跑个脚本、发 HTTPS 请求，仅此而已。`fleetherd api-agent mailbox` 经一个两边都去轮询的信箱中继够到这类智能体，智能体和网关都不用开入口。

```
fleetherd ──ACP──► api-agent mailbox ──HTTPS──► agent-mailbox 中继 ◄──每 5 秒轮询── Muse
```

中继是 [agent-mailbox](https://github.com/noir017/agent-mailbox)，一个 Cloudflare Worker，免费计划够用（每 5 秒轮询一次，能撑 4 个账号，算式在它的 README 里）。它的 `integrations/muse/` 是装进 Muse 的东西：一个 connector、一个 hook 和 Muse 要遵守的规则。

## 配置

1. 部署中继，每个 Muse 账号建一个信箱（`npm run new-mailbox -- <id>`）。每个信箱两把 token：agent token 给 Muse，client token 给网关。
2. 在那个账号里按 `integrations/muse/README.zh-CN.md` 装好 Muse 安装包。
3. 一个信箱一条 agent 配置：

```yaml
agents:
  - id: muse
    harness: custom
    command: fleetherd
    args: [api-agent, mailbox, --url, "https://mailbox.example.com"]
    env: { MAILBOX_TOKEN: "${MUSE_MAILBOX_TOKEN}" }
  - id: muse-work                 # 第二个账号：自己的信箱、自己的 token
    harness: custom
    command: fleetherd
    args: [api-agent, mailbox, --url, "https://mailbox.example.com"]
    env: { MAILBOX_TOKEN: "${MUSE_WORK_MAILBOX_TOKEN}" }
```

地址也可以从 `MAILBOX_URL` 来。token 只从 `MAILBOX_TOKEN` 读——放在参数里会出现在 `ps` 里，也会原样留在 config.yaml。它跑在网关自己的机器上（不写 `host:`）。没有模型菜单。

## 一轮是什么样

- 你的消息进信箱；Muse 几秒内取走，先发一条进度，显示成一行 `progress: "…"`，每来一条新的，上一条就带上耗时收起。
- 它的回答就是回复正文。Muse 每轮都以 final 结束，final 到了这一轮就结束。
- 每个对话在 Muse 那边是一个独立的 session，各自维护上下文；`/new` 开一个新的。网关重启后 session 不变。
- **2 分钟没人取走**：消息撤回，本轮失败，并说明对方上次来取是什么时候——通常是 hook 没开，或者账号额度用完了。
- **取走后 5 分钟没有新动静**：本轮带着已收到的内容收尾，注明没收到完成标记。5 分钟比网关 10 分钟的静默看门狗短，所以先出现的是这条说明。
- **`/stop`**：还没被取走的消息直接撤回，Muse 永远看不到；已取走的给 Muse 发一条 cancel，它的确认作为后续消息到达。
- **之后的回复**——本轮结束后才到的答案，或 Muse 主动发来的——在智能体进程还在时显示成 `⏱ background update`（两轮之间每 20 秒取一次）。进程不在时（空闲被回收，或网关重启）它们留在中继里，下一轮回复开头以 `⏱ Earlier replies not shown yet` 补上。

`--pickup-timeout <秒>` 和 `--silence-timeout <秒>` 改这两个时限；后者要小于 600。

## 限制

- 只传文字。图片和文件不发，回复里会说明；一条消息只有附件时什么都不发。
- 网关这边没有模型菜单、本地文件、`send_file`/`schedule`、MCP 和技能，也不能在一轮进行中插话。
- `/stop` 是个请求：Muse 到下一步才会停。
- 中继的每日额度是共用的：每个账号每天轮询 17,280 次，网关一轮中每 2 秒、两轮之间每 20 秒（对话进程还在时）再各取一次。
