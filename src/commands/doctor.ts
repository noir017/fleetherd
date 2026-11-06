import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveSocketPath, configPath, readRawConfigIfExists, saveConfig } from '../config/load.js';
import { ConfigSchema, accessUnrestricted, platformInstances, type Config, type HostDef, agyRuntime } from '../config/schema.js';
import { spawnSync } from 'node:child_process';
import { sshArgs } from '../remote/binaries.js';
import { defaultIdentityFile, defaultKnownHostsFile } from '../daemon/remote-hosts.js';
import { gitAsync, gitAvailable } from '../daemon/skills-git.js';
import { gitSshCommand, redactRepoUrl, skillsRemoteOf } from '../daemon/skills-repo.js';
import { isLegacyConfig, migrateLegacyConfig } from '../config/migrate.js';
import { resolveClaudeAdapterEntry } from '../daemon/agent-acp.js';
import { AGY_COMMAND } from '../daemon/agy-cli.js';
import { claudeProjectsDir } from '../daemon/claude-transcript.js';
import { remoteAgentEnv } from '../daemon/agent-common.js';
import { hostProbeScript, readHostProbe, type HostProbe } from '../daemon/host-probe.js';
import { agentHome } from '../daemon/skills-scan.js';
import { OWNER } from '../platform/webui/room.js';
import { loadJwks } from '../platform/webui/sso.js';

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
function locateCommand(cmd: string): string | null {
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* command not in this dir, continue */
    }
  }
  return null;
}

/** Agent definition -> its harness's main executable name (doctor only checks reachability, same convention as agent-acp's resolveHarness / agent-agy's AGY_COMMAND). claude is handled separately (a local dependency, not PATH). */
/** One `hosts:` entry, checked the way the daemon will use it (see the check's own comment). */
async function checkRemoteHost(def: HostDef, probes: HostProbe[]): Promise<{ ok: boolean; detail: string }> {
  const key = expandLocal(def.identityFile ?? defaultIdentityFile());
  const known = expandLocal(def.knownHostsFile ?? defaultKnownHostsFile());
  if (!fs.existsSync(key)) return { ok: false, detail: `no private key at ${key}` };
  if (!fs.existsSync(known)) {
    return { ok: false, detail: `no known_hosts at ${known} — add the host's key (ssh-keyscan, checked by hand) before the daemon can connect` };
  }
  const script = `uname -sm; exec "\${SHELL:-/bin/sh}" -ilc "${hostProbeScript(probes)}" </dev/null 2>/dev/null`;
  const r = spawnSync('ssh', sshArgs({ destination: def.ssh, identityFile: key, knownHostsFile: known }, script), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.status !== 0 && !r.stdout.includes('TCR-')) {
    return { ok: false, detail: `ssh failed (exit ${r.status}): ${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}` };
  }
  const system = r.stdout.split('\n')[0]?.trim() ?? '';
  const { missing, unchecked } = readHostProbe(probes, r.stdout);
  const supported = /^Linux (x86_64|amd64|aarch64|arm64)$/.test(system);
  const parts = [`connected (${system})`];
  if (!supported) parts.push('✗ talkcode-remote runs on Linux x86_64/arm64 only');
  if (missing.length) parts.push(`✗ not found there: ${missing.join(', ')}`);
  if (unchecked.length) parts.push(`not checked: ${unchecked.join(', ')}`);
  return { ok: supported && missing.length === 0, detail: parts.join(', ') };
}

