import { EventEmitter } from 'node:events';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { HostConnection, type RemoteArch, type RemoteBinary, type Transport, type Welcome } from './connection.js';
import type { FrameHeader } from './frame.js';

/**
 * A remote host as the daemon sees it: start processes there, read and write its files, run
 * commands — the things the gateway does on its own disk for a local agent, over one reliable link
 * (connection.ts). See remote/README.md for the protocol underneath.
 *
 * Every call works the same whether the link is up or down at that moment: requests queue and are
 * delivered on reconnect, and a process keeps running on the host meanwhile. The one exception is a
 * host this gateway has never reached: the first request then waits for that first connection, and
 * fails with its reason if it cannot be made — a typo in an address should say so, not hang.
 */

/** Stdin and command output are framed in pieces of at most this, so one big write (a prompt with a
 *  picture in it) cannot hold up everything else sharing the link. */
const CHUNK = 1 << 20;
/** Files cross in pieces of this (a frame body is capped at 16 MiB). */
const FILE_CHUNK = 8 << 20;

export interface SpawnOptions {
  cwd?: string;
  /** Set on top of the host's login environment (NOT the gateway's — see remote/shellenv.go). */
  env?: Record<string, string | undefined>;
  unset?: string[];
  /** A fourth pipe, as agy's status line uses (agy-statusline.ts). */
  fd3?: boolean;
}

export interface RunOptions {
  argv?: string[];
  /** Run as `bash -lc <bash>` instead of argv — the shape of a hook or a scheduled `--bash` task. */
  bash?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  unset?: string[];
  timeoutMs?: number;
  /** Interleave stderr into the output, as a log file would have it. */
  merge?: boolean;
  /** Keep at most this much output — its end. */
  max?: number;
}

export interface RunResult {
  code: number | null;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  spawnError?: string;
  stderr?: string;
  output: Buffer;
}

export interface CliRequest {
  argv: string[];
  /** The directory the agent ran `talkcode` in, on the host. */
  cwd: string;
  token: string;
  /** TALKCODE_CWD / TALKCODE_IPC_TIMEOUT_MS from the caller's environment, when set. */
  env: Record<string, string>;
  host: RemoteHost;
}

export interface CliIO {
  out(fd: 1 | 2, data: Buffer): void;
  exit(code: number): void;
}

export interface CliSession {
  write(data: Buffer): void;
  end(): void;
  kill(): void;
}

/**
 * Runs a reverse command an agent on the host invoked (its `talkcode …`, or the native-tools server
 * `talkcode mcp`). Supplied by the daemon, which owns the CLI it runs it with.
 */
export type CliBridge = (req: CliRequest, io: CliIO) => CliSession;

export interface RemoteHostOptions {
  id: string;
  ns: string;
  epoch: string;
  transport: Transport;
  binary(arch: RemoteArch): RemoteBinary | undefined;
  cli?: CliBridge;
}

interface PendingRpc {
  resolve(v: { res: Record<string, unknown>; body: Buffer }): void;
  reject(e: Error): void;
  /** On the link yet — until then it is in `unsent`, and no daemon has heard of it. */
  sent: boolean;
}

export class RemoteHost extends EventEmitter {
  readonly conn: HostConnection;
  private readonly children = new Map<string, RemoteChild>();
  private readonly rpcs = new Map<string, PendingRpc>();
  private readonly clis = new Map<string, CliSession>();
  /** New processes and requests waiting for a connection to go out on (see whenUp). */
  private readonly unsent: Array<() => void> = [];
  private seq = 0;

  constructor(private readonly opts: RemoteHostOptions) {
    super();
    this.conn = new HostConnection(
      { hostId: opts.id, ns: opts.ns, transport: opts.transport, binary: (a) => opts.binary(a) },
      opts.epoch
    );
    this.conn.on('frame', (h: FrameHeader, body: Buffer) => this.onFrame(h, body));
    this.conn.on('reset', () => this.onReset());
    this.conn.on('down', (reason: string) => this.emit('down', reason));
    this.conn.on('up', (resumed: boolean) => {
      for (const send of this.unsent.splice(0)) send();
      this.emit('up', resumed);
    });
  }

  /**
   * Put a new process or request on the link: now if a connection is up, else once one is.
   *
   * Not queued in the link meanwhile, the way the frames of something already running are. A
   * connection that comes back to a daemon that restarted (`reset`) has to fail everything the old
   * one was given, and the link cannot tell what that was from what nobody has seen yet — so the
   * request that set off the reconnect was failed as "restarted" too. That is every request after a
   * quiet spell: the gateway closes an idle connection, the host's daemon exits ten minutes later,
   * and the next one finds a new daemon. Its first casualty was the directory listing behind a bare
   * `/cc`, which then answered without its menu (2026-10-30).
   */
  private whenUp(send: () => void): void {
    if (this.conn.isUp) send();
    else this.unsent.push(send);
  }

