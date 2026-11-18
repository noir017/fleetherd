import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
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
 * Writes are here too, as of the file editor: `writeFile` is the one write an editor may use,
 * because replacing a file an agent may be editing at the same moment needs more than either side's
 * plain write — a version check, the file's mode and its symlink kept. Both halves implement the
 * same three rules, and `workspace.test.ts` holds them to it.
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
  /** Permission bits, when the machine reports them (both halves do). */
  mode?: number;
}

/**
 * What a write expects to find, from the last read. A mismatch is a conflict, not an error: the
 * page offers reload, overwrite or cancel, which needs an answer it can tell apart from a failure.
 *
 * `missing: true` is the create case — the file must not be there, or another tab (or the agent)
 * got there first.
 */
export interface WorkspaceWriteExpect {
  mtimeMs?: number;
  size?: number;
  missing?: boolean;
  /** Overwrite whatever is there — the person's answer to a conflict. Skips only the version check. */
  force?: boolean;
}

/** What a write answered: the file as it now is, so the editor's baseline moves with its save. */
export interface WorkspaceWriteResult {
  mtimeMs: number;
  size: number;
}

/**
 * A write refused because the file changed since it was read. Its own class so a caller does not
 * have to read a message: the page's conflict dialog hangs off exactly this.
 */
export class WorkspaceConflictError extends Error {
  constructor(
    message: string,
    /** What the file is now; `false` when it is gone. */
    readonly exists: boolean,
    readonly size?: number,
    readonly mtimeMs?: number
  ) {
    super(message);
    this.name = 'WorkspaceConflictError';
  }
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
  /**
   * Replace a file atomically, if it is still what `expect` says: a temporary beside it, fsynced,
   * then renamed over it. A symlink is followed and the file it points at is written — the link
   * stays a link. The file's permission bits are kept; a new file gets the umask's default.
   *
   * Throws `WorkspaceConflictError` for a stale expectation, and an ordinary error for anything
   * else (no such directory, permission denied).
   */
  writeFile(p: string, data: Uint8Array, expect: WorkspaceWriteExpect): Promise<WorkspaceWriteResult>;
  /** Make a directory and every parent it needs. */
  mkdirp(p: string): Promise<void>;
  /**
   * Move one entry; refuses to overwrite another. `owned` is the root the move must stay inside
   * (default: this workspace's root) — the editor can be pointed at extra roots.
   */
  rename(from: string, to: string, owned?: string): Promise<void>;
  /** Delete one file or one empty directory — never a tree. Stays inside `owned`, as `rename` does. */
  remove(p: string, owned?: string): Promise<void>;
}

/** The workspace of an agent's conversation that works in `root`, on the agent's machine. */
export function workspaceFor(def: AgentDef, root: string): Workspace {
  const host = remoteHosts.hostFor(def);
  return host ? remoteWorkspace(host, root) : localWorkspace(root);
}

type HostOps = Pick<
  RemoteHost,
  'id' | 'run' | 'stat' | 'listDir' | 'readFile' | 'editWrite' | 'mkdirp' | 'renameEntry' | 'removeEntry'
>;

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
    async writeFile(p, data, expect) {
      const r = await host.editWrite(p, data, expect);
      if (r.ok) return { mtimeMs: r.mtimeMs, size: r.size };
      throw new WorkspaceConflictError(
        `${p} changed since it was read`,
        r.exists,
        r.size,
        r.mtimeMs
      );
    },
    mkdirp: (p) => host.mkdirp(p),
    rename: (from, to, owned = root) => host.renameEntry(from, to, owned),
    remove: (p, owned = root) => host.removeEntry(p, owned),
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
        return {
          exists: true,
          dir: st.isDirectory(),
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
          mode: st.mode & 0o777,
        };
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
    /**
     * The same three rules the host keeps (remote/ops.go opEditWrite), because the editor must not
     * behave differently on the two machines it can be pointed at: through the link, keep the mode,
     * refuse a stale version. A local write has one extra thing to be careful of — `fs.rename`
     * replaces whatever is at the destination, including a symlink — so the target is resolved
     * first, exactly as the host resolves it.
     */
    async writeFile(p, data, expect) {
      const target = await resolveThroughLink(p);
      const before = await statOrNull(target);
      if (before?.isDirectory()) throw new Error(`${p} is a directory`);
      if (expect.missing) {
        if (before && !expect.force) {
          throw new WorkspaceConflictError(`${p} already exists`, true, before.size, Math.trunc(before.mtimeMs));
        }
      } else if (!expect.force) {
        if (!before) throw new WorkspaceConflictError(`${p} is gone`, false);
        if (before.size !== expect.size || Math.trunc(before.mtimeMs) !== expect.mtimeMs) {
          throw new WorkspaceConflictError(`${p} changed since it was read`, true, before.size, Math.trunc(before.mtimeMs));
        }
      }
      const dir = path.dirname(target);
      const di = await statOrNull(dir);
      if (!di?.isDirectory()) throw new Error(`${dir} is not a directory`);
      const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomUUID().slice(0, 12)}`);
      // `wx` is O_CREATE|O_EXCL: a collision is an error rather than two writers sharing a temp.
      // 0o666 rather than 0o600, so the umask decides what a new file gets, as it does for any
      // file the person creates; an existing file's mode is put back below.
      const fh = await fs.promises.open(tmp, 'wx', 0o666);
      try {
        await fh.writeFile(data);
        if (before) await fh.chmod(before.mode & 0o777);
        await fh.sync();
      } catch (e) {
        await fh.close().catch(() => {});
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
      await fh.close();
      try {
        await fs.promises.rename(tmp, target);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
      const after = await fs.promises.stat(target);
      return { mtimeMs: Math.trunc(after.mtimeMs), size: after.size };
    },
    async mkdirp(p) {
      await fs.promises.mkdir(p, { recursive: true, mode: 0o755 });
    },
    async rename(from, to, owned = root) {
      if (!withinOwned(from, owned) || !withinOwned(to, owned)) {
        throw new Error(`refusing to rename ${from} to ${to}: not both under ${owned}`);
      }
      await fs.promises.lstat(from);
      try {
        await fs.promises.lstat(to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        await fs.promises.rename(from, to);
        return;
      }
      throw new Error(`refusing to rename ${from} to ${to}: something is already there`);
    },
    async remove(p, owned = root) {
      if (!withinOwned(p, owned)) throw new Error(`refusing to remove ${p}: not under ${owned}`);
      const st = await fs.promises.lstat(p); // lstat: a link goes, its target stays
      if (st.isDirectory()) await fs.promises.rmdir(p);
      else await fs.promises.unlink(p);
    },
  };
}

/** `p` itself if it is not a symlink, and the file it points at if it is. */
async function resolveThroughLink(p: string): Promise<string> {
  let st;
  try {
    st = await fs.promises.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return p;
    throw e;
  }
  // A link whose target is gone fails here, as it does on the host: writing through it would
  // otherwise replace the link with a regular file, which is the one thing this write must not do.
  return st.isSymbolicLink() ? fs.promises.realpath(p) : p;
}

async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Strictly inside — the same rule the host's `within` applies, so both refuse alike. */
function withinOwned(p: string, owned: string): boolean {
  const clean = path.resolve(p);
  const base = path.resolve(owned);
  return clean.startsWith(base + path.sep);
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
