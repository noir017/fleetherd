import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { RemoteHosts } from './remote-hosts.js';
import { applyManagedSkills, managedSkillsHome, placeManagedSkills } from './managed-skills.js';
import { archiveSkill, createSkill, patchSkill, showSkill, writeSkillFile } from './skills-store.js';

/**
 * Delivery writes into a throwaway HOME, as skill-link.test.ts does: `applyManagedSkills` is the
 * unguarded half, and `placeManagedSkills` must do nothing from a test worker.
 */

let home: string;
let dir: string;
const T0 = Date.parse('2026-11-01T00:00:00Z');

const claude = { id: 'cc', harness: 'claude', env: {} } as unknown as AgentDef;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-skills-'));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-skills-gw-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  createSkill({ name: 'deploy-check', description: 'Use when checking a deployment', now: T0 }, dir);
  writeSkillFile({ name: 'deploy-check', file: 'references/api.md', content: 'API', now: T0 + 1 }, dir);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const copy = () => path.join(managedSkillsHome(home), 'deploy-check');
const link = () => path.join(home, '.claude', 'skills', 'deploy-check');

describe('applyManagedSkills', () => {
  it('copies the files read-only and links the skill into the harness directory', () => {
    const results = applyManagedSkills(claude, home, dir);
    expect(fs.readFileSync(path.join(copy(), 'SKILL.md'), 'utf8')).toContain('Use when checking a deployment');
    expect(fs.readFileSync(path.join(copy(), 'references', 'api.md'), 'utf8')).toBe('API');
    expect(fs.statSync(path.join(copy(), 'SKILL.md')).mode & 0o777).toBe(0o444);
    expect(fs.readlinkSync(link())).toBe(copy());
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'deploy-check', outcome: 'placed', path: copy() }),
        expect.objectContaining({ name: 'deploy-check', outcome: 'linked', path: link() }),
      ])
    );
  });

  it('does not rewrite a version that has not changed', () => {
    applyManagedSkills(claude, home, dir);
    const before = fs.statSync(path.join(copy(), 'SKILL.md')).mtimeMs;
    const again = applyManagedSkills(claude, home, dir);
    expect(again.every((r) => r.outcome === 'current')).toBe(true);
    expect(fs.statSync(path.join(copy(), 'SKILL.md')).mtimeMs).toBe(before);
  });

  it('replaces the copy when the skill changes, and removes a file that was removed', () => {
    applyManagedSkills(claude, home, dir);
    const shown = showSkill('deploy-check', undefined, dir);
    patchSkill(
      { name: 'deploy-check', version: shown.version, content: '---\nname: deploy-check\ndescription: "new"\n---\n\nnew\n', now: T0 + 2 },
      dir
    );
    applyManagedSkills(claude, home, dir);
    expect(fs.readFileSync(path.join(copy(), 'SKILL.md'), 'utf8')).toContain('new');
  });

  it('leaves a real directory or a foreign link in the harness directory alone', () => {
    createSkill({ name: 'blocked', description: 'x', now: T0 }, dir);
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'blocked'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync('/somewhere/else', path.join(home, '.claude', 'skills', 'deploy-check'));
    const results = applyManagedSkills(claude, home, dir);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'blocked', outcome: 'occupied', detail: 'a directory' }),
        expect.objectContaining({ name: 'deploy-check', outcome: 'occupied', detail: 'a link to /somewhere/else' }),
      ])
    );
    expect(fs.readlinkSync(path.join(home, '.claude', 'skills', 'deploy-check'))).toBe('/somewhere/else');
    expect(fs.readdirSync(path.join(home, '.claude', 'skills', 'blocked'))).toEqual([]);
  });

  it('takes back its copy and every link of ours when a skill is archived', () => {
    applyManagedSkills(claude, home, dir);
    // A link made for another harness, which this spawn would never look at.
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(copy(), path.join(home, '.agents', 'skills', 'deploy-check'), 'dir');
    archiveSkill('deploy-check', dir, T0 + 2);
    const results = applyManagedSkills(claude, home, dir);
    expect(fs.existsSync(copy())).toBe(false);
    expect(fs.existsSync(link())).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'deploy-check'))).toBe(false);
    expect(results.some((r) => r.outcome === 'removed')).toBe(true);
  });

  it('does nothing from a test worker, which is not the CLI', () => {
    expect(placeManagedSkills(claude, home)).toEqual([]);
    expect(fs.existsSync(managedSkillsHome(home))).toBe(false);
  });
});

describe('placeManagedSkills on a remote host', () => {
  class FakeHost {
    readonly id = 'h1';
    readonly writes: string[] = [];
    readonly links = new Map<string, string>();
    readonly removed: string[] = [];
    async writeFile(p: string): Promise<void> {
      this.writes.push(p);
    }
    async ensureLink(target: string, link: string): Promise<{ outcome: string; link: string }> {
      this.links.set(link, target);
      return { outcome: 'linked', link };
    }
    async removeLink(link: string): Promise<{ outcome: string; link: string }> {
      this.removed.push(link);
      this.links.delete(link);
      return { outcome: 'removed', link };
    }
  }

  const welcome = (instance: string): Welcome => ({
    version: '2.30.0',
    instance,
    home: '/home/u',
    pid: 1,
    os: 'linux',
    arch: 'amd64',
    resumed: false,
  });

  it('writes once per version, and links into the harness directories with `owned`', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.writes).toContain('/home/u/.talkcode/skills/deploy-check/SKILL.md');
    expect(host.writes).toContain('/home/u/.talkcode/skills/deploy-check/references/api.md');
    expect(host.links.get('/home/u/.claude/skills/deploy-check')).toBe('/home/u/.talkcode/skills/deploy-check');
    const written = host.writes.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.writes).toHaveLength(written);
  });

  it('re-sends after a change, and re-places for a new gateway instance', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    const written = host.writes.length;
    const shown = showSkill('deploy-check', undefined, dir);
    patchSkill(
      { name: 'deploy-check', version: shown.version, content: '---\nname: deploy-check\ndescription: "new"\n---\n\nnew\n', now: T0 + 2 },
      dir
    );
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.writes.length).toBeGreaterThan(written);
    const afterChange = host.writes.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i2'), dir);
    expect(host.writes.length).toBeGreaterThan(afterChange);
  });

  it('takes back an archived skill in every directory, then remembers it', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    archiveSkill('deploy-check', dir, T0 + 2);
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.removed).toContain('/home/u/.claude/skills/deploy-check');
    expect(host.removed).toContain('/home/u/.agents/skills/deploy-check');
    const removed = host.removed.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.removed).toHaveLength(removed);
  });
});
