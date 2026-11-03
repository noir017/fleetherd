import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_SKILLS, allSkillDirs, bundledSkillDir, ensureSkillLink, linkSkill, skillHomes } from './skill-link.js';

/**
 * The skill link writes into SHARED directories (the operator's own `~/.claude/skills`), so these
 * tests run `linkSkill` against a throwaway home only, and pin that the guarded entry point does
 * nothing from a test worker — the failure mode the reverse-CLI shim already had once.
 */

let home: string;
let source: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-link-'));
  source = path.join(home, 'pkg', 'skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: talkcode\n---\n');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('skillHomes', () => {
  it('puts each harness where it was observed to read skills from', () => {
    expect(skillHomes('claude', '/h')).toEqual([{ dir: '/h/.claude/skills', requires: '/h/.claude' }]);
    for (const harness of ['codex', 'opencode'] as const) {
      expect(skillHomes(harness, '/h').map((s) => s.dir)).toEqual(['/h/.agents/skills']);
    }
    // Not the shared directory, and not the one agy's own help names — neither reached the model.
    expect(skillHomes('agy', '/h')).toEqual([{ dir: '/h/.gemini/config/skills', requires: '/h/.gemini/antigravity-cli' }]);
  });

  it('links nothing for a harness whose skill directory was never found', () => {
    for (const harness of ['gemini', 'dsh'] as const) expect(skillHomes(harness, '/h')).toEqual([]);
  });

  it('knows CodeBuddy by its command, since `custom` alone says nothing', () => {
    expect(skillHomes('custom', '/h', '/usr/local/bin/codebuddy')).toEqual([
      { dir: '/h/.codebuddy/skills', requires: '/h/.codebuddy' },
    ]);
    expect(skillHomes('custom', '/h', 'codebuddy')).toHaveLength(1);
    for (const command of ['/opt/other/thing', '', undefined]) expect(skillHomes('custom', '/h', command)).toEqual([]);
  });

  it('lists every directory a link of ours could be sitting in, for the sweep', () => {
    expect(allSkillDirs('/h').sort()).toEqual(
      ['/h/.agents/skills', '/h/.claude/skills', '/h/.codebuddy/skills', '/h/.gemini/config/skills'].sort()
    );
  });
});

describe('linkSkill', () => {
  const claude = () => skillHomes('claude', home)[0]!;

  it('leaves a harness that has never run here alone, rather than inventing its config directory', () => {
    expect(linkSkill(source, claude()).outcome).toBe('skipped');
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('creates the skills directory and the link once the harness has run', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    const r = linkSkill(source, claude());
    expect(r.outcome).toBe('linked');
    expect(fs.readlinkSync(r.link)).toBe(source);
    expect(fs.existsSync(path.join(r.link, 'SKILL.md'))).toBe(true);
    expect(linkSkill(source, claude()).outcome).toBe('current');
  });

  it('repoints its own link when it points elsewhere (an older install, a test daemon)', () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const link = path.join(home, '.claude', 'skills', 'talkcode');
    fs.symlinkSync('/old/install/skill', link);
    expect(linkSkill(source, claude())).toEqual({ link, outcome: 'relinked', detail: '/old/install/skill' });
    expect(fs.readlinkSync(link)).toBe(source);
  });

  it('never replaces a real directory: that is the operator\'s own copy', () => {
    const own = path.join(home, '.claude', 'skills', 'talkcode');
    fs.mkdirSync(own, { recursive: true });
    expect(linkSkill(source, claude())).toMatchObject({ outcome: 'occupied', detail: 'a directory' });
    expect(fs.lstatSync(own).isDirectory()).toBe(true);
  });
});

describe('ensureSkillLink', () => {
  it('does nothing from a test worker, which is not the CLI', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    expect(ensureSkillLink('claude', home)).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
  });
});

describe('bundledSkillDir', () => {
  it('is the package\'s skill/, where the SKILL.md ships', () => {
    expect(fs.existsSync(path.join(bundledSkillDir(), 'SKILL.md'))).toBe(true);
  });
});

describe('BUNDLED_SKILLS', () => {
  it('each ships a SKILL.md named as it is linked, in a directory the package publishes', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { files: string[] };
    for (const skill of BUNDLED_SKILLS) {
      const md = fs.readFileSync(path.join(bundledSkillDir(skill.dir), 'SKILL.md'), 'utf8');
      expect(md, skill.dir).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`));
      expect(pkg.files, skill.dir).toContain(skill.dir);
    }
  });

  it('links a second skill under its own name', () => {
    const source = bundledSkillDir('skill-super');
    fs.mkdirSync(path.join(home, '.claude'));
    const r = linkSkill(source, { dir: path.join(home, '.claude', 'skills'), requires: path.join(home, '.claude') }, 'super');
    expect(r).toEqual({ link: path.join(home, '.claude', 'skills', 'super'), outcome: 'linked' });
    expect(fs.realpathSync(r.link)).toBe(fs.realpathSync(source));
  });
});
