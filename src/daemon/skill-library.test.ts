import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillLibrary, type LibraryAsker } from './skill-library.js';
import { readQueryEvents } from './skill-queries.js';
import { createSkill, listSkills, patchSkill, setResident, showSkill, writeSkillFile } from './skills-store.js';

let dir: string;
let library: SkillLibrary;
const T0 = Date.parse('2026-11-06T00:00:00Z');

const md = (name: string, description: string, meta: string, body: string): string =>
  `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n${meta}---\n\n${body}\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-library-'));
  library = new SkillLibrary(() => dir);
  createSkill({ name: 'server-ops', description: 'Use when operating a fleet server over SSH', body: 'Teleport and systemd.', now: T0 }, dir);
  setResident('server-ops', true, dir, T0);
  createSkill({ name: 'deploy-check', description: '部署完成后检查服务是否正常时使用', body: '依次检查健康接口。', now: T0 }, dir);
  writeSkillFile({ name: 'deploy-check', file: 'scripts/check.sh', content: '#!/bin/sh\n', now: T0 }, dir);
  createSkill({ name: 'agy-only', description: 'Use when configuring the agy server gateway', now: T0 }, dir);
  const v = showSkill('agy-only', undefined, dir).version;
  patchSkill({ name: 'agy-only', version: v, content: md('agy-only', 'Use when configuring the agy server gateway', '  talkcode-harnesses: "agy"\n  talkcode-category: "运维"\n', 'x'), now: T0 }, dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const codex: LibraryAsker = { conversation: 'web#main#a', generation: 0, agent: 'cx', host: 'uniagent', harness: 'codex' };

describe('search', () => {
  it('finds a library skill and says where its files are on the agent\'s machine', () => {
    const answer = library.search('检查部署', codex, T0);
    expect(answer.results[0]).toEqual({
      name: 'deploy-check',
      description: '部署完成后检查服务是否正常时使用',
      resident: false,
      path: '~/.talkcode/skills/deploy-check/SKILL.md',
    });
  });

  it('marks a resident hit as already in the agent\'s list', () => {
    const answer = library.search('fleet server ssh', codex, T0);
    expect(answer.results[0]).toMatchObject({ name: 'server-ops', resident: true, note: expect.stringMatching(/already in your skill list/) });
  });

  it('leaves out what does not reach the asking agent', () => {
    expect(library.search('agy gateway', codex, T0).results.map((r) => r.name)).not.toContain('agy-only');
    const agy = { ...codex, harness: 'agy' };
    expect(library.search('agy gateway', agy, T0).results[0]!.name).toBe('agy-only');
  });

  it('says what the library has when nothing matched, and logs the search either way', () => {
    const answer = library.search('quantum chromodynamics', codex, T0);
    expect(answer.results).toEqual([]);
    expect(answer.note).toMatch(/the library has: 运维 1, other 2/);
    library.search('检查部署', codex, T0 + 1);
    expect(readQueryEvents(dir).map((e) => (e.kind === 'search' ? [e.query, e.hits] : e.kind))).toEqual([
      ['quantum chromodynamics', []],
      ['检查部署', ['deploy-check']],
    ]);
    expect(library.missesOf('web#main#a', T0)).toEqual(['quantum chromodynamics']);
  });
});

describe('categories', () => {
  it('counts every skill by category, the uncategorized last', () => {
    expect(library.categories()).toEqual({
      total: 3,
      library: 2,
      categories: [
        { name: '运维', count: 1 },
        { name: 'other', count: 2 },
      ],
    });
  });
});

describe('show', () => {
  it('gives SKILL.md whole with the other files, and counts a use', () => {
    const shown = library.show('deploy-check', undefined, codex, false, T0) as Record<string, unknown>;
    expect(shown).toMatchObject({ name: 'deploy-check', file: 'SKILL.md', path: '~/.talkcode/skills/deploy-check', files: ['scripts/check.sh'] });
    expect(String(shown.content)).toContain('依次检查健康接口');
    expect(listSkills(dir).find((s) => s.name === 'deploy-check')).toMatchObject({ uses: 1, agents: ['cx'] });
  });

  it('answers "unchanged" for a version this conversation read, until --again, /new or a change', () => {
    library.show('deploy-check', undefined, codex, false, T0);
    expect(library.show('deploy-check', undefined, codex, false, T0 + 1)).toMatchObject({ unchanged: true });
    expect(library.show('deploy-check', undefined, codex, true, T0 + 2)).toMatchObject({ content: expect.any(String) });
    // Another conversation, or this one after /new, has not read it.
    expect(library.show('deploy-check', undefined, { ...codex, conversation: 'web#main#b' }, false, T0 + 3)).toHaveProperty('content');
    expect(library.show('deploy-check', undefined, { ...codex, generation: 1 }, false, T0 + 4)).toHaveProperty('content');
    // A new version is new to everyone.
    writeSkillFile({ name: 'deploy-check', file: 'references/more.md', content: 'more', now: T0 + 5 }, dir);
    expect(library.show('deploy-check', undefined, codex, false, T0 + 6)).toHaveProperty('content');
  });
});
