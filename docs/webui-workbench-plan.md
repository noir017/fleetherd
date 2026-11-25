# Web UI 工作台改版开发方案

> 内部工程方案，不是面向用户的功能文档。基于 `3.38.0` 源码实测编写（2026-11-24）。
> 给并行开发的多个代理用：每个工作包写明独占文件、依赖、验收标准，按 §8 的规则协作。
> 接续 [refactor-plan.md](refactor-plan.md) 的 Phase 1：其 Step 1C（拆分 `legacy-app.ts` 核心）就是本方案的 P0。

## 1. 结论

把 Web UI 重搭成 VS Code 式的**工作台**：基础服务 → 工作台外壳 → 贡献点（内部插件接口）→ 功能。现有功能全部改写为内置插件，走同一套贡献点；外部插件（前端 + 服务端）用同一套接口。拖拽布局自研，但只通过 `DockEngine` 接口使用，将来可以换成 dockview 等库而不动功能代码。默认布局是已确认的设计稿 v3 加底部状态栏（[webui-workbench-mockup.html](webui-workbench-mockup.html)）。分 P0–P4 五期，每期末发一个版本。

### 已定的决定（2026-11-24，与运维确认）

| # | 决定 | 理由 |
|---|---|---|
| 1 | 布局沿用设计稿 v3，并加回底部状态栏；配色、圆角、控件样式参照 VS Code Dark Modern / Light Modern | 运维确认过线框稿。**只借 VS Code 的配色和样式，不借它的布局部件** |
| 2 | 拖拽引擎**自研**，功能代码只依赖 `DockEngine` 接口，接口命名对齐 dockview | dockview-core 8.9.1 摇树后 gzip 89KB，现有 app 才 137KB；自研更小，留接口方便以后迁移 |
| 3 | 模板渲染引入 lit-html（`html` + `render`，gzip 3.1KB） | 默认转义，取代手拼字符串加 `text()`；体积可以忽略 |
| 4 | 插件**前后端一起做**（P4） | 有的功能需要新的服务端接口 |
| 5 | **原地分期替换**：没有长期并存的两套界面，每期末发版并删掉旧代码 | 避免两套都要维护。期内未完成的工作藏在不对外公开的开发开关后（§8.6） |
| 6 | 真浏览器测试**单独建一个 CI**（`webui-e2e.yml`），不作为发版门禁 | jsdom 测不了布局和拖拽；与「测试和发版解耦」（2026-11-20）一致 |

### 不做

- 不引入 React、Vue 等框架（refactor-plan 原则 1）
- 不做插件市场、不在网页上热安装、不做 iframe 沙箱
- 布局只存在本机浏览器，不同步到服务端
- 不改 daemon 和 Web UI 之间的协议，插件宿主除外

## 2. 现状与问题（实测）

| 项 | 现状 | 证据 |
|---|---|---|
| 客户端核心 | `client/legacy-app.ts` 7,954 行、356 个顶层函数，不过 tsc 和 eslint | `client/tsconfig.json` 的 exclude、`eslint.config.js:18` |
| 已拆出的面板 | 7 个（reviews、history、git、files、instructions、schedules、skills），都用"依赖袋 + innerHTML 字符串"模式 | `client/panels/*.ts`、`legacy-app.ts:98-330` |
| 入口分散 | 左栏头部有 3 个标签加 2 个图标，左栏底部有"菜单/管理"，对话头部有 6 个图标，右栏有上下两层标签 | `page-body.ts:19-74, 276-308, 424-447` |
| 浮层 | 8 个模态浮层，各自一套标题栏；Esc 的关闭名单是写死的 | `legacy-app.ts:6460-6462` |
| git 评论 | 评论写进输入框，但输入框被 git 窗口盖住 | `panels/git.ts:1084` |
| 颜色变量 | 浅色主题 192 个，其中 33 组取值重复 | `styles/main.css:13` |
| 包体积 | app 597KB，gzip 后 137KB | `dist/webui-assets/app-*.js` |
| DOM 测试 | 约 2 万行 `page.dom.*.test.ts`，在 jsdom 里跑整个打包后的脚本 | `page.test-helpers.ts` |

## 3. 目标架构

```
基础服务  base/ + services/     事件、生命周期、渲染、请求、SSE、状态、缓存、命令、快捷键、浮层栈、存储
工作台    workbench/            外壳各区、DockEngine（静态实现 → 可拖拽实现）、手机逐页外壳
贡献点    plugins/              PluginContext：视图、编辑器、话题工具、导航条、状态栏、命令、菜单、设置分区
功能      features/<name>/      每个功能都是一个内置插件，只通过 PluginContext 接入
组件      components/           功能之间共用的界面组件
```

依赖方向：`features → plugins → workbench → components → services → base`，只向下，不许反向。外部插件只能拿到 `PluginContext`（§6）。

### 3.1 目录（P1 结束时）

```
src/platform/webui/client/
  main.ts                 入口：读 BOOT、登录门、装配服务、挂外壳、激活内置插件和外部插件
  base/                   lifecycle.ts(Disposable) event.ts(Emitter) html.ts(lit-html) dom.ts
  services/               api.ts stream.ts store.ts cache.ts commands.ts keybindings.ts overlays.ts storage.ts boot.ts
  components/             list/ filterbar/ actionbar/ tabs/ menu/ dialog/ quickpick/ form/ tree/ badge/ notice/ splitter/
  workbench/              contracts.ts shell.ts parts/ dock/(engine.ts static.ts splitview.ts gridview.ts group.ts dnd.ts serialize.ts) stack-shell.ts
  plugins/                api.ts(公开类型) registry.ts builtin.ts loader.ts(P4)
  features/               topics/ topic/(对话编辑器) history/ schedules/ reviews/ skills/ settings/ changes/ files/ terminal/ reader/ status/
  i18n/  styles/(tokens.css + 各区和各功能一份 css)
```