function expandLocal(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
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

/**
 * Auth-method note. harness=claude (claude-agent-acp) by default reuses this machine's
 * `claude /login` subscription session; if ANTHROPIC_API_KEY is set (via env or
 * environment) it uses an API key. harness=agy reuses the Google sign-in `agy` cached in the OS
 * keyring — headless runs never prompt, so a never-signed-in agy fails at the first turn, and
 * saying so here is the only warning the operator gets. Other harnesses aren't noted (own mechanisms).
 */
function authNote(def: import('../config/schema.js').AgentDef): string {
  if (def.harness === 'agy') return ' [agy Google sign-in from the OS keyring; run `agy` once interactively if never signed in]';
  if (def.harness !== 'claude') return '';
  const hasKey = Boolean(def.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
  return hasKey ? ' [API key]' : ' [claude /login subscription session]';
}

/**
 * `talkcode doctor` — self-check. Each item reports ✅/⚠️/❌; doesn't exit on the first
 * failure, summarizes after running all.
 */
interface Check {
  name: string;
  run(): Promise<{ ok: boolean; level?: 'warn'; detail?: string }>;
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
  token: string
): Promise<{ ok: boolean; level?: 'warn'; detail?: string }> {
  try {
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (resp.status === 200) {
      const me = (await resp.json()) as { username?: string; id?: string };
      const name = me.username ?? me.id ?? '(unknown)';
      return { ok: true, detail: `bot username: ${name}` };
    }
    if (resp.status === 401) {
      return { ok: false, detail: 'invalid token (401 Unauthorized)' };
    }
    return { ok: false, detail: `Discord returned an unexpected status ${resp.status}` };
  } catch (e) {
    // Network errors etc. aren't treated as an invalid token; degrade to warn.
    return {
      ok: true,
      level: 'warn',
      detail: `could not reach Discord to validate the token: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Collapse the user's home dir to `~` for a compact, portable bin path (AXI §10). */
function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** AXI §10: identify the tool before the live data — absolute bin path + one-line description. */
function printIdentity(): void {
  console.log(`bin: ${tildify(process.argv[1] ?? 'talkcode')}`);
  console.log(`config: ${tildify(configPath())}`);
  console.log('description: Gateway connecting IM platforms to coding agents; this is its self-check.');
}

/**
 * `doctor --migrate-config`: rewrite a v0 file to v1 on disk. Validates the migrated
 * shape BEFORE touching the file, backs up to <file>.bak, then does a full rewrite
 * (comments are lost — noted in the output; the in-memory migration path never
 * touches the file, so opting into the rewrite is explicit).
 */
function migrateConfigFile(): void {
  const p = configPath();
  const raw = readRawConfigIfExists();
  if (!raw) {
    console.log(`❌ cannot read ${p} (missing or unparseable); nothing to migrate`);
    process.exitCode = 1;
    return;
  }
  if (!isLegacyConfig(raw)) {
    console.log(`✅ ${p} is already in the v1 format (platforms: map); nothing to do`);
    return;
  }
  const { config, notes } = migrateLegacyConfig(raw);
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    console.log(`❌ migrated config does not validate; file left untouched:\n${lines.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(p, `${p}.bak`);
  // Write the SLIM migrated raw (validated above), not parsed.data — parsing materializes
  // every schema default and would bloat the file with values the user never set.
  saveConfig(config as unknown as Parameters<typeof saveConfig>[0]);
  console.log(`✅ migrated ${p} to the v1 format (backup at ${p}.bak; YAML comments were not preserved)`);
  for (const n of notes) console.log(`   - ${n}`);
}

export async function runDoctor(opts: { migrateConfig?: boolean } = {}): Promise<void> {
  if (opts.migrateConfig) {
    migrateConfigFile();
    return;
  }

  printIdentity();

  // Load config once and reuse it across checks; if loading fails, dependent checks degrade themselves.
  let cfg: Config | null = null;
  let cfgError: string | null = null;
  try {
    cfg = loadConfig();
  } catch (e) {
    cfgError = String(e instanceof Error ? e.message : e);
  }

  // Cache the Discord token result for the "platform adapter connectivity (placeholder)" check (only the discord path writes it).
  let discordResult: { ok: boolean; level?: 'warn'; detail?: string } | null = null;

  const checks: Check[] = [
    {
      name: 'Config file exists and is valid',
      run: async () => {
        if (cfg) return { ok: true };
        return { ok: false, detail: cfgError ?? 'unknown error' };
      },
    },
    {
      // One daemon drives every configured instance; list them for a quick sanity read.
      name: 'Platform instances',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot resolve platform instances' };
        const insts = platformInstances(cfg);
        return { ok: true, detail: insts.map((i) => `"${i.id}" (${i.type})`).join(', ') };
      },
    },
    {
      // Platform credential check per instance. Required credentials are already
      // schema-validated at load (typed per-platform schemas), so only ONLINE validation
      // remains: discord hits /users/@me; other platforms have none implemented yet.
      name: 'Platform credentials usable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot read credentials' };
        const lines: string[] = [];
        let anyFail = false;
        let anyWarn = false;
        for (const [id, p] of Object.entries(cfg.platforms)) {
          if (p.type === 'webui') {
            // Its credential is a secret the operator chose for a server this process runs;
            // there is nothing upstream to ask. The port and the allowlist are what can be
            // wrong here, and both are checked below.
            lines.push(`${id} (webui): the login token is local — nothing to validate online`);
          } else if (p.type === 'discord') {
            discordResult = await checkDiscordToken(p.token);
            if (!discordResult.ok) anyFail = true;
            else if (discordResult.level === 'warn') anyWarn = true;
            lines.push(`${id}: ${discordResult.detail ?? (discordResult.ok ? 'ok' : 'failed')}`);
          } else {
            anyWarn = true;
            lines.push(
              `${id} (${p.type}): credentials schema-validated; online validation not implemented — if start fails to connect, re-check them`
            );
          }
        }
        return { ok: !anyFail, ...(anyWarn && !anyFail ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
      },
    },
    {
      // Adapter connectivity placeholder: only discord shows an honest "no gateway
      // actually established" placeholder; other platforms skip this check (avoiding a
      // misleading Discord-specific placeholder).
      name: 'Platform adapter connectivity (placeholder)',
      run: async () => {
        const types = cfg ? Object.values(cfg.platforms).map((p) => p.type) : [];
        if (!types.includes('discord')) {
          // Non-discord has no online placeholder check; pass and explain why it's skipped.
          return { ok: true, detail: `${types.join(',') || '(unknown)'} skipped (no online connectivity placeholder)` };
        }
        // discord: don't actually start a gateway; token validation already covers most connectivity (same bot credential).
        if (discordResult?.ok) {
          return {
            ok: true,
            level: 'warn',
            detail: 'placeholder: no gateway was actually established; the token check already covers most connectivity',
          };
        }
        return {
          ok: true,
          level: 'warn',
          detail: 'placeholder: no gateway was actually established; the token check failed, so the adapter most likely cannot connect',
        };
      },
    },
    {
      // Security posture: agents always run with full tool access, so an empty access.allowFrom
      // means anyone who can message the bot can drive them. Surface it as a standing ⚠️.
      name: 'Security: access control',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check access control' };
        if (!accessUnrestricted(cfg)) {
          return { ok: true, detail: `access.allowFrom restricts triggering to ${cfg.access.allowFrom.length} identity(ies)` };
        }
        return {
          ok: true,
          level: 'warn',
          detail:
            'access.allowFrom is empty: ANYONE who can message the bot can trigger an agent with full ' +
            'tool access (Bash / file writes). Set access.allowFrom to lock this down for production.',
        };
      },
    },
    {
      // The web UI's two ways of being configured-but-dead: a port something else already
      // holds, and an allowlist that does not name it. Both fail silently at runtime — the
      // first as a startup error long after the other platforms are live, the second as a
      // page that accepts your messages and never answers one.
      name: 'Web UI',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check the web UI' };
        const uis = Object.entries(cfg.platforms).filter(([, p]) => p.type === 'webui');
        if (uis.length === 0) return { ok: true, detail: 'no webui instance configured; skipped' };
        const lines: string[] = [];
        let warn = false;
        for (const [id, p] of uis) {
          if (p.type !== 'webui') continue;
          const free = await portFree(p.host, p.port);
          if (!free) {
            warn = true;
            lines.push(
              `${id}: ${p.host}:${p.port} is already in use — that is this web UI if the daemon is running, and a conflict if it is not`
            );
          } else {
            lines.push(`${id}: ${p.host}:${p.port} is free`);
          }
          const identity = `${id}:${OWNER}`;
          if (cfg.access.allowFrom.length > 0 && !cfg.access.allowFrom.includes(identity)) {
            warn = true;
            lines.push(
              `${id}: access.allowFrom does not list "${identity}", so every message typed into this page will be ignored`
            );
          }
          if (p.host !== '127.0.0.1' && p.host !== 'localhost' && p.host !== '::1') {
            warn = true;
            lines.push(
              `${id}: bound to ${p.host} over plain HTTP — the login token is the only thing between the network and an agent with full tool access; put TLS in front of it`
            );
          }
          if (p.sso) {
            // The one thing here that CAN be validated online, and the one most worth it: a
            // JWKS URL with a typo in it fails closed, but it fails closed at 3am on a phone
            // rather than here.
            try {
              const keys = await loadJwks(p.sso.jwksUrl);
              lines.push(
                `${id}: sso reads ${p.sso.header} from ${p.sso.from.join(', ')}, verified against ${keys.size} key(s) at ${p.sso.jwksUrl}`
              );
            } catch (e) {
              warn = true;
              lines.push(
                `${id}: sso cannot read ${p.sso.jwksUrl} (${e instanceof Error ? e.message : String(e)}) — nobody gets in this way until that URL answers`
              );
            }
            if (p.sso.password) {
              lines.push(`${id}: the shared token is still a second way in; set sso.password: false once sso works`);
            }
          }
        }
        return { ok: true, ...(warn ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
      },
    },
    {
      name: 'ACP SDK installed',
      run: async () => {
        const sdkName = '@agentclientprotocol/sdk';
        try {
          await import(sdkName);
          return { ok: true, detail: `${sdkName} loads successfully` };
        } catch {
          return { ok: false, detail: `${sdkName} is not installed — run npm i first` };
        }
      },
    },
    {
      name: 'Agent harness commands reachable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check agents' };
        const lines: string[] = [];
        let anyMissing = false;
        for (const def of cfg.agents) {
          // An agent on another machine needs its command THERE (the remote-hosts check below).
          if (def.host) continue;
          const cmd = harnessCommand(def);
          const auth = authNote(def);
          // claude runs a locally installed adapter dependency (claude-agent-acp), so its check is
          // "does the dependency resolve", not a PATH lookup. Every other harness, codex included,
          // is a command the operator installed — see the codex arm of resolveHarness for why that
          // adapter is deliberately not bundled. Whether they can actually log in is covered by authNote.
          const found =
            def.harness === 'claude'
              ? adapterResolves(resolveClaudeAdapterEntry)
              : Boolean(locateCommand(cmd));
          const note = !found
            ? def.harness === 'claude'
              ? ' (dependency missing — run npm install)'
              : def.harness === 'codex'
                ? ' (install it with `npm i -g @agentclientprotocol/codex-acp`)'
                : ''
            : '';
          if (found) {
            lines.push(`${def.id} (${def.harness}) → ${cmd} ✓${auth}`);
          } else {
            anyMissing = true;
            lines.push(`${def.id} (${def.harness}) → ${cmd} ✗ not found${note}`);
          }
        }
        // A fully missing command means the agent subprocess can't launch at start -> escalate to ❌ (so the exit code reflects it), not warn.
        return anyMissing
          ? { ok: false, detail: `some harness commands are not on PATH: ${lines.join('; ')}` }
          : { ok: true, detail: lines.join('; ') };
      },
    },
    {
      /**
       * Each `hosts:` entry: the key and known_hosts the gateway pins, a real connection, and the
       * harness commands of the agents placed there — looked up on the host's LOGIN PATH, which is
       * the environment talkcode-remote starts agents in (remote/shellenv.go), not the bare one a
       * non-interactive ssh command gets; or in the agent's own PATH when its `env` sets one
       * (doctor-hosts.ts).
       */
      name: 'Remote hosts reachable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check hosts' };
        const hosts = Object.entries(cfg.hosts ?? {});
        if (hosts.length === 0) return { ok: true, detail: 'none configured (every agent runs here)' };
        const lines: string[] = [];
        let failed = false;
        for (const [id, def] of hosts) {
          const probes = new Map<string, HostProbe>();
          for (const a of cfg.agents.filter((x) => x.host === id)) {
            const p: HostProbe = { command: harnessCommand(a), path: remoteAgentEnv(a).PATH };
            probes.set(`${p.command}\0${p.path ?? ''}`, p);
          }
          const r = await checkRemoteHost(def, [...probes.values()]);
          failed ||= !r.ok;
          lines.push(`${id} (${def.ssh}): ${r.detail}`);
        }
        return { ok: !failed, detail: lines.join('; ') };
      },
    },
    {
      /**
       * The managed skills live in a git repository (daemon/skills-store.ts), so a gateway without
       * git delivers none of them; and with `skills.repo` set, the repository has to answer with the
       * key and known_hosts the gateway pins — `git ls-remote` is the daemon's own fetch, minus the
       * download.
       */
      name: 'Skills repository',
      run: async () => {
        if (!gitAvailable()) return { ok: false, detail: 'git is not installed — the managed skills are neither delivered nor writable' };
        const remote = cfg ? skillsRemoteOf(cfg) : undefined;
        if (!remote) return { ok: true, detail: 'git found; no skills.repo, so the skills stay in a local repository' };
        if (/^ssh:\/\//i.test(remote.url) || /^[^/]+@[^/]+:/.test(remote.url)) {
          if (!fs.existsSync(remote.identityFile)) return { ok: false, detail: `no key at ${remote.identityFile}` };
          if (!fs.existsSync(remote.knownHostsFile)) {
            return { ok: false, detail: `no known_hosts at ${remote.knownHostsFile} — add the repository host's key (checked by hand) first` };
          }
        }
        try {
          await gitAsync(os.tmpdir(), ['ls-remote', '--heads', remote.url, remote.branch], { GIT_SSH_COMMAND: gitSshCommand(remote) }, 30_000);
          return { ok: true, detail: `${redactRepoUrl(remote.url)} answers (branch ${remote.branch})` };
        } catch (e) {
          return { ok: false, detail: `${redactRepoUrl(remote.url)}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
        }
      },
    },
    {
      /**
       * Only meaningful for agy on its stream-json fallback, and skipped entirely without one. It
       * answers the one question an operator cannot answer by looking: on an agy older than 1.4.7
       * the footer's context numbers arrive through agy's `statusLine` setting (see
       * daemon/agy-statusline.ts), so a setting that points elsewhere is the whole explanation for
       * "why does /context say nothing on agy" — and pointing elsewhere is a supported choice, hence
       * a warning rather than a failure. Over `agy acp` the status line plays no part in it.
       */
      name: 'agy status line wired for context usage',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check agents' };
        // Only the agy agents that run here: the daemon wires the status line of a local home only
        // (createAgyAgentFactory), and on a host agy reports context through its stream (1.4.7+).
        // Checking a remote agent's home on THIS disk warned about a file nothing would ever read.
        const allAgy = cfg.agents.filter((a) => a.harness === 'agy');
        const local = allAgy.filter((a) => !a.host);
        const agyAgents = local.filter((a) => agyRuntime(a) === 'stream-json');
        if (allAgy.length === 0) return { ok: true, detail: 'no agy agent configured' };
        if (local.length === 0) return { ok: true, detail: 'every agy agent runs on a host (context comes from its stream there)' };
        if (agyAgents.length === 0) return { ok: true, detail: 'every agy agent here runs as `agy acp`, which reports usage itself' };
        if (process.env.TALKCODE_NO_AGY_STATUSLINE) {
          return { ok: true, level: 'warn', detail: 'TALKCODE_NO_AGY_STATUSLINE is set — agy will report no context usage' };
        }
        const lines: string[] = [];
        let anyUnwired = false;
        for (const home of new Set(agyAgents.map((a) => agentHome(a)))) {
          const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
          let command: string | undefined;
          try {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
            command = (parsed as { statusLine?: { command?: string } })?.statusLine?.command;
          } catch {
            command = undefined;
          }
          if (command?.includes('agy-statusline')) {
            lines.push(`${file} → talkcode shim ✓`);
          } else {
            anyUnwired = true;
            lines.push(`${file} → ${command ?? 'no statusLine'} (the daemon rewires this on start, and again before starting agy)`);
          }
        }
        return anyUnwired
          ? { ok: true, level: 'warn', detail: lines.join('; ') }
          : { ok: true, detail: lines.join('; ') };
      },
    },
    {
      /**
       * Only meaningful for claude agents, and only for the web UI's status strip: its cache
       * countdown is read from Claude Code's own transcripts (see daemon/claude-transcript.ts),
       * because headless Claude Code runs no status line to ask. A missing directory costs that one
       * segment and nothing else, hence a warning.
       */
      name: 'claude transcripts readable for the cache countdown',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check agents' };
        const allClaude = cfg.agents.filter((a) => a.harness === 'claude');
        if (allClaude.length === 0) return { ok: true, detail: 'no claude agent configured' };
        // A claude agent on a host writes its transcripts there, and the daemon reads them there
        // (remoteClaudeProjectsDir). Looking on this disk warned "missing" for every remote agent.
        const claudeAgents = allClaude.filter((a) => !a.host);
        const remote = allClaude.filter((a) => a.host).map((a) => `${a.id} on ${a.host}: read there, not checked here`);
        const lines: string[] = [...remote];
        let anyMissing = false;
        for (const dir of new Set(claudeAgents.map((a) => claudeProjectsDir(a)))) {
          if (fs.existsSync(dir)) {
            lines.push(`${dir} ✓`);
          } else {
            anyMissing = true;
            lines.push(`${dir} missing (created by Claude Code on its first session)`);
          }
        }
        return anyMissing
          ? { ok: true, level: 'warn', detail: lines.join('; ') }
          : { ok: true, detail: lines.join('; ') };
      },
    },
    {
      name: 'IPC socket path usable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot resolve socket path' };
        try {
          const sock = resolveSocketPath(cfg);
          if (fs.existsSync(sock)) {
            // Socket file exists: probe to distinguish "daemon running" from "stale file".
            const alive = await probeDaemon(sock);
            if (alive) {
              return { ok: true, level: 'warn', detail: `${sock} (a daemon is listening)` };
            }
            return {
              ok: true,
              level: 'warn',
              detail: `${sock} exists but nothing is listening (stale file; the daemon cleans it up on start)`,
            };
          }
          return { ok: true, detail: sock };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
    },
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
