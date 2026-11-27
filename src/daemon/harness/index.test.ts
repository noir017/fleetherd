import { describe, expect, it } from 'vitest';
import { PERMISSION_LEVELS, type AgentDef } from '../../config/schema.js';
import { levelMode } from '../../core/permission-levels.js';
import type { Harness } from '../../types.js';
import { AGY_NO_TOOLS } from './agy.js';
import { CLAUDE_NO_TOOLS_META } from './claude.js';
import { HARNESSES } from './index.js';

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

describe('HARNESSES registry', () => {
  it('registers every Harness key with matching id, launch, reviewIsolation, and doctor', () => {
    expect(Object.keys(HARNESSES).sort()).toEqual([...ALL_HARNESSES].sort());
    for (const h of ALL_HARNESSES) {
      const profile = HARNESSES[h];
      expect(profile.id).toBe(h);
      expect(typeof profile.launch).toBe('function');
      expect(profile.reviewIsolation).toBeDefined();
      expect(typeof profile.doctor.command).toBe('function');
    }
  });

  it('marks custom, gemini, and dsh reviewIsolation explicitly as operator-args', () => {
    for (const h of ['custom', 'gemini', 'dsh'] as const) {
      expect(HARNESSES[h].reviewIsolation).toBe('operator-args');
    }
  });

  it('preserves security invariant 8 review-isolation switches for claude, codex, opencode, and agy', () => {
    const claudeIso = HARNESSES.claude.reviewIsolation;
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

    const codexIso = HARNESSES.codex.reviewIsolation;
    if (codexIso !== 'operator-args' && codexIso.kind === 'acp') {
      const launch = codexIso.build(agent('codex'), { command: 'codex-acp', args: [] });
      expect(launch.env['INITIAL_AGENT_MODE']).toBe('read-only');
      expect(JSON.parse(launch.env['CODEX_CONFIG'] ?? '{}')).toMatchObject({
        features: { shell_tool: false, unified_exec: false },
      });
    } else {
      expect.fail('codex reviewIsolation must be acp');
    }

    const ocIso = HARNESSES.opencode.reviewIsolation;
    if (ocIso !== 'operator-args' && ocIso.kind === 'acp') {
      const launch = ocIso.build(agent('opencode'), { command: 'opencode', args: ['acp'] });
      expect(JSON.parse(launch.env['OPENCODE_CONFIG_CONTENT'] ?? '{}')).toMatchObject({ permission: 'deny' });
    } else {
      expect.fail('opencode reviewIsolation must be acp');
    }

    const agyIso = HARNESSES.agy.reviewIsolation;
    if (agyIso !== 'operator-args' && agyIso.kind === 'agy-print') {
      expect(agyIso.settingsJson).toBe(AGY_NO_TOOLS);
      const parsed = JSON.parse(agyIso.settingsJson) as { permissions: { deny: string[] } };
      expect(parsed.permissions.deny).not.toContain('*');
      expect(parsed.permissions.deny).toEqual(
        expect.arrayContaining(['write_file(*)', 'read_file(*)', 'command(*)', 'mcp(*)'])
      );
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
    expect(HARNESSES.agy.omitPermissionModes).toBe(true);
  });
});
