/**
 * What `fleetherd doctor` runs on a host to see whether its agents can start there — and what the
 * daemon runs on a pod with no `pod.yaml` to see which agents it has (pods.ts): one lookup per
 * harness command, in the PATH that agent will actually have. In daemon/ rather than beside doctor
 * because both use it, and the daemon cannot import from commands/.
 *
 * That PATH is the host's login PATH (remote/shellenv.go) unless the agent's `env` sets PATH, in
 * which case it is exactly that value: remoteAgentEnv passes it through and fleetherd-remote replaces
 * the login PATH with it (agentEnv in remote/daemon.go). Checking every agent against the login
 * PATH reported "not on the login PATH" for a command the agent's own PATH did reach, and failed
 * doctor on a host that worked (armbox, 2026-10-29: node and claude-agent-acp under ~/tc-e2e,
 * named only in the agent's env).
 *
 * Pure, so the script can be run against a local directory in a test.
 */

/** A harness command, and the PATH to look for it in (undefined: the host's login PATH). */
export interface HostProbe {
  command: string;
  path?: string;
}

/**
 * The script travels inside single quotes (sshArgs) and runs inside the double quotes of a login
 * shell's -c within that, so only values that need no quoting at all are put in it. `~` is left
 * out of PATHs on purpose: a shell expands it in a PATH assignment, fleetherd-remote's lookup does
 * not, and checking with one rule would misreport the other.
 */
const SAFE_COMMAND = /^[\w.~/+-]+$/;
const SAFE_PATH = /^[\w./:+-]+$/;

/** The lookups as one shell command list; each line it prints is `TCR-HAS <i>` or `TCR-MISSING <i>`. */
export function hostProbeScript(probes: readonly HostProbe[]): string {
  return probes
    .map((p, i) => {
      if (!SAFE_COMMAND.test(p.command) || (p.path !== undefined && !SAFE_PATH.test(p.path))) return '';
      const look = `command -v ${p.command} >/dev/null 2>&1`;
      return `${p.path !== undefined ? `(PATH=${p.path}; ${look})` : look} && echo TCR-HAS ${i} || echo TCR-MISSING ${i}`;
    })
    .filter(Boolean)
    .join('; ');
}

/** What the probe's output says: commands not found, and probes it could not express. */
export function readHostProbe(probes: readonly HostProbe[], stdout: string): { missing: string[]; unchecked: string[] } {
  const seen = new Set<number>();
  const missing: string[] = [];
  for (const m of stdout.matchAll(/^TCR-(HAS|MISSING) (\d+)$/gm)) {
    const i = Number(m[2]);
    seen.add(i);
    if (m[1] === 'MISSING' && probes[i]) missing.push(label(probes[i]));
  }
  const unchecked = probes.flatMap((p, i) => (seen.has(i) ? [] : [label(p)]));
  return { missing, unchecked };
}

function label(p: HostProbe): string {
  return p.path !== undefined ? `${p.command} (in the agent's PATH)` : p.command;
}
