import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepSkills } from './skill-lifecycle.js';
import { archiveSkill, archivedSkillNames, createSkill, listSkills, pinSkill, recordSkillUse, restoreSkill, skillDir } from './skills-store.js';

let dir: string;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const DAY = 86_400_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-lifecycle-'));
  createSkill(
    { name: 'deploy-check', description: 'Use when checking a deployment', source: { conversation: 'c1', platform: 'tg', address: { channel: '1' } }, now: T0 },
    dir
  );
  createSkill({ name: 'release-notes', description: 'Use when writing release notes', now: T0 }, dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = (name: string, now: number) => listSkills(dir, now).find((s) => s.name === name)!;

describe('14 days expired, 30 archived', () => {
  it('does nothing before 14 days', () => {
    expect(sweepSkills(T0 + 13 * DAY, dir)).toEqual({ expired: [], archived: [] });
    expect(status('deploy-check', T0 + 13 * DAY).status).toBe('active');
  });

  it('marks expired at 14 days without moving the skill', () => {
    const swept = sweepSkills(T0 + 14 * DAY, dir);
    expect(swept.expired).toEqual(['deploy-check', 'release-notes']);
    expect(status('deploy-check', T0 + 14 * DAY).status).toBe('expired');
    expect(fs.existsSync(path.join(skillDir('deploy-check', dir), 'SKILL.md'))).toBe(true);
  });

  it('archives at 30 days, keeps the files, and tells the source conversation', () => {
    const notify = vi.fn();
    const swept = sweepSkills(T0 + 30 * DAY, dir, notify);
    expect(swept.archived.map((s) => s.name).sort()).toEqual(['deploy-check', 'release-notes']);
    expect(archivedSkillNames(dir).sort()).toEqual(['deploy-check', 'release-notes']);
    expect(fs.existsSync(path.join(skillDir('deploy-check', dir), 'SKILL.md'))).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
    const deploy = notify.mock.calls.find((c) => (c[0] as { name: string }).name === 'deploy-check')!;
    expect(deploy[1]).toBe('unused');
    expect((deploy[0] as { source?: unknown }).source).toMatchObject({ conversation: 'c1' });
    const notes = notify.mock.calls.find((c) => (c[0] as { name: string }).name === 'release-notes')!;
    expect((notes[0] as { source?: unknown }).source).toBeUndefined();
  });

  it('does not archive twice', () => {
    sweepSkills(T0 + 30 * DAY, dir);
    expect(sweepSkills(T0 + 60 * DAY, dir)).toEqual({ expired: [], archived: [] });
  });
});

describe('pinned and restored', () => {
  it('leaves a pinned skill alone however old it is', () => {
    pinSkill('deploy-check', true, dir);
    const swept = sweepSkills(T0 + 365 * DAY, dir);
    expect(swept.archived.map((s) => s.name)).toEqual(['release-notes']);
    expect(status('deploy-check', T0 + 365 * DAY)).toMatchObject({ status: 'active', pinned: true });
  });

  it('starts a restored skill\'s clock again', () => {
    archiveSkill('deploy-check', dir, T0 + 31 * DAY);
    restoreSkill('deploy-check', dir, T0 + 40 * DAY);
    // 20 days after the restore is still inside 30, even though the skill was created long ago.
    expect(sweepSkills(T0 + 60 * DAY, dir).archived.map((s) => s.name)).not.toContain('deploy-check');
    // 31 days after the restore is not.
    expect(sweepSkills(T0 + 71 * DAY, dir).archived.map((s) => s.name)).toContain('deploy-check');
  });

  it('brings an expired skill back when it is used', () => {
    sweepSkills(T0 + 14 * DAY, dir);
    expect(status('deploy-check', T0 + 14 * DAY).status).toBe('expired');
    recordSkillUse('deploy-check', 'claude', 'slash', dir, T0 + 15 * DAY);
    expect(status('deploy-check', T0 + 15 * DAY).status).toBe('active');
  });
});
