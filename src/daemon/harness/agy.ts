import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { agyTranscriptPath, readAgyContext } from '../agy-transcript.js';
import { agyReferences, agyRuleNote, resolveAgyReference } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function agySkillHomes(home: string): SkillHome[] {
  // Probed 2026-10-09 on agy 1.3.2: `~/.gemini/config/skills` is what agy reads, not `antigravity-cli/skills`.
  return [{ dir: path.join(home, '.gemini', 'config', 'skills'), requires: path.join(home, '.gemini', 'antigravity-cli') }];
}

export const agyProfile: HarnessProfile = {
  id: 'agy',
  skillHomes: (home) => agySkillHomes(home),
  skillReaders: [{ name: 'agy', homes: agySkillHomes }],
  skillScanDirs: (opts) => [
    path.join(opts.cwd, '.agents', 'skills'),
    path.join(opts.home, '.agents', 'skills'),
    path.join(opts.home, '.gemini', 'antigravity-cli', 'skills'),
    path.join(opts.home, '.gemini', 'skills'),
    path.join(opts.home, '.gemini', 'config', 'skills'),
  ],
  pluginHome: (home) => ({
    dir: path.join(home, '.gemini', 'config', 'plugins'),
    requires: path.join(home, '.gemini', 'antigravity-cli'),
  }),
  instructionsHome,
  instructionSources: (_def, home, _delivered, file) => ({
    delivered: file,
    summary: '`~/.gemini` instruction files and rules, and their `@[label](path)` includes',
    files: [
      { path: path.posix.join(home, '.gemini', 'AGENTS.md') },
      { path: path.posix.join(home, '.gemini', 'GEMINI.md') },
      { path: path.posix.join(home, '.gemini', 'config', 'GEMINI.md') },
    ],
    ruleDirs: [path.posix.join(home, '.gemini', 'config', 'rules')],
    ruleNote: agyRuleNote,
    syntax: { references: agyReferences, resolve: (ref, f, h) => resolveAgyReference(ref, f, h), hops: 1 },
  }),
  transcript: {
    transcriptPath: agyTranscriptPath,
    readContext: readAgyContext,
  },
};
