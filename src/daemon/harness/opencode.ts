import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { expandHome } from '../agent-common.js';
import { opencodeInstructions } from '../instruction-imports.js';
import { parseEnvJsonObject, type HarnessProfile, type SkillHome } from './profile.js';

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
  skillHomes: (home) => opencodeSkillHomes(home),
  skillReaders: [{ name: 'opencode', homes: opencodeSkillHomes }],
  skillScanDirs: (opts) =>
    // Relative entries resolve against the agent's working directory, matching opencode.json project paths.
    (opts.configured ?? []).map((p) => (path.isAbsolute(p) ? p : path.resolve(opts.cwd, expandHome(p)))),
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
