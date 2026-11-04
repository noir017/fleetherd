import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboundMessage, ToolEvent } from '../types.js';
import {
  beginSkillTurn,
  forgetSkillTurn,
  isAdmin,
  pathSkillNames,
  recordToolUse,
  skillToolName,
  slashSkill,
} from './skill-usage.js';
import { archiveSkill, createSkill, listSkills } from './skills-store.js';

let dir: string;
const T0 = Date.parse('2026-11-01T00:00:00Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'));
  for (const name of ['deploy-check', 'release-notes']) {
    createSkill({ name, description: `Use when handling ${name}`, now: T0 }, dir);
  }
});

afterEach(() => {
  forgetSkillTurn('c1');
  fs.rmSync(dir, { recursive: true, force: true });
});

const message = (content: string): InboundMessage => ({ content }) as InboundMessage;
const tool = (name: string, input: unknown, preview = ''): ToolEvent => ({ name, input, inputPreview: preview });
const uses = (name: string) => listSkills(dir, T0 + 1).find((s) => s.name === name)!;

describe('the three signals', () => {
  it('counts a Skill tool call naming the skill', () => {
    beginSkillTurn('c1', 'claude', [], dir);
    recordToolUse('c1', 'claude', tool('Skill', { skill: 'deploy-check' }), dir);
    expect(uses('deploy-check')).toMatchObject({ uses: 1, agents: ['claude'] });
    expect(uses('deploy-check').lastUsedAt).toBeTruthy();
  });

  it('counts a message that starts with /<name>', () => {
    beginSkillTurn('c1', 'codex', [message('/deploy-check the release')], dir);
    expect(uses('deploy-check')).toMatchObject({ uses: 1, agents: ['codex'] });
  });

  it('counts a tool call that touches a file under the skill directory', () => {
    beginSkillTurn('c1', 'opencode', [], dir);
    recordToolUse('c1', 'opencode', tool('Bash', { command: 'cat ~/.talkcode/skills/deploy-check/references/api.md' }), dir);
    recordToolUse('c1', 'opencode', tool('Read', { file_path: '/home/u/.talkcode/skills/release-notes/scripts/run.sh' }), dir);
    expect(uses('deploy-check').uses).toBe(1);
    expect(uses('release-notes').uses).toBe(1);
  });

  it('counts one use per turn however many times the skill appears', () => {
    beginSkillTurn('c1', 'claude', [message('/deploy-check')], dir);
    recordToolUse('c1', 'claude', tool('Skill', { skill: 'deploy-check' }), dir);
    recordToolUse('c1', 'claude', tool('Read', { file_path: '~/.talkcode/skills/deploy-check/SKILL.md' }), dir);
    expect(uses('deploy-check').uses).toBe(1);
    beginSkillTurn('c1', 'claude', [message('/deploy-check again')], dir);
    expect(uses('deploy-check').uses).toBe(2);
  });

  it('does not count an unknown skill, or one that is archived', () => {
    beginSkillTurn('c1', 'claude', [message('/not-a-skill')], dir);
    recordToolUse('c1', 'claude', tool('Skill', { skill: 'not-a-skill' }), dir);
    expect(uses('deploy-check').uses).toBe(0);
    archiveSkill('release-notes', dir, T0);
    beginSkillTurn('c1', 'claude', [message('/release-notes')], dir);
    expect(uses('release-notes').uses).toBe(0);
  });
});

describe('what is not a use', () => {
  it('does not count `talkcode skills` management, even when it reads a file', () => {
    beginSkillTurn('c1', 'claude', [], dir);
    recordToolUse(
      'c1',
      'claude',
      tool('Bash', { command: 'talkcode skills show deploy-check; cat ~/.talkcode/skills/deploy-check/SKILL.md' }),
      dir
    );
    expect(uses('deploy-check').uses).toBe(0);
    expect(isAdmin(tool('Bash', { command: 'talkcode skills list' }))).toBe(true);
    expect(isAdmin(tool('Bash', { command: 'echo talkcode skills' }))).toBe(true);
    expect(isAdmin(tool('Bash', { command: 'echo hi' }))).toBe(false);
  });

  it('still counts a Skill tool call whose args mention the management command', () => {
    beginSkillTurn('c1', 'claude', [], dir);
    recordToolUse('c1', 'claude', tool('Skill', { skill: 'deploy-check', args: 'talkcode skills list' }), dir);
    expect(uses('deploy-check').uses).toBe(1);
  });
});

describe('parsers', () => {
  it('reads a slash command only at the start', () => {
    expect(slashSkill('/deploy-check now')).toBe('deploy-check');
    expect(slashSkill('  /deploy-check')).toBe('deploy-check');
    expect(slashSkill('please /deploy-check')).toBeUndefined();
    expect(slashSkill('/deploy_check')).toBeUndefined();
  });

  it('reads the skill name from the fields harnesses use', () => {
    for (const input of [{ skill: 'deploy-check' }, { name: 'deploy-check' }, { command: '/deploy-check' }, 'deploy-check: now']) {
      expect(skillToolName(tool('Skill', input))).toBe('deploy-check');
    }
    expect(skillToolName(tool('Bash', { command: 'x' }))).toBeUndefined();
    expect(skillToolName(tool('skill', {}, 'deploy-check'))).toBe('deploy-check');
  });

  it('finds every managed skill mentioned by path, once', () => {
    const names = pathSkillNames(
      tool('Bash', {
        command: 'cat ~/.talkcode/skills/deploy-check/SKILL.md ~/.talkcode/skills/release-notes/references/a.md ~/.talkcode/skills/deploy-check/scripts/x.sh',
      })
    );
    expect(names.sort()).toEqual(['deploy-check', 'release-notes']);
  });
});
