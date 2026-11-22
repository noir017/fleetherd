import { describe, expect, it } from 'vitest';
import {
  asksPerson,
  isApiAgent,
  levelDetail,
  levelMode,
  offeredLevels,
  offeredLevelsFor,
  parseLevel,
  unsetLevel,
} from './permission-levels.js';
import { parseConfig, PERMISSION_LEVELS, type AgentDef } from '../config/schema.js';

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

  it('offers ask and auto to a harness with no modes: the gateway can still put its requests to you', () => {
    expect(offeredLevels([])).toEqual(['ask', 'auto']);
    // Only the empty case. A harness that reports modes has said what it asks about, and ask is
    // offered only where one of those modes means it.
    expect(offeredLevels(['plan'])).toEqual(['plan', 'auto']);
  });
});

describe('offeredLevelsFor and isApiAgent', () => {
  const def = (agent: Record<string, unknown>): AgentDef =>
    parseConfig({ platforms: { discord: { type: 'discord', token: 't' } }, agents: [agent], routing: { default: String(agent['id']) } })
      .agents[0]!;

  it('reads the API agent off the command and its first argument', () => {
    expect(isApiAgent(def({ id: 'a', harness: 'custom', command: 'fleetherd', args: ['api-agent', 'antigravity'] }))).toBe(true);
    expect(isApiAgent(def({ id: 'a', harness: 'custom', command: '/opt/ua/bin/talkcode', args: ['api-agent', 'mailbox'] }))).toBe(true);
    // The same binary, not the api-agent: an ordinary custom harness keeps its levels.
    expect(isApiAgent(def({ id: 'a', harness: 'custom', command: 'fleetherd', args: [] }))).toBe(false);
    expect(isApiAgent(def({ id: 'a', harness: 'custom', command: 'my-agent', args: ['api-agent'] }))).toBe(false);
    expect(isApiAgent(def({ id: 'a', harness: 'claude' }))).toBe(false);
  });

  it('gives the API agent auto alone, whatever modes a probe reported', () => {
    const api = def({ id: 'a', harness: 'custom', command: 'fleetherd', args: ['api-agent', 'antigravity'] });
    expect(offeredLevelsFor(api, ['default', 'acceptEdits', 'plan', 'bypassPermissions'])).toEqual(['auto']);
    expect(offeredLevelsFor(def({ id: 'a', harness: 'agy' }), [])).toEqual(['ask', 'auto']);
  });
});

describe('unsetLevel', () => {
  const def = (options: Record<string, string>): AgentDef =>
    parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'a', harness: 'codex', options }],
      routing: { default: 'a' },
    }).agents[0]!;

  it('reads a pinned full-access mode as full, and anything else — or nothing — as auto', () => {
    expect(unsetLevel(def({ mode: 'agent-full-access' }))).toEqual({ level: 'full', from: 'pin' });
    expect(unsetLevel(def({ mode: 'bypassPermissions' }))).toEqual({ level: 'full', from: 'pin' });
    // CodeBuddy's own spelling of the same mode, which `full` maps to only where it is the first one.
    expect(unsetLevel(def({ mode: 'fullAccess' }))).toEqual({ level: 'full', from: 'pin' });
    expect(unsetLevel(def({ mode: 'plan' }))).toEqual({ level: 'auto', from: 'pin' });
    expect(unsetLevel(def({}))).toEqual({ level: 'auto', from: 'none' });
  });

  it('prefers the mode a live session reports over the pin', () => {
    // A session in full access is full even with no pin, and a pin the harness never took does not
    // make it full: the live mode is the one in force.
    expect(unsetLevel(def({}), 'bypassPermissions')).toEqual({ level: 'full', from: 'session' });
    expect(unsetLevel(def({ mode: 'bypassPermissions' }), 'plan')).toEqual({ level: 'auto', from: 'session' });
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
    // ask on a harness with no modes: only the gateway's half holds, so there is no mode to set.
    expect(levelMode('ask', [])).toBeUndefined();
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

  it('says only what the gateway can promise where there is no mode to set', () => {
    // A harness that asks nothing on its own: the level stops what it does ask, and nothing else.
    expect(levelDetail('ask', 'none')).toContain('only what it asks about');
    expect(levelDetail('ask', 'none')).toContain('what it does without asking is not stopped');
    // agy's measured behaviour: commands ask, writes do not.
    expect(levelDetail('ask', 'agy')).toContain('writes files without asking');
    // The other levels keep their own words; none of them is offered without a mode anyway.
    expect(levelDetail('auto', 'none')).toBe(levelDetail('auto'));
  });

  it('supports zh-CN locale for levelDetail and apiAgentDetail', () => {
    expect(levelDetail('plan', undefined, 'zh-CN')).toContain('计划');
    expect(levelDetail('ask', undefined, 'zh-CN')).toContain('确认');
    expect(levelDetail('ask', 'agy', 'zh-CN')).toContain('执行命令等待你确认');
    expect(levelDetail('ask', 'none', 'zh-CN')).toContain('仅所请求的操作等待你确认');
  });
});