  get id(): string {
    return this.opts.id;
  }

  get isUp(): boolean {
    return this.conn.isUp;
  }

  ready(): Promise<Welcome> {
    return this.conn.ready();
  }

  /** Where things are on the host; needs its welcome (ready()). */
  paths(w: Welcome): { binDir: string; shim: string; socket: string; home: string } {
    const root = `${w.home}/.talkcode/remote`;
    const binDir = `${root}/${w.version}/bin`;
    return { binDir, shim: `${binDir}/talkcode`, socket: `${root}/run/${this.opts.ns}/daemon.sock`, home: w.home };
  }

  close(): void {
    this.conn.close();
  }

  // ── processes ───────────────────────────────────────────────────────────────────────────────

  /**
   * Start `command` on the host. Returns at once with a child_process-shaped handle; a failure to
   * start (no such command, an unreachable host on first contact) arrives as its `error` + `exit`,
   * the way a local spawn reports ENOENT.
   */
  spawn(command: string, args: string[], opts: SpawnOptions = {}): RemoteChild {
    this.seq += 1;
    const id = `p${this.seq}`;
    const child = new RemoteChild(this, id, opts.fd3 === true);
    this.children.set(id, child);
    this.conn.hold();
    const open = (): void =>
      this.whenUp(() =>
        child.open({ t: 'spawn', id, cmd: command, args, cwd: opts.cwd, env: definedOnly(opts.env), unset: opts.unset, fd3: opts.fd3 })
      );
    if (this.conn.welcome) open();
    else this.conn.ready().then(open, (e: Error) => this.finishChild(id, null, null, e.message));
    return child;
  }

  /** @internal — RemoteChild's way onto the link. */
  sendFrame(h: FrameHeader, body?: Uint8Array): void {
    this.conn.send(h, body);
  }

  private finishChild(id: string, code: number | null, signal: string | null, error?: string): void {
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    this.conn.release();
    child.exited(code, signal, error);
  }

  // ── operations ──────────────────────────────────────────────────────────────────────────────

  /**
   * One operation on the host. `timeoutMs` bounds the whole wait — including an outage — for
   * callers with a person waiting on a menu; the operation is cancelled on the host if it ran out.
   */
  async rpc(
    op: string,
    fields: Omit<FrameHeader, 't' | 'op' | 'rid'> = {},
    body?: Uint8Array,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ res: Record<string, unknown>; body: Buffer }> {
    if (!this.conn.welcome) await this.conn.ready();
    this.seq += 1;
    const rid = `r${this.seq}`;
    this.conn.hold();
    const settled = new Promise<{ res: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
      this.rpcs.set(rid, { resolve, reject, sent: false });
    });
    this.whenUp(() => {
      const p = this.rpcs.get(rid);
      if (!p) return; // timed out or cancelled while it waited
      p.sent = true;
      this.conn.send({ ...fields, t: 'rpc', op, rid }, body);
    });
    const cancel = (why: string): void => {
      const p = this.rpcs.get(rid);
      if (!p) return;
      this.rpcs.delete(rid);
      this.conn.release();
      if (p.sent) this.conn.send({ t: 'rpc-cancel', rid });
      p.reject(new Error(why));
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => cancel(`${op} on host "${this.id}" took longer than ${opts.timeoutMs}ms`), opts.timeoutMs)
        : undefined;
    const onAbort = (): void => cancel(`${op} on host "${this.id}" was cancelled`);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await settled;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async stat(path: string, timeoutMs?: number): Promise<{ exists: boolean; dir?: boolean; size?: number; mtimeMs?: number }> {
    const { res } = await this.rpc('stat', { path }, undefined, { timeoutMs });
    return res as { exists: boolean; dir?: boolean; size?: number; mtimeMs?: number };
  }

  async listDir(path: string, timeoutMs?: number): Promise<Array<{ name: string; dir: boolean }>> {
    const { res } = await this.rpc('listDir', { path }, undefined, { timeoutMs });
    return (res.entries as Array<{ name: string; dir: boolean }> | undefined) ?? [];
  }

  async mkdirp(path: string, mode?: number): Promise<void> {
    await this.rpc('mkdirp', { path, mode });
  }