`panels/` 的 7 个模块在 P1 移进 `features/`。`page-body.ts` 在 P1 缩成几个挂载点。

### 3.2 窗口模型

- **区（part）**：导航条、主侧栏、编辑区、副侧栏（右）、底部面板、状态栏。
- **视图（view）**：列表类内容，放进主侧栏、副侧栏或底部面板。同一个区里的多个视图以标签形式叠放。
- **编辑器（editor）**：一份文档，在编辑区里开成标签。编辑区可以分成多个组。
- **话题工具**（更改、文件、终端）是跟随**当前聚焦话题**的视图，就像 VS Code 的源代码管理视图跟随当前仓库。默认位置：更改和文件在副侧栏，终端在底部面板，都可以拖到别处。工具里的单个文档（某个文件的 diff、某个文件）可以"在编辑器中打开"。
- **侧栏组和编辑区组分开**：导航条和主侧栏只切换列表（话题、历史、复盘、技能……），点列表里的一项就在编辑区开成标签；换侧栏不关已开的标签。宽屏下编辑区顶部常驻标签条，标签下面仍是 v3 的标题栏（标题、状态、工具按钮、⋯）。（2026-11-25 运维要求）

| 内容 | 类型 | 默认位置 |
|---|---|---|
| 话题（全部/收藏）、历史、定时（任务/会话）、复盘、技能、设置目录 | 视图 | 主侧栏，由导航条切换 |
| 对话、历史记录（只读）、任务详情、技能、设置、指令文件、diff、文件、阅读器 | 编辑器 | 编辑区 |
| 更改、文件 | 话题工具（视图） | 副侧栏 |
| 终端 | 话题工具（视图） | 底部面板 |
| 连接、运行中、空闲（点开即"关闭空闲"）、通知、低打扰、语言、版本/有更新 | 状态栏项 | 状态栏 |

### 3.3 宽度规则

| 宽度 | 行为 |
|---|---|
| ≥ 1024px | 完整工作台，可拖拽。打开副侧栏时如果编辑区会窄于 640px，自动收起主侧栏，关掉副侧栏后恢复 |
| 640–1023px | 主侧栏和副侧栏变成浮层抽屉；编辑区只有一组，标签可以排序，但不能分屏 |
| < 640px | 逐页进入的手机外壳（`stack-shell.ts`），不加载拖拽代码；底栏是话题/历史/定时/更多；话题页顶部有工具标签：对话、更改、文件、终端 |

视图和编辑器只拿到一个容器元素，所以同一个组件在三种外壳里都能用。

## 4. 视觉规范

线框稿：[webui-workbench-mockup.html](webui-workbench-mockup.html)（地址加 `?light` 看浅色；文件头注释列出全部视图的 hash；`?m` 看手机外壳，`?gallery` 把手机的每一页并排摆出来）。同一套组件（侧栏视图、编辑器、话题工具、底部面板）由桌面工作台和手机外壳两个外壳渲染。手机外壳按原生手机习惯设计：大标题、底部标签栏、逐页进入和返回、左滑与长按操作、底部弹出面板、开关、分组列表、贴底输入框、安全区；颜色 token 不变，尺寸和圆角按手机习惯放大。

### 4.1 颜色 token（P0-10 定义，P1-4 落地）

现有 192 个变量收拢成下面这些按用途命名的 token（前缀 `--fh-`）。旧变量名在 P1 切换前保留为别名。插件只能用这些 token（§6.4）。

| token | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `bg` | #1f1f1f | #ffffff | 编辑区 |
| `bg-side` | #181818 | #f8f8f8 | 侧栏、导航条、状态栏、面板头 |
| `bg-widget` | #252526 | #f8f8f8 | 浮层、代码块头、评论框 |
| `bg-code` | #2b2b2b | #f2f2f2 | 行内代码 |
| `line` | #2b2b2b | #e5e5e5 | 分隔线、边框 |
| `fg` / `fg-hi` / `fg-dim` | #cccccc / #e7e7e7 / #9d9d9d | #3b3b3b / #1f1f1f / #717171 | 正文 / 强调 / 说明 |
| `fg-inactive` | #868686 | #616161 | 导航条未选中项 |
| `accent` / `accent-hover` | #0078d4 / #026ec1 | #005fb8 / #0258a8 | 主按钮、选中指示、焦点 |
| `link` | #4daafc | #005fb8 | 链接 |
| `input` / `input-line` / `placeholder` | #313131 / #3c3c3c / #989898 | #ffffff / #cecece / #767676 | 输入框 |
| `btn2` / `btn2-hover` | #313131 / #3c3c3c | #e5e5e5 / #cccccc | 次按钮 |
| `hover` / `sel` / `sel-inactive` | #2a2d2e / #04395e / #37373d | #f2f2f2 / #e8e8e8 / #e4e6f1 | 列表悬停、选中、失焦选中 |
| `toggle` / `toggle-line` | rgba(36,137,219,.51) / #2488db | rgba(0,95,184,.12) / #005fb8 | 开启状态的筛选标签 |
| `own` / `own-edge` | rgba(0,120,212,.10) / #0078d4 | rgba(0,95,184,.06) / #005fb8 | 自己发的消息 |
| `ok` / `warn` / `err` / `idle` | #89d185 / #cca700 / #f14c4c / #6e7681 | #388a34 / #bf8803 / #e51400 / #8b949e | 状态点、状态文字 |
| `git-mod` / `git-add` / `git-new` / `git-del` | #e2c08d / #81b88b / #73c991 / #e06c6c | #895503 / #587c0c / #007100 / #ad0707 | 文件状态 |
| `diff-add` / `diff-del` | rgba(155,185,85,.2) / rgba(255,0,0,.2) | rgba(155,185,85,.2) / rgba(255,0,0,.12) | diff 行底色 |
| `hc-<harness>`、`hc-<harness>-bg` | claude #e0805f，codex #3fb68b，底色取 15% | claude #b5532f，codex #0d8a6a，底色取 10% | harness 标签 |

