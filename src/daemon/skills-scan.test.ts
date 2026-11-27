import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { opencodeSkillDirs } from './harness/opencode.js';
import { agentHome } from './harness/profile.js';
import { scanSkillDirs, skillDirsFor } from './skills-scan.js';
import type { AgentDef } from '../config/schema.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * Reading skills off disk.
 *
 * The two properties that matter here are both ones the previous ACP-reporting version could not
 * have: this works before any agent has started, and it survives a daemon restart. What the tests
 * pin is the layout knowledge that makes it work — above all that entries are usually SYMLINKS
 * (25 of 26 on the machine this was written for), so an lstat-based directory check would find
 * nothing at all.
 */

const def = (over: Partial<AgentDef> = {}): AgentDef =>
  ({ id: 'a', harness: 'claude', args: [], env: {}, ...over }) as AgentDef;

/** A skill directory is one containing SKILL.md; make one. */
function makeSkill(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  return dir;
}

describe('agentHome', () => {
  it('honours a HOME override in the agent env', () => {
    // An agent running as another identity keeps its skills under that identity's home; scanning
    // the daemon's own home would quietly find an empty (but existing) tree.
    expect(agentHome(def({ env: { HOME: '/srv/other' } }))).toBe('/srv/other');
  });

  it('ignores an empty override rather than resolving to nothing', () => {
    expect(agentHome(def({ env: { HOME: '' } }))).not.toBe('');
  });
});

describe('skillDirsFor', () => {
  it('scans the user and project locations for claude', () => {
    const dirs = skillDirsFor(def(), { home: '/h', cwd: '/proj' });
    expect(dirs).toEqual(['/h/.claude/skills', '/proj/.claude/skills']);
  });

  it('collapses the two when the conversation sits in the home directory', () => {
    // A conversation that never used /cd can put the agent's cwd at the same place; listing the
    // directory twice would duplicate every skill in it.
    expect(skillDirsFor(def(), { home: '/h', cwd: '/h' })).toEqual(['/h/.claude/skills']);
  });

  it('scans the user and project locations for codex', () => {
    // Four, not two: `.agents/skills` is where a codex operator's skills actually live — the
    // `.codex/skills` tree holds codex's own bundled `.system` set and often nothing else — and
    // all four were confirmed by planting marker skills and reading the adapter's command list
    // back. See the note in skills-scan.ts, including why `.claude/skills` is absent.
    const dirs = skillDirsFor(def({ harness: 'codex' }), { home: '/h', cwd: '/proj' });
    expect(dirs).toEqual(['/h/.codex/skills', '/h/.agents/skills', '/proj/.codex/skills', '/proj/.agents/skills']);
  });

  it('uses only what opencode’s own config named', () => {
    // No convention is assumed for opencode: nothing was found that says it has one.
    const dirs = skillDirsFor(def({ harness: 'opencode' }), {
      home: '/h',
      cwd: '/proj',
      configured: ['/shared/skills'],
    });
    expect(dirs).toEqual(['/shared/skills']);
  });

  it('resolves a relative opencode entry against the working directory', () => {
    const dirs = skillDirsFor(def({ harness: 'opencode' }), {
      home: '/h',
      cwd: '/proj',
      configured: ['./local-skills'],
    });
    expect(dirs).toEqual(['/proj/local-skills']);
  });

  it('scans agy’s five locations, project copy first', () => {
    // Probed on agy 1.2.0: a skill under the home path and one under the conversation's own
    // directory both expand when typed, so both are listed; the project's is the more specific.
    expect(skillDirsFor(def({ harness: 'agy' }), { home: '/h', cwd: '/proj' })).toEqual([
      '/proj/.agents/skills',
      '/h/.agents/skills',
      '/h/.gemini/antigravity-cli/skills',
      '/h/.gemini/skills',
      '/h/.gemini/config/skills',
    ]);
  });

  it('collapses agy’s workspace and home paths when they are the same directory', () => {
    // The operator this was written for trusts their home directory as the workspace, so
    // `<cwd>/.agents/skills` and `<home>/.agents/skills` are one path and 25 skills would double.
    const dirs = skillDirsFor(def({ harness: 'agy' }), { home: '/h', cwd: '/h' });
    expect(dirs.filter((d) => d === '/h/.agents/skills')).toHaveLength(1);
  });

  it('returns nothing for a harness with no known location', () => {
    // dsh. Inventing a path would produce a confidently empty list instead of an honest
    // "this gateway does not know where to look".
    expect(skillDirsFor(def({ harness: 'dsh' }), { home: '/h', cwd: '/p' })).toEqual([]);
    expect(skillDirsFor(undefined, { home: '/h', cwd: '/p' })).toEqual([]);
  });
});

