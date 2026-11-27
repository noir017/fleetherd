import path from 'node:path';
import { harnessKind, instructionsHome } from '../../config/instructions.js';
import { codebuddyReferences, resolveAgainstFile } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

function isCodebuddyCommand(command?: string): boolean {
  return ((command ?? '').split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase() === 'codebuddy';
}

function isCursorAgentCommand(command?: string): boolean {
  return ((command ?? '').split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase() === 'cursor-agent';
}

function codebuddySkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.codebuddy', 'skills'), requires: path.join(home, '.codebuddy') }];
}

export const customProfile: HarnessProfile = {
  id: 'custom',
  launch: (def) => {
    if (!def.command) throw new Error(`agent "${def.id}" is reached at ${def.connect?.url ?? '?'} (connect), not started`);
    return { command: def.command, args: [...def.args] };
  },
  // Probed 2026-11-10 on cursor-agent 2026.11.05: splits context/effort/fast into separate config options.
  capabilityMeta: (def) => (isCursorAgentCommand(def.command) ? { parameterizedModelPicker: true } : {}),
  reviewIsolation: 'operator-args',
  doctor: {
    command: (def) => def.command ?? '(custom harness: no command configured)',
  },
  setup: { promptCommand: true },
  // CodeBuddy Code, by the last segment of its command, has its own skills directory.
  skillHomes: (home, command) => (isCodebuddyCommand(command) ? codebuddySkillHomes(home) : []),
  skillReaders: [{ name: 'codebuddy', homes: codebuddySkillHomes }],
  skillHarnessName: (def) => (path.basename(def.command ?? '') === 'codebuddy' ? 'codebuddy' : 'custom'),
  skillScanDirs: () => [],
  instructionsHome,
  instructionSources: (def, home, delivered, file) => {
    if (harnessKind(def.harness, def.command) !== 'codebuddy') return undefined;
    return {
      delivered: file,
      summary: `\`@\` references in \`${delivered}\`, and \`~/.codebuddy/rules\``,
      files: [],
      ruleDirs: [path.posix.join(home, '.codebuddy', 'rules')],
      syntax: { references: codebuddyReferences, resolve: resolveAgainstFile, hops: 4 },
    };
  },
  instructionDisplayHarness: (layer) => layer ?? 'custom',
};
