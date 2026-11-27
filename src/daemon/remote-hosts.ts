import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef, Config, HostDef } from '../config/schema.js';
import { configDir } from '../config/load.js';
import { commandHint, isBridgedCommand } from '../ipc/commands.js';
import { packageVersion, remoteBinary, sshTransport } from '../remote/binaries.js';
import { RemoteHost, type CliBridge, type CliSession } from '../remote/host.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { defaultIdentityFile, defaultKnownHostsFile, expandLocalHome } from './ssh-identity.js';
import { envOf } from '../legacy-name.js';

/**
 * The daemon's remote hosts (`hosts:` in config.yaml): one RemoteHost per entry, shared by every
 * agent whose `host` names it, and the pieces of "an agent on another machine" that are the
 * daemon's to decide rather than the transport's — the namespace this gateway uses on every host
 * and how an agent's `fleetherd` command is run back here.
 *
 * A module-level registry, configured once at start and again on `/reload`, because the runtimes
 * that need it are built by factories far from the daemon's constructor, and a host must be ONE
 * connection however many agents and conversations use it.
 */

/**
 * This gateway's name on every host it reaches (remote/paths.go `<ns>`): made up once and kept in
 * the config directory, so a restart finds its own daemon again — and a second gateway on the same
 * machine (a test instance with its own config directory) never finds the first one's.
 */
