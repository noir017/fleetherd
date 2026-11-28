import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { tCli } from '../../core/i18n/cli.js';
import { agySplitModel } from '../agy-acp.js';
import { AGY_COMMAND, runAgyCliCommand, runAgyCliFor, type AgyCliRunner } from '../agy-cli.js';
import { parseAgyUsagePools } from '../agy-meters.js';
import { agyRelay } from '../agy-relay.js';
import { agyTranscriptPath, readAgyContext } from '../agy-transcript.js';
import { agyReferences, agyRuleNote, resolveAgyReference } from '../instruction-imports.js';
import type { HarnessProfile, HarnessQuota, SkillHome } from './profile.js';

/** agy's own `agy -p=/usage`, for an agy signed in to Google; `local` is injectable for tests. */
export function agyQuota(local: AgyCliRunner = runAgyCliCommand): HarnessQuota {
  return {
    async read(def, cwd) {
      const r = await runAgyCliFor(def, 'usage', cwd, local);
      if (!r.ok) return { ok: false, reason: r.error };
      const pools = parseAgyUsagePools(r.output);
      return pools ? { ok: true, pools } : { ok: false, reason: 'agy -p=/usage printed no quota' };
    },
  };
}

/**
 * Every permission class the CLI knows, denied. `"*"` is NOT a wildcard here — measured on agy
 * 1.5.0, `deny: ["*"]` matched nothing and `write_file` still wrote a file — so each class is
 * named. The reviewer reads nothing and writes nothing: everything it needs is in the prompt.
 *
 * An unknown class in this list is ignored by the CLI (it logs "ignoring invalid deny entry"), so
 * adding one costs nothing; a NEW tool class in a future agy is not covered, which is why the
 * security note in AGENTS.md calls this list part of the contract. On agy 1.5.2 (2026-11-07)
 * `list_dir`, `search`, `url` and `browser` are such unknown entries: listing, searching and
 * fetching all went through `run_command` and `read_file` instead, and were denied there.
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
  // Measured on agy 1.5.1: `gpt-oss-120b-medium` came back from `session/load` and `session/resume`
  // on `gemini-3.8-flash-high`, so the configured model must be re-applied after every load.
  forgetsModelOnLoad: true,
  // Measured 2026-11-14 on agy 1.5.8 (project-scripts/agy-bg-probe/probe-hold.mjs): accepts a
  // second `session/prompt` mid-turn at tool boundaries without advertising `promptQueueing`.
  // ⚠️ HYRUM'S LAW: unadvertised behaviour. If a release refuses a second prompt like opencode
  // does, the turn fails with that refusal in chat; this is the line to take out.
  takesPromptMidTurn: true,
  usesAgyTurnWatch: true,
  quota: agyQuota(),
  contextMissingHint:
    ' agy reports usage once per turn, summed over every model call in it, so after a turn that ran tools the count comes from its transcript on the agent\'s machine, and is missing when that cannot be read; and agy never says how big its window is, so the daemon measures the context against where agy compacts, which it knows for the models it was measured on (Gemini 3.8 Flash, Claude Sonnet/Opus 4.6, GPT-OSS 120B) — any other model shows no numbers.',
  relay: agyRelay,
  gatewayEnvVar: 'AGY_LLM_GATEWAY_URL',
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
