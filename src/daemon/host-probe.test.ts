import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostProbeScript, readHostProbe, type HostProbe } from './host-probe.js';

/** Run the probe the way a host would (a shell -c), with `pathEnv` as the login PATH. */
function runProbe(probes: HostProbe[], pathEnv: string): string {
  return spawnSync('/bin/sh', ['-c', hostProbeScript(probes)], { encoding: 'utf8', env: { PATH: pathEnv } }).stdout;
}

describe('doctor host probe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-doctor-hosts-'));
  writeFileSync(join(dir, 'tc-fake-acp'), '#!/bin/sh\n');
  chmodSync(join(dir, 'tc-fake-acp'), 0o755);

  it("looks an agent's command up in its own PATH when it sets one, and in the login PATH otherwise", () => {
    // The armbox case: the command is reachable only through the PATH the agent's env names.
    const probes: HostProbe[] = [{ command: 'tc-fake-acp', path: `${dir}:/usr/bin:/bin` }, { command: 'tc-fake-acp' }];
    const out = runProbe(probes, '/usr/bin:/bin');
    expect(readHostProbe(probes, out)).toEqual({ missing: ['tc-fake-acp'], unchecked: [] });
  });

  it('finds what the login PATH has', () => {
    const probes: HostProbe[] = [{ command: 'tc-fake-acp' }];
    expect(readHostProbe(probes, runProbe(probes, `${dir}:/usr/bin:/bin`))).toEqual({ missing: [], unchecked: [] });
  });

  it('labels a miss in the agent PATH as such', () => {
    const probes: HostProbe[] = [{ command: 'tc-nowhere', path: '/usr/bin:/bin' }];
    expect(readHostProbe(probes, runProbe(probes, '/usr/bin:/bin')).missing).toEqual(["tc-nowhere (in the agent's PATH)"]);
  });

  it('reports what it cannot put in the script as unchecked rather than found', () => {
    // The script rides inside two layers of quotes; a value needing quotes is left out, and `~` is
    // expanded by a shell but not by fleetherd-remote's lookup.
    const probes: HostProbe[] = [
      { command: 'sh', path: '/opt/my tools/bin' },
      { command: 'sh', path: '~/bin:/bin' },
      { command: "it's" },
      { command: 'sh' },
    ];
    const script = hostProbeScript(probes);
    expect(script).not.toMatch(/my tools|~\/bin|it's/);
    expect(readHostProbe(probes, runProbe(probes, '/usr/bin:/bin'))).toEqual({
      missing: [],
      unchecked: ["sh (in the agent's PATH)", "sh (in the agent's PATH)", "it's"],
    });
  });

  it('has nothing in it the quoting around it would break', () => {
    // sshArgs puts the script in single quotes, doctor in the double quotes of `-ilc "…"`.
    const script = hostProbeScript([{ command: 'claude-agent-acp', path: '/a/b:/c' }, { command: 'codex-acp' }]);
    expect(script).not.toMatch(/['"$`\\]/);
  });
});
