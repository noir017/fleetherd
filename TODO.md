# TODO

## 架构重构

完整评估与分阶段方案见 [docs/refactor-plan.md](docs/refactor-plan.md)：

- [x] **Phase 0**：清理 24 个测试文件的 `/tmp` 临时目录泄漏；修复 `src/ipc/server.ts` 跨层引用并加静态分层校验；锁定现有 ESLint warning 上限
- [ ] **Phase 1**：将 `src/platform/webui/page.ts` 内联脚本与样式迁入 `esbuild`（`src/platform/webui/client/`），收紧 CSP 移除 `script-src 'unsafe-inline'`，拆分 `page.dom.test.ts`
- [ ] **Phase 2**：按职责拆分 `src/daemon/agent-acp.ts`、`src/daemon/conversation.ts`、`src/daemon/daemon.ts`（目标单文件 < 1,500 行）
- [ ] **Phase 3**：消除高负载下异步测试时序 flake；4.0 大版本移除 `legacy-name` 兼容层