其余 harness（opencode、agy、gemini、dsh）沿用现有色相，按同样规则换算深浅两套值。

### 4.2 形状与控件

- 圆角：输入框、按钮、筛选标签、分段切换 **2px**；卡片、消息气泡、浮层、评论框 **4px**；列表行和标签页 **直角**；计数徽标是胶囊形。
- 列表选中：`sel` 底色加 1px `accent` 描边；悬停用 `hover`。
- 按钮：主按钮 `accent` 底白字；次按钮 `btn2` 底。没有阴影。
- 分段切换：容器 `bg-widget` 底加 1px `input-line` 边；导航类的选中项（全部/收藏、工具按钮）用 `sel-inactive`，取值类的选中项（设置里的选项）用 `accent`。
- 字体：界面 13px，用系统 UI 字体；代码用 `"Cascadia Code","JetBrains Mono",Consolas,monospace`。分组标题 11px、大写、字距 .05em。
- 滚动条 10px，滑块 `rgba(121,121,121,.4)`。
- 图标沿用 `icons.ts`，描边 1.5（AGENTS.md：只用内联 SVG）。

### 4.3 页面一览

截图取自线框稿（2026-11-25）。以线框稿为准，改了线框稿就重截这里的图。地址都是相对 `webui-workbench-mockup.html` 的。

#### 宽屏（1440×900）

**话题对话 + 右侧「更改」分栏，编辑区顶部是标签条** · `#topic`

![话题对话 + 右侧「更改」分栏，编辑区顶部是标签条](images/workbench/desktop-01-topic.png)

**文件：目录树、别处改过的提示、编辑器** · `#files`

![文件：目录树、别处改过的提示、编辑器](images/workbench/desktop-02-files.png)

**终端：对话下方的底部面板，多个会话用标签切换** · `#term`

![终端：对话下方的底部面板，多个会话用标签切换](images/workbench/desktop-03-term.png)

**命令面板（Ctrl K）** · `#palette`

![命令面板（Ctrl K）](images/workbench/desktop-04-palette.png)

**话题行的 ⋯ 菜单** · `#menu`

![话题行的 ⋯ 菜单](images/workbench/desktop-05-menu.png)

**删除确认** · `#confirm`

![删除确认](images/workbench/desktop-06-confirm.png)

**新话题：选智能体和目录** · `#new`

![新话题：选智能体和目录](images/workbench/desktop-07-new.png)

**定时任务详情** · `#tasks`

![定时任务详情](images/workbench/desktop-08-tasks.png)

**编辑定时任务** · `#task-edit`

![编辑定时任务](images/workbench/desktop-09-task-edit.png)

**定时 · 会话：每次运行开出的话题** · `#sessions`

![定时 · 会话：每次运行开出的话题](images/workbench/desktop-10-sessions.png)

**历史：侧栏切到历史，对话标签仍开着** · `#history`

![历史：侧栏切到历史，对话标签仍开着](images/workbench/desktop-11-history.png)

**复盘详情** · `#reviews`

![复盘详情](images/workbench/desktop-12-reviews.png)

**待处理的偏好建议** · `#prefs`

![待处理的偏好建议](images/workbench/desktop-13-prefs.png)

**技能页：开关、文件、编辑器、改动记录** · `#skills`

![技能页：开关、文件、编辑器、改动记录](images/workbench/desktop-14-skills.png)

**网关设置 · 智能体** · `#settings`

![网关设置 · 智能体](images/workbench/desktop-15-settings.png)

**网关设置 · 子代理、会话、回复、复盘** · `#settings-gw`

![网关设置 · 子代理、会话、回复、复盘](images/workbench/desktop-16-settings-gw.png)

**指令文件** · `#instr`

![指令文件](images/workbench/desktop-17-instr.png)

**本设备** · `#device`

![本设备](images/workbench/desktop-18-device.png)

**登录** · `#login`

![登录](images/workbench/desktop-19-login.png)

#### 640–1023px（820 宽竖屏）

**侧栏收起 / 列表抽屉 / 更改抽屉** · `?t#topic`、`?t&drawer=list#topic`、`?t&drawer=pane#topic`

![820 宽的三种状态](images/workbench/tablet.png)

#### 手机（390×844）

**话题：列表（左滑操作）、长按面板、对话、选模型、新话题** · `?gallery=1`

![话题：列表（左滑操作）、长按面板、对话、选模型、新话题](images/workbench/phone-1-topics.png)

