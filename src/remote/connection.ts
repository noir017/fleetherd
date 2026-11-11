import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { FrameDecoder, encodeFrame, type Frame, type FrameHeader } from './frame.js';
import { ReliableLink, type LinkTransport } from './link.js';

/**
 * One gateway's connection to one remote host: the ssh process, the install of talkcode-remote,
 * the handshake, the heartbeat, and reconnecting — everything below "send this frame, deliver me
 * those". The reliable link (link.ts) rides on top and survives every reconnect; RemoteHost
 * (host.ts) is what the daemon talks to.
 *
 * ── A connection, step by step ───────────────────────────────────────────────────────────────
 * The transport runs one POSIX `sh` script on the host (bootstrapScript). It picks this gateway's
 * build for the host's architecture and runs `talkcode-remote attach`, which prints TCR-READY and
 * turns the connection into frames. If the build is not installed (TCR-NEED) or is not the bytes
 * this gateway carries (attach prints TCR-BADSUM, the script then TCR-NEED), the gateway uploads
 * it over a second transport and tries again. Then: `hello` → `welcome`, and the link resends
 * whatever the other side has not seen.
 *
 * ── Down is not dead ─────────────────────────────────────────────────────────────────────────
 * When the ssh process exits or the host stops answering pings, the connection is DOWN: frames
 * keep queueing in the link, the agents on the host keep running, and reconnect attempts back off
 * from 1s to 30s for as long as anything is still using the host. `down` and `up` events let the
 * daemon tell a waiting user what is happening. Only `reset` means loss: the host came back
 * WITHOUT our state (its daemon restarted), so every process started through it is gone.
 */

export const PROTO_VERSION = 1;

/**
 * Heartbeat: a ping this often, and the connection is dead after this long with nothing heard.
 * Raised from 15s to 30s (2026-11-11): 15s was only 3 missed pings, and across a lossy cross-border
 * VPN link (Oracle to home LAN EasyTier with ~13% packet loss and Wi-Fi power-save sleep on a laptop),
 * brief bursts of dropped packets caused working connections to be dropped repeatedly.
 */
const PING_EVERY_MS = 5_000;
const DEAD_AFTER_MS = 30_000;
/**
 * One attempt, from starting ssh to `welcome` (starting the daemon included). Short, because a dead
 * route rarely fails fast: through a black hole the TCP connect succeeds and the ssh handshake then
 * waits forever, and every second spent on that attempt is a second the reconnect is late.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Copying the build to a host: ~4 MiB, so allow a slow link its minutes. */
