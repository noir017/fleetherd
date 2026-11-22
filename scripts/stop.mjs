// Stop every running fleetherd instance (daemon + agent subprocesses), whichever way it was started.
//
// Why this exists: the daemon is a long-lived process, and it is easy to end up with MORE THAN ONE
// instance running at once (e.g. a `dist` daemon left over from before a rebuild, plus a fresh `tsx
// watch` one). Multiple instances share the same IM bot token and RACE to handle each message, which
// produces baffling "sometimes new behaviour, sometimes old" symptoms. This script force-kills them all
// so you can start exactly one clean instance. It also sweeps up orphaned `claude-agent-acp` children
// that a killed daemon may have left behind.
//
// Matched, on purpose, narrowly enough to never hit your editor / Claude Code / unrelated node procs:
//   - fleetherd daemon started from dist:  node .../dist/cli.js start
//   - fleetherd daemon started from src:   tsx ... src/cli.ts start  (dev:watch)
//   - agent subprocesses:               claude-agent-acp
import { execSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

const sh = (c) => {
  try {
    return execSync(c, { encoding: 'utf8' });
  } catch {
    return '';
  }
};

let pids = [];
if (process.platform === 'win32') {
  const psOut = sh(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { \\"$($_.ProcessId) $($_.CommandLine)\\" } }"'
  );
  const isWinTarget = (l) =>
    /^\s*\d+\s+(?:"[^"]*(?:node|tsx)(?:\.exe|\.cmd)?"|\S*(?:node|tsx)(?:\.exe|\.cmd)?)\s/i.test(l) &&
    /(?:(?:dist[\\/]cli\.js|src[\\/]cli\.ts)\b.*\bstart\b|claude-agent-acp)/i.test(l) &&
    !/stop\.mjs/i.test(l);
  pids = [...new Set(psOut.split(/\r?\n/).filter(isWinTarget).map((l) => l.trim().split(/\s+/)[0]))].filter(Boolean);
  for (const pid of pids) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (r.error) {
      try {
        process.kill(Number(pid));
      } catch {
        /* already gone */
      }
    }
  }
} else {
  const rows = sh('ps -Ao pid,command').split('\n');
  // The `start` subcommand may be separated from the entry file by global flags
  // (`node dist/cli.js --config foo.yaml start`), and the entry may be a relative
  // path — so: entry file anywhere in the line, `start` anywhere after it.
  // Anchor the first token after the pid to node/tsx: a shell line that merely
  // QUOTES such a command (`zsh -c "…; node dist/cli.js start"`) must not match,
  // or this script kills the wrapping shell.
  const isTarget = (l) =>
    /^\s*\d+\s+\S*(?:node|tsx)\s/.test(l) &&
    /(?:(?:dist\/cli\.js|src\/cli\.ts)\b.*\bstart\b|claude-agent-acp)/.test(l) &&
    !/\bgrep\b|stop\.mjs/.test(l);

  pids = [
    ...new Set(rows.filter(isTarget).map((l) => l.trim().split(/\s+/)[0])),
  ].filter(Boolean);

  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

console.log(
  pids.length
    ? `stopped ${pids.length} fleetherd process(es): ${pids.join(', ')}`
    : 'no fleetherd process was running'
);
