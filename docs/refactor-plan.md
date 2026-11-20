# Fleetherd 架构重构方案

> 本文为内部工程重构评估与实施路线图（非面向终端用户的功能文档），基于 `3.20.0` 源码实测数据编写。

## 1. 背景与核心问题

项目整体工程纪律很高（10.6 万行生产代码下 `eslint` 0 error / 24 warning，0 `@ts-ignore`，0 `TODO/FIXME`，单向分层与 11 条安全不变量执行严格），但功能持续演进后已出现三类明显的结构性瓶颈：

| 问题域 | 现状（实测） | 实际代价 |
|---|---|---|
| WebUI 内联化 | `src/platform/webui/page.ts` 14,621 行（内联 `SCRIPT` 约 1.26 万行、620 个函数）；`page.dom.test.ts` 16,905 行 | 1.26 万行前端代码完全绕过 `tsc`/`eslint`，需手避反引号与 `${`；单文件 jsdom 测试全量跑超 10 分钟 |
| Daemon 巨型文件 | `conversation.ts` 5,331 行（~212 方法）、`daemon.ts` 4,329 行（~126 方法）、`agent-acp.ts` 4,303 行（`createAcpSession` 单函数超 2,100 行） | 并行开发易撞文件；`vitest related` 触及即拉起几乎全套测试 |
| 测试卫生与分层漂移 | 23 个测试文件调用 `mkdtempSync` 未清理；高负载存在时序 flake；`src/ipc/server.ts` 引入了 `../core/conversation.js`（与 `AGENTS.md` 约束不符） | `/tmp` 目录持续堆积；发版时偶尔被迫跳过本地测试门禁；分层规则出现首个例外 |

## 2. 重构原则

1. **不引入重型前端框架**：WebUI 沿用现有 `esbuild` + 原生 TypeScript 模块，保持零外部 CDN、自包含与轻量。
2. **不削弱既有不变量**：严守 `AGENTS.md` 中的单向分层与 11 条安全不变量，且借 WebUI 拆分进一步收紧 CSP。
3. **重构与功能变更解耦**：每个阶段/PR 仅做结构调整、保持外部行为不变，独立可验证、可回滚。
4. **门禁不降级**：每步合并前保持 `npm run typecheck`、`npm run lint`、相关单测及 `npm run test:remote` 全绿。

---

## 3. 分阶段实施方案

### Phase 0：低成本止血（预计 0.5 天，低风险）

先清理见效快、改动面小的基础债，为后续大拆分铺平道路：

1. **修复测试 `/tmp` 泄漏（23 个测试文件）**
   - 新增公共测试辅助函数（如 `src/test-utils/temp-dir.ts`），在 `afterEach` 中统一 `rmSync(dir, { recursive: true, force: true })`。
   - 替换 `src/daemon/agent-acp-*.test.ts`、`src/daemon/voice*.test.ts`、`src/commands/log-file.test.ts` 等 23 个文件中未清理的 `mkdtempSync`。
2. **消除 `ipc/` 分层越界**
   - `src/ipc/server.ts` 当前直接 `import { parseTarget } from '../core/conversation.js'`，违背 `ipc/` 仅依赖 `types.ts` 和 `legacy-name.ts` 的约定。
   - 改为在 `IpcServerHandler` 或构造函数中由 `daemon` 注入 `parseTarget`（约 15 行改动），恢复 `ipc/` 零跨层依赖。
   - 在 CI 或测试中补一条极轻量的静态分层校验（检查 `core/`、`platform/`、`ipc/`、`history/`、`remote/`、`api-agent/` 的 import 边界），防止后续漂移。
3. **清零或锁定现有 24 条 ESLint warning**
   - 重点处理生产代码中的复杂度超标函数，避免重构过程中新增超长函数。

**验收标准**：`npm run typecheck && npm run lint` 零 error；测试跑完后 `/tmp` 无新增残留目录；分层校验通过。

---

### Phase 1：WebUI 前端模块化迁入 `esbuild`（最高 ROI，预计 3–5 天，中风险）

