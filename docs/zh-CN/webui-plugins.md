# 网页端插件

[English](../webui-plugins.md) | 简体中文

网页端工作台的内置功能与外部插件共用同一套贡献点接口。运维可以在 `config.yaml` 中挂载本地插件目录，扩展侧栏视图、编辑器、话题工具、状态栏项、命令、菜单、本设备设置分区以及服务端 HTTP 接口。

## 配置方式

外部插件默认关闭（`plugins: []`）。在 `config.yaml` 的 `platforms.<id>.plugins` 下声明插件目录：

platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    plugins:
      - path: /opt/fleetherd-plugins/hello
        config:
          greeting: "Hello from fleetherd"

- `path`：包含 `fleetherd-plugin.json` 的插件目录，支持 `~` 展开。
- `config`：可选配置对象，原样透传给服务端插件的 `host.config`。

## 清单格式（`fleetherd-plugin.json`）

每个插件目录根下必须有 `fleetherd-plugin.json`，加载时会按严格模式校验（不允许未定义字段）：

{
  "id": "hello",
  "name": "Hello Example",
  "version": "0.1.0",
  "engines": {
    "fleetherdWebui": ">=1.0.0"
  },
  "client": "client.mjs",
  "style": "style.css",
  "server": "server.mjs",
  "assets": ["assets/**"]
}

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 插件唯一标识，需满足 `^[a-z][a-z0-9-]{1,40}$`，且不能与内置插件重名（`topics`、`topic`、`history`、`schedules`、`reviews`、`skills`、`settings`、`changes`、`files`、`terminal`、`reader`、`status`）。 |
| `name` | 是 | 显示名称。 |
| `version` | 是 | 版本号字符串。 |
| `engines.fleetherdWebui` | 否 | 兼容的网页端插件 API 版本范围。 |
| `client` | 否 | 前端 ES 模块入口的相对 POSIX 路径。 |
| `style` | 否 | 注入到 `<head>` 的样式表相对 POSIX 路径。 |
| `server` | 否 | 服务端 Node.js ES 模块入口的相对 POSIX 路径。 |
| `assets` | 否 | 额外静态资源的相对 POSIX 通配模式（支持 `*`、`**`、`?`），通过 `GET /plugins/<id>/<file>` 提供。 |

所有路径必须落在插件目录内部（禁止前导 `/`、`..`、反斜杠，以及指向目录外的软链接）。HTTP 仅提供 `client`、`style` 及命中 `assets` 白名单的文件。

## 前端接口（`PluginContext`）

前端模块在登录鉴权通过后，由页面以同源 `import()` 从 `/plugins/<id>/<client>` 加载，支持以下导出形式：

- `export default { id, activate(ctx), deactivate?() }`
- `export const plugin = { id, activate(ctx), deactivate?() }`
- `export function activate(ctx) { ... }`（可选 `export function deactivate() { ... }`）

单个插件在加载、校验、注册或激活阶段出错都会被隔离，不阻塞内置工作台启动，并在底部状态栏展示非侵入式告警入口。

`ctx: PluginContext` 核心能力：

- `ctx.subscriptions`：`DisposableStore`，插件停用时自动释放；通过 `ctx.*` 注册的贡献会自动纳入其中。
- `ctx.views.register({ id, title, icon?, part, component, when? })`：在 `'sidebar'`、`'secondary'` 或 `'panel'` 注册视图。
- `ctx.editors.register({ kind, component, title })` / `ctx.editors.open(kind, input, opts?)`：在中间编辑区注册和打开自定义编辑器。
- `ctx.topicTools.register({ id, title, icon, defaultPart, available, component })`：注册跟随当前聚焦话题的话题工具视图。
- `ctx.activity.register({ id, title, icon, view, badge?, order? })`：在左侧导航条注册图标并绑定目标视图。
- `ctx.statusBar.register({ id, align, order?, render, onClick? })`：在底部状态栏左侧或右侧注册状态项。
- `ctx.commands.register(id, run, meta?)` / `ctx.commands.execute(id, ...args)`：注册和执行工作台命令（可附带 `keybinding`）。
- `ctx.menus.register(where, item)`：向 `'topic.row'`、`'topic.title'`、`'task.row'` 或 `'message'` 菜单追加项。
- `ctx.settings.registerSection({ id, title, scope: 'device', component })`：注册本设备设置分区（运行时强制 `scope: 'device'`，插件不能改写 `config.yaml`）。
- `ctx.events.on(key, cb)`：订阅工作台事件（`topic.active`、`topic.list`、`topic.message`、`topic.turnEnd`、`stream.state`、`locale.change`、`theme.change`）及服务端推送的 `plugin:<id>:<type>` SSE 事件。
- `ctx.topics`：读取 `list()`、`active()`，调用 `open(id)` 或 `insertIntoComposer(id, text)`。
- `ctx.api.get(path)` / `ctx.api.post(path, body)`：访问本插件的 `/api/plugins/<id>/...`（GET/POST）及公开只读接口白名单（仅 GET；`/api/files/*`、`/api/instructions/*` 等敏感接口被拒绝）。
- `ctx.storage.get(key)` / `ctx.storage.set(key, value)`：按 `plugin:<id>` 隔离的 `localStorage`。
- `ctx.i18n.add(locale, dict)` / `ctx.i18n.t(key, vars?)`：注册多语言字典并翻译文案。
- `ctx.html` / `ctx.render`：内置的 `lit-html` 模板标签与渲染函数。

