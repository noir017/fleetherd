import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { RemoteHosts } from './remote-hosts.js';
import { applyManagedSkills, managedSkillsHome, placeManagedSkills } from './managed-skills.js';
import { archiveSkill, createSkill, patchSkill, removeSkillFile, setResident, showSkill, writeSkillFile } from './skills-store.js';

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
  // Resident, as a person would make it: only a resident skill is linked.
  setResident('deploy-check', true, dir, T0 + 1);
});

/** A new SKILL.md for deploy-check that keeps it resident: an agent's patch may not change that. */
const residentMd = (description: string, body: string): string =>
  `---\nname: deploy-check\ndescription: "${description}"\nmetadata:\n  talkcode-resident: "true"\n---\n\n${body}\n`;

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
      { name: 'deploy-check', version: shown.version, content: residentMd('new', 'new'), now: T0 + 2 },
      dir
    );
    applyManagedSkills(claude, home, dir);
    expect(fs.readFileSync(path.join(copy(), 'SKILL.md'), 'utf8')).toContain('new');
  });

  it('leaves a real directory or a foreign link in the harness directory alone', () => {
    createSkill({ name: 'blocked', description: 'x', now: T0 }, dir);
    setResident('blocked', true, dir, T0);
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

describe('the library tier and who a skill reaches', () => {
  it('copies a library skill for the search to point at, but never links it', () => {
    createSkill({ name: 'release-notes', description: 'Use when writing release notes', now: T0 }, dir);
    applyManagedSkills(claude, home, dir);
    expect(fs.existsSync(path.join(managedSkillsHome(home), 'release-notes', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'release-notes'))).toBe(false);
  });

  it('takes back the link of a skill a person moved to the library', () => {
    applyManagedSkills(claude, home, dir);
    expect(fs.readlinkSync(link())).toBe(copy());
    setResident('deploy-check', false, dir, T0 + 2);
    const results = applyManagedSkills(claude, home, dir);
    expect(fs.existsSync(link())).toBe(false);
    expect(fs.existsSync(path.join(copy(), 'SKILL.md'))).toBe(true);
    expect(results).toContainEqual(expect.objectContaining({ name: 'deploy-check', outcome: 'removed', path: link() }));
  });

  it('gives a skill with hosts or harnesses only to the agents they name', () => {
    const md = (name: string, meta: string): string => `---\nname: ${name}\ndescription: "x"\nmetadata:\n  talkcode-resident: "true"\n${meta}---\n`;
    createSkill({ name: 'codex-only', description: 'x', now: T0 }, dir);
    patchSkill({ name: 'codex-only', version: showSkill('codex-only', undefined, dir).version, content: md('codex-only', '  talkcode-harnesses: "codex, opencode"\n'), by: { kind: 'person' }, now: T0 + 1 }, dir);
    createSkill({ name: 'on-awsfree2', description: 'x', now: T0 }, dir);
    patchSkill({ name: 'on-awsfree2', version: showSkill('on-awsfree2', undefined, dir).version, content: md('on-awsfree2', '  talkcode-hosts: "awsfree2"\n'), by: { kind: 'person' }, now: T0 + 1 }, dir);
    applyManagedSkills(claude, home, dir);
    const placed = fs.readdirSync(managedSkillsHome(home)).sort();
    expect(placed).toEqual(['deploy-check']);
  });
});

describe('placeManagedSkills on a remote host', () => {
  class FakeHost {
    readonly id = 'h1';
    readonly writes: string[] = [];
    readonly links = new Map<string, string>();
    readonly removed: string[] = [];
    readonly removedPaths: Array<{ path: string; owned: string }> = [];
    /** Every write and remove in call order, so a test can pin "write first, prune after". */
    readonly ops: string[] = [];
    /** What the copy looks like on the host; the prune asks for this before removing anything. */
    remoteFiles: string[] = [];
    async writeFile(p: string): Promise<void> {
      this.writes.push(p);
      this.ops.push(`write ${p}`);
    }
    async listFiles(): Promise<string[]> {
      return this.remoteFiles;
    }
    async removePath(path: string, owned: string): Promise<{ removed: boolean; path: string }> {
      this.removedPaths.push({ path, owned });
      this.ops.push(`remove ${path}`);
      return { removed: true, path };
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

  /** The take-back lines logged while `run` runs. */
  const takeBacks = async (run: () => Promise<void>): Promise<string[]> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('took back'));
    } finally {
      log.mockRestore();
    }
  };

  const welcome = (instance: string): Welcome => ({
    version: '2.30.0',
    instance,
    home: '/home/u',
    pid: 1,
    os: 'linux',
    arch: 'amd64',
    resumed: false,
  });

  it('links a second harness on the same host and version, where the files are already cached', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    const codex = { id: 'cx', harness: 'codex', env: {} } as unknown as AgentDef;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, codex, '/home/u', welcome('i1'), dir);
    expect(host.links.get('/home/u/.agents/skills/deploy-check')).toBe('/home/u/.talkcode/skills/deploy-check');
    expect(host.links.has('/home/u/.claude/skills/deploy-check')).toBe(false);
    // The files are already on the host for this instance; the claude link must still be made.
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.links.get('/home/u/.claude/skills/deploy-check')).toBe('/home/u/.talkcode/skills/deploy-check');
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
      { name: 'deploy-check', version: shown.version, content: residentMd('new', 'new'), now: T0 + 2 },
      dir
    );
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.writes.length).toBeGreaterThan(written);
    const afterChange = host.writes.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i2'), dir);
    expect(host.writes.length).toBeGreaterThan(afterChange);
  });

  it('writes the new version before pruning a file it no longer carries', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    removeSkillFile({ name: 'deploy-check', file: 'references/api.md', now: T0 + 2 }, dir);
    // What the previous version left in the copy: the file that was just removed is still there.
    host.remoteFiles = ['SKILL.md', 'references/api.md'];
    host.ops.length = 0;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.removedPaths).toEqual([
      { path: '/home/u/.talkcode/skills/deploy-check/references/api.md', owned: '/home/u/.talkcode/skills/deploy-check' },
    ]);
    // The write lands before the delete, so a reader never sees the skill half-deleted.
    expect(host.ops.indexOf('write /home/u/.talkcode/skills/deploy-check/SKILL.md')).toBeGreaterThanOrEqual(0);
    expect(host.ops.indexOf('write /home/u/.talkcode/skills/deploy-check/SKILL.md')).toBeLessThan(
      host.ops.indexOf('remove /home/u/.talkcode/skills/deploy-check/references/api.md')
    );
  });

  it('places a library skill without a link, and takes back the link once it leaves the resident tier', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.links.get('/home/u/.claude/skills/deploy-check')).toBe('/home/u/.talkcode/skills/deploy-check');
    setResident('deploy-check', false, dir, T0 + 2);
    const logged = await takeBacks(() => hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir));
    expect(host.links.has('/home/u/.claude/skills/deploy-check')).toBe(false);
    // Still active, so the log must not call it archived.
    expect(logged).toContain('[skills] h1: took back /home/u/.claude/skills/deploy-check (in the library now)');
    expect(logged.filter((l) => l.includes('archived'))).toEqual([]);
    expect(host.writes.filter((w) => w.endsWith('deploy-check/SKILL.md'))).toHaveLength(2);
    // Remembered: a second spawn asks the host nothing more about it.
    const removed = host.removed.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.removed).toHaveLength(removed);
  });

  it('takes back an archived skill in every directory, removes its copy, then remembers it', async () => {
    const host = new FakeHost();
    const hosts = new RemoteHosts();
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    archiveSkill('deploy-check', dir, T0 + 2);
    const logged = await takeBacks(() => hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir));
    expect(logged).toContain('[skills] h1: took back /home/u/.claude/skills/deploy-check (archived)');
    expect(logged.filter((l) => l.includes('library'))).toEqual([]);
    expect(host.removed).toContain('/home/u/.claude/skills/deploy-check');
    expect(host.removed).toContain('/home/u/.agents/skills/deploy-check');
    expect(host.removedPaths).toContainEqual({ path: '/home/u/.talkcode/skills/deploy-check', owned: '/home/u/.talkcode/skills' });
    const removed = host.removed.length;
    const removedPaths = host.removedPaths.length;
    await hosts.placeManagedSkills(host as unknown as RemoteHost, claude, '/home/u', welcome('i1'), dir);
    expect(host.removed).toHaveLength(removed);
    expect(host.removedPaths).toHaveLength(removedPaths);
  });
});
