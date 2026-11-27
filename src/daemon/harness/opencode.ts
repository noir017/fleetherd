import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { expandHome } from '../agent-common.js';
import { opencodeInstructions } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function opencodeSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.agents', 'skills'), requires: path.join(home, '.config', 'opencode') }];
}

export const opencodeProfile: HarnessProfile = {
  id: 'opencode',
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