**话题工具：更改、diff 评论、文件、编辑文件、终端** · `?gallery=2`

![话题工具：更改、diff 评论、文件、编辑文件、终端](images/workbench/phone-2-tools.png)

**定时与历史** · `?gallery=3`

![定时与历史](images/workbench/phone-3-tasks-history.png)

**更多、复盘、复盘详情、偏好建议** · `?gallery=4`

![更多、复盘、复盘详情、偏好建议](images/workbench/phone-4-more-reviews.png)

**技能、技能页、设置、设置 · 智能体** · `?gallery=5`

![技能、技能页、设置、设置 · 智能体](images/workbench/phone-5-skills-settings.png)

**设置细项：单选、开关、指令文件** · `?gallery=6`

![设置细项：单选、开关、指令文件](images/workbench/phone-6-settings-detail.png)

**外观与语言、编辑任务、定时 · 会话、删除确认、登录** · `?gallery=7`

![外观与语言、编辑任务、定时 · 会话、删除确认、登录](images/workbench/phone-7-forms.png)

#### 浅色示例

**话题对话** · `?light#topic`

![浅色话题对话](images/workbench/light-desktop-topic.png)

**技能页** · `?light#skills`

![浅色技能页](images/workbench/light-desktop-skills.png)

**手机 · 话题** · `?gallery=1&light`

![浅色手机话题](images/workbench/light-phone-1-topics.png)

## 5. 拖拽布局（自研）

### 5.1 接口（P0-1 写进 `workbench/contracts.ts`，之后冻结）

命名和语义对齐 dockview（`addPanel`、`getPanel`、`removePanel`、`toJSON/fromJSON`、`onDidLayoutChange`、`onDidActivePanelChange`、`api.setTitle`），以后换成 dockview 只需要写一个适配器。**功能代码不直接接触引擎**，只用工作台服务（`editors.open()`、`views.reveal()`、`tools.toggle()`）。

```ts
export type PartId = 'sidebar' | 'secondary' | 'panel';
export type Direction = 'left' | 'right' | 'above' | 'below' | 'within';
export type PanelPosition =
  | { part: PartId; index?: number }
  | { group: string; direction?: Direction; index?: number }
  | { referencePanel: string; direction: Direction };

export interface PanelComponent {
  readonly element: HTMLElement;
  init(params: unknown, ctx: PanelInitContext): void;
  update?(params: unknown): void;
  focus?(): void;
  dispose(): void;
}
export interface PanelRef {
  readonly id: string; readonly group: string | PartId; readonly params: unknown;
  readonly onDidVisibilityChange: Event<boolean>;
  readonly onDidDimensionsChange: Event<{ width: number; height: number }>;
  setTitle(title: string): void; setBadge(n: number | null): void; focus(): void; close(): void;
}
export interface DockEngine extends Disposable {
  readonly onDidLayoutChange: Event<void>;
  readonly onDidActivePanelChange: Event<PanelRef | undefined>;
  registerComponent(name: string, factory: () => PanelComponent): Disposable;
  addPanel(o: { id: string; component: string; title: string; params?: unknown; position?: PanelPosition }): PanelRef;
  getPanel(id: string): PanelRef | undefined;
  removePanel(id: string): void;
  movePanel(id: string, to: PanelPosition): void;
  setPartVisible(part: PartId, visible: boolean): void;
  maximizeGroup(group: string): void; exitMaximized(): void;
  toJSON(): LayoutState; fromJSON(state: LayoutState): void;
  layout(width: number, height: number): void;
}
```

`LayoutState` 是我们自己带版本号的格式（`{ v: 1, parts, grid, panels }`），不照抄任何库的格式。换库时写一个转换器。

### 5.2 实现（全部在 `workbench/dock/`）

| 模块 | 职责 |
|---|---|
| `splitview.ts` | 一维排列：各区大小、最小和最大尺寸、拖动分隔条、窗口变化时按比例重排。P1 的固定布局就用它（主侧栏和副侧栏可以拖宽，等同现在的 `--pw`） |
| `gridview.ts` | 编辑区分组的二叉树（行和列交替）；分组、合并、删空组、规范化 |
| `group.ts` | 一个组：标签条（排序、关闭、未保存标记、只剩一个标签时画成标题栏）加内容区 |
| `dnd.ts` | 用 pointer 事件自己实现拖拽，不用 HTML5 DnD（触屏不可靠）：拖动时的半透明副本，放置区（标签条上的插入位置、组的中心、四条边、各区的头部和空白处），按 Esc 取消 |
| `serialize.ts` | `LayoutState` v1：校验、迁移、丢掉已不存在的组件、恢复失败就回到默认布局 |
| `static.ts` | P1 用的 `DockEngine` 实现：固定的几个区加一个编辑组，没有拖拽 |
| `engine.ts` | P2 用的完整实现 |

约束：
- lint 规则照旧（复杂度 ≤ 18、单函数 ≤ 140 行、不许 `any`）。
- 尺寸和树的计算写成纯函数，在 node 里单测，不依赖 DOM。
- 用 ResizeObserver 时，jsdom 测试要在 `page.dom.test-helpers.ts` 里补一个垫片。
- 布局存在 `localStorage['aa_layout']` 里；"重置布局"命令清掉它。

## 6. 插件接口

### 6.1 前端：`PluginContext`（P0-1 写类型，P1-2 实现，P4-3 对外公开）

