import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDef, Config, HostDef } from '../config/schema.js';
import { configDir } from '../config/load.js';
import { REVERSE_COMMANDS } from '../ipc/commands.js';
import { packageVersion, remoteBinary, sshTransport } from '../remote/binaries.js';
import type { Welcome } from '../remote/connection.js';
import { RemoteHost, type CliBridge, type CliSession } from '../remote/host.js';
import {
  INSTRUCTIONS_MAX_BYTES,
  SETTLED,
  composeInstructions,
  instructionsDir,
  instructionsHome,
  ownedDir,
  reportInstructions,
  type InstructionsResult,
} from './instructions.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { BUNDLED_SKILLS, allSkillDirs, bundledSkillDir, skillHomes } from './skill-link.js';

/**
 * The daemon's remote hosts (`hosts:` in config.yaml): one RemoteHost per entry, shared by every
 * agent whose `host` names it, and the pieces of "an agent on another machine" that are the
 * daemon's to decide rather than the transport's — the namespace this gateway uses on every host,
 * how an agent's `talkcode` command is run back here, and where the bundled skill goes over there.
 *
 * A module-level registry, configured once at start and again on `/reload`, because the runtimes
 * that need it are built by factories far from the daemon's constructor, and a host must be ONE
 * connection however many agents and conversations use it.
 */

/**
 * The commands an agent on a remote host may run back here: the reverse commands, the native-tools
 * server, and help. Nothing else — this process is the gateway, and `talkcode start` or `setup`
 * invoked by a remote agent would be that agent running the gateway's own administration.
 */
const BRIDGED = new Set([...REVERSE_COMMANDS.map((s) => s.usage.split(' ')[0]!), 'mcp', 'help', '--help', '-h', '--version', '-V']);

export function isBridgedCommand(argv: string[]): boolean {
  return argv.length > 0 && BRIDGED.has(argv[0]!);
}

export function defaultIdentityFile(): string {
  return path.join(configDir(), 'ssh', 'id_ed25519');
}

export function defaultKnownHostsFile(): string {
  return path.join(configDir(), 'ssh', 'known_hosts');
}

/** The known_hosts file a host is checked against, `~` expanded. */
export function knownHostsFileOf(def: HostDef): string {
  return expandLocalHome(def.knownHostsFile ?? defaultKnownHostsFile());
}

function expandLocalHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

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

export class RemoteHosts {
  private readonly hosts = new Map<string, { key: string; host: RemoteHost }>();
  /** One per gateway process: a host that sees a new one knows the old gateway is gone. */
  private readonly epoch = randomBytes(8).toString('hex');
  private socketPath = '';
  private ns: string | undefined;
  /** host id + version → the skill is on that host for that version. */
  private readonly skillPlaced = new Set<string>();
  /**
   * host id + daemon instance + the harness's file → what was last delivered there and settled (a
   * hash of the text, or `none` / `too-big`), so an unchanged text costs no round trip per spawn.
   */
  private readonly instructionsPlaced = new Map<string, string>();

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
   * Put the bundled skills where `def` reads skills on the host (skill-link.ts says where, and
   * why only for a harness that has run there). The files go into the version's own directory, so
   * an upgrade retires them along with the old build, and the links are repointed by the next
   * spawn. Best-effort, like the local link: an agent without the skills still has its tools.
   *
   * Once per version, before linking, the links an older build left behind are swept: a link into a
   * version directory that no longer exists is dead, and only a spawn of the harness it was made for
   * would repoint it — so one made for a harness this build no longer maps would stay dead forever.
   */
  async placeSkill(host: RemoteHost, def: AgentDef, home: string, w: Welcome): Promise<void> {
    if (process.env.TALKCODE_NO_SKILL_LINK) return;
    const base = `${w.home}/.talkcode/remote/${w.version}`;
    const key = `${host.id}@${w.version}@${w.instance}`;
    const homes = skillHomes(def.harness, home, def.command);
    try {
      if (!this.skillPlaced.has(key)) {
        if (homes.length > 0) {
          for (const skill of BUNDLED_SKILLS) {
            const source = bundledSkillDir(skill.dir);
            for (const rel of listFiles(source)) {
              await host.writeFile(`${base}/${skill.dir}/${rel}`, fs.readFileSync(path.join(source, rel)), 0o644);
            }
          }
        }
        for (const dir of allSkillDirs(home)) {
          for (const link of await host.sweepSkillLinks(dir)) console.log(`[skill] ${host.id}: removed dead link ${link}`);
        }
        this.skillPlaced.add(key);
      }
      for (const skill of BUNDLED_SKILLS) {
        const target = `${base}/${skill.dir}`;
        for (const h of homes) {
          const r = await host.ensureLink(target, `${h.dir}/${skill.name}`, h.requires);
          if (r.outcome === 'linked' || r.outcome === 'relinked') console.log(`[skill] ${host.id}: linked ${r.link} → ${target}`);
          else if (r.outcome === 'occupied' || r.outcome === 'failed') console.warn(`[skill] ${host.id}: ${r.link}: ${r.outcome} (${r.detail ?? ''})`);
        }
      }
    } catch (e) {
      console.warn(`[skill] ${host.id}: could not place the skill:`, e instanceof Error ? e.message : e);
    }
  }

