---
name: fleetherd-setup
description: >-
  End-to-end installation, configuration, verification, and startup guide for fleetherd.
  Use when a user asks a coding agent (Claude Code, Codex, OpenCode, etc.) to install,
  configure, deploy, or troubleshoot initial setup of fleetherd on a local machine or
  via Docker.
---

# fleetherd Setup & Deployment Guide

Follow this workflow to install, configure, verify, and start [fleetherd](https://github.com/noir017/fleetherd) for a user without getting stuck on interactive prompts.

## Ground rules

- **Never run `fleetherd setup`.** It is an interactive terminal wizard that blocks waiting for keyboard input. Write `config.yaml` and `.env` directly instead.
- **Never hardcode secrets in `config.yaml`.** Put every token/API key in `<configDir>/.env` (`chmod 600`) and reference it as `${VAR}` in `config.yaml`.
- **Never invent config keys.** `config.yaml` is strictly validated by zod; unknown keys fail load. For fields beyond the templates below, read `skill/references/config.md` inside the installed package (`$(npm root -g)/fleetherd/skill/references/config.md`) or on GitHub.
- **Always run `fleetherd doctor` before starting** and fix reported errors.

---

## Step 1: Environment preflight

Inspect the host first so you only ask the user what cannot be detected:

```bash
uname -a
node -v 2>/dev/null || echo "node: missing"
npm -v 2>/dev/null || echo "npm: missing"
docker --version 2>/dev/null || echo "docker: missing"
for cmd in claude codex opencode agy fleetherd; do
  printf '%-10s %s\n' "$cmd" "$(command -v "$cmd" 2>/dev/null || echo missing)"
done
```

Check these requirements:
- **Node.js ≥ 22** is required for native CLI installation. If missing or `< 22`, offer to install/switch Node 22+ (e.g. via `nvm`, `fnm`, or system package manager) or use Docker gateway-only deployment.
- **OS notes**:
  - **Linux / macOS**: Full native support (local agents, systemd/launchd, SSH remote hosts).
  - **WSL2 (Windows)**: Works like Linux; preferred over native Windows if using remote hosts or systemd services.
  - **Native Windows**: Supported for local agents, though POSIX background service steps differ (use Task Scheduler / NSSM or foreground startup) and WSL2 is recommended for smoother harness compatibility.
- **Existing harnesses**:
  - `claude`: reuses the machine's `claude /login` session — no API key required for personal use.
  - `codex` / `opencode` / `agy`: verify the CLI is installed and signed in (or has its provider API key configured).
  - If **no** coding agent CLI is installed locally, either install one first or deploy fleetherd in **Docker gateway-only mode** pointing at a remote Linux host that has agents installed.

---

## Step 2: Gather minimal user choices

Ask the user once, concisely, with concrete defaults:

1. **Deployment mode**:
   - **Local native (default)** — install CLI globally via npm tarball and run agents on this machine.
   - **Docker gateway-only** — run `ghcr.io/noir017/fleetherd:latest` in Docker; all agents run on one or more remote Linux hosts over SSH (`hosts:` + `pod.yaml`).
2. **Entry point**:
   - **Built-in Web UI (recommended for quickest start)** — zero bot registration; opens in any browser on port `8787`.
   - **Chat platform(s)** — Telegram, Discord, Slack, Lark/Feishu, QQ, LINE, WeCom, or DingTalk (can be combined with Web UI). Ask for the required credentials only for chosen platforms.
3. **Initial agent & working directory**:
   - Which detected harness to use as default (e.g. `claude`, `codex`, `opencode`, `agy`).
   - Default project directory (`cwd`, e.g. `~/projects`).
   - Preferred gateway UI/chat language: `en` (default) or `zh-CN`.
4. **Security posture**:
   - **Web UI exposure**: `127.0.0.1` (local / SSH tunnel / local reverse proxy) vs `0.0.0.0` (LAN / behind reverse proxy).
   - **Access allowlist (`access.allowFrom`)**: Always set `["web:owner"]` for Web UI. For chat platforms, ask for the user's platform user ID (format `<instance-id>:<userId>`), or explain how to obtain it on first message and lock it down immediately.
   - **Agent permission level (`permissions`)**: Unset / `auto` (full tool access, gated by `allowFrom`) vs `edits` (auto-accept file edits, ask for shell) vs `ask` (ask in chat before tools) vs `plan` (read-only).

---

## Step 3: Install fleetherd

### Option A: Native CLI (from latest GitHub Release)

fleetherd is **not** published to npm. Resolve the latest release tarball from GitHub and install it globally:

```bash
TAG=$(curl -fsSL https://api.github.com/repos/noir017/fleetherd/releases/latest \
  | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.tag_name)")
VER="${TAG#v}"
npm install -g "https://github.com/noir017/fleetherd/releases/download/${TAG}/fleetherd-${VER}.tgz"
fleetherd --version
```

If `npm install -g` hits a permission error on Linux, configure a user-local npm prefix (`~/.local`) or use `nvm`/`fnm` rather than `sudo npm`.

### Option B: Docker gateway-only (`ghcr.io/noir017/fleetherd`)

> The Docker image contains **only** the gateway (Node + SSH client + fleetherd) and **no** agent binaries. Every agent must run on a remote Linux host (`host:` in `config.yaml` or `~/.fleetherd/pod.yaml` on that host).

```bash
mkdir -p ~/apps/fleetherd/config
```

Create `~/apps/fleetherd/docker-compose.yml`:

```yaml
services:
  fleetherd:
    image: ghcr.io/noir017/fleetherd:latest
    container_name: fleetherd
    restart: unless-stopped
    stop_grace_period: 32m
    environment:
      - TZ=UTC
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - ./config:/home/fleetherd/.config/fleetherd
```

The container runs as **uid 1001** — ensure `./config` is writable by uid 1001, then generate the gateway's SSH key inside the container:

```bash
cd ~/apps/fleetherd
docker compose run --rm fleetherd sh -c \
  'mkdir -p -m 700 ~/.config/fleetherd/ssh && ssh-keygen -t ed25519 -N "" -f ~/.config/fleetherd/ssh/id_ed25519 -C fleetherd'
```

Next, pair each remote Linux host:
1. Copy `config/ssh/id_ed25519.pub` into `~/.ssh/authorized_keys` on the remote host.
2. Pin the remote host's SSH public key into `config/ssh/known_hosts` (e.g. `ssh-keyscan -p <port> <host> >> config/ssh/known_hosts`, verifying the fingerprint with the user).
3. Add the host under `hosts:` in `config/config.yaml`, and either define `agents[]` with `host: <name>` or declare agents in `~/.fleetherd/pod.yaml` on the remote host.

---

## Step 4: Write configuration (`config.yaml` + `.env`)

Config directory:
- Native: `~/.config/fleetherd/` (or `$FLEETHERD_CONFIG_DIR`)
- Docker: `~/apps/fleetherd/config/`

### 4.1 Create `.env` with secrets

Generate a strong Web UI login secret (never leave it weak or empty) and store all credentials in `.env`:

```bash
mkdir -p ~/.config/fleetherd
WEB_TOKEN=$(openssl rand -base64 24 | tr -d '\n')
cat > ~/.config/fleetherd/.env <<EOF
WEB_TOKEN=${WEB_TOKEN}
EOF
chmod 600 ~/.config/fleetherd/.env
```

Show the generated `WEB_TOKEN` to the user once so they can log in (or let them supply their own). Add any chat platform tokens (`TELEGRAM_TOKEN=...`, `DISCORD_TOKEN=...`, `SLACK_APP_TOKEN=...`, `SLACK_BOT_TOKEN=...`, `LARK_APP_ID=...`, `LARK_APP_SECRET=...`) to the same `.env` file.

### 4.2 Write `config.yaml`

Minimal local setup (Web UI + one local agent):

```yaml
version: 1
locale: en                  # en | zh-CN

platforms:
  web:
    type: webui
    token: ${WEB_TOKEN}
    host: 127.0.0.1         # use 0.0.0.0 in Docker or behind a LAN/reverse proxy
    port: 8787

agents:
  - id: claude
    harness: claude         # claude | codex | opencode | agy | custom
    cwd: ~/projects
    # permissions: edits    # optional: plan | ask | edits | auto | full

routing:
  default: claude

session:
  scope: per_thread

access:
  allowFrom:
    - "web:owner"
```

Common chat platform blocks (add under `platforms:` and add `<instance-id>:<userId>` to `access.allowFrom`):

```yaml
  telegram-main:
    type: telegram
    token: ${TELEGRAM_TOKEN}

  discord-main:
    type: discord
    token: ${DISCORD_TOKEN}

  slack-main:
    type: slack
    appToken: ${SLACK_APP_TOKEN}    # xapp-... (Socket Mode)
    botToken: ${SLACK_BOT_TOKEN}    # xoxb-...
    protocol: ws

  feishu-main:
    type: lark
    appId: ${LARK_APP_ID}
    appSecret: ${LARK_APP_SECRET}
    endpoint: feishu                # feishu (cn) | lark (global)
    protocol: ws
```

For QQ, LINE, WeCom, DingTalk, `routing.pipeline`, `hosts`, `voice`, `review`, `skills`, or `mcp`, consult `skill/references/config.md`.

---

## Step 5: Verify & start

### 5.1 Run self-check

```bash
# Native
fleetherd doctor

# Docker
cd ~/apps/fleetherd && docker compose run --rm fleetherd fleetherd doctor
```

Every check should pass (warnings about empty `allowFrom` should be resolved unless the user explicitly accepts an unrestricted local-only setup).

### 5.2 Start & smoke-test

- **Quick foreground test (native)**: start `fleetherd start` in a background test or ask the user to run it, confirm the Web UI responds (`curl -sI http://127.0.0.1:8787`), then stop the temporary test process before installing a background service.
- **Docker**:
  ```bash
  cd ~/apps/fleetherd && docker compose up -d
  docker logs --tail 50 fleetherd
  ```

### 5.3 Optional background service (native)

Ask the user before enabling a persistent service.

**Linux (systemd user unit)** — `~/.config/systemd/user/fleetherd.service`:

```ini
[Unit]
Description=fleetherd coding-agent gateway
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env fleetherd start
Restart=on-failure
RestartSec=5
TimeoutStopSec=1920

[Install]
WantedBy=default.target
```

Then enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now fleetherd
systemctl --user status fleetherd --no-pager
# Optional: keep running after logout
loginctl enable-linger "$USER"
```

*(If `fleetherd` lives under `nvm`/`fnm` or `~/.local/bin`, put the absolute path to `fleetherd` and include `Environment=PATH=...` in `[Service]` so systemd finds both `node` and agent CLIs.)*

**macOS (launchd user agent)** — `~/Library/LaunchAgents/com.fleetherd.daemon.plist`:

Use `ProgramArguments` pointing to the absolute `node` and `fleetherd` paths, `RunAtLoad` + `KeepAlive`, and `EnvironmentVariables.PATH` containing your Node and harness bin directories, then load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fleetherd.daemon.plist`.

---

## Step 6: Troubleshooting & next steps

### Common issues

| Symptom | Cause & fix |
|---|---|
| `npm install -g` fails or Node syntax error | Node is `< 22`. Upgrade to Node 22 LTS and retry. |
| `doctor` reports harness not logged in | Run the harness once interactively (e.g. `claude /login`) or provide its API key in `agents[].env` via `.env`. |
| `EADDRINUSE` on port `8787` (or `8080`) | Another service or platform instance already binds that port; change `port:` in `config.yaml`. |
| Docker agent fails with `native binary not found` | The gateway image contains no local agents. Add `host: <remote>` or move the agent to `pod.yaml` on a remote host. |
| Docker cannot read/write `./config` | Container runs as uid `1001`. Run `chown -R 1001:1001 ~/apps/fleetherd/config` (or rebuild with `--build-arg UID=...`). |
| Web UI unreachable from another device | `host` is `127.0.0.1` or firewall blocks `8787`. Prefer an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 <server>`) or HTTPS reverse proxy rather than exposing plain HTTP directly. |
| Live config edit didn't take effect | Send `/reload` in chat (or `kill -HUP <pid>`). Changes under `platforms:` require a full daemon restart. |

### Next steps to suggest to the user

- **Expose Web UI safely**: put HTTPS + SSO (Cloudflare Access or Teleport) in front — see `docs/web-ui.md#exposing-it`.
- **Add remote Linux hosts**: connect other machines over pinned SSH and declare agents in `~/.fleetherd/pod.yaml` — see `docs/remote-hosts.md`.
- **Enable voice dictation**: configure OpenAI-compatible STT (e.g. Groq Whisper) + cleanup LLM or Gemini — see `docs/voice.md`.
- **Shared skills & standing instructions**: sync skills across machines (`docs/skills.md`) and write global rules in `common.md` (`docs/instructions.md`).
- **External MCP entrance**: connect external web agents to fleetherd with bearer auth — see `docs/external-mcp.md`.