```ts
export interface WebuiPlugin { id: string; activate(ctx: PluginContext): void | Promise<void>; deactivate?(): void }
export function definePlugin(p: WebuiPlugin): WebuiPlugin;

export interface PluginContext {
  readonly id: string;
  readonly subscriptions: DisposableStore;
  views: { register(v: { id: string; title: string; icon?: string; part: PartId; component: () => PanelComponent; when?: () => boolean }): Disposable };
  editors: { register(e: { kind: string; component: () => PanelComponent; title(input: unknown): string }): Disposable;
             open(kind: string, input: unknown, opts?: { position?: PanelPosition; preview?: boolean }): void };
  topicTools: { register(t: { id: string; title: string; icon: string; defaultPart: PartId; available(topic: TopicInfo): boolean; component: () => PanelComponent }): Disposable };
  activity: { register(a: { id: string; title: string; icon: string; view: string; badge?: () => number | 'dot' | null; order?: number }): Disposable };
  statusBar: { register(s: { id: string; align: 'left' | 'right'; order?: number; render(el: HTMLElement): void; onClick?(): void }): Disposable };
  commands: { register(id: string, run: (...a: unknown[]) => unknown, meta?: { title?: string; keybinding?: string }): Disposable;
              execute(id: string, ...a: unknown[]): Promise<unknown> };
  menus: { register(where: 'topic.row' | 'topic.title' | 'task.row' | 'message', item: MenuItem): Disposable };
  settings: { registerSection(s: { id: string; title: string; scope: 'device'; component: () => PanelComponent }): Disposable };
  events: { on<K extends keyof WebuiEvents>(k: K, cb: (e: WebuiEvents[K]) => void): Disposable };
  topics: { list(): readonly TopicInfo[]; active(): TopicInfo | undefined; open(id: string): void;
            insertIntoComposer(id: string, text: string): void };
  api: { get<T>(path: string): Promise<T>; post<T>(path: string, body: unknown): Promise<T> };   // 只能访问 /api/plugins/<id>/ 和公开的只读接口
  storage: { get<T>(k: string): T | undefined; set(k: string, v: unknown): void };          // localStorage，按插件 id 隔离
  i18n: { add(locale: string, dict: Record<string, string>): void; t(key: string, vars?: Record<string, unknown>): string };
  html: typeof import('lit-html').html; render: typeof import('lit-html').render;
}
```

- 内置功能（§3.2 的每一行）都通过这个接口注册。`features/*` 不许直接 import `workbench/` 或别的 feature，只能用 `PluginContext` 和 `components/`。这条用 eslint 的 `no-restricted-imports` 强制。
- `menus`：话题行的 ⋯ 菜单、标题栏菜单、任务行菜单都从注册表生成，取代现在的 `openTopicMenu` 和 `openTaskMenu`。
- 设置分区只开放 `scope: 'device'`（本设备）。网关设置仍由 daemon 的 `settingsScreen` 驱动（`core/settings.ts` 是唯一来源），插件不能往 config.yaml 写设置。

### 6.2 服务端：插件宿主（P4-1、P4-2）

配置（`WebuiConfigSchema`，这个 schema 里的**第六个安全决定**，默认是空列表）：

```yaml
platforms:
  web:
    type: webui
    plugins:
      - path: /opt/fleetherd-plugins/hello   # 目录，里面有 fleetherd-plugin.json
        config: { greeting: hi }             # 原样交给插件
```

清单 `fleetherd-plugin.json`（zod 严格校验）：`{ id, name, version, client?: "dist/client.js", style?: "dist/style.css", server?: "dist/server.mjs", assets?: ["dist/assets/**"] }`。`id` 的格式为 `^[a-z][a-z0-9-]{1,40}$`，不能和内置插件重名。

服务端模块导出 `activate(host: PluginHost)`：

```ts
export interface PluginHost {
  readonly id: string; readonly config: unknown; readonly log: (msg: string) => void;
  routes: { get(path: string, h: Handler): void; post(path: string, h: Handler): void };   // 挂在 /api/plugins/<id>/ 下
  topics: { list(): TopicInfo[]; get(id: string): TopicSnapshot | undefined;
            send(id: string, text: string): Promise<void> };                              // 以插件名义发，在对话里可见、带插件标识
  events: { on(k: 'topic' | 'message' | 'turn', cb: (e: unknown) => void): Disposable;
            push(type: string, data: unknown): void };                                    // 经现有 SSE，以 plugin:<id>:<type> 推给页面
  storage: { read(): Promise<unknown>; write(v: unknown): Promise<void> };                // <configDir>/plugins/<id>.json
}
```

- 路由：`server.ts` 的 GUARDED 表里加一项 `/api/plugins/` 前缀，按 id 分发。插件路由沿用现有登录和来源检查，不能覆盖或遮住内置路由。
- 资源：`GET /plugins/<id>/<file>`，放在 GUARDED 里，只服务清单里列出的文件。CSP 不变：插件脚本是同源文件，所以 `script-src 'self'` 足够。
- 启动配置（boot-config）加一项 `plugins: [{ id, version, client, style }]`。页面用 `import()` 加载插件脚本，每个插件单独 try/catch：一个插件挂了不影响页面，状态栏给出提示。
- 分层：服务端宿主放在 `src/platform/webui/plugins/`，只通过 `WebRoom` 访问网关，不 import `daemon/`。

### 6.3 安全（P4-4 写进 AGENTS.md，作为第 12 条安全不变量）

