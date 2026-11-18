import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import type { RemoteHost } from '../remote/host.js';
import { remoteHosts } from './remote-hosts.js';

/**
 * A conversation's files, as the web UI's workspace windows reach them — its git status and diffs,
 * a file tree, an editor — on whichever machine the conversation's agent runs.
 *
 * ── Why one interface for two machines ─────────────────────────────────────
 * On the reference deployment every agent is on a remote host; on a default install every agent is
 * local. A window that asked which would be written twice and tested once. What the windows need —
 * run a command in a directory, stat, list, read — is a subset RemoteHost already offers over its
 * link (remote/ops.go), so the local half is that subset done with node:fs and child_process, made
 * to answer the way the host does, edge cases included: a listing follows symlinks and skips broken
 * ones (opListDir), a read over the limit is refused rather than cut, and command output past the
 * cap keeps its END (the host's ring buffer) and says it was truncated. Code above this line never
 * learns which machine it is talking to.
 *
 * Writes are not here yet: the editor brings its own, because replacing a file an agent may be
 * editing at the same moment needs more than either side's plain write (a version check, the file's
 * mode and its symlink kept), and that is the editor's design to make.
 */

/** Output kept from one command when the caller names no cap — the host's own default (ops.go). */
export const DEFAULT_RUN_MAX = 1 << 20;
/** A command that has not finished by then is killed: a window waiting on it would hang with it. */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;
/** Stderr kept from a command, from its end — the host's own cap (ops.go). */
const STDERR_MAX = 64 << 10;

export interface WorkspaceRunOptions {
  /** Where the command runs; the workspace root when absent. */
  cwd?: string;
  timeoutMs?: number;
  /** Keep at most this much output — its END, as the host keeps it. */
  maxBytes?: number;
  /** Set on top of the environment the command would otherwise get on that machine. */
  env?: Record<string, string>;
  stdin?: Buffer | string;
}

export interface WorkspaceRunResult {
  code: number | null;
  output: Buffer;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Why the command never ran at all — not found, a missing directory. */
  spawnError?: string;
}

export interface WorkspaceStat {
  exists: boolean;
  dir?: boolean;
  size?: number;
  mtimeMs?: number;
}

export interface Workspace {
  /** `local`, or the id of the remote host the files are on. */
  readonly host: string;
  /** The conversation's working directory, absolute on that machine (a remote one may start `~`). */
  readonly root: string;
  /** Run argv — never a shell string — and collect its output. Never throws for a failed command. */
  run(argv: readonly string[], o?: WorkspaceRunOptions): Promise<WorkspaceRunResult>;
  stat(p: string): Promise<WorkspaceStat>;
  /** A directory's entries, each typed after following symlinks; broken links are left out. */
  listDir(p: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** A whole file; throws for one larger than `maxBytes` rather than handing back part of it. */
  readFile(p: string, maxBytes: number): Promise<Buffer>;
}

/** The workspace of an agent's conversation that works in `root`, on the agent's machine. */
export function workspaceFor(def: AgentDef, root: string): Workspace {
  const host = remoteHosts.hostFor(def);
  return host ? remoteWorkspace(host, root) : localWorkspace(root);
}

type HostOps = Pick<RemoteHost, 'id' | 'run' | 'stat' | 'listDir' | 'readFile'>;

export function remoteWorkspace(host: HostOps, root: string): Workspace {
  return {
    host: host.id,
    root,
    async run(argv, o = {}) {
      const r = await host.run({
        argv: [...argv],
        cwd: o.cwd ?? root,
        env: o.env,
        stdin: o.stdin,
        timeoutMs: o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        max: o.maxBytes ?? DEFAULT_RUN_MAX,
      });
      return {
        code: r.code,
        output: r.output,
        stderr: r.stderr ?? '',
        truncated: r.truncated === true,
        timedOut: r.timedOut === true,
        ...(r.spawnError ? { spawnError: r.spawnError } : {}),
      };
    },
    stat: (p) => host.stat(p),
    listDir: (p) => host.listDir(p),
    readFile: (p, maxBytes) => host.readFile(p, maxBytes),
  };
}

export function localWorkspace(root: string): Workspace {
  return {
    host: 'local',
    root,
    run: (argv, o = {}) => runLocal(argv, { ...o, cwd: o.cwd ?? root }),
    async stat(p) {
      try {
        const st = await fs.promises.stat(p);
        return { exists: true, dir: st.isDirectory(), size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
        throw e;
      }
    },
    async listDir(p) {
      const names = await fs.promises.readdir(p);
      const out: Array<{ name: string; dir: boolean }> = [];
      for (const name of names) {
        try {
          out.push({ name, dir: (await fs.promises.stat(path.join(p, name))).isDirectory() });
        } catch {
          // A broken link, or gone since the listing — the host skips it too.
        }
      }
      return out;
    },
    async readFile(p, maxBytes) {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) throw new Error(`${p} is a directory`);
      if (st.size > maxBytes) throw new Error(`${p} is ${st.size} bytes, over the ${maxBytes}-byte limit`);
      return fs.promises.readFile(p);
    },
  };
}

/** Keeps the last `max` bytes written to it — the host's ring (ops.go), so both sides cut alike. */
class Tail {
  private parts: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(b: Buffer): void {
    this.parts.push(b);
    this.size += b.length;
    while (this.size > this.max && this.parts.length > 0) {
      const head = this.parts[0] as Buffer;
      const over = this.size - this.max;
      this.truncated = true;
      if (head.length <= over) {
        this.parts.shift();
        this.size -= head.length;
      } else {
        this.parts[0] = head.subarray(over);
        this.size -= over;
      }
    }
  }
  get(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function runLocal(argv: readonly string[], o: WorkspaceRunOptions): Promise<WorkspaceRunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: false, spawnError: 'empty argv' });
  return new Promise((resolve) => {
    const out = new Tail(o.maxBytes ?? DEFAULT_RUN_MAX);
    const err = new Tail(STDERR_MAX);
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    // A child that exits before reading all of its stdin would otherwise fail the promise with EPIPE.
    child.stdin?.on('error', () => {});
    if (o.stdin !== undefined) child.stdin?.end(o.stdin);
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: spawnError ? null : code,
        output: out.get(),
        stderr: err.get().toString('utf8'),
        truncated: out.truncated,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}
