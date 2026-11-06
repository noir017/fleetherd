import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitSync, initRepo } from './skills-git.js';
import { SkillsRepo, gitSshCommand, prepareSkillsRepo, redactRepoUrl, type SkillsRemote } from './skills-repo.js';
import {
  activeSkillFiles,
  createSkill,
  listSkills,
  patchSkill,
  repoRoot,
  showSkill,
  skillDir,
  skillHistory,
  usagePath,
} from './skills-store.js';

/**
 * The repository side of the managed skills, against a bare repository on disk standing in for
 * agent-skills. Nothing here reaches a network: a path is a git remote too.
 */

let tmp: string;
let dir: string;
let bare: string;
let logs: string[];

const PERSON = { GIT_AUTHOR_NAME: 'person', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'person', GIT_COMMITTER_EMAIL: 'p@x' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-repo-'));
  dir = path.join(tmp, 'config');
  fs.mkdirSync(dir);
  bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  gitSync(bare, ['init', '-q', '--bare']);
  gitSync(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const remote = (url = bare): SkillsRemote => ({ url, branch: 'main', identityFile: '/nonexistent', knownHostsFile: '/nonexistent' });

function repo(r: SkillsRemote | null = remote()): SkillsRepo {
  return new SkillsRepo({ dir, remote: () => r ?? undefined, log: (m) => logs.push(m) });
}

/** A person's working copy of the shared repository. */
function personClone(): string {
  const work = path.join(tmp, `person-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(work);
  gitSync(work, ['clone', '-q', bare, '.']);
  return work;
}

function personCommit(work: string, rel: string, content: string, message: string): void {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), content);
  gitSync(work, ['add', '-A']);
  gitSync(work, ['commit', '-q', '-m', message], PERSON);
  gitSync(work, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
}

const skillMd = (name: string, description: string, body = ''): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body ? `\n${body}\n` : ''}`;

/** Seed the shared repository the way agent-skills looks: a skill and things that are not skills. */
function seedRemote(): string {
  const seed = path.join(tmp, 'seed');
  initRepo(seed);
  fs.mkdirSync(path.join(seed, 'skills', 'server-ops'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'skills', 'server-ops', 'SKILL.md'), skillMd('server-ops', 'Use when operating a server'));
  fs.writeFileSync(path.join(seed, 'README.md'), 'generated\n');
  gitSync(seed, ['add', '-A']);
  gitSync(seed, ['commit', '-q', '-m', 'feat: server-ops'], PERSON);
  gitSync(seed, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  return seed;
}

const remoteLog = (): string[] => gitSync(bare, ['log', '--format=%an|%s', 'main']).trim().split('\n');

describe('prepareSkillsRepo', () => {
  it('moves an old store into a repository as one commit and keeps the old one', () => {
    const old = path.join(dir, 'skills');
    fs.mkdirSync(path.join(old, 'email-reader'), { recursive: true });
    fs.writeFileSync(path.join(old, 'email-reader', 'SKILL.md'), skillMd('email-reader', 'Use when reading mail'));
    fs.mkdirSync(path.join(old, '.archive', 'old-one'), { recursive: true });
    fs.writeFileSync(path.join(old, '.archive', 'old-one', 'SKILL.md'), skillMd('old-one', 'Use when never'));
    fs.mkdirSync(path.join(old, '.history', 'email-reader', '1'), { recursive: true });
    const usage = { version: 1, skills: { 'email-reader': { source: { agent: 'ag' }, createdAt: '2026-11-01T00:00:00.000Z', uses: 2, agents: [], status: 'active', pinned: false } } };
    fs.writeFileSync(path.join(old, '.usage.json'), JSON.stringify(usage));

    expect(prepareSkillsRepo(dir, (m) => logs.push(m))).toBe(true);

    expect(fs.existsSync(path.join(repoRoot(dir), '.git'))).toBe(true);
    expect(listSkills(dir).map((s) => [s.name, s.status])).toEqual([
      ['email-reader', 'active'],
      ['old-one', 'archived'],
    ]);
    expect(listSkills(dir)[0]).toMatchObject({ uses: 2, source: { agent: 'ag' } });
    expect(JSON.parse(fs.readFileSync(usagePath(dir), 'utf8'))).toEqual(usage);
    expect(skillHistory('email-reader', dir)).toEqual([expect.objectContaining({ action: 'import', author: 'talkcode' })]);
    // The old store is set aside whole, `.history/` included.
    expect(fs.existsSync(path.join(dir, 'skills.pre-git', '.history', 'email-reader', '1'))).toBe(true);
    // Nothing of the old bookkeeping is in the repository.
    expect(fs.existsSync(path.join(repoRoot(dir), '.usage.json'))).toBe(false);
    // A second start finds a repository and does nothing.
    expect(prepareSkillsRepo(dir)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('skills.pre-git'))).toEqual(['skills.pre-git']);
  });

  it('starts an empty repository when there was no store', () => {
    expect(prepareSkillsRepo(dir)).toBe(true);
    expect(fs.existsSync(path.join(repoRoot(dir), '.git'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills.pre-git'))).toBe(false);
  });
});

describe('a store with an old layout that was never moved', () => {
  it('refuses to write rather than turning the old directory into a repository', () => {
    fs.mkdirSync(path.join(dir, 'skills', 'email-reader'), { recursive: true });
    expect(() => createSkill({ name: 'new-one', description: 'x' }, dir)).toThrow(/not a git repository yet/);
    expect(fs.existsSync(path.join(dir, 'skills', '.git'))).toBe(false);
  });
});

describe('SkillsRepo with a remote', () => {
  it('puts the moved store on top of the shared repository and pushes it', async () => {
    seedRemote();
    fs.mkdirSync(path.join(dir, 'skills', 'email-reader'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'email-reader', 'SKILL.md'), skillMd('email-reader', 'Use when reading mail'));
    prepareSkillsRepo(dir);

    await repo().sync();

    expect(listSkills(dir).map((s) => s.name)).toEqual(['email-reader', 'server-ops']);
    expect(remoteLog()).toEqual(['talkcode|skills: import email-reader', 'person|feat: server-ops']);
    // What is not a skill comes along untouched and is not listed.
    expect(fs.readFileSync(path.join(repoRoot(dir), 'README.md'), 'utf8')).toBe('generated\n');
  });

  it('starts from the shared repository when the store was empty', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    await repo().sync();
    expect(activeSkillFiles(dir).map((s) => s.name)).toEqual(['server-ops']);
    expect(skillHistory('server-ops', dir)).toEqual([
      expect.objectContaining({ action: 'commit', author: 'person', note: 'feat: server-ops' }),
    ]);
  });

  it('checks a patch against a person\'s newer commit, and pushes the one that passes', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    const r = repo();
    await r.sync();
    const read = showSkill('server-ops', undefined, dir).version;

    personCommit(personClone(), 'skills/server-ops/SKILL.md', skillMd('server-ops', 'Use when operating a server', 'by hand'), 'docs: by hand');
    const stale = r.write(() =>
      patchSkill({ name: 'server-ops', version: read, content: skillMd('server-ops', 'Use when operating a server', 'by an agent') }, dir)
    );
    await expect(stale).rejects.toThrow(/version mismatch/);
    expect(showSkill('server-ops', undefined, dir).content).toContain('by hand');

    const fresh = showSkill('server-ops', undefined, dir).version;
    await r.write(() =>
      patchSkill(
        { name: 'server-ops', version: fresh, content: skillMd('server-ops', 'Use when operating a server', 'by an agent'), by: { kind: 'review', agent: 'ag' } },
        dir
      )
    );
    expect(remoteLog()[0]).toBe('talkcode-review|skills: patch server-ops');
    const body = gitSync(bare, ['log', '-1', '--format=%b', 'main']);
    expect(body).toMatch(/Talkcode-Action: patch/);
    expect(body).toMatch(/Talkcode-By: review ag/);
  });

  it('lets the repository win when both sides changed one file, and keeps the gateway\'s on a branch', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    // Synced once, then unreachable while an agent patches; meanwhile a person edits the same file.
    await repo().sync();
    const offline = repo(remote(path.join(tmp, 'missing.git')));
    const v = showSkill('server-ops', undefined, dir).version;
    await offline.write(() =>
      patchSkill({ name: 'server-ops', version: v, content: skillMd('server-ops', 'Use when operating a server', 'gateway') }, dir)
    );
    personCommit(personClone(), 'skills/server-ops/SKILL.md', skillMd('server-ops', 'Use when operating a server', 'person'), 'docs: person');

    await repo().sync();

    expect(showSkill('server-ops', undefined, dir).content).toContain('person');
    expect(logs.some((l) => /kept on branch talkcode-unpushed-/.test(l))).toBe(true);
    const branches = gitSync(repoRoot(dir), ['branch', '--list', 'talkcode-unpushed-*']);
    expect(branches.trim()).not.toBe('');
  });

  it('keeps a write local while the repository is unreachable, says so once, and pushes it later', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    await repo().sync();
    const away = path.join(tmp, 'away.git');
    fs.renameSync(bare, away);
    const r = repo();

    await r.write(() => createSkill({ name: 'deploy-check', description: 'Use when checking a deployment' }, dir));
    await r.sync();
    expect(fs.existsSync(skillDir('deploy-check', dir))).toBe(true);
    expect(logs.filter((l) => /is not reachable/.test(l))).toHaveLength(1);

    fs.renameSync(away, bare);
    await r.sync();
    expect(remoteLog()[0]).toBe('talkcode|skills: create deploy-check');
    expect(logs.some((l) => /answers again/.test(l))).toBe(true);
  });

  it('commits a change left uncommitted in its copy before taking the repository\'s', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    const r = repo();
    await r.sync();
    fs.writeFileSync(path.join(skillDir('server-ops', dir), 'SKILL.md'), skillMd('server-ops', 'Use when operating a server', 'stray'));
    personCommit(personClone(), 'README.md', 'regenerated\n', 'chore: readme');

    await r.sync();

    expect(remoteLog().slice(0, 2)).toEqual(['talkcode|skills: commit-stray skills/server-ops/SKILL.md', 'person|chore: readme']);
  });

  it('follows the remote named in the config, so a reload can move it', async () => {
    seedRemote();
    prepareSkillsRepo(dir);
    let current: SkillsRemote | undefined = remote(path.join(tmp, 'nowhere.git'));
    const r = new SkillsRepo({ dir, remote: () => current, log: (m) => logs.push(m) });
    await r.sync();
    expect(listSkills(dir)).toEqual([]);
    current = remote();
    await r.sync();
    expect(listSkills(dir).map((s) => s.name)).toEqual(['server-ops']);
    expect(gitSync(repoRoot(dir), ['remote', 'get-url', 'origin']).trim()).toBe(bare);
  });
});

describe('SkillsRepo without a remote', () => {
  it('runs the write and touches no network', async () => {
    prepareSkillsRepo(dir);
    const r = repo(null);
    await r.write(() => createSkill({ name: 'deploy-check', description: 'Use when checking a deployment' }, dir));
    expect(skillHistory('deploy-check', dir)).toEqual([expect.objectContaining({ action: 'create' })]);
    expect(() => gitSync(repoRoot(dir), ['remote', 'get-url', 'origin'])).toThrow();
  });
});

describe('the ssh git runs', () => {
  it('pins the key and known_hosts and never learns a host key', () => {
    const cmd = gitSshCommand({ url: 'ssh://git@h:22/r.git', branch: 'main', identityFile: "/k/it's", knownHostsFile: '/k/known_hosts' });
    expect(cmd).toContain('-F none');
    expect(cmd).toContain('StrictHostKeyChecking=yes');
    expect(cmd).toContain(`'IdentityFile=/k/it'\\''s'`);
    expect(cmd).toContain(`'UserKnownHostsFile=/k/known_hosts'`);
  });

  it('masks a token in an https URL before it is logged', () => {
    expect(redactRepoUrl('https://user:tok@git.example/r.git')).not.toContain('tok');
    expect(redactRepoUrl('ssh://git@h:22/r.git')).toBe('ssh://git@h:22/r.git');
  });
});
