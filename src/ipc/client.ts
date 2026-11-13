import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { ASK_CLIENT_TIMEOUT_MARGIN_MS, DEFAULT_ASK_TIMEOUT_MS, type IpcAction, type IpcRequest, type IpcResponse } from './protocol.js';
import { envOf } from '../legacy-name.js';

/**
 * How long the client waits for the commands that can outlast the 10 s default.
 *
 * - `schedule add` / `schedule edit` and `task-new` with `--model`: the daemon asks the agent for its
 *   model list, which may mean starting a session (cold start, and an ssh round trip for a remote
 *   agent). The daemon answers at once without `--model`; one generous bound for the command is
 *   simpler than making it depend on a field.
 * - `reload` and `pod-add`: a reload reads every pod first, waiting up to 20 s for a host that does
 *   not answer (daemon.ts RELOAD_POD_TIMEOUT_MS), and a host added just now has the helper installed
 *   before it can be read.
 *
 * The failure is the bad kind: the client gives up while the daemon finishes and applies the
 * change, so an agent that retries leaves a duplicate (an add, a proposal) or edits twice. Both
 * `pod-add` and `task-new --model` did exactly that on a cold host (laptop, 2026-11-09), each
 * reporting "IPC timeout" for a change that had gone through.
 */
const SLOW_ACTION_TIMEOUT_MS = 60_000;
const SLOW_ACTIONS: ReadonlySet<IpcAction['kind']> = new Set(['schedule-add', 'schedule-edit', 'task-new', 'reload-config', 'pod-add']);

/**
 * The wait this action needs, or undefined for the 10 s default (which still honours
 * `FLEETHERD_IPC_TIMEOUT_MS`). Shared by the shell command and the native tool, so both get the
 * same bound: `ask` blocks until the person answers, the slow actions above until the daemon has
 * done what they ask.
 */
export function clientTimeoutFor(action: IpcAction): number | undefined {
  if (action.kind === 'ask') return (action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) + ASK_CLIENT_TIMEOUT_MARGIN_MS;
  // `schedule run --wait`: the daemon answers when the run ends, so the client has to outlast the
  // wait it asked for. The margin is the daemon's own answer time on top of it.
  if (action.kind === 'schedule-op' && action.op === 'run' && action.waitMs !== undefined) {
    return action.waitMs + SLOW_ACTION_TIMEOUT_MS;
  }
  if (SLOW_ACTIONS.has(action.kind)) return SLOW_ACTION_TIMEOUT_MS;
  return undefined;
}

export async function callDaemon(
  socketPath: string,
  action: IpcAction,
  token = envOf('TURN_TOKEN'),
  /** Explicit override for the client wait timeout (ms). Blocking commands (e.g. ask) pass a larger value. */
  timeoutMs?: number
): Promise<IpcResponse> {
  if (!token) {
    return { ok: false, error: 'FLEETHERD_TURN_TOKEN is not set: reverse commands must be invoked within an agent turn driven by the daemon' };
  }
  const req: IpcRequest = { token, action };

  // Timeout precedence:
  //  - Parse env (FLEETHERD_IPC_TIMEOUT_MS): accept only finite positive numbers. Bad
  //    values (NaN/negative/non-numeric) aren't silently swallowed into undefined;
  //    they're warned on stderr and ignored — so a "valid 0" and a "bad NaN" aren't
  //    both eaten by `|| undefined`, leaving an operator's misconfig with no feedback.
  //  - Synthesis: for blocking commands (explicit larger timeoutMs, e.g. ask waiting
  //    on a button), take max(env, explicit) so a small operator env can't truncate a
  //    large timeout and make the client give up before the daemon. Without an explicit
  //    value, use env or the 10s default.
  const envTimeout = parseEnvTimeout(envOf('IPC_TIMEOUT_MS'));
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
 * Parse FLEETHERD_IPC_TIMEOUT_MS. Unset -> undefined; set but bad (non-finite/negative)
 * -> warn on stderr and ignore (return undefined) rather than swallow silently.
 * Note: 0 is treated as bad here — a 0 timeout is meaningless, and rejecting it
 * explicitly avoids a misconfig making every IPC call time out instantly.
 */
function parseEnvTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[ipc] ignoring invalid FLEETHERD_IPC_TIMEOUT_MS=${JSON.stringify(raw)} (must be a positive number of milliseconds)`);
    return undefined;
  }
  return n;
}
