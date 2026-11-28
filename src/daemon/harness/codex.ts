import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { tCli } from '../../core/i18n/cli.js';
import { parseEnvJsonObject, type HarnessProfile, type SkillHome } from './profile.js';

/** The codex features that are a shell. Off, codex has no way to read or run anything (AGENTS.md invariant 8). */
const CODEX_NO_SHELL = { shell_tool: false, unified_exec: false };

function codexSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.agents', 'skills'), requires: path.join(home, '.codex') }];
}

export const codexProfile: HarnessProfile = {
  id: 'codex',
  gatewayEnvVar: 'OPENAI_BASE_URL',
  // PATH command (@agentclientprotocol/codex-acp), not bundled (~284 MB native binary).
  launch: (def) => ({ command: 'codex-acp', args: [...def.args] }),
  reviewIsolation: {
    kind: 'acp',
    build: (def, base) => {
      // Merged into the agent's own CODEX_CONFIG (provider/model), with shell features off last so they win.
      const own = parseEnvJsonObject(def.env['CODEX_CONFIG']);
      const ownFeatures = own['features'];
      const features = {
        ...(ownFeatures && typeof ownFeatures === 'object' && !Array.isArray(ownFeatures) ? ownFeatures : {}),
        ...CODEX_NO_SHELL,
      };
      // INITIAL_AGENT_MODE=read-only forces apply_patch to ask; refused permission cancels the turn.
      return { ...base, env: { CODEX_CONFIG: JSON.stringify({ ...own, features }), INITIAL_AGENT_MODE: 'read-only' } };
    },
  },
  doctor: {
    command: () => 'codex-acp',
    missingNote: (locale) => tCli(locale, 'doctor.detail.codexMissing'),
  },
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
