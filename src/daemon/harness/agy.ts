import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { tCli } from '../../core/i18n/cli.js';
import { agySplitModel } from '../agy-acp.js';
import { AGY_COMMAND } from '../agy-cli.js';
import { agyRelay } from '../agy-relay.js';
import { agyTranscriptPath, readAgyContext } from '../agy-transcript.js';
import { agyReferences, agyRuleNote, resolveAgyReference } from '../instruction-imports.js';
import type { HarnessProfile, SkillHome } from './profile.js';

/**
 * Explicit permission-class deny list for `agy -p --settings` review isolation (AGENTS.md invariant 8).
 * Measured on agy 1.5.0/1.5.2 (2026-11-04/07): `deny: ["*"]` denies nothing (literal class name) and
 * `agy acp` ignores `--settings`, so every class must be listed explicitly on `agy -p`.
 */
export const AGY_NO_TOOLS = JSON.stringify({
  permissions: {
    deny: [
      'write_file(*)',
      'read_file(*)',
      'list_dir(*)',
      'search(*)',
      'command(*)',
      'url(*)',
      'browser(*)',
      'mcp(*)',
    ],
  },
});

function agySkillHomes(home: string): SkillHome[] {
  // Probed 2026-10-09 on agy 1.3.2: `~/.gemini/config/skills` is what agy reads, not `antigravity-cli/skills`.
  return [{ dir: path.join(home, '.gemini', 'config', 'skills'), requires: path.join(home, '.gemini', 'antigravity-cli') }];
}

export const agyProfile: HarnessProfile = {
  id: 'agy',
  // agy >= 1.5 native ACP server; permissions arrive via session/request_permission (never --dangerously-skip-permissions).
  launch: (def) => ({ command: AGY_COMMAND, args: ['acp', ...def.args] }),
  startupHint: ' (`agy acp` needs agy 1.5 or later — check `agy --version` on that machine and upgrade it)',
  reviewIsolation: { kind: 'agy-print', settingsJson: AGY_NO_TOOLS },
  doctor: {
    command: () => AGY_COMMAND,
    authNote: (def, locale) =>
      def.env?.AGY_LLM_GATEWAY_URL ? tCli(locale, 'doctor.auth.agyGateway') : tCli(locale, 'doctor.auth.agyKeyring'),
  },
  splitModelOption: agySplitModel,
  // Measured on agy 1.5.1: session/load and session/resume answer on agy's default model.
  forgetsModelOnLoad: true,
  // Measured 2026-11-06/18: agy's `default` mode writes without asking, so permission levels stay ask/auto only.
  omitPermissionModes: true,
  // Measured 2026-11-14 on agy 1.5.8: unadvertised prompt queueing mid-turn.
  takesPromptMidTurn: true,
  usesAgyTurnWatch: true,
  hasBuiltinQuota: true,
  hasBuiltinCli: true,
  contextMissingHint:
    ' agy reports usage once per turn, summed over every model call in it, so after a turn that ran tools the count comes from its transcript on the agent\'s machine, and is missing when that cannot be read; and agy never says how big its window is, so the daemon measures the context against where agy compacts, which it knows for the models it was measured on (Gemini 3.8 Flash, Claude Sonnet/Opus 4.6, GPT-OSS 120B) — any other model shows no numbers.',
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
