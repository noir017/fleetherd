import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function codexSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.agents', 'skills'), requires: path.join(home, '.codex') }];
}

export const codexProfile: HarnessProfile = {
  id: 'codex',
  skillHomes: (home) => codexSkillHomes(home),
  skillReaders: [{ name: 'codex', homes: codexSkillHomes }],
  skillScanDirs: (opts) => [
    path.join(opts.home, '.codex', 'skills'),
    path.join(opts.home, '.agents', 'skills'),
    path.join(opts.cwd, '.codex', 'skills'),
    path.join(opts.cwd, '.agents', 'skills'),
  ],
  instructionsHome,
  instructionSources: (_def, home, _delivered, file) => ({
    delivered: file,
    summary: '`~/.codex/AGENTS.override.md`, when there is one',
    files: [
      {
        path: path.posix.join(home, '.codex', 'AGENTS.override.md'),
        note: 'codex reads this instead of AGENTS.md: while it exists, the gateway’s instructions do not reach codex',
      },
    ],
    ruleDirs: [],
  }),
};