export function gatewayNamespace(dir = configDir()): string {
  const file = path.join(dir, 'remote-id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (/^g[0-9a-f]{12}$/.test(id)) return id;
  } catch {
    // first run
  }
  const id = `g${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/**
 * One remote session's `fleetherd mcp`, served in the daemon (commands/mcp.ts mcpSession). What it
 * is given is what a spawned server would have found in its environment.
 */
export type InProcessMcp = (
  session: { token: string; socket: string; cwd: string; home: string; version: string; ipcTimeoutMs?: string },
  io: Parameters<CliBridge>[1]
) => CliSession;

export class RemoteHosts {
  private readonly hosts = new Map<string, { key: string; host: RemoteHost }>();
  /** One per gateway process: a host that sees a new one knows the old gateway is gone. */
  private readonly epoch = randomBytes(8).toString('hex');
  private socketPath = '';
  private ns: string | undefined;
  /** Told each time a host's connection comes up or drops (host-availability.ts listens). */
  private connectionListener: ((id: string, up: boolean) => void) | undefined;
  /** Serves a host's `fleetherd mcp` in this process; unset, it is spawned like any command. */
  private mcp: InProcessMcp | undefined;

  /**
   * Serve the native-tools server of every agent on a host in this process (commands/mcp.ts
   * mcpSession says why). Handed in by `start` because the server is commands/'s, and daemon/ does
   * not import commands/ (AGENTS.md Layering).
   */
  serveMcpWith(mcp: InProcessMcp): void {
    this.mcp = mcp;
  }

  /** Hear about every host's connection coming up or dropping — one listener, the daemon's. */
  onConnection(listener: (id: string, up: boolean) => void): void {
    this.connectionListener = listener;
  }

  /** (Re)build the host table from config. Unchanged entries keep their live connection. */
  configure(cfg: Pick<Config, 'hosts'>, socketPath: string): void {
    this.socketPath = socketPath;
    const wanted = cfg.hosts ?? {};
    for (const [id, entry] of [...this.hosts]) {
      const def = wanted[id];
      if (!def || hostKey(def) !== entry.key) {
        entry.host.close();
        this.hosts.delete(id);
      }
    }
    for (const [id, def] of Object.entries(wanted)) {
      if (this.hosts.has(id)) continue;
      this.ns ??= gatewayNamespace();
      const version = packageVersion();
      const host = new RemoteHost({
        id,
        ns: this.ns,
        epoch: this.epoch,
        transport: sshTransport({
          destination: def.ssh,
          identityFile: expandLocalHome(def.identityFile ?? defaultIdentityFile()),
          knownHostsFile: expandLocalHome(def.knownHostsFile ?? defaultKnownHostsFile()),
        }),
        binary: (arch) => remoteBinary(arch, version),
        cli: (req, io) => this.runCli(req, io),
      });
      this.hosts.set(id, { key: hostKey(def), host });
      // Through a field rather than the listener itself, so one set after configure() still hears
      // the hosts configured before it.
      host.on('up', () => this.connectionListener?.(id, true));
      host.on('down', () => this.connectionListener?.(id, false));
      // Reached once now rather than on the first message: a host whose last gateway died without
      // stopping its agents (a crash, a kill -9) sees this gateway's new epoch and stops them at
      // once instead of whenever someone next writes; and a wrong address or key shows up in the
      // log at startup. The connection then closes on its own once idle.
      host.ready().catch((e: Error) => console.warn(`[remote] ${id}: ${e.message}`));
    }
  }

  get(id: string): RemoteHost | undefined {
    return this.hosts.get(id)?.host;
  }

  /** The host an agent runs on, or undefined for one that runs here. */
  hostFor(def: AgentDef | undefined): RemoteHost | undefined {
    return def?.host ? this.get(def.host) : undefined;
  }

  ids(): string[] {
    return [...this.hosts.keys()];
  }

  /** Wait (bounded) until every host has delivered what is queued for it. */
  async flushAll(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pending = (): boolean => [...this.hosts.values()].some(({ host }) => host.isUp && host.conn.link.backlogBytes > 0);
    while (pending() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  closeAll(): void {
    for (const { host } of this.hosts.values()) host.close();
    this.hosts.clear();
  }

  /**
   * Run one `fleetherd …` an agent on a host invoked, as this gateway's own CLI — the same program a
   * local agent's command runs, so parsing, validation and output are the same — with the turn
   * token the agent holds, this daemon's socket, and the agent's directory and home, which is what
   * its relative and `~` paths mean (commands/reverse.ts resolvePathArg).
   *
   * Public because it is the security boundary itself: the test drives it directly rather than
   * asserting on the list it consults, which would stay green with the call removed.
   *
   * Bare `mcp` is the exception to "spawned": served in this process when `serveMcpWith` was given
   * a server — after the same allowlist check, and with the same token on every call it makes.
   */
  runCli(req: Parameters<CliBridge>[0], io: Parameters<CliBridge>[1]): CliSession {
    const refuse = (message: string): CliSession => {
      io.out(2, Buffer.from(`fleetherd: ${message}\n`));
      io.exit(2);
      return { write: () => {}, end: () => {}, kill: () => {} };
    };
    // The command is judged before this process's own shape: a forbidden command is forbidden
    // whatever the gateway runs as, and the message about it is the useful one.
    if (!isBridgedCommand(req.argv)) {
      const hint = commandHint(req.argv[0] ?? '');
      return refuse(
        `"${req.argv[0] ?? ''}" is not a command an agent can run here; \`fleetherd help\` lists them` +
          (hint ? `. ${hint}` : '')
      );
    }
    const cwd = envOf('CWD', req.env) || req.cwd;
    const home = (): string => req.host.conn.welcome?.home || '/';
    const timeout = envOf('IPC_TIMEOUT_MS', req.env);
    const stdinTty = envOf('STDIN_TTY', req.env);
    // Bare `mcp` only: anything after it (`mcp --help`) is the CLI's to answer.
    if (this.mcp && req.argv.length === 1 && req.argv[0] === 'mcp') {
      return this.mcp(
        { token: req.token, socket: this.socketPath, cwd, home: home(), version: packageVersion(), ipcTimeoutMs: timeout },
        io
      );
    }
    const self = selfInvocation();
    if (!self) return refuse('this gateway is not running as the fleetherd CLI, so it cannot run reverse commands');
    const env: Record<string, string | undefined> = {
      ...process.env,
      FLEETHERD_TURN_TOKEN: req.token,
      FLEETHERD_SOCKET: this.socketPath,
      FLEETHERD_CWD: cwd,
      FLEETHERD_REMOTE_HOME: home(),
      FLEETHERD_REMOTE_HOST: req.host.id,
    };
    if (timeout) env.FLEETHERD_IPC_TIMEOUT_MS = timeout;
    if (stdinTty) env.FLEETHERD_STDIN_TTY = stdinTty;
    const child = spawn(self.command, [...self.args, ...req.argv], { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => io.out(1, d));
    child.stderr.on('data', (d: Buffer) => io.out(2, d));
    child.stdin.on('error', () => {}); // the command finished without reading what was piped to it
    child.on('error', (e) => {
      io.out(2, Buffer.from(`fleetherd: ${e.message}\n`));
      io.exit(127);
    });
    child.on('close', (code) => io.exit(code ?? 1));
    return {
      write: (d) => child.stdin.write(d),
      end: () => child.stdin.end(),
      kill: () => child.kill(),
    };
  }
}

function hostKey(def: HostDef): string {
  return JSON.stringify([def.ssh, def.identityFile ?? '', def.knownHostsFile ?? '']);
}

/** The daemon's registry (see the header for why it is module-level). */
export const remoteHosts = new RemoteHosts();
