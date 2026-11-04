import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSkillsPanel } from './skills-panel.js';
import type { SkillPanelDetail, SkillPanelResult } from '../platform/adapter.js';
import { skillDir, type SkillRecord } from './skills-store.js';

/**
 * The daemon's side of the web UI's skills page.
 *
 * The store's own rules are `skills-store.test.ts`'s; what is pinned here is the seam: the page's
 * shape, the store's sentence handed back unchanged when it refuses, and the archive notice — the
 * one thing the panel adds over calling the store, because a skill archived from a page must tell
 * the conversation that created it exactly as `talkcode skills archive` does.
 */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-panel-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const build = (notifyArchived?: (skill: SkillRecord) => void) => buildSkillsPanel({ dir, notifyArchived });

const detail = (result: SkillPanelResult): SkillPanelDetail => {
  if (!result.ok) throw new Error(result.error);
  if (!result.detail) throw new Error('no detail');
  return result.detail;
};

describe('skills panel', () => {
  it('creates, lists and opens a skill with its files and first history entry', () => {
    const panel = build();
    expect(panel.list()).toEqual([]);

    const created = panel.op({ action: 'create', name: 'deploy-check', description: 'Use when checking a deployment', body: '# Steps' });
    expect(created).toMatchObject({
      ok: true,
      skills: [expect.objectContaining({ name: 'deploy-check', status: 'active', pinned: false, uses: 0 })],
    });

    const shown = detail(panel.op({ action: 'show', name: 'deploy-check' }));
    expect(shown.skill).toMatchObject({ name: 'deploy-check', status: 'active', pinned: false });
    expect(shown.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(shown.file).toMatchObject({ path: 'SKILL.md' });
    expect(shown.file!.content).toContain('description: "Use when checking a deployment"');
    expect(shown.file!.version).toBe(shown.skill.version);
    expect(shown.history).toHaveLength(1);
    expect(shown.history[0]).toMatchObject({ action: 'create' });
    expect(shown.history[0]!.beforeVersion).toBeUndefined();
  });

  it('hands back the store refusal when patch carries a stale version', () => {
    const panel = build();
    panel.op({ action: 'create', name: 'deploy-check', description: 'Use when checking a deployment' });
    const first = detail(panel.op({ action: 'show', name: 'deploy-check' }));
    const next = '---\nname: deploy-check\ndescription: "second"\n---\n\nsecond\n';
    expect(panel.op({ action: 'patch', name: 'deploy-check', version: first.file!.version, content: next }).ok).toBe(true);

    const stale = panel.op({ action: 'patch', name: 'deploy-check', version: first.file!.version, content: next });
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/version mismatch/) });
  });

  it('edits an extra file, records it, and reverts the whole skill to a snapshot', () => {
    const panel = build();
    panel.op({ action: 'create', name: 'deploy-check', description: 'Use when checking a deployment' });
    const created = detail(panel.op({ action: 'show', name: 'deploy-check' }));
    expect(panel.op({ action: 'write-file', name: 'deploy-check', file: 'references/api.md', content: 'API' }).ok).toBe(true);

    const withFile = detail(panel.op({ action: 'show', name: 'deploy-check', file: 'references/api.md' }));
    expect(withFile.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/api.md']);
    expect(withFile.file).toMatchObject({ path: 'references/api.md', content: 'API' });

    const patch = withFile.history.find((h) => h.action === 'write-file')!;
    expect(panel.op({ action: 'revert', name: 'deploy-check', id: patch.id }).ok).toBe(true);
    const back = detail(panel.op({ action: 'show', name: 'deploy-check' }));
    expect(back.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(back.skill.version).toBe(created.skill.version);
    expect(back.history[0]).toMatchObject({ action: 'revert', note: `revert ${patch.id}` });

    expect(panel.op({ action: 'remove-file', name: 'deploy-check', file: 'references/api.md' }).ok).toBe(false);
  });

  it('archives with a notice, lists the archived copy, and restores it', () => {
    const told: string[] = [];
    const panel = build((skill) => told.push(`${skill.name}:${skill.status}`));
    panel.op({ action: 'create', name: 'deploy-check', description: 'Use when checking a deployment' });
    panel.op({ action: 'write-file', name: 'deploy-check', file: 'templates/report.md', content: 'report' });

    const archived = panel.op({ action: 'archive', name: 'deploy-check' });
    expect(archived).toMatchObject({ ok: true, skills: [expect.objectContaining({ name: 'deploy-check', status: 'archived' })] });
    expect(told).toEqual(['deploy-check:archived']);
    expect(fs.existsSync(skillDir('deploy-check', dir))).toBe(false);

    // Reading an archived skill lists the files from `.archive/`, not the (now absent) live dir.
    const shown = detail(panel.op({ action: 'show', name: 'deploy-check', file: 'templates/report.md' }));
    expect(shown.skill.status).toBe('archived');
    expect(shown.files.map((f) => f.path)).toEqual(['SKILL.md', 'templates/report.md']);
    expect(shown.file!.content).toBe('report');

    expect(panel.op({ action: 'restore', name: 'deploy-check' }).ok).toBe(true);
    expect(panel.list()).toEqual([expect.objectContaining({ name: 'deploy-check', status: 'active' })]);
    expect(told).toEqual(['deploy-check:archived']);
  });

  it('pins and unpins, and reports an unknown skill as the store does', () => {
    const panel = build();
    panel.op({ action: 'create', name: 'deploy-check', description: 'Use when checking a deployment' });
    expect(panel.op({ action: 'pin', name: 'deploy-check', pinned: true })).toMatchObject({
      ok: true,
      skills: [expect.objectContaining({ pinned: true })],
    });
    expect(panel.op({ action: 'pin', name: 'deploy-check', pinned: false })).toMatchObject({
      ok: true,
      skills: [expect.objectContaining({ pinned: false })],
    });
    expect(panel.op({ action: 'show', name: 'nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/no skill named/) });
  });
});
