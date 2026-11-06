# Platforms

English | [简体中文](zh-CN/platforms.md)

| | Discord | Telegram | Slack | Lark | QQ | LINE | WeCom | DingTalk | Web UI |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Streaming in-place edit | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| Lifecycle reactions | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ |
| Typing indicator | ✓ | ✓ | – | – | – | ✓ | – | – | ✓ |
| Native reply | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Threads / auto-thread | ✓ | ✓ | ✓ | ✓ | – | – | – | – | ✓ |
| Buttons (`ask`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | ✓ |
| Slash commands | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ |

Markdown is rendered per platform; missing capabilities degrade gracefully (no
editing → chunked sends, no buttons → plain-text question). Slack, Lark, and
DingTalk connect over WebSocket by default — no public callback URL needed.

Every platform is an entry under `platforms:` in config.yaml, and the same type may appear
more than once for several accounts — see [Configuration](configuration.md). The web UI is
not a chat service but a page the daemon serves itself; it has [its own page](web-ui.md).

## When a platform does not connect

The daemon's `platform instance "…" started` line means the platform was asked to connect, not
that it did. An instance with no bot online a minute after start logs a warning naming it — `is
not online 60s after start` — and logs `is online now` if it connects later. Every change of
connection state is logged as well: online, offline, reconnecting.

Telegram retries its startup by itself. A 5xx, a 429, a refused connection or a timeout logs one
line per attempt — the instance, the error, and when it tries again — and retries after 5 s,
doubling up to once a minute, until it connects. A 401 or 404 means the token is wrong: that is
logged as an error once, the instance stays offline, and it needs a corrected token and a restart.
Other platforms keep their own adapter's reconnect behaviour; LINE and WeCom have none at startup,
so a failed login there stays offline until the next restart, and the one-minute warning is what
says so.
