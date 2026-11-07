import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitSync } from './skills-git.js';
import {
  MAX_SKILL_BYTES,
  activeSkillFiles,
  archiveSkill,
  archivedSkillNames,
  conversationSkillFiles,
  createSkill,
  listSkills,
  listSkillFiles,
  patchSkill,
  pinSkill,
  removeSkillFile,
  repoRoot,
  restoreSkill,
  setResident,
  frontmatterMetadata,
  skillMetaOf,
  revertSkill,
  showSkill,
  skillDir,
  skillHistory,
  skillVersion,
  validateFilePath,
  validateSkillName,
  writeSkillFile,
} from './skills-store.js';

/** The store writes only under a temp config directory; nothing here touches the live gateway. */

let dir: string;
const T0 = Date.parse('2026-11-01T00:00:00Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const create = (name = 'deploy-check', extra: { body?: string; description?: string } = {}) =>
  createSkill({ name, description: extra.description ?? 'Use when checking a deployment', body: extra.body, now: T0 }, dir);

describe('rules', () => {
  it('accepts lowercase words joined by hyphens, and nothing else', () => {
    for (const name of ['deploy', 'deploy-check', 'a1-b2']) expect(validateSkillName(name)).toBe(name);
    for (const name of ['Deploy', 'deploy_check', 'deploy check', '-deploy', 'deploy-', 'deploy--check', '', '../x']) {
      expect(() => validateSkillName(name), name).toThrow(/lowercase/);
    }
    expect(() => validateSkillName('a'.repeat(65))).toThrow(/too long/);
  });

  it('will not let a managed skill shadow the bundled two', () => {
    for (const name of ['talkcode', 'super']) expect(() => validateSkillName(name)).toThrow(/bundled/);
    expect(() => createSkill({ name: 'super', description: 'x', now: T0 }, dir)).toThrow(/bundled/);
  });

  it('allows extra files only under the three directories', () => {
    expect(validateFilePath('references/api.md')).toBe('references/api.md');
    expect(validateFilePath('./scripts/run.sh')).toBe('scripts/run.sh');
    expect(validateFilePath('templates/report.md')).toBe('templates/report.md');
    for (const file of ['SKILL.md', 'other/a.md', '../x/a.md', 'references/../a.md', '/etc/passwd', 'references', 'a/b.md']) {
      expect(() => validateFilePath(file), file).toThrow(/files may only|stay inside|needs a name|use "\/"/);
    }
  });

  it('refuses a SKILL.md over 64 KB, or one a harness would not list', () => {
    expect(() => create('deploy-check', { body: 'x'.repeat(MAX_SKILL_BYTES) })).toThrow(/over the 65536-byte limit/);
    const skill = create();
    const version = showSkill(skill.name, undefined, dir).version;
    expect(() => patchSkill({ name: skill.name, version, content: 'no frontmatter', now: T0 }, dir)).toThrow(/frontmatter/);
    expect(() =>
      patchSkill({ name: skill.name, version, content: '---\nname: other\ndescription: x\n---\n', now: T0 }, dir)
    ).toThrow(/but this skill is "deploy-check"/);
    expect(() =>
      patchSkill({ name: skill.name, version, content: '---\nname: deploy-check\ndescription: ""\n---\n', now: T0 }, dir)
    ).toThrow(/non-empty description/);
  });
});

describe('create and show', () => {
  it('writes SKILL.md and a usage record with the source conversation', () => {
    const source = { conversation: 'c1', platform: 'tg', address: { channel: '1' }, agent: 'claude' };
    const skill = createSkill({ name: 'deploy-check', description: 'Use when checking a deployment', body: '# Steps', source, now: T0 }, dir);
    expect(skill.version).toMatch(/^[0-9a-f]{12}$/);
    expect(skill.status).toBe('active');
    expect(skill.uses).toBe(0);
    const md = fs.readFileSync(path.join(skillDir('deploy-check', dir), 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^---\nname: deploy-check\ndescription: "Use when checking a deployment"\n---\n\n# Steps\n$/);
    expect(showSkill('deploy-check', undefined, dir)).toMatchObject({ name: 'deploy-check', file: 'SKILL.md', content: md });
    const usage = JSON.parse(fs.readFileSync(path.join(dir, 'skills-usage.json'), 'utf8')) as { skills: Record<string, { source: unknown }> };
    expect(usage.skills['deploy-check']!.source).toEqual(source);
  });

  it('files a skill under the category it is created with, and refuses one that is not a short label', () => {
    createSkill({ name: 'agy-config', description: 'Use when configuring agy', category: ' 运维 ', now: T0 }, dir);
    const md = fs.readFileSync(path.join(skillDir('agy-config', dir), 'SKILL.md'), 'utf8');
    expect(md).toBe('---\nname: agy-config\ndescription: "Use when configuring agy"\nmetadata:\n  talkcode-category: "运维"\n---\n\n');
    expect(listSkills(dir).find((s) => s.name === 'agy-config')).toMatchObject({ category: '运维', resident: false });
    expect(() => createSkill({ name: 'b-skill', description: 'd', category: 'a, b', now: T0 }, dir)).toThrow(/may not contain/);
    expect(() => createSkill({ name: 'c-skill', description: 'd', category: 'x'.repeat(21), now: T0 }, dir)).toThrow(/too long/);
    expect(() => createSkill({ name: 'd-skill', description: 'd', category: '  ', now: T0 }, dir)).toThrow(/empty/);
  });

  it('refuses a duplicate name and points at the archived copy when there is one', () => {
    create();
    expect(() => create()).toThrow(/already exists/);
    archiveSkill('deploy-check', dir, T0);
    expect(() => create()).toThrow(/archived; restore it/);
  });

  it('shows an archived skill and its version', () => {
    const skill = create();
    const version = skill.version;
    archiveSkill(skill.name, dir, T0);
    expect(showSkill(skill.name, undefined, dir)).toMatchObject({ version, status: 'archived' });
    expect(() => showSkill(skill.name, 'references/missing.md', dir)).toThrow(/has no references\/missing.md/);
  });

  it('lists only delivered files for an archived skill, ignoring one an agent left at its root', () => {
    const skill = create();
    writeSkillFile({ name: skill.name, file: 'references/api.md', content: 'API', now: T0 + 1 }, dir);
    // What an agent can leave with a shell command: not a file `show` can open, because a file
    // path must be SKILL.md or one of the three directories.
    fs.writeFileSync(path.join(skillDir(skill.name, dir), 'notes.txt'), 'hand-written');
    archiveSkill(skill.name, dir, T0 + 2);

    expect(listSkillFiles(skill.name, dir).map((f) => f.path)).toEqual(['SKILL.md', 'references/api.md']);
    expect(() => showSkill(skill.name, 'notes.txt', dir)).toThrow(/files may only go in/);
  });
});

describe('patch', () => {
  it('is refused unless it names the version show printed', () => {
    const skill = create();
    const next = '---\nname: deploy-check\ndescription: "Use when checking a deployment"\n---\n\nnew body\n';
    expect(() => patchSkill({ name: skill.name, version: '000000000000', content: next, now: T0 + 1 }, dir)).toThrow(/version mismatch/);
    const patched = patchSkill({ name: skill.name, version: skill.version, content: next, now: T0 + 1 }, dir);
    expect(patched.version).not.toBe(skill.version);
    expect(showSkill(skill.name, undefined, dir).content).toBe(next);
    // The old version is now stale: a second write must read again.
    expect(() => patchSkill({ name: skill.name, version: skill.version, content: next, now: T0 + 2 }, dir)).toThrow(/version mismatch/);
  });

  it('rejects a patch to a skill that is archived', () => {
    const skill = create();
    archiveSkill(skill.name, dir, T0);
    expect(() => patchSkill({ name: skill.name, version: skill.version, content: '', now: T0 }, dir)).toThrow(/archived/);
  });
});

describe('extra files', () => {
  it('writes and removes a reference, changing the version each time', () => {
    const skill = create();
    const withRef = writeSkillFile({ name: skill.name, file: 'references/api.md', content: 'API', now: T0 + 1 }, dir);
    expect(withRef.version).not.toBe(skill.version);
    expect(fs.readFileSync(path.join(skillDir(skill.name, dir), 'references', 'api.md'), 'utf8')).toBe('API');
    const without = removeSkillFile({ name: skill.name, file: 'references/api.md', now: T0 + 2 }, dir);
    expect(without.version).toBe(skill.version);
    expect(fs.existsSync(path.join(skillDir(skill.name, dir), 'references'))).toBe(false);
    expect(() => removeSkillFile({ name: skill.name, file: 'references/api.md', now: T0 + 3 }, dir)).toThrow(/has no file/);
  });

  it('keeps a script executable and refuses one over the size cap', () => {
    const skill = create();
    writeSkillFile({ name: skill.name, file: 'scripts/run.sh', content: '#!/bin/sh\n', now: T0 + 1 }, dir);
    expect(fs.statSync(path.join(skillDir(skill.name, dir), 'scripts', 'run.sh')).mode & 0o777).toBe(0o700);
    expect(() =>
      writeSkillFile({ name: skill.name, file: 'references/big.md', content: 'x'.repeat(1024 * 1024 + 1), now: T0 + 2 }, dir)
    ).toThrow(/over the 1048576-byte limit/);
  });
});

describe('history and revert', () => {
  it('keeps the version before every change and puts it back on revert', () => {
    const first = create();
    const second = patchSkill({
      name: first.name,
      version: first.version,
      content: '---\nname: deploy-check\ndescription: "second"\n---\n\nsecond\n',
      now: T0 + 1,
    }, dir);
    const third = writeSkillFile({ name: first.name, file: 'references/a.md', content: 'a', now: T0 + 2 }, dir);
    expect(third.version).not.toBe(second.version);

    const history = skillHistory(first.name, dir);
    expect(history.map((h) => h.action)).toEqual(['write-file', 'patch', 'create']);
    const patchEntry = history.find((h) => h.action === 'patch')!;
    expect(patchEntry).toMatchObject({ beforeVersion: first.version, afterVersion: second.version });
    expect(history.find((h) => h.action === 'create')!.beforeVersion).toBeUndefined();

    const reverted = revertSkill(first.name, patchEntry.id, dir, T0 + 3);
    expect(reverted.skill.version).toBe(first.version);
    expect(showSkill(first.name, undefined, dir).content).toContain('Use when checking a deployment');
    // The file added after that patch is gone too: the snapshot is the whole skill.
    expect(fs.existsSync(path.join(skillDir(first.name, dir), 'references', 'a.md'))).toBe(false);
    expect(skillHistory(first.name, dir)[0]).toMatchObject({ action: 'revert', note: `revert ${patchEntry.id}` });
  });

  it('has nothing to revert to for the first version', () => {
    const skill = create();
    const createEntry = skillHistory(skill.name, dir).find((h) => h.action === 'create')!;
    expect(() => revertSkill(skill.name, createEntry.id, dir, T0 + 1)).toThrow(/nothing before it/);
    expect(() => revertSkill(skill.name, 'no-such-entry', dir, T0 + 1)).toThrow(/no history entry/);
  });

  it('reverts a skill that is archived back into use', () => {
    const first = create();
    const second = patchSkill({
      name: first.name,
      version: first.version,
      content: '---\nname: deploy-check\ndescription: "second"\n---\n\nsecond\n',
      now: T0 + 1,
    }, dir);
    const patchEntry = skillHistory(first.name, dir).find((h) => h.action === 'patch')!;
    archiveSkill(first.name, dir, T0 + 2);
    expect(archivedSkillNames(dir)).toEqual([first.name]);
    const reverted = revertSkill(first.name, patchEntry.id, dir, T0 + 3);
    expect(reverted.skill.status).toBe('active');
    expect(archivedSkillNames(dir)).toEqual([]);
    expect(skillVersion(first.name, dir)).toBe(first.version);
    expect(second.version).not.toBe(first.version);
  });
});

describe('archive, restore and pin', () => {
  it('moves a skill to .archive, never deletes it, and restores it with a fresh clock', () => {
    const skill = create();
    const archived = archiveSkill(skill.name, dir, T0 + 30 * 86_400_000);
    expect(archived.status).toBe('archived');
    expect(fs.existsSync(skillDir(skill.name, dir))).toBe(false);
    expect(archivedSkillNames(dir)).toEqual([skill.name]);
    expect(listSkills(dir, T0 + 31 * 86_400_000)).toEqual([expect.objectContaining({ name: skill.name, status: 'archived' })]);
    const restored = restoreSkill(skill.name, dir, T0 + 40 * 86_400_000);
    expect(restored.status).toBe('active');
    expect(restored.restoredAt).toBe(new Date(T0 + 40 * 86_400_000).toISOString());
    expect(fs.existsSync(path.join(skillDir(skill.name, dir), 'SKILL.md'))).toBe(true);
    expect(() => restoreSkill(skill.name, dir, T0 + 41 * 86_400_000)).toThrow(/already active/);
  });

  it('pins a skill and unpins it', () => {
    const skill = create();
    expect(pinSkill(skill.name, true, dir)).toMatchObject({ pinned: true, status: 'active' });
    expect(pinSkill(skill.name, false, dir)).toMatchObject({ pinned: false });
    expect(() => pinSkill('nope', true, dir)).toThrow(/no skill named/);
  });
});

describe('a skill changed by hand in the repository', () => {
  const PERSON = { GIT_AUTHOR_NAME: 'person', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'person', GIT_COMMITTER_EMAIL: 'p@x' };
  const byHand = (rel: string, content: string, message: string): void => {
    const file = path.join(repoRoot(dir), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    gitSync(repoRoot(dir), ['add', '-A']);
    gitSync(repoRoot(dir), ['commit', '-q', '-m', message], PERSON);
  };

  it('is listed in history with its author, and can be reverted like the gateway\'s own change', () => {
    const first = create();
    byHand('skills/deploy-check/SKILL.md', '---\nname: deploy-check\ndescription: by hand\n---\n', 'docs: rewrite deploy-check');
    const history = skillHistory('deploy-check', dir);
    expect(history[0]).toMatchObject({ action: 'commit', author: 'person', note: 'docs: rewrite deploy-check' });
    expect(history[1]).toMatchObject({ action: 'create', author: 'talkcode' });

    revertSkill('deploy-check', history[0]!.id, dir, T0 + 1);
    expect(skillVersion('deploy-check', dir)).toBe(first.version);
  });

  it('is never delivered when it breaks the store\'s rules, and says why', () => {
    create();
    byHand('skills/broken-one/SKILL.md', 'no frontmatter at all\n', 'feat: broken');
    byHand('skills/talkcode/SKILL.md', '---\nname: talkcode\ndescription: shadow\n---\n', 'feat: shadow');
    expect(activeSkillFiles(dir).map((s) => s.name)).toEqual(['deploy-check']);
    const listed = listSkills(dir);
    expect(listed.find((s) => s.name === 'broken-one')!.problem).toMatch(/frontmatter/);
    expect(listed.find((s) => s.name === 'talkcode')!.problem).toMatch(/bundled/);
    expect(listed.find((s) => s.name === 'deploy-check')!.problem).toBeUndefined();
  });

  it('can be pinned although the gateway never recorded it', () => {
    create();
    byHand('skills/hand-made/SKILL.md', '---\nname: hand-made\ndescription: Use when by hand\n---\n', 'feat: hand-made');
    expect(pinSkill('hand-made', true, dir)).toMatchObject({ name: 'hand-made', pinned: true, status: 'active' });
  });
});

describe('conversationSkillFiles', () => {
  const by = (conversation: string) => ({ kind: 'agent' as const, agent: 'cc', conversation });

  it('is the files one conversation\'s commits changed since a time, newest first, still there', () => {
    create('server-ops');
    create('mail');
    writeSkillFile({ name: 'server-ops', file: 'references/old.md', content: 'before the window', now: T0 + 1_000, by: by('telegram#1') }, dir);
    writeSkillFile({ name: 'server-ops', file: 'references/grant.md', content: 'a', now: T0 + 10_000, by: by('telegram#1') }, dir);
    writeSkillFile({ name: 'mail', file: 'references/api.md', content: 'b', now: T0 + 11_000, by: by('telegram#1') }, dir);
    writeSkillFile({ name: 'mail', file: 'references/gone.md', content: 'c', now: T0 + 12_000, by: by('telegram#1') }, dir);
    removeSkillFile({ name: 'mail', file: 'references/gone.md', now: T0 + 13_000 }, dir);
    // `telegram#12` starts with `telegram#1`: --grep would match it, the trailer comparison does not.
    writeSkillFile({ name: 'mail', file: 'references/other.md', content: 'd', now: T0 + 14_000, by: by('telegram#12') }, dir);
    expect(conversationSkillFiles('telegram#1', T0 + 5_000, dir)).toEqual([
      { name: 'mail', file: 'references/api.md' },
      { name: 'server-ops', file: 'references/grant.md' },
    ]);
  });

  it('leaves out an archived skill, and is empty with no repository', () => {
    expect(conversationSkillFiles('telegram#1', 0, dir)).toEqual([]);
    create('server-ops');
    writeSkillFile({ name: 'server-ops', file: 'references/a.md', content: 'a', now: T0 + 1_000, by: by('telegram#1') }, dir);
    archiveSkill('server-ops', dir, T0 + 2_000);
    expect(conversationSkillFiles('telegram#1', 0, dir)).toEqual([]);
  });
});

describe('resident and library', () => {
  const md = (meta: string, description = 'Use when checking a deployment'): string =>
    `---\nname: deploy-check\ndescription: "${description}"\n${meta}---\n\nbody\n`;

  it('reads the tier, category and conditions from the metadata block, skipping deeper maps', () => {
    const text = md('metadata:\n  talkcode-resident: "true"\n  talkcode-category: "运维"\n  hermes:\n    tags: [a, b]\n  talkcode-hosts: "uniagent, awsfree2"\nversion: 1.0\n');
    expect(frontmatterMetadata(text)).toEqual(
      new Map([
        ['talkcode-resident', 'true'],
        ['talkcode-category', '运维'],
        ['talkcode-hosts', 'uniagent, awsfree2'],
      ])
    );
    expect(skillMetaOf(new Map([['SKILL.md', Buffer.from(text)]]))).toEqual({ resident: true, category: '运维', hosts: ['uniagent', 'awsfree2'] });
    expect(skillMetaOf(new Map([['SKILL.md', Buffer.from(md(''))]]))).toEqual({ resident: false });
  });

  it('is library when created, and a person makes it resident and back', () => {
    const skill = create();
    expect(skill.resident).toBe(false);
    const resident = setResident(skill.name, true, dir, T0 + 1);
    expect(resident.resident).toBe(true);
    expect(showSkill(skill.name, undefined, dir).content).toMatch(/metadata:\n {2}talkcode-resident: "true"\n---/);
    expect(skillHistory(skill.name, dir)[0]).toMatchObject({ action: 'resident', author: 'talkcode-web' });
    const back = setResident(skill.name, false, dir, T0 + 2);
    expect(back.resident).toBe(false);
    // Absence is the library tier: the line goes, and an emptied block goes with it.
    expect(showSkill(skill.name, undefined, dir).content).not.toContain('metadata:');
    expect(back.version).toBe(skill.version);
  });

  it('keeps the rest of a metadata block when the tier changes', () => {
    const skill = create();
    patchSkill({ name: skill.name, version: skill.version, content: md('metadata:\n  talkcode-category: "运维"\n'), now: T0 + 1 }, dir);
    setResident(skill.name, true, dir, T0 + 2);
    expect(listSkills(dir)[0]).toMatchObject({ resident: true, category: '运维' });
    setResident(skill.name, false, dir, T0 + 3);
    expect(listSkills(dir)[0]).toMatchObject({ resident: false, category: '运维' });
  });

  it('refuses an agent\'s or the review\'s patch that changes the tier, and takes a person\'s', () => {
    const skill = create();
    const promote = md('metadata:\n  talkcode-resident: "true"\n');
    expect(() => patchSkill({ name: skill.name, version: skill.version, content: promote, now: T0 + 1 }, dir)).toThrow(/only a person/);
    expect(() =>
      patchSkill({ name: skill.name, version: skill.version, content: promote, by: { kind: 'review', agent: 'ag' }, now: T0 + 1 }, dir)
    ).toThrow(/only a person/);
    expect(patchSkill({ name: skill.name, version: skill.version, content: promote, by: { kind: 'person' }, now: T0 + 1 }, dir).resident).toBe(true);
    // And an agent cannot demote what a person chose, either.
    const v = showSkill(skill.name, undefined, dir).version;
    expect(() => patchSkill({ name: skill.name, version: v, content: md(''), now: T0 + 2 }, dir)).toThrow(/only a person/);
  });

  it('holds a resident description to one short line, and says so about a hand-made one', () => {
    const skill = create('deploy-check', { description: 'x'.repeat(121) });
    expect(() => setResident(skill.name, true, dir, T0 + 1)).toThrow(/at most 120 characters, this one is 121/);
    // Characters, not bytes: 120 Chinese characters fit.
    const ok = create('cn-skill', { description: '运'.repeat(120) });
    expect(setResident(ok.name, true, dir, T0 + 1).resident).toBe(true);
    // A person's commit can still push a long one; it is delivered, with a warning to see.
    const file = path.join(skillDir('deploy-check', dir), 'SKILL.md');
    fs.writeFileSync(file, md('metadata:\n  talkcode-resident: "true"\n', 'y'.repeat(130)));
    gitSync(repoRoot(dir), ['add', '-A']);
    gitSync(repoRoot(dir), ['commit', '-q', '-m', 'by hand'], { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' });
    const listed = listSkills(dir).find((s) => s.name === 'deploy-check')!;
    expect(listed.problem).toBeUndefined();
    expect(listed.warning).toMatch(/130 characters/);
  });
});
