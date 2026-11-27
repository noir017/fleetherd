import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { claudeProjectsDir, remoteClaudeProjectsDir } from '../claude-transcript.js';
import { claudeReferences, resolveClaudeReference } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function claudeSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.claude', 'skills'), requires: path.join(home, '.claude') }];
}

export const claudeProfile: HarnessProfile = {
  id: 'claude',
  skillHomes: (home) => claudeSkillHomes(home),
  skillReaders: [{ name: 'claude', homes: claudeSkillHomes }],
  skillScanDirs: (opts) => [path.join(opts.home, '.claude', 'skills'), path.join(opts.cwd, '.claude', 'skills')],
  instructionsHome,
  instructionSources: (_def, home, delivered, file) => ({
    delivered: file,
    summary: `\`@\` references in \`${delivered}\`, and \`~/.claude/rules\``,
    files: [],
    ruleDirs: [path.posix.join(home, '.claude', 'rules')],
    syntax: { references: claudeReferences, resolve: resolveClaudeReference, hops: 4 },
  }),
  transcript: {
    projectsDir: claudeProjectsDir,
    remoteProjectsDir: remoteClaudeProjectsDir,
  },
};