1. 插件就是网关自己的代码：服务端模块在网关进程里运行，有它的全部权限；前端模块在页面里运行，带着登录会话。**不提供沙箱**。
2. **只有 config.yaml 能装插件。** 没有任何路由、反向命令、MCP 工具、技能或网页控件可以安装、启用或写入插件。
3. 加载时拒绝两类目录：在 `files.roots` 之下的，以及在任何 agent 工作目录之下的。这是尽力而为：和网关同一个用户运行的本机 agent 仍然属于不变量 1 的边界。
4. 插件发进话题的文字在对话里可见，并标明来自哪个插件。插件不能往 agent 的提示词里加隐藏文字（对应「Nothing of the gateway's in the agent's prompt」原则）。
5. `doctor` 列出已配置的插件，并提示上面第 1 条。

### 6.4 对外契约

- 类型从 `client/plugins/api.ts` 和 `webui/plugins/host.ts` 生成 `dist/webui-plugin.d.ts`，随发版的 tgz 一起提供。
- 稳定的部分：`PluginContext`、`PluginHost`、`--fh-*` 颜色 token、清单格式。不稳定的部分：类名、DOM 结构、内部服务。
- 破坏性改动要升插件 API 的版本（清单里加 `engines.fleetherdWebui`）。
- 示例插件放在 `examples/webui-plugin-hello/`：一个状态栏项、一个侧栏视图、一个服务端路由。

## 7. 分期与工作包

工作量：S（约 1 个代理日）、M（2–3 天）、L（4–6 天）、XL（更多）。"→" 表示依赖。同一波的包可以并行。

### P0 地基（用户看不到变化，期末发版）

目标：`legacy-app.ts` 只剩装配代码，然后改名为 `main.ts`；整个 `client/` 都过 tsc 和 eslint。**行为不变，现有 page.dom 测试保持全绿。**

| 包 | 内容 | 独占文件 / 从 legacy-app 搬出的行段 | 依赖 | 量 |
|---|---|---|---|---|
| P0-1 | 契约和基础服务：`base/*`；`services/api.ts`（取代 `text/wait/post/sendLimit`，1216–1287）；`stream.ts`（取代 `handle…connect`，5220–5681）；`store.ts`、`commands.ts`、`keybindings.ts`、`overlays.ts`（取代 Esc 名单 6445–6478）、`storage.ts`、`boot.ts`；`workbench/contracts.ts`（§5.1）；`plugins/api.ts` 的类型（§6.1）；引入 lit-html | `base/` `services/` `workbench/contracts.ts` `plugins/api.ts`、package.json 的依赖 | — | L |
| P0-E | e2e 基础设施：`test/e2e/webui/`（Playwright、隔离网关、假 ACP agent、初始数据）、`.github/workflows/webui-e2e.yml`、`npm run test:e2e`；现有界面的冒烟用例（登录、发消息、切话题、手机） | `test/e2e/` 、workflow、package.json 的 devDependencies | — | M |
| P0-10 | 样式：`main.css` 拆成 `styles/tokens.css` 加各区各功能一份；定义 §4.1 的 `--fh-*` token，旧变量改成别名，取值不变 | `styles/` | — | M |
| P0-2 | 缓存和已读状态 → `services/cache.ts`、`services/reads.ts` | 382–628 | P0-1 | M |
| P0-3 | 话题列表 → `features/topics/`（时间格式、行模板、树、筛选条、排序、预取、切换、删除、行菜单、新建、收藏、分叉、关闭空闲） | 891–1188、3079–4131、4413–4674、5681–6301 | P0-1 | L |
| P0-4 | 对话记录 → `features/topic/transcript/`（滚动、绘制、代码块、/btw、消息模板、本轮改动、目录选择器、工具行折叠、合并消息、骨架屏、新话题的 agent 列表、机器状态、分叉提示） | 1287–2035、2592–3078、`log` 的事件绑定（6302–6382、6421–6425） | P0-1 | L |
| P0-5 | 设置页 → `features/settings/` | 2036–2591、`settingsBody` 的事件绑定（6383–6420） | P0-1 | M |
| P0-6 | 状态行、排队消息、模型和选项弹层 → `features/topic/status/` | 4675–5219 | P0-1 | M |
| P0-7 | 输入框 → `features/topic/composer/`（附件标签、草稿、图片压缩、录音、斜杠提示、未发送消息、发送、复制引用） | 6600–7885 | P0-1 | L |
| P0-8 | 其余 → `features/{notify,terminal,reader}/`，以及 `workbench/legacy-shell.ts`（`makePanel`、菜单、低打扰、主题、语言，P1 会被替换） | 629–890、4132–4412、6426–6599 | P0-1 | M |
| P0-9 | 收尾：legacy-app → `main.ts`（只剩 DOM 引用、各模块的装配、末尾 7886–7954 的启动顺序）；client 全部开启 tsc 和 eslint；删掉排除项；更新 fras 和 README | `main.ts`、tsconfig、eslint 配置 | P0-2…P0-8 | S |