**目标**：彻底终结 `page.ts` 1.26 万行内联字符串，复用现有的 `scripts/build-webui-assets.mjs` 构建管线，拿回 `tsc`、`eslint` 与模块化测试。

#### 1.1 目标目录与构建产物

```text
src/platform/webui/
├── page.ts                # 缩减至 <200 行：纯 HTML 壳 + <script type="application/json" id="boot-config"> + 资源引用
├── assets.ts              # 读取 manifest.json（扩展支持 app / style / codeview）
├── codeview/              # 保持按需动态加载不变
└── client/                # 新增：真实 TypeScript 前端源码（独立 tsconfig.json，DOM lib）
    ├── tsconfig.json
    ├── main.ts            # 启动装配与登录门控
    ├── state.ts           # 全局状态、已读/折叠持久化
    ├── cache.ts           # IndexedDB 缓存与预载（复用 cache-script.ts 常量）
    ├── stream.ts          # SSE 订阅、断线续传、隐藏页签驻留、build 校验
    ├── topics.ts          # 侧栏话题树、筛选/排序、年龄显示、行菜单
    ├── transcript.ts      # 消息渲染、代码块、/btw、图片压缩、composer
    ├── styles/            # 拆出的 CSS（由 esbuild 打包为 style-<hash>.css）
    └── panels/            # 各功能面板独立模块
        ├── settings.ts
        ├── schedules.ts
        ├── skills.ts
        ├── reviews.ts
        ├── history.ts
        ├── git.ts
        ├── files.ts
        ├── instructions.ts
        └── terminal.ts
```

#### 1.2 构建与安全收益

- **构建管线**：扩展 `scripts/build-webui-assets.mjs`，同时构建 `app`、`style` 与 `codeview` 三个入口，输出带内容哈希的 `app-<hash>.js`、`style-<hash>.css` 写入 `dist/webui-assets/manifest.json`，复用现有 `/assets/<file>` 的 `immutable` 缓存路由。
- **CSP 收紧**：去掉内联 `<script>` 后，将 `src/platform/webui/server.ts` 中的 `script-src 'unsafe-inline' 'self'` 收紧为 `script-src 'self'`；服务端注入的配置（`title`、`terminal`、`files`、`instructions`、`codeview`、`build` 等）改为 `<script type="application/json" id="boot-config">` 传递，杜绝模板字符串转义陷阱。
- **前后端契约共享**：`client/` 直接 `import type` 复用 `src/platform/webui/protocol.ts` 中的类型定义，接口字段变动在编译期直接报错。
- **测试拆分**：将 16,905 行的 `page.dom.test.ts` 按域拆为 `topics.dom.test.ts`、`cache.dom.test.ts`、`panels-*.dom.test.ts` 等多个文件，允许 Vitest 并行执行并按改动精确触发。

#### 1.3 渐进迁移步骤（降低一次性风险）

1. **Step 1A（搬家不改逻辑）**：将 `page.ts` 的 CSS 与 `SCRIPT` 原样抽出为 `client/styles/main.css` 与 `client/legacy-app.ts`，打通 `esbuild` 构建、`manifest.json`、CSP 收紧和现有 `page.dom.test.ts` 全绿。
2. **Step 1B（按面板逐个拆出）**：每次只抽 1–2 个独立面板（优先从耦合最低的 `reviews.ts`、`history.ts`、`skills.ts`、`git.ts`、`files.ts`、`instructions.ts`、`schedules.ts` 开始），补齐类型注解，同时把对应测试从 `page.dom.test.ts` 迁出。
3. **Step 1C（核心拆清）**：最后拆分 `cache.ts`、`stream.ts`、`topics.ts`、`transcript.ts`，开启 `client/` 目录的严格 `tsc --noEmit` 与 `eslint`。

**验收标准**：`page.ts` < 250 行；`client/` 全量通过 `tsc` 与 `eslint`；`script-src` 移除 `'unsafe-inline'`；所有 DOM 测试与真浏览器回归通过。

---

### Phase 2：Daemon 三大巨型文件按职责拆分（预计 4–6 天，中风险）