  /** Read a whole file, refusing one larger than `maxBytes`. */
  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { res, body } = await this.rpc('readFile', { path, offset, max: FILE_CHUNK });
      const size = Number(res.size ?? 0);
      if (size > maxBytes) throw new Error(`${path} is ${size} bytes, over the ${maxBytes}-byte limit`);
      parts.push(body);
      offset += body.length;
      if (offset >= size || body.length === 0) break;
    }
    return Buffer.concat(parts);
  }

  /**
   * The last `max` bytes of a file as whole lines — only those containing one of `grep`, and each
   * JSON line cut down to `fields` (dotted paths), when given. Both filters run on the host, so only
   * what is kept crosses the link.
   */
  async readTail(path: string, max: number, opts: { grep?: string[]; fields?: string[]; timeoutMs?: number } = {}): Promise<string> {
    const { body } = await this.rpc('readTail', { path, max, grep: opts.grep, fields: opts.fields }, undefined, {
      timeoutMs: opts.timeoutMs,
    });
    return body.toString('utf8');
  }

  async writeFile(path: string, data: Uint8Array, mode?: number): Promise<void> {
    if (data.length === 0) {
      await this.rpc('writeFile', { path, mode }, data);
      return;
    }
    for (let off = 0; off < data.length; off += FILE_CHUNK) {
      await this.rpc('writeFile', { path, mode, append: off > 0 }, data.subarray(off, off + FILE_CHUNK));
    }
  }

  async ensureLink(target: string, link: string, requires: string): Promise<{ outcome: string; detail?: string; link: string }> {
    const { res } = await this.rpc('ensureLink', { target, path: link, requires });
    return res as { outcome: string; detail?: string; link: string };
  }

  /**
   * Remove skill links of ours under `dir` that point into a version directory this host no longer
   * has (remote/ops.go sweepSkillLinks). Only symlinks into `~/.talkcode/remote` are touched; a
   * real directory or a link pointing anywhere else is the operator's and stays. Answers with what
   * it removed, so the gateway can say so.
   */
  async sweepSkillLinks(dir: string): Promise<string[]> {
    const { res } = await this.rpc('sweepSkillLinks', { path: dir });
    return (res as { removed?: string[] }).removed ?? [];
  }

  async run(o: RunOptions, signal?: AbortSignal): Promise<RunResult> {
    const { res, body } = await this.rpc(
      'run',
      { argv: o.argv, bash: o.bash, cwd: o.cwd, env: definedOnly(o.env), unset: o.unset, timeoutMs: o.timeoutMs, merge: o.merge, max: o.max },
      undefined,
      { signal }
    );
    return { ...(res as Omit<RunResult, 'output'>), code: (res.code as number | null | undefined) ?? null, output: body };
  }

  // ── frames from the host ────────────────────────────────────────────────────────────────────

  /** Every frame type the host sends, and what becomes of it. */
  private readonly handlers: Record<string, (h: FrameHeader, body: Buffer) => void> = {
    spawned: (h) => this.children.get(h.id ?? '')?.spawned(h.pid ?? 0),
    out: (h, body) => this.children.get(h.id ?? '')?.output(h.fd ?? 1, body),
    exit: (h) => this.finishChild(h.id ?? '', h.code ?? null, h.signal ?? null, h.error),
    'rpc-ok': (h, body) => this.settleRpc(h, body),
    'rpc-err': (h, body) => this.settleRpc(h, body),
    'cli-open': (h) => this.openCli(h),
    'cli-in': (h, body) => this.clis.get(h.cid ?? '')?.write(body),
    'cli-in-end': (h) => this.clis.get(h.cid ?? '')?.end(),
    'cli-gone': (h) => {
      const s = this.clis.get(h.cid ?? '');
      if (!s) return;
      this.clis.delete(h.cid ?? '');
      this.conn.release();
      s.kill();
    },
  };

  private onFrame(h: FrameHeader, body: Buffer): void {
    const handle = this.handlers[h.t];
    if (handle) handle(h, body);
    else console.debug(`[remote] ${this.id}: ignoring frame ${h.t}`);
  }

  private settleRpc(h: FrameHeader, body: Buffer): void {
    const p = this.rpcs.get(h.rid ?? '');
    if (!p) return;
    this.rpcs.delete(h.rid ?? '');
    this.conn.release();
    if (h.t === 'rpc-ok') p.resolve({ res: (h.res as Record<string, unknown> | undefined) ?? {}, body });
    else p.reject(new Error(h.error ?? 'operation failed'));
  }

  private openCli(h: FrameHeader): void {
    const cid = h.cid ?? '';
    let open = true;
    const io: CliIO = {
      out: (fd, data) => {
        if (!open) return;
        for (let off = 0; off < data.length; off += CHUNK) {
          this.conn.send({ t: 'cli-out', cid, fd }, data.subarray(off, off + CHUNK));
        }
      },
      exit: (code) => {
        if (!open) return;
        open = false;
        this.conn.send({ t: 'cli-exit', cid, code });
        if (this.clis.delete(cid)) this.conn.release();
      },
    };
    if (!this.opts.cli) {
      this.conn.send({ t: 'cli-out', cid, fd: 2 }, Buffer.from('talkcode: reverse commands are not available on this gateway\n'));
      this.conn.send({ t: 'cli-exit', cid, code: 1 });
      return;
    }
    this.conn.hold();
    const session = this.opts.cli(
      { argv: h.argv ?? [], cwd: h.cwd ?? '', token: h.token ?? '', env: h.env ?? {}, host: this },
      io
    );
    if (open) this.clis.set(cid, session);
  }

  /**
   * The host's daemon came back without our state: everything started through it is gone. What is
   * still waiting in `unsent` was never given to it, and goes to the new one instead (whenUp).
   */
  private onReset(): void {
    const gone = [...this.children].filter(([, c]) => c.isOpen).map(([id]) => id);
    const lost = [...this.rpcs].filter(([, p]) => p.sent);
    if (gone.length > 0 || lost.length > 0) {
      console.warn(`[remote] ${this.id}: talkcode-remote restarted; ${gone.length} process(es) on it are gone`);
    }
    for (const id of gone) this.finishChild(id, null, 'SIGKILL');
    for (const [rid, p] of lost) {
      this.rpcs.delete(rid);
      this.conn.release();
      p.reject(new Error(`talkcode-remote on host "${this.id}" restarted`));
    }
    for (const [cid, s] of [...this.clis]) {
      this.clis.delete(cid);
      this.conn.release();
      s.kill();
    }
  }
}

