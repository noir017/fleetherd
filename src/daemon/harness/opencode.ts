import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import type { RemoteHost } from '../../remote/host.js';
import { expandHome } from '../agent-common.js';
import { opencodeInstructions } from '../instruction-imports.js';
import { parseEnvJsonObject, type HarnessLogEvent, type HarnessProfile, type SkillHome } from './profile.js';

const OC_TIMESTAMP = /(?:^|\s)timestamp=(\S+)/;
const OC_SESSION = /(?:^|\s)session\.id=(\S+)/;
const OC_ERROR = /(?:^|\s)error\.error="((?:[^"\\]|\\.)*)"/;
/** opencode auxiliary calls (e.g. session titling) carry `small=true` and are excluded from turn error notices. */
const OC_SMALL = /(?:^|\s)small=true(?:\s|$)/;

function unescapeLogValue(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** Pull one session's errors out of a chunk of opencode's log (first partial line dropped). */
export function parseOpencodeLog(tail: string, sessionId: string, since: Date): HarnessLogEvent[] {
  const events: HarnessLogEvent[] = [];
  const lines = tail.split('\n');
  for (const line of lines.slice(1)) {
    if (!line.includes('level=ERROR')) continue;
    if (OC_SMALL.test(line)) continue;
    if (OC_SESSION.exec(line)?.[1] !== sessionId) continue;
    const stamp = OC_TIMESTAMP.exec(line)?.[1];
    const reason = OC_ERROR.exec(line)?.[1];
    if (!stamp || !reason) continue;
    const at = new Date(stamp);
    if (Number.isNaN(at.getTime()) || at.getTime() < since.getTime()) continue;
    const text = unescapeLogValue(reason).trim();
    if (text.length > 0) events.push({ at, reason: text });
  }
  return events;
}

/** The `skills` array from opencode's config (`$XDG_CONFIG_HOME` or `~/.config`, then `opencode.json`). */
export async function opencodeSkillDirs(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const base = env['XDG_CONFIG_HOME'] || path.join(home, '.config');
  const file = path.join(base, 'opencode', 'opencode.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    if (!Array.isArray(skills)) return [];
    return skills.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[skills] could not read ${file}:`, e instanceof Error ? e.message : e);
    }
    return [];
  }
}

/** opencodeSkillDirs, reading opencode.json on the agent's host; `env` is the agent's own block. */
export async function remoteOpencodeSkillDirs(
  host: RemoteHost,
  home: string,
  env: Record<string, string>
): Promise<string[]> {
  const file = path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'opencode', 'opencode.json');
  try {
    const parsed: unknown = JSON.parse((await host.readFile(file, 1 << 20)).toString('utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}

function opencodeSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.agents', 'skills'), requires: path.join(home, '.config', 'opencode') }];
}

export const opencodeProfile: HarnessProfile = {
  id: 'opencode',
  launch: (def) => ({ command: 'opencode', args: ['acp', ...def.args] }),
  reviewIsolation: {
    kind: 'acp',
    build: (def, base) => {
      // OPENCODE_CONFIG_CONTENT overrides every config file; `permission: "deny"` denies all tools including MCP (AGENTS.md invariant 8).
      const own = parseEnvJsonObject(def.env['OPENCODE_CONFIG_CONTENT']);
      return { ...base, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...own, permission: 'deny' }) } };
    },
  },
  doctor: {
    command: () => 'opencode',
  },
  // Probed 2026-11-13 on opencode 2.2.5: a fork taken mid-turn carries on with the running turn and repeats its commands.
  forkCarriesOnRunningTurn: true,
  contextMissingHint:
    ' On opencode that means a model from a custom provider: give it a `limit` block in opencode.json (e.g. `"limit": { "context": 128000 }`) and the numbers appear.',
  logProbe: {
    // Observed XDG data layout on opencode (`XDG_DATA_HOME` or `~/.local/share`).
    logPath: (home, env) => path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'opencode', 'log', 'opencode.log'),
    parse: parseOpencodeLog,
  },
  skillHomes: (home) => opencodeSkillHomes(home),
  skillReaders: [{ name: 'opencode', homes: opencodeSkillHomes }],
  skillScanDirs: (opts) =>
    // Relative entries resolve against the agent's working directory, matching opencode.json project paths.
    (opts.configured ?? []).map((p) => (path.isAbsolute(p) ? p : path.resolve(opts.cwd, expandHome(p)))),
  configuredSkillDirs: opencodeSkillDirs,
  remoteConfiguredSkillDirs: remoteOpencodeSkillDirs,
  instructionsHome,
  instructionSources: (_def, home, _delivered, file) => ({
    delivered: file,
    summary: 'the files `instructions` lists in `~/.config/opencode/opencode.json`',
    files: [],
    ruleDirs: [],
    lists: {
      configs: [
        path.posix.join(home, '.config', 'opencode', 'opencode.json'),
        path.posix.join(home, '.config', 'opencode', 'opencode.jsonc'),
      ],
      entries: opencodeInstructions,
    },
  }),
};
