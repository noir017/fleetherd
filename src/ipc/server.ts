import fs from 'node:fs';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { parseIpcRequest, type IpcAction, type IpcResponse } from './protocol.js';
import { parseTarget, type ChannelTarget, type ConversationAddress } from '../core/conversation.js';

/**
 * Daemon-side IPC server over a unix socket. Token validation and address
 * resolution are delegated to the handler (daemon).
 */
export interface IpcServerHandler {
  /**
   * Validate token, return the address this command writes to (throws if invalid). `override` is
   * the parsed `--channel`, whose `platform` is set only when the value named an instance.
   */
  resolveAddress(token: string, override?: ChannelTarget): ConversationAddress;
  handle(action: IpcAction, address: ConversationAddress): Promise<unknown>;
}

const IDLE_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 1 << 20; // 1 MiB

export class IpcServer {
  private server: net.Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly handler: IpcServerHandler,
    /**
     * Configured platform instance ids — what tells `tg:123/4` (a platform-qualified target) apart
     * from a channel id that merely contains a colon. Empty means no value is ever read as
     * qualified, which is exactly the behaviour before qualified targets existed.
     */
    private readonly instances: ReadonlySet<string> = new Set()
  ) {}

  async start(): Promise<void> {
    this.server = net.createServer((sock) => {
      // Catch per-connection errors so one bad connection can't take down the server.
      sock.on('error', (err) => {
        console.error(`[ipc] connection error: ${err.message}`);
      });

      // Idle timeout: drop connections that hang without sending data, avoiding fd leaks.
      sock.setTimeout(IDLE_TIMEOUT_MS);
      sock.on('timeout', () => {
        console.error('[ipc] connection idle timeout, closing');
        sock.destroy();
      });

      let buf = '';
      // StringDecoder buffers incomplete multibyte sequences split across chunk
      // boundaries (e.g. a CJK char cut mid-byte). Decoding each chunk independently
      // with chunk.toString('utf8') would turn half a char into U+FFFD and make
      // JSON.parse spuriously reject otherwise-valid requests.
      const decoder = new StringDecoder('utf8');
      sock.on('data', (chunk) => {
        buf += decoder.write(chunk);
        // Per-connection buffer cap, so a malicious/buggy peer can't exhaust memory.
        if (buf.length > MAX_LINE_BYTES) {
          console.error('[ipc] per-connection buffer exceeded limit, closing');
          sock.destroy();
          return;
        }
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          // dispatch wraps its own try/catch, so one bad request doesn't affect the rest.
          if (line.trim()) void this.dispatch(line, sock);
        }
      });
    });

    // Catch server-level errors so an uncaught exception can't kill the process.
    this.server.on('error', (err) => {
      console.error(`[ipc] server error: ${err.message}`);
    });

    await new Promise<void>((res, rej) => {
      const server = this.server!;
      let attempted = false;

      const onListening = (): void => {
        try {
          // Socket file perms 0600: owner-only read/write.
          fs.chmodSync(this.socketPath, 0o600);
        } catch (e) {
          console.error(
            `[ipc] failed to set socket permissions: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        res();
      };

      const onError = (err: Error): void => {
        const code = (err as NodeJS.ErrnoException).code;
        // Address in use: either a live daemon still listening (reject double-start)
        // or a stale file. We don't unlink before bind (TOCTOU); instead we bind first
        // and only after failure decide stale vs alive.
        if (code === 'EADDRINUSE' && !attempted) {
          attempted = true;
          this.probeExisting()
            .then((alive) => {
              if (alive) {
                rej(
                  new Error(
                    `socket ${this.socketPath} already has a daemon listening; refusing to start a second instance (stop the existing process first)`
                  )
                );
                return;
              }
              // Can't connect (ECONNREFUSED etc.) -> stale file; unlink and retry listen once.
              try {
                fs.unlinkSync(this.socketPath);
              } catch (e) {
                rej(e instanceof Error ? e : new Error(String(e)));
                return;
              }
              attemptListen();
            })
            .catch((e) => rej(e instanceof Error ? e : new Error(String(e))));
          return;
        }
        rej(err);
      };

      const attemptListen = (): void => {
        server.once('error', onError);
        // Tighten umask before bind: the unix socket file is created at listen() time
        // under the current umask, and we only chmod 0600 afterwards — leaving a
        // world-accessible window in between. Setting umask to 0o077 makes the socket
        // owner-only the moment it's created, closing that window; we restore it right
        // after listen() synchronously triggers creation, keeping the side effect on
        // other fd creation minimal. chmod is kept as a fallback (clears umask residue).
        const prevUmask = process.umask(0o077);
        try {
          server.listen(this.socketPath, () => {
            server.removeListener('error', onError);
            onListening();
          });
        } finally {
          process.umask(prevUmask);
        }
      };

      attemptListen();
    });
  }

  /** Probe whether an existing socket has a live daemon. Connect ok -> true; fail -> false. */
  private probeExisting(timeoutMs = 500): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const sock = net.createConnection(this.socketPath);
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

  private async dispatch(line: string, sock: net.Socket): Promise<void> {
    let resp: IpcResponse;
    // Pause the idle timeout while handling: a blocking handler (e.g. ask, waiting
    // for the user to click a button) can far exceed 30s but shouldn't be killed as
    // "idle". The finally block restores the timeout so a truly idle next request
    // is still reclaimed on time.
    sock.setTimeout(0);
    try {
      // Parse JSON first, then validate structure with zod: the peer is an untrusted
      // short-lived process, so we can't `as IpcRequest` and trust it blindly — a
      // malformed/missing-field action would otherwise carry undefined all the way
      // down to the platform call layer.
      const raw: unknown = JSON.parse(line);
      const parsed = parseIpcRequest(raw);
      if (!parsed.ok) {
        // Validation failure: reply ok:false rather than throw — fits the semantics
        // better and still flows through the unified write-back below.
        resp = { ok: false, error: parsed.error };
      } else {
        const req = parsed.req;
        const address = this.handler.resolveAddress(req.token, overrideTarget(req.action, this.instances));
        const data = await this.handler.handle(req.action, address);
        resp = { ok: true, data };
      }
    } catch (err) {
      resp = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Restore the idle timeout (one connection may carry many requests; keep the
      // next idle one protected).
      sock.setTimeout(IDLE_TIMEOUT_MS);
    }
    try {
      // Write-back may fail if the peer already disconnected; catch to avoid an
      // unhandled exception bubbling up.
      sock.write(JSON.stringify(resp) + '\n');
    } catch (e) {
      console.error(`[ipc] failed to write back response: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => {
      if (!this.server) {
        res();
        return;
      }
      this.server.close(() => res());
    });
    this.server = null;
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch (e) {
      console.error(`[ipc] failed to clean up socket file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The `--channel` override, parsed and validated.
 *
 * Accepts `<channel>` or `<channel>/<thread>` so an agent can target a specific topic/thread, not
 * just a channel root — and either of those behind `<instance>:` to target another platform (the
 * ids `fleetherd channels` prints). Malformed input throws here (the message reaches the
 * agent as `ok:false, error`) rather than reaching a platform API as a garbled id.
 */
function overrideTarget(action: IpcAction, instances: ReadonlySet<string>): ChannelTarget | undefined {
  const raw = 'channelId' in action ? action.channelId : undefined;
  return raw == null ? undefined : parseTarget(raw, instances);
}
