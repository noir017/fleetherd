import { describe, expect, it } from 'vitest';
import { PERMISSION_LEVELS, REVIEW_ARGS_HARNESSES, type AgentDef } from '../../config/schema.js';
import { HARNESS_FACTS } from '../../core/harness-facts.js';
import { levelMode } from '../../core/permission-levels.js';
import type { Harness } from '../../types.js';
import { AGY_NO_TOOLS } from './agy.js';
import { CLAUDE_NO_TOOLS_META } from './claude.js';
import { HARNESS_PROFILES } from './index.js';

const ALL_HARNESSES: readonly Harness[] = ['claude', 'codex', 'agy', 'opencode', 'gemini', 'dsh', 'custom'];

function agent(harness: Harness, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: `test-${harness}`,
    harness,
    ...(harness === 'custom' ? { command: 'my-agent' } : {}),
    args: [],
    env: {},
    options: {},
    ...overrides,
  } as AgentDef;
}

describe('HARNESS_PROFILES registry', () => {
  it('registers every Harness key with matching id, launch, reviewIsolation, and doctor', () => {
    expect(Object.keys(HARNESS_PROFILES).sort()).toEqual([...ALL_HARNESSES].sort());
    for (const h of ALL_HARNESSES) {
      const profile = HARNESS_PROFILES[h];
      expect(profile.id).toBe(h);
      expect(typeof profile.launch).toBe('function');
      expect(profile.reviewIsolation).toBeDefined();
      expect(typeof profile.doctor.command).toBe('function');
    }
  });

  it('matches REVIEW_ARGS_HARNESSES exactly to the operator-args reviewIsolation set', () => {
    for (const h of ['custom', 'gemini', 'dsh'] as const) {
      expect(HARNESS_PROFILES[h].reviewIsolation).toBe('operator-args');
    }
    const operatorArgsHarnesses = ALL_HARNESSES.filter((h) => HARNESS_PROFILES[h].reviewIsolation === 'operator-args');
    expect([...REVIEW_ARGS_HARNESSES].sort()).toEqual([...operatorArgsHarnesses].sort());
  });

  it('preserves security invariant 8 review-isolation switches for claude, codex, opencode, and agy', () => {
    const claudeIso = HARNESS_PROFILES.claude.reviewIsolation;
    expect(claudeIso).not.toBe('operator-args');
    if (claudeIso !== 'operator-args' && claudeIso.kind === 'acp') {
      const launch = claudeIso.build(agent('claude'), { command: 'claude-agent-acp', args: [] });
      expect(launch.meta).toEqual(CLAUDE_NO_TOOLS_META);
      expect((launch.meta as { claudeCode: { options: unknown } }).claudeCode.options).toEqual({
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
      });
    } else {
      expect.fail('claude reviewIsolation must be acp');
    }

    const codexIso = HARNESS_PROFILES.codex.reviewIsolation;
    if (codexIso !== 'operator-args' && codexIso.kind === 'acp') {
      const launch = codexIso.build(agent('codex'), { command: 'codex-acp', args: [] });
      expect(launch.env['INITIAL_AGENT_MODE']).toBe('read-only');
      expect(JSON.parse(launch.env['CODEX_CONFIG'] ?? '{}')).toMatchObject({
        features: { shell_tool: false, unified_exec: false },
      });
    } else {
      expect.fail('codex reviewIsolation must be acp');
    }

    const ocIso = HARNESS_PROFILES.opencode.reviewIsolation;
    if (ocIso !== 'operator-args' && ocIso.kind === 'acp') {
      const launch = ocIso.build(agent('opencode'), { command: 'opencode', args: ['acp'] });
      expect(JSON.parse(launch.env['OPENCODE_CONFIG_CONTENT'] ?? '{}')).toMatchObject({ permission: 'deny' });
    } else {
      expect.fail('opencode reviewIsolation must be acp');
    }

    const agyIso = HARNESS_PROFILES.agy.reviewIsolation;
    if (agyIso !== 'operator-args' && agyIso.kind === 'agy-print') {
      expect(agyIso.settingsJson).toBe(AGY_NO_TOOLS);
      const parsed = JSON.parse(agyIso.settingsJson) as { permissions: { deny: string[] } };
      expect(parsed.permissions.deny).not.toContain('*');
      expect(parsed.permissions.deny).toEqual([
        'write_file(*)',
        'read_file(*)',
        'list_dir(*)',
        'search(*)',
        'command(*)',
        'url(*)',
        'browser(*)',
        'mcp(*)',
      ]);
    } else {
      expect.fail('agy reviewIsolation must be agy-print');
    }
  });

  it('never maps any permission level to harness-internal auto-answer modes (claude auto / codex agent)', () => {
    const claudeModes = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'];
    const codexModes = ['read-only', 'workspace-write', 'agent', 'agent-full-access'];
    for (const level of PERMISSION_LEVELS) {
      expect(levelMode(level, claudeModes)).not.toBe('auto');
      expect(levelMode(level, codexModes)).not.toBe('agent');
    }
    expect(HARNESS_FACTS.agy.ignoresSessionModes).toBe(true);
  });
});