describe('scanSkillDirs', () => {
  it('finds a skill reached through a symlink', async () => {
    // THE case this has to get right: on the machine this was written for, 25 of 26 entries under
    // ~/.claude/skills are symlinks into a shared tree. stat, not lstat.
    const root = makeTempDir('skills-');
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    mkdirSync(linked);
    makeSkill(real, 'server-ops');
    symlinkSync(join(real, 'server-ops'), join(linked, 'server-ops'));

    const found = await scanSkillDirs([linked]);
    expect(found.map((s) => s.name)).toEqual(['server-ops']);
  });

  it('ignores a directory with no SKILL.md', async () => {
    const root = makeTempDir('skills-');
    makeSkill(root, 'real-skill');
    mkdirSync(join(root, 'references'));
    const found = await scanSkillDirs([root]);
    expect(found.map((s) => s.name)).toEqual(['real-skill']);
  });

  it('keeps the first copy of a shadowed name', async () => {
    // Both harnesses resolve a shadowed skill to the earlier directory in their search order, and
    // skillDirsFor returns them in that order. Listing both would claim two commands for one skill.
    const a = makeTempDir('skills-a-');
    const b = makeTempDir('skills-b-');
    makeSkill(a, 'shared');
    makeSkill(b, 'shared');
    const found = await scanSkillDirs([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toBe(a);
  });

  it('treats a missing directory as empty rather than failing the command', async () => {
    // A project with no .claude/skills is the common case, not an error.
    const root = makeTempDir('skills-');
    makeSkill(root, 'present');
    const found = await scanSkillDirs([join(root, 'nope'), root]);
    expect(found.map((s) => s.name)).toEqual(['present']);
  });

  it('sorts within a directory so the list does not reshuffle between calls', async () => {
    const root = makeTempDir('skills-');
    makeSkill(root, 'zebra');
    makeSkill(root, 'alpha');
    const found = await scanSkillDirs([root]);
    expect(found.map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('opencodeSkillDirs', () => {
  it('reads the skills array from opencode.json', async () => {
    const home = makeTempDir('oc-home-');
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: ['/shared/skills'] }));
    expect(await opencodeSkillDirs(home, {})).toEqual(['/shared/skills']);
  });

  it('honours XDG_CONFIG_HOME', async () => {
    const base = makeTempDir('oc-xdg-');
    const dir = join(base, 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: ['/x'] }));
    expect(await opencodeSkillDirs('/unused', { XDG_CONFIG_HOME: base })).toEqual(['/x']);
  });

  it('degrades to nothing on malformed JSON', async () => {
    // This runs inside a chat command: a broken config elsewhere must cost the catalogue, not the
    // gateway.
    const home = makeTempDir('oc-bad-');
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), '{ not json');
    expect(await opencodeSkillDirs(home, {})).toEqual([]);
  });

  it('degrades to nothing when skills is not an array of strings', async () => {
    const home = makeTempDir('oc-shape-');
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ skills: { a: 1 } }));
    expect(await opencodeSkillDirs(home, {})).toEqual([]);
  });

  it('is silent and empty when opencode is not configured at all', async () => {
    expect(await opencodeSkillDirs(makeTempDir('oc-none-'), {})).toEqual([]);
  });
});
