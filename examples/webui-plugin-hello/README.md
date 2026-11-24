# Hello Web UI Plugin Example

A minimal external plugin for the fleetherd Web UI workbench demonstrating:

- A sidebar view (`hello.view`) with an activity bar icon (`hello.activity`)
- A clickable status bar item (`hello.status`)
- A server-side route (`GET /api/plugins/hello/ping`) with persisted plugin storage and SSE broadcast (`plugin:hello:ping`)
- Styling with `--fh-*` semantic design tokens

## Files

- `fleetherd-plugin.json` — Plugin manifest
- `client.mjs` — Browser module (`PluginContext`)
- `style.css` — Theme-aware styles using `--fh-*` tokens
- `server.mjs` — Server module (`PluginHost`)

## Usage

Copy this directory outside any agent working directory and outside `files.roots` (for example `/opt/fleetherd-plugins/hello`), then add it to `config.yaml`:

platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    plugins:
      - path: /opt/fleetherd-plugins/hello
        config:
          greeting: "Hello from fleetherd"

Verify configuration with `fleetherd doctor`, restart the gateway, sign in to the Web UI, and open **Hello Plugin** from the activity bar or click **Hello** in the status bar.

See [Web UI Plugins](../../docs/webui-plugins.md) ([简体中文](../../docs/zh-CN/webui-plugins.md)) for the full API and security model.
