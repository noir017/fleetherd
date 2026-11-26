# Web UI Plugins

English | [简体中文](zh-CN/webui-plugins.md)

The Web UI workbench is built on the same contribution model for both built-in features and external plugins. An operator can load local plugins from `config.yaml` to add sidebar views, editors, topic tools, status bar items, commands, menus, device-scoped settings sections, and custom server-side HTTP endpoints.

## Configuration

External plugins are disabled by default (`plugins: []`). Add plugin directories under `platforms.<id>.plugins` in `config.yaml`:

platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    plugins:
      - path: /opt/fleetherd-plugins/hello
        config:
          greeting: "Hello from fleetherd"

- `path`: Directory containing `fleetherd-plugin.json`. `~` is expanded.
- `config`: Optional arbitrary YAML/JSON value passed as-is to `host.config` on the server side.

## Manifest (`fleetherd-plugin.json`)

Every plugin directory must contain a `fleetherd-plugin.json` file at its root. It is strictly validated (unknown keys are rejected):

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

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique plugin identifier matching `^[a-z][a-z0-9-]{1,40}$`. Cannot collide with built-in plugin IDs (`topics`, `topic`, `history`, `schedules`, `reviews`, `skills`, `settings`, `changes`, `files`, `terminal`, `reader`, `status`). |
| `name` | Yes | Display name. |
| `version` | Yes | Version string (e.g. semver). |
| `engines.fleetherdWebui` | No | Target Web UI plugin API range. |
| `client` | No | Relative POSIX path to the browser ES module entrypoint. |
| `style` | No | Relative POSIX path to a CSS stylesheet injected into `<head>`. |
| `server` | No | Relative POSIX path to the Node.js ES module entrypoint. |
| `assets` | No | Relative POSIX glob patterns (`*`, `**`, `?`) for extra static files served under `GET /plugins/<id>/<file>`. |

All paths must stay inside the plugin directory (no leading `/`, no `..`, no backslashes, and no symlinks resolving outside the plugin directory). Only files declared by `client`, `style`, or matching `assets` are served over HTTP.

## Client API (`PluginContext`)

A client module is loaded in the browser via same-origin `import()` from `/plugins/<id>/<client>` after authentication. It may export:

- `export default { id, activate(ctx), deactivate?() }`
- `export const plugin = { id, activate(ctx), deactivate?() }`
- `export function activate(ctx) { ... }` (and optional `export function deactivate() { ... }`)

If a plugin fails to load, validate, register, or activate, the error is isolated: the built-in workbench keeps running and a non-intrusive warning indicator appears in the status bar.

Key capabilities on `ctx: PluginContext`:

- `ctx.subscriptions`: `DisposableStore` disposed automatically when the plugin deactivates. Contributions registered through `ctx.*` are tracked here automatically.
- `ctx.views.register({ id, title, icon?, part, component, when? })`: Register a view in `'sidebar'`, `'secondary'`, or `'panel'`.
- `ctx.editors.register({ kind, component, title })` / `ctx.editors.open(kind, input, opts?)`: Register and open custom editors in the center editor area.
- `ctx.topicTools.register({ id, title, icon, defaultPart, available, component })`: Register a topic-scoped tool that follows the focused topic.
- `ctx.activity.register({ id, title, icon, view, badge?, order? })`: Add an icon to the activity bar to reveal a view.
- `ctx.statusBar.register({ id, align, order?, render, onClick? })`: Add a left- or right-aligned status bar item.
- `ctx.commands.register(id, run, meta?)` / `ctx.commands.execute(id, ...args)`: Register and invoke workbench commands (optionally with `keybinding`).
- `ctx.menus.register(where, item)`: Append items to `'topic.row'`, `'topic.title'`, `'task.row'`, or `'message'` menus.
- `ctx.settings.registerSection({ id, title, scope: 'device', component })`: Add a device-local settings section (`scope` is enforced to `'device'` at runtime; plugins cannot write `config.yaml`).
- `ctx.events.on(key, cb)`: Subscribe to workbench events (`topic.active`, `topic.list`, `topic.message`, `topic.turnEnd`, `stream.state`, `locale.change`, `theme.change`) and server-pushed plugin SSE events (`plugin:<id>:<type>`).
- `ctx.topics`: Read `list()`, `active()`, `open(id)`, or `insertIntoComposer(id, text)`.
- `ctx.api.get(path)` / `ctx.api.post(path, body)`: Calls `/api/plugins/<id>/...` (GET and POST) or the public read-only API allowlist (GET only; opt-in sensitive endpoints such as `/api/files/*` and `/api/instructions/*` are blocked).
- `ctx.storage.get(key)` / `ctx.storage.set(key, value)`: `localStorage` scoped under `plugin:<id>`.
- `ctx.i18n.add(locale, dict)` / `ctx.i18n.t(key, vars?)`: Register translations and resolve localized strings.
- `ctx.html` / `ctx.render`: Bundled `lit-html` template tag and renderer.