- **行号以 3.38.0 为准**，是函数起点划出的大致范围，开工前先确认。文件里另有 64 处顶层事件绑定（`addEventListener`，其中 20 处挂在 `document` 或 `window` 上），散在各处：每个包用 grep 找出调用自己函数的绑定，一起搬走。`document` 上的 Esc 处理（6445–6478）归 P0-1 的浮层栈。
- legacy-app 的冲突规则：每个包只删自己的行段，并在文件顶部的 `// WIRING` 区追加自己的装配调用。合并顺序固定：P0-1 → P0-2 → P0-5 → P0-6 → P0-8 → P0-4 → P0-3 → P0-7 → P0-9，后合并的先 rebase。
- page.test.ts 里按脚本文本断言的用例，由搬走那段代码的包负责改成读新文件。

### P1 工作台外壳和配色（期末切换为默认并发版）

| 包 | 内容 | 依赖 | 量 |
|---|---|---|---|
| P1-1 | 外壳：各区、`splitview.ts`、`static.ts`（DockEngine 的静态实现）、宽度规则（§3.3）、`stack-shell.ts`；`page-body.ts` 缩成几个挂载点 | P0 | L |
| P1-2 | 贡献点注册表和内部 `PluginContext`；导航条和状态栏由注册的贡献生成；内置插件清单 `builtin.ts` | P0 | M |
| P1-3 | 组件库 `components/*`：列表（分组、选中、键盘、⋯）、筛选条（搬 `makeFilterBar`）、按钮条、标签和分段切换、菜单（搬 `openRowMenu`）、确认框、选择弹层、表单控件、文件树、徽标、标签、状态点、提示条、空状态、分隔条 | P0 | L |
| P1-4 | 配色：按 §4 落地深浅两套 token 取值，以及形状、控件、滚动条 | P0-10 | M |
| P1-5 | 话题视图（全部/收藏）+ 历史视图 + 只读历史编辑器 | P1-1…3 | M |
| P1-6 | 对话编辑器：对话记录、输入框、状态行、标题栏（单标签时的样子）、工具按钮、⋯ 菜单 | P1-1…3 | L |
| P1-7 | 定时（任务/会话视图 + 任务编辑器）+ 复盘视图 | P1-1…3 | M |
| P1-8 | 技能视图 + 技能编辑器 | P1-1…3 | M |
| P1-9 | 设置：目录视图 + 设置编辑器（网关部分仍由 `settingsScreen` 驱动）+ 本设备分区 + 指令文件编辑器 | P1-1…3 | M |
| P1-10 | 更改工具（文件列表 + 行内 diff + 评论直接进对应话题的输入框）+ diff 编辑器；文件工具（文件树 + 编辑）+ 文件编辑器 | P1-1…3 | L |
| P1-11 | 终端视图（底部面板）+ 阅读器编辑器 + 看图浮层 | P1-1…3 | M |
| P1-12 | 状态栏各项、关闭空闲确认框、通知、低打扰、语言、主题、版本和有更新提示 | P1-1…3 | S |
| P1-13 | 切换：删开发开关、旧外壳、旧 CSS、旧菜单；重写 layout 和 chrome 两组 DOM 测试；补 e2e 用例；更新 `docs/web-ui.md`（中英文）、README 截图、CHANGELOG；发版 | P1-4…12 | M |

### P2 拖拽（发版）

| 包 | 内容 | 依赖 | 量 |
|---|---|---|---|
| P2-1 | `gridview.ts` + `group.ts`：编辑区多组、标签排序、单标签显示成标题栏 | P1 | L |
| P2-2 | `dnd.ts`：pointer 拖拽、半透明副本、各放置区；以纯函数的放置区计算为核心，可以先对着接口独立开发 | P1（与 P2-1 并行，对接口） | L |
| P2-3 | 视图在主侧栏、副侧栏、底部面板之间移动（拖拽 + "移动到…"菜单）；各区显示和隐藏 | P2-1 | M |
| P2-4 | `serialize.ts`：版本、校验、迁移、重置；多个话题并排；话题工具跟随聚焦的话题 | P2-1 | M |
| P2-5 | 布局命令和快捷键（Ctrl+\ 分屏、Ctrl+1/2/3 聚焦组、移动编辑器、最大化、关闭）；平板规则 | P2-1、P2-3 | M |
| P2-6 | 拖拽、恢复、平板的 e2e 用例；文档；发版 | P2-1…5 | S |

### P3 窗口打磨（可并行，期末发版）

| 包 | 内容 | 量 |
|---|---|---|
| P3-1 | 命令面板：Ctrl+K 跳到话题、Ctrl+Shift+P 执行命令（基于选择弹层组件）；快捷键一览 | M |
| P3-2 | 对话：长对话性能（保留现有的增量绘制）、消息操作条、本轮改动一键并排打开 diff | M |
| P3-3 | 更改：每个文件一个 diff 标签、上一个/下一个改动、评论多段合并 | M |
| P3-4 | 文件：多文件标签、未保存标记、冲突提示条、在树里定位当前文件 | M |
| P3-5 | 终端：多个终端标签、改名、拖到右侧 | S |
| P3-6 | 设置、技能、任务：设置搜索、改过的项有标记；技能历史 diff；任务运行记录表 | M |
| P3-7 | 六种列表统一键盘操作和批量操作；历史在编辑器里显示带高亮的搜索结果 | S |

### P4 插件（发版）

