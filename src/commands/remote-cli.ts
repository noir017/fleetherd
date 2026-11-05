import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isBridgedCommand } from '../ipc/commands.js';

/**
 * What a `talkcode` invocation does when it lands on the full Node CLI inside an agent on a host
 * the gateway reaches over ssh.
 *
 * Reverse commands on a host are meant to be the gateway's own CLI, reached through the `talkcode`
 * shim talkcode-remote puts first on PATH (remote/shim.go): same parsing, same validation, same
 * output, and nothing to drift. PATH is not dependable, though. codex runs the commands it is asked
 * to run with `bash -lc`, and a login shell re-reads /etc/profile, which rebuilds PATH from the
 * system default — so `talkcode` becomes whatever the image installed (on uniagent, this CLI). It
 * then looks for a config file that lives on the gateway's machine, not this one, and answers
 * "config not found at ~/.config/talkcode/config.yaml; run `talkcode setup` first" — every reverse
 * command from that agent is dead.
 *
 * So an agent's environment decides (TALKCODE_REMOTE_SOCK, which the host's daemon sets for every
 * process it starts): with it set, this CLI is not the gateway's CLI at all, but a wrapper for the
 * shim. TALKCODE_REMOTE_CLI names the shim — an absolute path the host's daemon knows and the
 * socket's path does not, since the socket is per gateway and the shim is per version
 * (remote/daemon.go agentEnv) — and argv goes there unchanged.
 *
 * What may go there is the same set the gateway's bridge accepts (ipc/commands.ts isBridgedCommand):
 * the reverse commands, `mcp`, `help` and the version/help flags. Anything else is refused HERE,
 * before it leaves the machine: `start` / `setup` / `doctor` are the gateway's own administration,
 * and a login shell must not be able to turn this binary into a way to run them on the gateway.
 */

export type RemoteCliPlan =
  /** Not an agent's shell on a host: the CLI behaves as it always has. */
  | { kind: 'local' }
  /** Hand argv to the host's `talkcode` shim, which carries it to the gateway. */
  | { kind: 'forward'; shim: string }
  /** Say why not, and exit 2 — the same shape the gateway's bridge uses for a command it turns away. */
  | { kind: 'refuse'; message: string };

/**
 * The decision, with everything it reads passed in: the CLI calls it with process.argv and
 * process.env, tests call it with whatever they are pinning.
 */
export function planRemoteCli(argv: string[], env: NodeJS.ProcessEnv): RemoteCliPlan {
  if (!env.TALKCODE_REMOTE_SOCK) return { kind: 'local' };
  const command = argv[0];
  if (!isBridgedCommand(argv)) {
    return {
      kind: 'refuse',
      message:
        command === undefined
          ? 'talkcode: an agent on a host can run only the reverse commands, `mcp` and `help`; `talkcode help` lists them'
          : `talkcode: "${command}" is the gateway's own administration; an agent on a host can run only the reverse commands, \`mcp\` and \`help\` (\`talkcode help\` lists them)`,
    };
  }
  const shim = env.TALKCODE_REMOTE_CLI;
  if (!shim) {
    // A talkcode-remote older than this CLI: the host's helper predates the variable that says where
    // its shim is. Naming the cause matters — the alternative reading of this state is "the CLI is
    // broken", and nothing on the host can be edited to fix it.
    return {
      kind: 'refuse',
      message:
        'talkcode: this agent runs on a host reached over ssh, but the talkcode-remote serving it did not say where its talkcode command is (TALKCODE_REMOTE_CLI) — it is older than this CLI. Update the gateway: it installs talkcode-remote on each host, and the next connection replaces this one.',
    };
  }
  if (!isExecutable(shim)) {
    return {
      kind: 'refuse',
      message: `talkcode: the talkcode-remote on this host pointed at ${shim}, which is not there; the gateway reinstalls its helper on the next connection to the host.`,
    };
  }
  return { kind: 'forward', shim };
}

/**
 * Do what `planRemoteCli` decided. `null` means "not a host: carry on as the CLI"; otherwise the
 * process should exit with the returned code, which the caller does.
 */
export async function handOffRemoteCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number | null> {
  const plan = planRemoteCli(argv, env);
  if (plan.kind === 'local') return null;
  if (plan.kind === 'refuse') {
    process.stderr.write(`${plan.message}\n`);
    return 2;
  }
  return await runShim(plan.shim, argv);
}

/** Run the shim with the descriptors this process was given, and carry its exit code back. */
function runShim(shim: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    // Inherited, not piped: `talkcode mcp` is a stdio server and `ask` blocks on a person, so the
    // child must own the same stdin and stdout rather than talking to a wrapper that relays.
    const child = spawn(shim, argv, { stdio: 'inherit' });
    // A harness stops a command with a signal. It has to reach the shim, or a killed `mcp` or `ask`
    // leaves the shim waiting on a socket the gateway still thinks is alive.
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const relay = (sig: NodeJS.Signals): void => void child.kill(sig);
    for (const sig of signals) process.on(sig, relay);
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      for (const sig of signals) process.off(sig, relay);
      resolve(code);
    };
    child.on('error', (e) => {
      process.stderr.write(`talkcode: cannot run the host's talkcode command at ${shim}: ${e.message}\n`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
