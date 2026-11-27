import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { agySplitModel } from '../agy-acp.js';
import { AGY_COMMAND } from '../agy-cli.js';
import { agyRelay } from '../agy-relay.js';
import { agyTranscriptPath, readAgyContext } from '../agy-transcript.js';
import { agyReferences, agyRuleNote, resolveAgyReference } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function agySkillHomes(home: string): SkillHome[] {
  // Probed 2026-10-09 on agy 1.3.2: `~/.gemini/config/skills` is what agy reads, not `antigravity-cli/skills`.
  return [{ dir: path.join(home, '.gemini', 'config', 'skills'), requires: path.join(home, '.gemini', 'antigravity-cli') }];
}

export const agyProfile: HarnessProfile = {
  id: 'agy',
  // agy >= 1.5 native ACP server; permissions arrive via session/request_permission (never --dangerously-skip-permissions).
  launch: (def) => ({ command: AGY_COMMAND, args: ['acp', ...def.args] }),
  startupHint: ' (`agy acp` needs agy 1.5 or later — check `agy --version` on that machine and upgrade it)',
  splitModelOption: agySplitModel,
  // Measured on agy 1.5.1: session/load and session/resume answer on agy's default model.
  forgetsModelOnLoad: true,
  // Measured 2026-11-06/18: agy's `default` mode writes without asking, so permission levels stay ask/auto only.
  omitPermissionModes: true,
  relay: agyRelay,
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