**目标**：打破 `agent-acp.ts`、`conversation.ts`、`daemon.ts` 的单文件瓶颈，降低耦合度与 `vitest related` 扇出范围。采用**组合优先于继承**的方式，原类名与公开接口保持不变。

#### 2.1 `src/daemon/agent-acp.ts`（4,303 行）

- `agent-acp-harness.ts`：`resolveHarness`、`resolveClaudeAdapterEntry`、各 harness 启动参数与 quirk 适配。
- `agent-acp-options.ts`：model / effort / mode / custom options 的解析、归一化与权限模式映射。
- `agent-acp-translate.ts`：`session/update` 到 `AgentStreamHandlers` 的纯事件翻译逻辑（无状态，极易单测）。
- `agent-acp.ts`（目标 < 1,200 行）：保留 `createAcpAgentFactory`、会话生命周期、超时与权限应答主流程；拆分超 2,100 行的 `createAcpSession`。

#### 2.2 `src/daemon/conversation.ts`（5,331 行，`ConversationRegistry` ~212 方法）

按文件现有注释分区拆为职责单一的协作者，`ConversationRegistry` 退化为状态持有者与对外门面：

- `conversation-turns.ts`：入队合并、steering/排队策略、turn 执行调度、`stop` / `kill` 与排空状态。
- `conversation-controls.ts`：`/model`、`/effort`、`/cd`、`/fork`、会话标题重命名。
- `conversation-history.ts`：历史记录恢复、transcript 转换与分页读取。
- `conversation-delegation.ts`：子代理话题挂接、定时任务运行入口。

#### 2.3 `src/daemon/daemon.ts`（4,329 行，`Daemon` ~126 方法）

- `daemon-menus.ts`：统一收口 `PendingAsk`、`PendingPick`、`PendingModelMenu`、`PendingEffortMenu`、`PendingSettingsMenu`、`PendingScheduleMenu`、`PendingWorkdirMenu`、`PendingAgentMenu` 的状态管理、过期清理与按钮回调处理。
- `daemon-reverse.ts`：抽出 `handleReverse` 及其分组处理（保留 `const _exhaustive: never` 穷举检查）。
- `daemon.ts`（目标 < 1,500 行）：聚焦依赖装配、启动/停机排空与平台事件路由。

**验收标准**：三个核心文件均降至 1,500 行以内；既有 `daemon/*.test.ts` 无需大幅改写即可全绿；修改单个子模块时 `vitest related` 仅触发对应子集。

---

### Phase 3：测试稳定性治理与 4.0 清理（持续 / 随大版本推进）

1. **消除高负载时序 flake**：排查依赖短真实墙钟宽限期（如 300ms）的异步测试（如 `agent-acp-pump.test.ts` 等），改为事件同步信号或受控假时钟，恢复每次发版均执行完整本地门禁。
2. **4.0 移除改名兼容层**：按 `AGENTS.md` 中“Compatibility with the name talkcode”清单，统一删除 `src/legacy-name.ts` 与 `remote/legacy.go` 及其配套兼容测试。

---

## 4. 优先级与实施路线总览

| 阶段 | 核心内容 | 收益 | 预计投入 | 风险 | 建议顺序 |
|---|---|---|---|---|---|
| Phase 0 | 清理 23 处测试 `/tmp` 泄漏 + 修 `ipc/` 越界 + 分层门禁 | 立即改善开发体验与门禁完整性 | 0.5 天 | 极低 | 第 1 |
| Phase 1 | WebUI `page.ts` 迁入 `esbuild` + 拆 `client/` + 收紧 CSP + 拆 DOM 测试 | **最高**：1.26 万行前端重获类型检查与 lint，测试提速 | 3–5 天 | 中（按 1A→1B→1C 分步可控） | 第 2 |
| Phase 2 | 拆分 `agent-acp.ts` / `conversation.ts` / `daemon.ts` | 降低核心耦合、减少多人/多代理并行冲突与测试波及面 | 4–6 天 | 中 | 第 3 |
| Phase 3 | 治理时序 flake + 4.0 清理 `legacy-name` | 发版门禁稳定、减少长期维护包袱 | 1–2 天 | 低 | 第 4 |