const UPLOAD_TIMEOUT_MS = 180_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** With nothing using the host for this long, the connection is closed (the host's daemon stays). */
const IDLE_CLOSE_MS = 5 * 60_000;

export type RemoteArch = 'amd64' | 'arm64';

export interface RemoteBinary {
  path: string;
  sha256: string;
  /** Directory name on the host: package version + a prefix of the hash (see binaries.ts). */
  version: string;
}

export interface Welcome {
  version: string;
  instance: string;
  home: string;
  pid: number;
  os: string;
  arch: string;
  resumed: boolean;
}

/** Starts the process a connection rides on, running `script` on the host: ssh in production. */
export type Transport = (script: string) => ChildProcess;

export interface ConnectionOptions {
  hostId: string;
  /** This gateway's namespace on the host (see remote/paths.go). */
  ns: string;
  transport: Transport;
  binary(arch: RemoteArch): RemoteBinary | undefined;
}

type LaunchResult =
  | { kind: 'ready'; proc: ChildProcess; rest: Buffer }
  | { kind: 'need'; arch: string }
  | { kind: 'error'; message: string };

type State = 'idle' | 'connecting' | 'up' | 'down';

export class HostConnection extends EventEmitter {
  readonly link = new ReliableLink();
  /** This gateway process's epoch: a host that sees a different one starts from nothing. */
  readonly epoch: string;
  private state: State = 'idle';
  private proc: ChildProcess | undefined;
  private welcomeInfo: Welcome | undefined;
  private lastHeard = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private users = 0;
  private closed = false;
  private lastError: string | undefined;
  private waiters: Array<{ resolve: (w: Welcome) => void; reject: (e: Error) => void }> = [];
  private pingN = 0;

  constructor(private readonly opts: ConnectionOptions, epoch: string) {
    super();
    this.epoch = epoch;
  }

  get hostId(): string {
    return this.opts.hostId;
  }

  get isUp(): boolean {
    return this.state === 'up';
  }

  /** What the host said about itself the last time it answered; undefined before the first time. */
  get welcome(): Welcome | undefined {
    return this.welcomeInfo;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  /** Queue a sequenced frame: sent now if connected, or as soon as a connection is back. */
  send(h: FrameHeader, body?: Uint8Array): void {
    this.link.send(h, body);
  }

  /**
   * Something is using the host (a process, an operation): keep a connection, reconnect when it
   * drops. Every hold() is paired with a release().
   */
  hold(): void {
    this.users += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.state === 'idle') this.connectSoon(0);
  }

  release(): void {
    this.users = Math.max(0, this.users - 1);
    this.armIdle();
  }

  /** Close the connection after IDLE_CLOSE_MS with nothing using the host. */
  private armIdle(): void {
    if (this.users > 0 || this.idleTimer || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.users === 0) this.disconnect('idle', 'idle');
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  /**
   * The host's welcome, connecting first if this gateway has never reached it. A host reached before
   * answers at once — what it said then is still what paths are built from — while a first contact
   * that fails rejects with the reason (a wrong key, an unreachable address), so a user's first
   * message says why instead of waiting on a reconnect loop.
   */
  ready(): Promise<Welcome> {
    if (this.welcomeInfo) return Promise.resolve(this.welcomeInfo);
    return new Promise<Welcome>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (this.state === 'idle' || this.state === 'down') this.connectSoon(0);
    });
  }

  /** Close for good (daemon shutdown). The host's daemon is left running; its idle timer ends it. */
  close(): void {
    this.closed = true;
    this.disconnect('closed', 'idle');
    for (const w of this.waiters.splice(0)) w.reject(new Error(`connection to ${this.opts.hostId} closed`));
  }

  // ── connecting ──────────────────────────────────────────────────────────────────────────────

  private connectSoon(delayMs: number): void {
    if (this.closed || this.retryTimer || this.state === 'connecting' || this.state === 'up') return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.closed || this.state === 'connecting' || this.state === 'up') return;
    this.state = 'connecting';
    try {
      const { proc, rest } = await this.establish();
      if (this.closed) {
        proc.kill('SIGKILL');
        return;
      }
      await this.handshake(proc, rest);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.state = 'down';
      console.warn(`[remote] ${this.opts.hostId}: connection attempt failed: ${this.lastError}`);
      // A first contact reports its failure to whoever is waiting for it; later ones just retry.
      if (!this.welcomeInfo) {
        for (const w of this.waiters.splice(0)) w.reject(new Error(`cannot reach host "${this.opts.hostId}": ${this.lastError}`));
      }
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    if (this.users === 0 && this.waiters.length === 0) {
      this.state = 'idle';
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.connectSoon(delay);
  }

  /** Start the transport and get to TCR-READY, uploading the build when the host lacks it. */
  private async establish(): Promise<{ proc: ChildProcess; rest: Buffer }> {
    for (let round = 0; round < 3; round++) {
      const r = await this.launch(this.bootstrapScript());
      if (r.kind === 'ready') return r;
      if (r.kind === 'error') throw new Error(r.message);
      await this.upload(r.arch);
    }
    throw new Error('talkcode-remote was uploaded but the host still does not run it');
  }

  bootstrapScript(): string {
    const arm = (arch: RemoteArch): string => {
      const b = this.opts.binary(arch);
      return b
        ? `v=${b.version}; s=${b.sha256}`
        : `echo "TCR-ERROR this gateway carries no talkcode-remote build for ${arch}"; exit 0`;
    };
    // POSIX sh only, single-quote free (it is passed inside single quotes), and run through
    // `sh -c` so a user whose login shell is fish or zsh gets the same parse.
    return [
      `[ "$(uname -s)" = Linux ] || { echo "TCR-ERROR unsupported system: $(uname -s)"; exit 0; }`,
      `m=$(uname -m)`,
      `case "$m" in x86_64|amd64) ${arm('amd64')};; aarch64|arm64) ${arm('arm64')};;`,
      `*) echo "TCR-ERROR unsupported architecture: $m"; exit 0;; esac`,
      `p="$HOME/.talkcode/remote/$v/talkcode-remote"`,
      `if [ -x "$p" ]; then "$p" attach --ns ${this.opts.ns} --version "$v" --sha256 "$s"; rc=$?; [ $rc -eq 3 ] || exit $rc; fi`,
      `echo "TCR-NEED $m"`,
    ].join('\n');
  }

  private launch(script: string): Promise<LaunchResult> {
    return new Promise<LaunchResult>((resolve) => {
      const proc = this.opts.transport(script);
      let settled = false;
      let text = Buffer.alloc(0);
      let stderr = '';
      const finish = (r: LaunchResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        // Paused, so nothing the host sends before the handshake attaches its reader is lost.
        if (r.kind === 'ready') proc.stdout?.pause();
        else proc.kill('SIGKILL');
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ kind: 'error', message: `no answer within ${ATTEMPT_TIMEOUT_MS / 1000}s${tail(stderr)}` }),
        ATTEMPT_TIMEOUT_MS
      );
      const onData = (chunk: Buffer): void => {
        text = Buffer.concat([text, chunk]);
        for (;;) {
          const nl = text.indexOf(0x0a);
          if (nl < 0) break;
          const line = text.subarray(0, nl).toString('utf8').trim();
          text = text.subarray(nl + 1);
          if (line === 'TCR-READY') return finish({ kind: 'ready', proc, rest: Buffer.from(text) });
          if (line.startsWith('TCR-NEED')) return finish({ kind: 'need', arch: line.split(/\s+/)[1] ?? '' });
          if (line.startsWith('TCR-ERROR')) return finish({ kind: 'error', message: line.slice('TCR-ERROR'.length).trim() });
          // Anything else before the marker is the host's shell talking (a banner from an rc file).
        }
        if (text.length > 64 << 10) finish({ kind: 'error', message: 'the host printed too much before talkcode-remote started' });
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-2000);
      });
      proc.on('error', (e) => finish({ kind: 'error', message: e.message }));
      proc.on('exit', (code, signal) =>
        finish({ kind: 'error', message: `${code !== null ? `exit ${code}` : `killed by ${signal}`}${tail(stderr)}` })
      );
    });
  }

  /** Copy the build for `arch` into its version directory on the host, atomically. */
  private upload(arch: string): Promise<void> {
    const key: RemoteArch | undefined =
      arch === 'x86_64' || arch === 'amd64' ? 'amd64' : arch === 'aarch64' || arch === 'arm64' ? 'arm64' : undefined;
    const bin = key ? this.opts.binary(key) : undefined;
    if (!bin) return Promise.reject(new Error(`this gateway carries no talkcode-remote build for ${arch}`));
    console.log(`[remote] ${this.opts.hostId}: installing talkcode-remote ${bin.version} (${key})`);
    const script = [
      `umask 077`,
      `d="$HOME/.talkcode/remote/${bin.version}"`,
      `mkdir -p "$d" && cat > "$d/.upload.$$" && chmod 700 "$d/.upload.$$" && mv -f "$d/.upload.$$" "$d/talkcode-remote" && echo TCR-UPLOADED`,
    ].join('\n');
    return new Promise<void>((resolve, reject) => {
      const proc = this.opts.transport(script);
      let out = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('upload timed out'));
      }, UPLOAD_TIMEOUT_MS);
      proc.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
      proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && out.includes('TCR-UPLOADED')) resolve();
        else reject(new Error(`upload failed (exit ${code})${tail(stderr)}`));
      });
      if (proc.stdin) createReadStream(bin.path).on('error', reject).pipe(proc.stdin);
    });
  }

  // ── the live connection ─────────────────────────────────────────────────────────────────────

  private handshake(proc: ChildProcess, rest: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const decoder = new FrameDecoder();
      let welcomed = false;
      const transport: LinkTransport = {
        write: (buf) => {
          proc.stdin?.write(buf);
        },
      };
      const fail = (message: string): void => {
        if (welcomed) return;
        clearTimeout(timer);
        proc.kill('SIGKILL');
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('no welcome from talkcode-remote'), ATTEMPT_TIMEOUT_MS);
      const onFrames = (frames: Frame[]): void => {
        for (const f of frames) {
          if (!welcomed) {
            if (f.h.t !== 'welcome') return fail(`expected welcome, got ${f.h.t}`);
            if (f.h.error) return fail(f.h.error);
            welcomed = true;
            clearTimeout(timer);
            this.onWelcome(proc, transport, f.h);
            resolve();
            continue;
          }
          this.onFrame(proc, f);
        }
      };
      const onData = (chunk: Buffer): void => {
        if (this.proc !== proc && welcomed) return;
        try {
          onFrames(decoder.push(chunk));
        } catch (e) {
          if (!welcomed) return fail(e instanceof Error ? e.message : String(e));
          this.drop(proc, `bad data from the host: ${e instanceof Error ? e.message : e}`);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stdin?.on('error', () => {}); // a write after the process died; 'exit' handles it
      proc.on('exit', (code, signal) => {
        if (!welcomed) return fail(`the connection closed during the handshake (${code ?? signal})`);
        this.drop(proc, `ssh ${code !== null ? `exited ${code}` : `was killed (${signal})`}`);
      });
      proc.stdin?.write(encodeFrame({ t: 'hello', proto: PROTO_VERSION, epoch: this.epoch, recv: this.link.recvSeq }));
      if (rest.length > 0) onData(rest);
      proc.stdout?.resume();
    });
  }

  private onWelcome(proc: ChildProcess, transport: LinkTransport, h: FrameHeader): void {
    const resumed = h.resumed === true;
    const lost = !resumed && this.link.hasState;
    if (!resumed) this.link.reset();
    this.welcomeInfo = {
      version: h.version ?? '',
      instance: h.instance ?? '',
      home: h.home ?? '',
      pid: h.pid ?? 0,
      os: h.os ?? '',
      arch: h.arch ?? '',
      resumed,
    };
    this.proc = proc;
    this.state = 'up';
    this.attempt = 0;
    this.lastError = undefined;
    this.lastHeard = Date.now();
    // `reset` before the link resumes, so nothing is resent on behalf of processes that are gone.
    if (lost) this.emit('reset');
    this.link.attach(transport, resumed ? (h.recv ?? 0) : 0);
    this.heartbeat = setInterval(() => this.beat(proc), PING_EVERY_MS);
    this.heartbeat.unref?.();
    console.log(`[remote] ${this.opts.hostId}: connected (talkcode-remote ${this.welcomeInfo.version}, ${resumed ? 'resumed' : 'fresh'})`);
    for (const w of this.waiters.splice(0)) w.resolve(this.welcomeInfo);
    this.emit('up', resumed);
    // A connection nobody is using yet (the daemon's first contact at startup) still closes.
    this.armIdle();
  }

  private onFrame(proc: ChildProcess, f: Frame): void {
    if (this.proc !== proc) return;
    this.lastHeard = Date.now();
    let deliver: boolean;
    try {
      deliver = this.link.receive(f.h, f.body.length);
    } catch (e) {
      this.drop(proc, e instanceof Error ? e.message : String(e));
      return;
    }
    if (deliver) this.emit('frame', f.h, f.body);
  }

  private beat(proc: ChildProcess): void {
    if (this.proc !== proc) return;
    if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
      this.drop(proc, `no answer for ${DEAD_AFTER_MS / 1000}s`);
      return;
    }
    this.pingN += 1;
    this.link.control({ t: 'ping', n: this.pingN });
  }

  /** The live connection is gone: keep everything, and try again. */
  private drop(proc: ChildProcess, reason: string): void {
    if (this.proc !== proc) return;
    this.disconnect(reason, 'down');
    this.scheduleRetry();
  }

  private disconnect(reason: string, next: State): void {
    const proc = this.proc;
    const wasUp = this.state === 'up';
    this.proc = undefined;
    this.link.detach();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.state = next;
    if (proc) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      // Let go of the pipes too: whatever ran on the far end of them may outlive the process.
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    }
    if (wasUp) {
      console.log(`[remote] ${this.opts.hostId}: disconnected (${reason})`);
      if (next === 'down') this.emit('down', reason);
    }
  }
}

function tail(stderr: string): string {
  const s = stderr.trim().split('\n').slice(-3).join(' | ');
  return s ? `: ${s}` : '';
}
