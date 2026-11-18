import { describe, expect, it } from 'vitest';
import { asksPerson, levelDetail, levelMode, offeredLevels, parseLevel } from './permission-levels.js';
import { PERMISSION_LEVELS } from '../config/schema.js';

/**
 * The level table. The mode lists are what each harness reported on 2026-11-18
 * (project-reports/acp-permission-modes-20261118.md); the expectations below are the mapping table
 * the docs print, so a change here is a change to what a person is offered.
 */

const CLAUDE = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const CLAUDE_AS_ROOT = ['default', 'acceptEdits', 'plan', 'auto'];
const CODEX = ['read-only', 'workspace-write', 'agent', 'agent-full-access'];
const OPENCODE = ['build', 'plan'];
const CODEBUDDY = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'fullAccess'];

describe('asksPerson', () => {
  it('asks under plan, ask and edits; approves under auto, full and no level at all', () => {
    expect(PERMISSION_LEVELS.filter(asksPerson)).toEqual(['plan', 'ask', 'edits']);
    expect(asksPerson(undefined)).toBe(false);
  });
});

describe('offeredLevels', () => {
  it('offers each harness the levels it has a mode for, most asked first', () => {
    expect(offeredLevels(CLAUDE)).toEqual(['plan', 'ask', 'edits', 'auto', 'full']);
    expect(offeredLevels(CLAUDE_AS_ROOT)).toEqual(['plan', 'ask', 'edits', 'auto']);
    expect(offeredLevels(CODEX)).toEqual(['ask', 'edits', 'auto', 'full']);
    expect(offeredLevels(OPENCODE)).toEqual(['plan', 'auto']);
    expect(offeredLevels(CODEBUDDY)).toEqual(['plan', 'ask', 'edits', 'auto', 'full']);
  });

  it('offers auto alone to a harness with no modes: approving is the gateway’s whatever the harness has', () => {
    expect(offeredLevels([])).toEqual(['auto']);
  });
});

describe('levelMode', () => {
  it('maps each level to the mode that means it on each harness', () => {
    const table = (modes: string[]) => Object.fromEntries(offeredLevels(modes).map((l) => [l, levelMode(l, modes)]));
    expect(table(CLAUDE)).toEqual({ plan: 'plan', ask: 'default', edits: 'acceptEdits', auto: 'default', full: 'bypassPermissions' });
    expect(table(CODEX)).toEqual({ ask: 'read-only', edits: 'workspace-write', auto: 'workspace-write', full: 'agent-full-access' });
    expect(table(OPENCODE)).toEqual({ plan: 'plan', auto: 'build' });
    expect(table(CODEBUDDY)).toEqual({ plan: 'plan', ask: 'default', edits: 'acceptEdits', auto: 'default', full: 'bypassPermissions' });
  });

  it('never maps to a harness’s own reviewer mode, where requests are answered inside it', () => {
    for (const modes of [CLAUDE, CODEX, CODEBUDDY]) {
      for (const level of PERMISSION_LEVELS) expect(['auto', 'agent', 'dontAsk']).not.toContain(levelMode(level, modes));
    }
  });

  it('leaves the mode alone with no level, or none on offer', () => {
    expect(levelMode(undefined, CLAUDE)).toBeUndefined();
    expect(levelMode('plan', CODEX)).toBeUndefined();
    expect(levelMode('full', CLAUDE_AS_ROOT)).toBeUndefined();
  });

  it('takes a pinned options.mode as where auto goes, and only auto', () => {
    expect(levelMode('auto', CODEX, 'agent-full-access')).toBe('agent-full-access');
    expect(levelMode('ask', CODEX, 'agent-full-access')).toBe('read-only');
    // A pin the session does not offer leaves the mode alone rather than guessing another.
    expect(levelMode('auto', CODEX, 'nope')).toBeUndefined();
  });
});

describe('parseLevel and levelDetail', () => {
  it('reads a level whatever its case, and nothing else', () => {
    expect(parseLevel(' Edits ')).toBe('edits');
    expect(parseLevel('yolo')).toBeUndefined();
  });

  it('says what every level does', () => {
    for (const level of PERMISSION_LEVELS) expect(levelDetail(level).length).toBeGreaterThan(10);
  });
});