## Server API (`PluginHost`)

A server module runs inside the fleetherd gateway process (Node.js ESM) and exports `activate(host)` (and optional `deactivate()`):

- `host.id`, `host.config`, `host.log(msg)`: Plugin identity, config from `config.yaml`, and prefixed logger (`[webui:plugin:<id>]`).
- `host.routes.get(path, handler)` / `host.routes.post(path, handler)`: Mount HTTP handlers under `/api/plugins/<id>/<path>`. Routes sit behind the Web UI session/SSO gate and same-origin POST check, and are matched last so plugins can never shadow built-in routes.
- `host.topics.list()` / `host.topics.get(id)` / `host.topics.send(id, text)`: Inspect topics or post a message into a topic. Messages sent via `host.topics.send` are always prefixed visibly with `[plugin:<id>]` in the conversation transcript.
- `host.events.on('topic' | 'message' | 'turn', cb)`: Subscribe to room events (returns a `Disposable`).
- `host.events.push(type, data)`: Broadcast a `plugin:<id>:<type>` event over the existing SSE stream to connected pages.
- `host.storage.read()` / `host.storage.write(value)`: Atomic JSON persistence in `<configDir>/plugins/<id>.json` (`0600`).

## TypeScript Types (`dist/webui-plugin.d.ts`)

`npm run build:assets` (and every release tarball) generates a self-contained declaration file at `dist/webui-plugin.d.ts` covering `PluginContext`, `PluginHost`, `WebuiPlugin`, `ServerPluginModule`, `PanelComponent`, and `PluginManifest`.

In TypeScript projects, include it in `tsconfig.json` or reference it directly:

/// <reference path="/path/to/fleetherd/dist/webui-plugin.d.ts" />

In plain `.mjs` plugins, use JSDoc `@param` / `@type` annotations pointing to `dist/webui-plugin.d.ts` for editor autocompletion without a build step (see `examples/webui-plugin-hello/`).

## Stability Contract

- **Stable (covered by semver / `engines.fleetherdWebui`)**: `PluginContext`, `PluginHost`, `--fh-*` CSS design tokens, and `fleetherd-plugin.json`.
- **Unstable (may change between minor releases)**: internal DOM structure, internal CSS class names, and internal client/server services.

Use `--fh-*` CSS variables (such as `--fh-bg`, `--fh-bg-side`, `--fh-bg-widget`, `--fh-line`, `--fh-fg`, `--fh-fg-hi`, `--fh-fg-dim`, `--fh-accent`, `--fh-ok`, `--fh-warn`, `--fh-err`) so your plugin adapts automatically to Dark Modern and Light Modern themes.

## Security Model

Web UI plugins follow [Security invariant #12](../AGENTS.md#security-invariants):

1. **No sandbox.** Server plugin code executes in-process with the gateway daemon's full privileges; client plugin code executes same-origin in the browser with the signed-in session. Install only code you trust.
2. **Config-only installation.** Plugins can only be configured in `config.yaml` (`platforms.<id>.plugins`). No HTTP route, reverse command, MCP tool, skill, or UI control can install, enable, or write plugins.
3. **Directory restrictions.** At load time, fleetherd rejects plugin directories located inside `files.roots` or inside any configured agent working directory (checked with both resolved paths and `realpath` to prevent symlink escapes).
4. **Visible attribution.** `host.topics.send` always prefixes messages with `[plugin:<id>]` in the visible transcript. Plugins cannot inject hidden instructions into an agent's prompt.
5. **`fleetherd doctor` audit.** Running `fleetherd doctor` lists every configured Web UI plugin, validates its manifest and directory rules, and warns that plugins run without a sandbox.

## Running the Example Plugin

The repository includes a complete example in `examples/webui-plugin-hello/`.

1. Copy `examples/webui-plugin-hello/` to a directory outside `files.roots` and outside any agent working directory:
   cp -r examples/webui-plugin-hello /opt/fleetherd-plugins/hello
2. Add it to `config.yaml`:
   platforms:
     web:
       type: webui
       token: ${WEB_TOKEN}
       plugins:
         - path: /opt/fleetherd-plugins/hello
           config:
             greeting: "Hello from fleetherd"
3. Run `fleetherd doctor` and confirm `hello@0.1.0 ✓` appears without errors.
4. Start or restart fleetherd, sign in to the Web UI, and open **Hello Plugin** from the left activity bar or click **Hello** on the bottom status bar to call `GET /api/plugins/hello/ping`.
