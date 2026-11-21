# TODO

## 架构重构

完整评估与分阶段方案见 [docs/refactor-plan.md](docs/refactor-plan.md)：

- [x] **Phase 0**：清理 24 个测试文件的 `/tmp` 临时目录泄漏；修复 `src/ipc/server.ts` 跨层引用并加静态分层校验；锁定现有 ESLint warning 上限
- [ ] **Phase 1**：将 `src/platform/webui/page.ts` 内联脚本与样式迁入 `esbuild`（`src/platform/webui/client/`），收紧 CSP 移除 `script-src 'unsafe-inline'`，拆分 `page.dom.test.ts`
  - [x] **Step 1A**：内联脚本与样式原样搬到 `client/legacy-app.ts`、`client/styles/main.css`，经 esbuild 打包进 `dist/webui-assets/`（manifest 增 `app`/`style`），服务端配置改走 `boot-config` JSON，CSP `script-src 'self'`
  - [ ] **Step 1B**：按面板逐个拆出 `client/panels/*`（已完成 `reviews`、`history`、`schedules`（含 Sessions 列表与任务页）、`skills`、`git`（含 Commits）、`files`、`instructions`，`legacy-app.ts` 降至 7,350 行；剩 `settings`、agent 自身设置、`terminal`）
  - [ ] **Step 1C**：拆清核心模块，`client/` 开启严格 `tsc` 与 `eslint`
- [x] **Phase 2**：按职责拆分 `src/daemon/agent-acp.ts`、`src/daemon/conversation.ts`、`src/daemon/daemon.ts`（目标单文件 < 1,500 行）
  - [x] `agent-acp.ts`：已按职责拆分为 `agent-acp.ts`（1,185 行）、`agent-acp-harness.ts`、`agent-acp-options.ts`、`agent-acp-translate.ts`，消除 5 条 ESLint warning（上限锁紧至 22）
  - [x] `conversation.ts`：已按职责拆分为 `conversation.ts`（952 行）、`conversation-turns.ts`、`conversation-controls.ts`、`conversation-commands.ts`、`conversation-history.ts`、`conversation-delegation.ts`，共享类型与上下文在 `conversation-context.ts`；消除 4 条 ESLint warning（上限锁紧至 18）
  - [x] `daemon.ts`：已拆为 `daemon.ts`（1,005 行）、`daemon-menus.ts`（8 类待答菜单与按钮回调）、`daemon-reverse.ts`（反向命令分发），共享视图在 `daemon-context.ts`
- [ ] **Phase 3**：消除高负载下异步测试时序 flake；4.0 大版本移除 `legacy-name` 兼容层
