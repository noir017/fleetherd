import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveSocketPath, configPath, readRawConfigIfExists, saveConfig } from '../config/load.js';
import { ConfigSchema, accessUnrestricted, platformInstances, type Config, type HostDef } from '../config/schema.js';
import { isNamedPipe } from '../ipc/server.js';
import { spawnSync } from 'node:child_process';
import { sshArgs } from '../remote/binaries.js';
import { defaultIdentityFile, defaultKnownHostsFile } from '../daemon/ssh-identity.js';
import { gitAsync, gitAvailable } from '../daemon/skills-git.js';
import { gitSshCommand, redactRepoUrl, skillsRemoteOf } from '../daemon/skills-repo.js';
import { isLegacyConfig, migrateLegacyConfig } from '../config/migrate.js';
import { resolveClaudeAdapterEntry } from '../daemon/agent-acp.js';
import { AGY_COMMAND } from '../daemon/agy-cli.js';
import { claudeProjectsDir } from '../daemon/claude-transcript.js';
import { remoteAgentEnv } from '../daemon/agent-common.js';
import { hostProbeScript, readHostProbe, type HostProbe } from '../daemon/host-probe.js';
import { OWNER } from '../platform/webui/room.js';
import { loadJwks } from '../platform/webui/sso.js';
import { loadSinglePlugin } from '../platform/webui/plugins/loader.js';
import { detectEnvLocale, type Locale } from '../core/i18n/index.js';
import { tCli } from '../core/i18n/cli.js';

/** Whether a host:port can be bound right now. Binds and releases; never leaves it held. */
async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * Locate an executable: if it contains a path separator, check the file directly;
 * otherwise scan PATH. Returns the path, or null if not found.
 */
export function locateCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const isWin = platform === 'win32';
  const mode = isWin ? fs.constants.F_OK : fs.constants.X_OK;
  const exts = isWin ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const check = (base: string): string | null => {
    for (const ext of exts) {
      const candidate = ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? `${base}${ext}` : base;
      try {
        fs.accessSync(candidate, mode);
        return candidate;
      } catch {
        /* not found with this extension */
      }
    }
    return null;
  };
  if (cmd.includes('/') || cmd.includes('\\')) return check(cmd);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = (pathKey ? env[pathKey] ?? '' : '').split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const found = check(path.join(dir, cmd));
    if (found) return found;
  }
  return null;
}

/** One `hosts:` entry, checked the way the daemon will use it (see the check's own comment). */
async function checkRemoteHost(
  def: HostDef,
  probes: HostProbe[],
  locale: Locale
): Promise<{ ok: boolean; detail: string }> {
  const key = expandLocal(def.identityFile ?? defaultIdentityFile());
  const known = expandLocal(def.knownHostsFile ?? defaultKnownHostsFile());
  if (!fs.existsSync(key)) return { ok: false, detail: tCli(locale, 'doctor.detail.hostNoPrivateKey', { path: key }) };
  if (!fs.existsSync(known)) {
    return {
      ok: false,
      detail: tCli(locale, 'doctor.detail.hostNoKnownHosts', { path: known }),
    };
  }
  const script = `uname -sm; exec "\${SHELL:-/bin/sh}" -ilc "${hostProbeScript(probes)}" </dev/null 2>/dev/null`;
  const r = spawnSync('ssh', sshArgs({ destination: def.ssh, identityFile: key, knownHostsFile: known }, script), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.status !== 0 && !r.stdout.includes('TCR-')) {
    const errLine = r.stderr.trim().split('\n').slice(-1)[0] ?? '';
    return { ok: false, detail: tCli(locale, 'doctor.detail.hostSshFailed', { status: r.status ?? -1, error: errLine }) };
  }
  const system = r.stdout.split('\n')[0]?.trim() ?? '';
  const { missing, unchecked } = readHostProbe(probes, r.stdout);
  const supported = /^Linux (x86_64|amd64|aarch64|arm64)$/.test(system);
  const parts = [tCli(locale, 'doctor.detail.hostConnected', { system })];
  if (!supported) parts.push(tCli(locale, 'doctor.detail.hostArchUnsupported'));
  if (missing.length) parts.push(tCli(locale, 'doctor.detail.hostMissingCommands', { missing: missing.join(', ') }));
  if (unchecked.length) parts.push(tCli(locale, 'doctor.detail.hostUncheckedCommands', { unchecked: unchecked.join(', ') }));
  return { ok: supported && missing.length === 0, detail: parts.join(', ') };
}

function expandLocal(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
}

