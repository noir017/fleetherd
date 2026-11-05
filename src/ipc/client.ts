import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { ASK_CLIENT_TIMEOUT_MARGIN_MS, DEFAULT_ASK_TIMEOUT_MS, type IpcAction, type IpcRequest, type IpcResponse } from './protocol.js';

/**
 * How long the client waits for `schedule add` when the caller does not say.
 *
 * Adding a task with `--model` is not a disk write: the daemon asks the agent for its model list,
 * which may mean starting a session (cold start, and an ssh round trip for a remote agent). The
 * 10 s default is shorter than that on a busy machine, and the failure is the bad kind — the client
 * gives up while the daemon finishes and registers the task, so an agent that retries leaves a
 * duplicate behind. The daemon answers immediately without `--model`; one generous bound for the
 * command is simpler than making it depend on a field.
 */
const SCHEDULE_ADD_TIMEOUT_MS = 60_000;

/**
 * The wait this action needs, or undefined for the 10 s default (which still honours
 * `TALKCODE_IPC_TIMEOUT_MS`). Shared by the shell command and the native tool, so both get the
 * same bound: `ask` blocks until the person answers, `schedule add` until a model list is read.
 */
export function clientTimeoutFor(action: IpcAction): number | undefined {
  if (action.kind === 'ask') return (action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) + ASK_CLIENT_TIMEOUT_MARGIN_MS;
  if (action.kind === 'schedule-add') return SCHEDULE_ADD_TIMEOUT_MS;
  return undefined;
}

/**
 * CLI-side IPC client. Reverse-command processes use it to connect back to the daemon.
 * The token is read from TALKCODE_TURN_TOKEN (injected by the daemon when it spawns the agent).
 */
export async function callDaemon(
  socketPath: string,
  action: IpcAction,
  token = process.env.TALKCODE_TURN_TOKEN,
  /** Explicit override for the client wait timeout (ms). Blocking commands (e.g. ask) pass a larger value. */
  timeoutMs?: number
): Promise<IpcResponse> {
  if (!token) {
    return { ok: false, error: 'TALKCODE_TURN_TOKEN is not set: reverse commands must be invoked within an agent turn driven by the daemon' };
  }
  const req: IpcRequest = { token, action };

  // Timeout precedence:
  //  - Parse env (TALKCODE_IPC_TIMEOUT_MS): accept only finite positive numbers. Bad
  //    values (NaN/negative/non-numeric) aren't silently swallowed into undefined;
  //    they're warned on stderr and ignored — so a "valid 0" and a "bad NaN" aren't
  //    both eaten by `|| undefined`, leaving an operator's misconfig with no feedback.
  //  - Synthesis: for blocking commands (explicit larger timeoutMs, e.g. ask waiting
  //    on a button), take max(env, explicit) so a small operator env can't truncate a
  //    large timeout and make the client give up before the daemon. Without an explicit
  //    value, use env or the 10s default.
  const envTimeout = parseEnvTimeout(process.env.TALKCODE_IPC_TIMEOUT_MS);
  const TIMEOUT_MS =
    timeoutMs !== undefined
      ? Math.max(envTimeout ?? 0, timeoutMs)
      : (envTimeout ?? 10_000);

  return new Promise<IpcResponse>((resolve) => {
    let settled = false;
    const done = (r: IpcResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const sock = net.createConnection(socketPath, () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    const timer = setTimeout(
      () => done({ ok: false, error: 'IPC timeout: the daemon did not respond within the allotted time' }),
      TIMEOUT_MS
    );
    let buf = '';
    // StringDecoder buffers incomplete multibyte sequences split across chunk
    // boundaries, so multibyte chars in the response aren't decoded into U+FFFD and
    // break JSON.parse.
    const decoder = new StringDecoder('utf8');
    sock.on('data', (chunk) => {
      buf += decoder.write(chunk);
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          done(JSON.parse(buf.slice(0, nl)) as IpcResponse);
        } catch (e) {
          done({ ok: false, error: String(e) });
        }
      }
    });
    sock.on('error', (e) => done({ ok: false, error: e.message }));
    sock.on('close', () => done({ ok: false, error: 'IPC connection closed before a complete response was received' }));
  });
}

/**
 * Parse TALKCODE_IPC_TIMEOUT_MS. Unset -> undefined; set but bad (non-finite/negative)
 * -> warn on stderr and ignore (return undefined) rather than swallow silently.
 * Note: 0 is treated as bad here — a 0 timeout is meaningless, and rejecting it
 * explicitly avoids a misconfig making every IPC call time out instantly.
 */
function parseEnvTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[ipc] ignoring invalid TALKCODE_IPC_TIMEOUT_MS=${JSON.stringify(raw)} (must be a positive number of milliseconds)`);
    return undefined;
  }
  return n;
}
