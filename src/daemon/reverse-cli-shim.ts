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
 * On POSIX this writes `<configDir>/bin/<name>` (`#!/bin/sh`). On Windows it writes both
 * `<name>.cmd` (for cmd.exe / PowerShell / CreateProcess) and `<name>` (`#!/bin/sh`, for Git Bash /
 * MSYS2 subshells that agents such as Claude Code invoke).
 */
export function ensureReverseCliShim(platform: NodeJS.Platform = process.platform): string | null {
  const self = selfInvocation();
  if (!self) return null;
  const dir = path.join(configDir(), 'bin');
  const posixScript = [
    '#!/bin/sh',
    `exec ${[self.command, ...self.args].map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');
  const cmdScript =
    platform === 'win32'
      ? `@echo off\r\n${[self.command, ...self.args].map(cmdQuote).join(' ')} %*\r\n`
      : undefined;
  try {
    // One shim under each of the CLI's names: `talkcode` is the one an agent learned before 3.0.0
    // (legacy-name.ts), and an older skill copy or a scheduled bash task may still call it.
    for (const name of CLI_NAMES) {
      writeShimFile(path.join(dir, name), posixScript, platform !== 'win32');
      if (cmdScript !== undefined) {
        writeShimFile(path.join(dir, `${name}.cmd`), cmdScript, false);
      }
    }
    return dir;
  } catch (e) {
    console.warn('[shim] failed to provision the reverse CLI shim:', e instanceof Error ? e.message : e);
    return null;
  }
}

function writeShimFile(shim: string, content: string, executable: boolean): void {
  // Idempotent: rewrite only when the content drifts (entry moved, node upgraded).
  if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== content) {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, content, executable ? { mode: 0o755 } : undefined);
  } else if (executable) {
    fs.chmodSync(shim, 0o755);
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
  const raw = entry.split(/[\\/]/).pop() ?? '';
  const base = raw.replace(/\.(cmd|exe|bat)$/i, '');
  return (CLI_NAMES as readonly string[]).includes(base) || /^cli\.(js|mjs|cjs|ts)$/i.test(raw);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(s: string): string {
  return `"${s.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}
