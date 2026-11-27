import { createRequire } from 'node:module';
import path from 'node:path';
import { instructionsHome } from '../../config/instructions.js';
import { claudeProjectsDir, remoteClaudeProjectsDir } from '../claude-transcript.js';
import { claudeReferences, resolveClaudeReference } from '../instruction-imports.js';
import { SESSION_FAILURE_CAPABILITY_META } from '../session-failure.js';
import type { HarnessProfile, SkillHome } from './profile.js';

/** Resolve the bundled `@agentclientprotocol/claude-agent-acp` entry script. Throws if node_modules is incomplete. */
export function resolveClaudeAdapterEntry(): string {
  return createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
}

/**
 * claude-agent-acp's per-session SDK options for review isolation (AGENTS.md invariant 8):
 * `tools: []` disables built-in tools, `settingSources: []` loads no operator settings/hooks/skills,
 * `strictMcpConfig: true` takes MCP servers from this request alone (none). `disableBuiltInTools` is kept for older adapters.
 */
export const CLAUDE_NO_TOOLS_META: Record<string, unknown> = {
  claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true } },
  disableBuiltInTools: true,
};

function claudeSkillHomes(home: string): SkillHome[] {
  return [{ dir: path.join(home, '.claude', 'skills'), requires: path.join(home, '.claude') }];
}

export const claudeProfile: HarnessProfile = {
  id: 'claude',
  launch: (def, remote = false) =>
    // Remote hosts run their own global install; the bundled adapter carries a platform-specific native build.
    remote
      ? { command: 'claude-agent-acp', args: [...def.args] }
      : { command: process.execPath, args: [resolveClaudeAdapterEntry(), ...def.args] },
  // Advertise typed failure records only for claude; opencode validates capabilities strictly.
  capabilityMeta: () => ({ ...SESSION_FAILURE_CAPABILITY_META }),
  reviewIsolation: {
    kind: 'acp',
    build: (_def, base) => ({ ...base, env: {}, meta: CLAUDE_NO_TOOLS_META }),
  },
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
