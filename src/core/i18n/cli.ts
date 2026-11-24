import { createTranslator, type DictOf, type DomainTranslator, type MessageParams } from './index.js';

export { type MessageParams };

export const en = {
  // Top-level CLI (program.ts)
  'cli.description': 'Gateway that connects IM platforms to coding agents: messaging via Koishi, handled over ACP',
  'cli.option.config': 'path to the config YAML to use (default: ~/.config/fleetherd/config.yaml); goes before the command',

  // Start (start.ts)
  'start.daemonRunning': '🚀 fleetherd daemon is running (socket: {socket})',
  'start.podsLoadFallback': '[pods] the config did not load; reading the hosts\' pods in case it names their agents',
  'start.renamesApplied': '[renames] {renames}: {conversations} conversation(s), {tasks} scheduled task(s); backups *.bak-renames-{stamp}',
  'start.migrateLegacySessions': '[migrate] carried {count} conversation(s) over from sessions.json — their agents resume where they left off',
  'start.historyImported': '[history] imported {count} web UI conversation(s), {messages} message(s)',
  'start.historyImportFailed': '[history] {count} web UI transcript(s) could not be imported',

  // Setup wizard (setup.ts)
  'setup.prompt.locale': 'Language / 语言:',
  'setup.foundV0': 'Found a v0 config; it will be upgraded to the v1 `platforms:` format on save.',
  'setup.existingConfig': 'Found an existing config at {path}. The wizard only updates the chosen platform/agents/routing/scope/allowFrom; any other hand-edited settings are preserved. Continue?',
  'setup.cancelled': 'Cancelled.',

  'setup.platformNote.slack': 'Note: defaults to ws (Socket Mode). To use protocol=http (Events API), edit the yaml and also set signing.',
  'setup.platformNote.lark': 'Note: edit the yaml to change endpoint (feishu/lark) or protocol (ws/http) if needed.',
  'setup.platformNote.qq': 'Note: edit the yaml to set sandbox/intents/protocol if needed.',
  'setup.platformNote.line': 'Note: edit the yaml to set host/port if needed.',
  'setup.platformNote.dingtalk': 'Note: defaults to ws (Stream mode, no public URL). Edit the yaml for protocol=http (webhook at <public host>/dingtalk) with host/port.',
  'setup.platformNote.webui': 'Note: the page is served at http://<host>:8787 — edit the yaml for host/port/title. It binds every interface and speaks plain HTTP, so the token you just set is the only thing protecting it; put TLS in front of it before exposing it beyond a network you trust, or set host: 127.0.0.1 and reach it over an SSH tunnel. Its identity for access.allowFrom is "<this instance id>:owner", and the "channels to listen on" question below is answered by "main" or left empty.',

  'setup.platformName.discord': 'Discord',
  'setup.platformName.telegram': 'Telegram',
  'setup.platformName.qq': 'QQ (qqguild channels)',
  'setup.platformName.lark': 'Lark / Feishu',
  'setup.platformName.slack': 'Slack',
  'setup.platformName.line': 'LINE',
  'setup.platformName.wecom': 'WeCom (WeChat Work)',
  'setup.platformName.dingtalk': 'DingTalk (钉钉)',
  'setup.platformName.webui': 'Web UI (a browser page this daemon serves)',

  'setup.prompt.imPlatform': 'IM platform:',
  'setup.prompt.fieldRequired': 'This field cannot be empty.',
  'setup.prompt.channels': 'Channel IDs to listen on (comma-separated; empty = all):',
  'setup.prompt.scope': 'Session scope (granularity of an agent session):',
  'setup.scope.perChannel': 'One session per channel (recommended)',
  'setup.scope.perUser': 'One session per user',
  'setup.scope.perThread': 'One session per thread',
  'setup.scope.shared': 'Single shared session',

  'setup.prompt.harness': 'Agent harness (the coding agent to drive):',
  'setup.harness.claude': 'Claude (via claude-agent-acp)',
  'setup.harness.gemini': 'Gemini CLI (native ACP)',
  'setup.harness.codex': 'Codex',
  'setup.harness.agy': 'Antigravity CLI (agy)',
  'setup.harness.custom': 'Custom (provide your own command)',

  'setup.prompt.customCommand': 'Executable command to launch the ACP agent:',
  'setup.prompt.customCommandRequired': 'A command is required for the custom harness.',
  'setup.prompt.model': 'Model (leave empty to use the harness default):',
  'setup.prompt.allowFrom': 'Allowlist of identities allowed to trigger the bot (comma-separated, format platform:userId, e.g. discord:123456789). Strongly recommended; empty = anyone who can message the bot can trigger it:',
  'setup.warn.noAllowlist': '⚠️  No allowlist set: anyone who can message the bot will be able to drive an agent with full tool access.',

  'setup.success.wrote': '✅ Wrote {path}',
  'setup.success.advanced': 'Multi-agent setups, routing pipelines, multi-instance platforms, and ${VAR} secrets are advanced features — edit the yaml directly (see the README).',
  'setup.success.next': 'Next: run `fleetherd doctor` to self-check, then `fleetherd start` to launch the daemon.',

  // Doctor (doctor.ts)
  'doctor.description': 'Gateway connecting IM platforms to coding agents; this is its self-check.',
  'doctor.migrate.cannotRead': 'cannot read {path} (missing or unparseable); nothing to migrate',
  'doctor.migrate.alreadyV1': '{path} is already in the v1 format (platforms: map); nothing to do',
  'doctor.migrate.validationFailed': 'migrated config does not validate; file left untouched:\n{lines}',
  'doctor.migrate.success': 'migrated {path} to the v1 format (backup at {backup}; YAML comments were not preserved)',

  'doctor.check.configValid': 'Config file exists and is valid',
  'doctor.detail.unknownError': 'unknown error',

  'doctor.check.platformInstances': 'Platform instances',
  'doctor.detail.configUnavailableInstances': 'config unavailable, cannot resolve platform instances',

  'doctor.check.platformCredentials': 'Platform credentials usable',
  'doctor.detail.configUnavailableCredentials': 'config unavailable, cannot read credentials',
  'doctor.detail.webuiLocalToken': 'the login token is local — nothing to validate online',
  'doctor.detail.unsupportedOnlineValidation': '{id} ({type}): credentials schema-validated; online validation not implemented — if start fails to connect, re-check them',
  'doctor.detail.ok': 'ok',
  'doctor.detail.failed': 'failed',

  'doctor.check.platformConnectivity': 'Platform adapter connectivity (placeholder)',
  'doctor.detail.connectivitySkipped': '{types} skipped (no online connectivity placeholder)',
  'doctor.detail.connectivityPlaceholderOk': 'placeholder: no gateway was actually established; the token check already covers most connectivity',
  'doctor.detail.connectivityPlaceholderFail': 'placeholder: no gateway was actually established; the token check failed, so the adapter most likely cannot connect',

  'doctor.check.accessControl': 'Security: access control',
  'doctor.detail.configUnavailableAccess': 'config unavailable, cannot check access control',
  'doctor.detail.accessRestricted': 'access.allowFrom restricts triggering to {count} identity(ies)',
  'doctor.detail.accessUnrestricted': 'access.allowFrom is empty: ANYONE who can message the bot can trigger an agent with full tool access (Bash / file writes). Set access.allowFrom to lock this down for production.',

  'doctor.check.webui': 'Web UI',
  'doctor.detail.configUnavailableWebui': 'config unavailable, cannot check the web UI',
  'doctor.detail.webuiSkipped': 'no webui instance configured; skipped',
  'doctor.detail.webuiPortInUse': '{id}: {host}:{port} is already in use — that is this web UI if the daemon is running, and a conflict if it is not',
  'doctor.detail.webuiPortFree': '{id}: {host}:{port} is free',
  'doctor.detail.webuiAllowFromMissing': '{id}: access.allowFrom does not list "{identity}", so every message typed into this page will be ignored',
  'doctor.detail.webuiPlainHttp': '{id}: bound to {host} over plain HTTP — the login token is the only thing between the network and an agent with full tool access; put TLS in front of it',
  'doctor.detail.webuiSsoKeys': '{id}: sso reads {header} from {from}, verified against {count} key(s) at {url}',
  'doctor.detail.webuiSsoError': '{id}: sso cannot read {url} ({error}) — nobody gets in this way until that URL answers',
  'doctor.detail.webuiSsoPassword': '{id}: the shared token is still a second way in; set sso.password: false once sso works',
  'doctor.detail.webuiPlugins': '{id}: plugins ({count}) — {list}. Security: plugins run in the gateway process with full permissions and in the signed-in browser session with no sandbox',

  'doctor.check.acpSdk': 'ACP SDK installed',
  'doctor.detail.acpSdkOk': '{sdk} loads successfully',
  'doctor.detail.acpSdkMissing': '{sdk} is not installed — run npm i first',

  'doctor.check.agentHarness': 'Agent harness commands reachable',
  'doctor.detail.configUnavailableAgents': 'config unavailable, cannot check agents',
  'doctor.detail.agentConnect': '{id} (connect) → {url}, dialled when a session starts',
  'doctor.detail.claudeMissing': ' (dependency missing — run npm install)',
  'doctor.detail.codexMissing': ' (install it with `npm i -g @agentclientprotocol/codex-acp`)',
  'doctor.detail.agentNotFound': ' ✗ not found',
  'doctor.detail.harnessNotOnPath': 'some harness commands are not on PATH: {lines}',

  'doctor.check.remoteHosts': 'Remote hosts reachable',
  'doctor.detail.configUnavailableHosts': 'config unavailable, cannot check hosts',
  'doctor.detail.noRemoteHosts': 'none configured (every agent runs here)',

  'doctor.check.skillsRepo': 'Skills repository',
  'doctor.detail.gitNotInstalled': 'git is not installed — the managed skills are neither delivered nor writable',
  'doctor.detail.skillsLocal': 'git found; no skills.repo, so the skills stay in a local repository',
  'doctor.detail.skillsNoKey': 'no key at {path}',
  'doctor.detail.skillsNoKnownHosts': 'no known_hosts at {path} — add the repository host\'s key (checked by hand) first',
  'doctor.detail.skillsAnswers': '{url} answers (branch {branch})',

  'doctor.check.claudeTranscripts': 'claude transcripts readable for the cache countdown',
  'doctor.detail.noClaudeAgent': 'no claude agent configured',
  'doctor.detail.remoteClaude': '{id} on {host}: read there, not checked here',
  'doctor.detail.claudeDirMissing': '{dir} missing (created by Claude Code on its first session)',

  'doctor.check.ipcSocket': 'IPC socket path usable',
  'doctor.detail.configUnavailableSocket': 'config unavailable, cannot resolve socket path',
  'doctor.detail.socketAlive': '{path} (a daemon is listening)',
  'doctor.detail.socketStale': '{path} exists but nothing is listening (stale file; the daemon cleans it up on start)',

  'doctor.detail.hostNoPrivateKey': 'no private key at {path}',
  'doctor.detail.hostNoKnownHosts': 'no known_hosts at {path} — add the host\'s key (ssh-keyscan, checked by hand) before the daemon can connect',
  'doctor.detail.hostSshFailed': 'ssh failed (exit {status}): {error}',
  'doctor.detail.hostConnected': 'connected ({system})',
  'doctor.detail.hostArchUnsupported': '✗ fleetherd-remote runs on Linux x86_64/arm64 only',
  'doctor.detail.hostMissingCommands': '✗ not found there: {missing}',
  'doctor.detail.hostUncheckedCommands': 'not checked: {unchecked}',

  'doctor.auth.agyGateway': ' [agy through a model gateway: AGY_LLM_GATEWAY_URL]',
  'doctor.auth.agyKeyring': ' [agy Google sign-in from the OS keyring; run `agy` once interactively if never signed in]',
  'doctor.auth.apiKey': ' [API key]',
  'doctor.auth.claudeLogin': ' [claude /login subscription session]',

  'doctor.discord.botUsername': 'bot username: {name}',
  'doctor.discord.invalidToken': 'invalid token (401 Unauthorized)',
  'doctor.discord.unexpectedStatus': 'Discord returned an unexpected status {status}',
  'doctor.discord.networkError': 'could not reach Discord to validate the token: {error}',
} as const;