| 包 | 内容 | 依赖 | 量 |
|---|---|---|---|
| P4-1 | 配置 schema、清单 schema、服务端加载器、目录检查（§6.3 第 3 条）、`/plugins/<id>/` 资源路由、boot-config、doctor | P1 | M |
| P4-2 | `PluginHost`：路由分发、话题读取和发送、事件、SSE 推送、存储 | P4-1 | M |
| P4-3 | 前端加载器（`import()`、错误隔离、样式）；`PluginContext` 对外；生成 `dist/webui-plugin.d.ts` | P4-1 | M |
| P4-4 | 示例插件；`docs/webui-plugins.md` 和 `docs/zh-CN/webui-plugins.md`；AGENTS.md 第 12 条；webui README | P4-2、P4-3 | S |
| P4-5 | 插件的 e2e 用例（加载、出错隔离、路由鉴权） | P4-4 | S |

### 并行波次（参考）

```
P0: [P0-1 ∥ P0-E ∥ P0-10] → [P0-2 ∥ P0-3 ∥ P0-4 ∥ P0-5 ∥ P0-6 ∥ P0-7 ∥ P0-8，按固定顺序合并] → P0-9 → 发版
P1: [P1-1 ∥ P1-2 ∥ P1-3 ∥ P1-4] → [P1-5 … P1-12 并行] → P1-13 → 发版
P2: [P2-1 ∥ P2-2] → [P2-3 ∥ P2-4] → P2-5 → P2-6 → 发版
P3: 全部并行 → 发版        P4: P4-1 → [P4-2 ∥ P4-3] → P4-4 → P4-5 → 发版
```

## 8. 并行开发规则（每个代理开工前读）

1. **先读**：`AGENTS.md`、`src/platform/webui/README.md` 里相关的章节、本文档中自己那个包和 §3–§6。
2. **只改独占文件。** 要改共享文件按下面的协议来；要改契约（`workbench/contracts.ts`、`plugins/api.ts`）就停下，向协调者提出。
3. **分支和工作树**：分支 `wb/<包号>-<短名>`，工作树 `.worktrees/wb-<包号>`。
4. **门禁**（本地，不跑全量测试）：`npm run typecheck`、`npm run lint`、`npx vitest run <相关测试>` 或 `npx vitest related <改动文件> --run`；动了界面的再跑 `npm run test:e2e` 的相关用例。
5. **交付**：提交信息不加 AI 署名；更新 webui README 的对应章节和 `platform.fras`；汇报内容为改了什么（file:line）、测试结果、没做的项。
6. **开发开关**：P1、P2 期内，新外壳只在 `localStorage['aa_workbench'] === '1'` 时挂载，不写进文档，由该期的切换包删除。P0 和 P3 不需要开关。
7. **合并和发版**：协调者按依赖顺序把分支 `--no-ff` 合进 `main`，合并前由另一个代理审查。包不单独发版，每期末由协调者发版（AGENTS.md 的 Shipping 一节，第 1、2 步）。
8. **共享文件协议**
   - `legacy-app.ts`（P0）：见 P0 那一节的冲突规则。
   - `i18n/en.ts`、`zh-CN.ts`：只追加自己前缀下的 key（如 `wb.dock.*`、`plugin.*`），不改别人的 key；`en.ts` 是类型来源，两个文件一起改。
   - 样式：P0-10 之后每个功能各有一份 css，只改自己那份；token 只由 P0-10 和 P1-4 改。
   - `package.json`：只有 P0-1（lit-html）和 P0-E（Playwright）能加依赖。
   - `CHANGELOG.md`：协调者在期末统一写。
9. **安全不变量不打折**：拿不准就停下来问。尤其是第 7 条（只向推送服务发 POST）、第 9 和第 10 条（文件和指令写入要做版本检查），以及 P4 的第 12 条。

## 9. 测试

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯逻辑 | vitest（node） | `splitview`、`gridview` 的计算，`serialize` 的迁移，`dnd` 的放置区，store，命令，快捷键解析 |
| DOM | vitest + jsdom（`page.dom.*`） | 行为：发送、缓存、话题、设置、面板。P0 保持全绿；P1-13 重写 layout 和 chrome 两组 |
| 真浏览器 | Playwright（`test/e2e/webui/`，`webui-e2e.yml`） | 默认布局、宽度断点、手机外壳、拖拽分屏、视图移动、布局恢复、插件加载 |

`webui-e2e.yml` 的设置：
- 触发：push 和 PR 改动了 `src/platform/webui/**`、`test/e2e/webui/**` 或这个 workflow；也可以手动触发。
- 步骤：`npm ci` → `npm run build:assets` → `npx playwright install --with-deps chromium` → 起一个隔离网关（临时 HOME、临时配置、假 ACP agent、随机端口）→ 跑用例 → 失败时上传截图和 trace。
- 不是发版门禁。本地也能跑；设置了 `PW_CDP_URL` 就改连远程浏览器。

## 10. 风险

| 风险 | 对策 |
|---|---|
| 并行拆 legacy-app 时冲突 | 按行段划分、固定合并顺序、装配代码集中在 `// WIRING` |
| 自研拖拽在触屏上有 bug | 全用 pointer 事件；平板和手机的 e2e；手机不启用拖拽 |
| 包体积变大 | 设预算：P2 结束时 app 的 gzip ≤ 160KB（现在 137KB），`build-webui-assets` 打印体积，超了就报 |
| lit-html 和现有增量绘制冲突 | 对话记录保留 `repaintKey` 那套增量逻辑，lit-html 只负责单条消息内部 |
| 插件带来安全面 | 默认关闭，只能由运维在 config.yaml 里装，同源加载，有目录检查，写进第 12 条不变量 |
| 期内 main 上同时有两套外壳 | 开发开关不对外；每期由切换包删掉旧代码 |