## 服务端接口（`PluginHost`）

服务端模块在 fleetherd 网关进程内以 Node.js ESM 运行，导出 `activate(host)`（及可选 `deactivate()`）：

- `host.id`、`host.config`、`host.log(msg)`：插件 ID、`config.yaml` 传入的配置及带 `[webui:plugin:<id>]` 前缀的日志函数。
- `host.routes.get(path, handler)` / `host.routes.post(path, handler)`：挂载在 `/api/plugins/<id>/<path>` 下，复用网页端登录/SSO 鉴权与 POST 同源检查，且排在路由表末尾，不能覆盖或遮蔽内置路由。
- `host.topics.list()` / `host.topics.get(id)` / `host.topics.send(id, text)`：读取话题列表/快照，或向话题发消息；通过 `host.topics.send` 发送的文字在对话记录里始终可见并自动带上 `[plugin:<id>]` 前缀。
- `host.events.on('topic' | 'message' | 'turn', cb)`：订阅房间事件（返回 `Disposable`）。
- `host.events.push(type, data)`：复用现有 SSE 连接向已连接页面推送 `plugin:<id>:<type>` 事件。
- `host.storage.read()` / `host.storage.write(value)`：原子读写 `<configDir>/plugins/<id>.json`（权限 `0600`）。

## 使用类型声明（`dist/webui-plugin.d.ts`）

执行 `npm run build:assets`（以及每次发版的 tgz 包）都会生成独立的 `dist/webui-plugin.d.ts`，包含 `PluginContext`、`PluginHost`、`WebuiPlugin`、`ServerPluginModule`、`PanelComponent` 和 `PluginManifest` 的完整声明。

在 TypeScript 插件项目中可直接引用：

/// <reference path="/path/to/fleetherd/dist/webui-plugin.d.ts" />

在无需构建步骤的纯 `.mjs` 插件中，也可以通过 JSDoc `@param` / `@type` 指向 `dist/webui-plugin.d.ts` 获得编辑器补全（参考 `examples/webui-plugin-hello/`）。

## 稳定与不稳定契约边界

- **稳定契约**（破坏性改动需升级 `engines.fleetherdWebui`）：`PluginContext`、`PluginHost`、`--fh-*` 配色与样式 token、`fleetherd-plugin.json` 清单格式。
- **不稳定实现**（小版本可能调整，不应依赖）：内部 DOM 结构、内部 CSS 类名、内部前后端服务。

样式请统一使用 `--fh-*` 语义变量（如 `--fh-bg`、`--fh-bg-side`、`--fh-bg-widget`、`--fh-line`、`--fh-fg`、`--fh-fg-hi`、`--fh-fg-dim`、`--fh-accent`、`--fh-ok`、`--fh-warn`、`--fh-err`），以自动适配 Dark Modern / Light Modern 主题。

## 安全模型

网页端插件受 [AGENTS.md 安全不变量 #12](../../AGENTS.md#security-invariants) 约束：

1. **无沙箱**：服务端模块在网关进程内运行并拥有网关全部权限；前端模块在同源页面内运行并携带用户登录会话。只安装你信任的代码。
2. **仅 `config.yaml` 可安装**：没有任何 HTTP 路由、反向命令、MCP 工具、技能或网页端控件可以安装、启用或写入插件。
3. **目录限制**：加载时拒绝位于 `files.roots` 或任意智能体工作目录下的插件目录（同时校验解析路径与 `realpath`，防止软链接绕过）。
4. **可见归属前缀**：`host.topics.send` 写入对话的消息始终可见并带有 `[plugin:<id>]` 前缀，插件不能向智能体提示词注入隐藏文本。
5. **`fleetherd doctor` 告警**：执行 `fleetherd doctor` 会列出所有已配置的网页端插件、检查清单与目录约束，并明确提醒插件以无沙箱方式运行。

## 运行示例插件（`examples/webui-plugin-hello/`）

仓库自带完整示例 `examples/webui-plugin-hello/`：

1. 将示例目录复制到 `files.roots` 与所有智能体工作目录之外的位置：
   cp -r examples/webui-plugin-hello /opt/fleetherd-plugins/hello
2. 在 `config.yaml` 中加入插件配置：
   platforms:
     web:
       type: webui
       token: ${WEB_TOKEN}
       plugins:
         - path: /opt/fleetherd-plugins/hello
           config:
             greeting: "Hello from fleetherd"
3. 运行 `fleetherd doctor`，确认输出 `hello@0.1.0 ✓` 且无报错。
4. 启动或重启 fleetherd，登录网页端后点击左侧导航条的 **Hello 示例插件**，或点击底部状态栏的 **Hello** 按钮，即可调用 `GET /api/plugins/hello/ping` 并观察实时更新。