export type CliMessageKey = keyof typeof en;

export const zhCN: DictOf<typeof en> = {
  // Top-level CLI (program.ts)
  'cli.description': '连接 IM 聊天平台与 Coding Agent 的网关：通过 Koishi 传递消息，走 ACP 协议与 Agent 交互',
  'cli.option.config': '指定使用的 YAML 配置文件路径（默认：~/.config/fleetherd/config.yaml）；需放在子命令之前',

  // Start (start.ts)
  'start.daemonRunning': '🚀 fleetherd 守护进程已启动 (socket: {socket})',
  'start.podsLoadFallback': '[pods] 配置文件未成功加载；正在读取远程主机 pods 以解析其声明的 Agent',
  'start.renamesApplied': '[renames] {renames}：{conversations} 个会话，{tasks} 个计划任务；备份为 *.bak-renames-{stamp}',
  'start.migrateLegacySessions': '[migrate] 已从 sessions.json 迁移 {count} 个会话 — 对应 Agent 将从中断处继续',
  'start.historyImported': '[history] 已导入 {count} 个 Web UI 会话，共 {messages} 条消息',
  'start.historyImportFailed': '[history] {count} 个 Web UI 会话记录无法导入',

  // Setup wizard (setup.ts)
  'setup.prompt.locale': '语言 / Language:',
  'setup.foundV0': '发现 v0 格式配置；保存时将升级为 v1 的 `platforms:` 格式。',
  'setup.existingConfig': '在 {path} 发现已有配置。向导仅更新所选平台/agents/routing/scope/allowFrom；其他手动修改的设置将保留。是否继续？',
  'setup.cancelled': '已取消。',

  'setup.platformNote.slack': '提示：默认使用 ws (Socket Mode)。若要使用 protocol=http (Events API)，请编辑 yaml 并配置 signing。',
  'setup.platformNote.lark': '提示：如需修改 endpoint (feishu/lark) 或 protocol (ws/http)，请编辑 yaml。',
  'setup.platformNote.qq': '提示：如需配置 sandbox/intents/protocol，请编辑 yaml。',
  'setup.platformNote.line': '提示：如需配置 host/port，请编辑 yaml。',
  'setup.platformNote.dingtalk': '提示：默认使用 ws (Stream mode，无需公网 URL)。若使用 protocol=http (webhook 位于 <public host>/dingtalk)，请编辑 yaml 配置 host/port。',
  'setup.platformNote.webui': '提示：页面运行于 http://<host>:8787 — 可编辑 yaml 调整 host/port/title。它监听所有接口且走明文 HTTP，因此刚才设置的 token 是唯一的安全保护；暴露到不受信任的网络前请务必配置 TLS，或设置 host: 127.0.0.1 通过 SSH 隧道访问。它在 access.allowFrom 中的身份为 "<this instance id>:owner"，下方的“监听频道”可填 "main" 或留空。',

  'setup.platformName.discord': 'Discord',
  'setup.platformName.telegram': 'Telegram',
  'setup.platformName.qq': 'QQ (QQ 频道)',
  'setup.platformName.lark': '飞书 / Lark',
  'setup.platformName.slack': 'Slack',
  'setup.platformName.line': 'LINE',
  'setup.platformName.wecom': '企业微信 (WeCom)',
  'setup.platformName.dingtalk': '钉钉 (DingTalk)',
  'setup.platformName.webui': 'Web UI (本网关内置网页)',

  'setup.prompt.imPlatform': 'IM 聊天平台：',
  'setup.prompt.fieldRequired': '此字段不能为空。',
  'setup.prompt.channels': '要监听的频道 ID（逗号分隔；留空表示全部）：',
  'setup.prompt.scope': '会话隔离粒度（Session scope）：',
  'setup.scope.perChannel': '每个频道一个会话（推荐）',
  'setup.scope.perUser': '每个用户一个会话',
  'setup.scope.perThread': '每个话题一个会话',
  'setup.scope.shared': '所有交互共享单个会话',

  'setup.prompt.harness': 'Agent 驱动引擎（harness）：',
  'setup.harness.claude': 'Claude (通过 claude-agent-acp)',
  'setup.harness.gemini': 'Gemini CLI (原生 ACP)',
  'setup.harness.codex': 'Codex',
  'setup.harness.agy': 'Antigravity CLI (agy)',
  'setup.harness.custom': '自定义（提供启动命令）',

  'setup.prompt.customCommand': '启动 ACP agent 的可执行命令：',
  'setup.prompt.customCommandRequired': '自定义 harness 必须提供启动命令。',
  'setup.prompt.model': '模型（留空使用 harness 默认模型）：',
  'setup.prompt.allowFrom': '允许触发 Bot 的身份白名单（逗号分隔，格式为 platform:userId，例如 discord:123456789）。强烈推荐配置；留空表示任何能向 Bot 发消息的人都能触发：',
  'setup.warn.noAllowlist': '⚠️  未设置白名单：任何能向 Bot 发消息的人都将能驱动具备完整工具权限的 agent。',

  'setup.success.wrote': '✅ 已写入 {path}',
  'setup.success.advanced': '多 Agent 配置、路由管线、多平台实例及 ${VAR} 敏感变量为进阶功能 — 请直接编辑 yaml（详见 README）。',
  'setup.success.next': '下一步：运行 `fleetherd doctor` 进行自检，然后运行 `fleetherd start` 启动网关守护进程。',

  // Doctor (doctor.ts)
  'doctor.description': '连接 IM 聊天平台与 Coding Agent 的网关；此命令用于环境自检。',
  'doctor.migrate.cannotRead': '无法读取 {path}（文件缺失或不可解析）；无需迁移',
  'doctor.migrate.alreadyV1': '{path} 已是 v1 格式（platforms: map）；无需操作',
  'doctor.migrate.validationFailed': '迁移后的配置校验未通过；未修改原文件：\n{lines}',
  'doctor.migrate.success': '已将 {path} 迁移至 v1 格式（备份位于 {backup}；未保留 YAML 注释）',

  'doctor.check.configValid': '配置文件存在且有效',
  'doctor.detail.unknownError': '未知错误',

  'doctor.check.platformInstances': '平台实例',
  'doctor.detail.configUnavailableInstances': '配置不可用，无法解析平台实例',

  'doctor.check.platformCredentials': '平台凭据可用性',
  'doctor.detail.configUnavailableCredentials': '配置不可用，无法读取凭据',
  'doctor.detail.webuiLocalToken': '登录 token 为本地凭据 — 无需在线验证',
  'doctor.detail.unsupportedOnlineValidation': '{id} ({type})：凭据已通过 Schema 校验；未实现在线验证 — 若启动连接失败，请重新检查凭据',
  'doctor.detail.ok': '正常',
  'doctor.detail.failed': '失败',

  'doctor.check.platformConnectivity': '平台适配器连通性（占位检查）',
  'doctor.detail.connectivitySkipped': '{types} 已跳过（无在线连通性占位检查）',
  'doctor.detail.connectivityPlaceholderOk': '占位检查：未真正建立网关连接；Token 校验已涵盖主要连通性',
  'doctor.detail.connectivityPlaceholderFail': '占位检查：未真正建立网关连接；Token 校验失败，适配器极可能无法连接',

  'doctor.check.accessControl': '安全：访问控制',
  'doctor.detail.configUnavailableAccess': '配置不可用，无法检查访问控制',
  'doctor.detail.accessRestricted': 'access.allowFrom 已限制仅允许 {count} 个身份触发',
  'doctor.detail.accessUnrestricted': 'access.allowFrom 为空：任何能向 Bot 发消息的人都将能触发具备完整工具权限（Bash / 文件写入）的 agent。生产环境请设置 access.allowFrom 进行权限收敛。',

  'doctor.check.webui': 'Web UI',
  'doctor.detail.configUnavailableWebui': '配置不可用，无法检查 Web UI',
  'doctor.detail.webuiSkipped': '未配置 Web UI 实例；已跳过',
  'doctor.detail.webuiPortInUse': '{id}：{host}:{port} 已被占用 — 若守护进程正在运行则为本 Web UI，否则存在端口冲突',
  'doctor.detail.webuiPortFree': '{id}：{host}:{port} 空闲',
  'doctor.detail.webuiAllowFromMissing': '{id}：access.allowFrom 未包含 "{identity}"，在此页面发送的所有消息都将被忽略',
  'doctor.detail.webuiPlainHttp': '{id}：通过明文 HTTP 绑定到 {host} — 登录 Token 是网络与具备完整工具权限 Agent 之间的唯一防线；请在前面配置 TLS',
  'doctor.detail.webuiSsoKeys': '{id}：SSO 从 {from} 读取 {header}，通过 {url} 的 {count} 个密钥进行验证',
  'doctor.detail.webuiSsoError': '{id}：SSO 无法读取 {url}（{error}）— 在该 URL 正常响应前，任何人都无法通过此方式登录',
  'doctor.detail.webuiSsoPassword': '{id}：共享 Token 仍作为备用登录入口；SSO 验证正常后建议设置 sso.password: false',
  'doctor.detail.webuiPlugins': '{id}：插件（{count} 个）— {list}。安全提示：插件与网关同进程、同登录会话权限运行，无沙箱隔离',

  'doctor.check.acpSdk': 'ACP SDK 安装状态',
  'doctor.detail.acpSdkOk': '{sdk} 加载成功',
  'doctor.detail.acpSdkMissing': '{sdk} 未安装 — 请先运行 npm i',

  'doctor.check.agentHarness': 'Agent harness 命令可达性',
  'doctor.detail.configUnavailableAgents': '配置不可用，无法检查 Agent',
  'doctor.detail.agentConnect': '{id} (connect) → {url}，将在会话开始时建立连接',
  'doctor.detail.claudeMissing': '（依赖缺失 — 请运行 npm install）',
  'doctor.detail.codexMissing': '（请通过 `npm i -g @agentclientprotocol/codex-acp` 安装）',
  'doctor.detail.agentNotFound': ' ✗ 未找到',
  'doctor.detail.harnessNotOnPath': '部分 harness 命令不在 PATH 中：{lines}',

  'doctor.check.remoteHosts': '远程主机可达性',
  'doctor.detail.configUnavailableHosts': '配置不可用，无法检查主机',
  'doctor.detail.noRemoteHosts': '未配置远程主机（所有 Agent 均运行在本机）',

  'doctor.check.skillsRepo': 'Skills 仓库',
  'doctor.detail.gitNotInstalled': '未安装 git — 托管技能无法分发亦不可写入',
  'doctor.detail.skillsLocal': '已找到 git；未配置 skills.repo，技能保存在本地仓库',
  'doctor.detail.skillsNoKey': '{path} 处未找到私钥',
  'doctor.detail.skillsNoKnownHosts': '{path} 处未找到 known_hosts — 请先添加仓库主机的公钥（人工核对）',
  'doctor.detail.skillsAnswers': '{url} 响应正常（分支 {branch}）',

  'doctor.check.claudeTranscripts': '用于缓存倒计时的 Claude 会话记录可读性',
  'doctor.detail.noClaudeAgent': '未配置 Claude Agent',
  'doctor.detail.remoteClaude': '{host} 上的 {id}：在远程读取，本机不检查',
  'doctor.detail.claudeDirMissing': '{dir} 不存在（Claude Code 会在首次会话时自动创建）',

  'doctor.check.ipcSocket': 'IPC Socket 路径可用性',
  'doctor.detail.configUnavailableSocket': '配置不可用，无法解析 Socket 路径',
  'doctor.detail.socketAlive': '{path}（守护进程正在监听）',
  'doctor.detail.socketStale': '{path} 存在但无进程监听（残留文件；守护进程启动时会自动清理）',

  'doctor.detail.hostNoPrivateKey': '{path} 处未找到私钥',
  'doctor.detail.hostNoKnownHosts': '{path} 处未找到 known_hosts — 连接前请先添加主机公钥（ssh-keyscan，人工核对）',
  'doctor.detail.hostSshFailed': 'SSH 连接失败 (退出码 {status}): {error}',
  'doctor.detail.hostConnected': '已连接 ({system})',
  'doctor.detail.hostArchUnsupported': '✗ fleetherd-remote 仅支持 Linux x86_64/arm64',
  'doctor.detail.hostMissingCommands': '✗ 远程未找到：{missing}',
  'doctor.detail.hostUncheckedCommands': '未检查：{unchecked}',

  'doctor.auth.agyGateway': ' [agy 通过模型网关访问：AGY_LLM_GATEWAY_URL]',
  'doctor.auth.agyKeyring': ' [agy 使用系统密钥环中的 Google 登录凭据；若从未登录请先交互式运行一次 `agy`]',
  'doctor.auth.apiKey': ' [API 密钥]',
  'doctor.auth.claudeLogin': ' [claude /login 订阅会话]',

  'doctor.discord.botUsername': 'Bot 用户名：{name}',
  'doctor.discord.invalidToken': '无效 Token (401 Unauthorized)',
  'doctor.discord.unexpectedStatus': 'Discord 返回了非预期状态码 {status}',
  'doctor.discord.networkError': '无法连接 Discord 以验证 Token：{error}',
};

export const tCli: DomainTranslator<CliMessageKey> = createTranslator({
  en,
  'zh-CN': zhCN,
});
