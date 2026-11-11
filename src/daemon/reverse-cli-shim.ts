import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';
import { CLI_NAMES } from '../legacy-name.js';

/**
 * Self-provisioned `fleetherd` shim for agent subprocesses.
 *
 * The bundled skill tells the agent that `fleetherd` is on PATH, but whether that
 * is true depends on how the daemon was launched: a global npm install puts it on PATH, while
 * `node dist/cli.js start` or a tsx dev run does not (and a service manager like launchd may strip
 * PATH entirely). Instead of gambling, the daemon writes a two-line shim that re-executes exactly
 * the runtime it is itself running as (see selfInvocation — so a tsx dev daemon spawns
 * a tsx reverse CLI, a dist daemon spawns dist), and agent-acp prepends the shim dir to each agent
 * child's PATH. This also pins the agent to THIS daemon's version when a different global one exists.
 *
 * POSIX only for now; on win32 it returns null and the agent falls back to whatever PATH offers.
 */
export function ensureReverseCliShim(): string | null {
  if (process.platform === 'win32') return null;
  const self = selfInvocation();
  if (!self) return null;
  const dir = path.join(configDir(), 'bin');
  const script = [
    '#!/bin/sh',
    `exec ${[self.command, ...self.args].map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
  try {
    // One shim under each of the CLI's names: `talkcode` is the one an agent learned before 3.0.0
    // (legacy-name.ts), and an older skill copy or a scheduled bash task may still call it.
    for (const name of CLI_NAMES) {
      const shim = path.join(dir, name);
      // Idempotent: rewrite only when the content drifts (entry moved, node upgraded).
      if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== script) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(shim, script, { mode: 0o755 });
      } else {
        fs.chmodSync(shim, 0o755);
      }
    }
    return dir;
  } catch (e) {
    console.warn('[shim] failed to provision the reverse CLI shim:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * How to run THIS CLI again, exactly as this process is running: execPath + execArgv + argv[1].
 * Shared by the shim above and by the MCP server entry the daemon hands to every ACP session
 * (agent-acp.ts acpMcpServers), so both reach the daemon's own version through the same runtime —
 * a tsx dev daemon gets tsx children, a dist daemon dist ones. Null when this process is not the CLI.
 */
export function selfInvocation(): { command: string; args: string[] } | null {
  // `argv[1]` is the only clue to "how was I launched", and it is a good one ONLY when this
  // process really is the CLI. It is not, for instance, in a vitest worker, whose argv[1] is
  // tinypool's worker entry — and the shim is written to a SHARED user path, so a test run
  // rewrote the shim of the daemon actually running on this machine to point at that entry.
  // The shim dir leads PATH, so every send-message / ask / send-file from every live agent
  // started failing instantly, with a stack from inside tinypool. Refuse to guess instead.
  const entry = process.argv[1];
  if (!entry || !isCliEntry(entry)) return null;
  return { command: process.execPath, args: [...process.execArgv, entry].filter(Boolean) };
}

/**
 * Whether `entry` looks like this CLI's own entry point.
 *
 * The three real launch shapes: a global install (`/usr/bin/fleetherd`, or `/usr/bin/talkcode`, its
 * name before 3.0.0 — a symlink node is handed by name), `node dist/cli.js`, and `tsx src/cli.ts`. Anything else — a test runner, a
 * REPL, an embedding host — means this process is not the CLI and must not claim to be one.
 */
export function isCliEntry(entry: string): boolean {
  const base = path.basename(entry);
  return (CLI_NAMES as readonly string[]).includes(base) || /^cli\.(js|mjs|cjs|ts)$/.test(base);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
