# 架构解耦方案（公理设计视角）

> 内部工程方案，不是面向用户的功能文档。基于 `3.39.0`（`f39aad4`）源码实测编写（2026-11-26）；2026-11-27 已全部执行，结果见 [§8](#8-执行结果2026-11-27)。
> 接续 [refactor-plan.md](refactor-plan.md)：那份方案的 Phase 0–2（巨型文件物理拆分、`ipc/` 越界、分层测试）已经落地，本方案处理拆分之后**还留着的逻辑耦合**。

## 1. 结论

- 模块层面已经是下三角：`src/layering.test.ts` 机检单向分层，跨模块没有值级循环依赖。
- 功能层面仍是**耦合设计**：14 个上三角耦合点，集中在四处——`daemon/` 内的 import 环、`PlatformAdapter` 被 Web UI 撑胖、`remote-hosts.ts` 反向依赖技能/指令/agy 插件、harness 知识散落 25 个文件。
- 方案是 1 个护栏 + 6 个工作包（WP0–WP6），全部是**行为不变的结构调整**。在 import 图上模拟过 WP1/WP2/WP6 的切边：`src/`（不含 `webui/client/`）的 import 环从 4 个强连通分量（其中 1 个含值级环）降到 0。
- 做完后上三角从 14 格降到 5 格，剩下的都是有意保留，§6 逐条说明理由。
- 单代理串行约 9–11 个工作日；按 §7 的顺序，最多两个代理并行。

## 2. 现状

### 2.1 功能需求（FR）与设计参数（DP）

| # | FR（系统要做什么） | DP（用什么实现） |
|---|---|---|
| 1 | 加载、校验、迁移配置 | `config/` |
| 2 | agent 反向调用网关（认证、校验、CLI/MCP 暴露） | `ipc/` |
| 3 | 在远程主机上运行 agent | `remote/`（TS + Go）、`daemon/remote-hosts.ts`、`pods*.ts`、`workspace.ts` |
| 4 | 接入 IM 平台收发、按平台方言渲染 | `platform/`（`adapter.ts`、`satori-core.ts`、`profiles/`、`*-markdown.ts`）、`daemon/paced-adapter.ts` |
| 5 | 驱动 harness 跑一轮并流式回传 | `daemon/agent-acp*.ts`、`agent-common.ts`、`agy-*.ts`、`turn-runner.ts`、`turn-outcomes.ts`、`conversation-turns.ts` |
| 6 | 会话历史持久化与检索 | `history/` |
| 7 | 托管技能库与自动审阅 | `daemon/skills-*.ts`、`skill-*.ts`、`managed-skills.ts`、`review*.ts` |
| 8 | 子代理派发、回审、外部 MCP 入口 | `daemon/delegation.ts`、`conversation-delegation.ts`、`external-*.ts` |
| 9 | 会话路由与交互控制 | `daemon/daemon.ts`、`conversation*.ts`（其余）、`routing.ts`、`daemon-menus.ts`、`daemon-reverse.ts`、`settings-store.ts` |
| 10 | Web UI 工作台 | `platform/webui/`、`daemon/*-panel.ts`、`turn-changes.ts` |

### 2.2 设计矩阵（已按依赖方向重排）

`X` 值级/运行时依赖，`x` 仅类型或接口依赖，方括号为上三角（破坏解耦）。

```
               DP1 DP2 DP3 DP4 DP5 DP6 DP7 DP8 DP9 DP10
FR1  配置       X   .   .  [X]  .   .   .   .  [x] [X]
FR2  反向通道   .   X   .   .   .   .   .   .   .   .
FR3  远程主机   X   X   X   .  [X]  .  [X]  .   .   .
FR4  IM收发     X   .   .   X   .   .   .   .   .  [x]
FR5  跑一轮     X   X   X   X   X   .  [X] [X] [X] [x]
FR6  历史       X   .   .   .   X   X   .   .  [X] [x]
FR7  技能/审阅  X   X   X   X   X   X   X   .  [x]  .
FR8  子代理     X   X   .   X   X   X   X   X  [X]  .
FR9  会话路由   X   X   X   X   X   X   X   X   X   .
FR10 Web UI     X   .   X   X   X   X   X   X   X   X
```

### 2.3 耦合点与证据

**import 环**（Tarjan 强连通分量，含 `import type`）：

| 环 | 成员 | 关键边 |
|---|---|---|
| A（唯一值级） | `turn-runner.ts` ↔ `delegation.ts` | `turn-runner.ts:23` 取 `commandSurface`；`delegation.ts:31` 取 `UPDATE_SENDER`、`PersonWords` |
| B（10 文件） | `conversation.ts`、`conversation-{context,commands,controls,delegation,history,turns}.ts`、`delegation.ts`、`turn-outcomes.ts`、`turn-runner.ts` | `turn-outcomes.ts:20` 取 `CARD_ITEM_CHARS`；`conversation-controls.ts:64` 取 `subjectOf`；`conversation-context.ts` 取 `PersonWords`；`delegation.ts:30` 取 `ConversationRegistry` |
| C（跨层） | `types.ts` → `core/conversation.ts` → `config/schema.ts` → `types.ts`，外加 `config/instructions.ts` ↔ `config/schema.ts` | `types.ts:5-6`。`types.ts` 是根文件，哪层都允许 import，所以 `layering.test.ts` 抓不到这个环 |
| D | `agent-acp.ts` → `acp-fork.ts` → `acp-side-question.ts` → `agent-acp.ts` | `acp-side-question.ts:3` 取 `TurnState` |
| E | `relay.ts` ↔ `agy-relay.ts` | 注册表 import 了实现，实现又 import 注册表里的接口 |

**反向依赖与胖接口：**

- **`remote-hosts.ts` 认识四个功能**：`remote-hosts.ts:13-27` import 了 `instructions`、`agy-plugin`、`skill-link`、`bundled-skill`、`managed-skills`、`skills-store`。`RemoteHosts` 有 4 个 `place*` 方法和 8 个缓存，全属于这四个功能。`agent-common.ts` 里对应的本机版本是 `buildAgentEnv` 第 153–158 行和 `prepareRemoteSpawn` 第 293–296 行，各是四连调用。`skills-repo.ts:18` 只为拿 ssh 密钥路径就依赖了 `remote-hosts.ts`。`remoteHosts` 是模块级单例（`remote-hosts.ts:578`），有 18 个文件直接调用。
- **`PlatformAdapter` 被 Web UI 撑胖**：共 53 个成员，其中 31 个可选成员只有 webui 实现（`use*Panel`、`set*`、`parentOf` 等）。每个成员都要在 `paced-adapter.ts` 的 `PACING` 表里登记一行。10 月以来 `adapter.ts` 改过 65 次，其中 48 次同时改了 `webui/page.ts`、26 次同时改了 `paced-adapter.ts`。`daemon.ts:831-881` 是一整块面板装配，为此 import 了 7 个 `*-panel.ts`。
- **harness 知识散落**：按 harness 分支的代码约 120 处，分布在 25 个文件、4 个模块里。最多的是 `commands/doctor.ts` 15 处、`config/instructions.ts` 12 处、`agent-acp-harness.ts` 11 处，`review-run.ts`、`core/agent-menu.ts` 各 9 处。平台有统一的 `PlatformProfile` 接缝，harness 没有对应的接缝。
- **helper 放错地方**：`agent-hooks.ts`、`quota-meter.ts` 借定时任务的 `schedule-bash.ts` 起 shell；`claude-transcript.ts`、`agy-transcript.ts` 借 `skills-scan.agentHome`；`history/import-webui.ts` 依赖 webui 在磁盘上的 transcript 格式。

### 2.4 已经做对、本方案不动的

- `layering.test.ts` 的模块边界、`core/` 纯函数层，以及 `ipc/`、`history/`、`api-agent/` 这三个不依赖其他功能模块的模块。
- `REVERSE_COMMANDS`、`GENERIC_COMMANDS`、`/setting` 表这些单一真源。它们造成的是下三角的整列依赖，属于有意设计。
- `PlatformProfile` 接缝，以及 `PACING` 表用 `satisfies Record<keyof PlatformAdapter, …>` 强制穷举。WP4 要保留这种「新成员必须表态」的机制。
- `delegation.ts` 里 `type Registry = Pick<ConversationRegistry, …>` 的做法：只声明自己用到的那几个方法。WP1 会把它升级成真正的端口接口。

## 3. 原则

1. **行为不变**：每个工作包只做结构调整，不夹带功能或文案改动。一个工作包一个分支，用 `--no-ff` 合并，可以单独回滚。
2. **不削弱安全不变量**：碰到不变量 1、5、8、9、10 的代码一律原样搬迁，测试跟着一起搬。每个工作包都写明要守住哪几条。
3. **棘轮防回退**：WP0 先把「不许出现新环」变成测试，后面每个工作包只能让允许名单变短。
4. **不为矩阵好看而拆**：搬一处依赖要换来真实收益——少改文件、能单测、能裁剪。§5 列出明确不做的事。
5. **只用显式注入，不引入 DI 容器或事件总线**。端口一律定义在消费方，提供方用结构类型满足它。
6. **文档同步**：新增、改名文件要在同一提交里更新对应模块的 `*.fras`。契约有变（WP4、WP5）时同步更新模块 README 和 `AGENTS.md` 的 Adding things 一节。

## 4. 工作包

### WP0 护栏：import 环棘轮测试（0.5 天，极低风险）

- 把 `layering.test.ts` 里的 import 解析（`IMPORT_RE`、`walkProdTs`、`resolveTarget`）抽到 `src/test-utils/import-graph.ts`。
- 新增 `src/import-cycles.test.ts`，对 `src/`（不含 `webui/client/`）做两遍强连通分量检测，结果都必须**等于**一份写死的允许名单：
  - 含 `import type` 的一遍，初始名单是 4 个分量：B（A 包含在其中）、C、D、E。
  - 只看值级 import 的一遍，初始名单是 A。
  - 出现新环，测试失败，并打印环的成员。
  - 某个环消失了也失败，提示删掉名单里那一项。这样名单只会变短，不会悄悄留着失效条目。
- 验收：`npx vitest run src/layering.test.ts src/import-cycles.test.ts`、`npm run typecheck`、`npm run lint` 全绿。

### WP1 拆掉 daemon 的环 A、B（1 天，低风险）

把被环两端共用的「约定」挪到不依赖任何 daemon 文件的叶子文件里，再让 delegation 只依赖自己声明的端口。

| 搬什么 | 从哪里 | 到哪里 |
|---|---|---|
| `SCHEDULED_SENDER`、`CONTINUE_SENDER`、`DELEGATE_SENDER`、`UPDATE_SENDER`、`RECONNECT_SENDER`、`GATEWAY_SENDERS`、`PersonWords` | `turn-runner.ts:48-100` | 新建 `daemon/turn-senders.ts`（叶子文件） |
| `commandSurface`、`CARD_ITEM_CHARS`、`CARD_TOTAL_CHARS` | `delegation.ts:136,191` | 新建 `daemon/delegation-surface.ts`（只 `import type` `PlatformAdapter`） |
| `formatLaneTitle`、`subjectOf`（互为逆运算的纯字符串函数） | `conversation-controls.ts:77`、`delegation.ts:2512` | 新建 `core/lane-title.ts` |
| `parseTextCommand`、`looksLikeCommand`（纯文本） | `routing.ts:77,91` | 新建 `core/text-command.ts` |
| `ReviewFacts` 类型（消费方定义端口） | `conversation-turns.ts` | `review.ts` |
| `Registry = Pick<ConversationRegistry, …>` | `delegation.ts` | 在 `delegation.ts` 里写成显式的 `DelegationRegistry` 接口，由 `ConversationRegistry` 用结构类型满足 |
| 可选：runtime 只用到 `ConversationStore` 的 5 个方法 | `agent-acp.ts`、`agent-acp-options.ts`、`turn-outcomes.ts` | 在 `agent.ts` 定义窄端口 `SessionMemory` |

- 所有 importer 直接改成从新位置 import，**不留 re-export**（`conversation.ts:72` 现有的那个 re-export 也一起删掉）。留着 re-export，依赖边其实没断。
- 模拟结果：环 A、B 消失，`turn-runner.ts` 不再依赖任何 `conversation*` 或 `delegation` 文件。
- 验收：从 WP0 的允许名单删去 A、B；`npx vitest run` 跑被改文件对应的测试，以及 `src/daemon/delegation*.test.ts`、`turn-runner*.test.ts`；更新 daemon、core 两个模块的 `*.fras`。

### WP2 让 `types.ts` 成为真正的底层（0.5 天，低风险）

- `ConversationAddress`、`ConversationRef` 的类型定义从 `core/conversation.ts` 移到 `types.ts`，`core/conversation.ts` 改为从 `types.ts` import。
- `PermissionLevel`、`SessionScope` 改成 `types.ts` 里的字面量联合，`config/schema.ts` 的 zod 枚举用 `satisfies` 对齐。这就是 AGENTS.md 说的「`types.ts` domain types → mirrored zod enums with `satisfies`」，和 `ToolMode` 的写法一样。
- 同时在 `types.ts` 加 `Harness` 联合类型，作为 WP5 的地基。`config/instructions.ts` 改用它和自己的结构类型，不再 import `schema.ts`，这样 config 内部那个小环也一起断掉。
- `layering.test.ts` 加一条规则：`types.ts` 不得 import `src/` 下任何文件。
- 验收：允许名单删去 C；`npm run typecheck`；`npx vitest run src/layering.test.ts src/config src/core/conversation.test.ts`。

### WP3 agent 投放注册表：拆掉 `remote-hosts.ts` 的反向依赖（1.5–2 天，中风险）

**改动：**
- 新建 `daemon/provision.ts`，只定义接口：
  ```ts
  export interface AgentProvision {
    readonly name: string;
    local(def: AgentDef, home: string): void;
    remote(host: HostFiles, def: AgentDef, home: string, w: Welcome): Promise<void>;
  }
  ```
  `HostFiles` 是 `RemoteHost` 上的窄端口：`ensureLink`、写文件、`stat`、`mkdirp` 等，即现在 `place*` 方法实际用到的那几个操作。
- 四个功能各自实现一个 `AgentProvision`，**本机和远程两种放置写在一起**：
  - `skill-link.ts` 加 `bundled-skill.ts`：内置技能
  - `agy-plugin.ts`：agy 插件
  - `instructions.ts`：指令文件
  - `managed-skills.ts`：托管技能
- `RemoteHosts` 的 4 个 `place*` 方法和 8 个缓存跟着搬到各自模块。缓存键（`host@version@instance`）和失效时机原样保留。
- 在 `commands/start.ts:89` 构建 agent factory 的地方装配投放列表 `[bundledSkill, agyPlugin, instructions, managedSkills]`，注入 `createAcpAgentFactory`。
  - `agent-common.ts` 的 `buildAgentEnv` 和 `prepareRemoteSpawn` 改成按顺序遍历这个列表，顺序与现在一致。
- 新建叶子文件 `daemon/ssh-identity.ts`，放 `defaultIdentityFile`、`defaultKnownHostsFile`、`knownHostsFileOf`、`expandLocalHome`。`skills-repo.ts`、`pod-admin.ts`、`daemon.ts`、`commands/doctor.ts` 改为从这里取。

**结果：** `remote-hosts.ts` 只剩连接管理和 `runCli`，不再 import 任何功能模块；agent 启动代码不再 import 技能模块；以后新增一种投放物，只需要加一个实现、在装配处加一行。

**要守住的不变量：**
- 不变量 5：主机只按配置访问，投放走同一条 ssh 链路。
- 不变量 8：归档的技能要从每台主机撤下（`managedArchived` 的逻辑原样搬）；技能名、路径的校验仍在写入前做。
- `FLEETHERD_NO_SKILL_LINK` 等环境变量开关的位置和语义不变。

**验收：**
- `remote-hosts.ts` 的 import 里不再出现上述 6 个模块（用 grep 断言）。
- 跑 `npx vitest run` 覆盖 `remote-hosts`、`agent-common`、`skill-link`、`agy-plugin`、`instructions`、`managed-skills`、`bundled-skill`、`skills-repo` 的测试。
- 一次远程主机实测：隔离网关 + 本机 sshd。确认内置技能、托管技能、指令文件、agy 插件都送到了主机，归档的技能被撤下。

**WP3b（可选，看收益再定）：** 把 `remoteHosts` 单例改成经 `ConversationContext`、`DaemonContext` 注入的 `Machines` 端口（`hostFor`、`get`、`ids`），涉及 18 个文件。主机集合本身就是进程级资源，单例本身不是错。真正的问题是反向依赖，WP3 已经解决了。所以只在测试确实需要替换它时才做。

### WP4 `PlatformAdapter` 瘦身：工作台能力单独成接口（1.5–2 天，中风险）

**改动：** 把 31 个只有 webui 实现的可选成员按语义分三组，挂到 adapter 的三个可选子对象上：

| 子对象 | 成员 | 说明 |
|---|---|---|
| `topics?: TopicTree` | `parentOf`、`childrenOf`、`hasThread`、`forkThread` | 话题树。是平台级语义，将来有话题的 IM 平台也能实现 |
| `presence?: TopicPresence` | `setStatus`、`setActivity`、`setPendingQueue`、`markPendingDelivered`、`usePendingQueueActions`、`setOfflineMachines`、`seenAt` | 话题状态展示 |
| `workbench?: WorkbenchHost` | 其余 19 个 `use*` 面板/查询钩子和 `attachTurnChanges`，共 20 个 | 工作台面板 |

- 面板相关的类型（`SchedulePanel*`、`SkillPanel*`、`ReviewPanel*`、`GitPanel`、`HistoryPanel` 等）从 `adapter.ts` 移到 `platform/workbench.ts`。
- `PACING` 表里三个子对象各登记一行 `unpaced`。表仍然 `satisfies Record<keyof PlatformAdapter, …>`，所以以后给通用接口加成员照样要表态；但加一个工作台面板，就不用再碰 `adapter.ts` 和 `paced-adapter.ts` 了。
- `daemon.ts:831-881` 的面板装配块搬进新文件 `daemon/workbench-wiring.ts`，提供 `attachWorkbench(wb, deps)`。`daemon.ts` 不再 import 7 个 `*-panel.ts`。
- `delegation.ts` 的 11 处、`conversation-turns.ts` 的 7 处、`external-calls.ts` 的 3 处等调用点，从 `adapter.parentOf?.()` 改成 `adapter.topics?.parentOf()`。`commandSurface` 改成判断 `adapter.topics` 是否存在。
- 分三个提交走，每个提交都能单独编译通过：先加子对象并让旧成员委托过去 → 迁移所有调用方 → 删掉旧成员。

**要守住的不变量：**
- 不变量 9、10：文件窗口和指令编辑器默认关闭；关闭时页面没有入口，路由一律 404。装配逻辑原样搬，不能因为 `workbench` 存在就挂上面板。
- 不变量 12：插件路由在 `GUARDED` 之后匹配，这部分不动。

**验收：**
- `PlatformAdapter` 剩 22 个方法加 3 个能力子对象。
- `npx vitest run src/daemon/paced-adapter.test.ts src/platform/webui src/daemon/delegation*.test.ts`。
- 关键 DOM 测试：`page.dom.*.test.ts` 里覆盖话题树、状态、面板的几个文件。
- 一次 Web UI 实测：话题树、子代理话题、git/文件/定时/技能面板都能打开；关掉 `files.enabled` 后对应路由 404。
- 更新 `platform/README.md`、`platform/webui/README.md`。

### WP5 `HarnessProfile` 接缝（3–4 天，中风险，在 WP3 之后做）

参照 `PlatformProfile`：每个 harness 一个文件，注册表穷举所有 harness，新增 harness 时编译器会逼着它把每一项都填上。

```text
src/daemon/harness/
├── profile.ts        # HarnessProfile 接口
├── index.ts          # HARNESSES satisfies Record<Harness, HarnessProfile>
├── claude.ts  codex.ts  opencode.ts  agy.ts  gemini.ts  dsh.ts  custom.ts
src/core/harness-facts.ts   # 纯数据：命令映射、菜单标签、effort/权限档位，按 Harness 键穷举
```

**分面迁移**，一个分面一个提交，从重复最多、风险最低的开始：

| # | 分面 | 现在在哪 |
|---|---|---|
| 1 | 技能目录、指令文件位置、transcript 位置 | `skill-link.ts`、`config/instructions.ts`、`instruction-imports.ts`、`skills-scan.ts`、`claude-transcript.ts`、`agy-transcript.ts` |
| 2 | 纯数据 | `core/command-translate.ts`、`agent-menu.ts`、`effort-menu.ts`、`settings.ts`、`permission-levels.ts`，搬进 `core/harness-facts.ts` |
| 3 | 启动参数与特殊处理（quirk） | `agent-acp-harness.ts` 的 `resolveHarness` |
| 4 | 选项映射（模型、effort、权限 → harness 模式） | `agent-acp-options.ts` |
| 5 | relay 改写（改由 profile 提供，`relay.ts` 不再 import 具体实现） | `relay.ts`、`agy-relay.ts` |
| 6 | 审阅隔离开关 | `review-run.ts` |
| 7 | 自检 | `commands/doctor.ts` |

`config/instructions.ts` 留在 config 层：加载配置时要做路径冲突检测，config 不能依赖 daemon。harness 的 profile 引用这张表，而不是复制一份。

**要守住的不变量：**
- 不变量 1：权限档位不得映射到在 harness 内部自己应答请求的模式（claude 的 `auto`、codex 的 `agent`）。映射表原样搬，测试跟着搬。
- 不变量 8：每个 harness 的审阅隔离开关原样搬，包括 agy 的 `AGY_NO_TOOLS` 拒绝列表和 codex 关掉的 shell 功能。
  - `HarnessProfile.reviewIsolation` 设为**必填**。`custom`、`gemini`、`dsh` 显式写成 `'operator-args'`，表示由运维通过 `review.args` 自己提供开关。这样新增 harness 时必须对审阅隔离表态，比现在更安全。

**结果：** 新增或裁掉一个 harness，从改 25 个文件变成「一个文件 + 注册表一行」。AGENTS.md 的「Adding things → An agent harness」一节同步改写。

**验收：**
- 用 grep 断言 `daemon/harness/` 和 `core/harness-facts.ts` 以外不再出现 harness 名字的分支（允许 `config/instructions.ts` 例外）。
- 跑每个分面对应的测试，以及 `npm run typecheck`、`npm run lint`。
- 实测：claude、codex、opencode、agy 四种 harness 各跑一轮，并各跑一次自动审阅。

### WP6 小修（0.5–1 天，极低风险）

- `schedule-bash.ts` 里的 `shellLaunch`、`runBashCommand`、`runRemoteBashCommand` 移到 `daemon/shell-run.ts`。`agent-hooks.ts`、`quota-meter.ts`、`schedule-service.ts` 都从这里取。
- `skills-scan.agentHome` 移到 `agent-common.ts`，或在 WP5 之后归入 harness profile。
- `acp-side-question.ts` 改为直接从定义处 `agent-acp-translate.ts:492` 取 `TurnState`，不再经过 `agent-acp.ts` 的兼容 re-export。一行改动，解掉环 D。
- `HarnessRelay` 接口从 `relay.ts` 移到叶子文件 `daemon/relay-types.ts`，`agy-relay.ts` 改从这里取，解掉环 E。WP5 之后 relay 改由 harness profile 提供。
- `history/import-webui.ts` 是从 2.13.0 起的一次性迁移，导入是幂等的。在 AGENTS.md 的兼容清单里标为「下个大版本删除」，跟 `legacy-name.ts` 一起清掉。
- `DaemonContext`、`ConversationHooks` 目前是什么都装的上下文包（30 多个可选回调）。借鉴 `Registry = Pick<…>` 的写法，让每个协作者声明自己用到的子集：`DaemonReverse` 用 `ReverseDeps`，`DaemonMenus` 用 `MenuDeps`。只收窄类型，不改装配方式。
- 验收：允许名单删去 D、E；跑相关测试。

## 5. 明确不做的事

| 不做 | 理由 |
|---|---|
| 拆开 `config/schema.ts` → `platform/config-schemas.ts` | 校验配置本来就要知道各平台的凭据结构，AGENTS.md 也写明了这条依赖。拆开得引入 schema 注册机制，换来的行为收益是零（第四批已改为把文件挪进 `config/`） |
| 打散 `REVERSE_COMMANDS` 的整列依赖 | 有意设计的单一真源，处在下三角 |
| 消除 `daemon.ts` 作为装配根对所有模块的 import | 装配根就该认识一切；WP4 之后它会少掉面板装配那一块 |
| 按行数拆 `delegation.ts`（2595 行）、`turn-runner.ts`（2254 行） | 行数不等于耦合。WP1 之后如果出现自然的分界再说 |
| 引入 DI 容器、事件总线、插件化 daemon | 违反原则 5：隐式连线比现在的显式构造更难追踪 |
| 动 Go 端 `remote/*.go` | 不在耦合点上；所有工作包都不改主机端协议 |

## 6. 目标矩阵

```
               DP1 DP2 DP3 DP4 DP5 DP6 DP7 DP8 DP9 DP10
FR1  配置       X   .   .  [X]  .   .   .   .   .  [X]
FR2  反向通道   .   X   .   .   .   .   .   .   .   .
FR3  远程主机   X   X   X   .   .   .   .   .   .   .
FR4  IM收发     X   .   .   X   .   .   .   .   .   .
FR5  跑一轮     X   X   X   X   X   .   .   .  [x]  .
FR6  历史       X   .   .   .   X   X   .   .  [X]  .
FR7  技能/审阅  X   X   X   X   X   X   X   .   .   .
FR8  子代理     X   X   .   X   X   X   X   X  [x]  .
FR9  会话路由   X   X   X   X   X   X   X   X   X   .
FR10 Web UI     X   .   X   X   X   X   X   X   X   X
```

剩下 5 个上三角格子，全部有意保留：

- **FR1×DP4、FR1×DP10**：平台凭据和 webui 安全开关的 schema 定义在 `platform/config-schemas.ts`，理由见 §5 第一行（第四批已改为把文件挪进 `config/`）。
- **FR6×DP9**：记录对话的位置天然在会话层，`history/` 只是被动存储。
- **FR5×DP9、FR8×DP9（x）**：`conversation-turns.ts` 和 `conversation-delegation.ts` 是 `ConversationRegistry` 的协作者，按设计就共享 `ConversationContext` 类型。如果把这两个文件归到 DP9，这两格也会消失。

## 7. 顺序、并行与交付

```
WP0 ──► WP1 ──► WP4
   └──► WP2
   └──► WP3 ──► WP5
WP6 随时可做（解环 D、E 的两项在 WP0 之后做）
```

- **能并行的**：WP1 和 WP2，WP3 和 WP4。每对之间没有共享文件——WP3 在 `commands/start.ts` 装配，不碰 `daemon.ts`。
- **必须串行的**：WP4 要在 WP1 之后，两者都改 `delegation.ts`、`conversation-turns.ts`、`turn-outcomes.ts`。WP5 要在 WP3 之后，两者都改 `skill-link.ts`、`agy-plugin.ts`、`agent-common.ts`。
- **工作方式**：每个工作包在 `.worktrees/<wp名>` 里做。合并进 `main` 前先 `git fetch`，用 `--no-ff` 合并。
- **本地验证**：只跑 `typecheck`、`lint`、`import-cycles.test.ts`，以及覆盖改动的测试（`npx vitest run <files>`）。全量测试交给 CI。
- **发版**：
  - 纯结构调整对用户不可见，不写 CHANGELOG，也不单独发版，随下一个功能版本一起发布。
  - WP3、WP4、WP5 会改变 agent 启动和 Web UI 装配的代码路径。它们所在的那个版本，发版前要按上面各自的「实测」项再验一遍。

## 8. 执行结果（2026-11-27）

三批全部合入 `main`，每批一个检查点 tag（不以 `v` 开头，不触发发版）。全部是行为不变的结构调整，未单独发版。

| tag | 内容 | 合并提交 |
|---|---|---|
| `refactor-batch-1` | WP0 环棘轮测试，WP1、WP2，WP6 的解环 D、E | `0c3b9a0` |
| `refactor-batch-2` | WP3 投放注册表与 `ssh-identity.ts`，WP4 能力子对象与 `workbench-wiring.ts`，doctor 收口到 `platform/webui/doctor.ts`，WP6 的 `shell-run.ts` 与 `DaemonContext` 收窄，`SessionScope` 移入 `types.ts` | `d78ae5d` |
| `refactor-batch-3` | WP5 `daemon/harness/`（`HARNESS_PROFILES`）与 `core/harness-facts.ts`；三个时序测试改为等条件 | `12d38a3` |

**结果**
- `src/`（不含 `webui/client/`）的文件级 import 环：4 个强连通分量 → 0。`import-cycles.test.ts` 的两份允许名单都是空的，import 解析改用 TypeScript AST。
- `remote-hosts.ts` 只剩连接管理和 `runCli`；`agent-common.ts` 不再 import 技能、指令、插件模块；投放列表在 `commands/start.ts` 装配，参数必填。
- `PlatformAdapter`：56 个成员（32 个可选）→ 3 个只读字段 + 22 个通用方法 + `topics`、`presence`、`workbench` 三个能力子对象。`daemon.ts` 不再 import 任何 `*-panel.ts`。
- harness 分支只剩在 `daemon/harness/`、`core/harness-facts.ts` 和 `config/` 里。新增 harness 要动的地方见 AGENTS.md「Adding things → An agent harness」。

**与方案的出入**
- 吸收了另一份对比方案里的一项：`commands/doctor.ts` 不再穿透 `platform/webui/` 内部文件。
- 仍有按 harness 名字分支、但属于有意保留的例外：
  - `config/schema.ts` 的枚举和 custom/agy 的 refine：config 不能依赖 daemon。
  - `config/instructions.ts` 的 `harnessKind`：加载配置时做路径冲突检测要用。
  - `core/permission-levels.ts` 的 `isApiAgent`：结构判断，不是数据。
  - `daemon/harness/custom.ts` 的 CodeBuddy 判定：合并会改变边界值下 `skillHarnessName` 的结果。
  - Web UI 前端 `banners.ts` 的 custom 判断：浏览器端代码 import 不到 daemon。
- 未做：
  - WP1 的 `SessionMemory` 窄端口、WP3b 的 `remoteHosts` 单例注入：方案自己标为可选，目前没有测试需要替换它们。
  - `platform/webui` 不依赖 `config/load.ts`：AGENTS.md 明文接受这条依赖。

**验证**
- 每批都派 cc 审代码，并用隔离网关做新旧对照实测。
- 第二批：本机 sshd 远程主机的投放结果逐项 diff、各 Web UI 面板、`files.enabled`/`instructions.enabled` 关闭后路由 404、doctor 输出。
- 第三批：claude、codex、opencode、agy 真跑一轮加一次自动审阅，比对发给 harness 的全部 argv、env、ACP 消息和审阅隔离开关，新旧 diff 为空。
- 包含 WP3、WP4、WP5 的那个版本，发版前按 §4 各「实测」项已验过。远程主机上的真 harness 实跑、gemini、dsh、cursor-agent 未实跑，只比过纯函数和 doctor 输出。