/**
 * A process on a remote host, shaped like the parts of node's ChildProcess the runtimes use:
 * stdin/stdout/stderr (and stdio[3]), `exit`/`error` events, exitCode/signalCode, kill().
 */
export class RemoteChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio: [Writable, Readable, Readable, Readable | null];
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private opened = false;
  private done = false;
  /** Frames written before the spawn itself was sent (first contact, or a connection, still to come). */
  private early: Array<{ h: FrameHeader; body?: Buffer }> = [];

  constructor(private readonly host: RemoteHost, readonly id: string, fd3: boolean) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        for (let off = 0; off < chunk.length; off += CHUNK) this.send({ t: 'stdin', id }, chunk.subarray(off, off + CHUNK));
        cb();
      },
      final: (cb) => {
        this.send({ t: 'stdin-end', id });
        cb();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr, fd3 ? new PassThrough() : null];
  }

  /** @internal — its `spawn` is on the link, so a daemon that restarted took it down. */
  get isOpen(): boolean {
    return this.opened;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.done) return false;
    const sig = typeof signal === 'number' ? 'SIGTERM' : signal;
    this.send({ t: 'signal', id: this.id, sig });
    return true;
  }

  private send(h: FrameHeader, body?: Buffer): void {
    if (this.done) return;
    if (!this.opened) {
      this.early.push({ h, body });
      return;
    }
    this.host.sendFrame(h, body);
  }

  /** @internal */
  open(spawn: FrameHeader): void {
    if (this.done || this.opened) return;
    this.opened = true;
    this.host.sendFrame(spawn);
    for (const f of this.early.splice(0)) this.host.sendFrame(f.h, f.body);
  }

  /** @internal */
  spawned(pid: number): void {
    this.pid = pid;
    this.emit('spawn');
  }

  /** @internal */
  output(fd: number, body: Buffer): void {
    if (this.done) return;
    const stream = fd === 2 ? this.stderr : fd === 3 ? this.stdio[3] : this.stdout;
    (stream as PassThrough | null)?.write(body);
  }

  /** @internal */
  exited(code: number | null, signal: string | null, error?: string): void {
    if (this.done) return;
    this.done = true;
    this.early = [];
    if (error) {
      const err = Object.assign(new Error(error), { code: /not found/i.test(error) ? 'ENOENT' : 'EREMOTE' });
      this.emit('error', err);
    }
    this.exitCode = error ? (code ?? -2) : code;
    this.signalCode = (signal as NodeJS.Signals | null) ?? null;
    this.stdout.end();
    this.stderr.end();
    (this.stdio[3] as PassThrough | null)?.end();
    this.emit('exit', this.exitCode, this.signalCode);
    this.emit('close', this.exitCode, this.signalCode);
  }
}

function definedOnly(env?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