function harnessCommand(def: import('../config/schema.js').AgentDef): string {
  switch (def.harness) {
    case 'claude':
      return 'claude-agent-acp';
    case 'gemini':
      return 'gemini';
    case 'codex':
      return 'codex-acp';
    case 'opencode':
      return 'opencode';
    case 'dsh':
      return 'dsh';
    case 'agy':
      return AGY_COMMAND;
    case 'custom':
      return def.command ?? '(custom harness: no command configured)';
  }
}

/** Whether a local adapter dependency resolves (the claude harness spawns a dependency, not a PATH command). */
function adapterResolves(resolve: () => string): boolean {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}

function authNote(def: import('../config/schema.js').AgentDef, locale: Locale): string {
  if (def.harness === 'agy' && def.env?.AGY_LLM_GATEWAY_URL) return tCli(locale, 'doctor.auth.agyGateway');
  if (def.harness === 'agy') return tCli(locale, 'doctor.auth.agyKeyring');
  if (def.harness !== 'claude') return '';
  const hasKey = Boolean(def.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
  return hasKey ? tCli(locale, 'doctor.auth.apiKey') : tCli(locale, 'doctor.auth.claudeLogin');
}

/**
 * `fleetherd doctor` — self-check. Each item reports ✅/⚠️/❌; doesn't exit on the first
 * failure, summarizes after running all.
 */
interface Check {
  name: string;
  run(): Promise<{ ok: boolean; level?: 'warn'; detail?: string }>;
}

interface DoctorContext {
  cfg: Config | null;
  cfgError: string | null;
  locale: Locale;
  discordResult?: { ok: boolean; level?: 'warn'; detail?: string };
}

/**
 * Try connecting to the socket to see if a daemon is actually listening.
 * Connect ok -> true (daemon running); ECONNREFUSED/timeout -> false (stale or nobody listening).
 */
function probeDaemon(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(alive);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Validate a Discord token: GET /users/@me; 200 yields the bot name, 401 means invalid. */
async function checkDiscordToken(
  token: string,
  locale: Locale
): Promise<{ ok: boolean; level?: 'warn'; detail?: string }> {
  try {
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (resp.status === 200) {
      const me = (await resp.json()) as { username?: string; id?: string };
      const name = me.username ?? me.id ?? '(unknown)';
      return { ok: true, detail: tCli(locale, 'doctor.discord.botUsername', { name }) };
    }
    if (resp.status === 401) {
      return { ok: false, detail: tCli(locale, 'doctor.discord.invalidToken') };
    }
    return { ok: false, detail: tCli(locale, 'doctor.discord.unexpectedStatus', { status: resp.status }) };
  } catch (e) {
    return {
      ok: true,
      level: 'warn',
      detail: tCli(locale, 'doctor.discord.networkError', { error: e instanceof Error ? e.message : String(e) }),
    };
  }
}

/** Collapse the user's home dir to `~` for a compact, portable bin path (AXI §10). */
function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** AXI §10: identify the tool before the live data — absolute bin path + one-line description. */
function printIdentity(locale: Locale): void {
  console.log(`bin: ${tildify(process.argv[1] ?? 'fleetherd')}`);
  console.log(`config: ${tildify(configPath())}`);
  console.log(`description: ${tCli(locale, 'doctor.description')}`);
}

/**
 * `doctor --migrate-config`: rewrite a v0 file to v1 on disk. Validates the migrated
 * shape BEFORE touching the file, backs up to <file>.bak, then does a full rewrite
 * (comments are lost — noted in the output; the in-memory migration path never
 * touches the file, so opting into the rewrite is explicit).
 */
function migrateConfigFile(locale: Locale): void {
  const p = configPath();
  const raw = readRawConfigIfExists();
  if (!raw) {
    console.log(`❌ ${tCli(locale, 'doctor.migrate.cannotRead', { path: p })}`);
    process.exitCode = 1;
    return;
  }
  if (!isLegacyConfig(raw)) {
    console.log(`✅ ${tCli(locale, 'doctor.migrate.alreadyV1', { path: p })}`);
    return;
  }
  const { config, notes } = migrateLegacyConfig(raw);
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    console.log(`❌ ${tCli(locale, 'doctor.migrate.validationFailed', { lines: lines.join('\n') })}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(p, `${p}.bak`);
  saveConfig(config as unknown as Parameters<typeof saveConfig>[0]);
  console.log(`✅ ${tCli(locale, 'doctor.migrate.success', { path: p, backup: `${p}.bak` })}`);
  for (const n of notes) console.log(`   - ${n}`);
}

function buildConfigChecks(ctx: DoctorContext): Check[] {
  const { cfg, cfgError, locale } = ctx;
  return [
    {
      name: tCli(locale, 'doctor.check.configValid'),
      run: async () => {
        if (cfg) return { ok: true };
        return { ok: false, detail: cfgError ?? tCli(locale, 'doctor.detail.unknownError') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.platformInstances'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableInstances') };
        const insts = platformInstances(cfg);
        return { ok: true, detail: insts.map((i) => `"${i.id}" (${i.type})`).join(', ') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.platformCredentials'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableCredentials') };
        const lines: string[] = [];
        let anyFail = false;
        let anyWarn = false;
        for (const [id, p] of Object.entries(cfg.platforms)) {
          if (p.type === 'webui') {
            lines.push(`${id} (webui): ${tCli(locale, 'doctor.detail.webuiLocalToken')}`);
          } else if (p.type === 'discord') {
            ctx.discordResult = await checkDiscordToken(p.token, locale);
            if (!ctx.discordResult.ok) anyFail = true;
            else if (ctx.discordResult.level === 'warn') anyWarn = true;
            const okStr = tCli(locale, 'doctor.detail.ok');
            const failStr = tCli(locale, 'doctor.detail.failed');
            lines.push(`${id}: ${ctx.discordResult.detail ?? (ctx.discordResult.ok ? okStr : failStr)}`);
          } else {
            anyWarn = true;
            lines.push(tCli(locale, 'doctor.detail.unsupportedOnlineValidation', { id, type: p.type }));
          }
        }
        return { ok: !anyFail, ...(anyWarn && !anyFail ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.platformConnectivity'),
      run: async () => {
        const types = cfg ? Object.values(cfg.platforms).map((p) => p.type) : [];
        if (!types.includes('discord')) {
          return { ok: true, detail: tCli(locale, 'doctor.detail.connectivitySkipped', { types: types.join(',') || '(unknown)' }) };
        }
        if (ctx.discordResult?.ok) {
          return {
            ok: true,
            level: 'warn',
            detail: tCli(locale, 'doctor.detail.connectivityPlaceholderOk'),
          };
        }
        return {
          ok: true,
          level: 'warn',
          detail: tCli(locale, 'doctor.detail.connectivityPlaceholderFail'),
        };
      },
    },
  ];
}

function inspectWebuiPlugins(
  id: string,
  plugins: readonly { path: string; config?: unknown }[],
  filesRoots: readonly string[],
  cfg: Config,
  locale: Locale
): string {
  const agentRoots = cfg.agents
    .filter((a) => !a.host)
    .flatMap((a) => [a.cwd, path.join(os.homedir(), '.fleetherd', 'agents', a.id)].filter((x): x is string => Boolean(x)));
  const forbiddenRoots = [...filesRoots, ...agentRoots];
  const seenIds = new Set<string>();
  const items = plugins.map((entry) => {
    const result = loadSinglePlugin(entry, forbiddenRoots, seenIds);
    if (result.ok) {
      seenIds.add(result.plugin.id);
      return `${entry.path} (${result.plugin.id}@${result.plugin.version} ✓)`;
    }
    return `${entry.path} (✗ ${result.reason})`;
  });
  return tCli(locale, 'doctor.detail.webuiPlugins', {
    id,
    count: plugins.length,
    list: items.join(', '),
  });
}

function buildRuntimeChecks(ctx: DoctorContext): Check[] {
  const { cfg, locale } = ctx;
  return [
    {
      name: tCli(locale, 'doctor.check.accessControl'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableAccess') };
        if (!accessUnrestricted(cfg)) {
          return { ok: true, detail: tCli(locale, 'doctor.detail.accessRestricted', { count: cfg.access.allowFrom.length }) };
        }
        return {
          ok: true,
          level: 'warn',
          detail: tCli(locale, 'doctor.detail.accessUnrestricted'),
        };
      },
    },
    {
      name: tCli(locale, 'doctor.check.webui'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableWebui') };
        const uis = Object.entries(cfg.platforms).filter(([, p]) => p.type === 'webui');
        if (uis.length === 0) return { ok: true, detail: tCli(locale, 'doctor.detail.webuiSkipped') };
        const lines: string[] = [];
        let warn = false;
        for (const [id, p] of uis) {
          if (p.type !== 'webui') continue;
          const free = await portFree(p.host, p.port);
          if (!free) {
            warn = true;
            lines.push(tCli(locale, 'doctor.detail.webuiPortInUse', { id, host: p.host, port: p.port }));
          } else {
            lines.push(tCli(locale, 'doctor.detail.webuiPortFree', { id, host: p.host, port: p.port }));
          }
          const identity = `${id}:${OWNER}`;
          if (cfg.access.allowFrom.length > 0 && !cfg.access.allowFrom.includes(identity)) {
            warn = true;
            lines.push(tCli(locale, 'doctor.detail.webuiAllowFromMissing', { id, identity }));
          }
          if (p.host !== '127.0.0.1' && p.host !== 'localhost' && p.host !== '::1') {
            warn = true;
            lines.push(tCli(locale, 'doctor.detail.webuiPlainHttp', { id, host: p.host }));
          }
          if (p.sso) {
            try {
              const keys = await loadJwks(p.sso.jwksUrl);
              lines.push(
                tCli(locale, 'doctor.detail.webuiSsoKeys', {
                  id,
                  header: p.sso.header,
                  from: p.sso.from.join(', '),
                  count: keys.size,
                  url: p.sso.jwksUrl,
                })
              );
            } catch (e) {
              warn = true;
              lines.push(
                tCli(locale, 'doctor.detail.webuiSsoError', {
                  id,
                  url: p.sso.jwksUrl,
                  error: e instanceof Error ? e.message : String(e),
                })
              );
            }
            if (p.sso.password) {
              lines.push(tCli(locale, 'doctor.detail.webuiSsoPassword', { id }));
            }
          }
          if (p.plugins.length > 0) {
            warn = true;
            lines.push(inspectWebuiPlugins(id, p.plugins, p.files.roots, cfg, locale));
          }
        }
        return { ok: true, ...(warn ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.acpSdk'),
      run: async () => {
        const sdkName = '@agentclientprotocol/sdk';
        try {
          await import(sdkName);
          return { ok: true, detail: tCli(locale, 'doctor.detail.acpSdkOk', { sdk: sdkName }) };
        } catch {
          return { ok: false, detail: tCli(locale, 'doctor.detail.acpSdkMissing', { sdk: sdkName }) };
        }
      },
    },
    {
      name: tCli(locale, 'doctor.check.agentHarness'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableAgents') };
        const lines: string[] = [];
        let anyMissing = false;
        for (const def of cfg.agents) {
          if (def.host) continue;
          if (def.connect) {
            lines.push(tCli(locale, 'doctor.detail.agentConnect', { id: def.id, url: def.connect.url }));
            continue;
          }
          const cmd = harnessCommand(def);
          const auth = authNote(def, locale);
          const found =
            def.harness === 'claude'
              ? adapterResolves(resolveClaudeAdapterEntry)
              : Boolean(locateCommand(cmd));
          const note = !found
            ? def.harness === 'claude'
              ? tCli(locale, 'doctor.detail.claudeMissing')
              : def.harness === 'codex'
                ? tCli(locale, 'doctor.detail.codexMissing')
                : ''
            : '';
          if (found) {
            lines.push(`${def.id} (${def.harness}) → ${cmd} ✓${auth}`);
          } else {
            anyMissing = true;
            lines.push(`${def.id} (${def.harness}) → ${cmd}${tCli(locale, 'doctor.detail.agentNotFound')}${note}`);
          }
        }
        return anyMissing
          ? { ok: false, detail: tCli(locale, 'doctor.detail.harnessNotOnPath', { lines: lines.join('; ') }) }
          : { ok: true, detail: lines.join('; ') };
      },
    },
  ];
}

function buildHostAndStoreChecks(ctx: DoctorContext): Check[] {
  const { cfg, locale } = ctx;
  return [
    {
      name: tCli(locale, 'doctor.check.remoteHosts'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableHosts') };
        const hosts = Object.entries(cfg.hosts ?? {});
        if (hosts.length === 0) return { ok: true, detail: tCli(locale, 'doctor.detail.noRemoteHosts') };
        const lines: string[] = [];
        let failed = false;
        for (const [id, def] of hosts) {
          const probes = new Map<string, HostProbe>();
          for (const a of cfg.agents.filter((x) => x.host === id && !x.connect)) {
            const p: HostProbe = { command: harnessCommand(a), path: remoteAgentEnv(a).PATH };
            probes.set(`${p.command}\0${p.path ?? ''}`, p);
          }
          const r = await checkRemoteHost(def, [...probes.values()], locale);
          failed ||= !r.ok;
          lines.push(`${id} (${def.ssh}): ${r.detail}`);
        }
        return { ok: !failed, detail: lines.join('; ') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.skillsRepo'),
      run: async () => {
        if (!gitAvailable()) return { ok: false, detail: tCli(locale, 'doctor.detail.gitNotInstalled') };
        const remote = cfg ? skillsRemoteOf(cfg) : undefined;
        if (!remote) return { ok: true, detail: tCli(locale, 'doctor.detail.skillsLocal') };
        if (/^ssh:\/\//i.test(remote.url) || /^[^/]+@[^/]+:/.test(remote.url)) {
          if (!fs.existsSync(remote.identityFile)) return { ok: false, detail: tCli(locale, 'doctor.detail.skillsNoKey', { path: remote.identityFile }) };
          if (!fs.existsSync(remote.knownHostsFile)) {
            return { ok: false, detail: tCli(locale, 'doctor.detail.skillsNoKnownHosts', { path: remote.knownHostsFile }) };
          }
        }
        try {
          await gitAsync(os.tmpdir(), ['ls-remote', '--heads', remote.url, remote.branch], { GIT_SSH_COMMAND: gitSshCommand(remote) }, 30_000);
          return { ok: true, detail: tCli(locale, 'doctor.detail.skillsAnswers', { url: redactRepoUrl(remote.url), branch: remote.branch }) };
        } catch (e) {
          return { ok: false, detail: `${redactRepoUrl(remote.url)}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
        }
      },
    },
    {
      name: tCli(locale, 'doctor.check.claudeTranscripts'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableAgents') };
        const allClaude = cfg.agents.filter((a) => a.harness === 'claude');
        if (allClaude.length === 0) return { ok: true, detail: tCli(locale, 'doctor.detail.noClaudeAgent') };
        const claudeAgents = allClaude.filter((a) => !a.host);
        const remote = allClaude.filter((a) => Boolean(a.host)).map((a) => tCli(locale, 'doctor.detail.remoteClaude', { id: a.id, host: a.host ?? '' }));
        const lines: string[] = [...remote];
        let anyMissing = false;
        for (const dir of new Set(claudeAgents.map((a) => claudeProjectsDir(a)))) {
          if (fs.existsSync(dir)) {
            lines.push(`${dir} ✓`);
          } else {
            anyMissing = true;
            lines.push(tCli(locale, 'doctor.detail.claudeDirMissing', { dir }));
          }
        }
        return anyMissing
          ? { ok: true, level: 'warn', detail: lines.join('; ') }
          : { ok: true, detail: lines.join('; ') };
      },
    },
    {
      name: tCli(locale, 'doctor.check.ipcSocket'),
      run: async () => {
        if (!cfg) return { ok: false, detail: tCli(locale, 'doctor.detail.configUnavailableSocket') };
        try {
          const sock = resolveSocketPath(cfg);
          if (isNamedPipe(sock)) {
            const alive = await probeDaemon(sock);
            if (alive) {
              return { ok: true, level: 'warn', detail: tCli(locale, 'doctor.detail.socketAlive', { path: sock }) };
            }
            return { ok: true, detail: sock };
          }
          if (fs.existsSync(sock)) {
            const alive = await probeDaemon(sock);
            if (alive) {
              return { ok: true, level: 'warn', detail: tCli(locale, 'doctor.detail.socketAlive', { path: sock }) };
            }
            return {
              ok: true,
              level: 'warn',
              detail: tCli(locale, 'doctor.detail.socketStale', { path: sock }),
            };
          }
          return { ok: true, detail: sock };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
    },
  ];
}

export async function runDoctor(opts: { migrateConfig?: boolean } = {}): Promise<void> {
  let cfg: Config | null = null;
  let cfgError: string | null = null;
  try {
    cfg = loadConfig();
  } catch (e) {
    cfgError = String(e instanceof Error ? e.message : e);
  }
  const raw = cfg ? null : readRawConfigIfExists();
  const locale: Locale = cfg?.locale ?? (raw?.locale as Locale | undefined) ?? detectEnvLocale(process.env);

  if (opts.migrateConfig) {
    migrateConfigFile(locale);
    return;
  }

  printIdentity(locale);

  const ctx: DoctorContext = { cfg, cfgError, locale };
  const checks: Check[] = [
    ...buildConfigChecks(ctx),
    ...buildRuntimeChecks(ctx),
    ...buildHostAndStoreChecks(ctx),
  ];

  let failed = false;
  for (const c of checks) {
    const r = await c.run();
    const icon = r.ok ? (r.level === 'warn' ? '⚠️ ' : '✅') : '❌';
    if (!r.ok) failed = true;
    console.log(`${icon} ${c.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (failed) process.exitCode = 1;
}