  /**
   * Put the operator's instructions where `def`'s harness reads them on the host — the remote twin
   * of instructions.ts placeInstructions, which says where and under what rules. The text is
   * composed HERE, from this gateway's `instructions/` directory, and the host only receives the
   * result: one copy of the operator's words, wherever the agents run.
   *
   * Settled outcomes are remembered per host, daemon instance and file, so an unchanged text costs
   * no round trip on the next spawn; a new remote daemon (an upgrade, a restart) places it again.
   * What is not settled — a real file in the way, a failure — is tried again at the next spawn, and
   * warned about once. Best-effort like the skill.
   */
  async placeInstructions(host: RemoteHost, def: AgentDef, home: string, w: Welcome): Promise<void> {
    if (process.env.TALKCODE_NO_SKILL_LINK) return;
    const where = instructionsHome(def.harness, home, def.command);
    if (!where) return;
    const key = `${host.id}@${w.instance}@${where.file}`;
    try {
      const composed = composeInstructions(instructionsDir(), where.name);
      const state = composed.kind === 'text' ? createHash('sha256').update(composed.text).digest('hex') : composed.kind;
      if (this.instructionsPlaced.get(key) === state) return;
      const owned = ownedDir(home);
      let r: InstructionsResult;
      if (composed.kind === 'none') {
        r = (await host.removeLink(where.file, owned)) as InstructionsResult;
      } else if (composed.kind === 'too-big') {
        r = { link: where.file, outcome: 'too-big', detail: `${composed.bytes} bytes, over the ${INSTRUCTIONS_MAX_BYTES}-byte limit` };
      } else {
        const copy = path.join(owned, `${where.name}.md`);
        await host.writeFile(copy, Buffer.from(composed.text, 'utf8'), 0o444, { atomic: true });
        r = (await host.ensureLink(copy, where.file, where.requires, owned)) as InstructionsResult;
      }
      reportInstructions(r, host.id);
      if (SETTLED.has(r.outcome)) this.instructionsPlaced.set(key, state);
    } catch (e) {
      reportInstructions({ link: where.file, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) }, host.id);
    }
  }

  /**
   * Run one `talkcode …` an agent on a host invoked, as this gateway's own CLI — the same program a
   * local agent's command runs, so parsing, validation and output are the same — with the turn
   * token the agent holds, this daemon's socket, and the agent's directory and home, which is what
   * its relative and `~` paths mean (commands/reverse.ts resolvePathArg).
   */
  private runCli(req: Parameters<CliBridge>[0], io: Parameters<CliBridge>[1]): CliSession {
    const refuse = (message: string): CliSession => {
      io.out(2, Buffer.from(`talkcode: ${message}\n`));
      io.exit(2);
      return { write: () => {}, end: () => {}, kill: () => {} };
    };
    const self = selfInvocation();
    if (!self) return refuse('this gateway is not running as the talkcode CLI, so it cannot run reverse commands');
    if (!isBridgedCommand(req.argv)) {
      return refuse(`"${req.argv[0] ?? ''}" is not a command an agent can run here; \`talkcode help\` lists them`);
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      TALKCODE_TURN_TOKEN: req.token,
      TALKCODE_SOCKET: this.socketPath,
      TALKCODE_CWD: req.env.TALKCODE_CWD || req.cwd,
      TALKCODE_REMOTE_HOME: req.host.conn.welcome?.home || '/',
      TALKCODE_REMOTE_HOST: req.host.id,
    };
    if (req.env.TALKCODE_IPC_TIMEOUT_MS) env.TALKCODE_IPC_TIMEOUT_MS = req.env.TALKCODE_IPC_TIMEOUT_MS;
    const child = spawn(self.command, [...self.args, ...req.argv], { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => io.out(1, d));
    child.stderr.on('data', (d: Buffer) => io.out(2, d));
    child.stdin.on('error', () => {}); // the command finished without reading what was piped to it
    child.on('error', (e) => {
      io.out(2, Buffer.from(`talkcode: ${e.message}\n`));
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

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** The daemon's registry (see the header for why it is module-level). */
export const remoteHosts = new RemoteHosts();
