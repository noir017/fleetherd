import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGitPanel, gitBranches, gitCommit, gitCommitFile, gitFile, gitLog, gitStatus } from './git-panel.js';
import { localWorkspace, type Workspace } from './workspace.js';

/**
 * The git window's daemon half, against real repositories.
 *
 * The point of testing this with git rather than a fake is the formats: `-z`, `--no-index`, the
 * numstat that says `-` `-` for a binary, and the merge base are exactly where a hand-written
 * parser drifts from the tool. Each case builds a throwaway repository under the test's own HOME
 * (vitest.setup.ts), so nothing here touches the checkout being tested.
 */

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: ENV,
  });
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('git panel', () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-panel-')));
    ws = localWorkspace(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A repository on `main` with one commit, and the workspace pointing at its root. */
  function repo(): void {
    gitIn(dir, 'init', '-q', '-b', 'main');
    write(path.join(dir, 'base.txt'), 'a\nb\n');
    write(path.join(dir, 'gone.txt'), 'one\ntwo\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'base');
  }

  it('reads the working tree against HEAD, untracked files included, with real line counts', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    write(path.join(dir, 'added.txt'), 'new\n');
    gitIn(dir, 'add', 'added.txt');
    fs.rmSync(path.join(dir, 'gone.txt'));
    write(path.join(dir, 'new.txt'), '1\n2\n3\n');

    const status = await gitStatus(ws, 'working');
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.repo).toEqual({ root: dir, branch: 'main', base: 'main' });
    expect(status.files).toEqual([
      { path: 'added.txt', status: 'added', additions: 1, deletions: 0 },
      { path: 'base.txt', status: 'modified', additions: 1, deletions: 0 },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 2 },
      { path: 'new.txt', status: 'added', additions: 3, deletions: 0 },
    ]);

    const added = await gitFile(ws, 'working', undefined, 'new.txt');
    expect(added).toMatchObject({ ok: true, path: 'new.txt', status: 'added', original: '' });
    if (!added.ok) return;
    expect(added.modified).toBe('1\n2\n3\n');
    expect(added.patch).toContain('+1');

    const deleted = await gitFile(ws, 'working', undefined, 'gone.txt');
    if (!deleted.ok) throw new Error(deleted.text);
    expect(deleted.original).toBe('one\ntwo\n');
    expect(deleted.modified).toBe('');
    expect(deleted.patch).toContain('-one');
  });

  it('compares branch against the merge base and committed against HEAD', async () => {
    repo();
    gitIn(dir, 'checkout', '-qb', 'feature');
    write(path.join(dir, 'base.txt'), 'a\nb\ncommitted\n');
    gitIn(dir, 'commit', '-qam', 'feature work');
    write(path.join(dir, 'base.txt'), 'a\nb\ncommitted\nworking\n');
    write(path.join(dir, 'later.txt'), 'later\n');

    const branches = await gitBranches(ws);
    expect(branches).toMatchObject({ ok: true, branch: 'feature', base: 'main' });
    if (branches.ok) expect(branches.branches).toEqual(expect.arrayContaining(['main', 'feature']));

    const branch = await gitStatus(ws, 'branch', 'main');
    if (!branch.ok) throw new Error(branch.text);
    expect(branch.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['base.txt', 'modified', 2, 0],
      ['later.txt', 'added', 1, 0],
    ]);

    const committed = await gitStatus(ws, 'committed', 'main');
    if (!committed.ok) throw new Error(committed.text);
    expect(committed.files).toEqual([{ path: 'base.txt', status: 'modified', additions: 1, deletions: 0 }]);

    const file = await gitFile(ws, 'committed', 'main', 'base.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('a\nb\n');
    expect(file.modified).toBe('a\nb\ncommitted\n');

    // A working-tree-only file is not in the committed comparison, so it cannot be read as one.
    const later = await gitFile(ws, 'committed', 'main', 'later.txt');
    expect(later.ok).toBe(false);

    const unknown = await gitStatus(ws, 'branch', 'does-not-exist');
    expect(unknown).toMatchObject({ ok: false, reason: 'error' });
    // The working comparison needs no base, so a stale picker value from another mode is ignored.
    expect((await gitStatus(ws, 'working', 'does-not-exist')).ok).toBe(true);
  });

  it('keeps every path relative to the repository root when the topic is in a subdirectory', async () => {
    repo();
    write(path.join(dir, 'sub', 'deep', 'inside.txt'), 'in\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'subdir');
    write(path.join(dir, 'base.txt'), 'a\nb\nchanged\n');
    write(path.join(dir, 'sub', 'deep', 'inside.txt'), 'in\nand more\n');
    write(path.join(dir, 'sub', 'new.txt'), 'n1\nn2\n');

    const sub = localWorkspace(path.join(dir, 'sub'));
    const status = await gitStatus(sub, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.repo.root).toBe(dir);
    expect(status.files.map((f) => [f.path, f.additions])).toEqual([
      ['base.txt', 1],
      ['sub/deep/inside.txt', 1],
      ['sub/new.txt', 2],
    ]);

    // The pathspec is repo-relative, so the commands must run from the repository root even
    // though the topic works in `sub/`.
    const file = await gitFile(sub, 'working', undefined, 'sub/deep/inside.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('in\n');
    expect(file.modified).toBe('in\nand more\n');
    expect(file.patch).toContain('+and more');

    const untracked = await gitFile(sub, 'working', undefined, 'sub/new.txt');
    if (!untracked.ok) throw new Error(untracked.text);
    expect(untracked.modified).toBe('n1\nn2\n');
    expect(untracked.patch).toContain('+n1');
  });

  it('answers not-git for a directory outside any repository', async () => {
    const status = await gitStatus(ws, 'working');
    expect(status).toMatchObject({ ok: false, reason: 'not-git' });
    expect((await gitBranches(ws)).ok).toBe(false);
    expect((await gitFile(ws, 'working', undefined, 'x')).ok).toBe(false);
  });

  it('answers not-git when git stops at a filesystem boundary, not with its last line', async () => {
    // A working directory on a mounted volume: discovery stops at the mount point and git says so
    // on a SECOND line. Only the last line was matched before, so this read as a raw git error.
    const stderr =
      'fatal: not a git repository (or any parent up to mount point /mnt)\n' +
      'Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n';
    const mounted: Workspace = {
      ...ws,
      run: async (argv, o) =>
        argv.includes('--show-toplevel')
          ? { code: 128, output: Buffer.alloc(0), stderr, truncated: false, timedOut: false }
          : ws.run(argv, o),
    };
    expect(await gitStatus(mounted, 'working')).toMatchObject({ ok: false, reason: 'not-git' });
    expect(await gitLog(mounted, 0)).toMatchObject({ ok: false, reason: 'not-git' });
    expect(await gitCommit(mounted, 'abc1234')).toMatchObject({ ok: false, reason: 'not-git' });
    expect(await gitCommitFile(mounted, 'abc1234', 'a.txt')).toMatchObject({ ok: false });
  });

  it('pages the history newest first and says whether another page follows', async () => {
    repo();
    for (let i = 1; i <= 55; i++) {
      write(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), `${i}\n`);
      gitIn(dir, 'add', '.');
      gitIn(dir, 'commit', '-qm', `change ${i}`);
    }

    const first = await gitLog(ws, 0);
    if (!first.ok) throw new Error(first.text);
    expect(first.repo).toEqual({ root: dir, branch: 'main' });
    expect(first.more).toBe(true);
    expect(first.commits).toHaveLength(50);
    expect(first.commits[0]).toMatchObject({ subject: 'change 55', author: 'test', parents: 1 });
    expect(first.commits[0]?.short).toMatch(/^[0-9a-f]{7,}$/);
    expect(first.commits[0]?.at).toBeGreaterThan(0);
    // Every row, not just the first: the record separator's newline used to land on the front of
    // the next sha, which the page then sent back and the query schema refused.
    expect(first.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);

    // 55 changes plus the repository's first commit: the second page holds the rest.
    const second = await gitLog(ws, 50);
    if (!second.ok) throw new Error(second.text);
    expect(second.commits).toHaveLength(6);
    expect(second.more).toBe(false);
    expect(second.commits.at(-1)?.subject).toBe('base');
    expect(second.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
    // No overlap between the pages.
    expect(second.commits.some((c) => first.commits.some((p) => p.sha === c.sha))).toBe(false);

    // A sha from the second page — the one that used to carry a newline — opens as a commit.
    const older = second.commits[1];
    if (!older) throw new Error('expected a second commit on the second page');
    const opened = await gitCommit(ws, older.sha);
    if (!opened.ok) throw new Error(opened.text);
    expect(opened.commit).toMatchObject({ sha: older.sha, subject: older.subject });

    const past = await gitLog(ws, 500);
    expect(past).toMatchObject({ ok: true, commits: [], more: false });
  });

  it('says there is no more when the page ends exactly at the last commit', async () => {
    repo();
    for (let i = 1; i <= 49; i++) {
      write(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), `${i}\n`);
      gitIn(dir, 'add', '.');
      gitIn(dir, 'commit', '-qm', `change ${i}`);
    }
    const page = await gitLog(ws, 0);
    if (!page.ok) throw new Error(page.text);
    expect(page.commits).toHaveLength(50);
    expect(page.more).toBe(false);
  });

  it('answers an empty history for a repository with no commits', async () => {
    gitIn(dir, 'init', '-q', '-b', 'main');
    const empty = { ok: true, repo: { root: dir, branch: 'main' }, commits: [], more: false };
    expect(await gitLog(ws, 0)).toEqual(empty);
    // A page past the end of an empty history is still a page, not a refusal.
    expect(await gitLog(ws, 50)).toEqual(empty);
  });

  it('reads a root commit against the empty tree', async () => {
    repo();
    const root = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const commit = await gitCommit(ws, root.slice(0, 7));
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.commit).toMatchObject({ sha: root, short: root.slice(0, 7), subject: 'base', body: '', parents: 0 });
    expect(commit.files.map((f) => [f.path, f.status])).toEqual([
      ['base.txt', 'added'],
      ['gone.txt', 'added'],
    ]);

    const file = await gitCommitFile(ws, root.slice(0, 7), 'base.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file).toMatchObject({ path: 'base.txt', status: 'added', original: '', modified: 'a\nb\n' });
    expect(file.patch).toContain('+a');
  });

  it('reads a SHA-256 repository, root commit and all', async (ctx) => {
    try {
      gitIn(dir, 'init', '-q', '--object-format=sha256', '-b', 'main');
    } catch {
      // A git too old to know the option, or built without SHA-256 support.
      ctx.skip();
      return;
    }
    write(path.join(dir, 'base.txt'), 'a\nb\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'root');
    const root = gitIn(dir, 'rev-parse', 'HEAD').trim();
    expect(root).toHaveLength(64);

    const log = await gitLog(ws, 0);
    if (!log.ok) throw new Error(log.text);
    // A 64-character id is a commit id too: the query regex and the daemon's must let it through.
    expect(log.commits.map((c) => c.sha)).toEqual([root]);

    const commit = await gitCommit(ws, root);
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.commit.sha).toBe(root);
    expect(commit.files.map((f) => [f.path, f.status])).toEqual([['base.txt', 'added']]);

    // The root commit's old side is this repository's empty tree, not a SHA-1 id it never had.
    const file = await gitCommitFile(ws, root, 'base.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('');
    expect(file.modified).toBe('a\nb\n');
    expect(file.patch).toContain('+a');
  });

  it('gives both sides of a file a commit changed, and refuses one it did not', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    gitIn(dir, 'commit', '-qam', 'edit base');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const file = await gitCommitFile(ws, sha, 'base.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file).toMatchObject({ path: 'base.txt', status: 'modified', original: 'a\nb\n', modified: 'a\nb\nc\n' });
    expect(file.patch).toContain('+c');

    expect(await gitCommitFile(ws, sha, 'gone.txt')).toMatchObject({
      ok: false,
      text: 'That file is not one of the changes shown.',
    });
    // A path that looks like an option never reaches git: it is refused by the list check.
    expect(await gitCommitFile(ws, sha, '--upload-pack=touch /tmp/pwned')).toMatchObject({ ok: false });
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
  });

  it('reads a merge commit against its first parent', async () => {
    repo();
    gitIn(dir, 'checkout', '-qb', 'feature');
    write(path.join(dir, 'feature.txt'), 'f\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'feature work');
    gitIn(dir, 'checkout', '-q', 'main');
    write(path.join(dir, 'main.txt'), 'm\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'main work');
    gitIn(dir, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const merge = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const detail = await gitCommit(ws, merge);
    if (!detail.ok) throw new Error(detail.text);
    expect(detail.commit).toMatchObject({ sha: merge, subject: 'merge feature', parents: 2 });
    // The first parent is main, so the merge brought the feature file and nothing else.
    expect(detail.files.map((f) => f.path)).toEqual(['feature.txt']);

    const file = await gitCommitFile(ws, merge, 'feature.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('');
    expect(file.modified).toBe('f\n');
    expect((await gitCommitFile(ws, merge, 'main.txt')).ok).toBe(false);
  });

  it('gives the deleted side of a commit that removed a file', async () => {
    repo();
    gitIn(dir, 'rm', '-q', 'gone.txt');
    gitIn(dir, 'commit', '-qm', 'remove gone');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const commit = await gitCommit(ws, sha);
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.files).toEqual([{ path: 'gone.txt', status: 'deleted', additions: 0, deletions: 2 }]);

    const file = await gitCommitFile(ws, sha, 'gone.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('one\ntwo\n');
    expect(file.modified).toBe('');
    expect(file.patch).toContain('-one');
  });

  it('shows a rename as a delete and an add, because renames are off', async () => {
    repo();
    gitIn(dir, 'mv', 'base.txt', 'moved.txt');
    gitIn(dir, 'commit', '-qm', 'rename');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const commit = await gitCommit(ws, sha);
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.files.map((f) => [f.path, f.status])).toEqual([
      ['base.txt', 'deleted'],
      ['moved.txt', 'added'],
    ]);

    const old = await gitCommitFile(ws, sha, 'base.txt');
    if (!old.ok) throw new Error(old.text);
    expect(old.original).toBe('a\nb\n');
    expect(old.modified).toBe('');
    const moved = await gitCommitFile(ws, sha, 'moved.txt');
    if (!moved.ok) throw new Error(moved.text);
    expect(moved.original).toBe('');
    expect(moved.modified).toBe('a\nb\n');
  });

  it('marks a committed side over the cap tooLarge instead of returning part of it', async () => {
    repo();
    // `blobAt` reads with a cap of MAX_SIDE_BYTES + 1, so only a file past that is cut off.
    write(path.join(dir, 'big.txt'), 'x'.repeat(2 << 20));
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'big');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();
    expect(await gitCommitFile(ws, sha, 'big.txt')).toMatchObject({
      ok: true,
      tooLarge: true,
      original: '',
      modified: '',
      patch: '',
    });
  });

  it('reads history for a topic in a subdirectory, with paths relative to the repository root', async () => {
    repo();
    write(path.join(dir, 'sub', 'deep', 'inside.txt'), 'one\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'subdir');
    write(path.join(dir, 'sub', 'deep', 'inside.txt'), 'one\ntwo\n');
    gitIn(dir, 'commit', '-qam', 'edit inside');

    const sub = localWorkspace(path.join(dir, 'sub'));
    const log = await gitLog(sub, 0);
    if (!log.ok) throw new Error(log.text);
    expect(log.repo.root).toBe(dir);
    const head = log.commits[0];
    if (!head) throw new Error('expected a commit');
    expect(head.subject).toBe('edit inside');

    const commit = await gitCommit(sub, head.sha);
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.files.map((f) => f.path)).toEqual(['sub/deep/inside.txt']);

    const file = await gitCommitFile(sub, head.sha, 'sub/deep/inside.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('one\n');
    expect(file.modified).toBe('one\ntwo\n');
    expect(file.patch).toContain('+two');
  });

  it('refuses a cut-off history answer instead of parsing its tail', async () => {
    repo();
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.some((a) => a.startsWith('--skip=')) ? { ...r, truncated: true } : r;
      },
    };
    // The host keeps the END of a cut-off output: it starts mid-record, so it is not a page.
    expect(await gitLog(cut, 0)).toMatchObject({
      ok: false,
      reason: 'error',
      text: expect.stringContaining('too large'),
    });
  });

  it('refuses a commit whose message was cut off', async () => {
    repo();
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('-1') ? { ...r, truncated: true } : r;
      },
    };
    expect(await gitCommit(cut, sha)).toMatchObject({
      ok: false,
      reason: 'error',
      text: expect.stringContaining('too large'),
    });
    expect(await gitCommitFile(cut, sha, 'base.txt')).toMatchObject({ ok: false, text: expect.stringContaining('too large') });
  });

  it('gives no text for a binary file in a commit', async () => {
    repo();
    write(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'binary');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const commit = await gitCommit(ws, sha);
    if (!commit.ok) throw new Error(commit.text);
    expect(commit.files.find((f) => f.path === 'bin.dat')).toMatchObject({ status: 'added', binary: true });
    expect(await gitCommitFile(ws, sha, 'bin.dat')).toEqual({
      ok: true,
      path: 'bin.dat',
      status: 'added',
      original: '',
      modified: '',
      patch: '',
      binary: true,
    });
  });

  it('refuses a commit id that is not one, before git could read it as an option', async () => {
    repo();
    for (const sha of ['', 'abc', 'HEAD', '--all', 'Z'.repeat(40), 'main']) {
      expect(await gitCommit(ws, sha), sha).toMatchObject({ ok: false, reason: 'error' });
      expect(await gitCommitFile(ws, sha, 'base.txt'), sha).toMatchObject({ ok: false });
    }
    // Well-formed hex that names nothing is still a refusal, with the id in the sentence.
    const missing = await gitCommit(ws, 'deadbeef');
    expect(missing).toMatchObject({ ok: false, reason: 'error' });
    if (!missing.ok) expect(missing.text).toContain('deadbeef');
  });

  it('reports a history command that failed as an error, never as an empty page', async () => {
    repo();
    const broken: Workspace = {
      ...ws,
      run: async (argv, o) => {
        if (!argv.includes('log')) return ws.run(argv, o);
        return { code: 128, output: Buffer.alloc(0), stderr: 'fatal: bad object HEAD\n', truncated: false, timedOut: false };
      },
    };
    expect(await gitLog(broken, 0)).toMatchObject({
      ok: false,
      reason: 'error',
      text: expect.stringContaining('bad object HEAD'),
    });
  });

  it('works in a repository with no commits, and reports committed as empty', async () => {
    gitIn(dir, 'init', '-q', '-b', 'main');
    write(path.join(dir, 'first.txt'), 'one\ntwo\n');

    const working = await gitStatus(ws, 'working');
    if (!working.ok) throw new Error(working.text);
    expect(working.repo.branch).toBe('main');
    expect(working.repo.base).toBeUndefined();
    expect(working.files).toEqual([{ path: 'first.txt', status: 'added', additions: 2, deletions: 0 }]);

    const branch = await gitStatus(ws, 'branch');
    expect(branch).toMatchObject({ ok: true, files: [{ path: 'first.txt' }] });

    const committed = await gitStatus(ws, 'committed');
    expect(committed).toMatchObject({ ok: true, files: [] });

    const file = await gitFile(ws, 'working', undefined, 'first.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.original).toBe('');
    expect(file.modified).toBe('one\ntwo\n');
    expect(file.patch).toContain('+two');
  });

  it('marks a binary file and gives no text for it', async () => {
    repo();
    write(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    gitIn(dir, 'add', 'bin.dat');
    gitIn(dir, 'commit', '-qm', 'binary');
    write(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 9, 3]));

    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.files.find((f) => f.path === 'bin.dat')).toMatchObject({ status: 'modified', binary: true });

    const file = await gitFile(ws, 'working', undefined, 'bin.dat');
    expect(file).toEqual({ ok: true, path: 'bin.dat', status: 'modified', original: '', modified: '', patch: '', binary: true });
  });

  it('marks a side over 1 MiB tooLarge instead of returning part of it', async () => {
    repo();
    write(path.join(dir, 'big.txt'), 'x'.repeat((1 << 20) + 1));

    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.files.find((f) => f.path === 'big.txt')).toMatchObject({ status: 'added' });

    const file = await gitFile(ws, 'working', undefined, 'big.txt');
    expect(file).toMatchObject({ ok: true, tooLarge: true, original: '', modified: '', patch: '' });
  });

  it('treats a truncated git answer as too large, never as content', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    // The host keeps the END of output past its cap; a stub that marks a `show` truncated is the
    // remote case without an ssh. What must not happen is that the tail is shown as the file.
    const truncating: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('cat-file') ? { ...r, truncated: true } : r;
      },
    };
    const file = await gitFile(truncating, 'working', undefined, 'base.txt');
    expect(file).toMatchObject({ ok: true, tooLarge: true, original: '', modified: '', patch: '' });

    const listTruncated: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('status') ? { ...r, truncated: true } : r;
      },
    };
    expect(await gitStatus(listTruncated, 'working')).toMatchObject({ ok: true, files: [], truncated: true });
  });

  it('reads only a path the change list named, even when the path itself looks like an option', async () => {
    repo();
    write(path.join(dir, '-n.txt'), 'dash\n');

    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.files.map((f) => f.path)).toContain('-n.txt');

    const file = await gitFile(ws, 'working', undefined, '-n.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.modified).toBe('dash\n');

    // Not in the list: refused by the listing check. The request's path itself never reaches a
    // command — the commands that DID run were the ones that produced the list being checked.
    // `--upload-pack` is a git option that would run a program if a naive implementation put the
    // path on the command line.
    const refused = await gitFile(ws, 'working', undefined, '--upload-pack=touch /tmp/pwned');
    expect(refused).toMatchObject({ ok: false });
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
  });

  it('reads a path literally, so a name with a glob character cannot match another file', async () => {
    repo();
    write(path.join(dir, 'a*.txt'), 'star\n');
    write(path.join(dir, 'abc.txt'), 'plain\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-qm', 'names');
    write(path.join(dir, 'a*.txt'), 'star2\n');
    write(path.join(dir, 'abc.txt'), 'plain2\n');

    const star = await gitFile(ws, 'working', undefined, 'a*.txt');
    if (!star.ok) throw new Error(star.text);
    expect(star.original).toBe('star\n');
    expect(star.modified).toBe('star2\n');
    expect(star.patch).toContain('star2');
    expect(star.patch).not.toContain('abc.txt');
  });

  it('lists every file in a new directory, not the directory as one row', async () => {
    repo();
    write(path.join(dir, 'fresh', 'one.txt'), 'a\nb\n');
    write(path.join(dir, 'fresh', 'two.txt'), 'c\n');

    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.files.map((f) => [f.path, f.additions])).toEqual([
      ['fresh/one.txt', 2],
      ['fresh/two.txt', 1],
    ]);

    // And each is readable, which a collapsed `fresh/` row could not be.
    const file = await gitFile(ws, 'working', undefined, 'fresh/one.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.modified).toBe('a\nb\n');
    expect(file.patch).toContain('+b');
  });

  it('counts a staged file in a repository with no commits', async () => {
    gitIn(dir, 'init', '-q', '-b', 'main');
    write(path.join(dir, 'staged.txt'), 'one\ntwo\n');
    gitIn(dir, 'add', 'staged.txt');

    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    expect(status.files).toEqual([{ path: 'staged.txt', status: 'added', additions: 2, deletions: 0 }]);
  });

  it.skipIf(process.platform === 'win32')('compares a symlink by its target text, never by what it points at', async () => {
    repo();
    write(path.join(dir, 'secret.txt'), 'SECRET\n');
    fs.symlinkSync('secret.txt', path.join(dir, 'link'));

    const untracked = await gitStatus(ws, 'working');
    if (!untracked.ok) throw new Error(untracked.text);
    expect(untracked.files.find((f) => f.path === 'link')).toMatchObject({ status: 'added', additions: 1 });

    const link = await gitFile(ws, 'working', undefined, 'link');
    if (!link.ok) throw new Error(link.text);
    // The target path, not the target's bytes: following it would show a file the repository does
    // not contain (and, for a link pointing outside, one the page was never meant to read).
    expect(link.modified).toBe('secret.txt');
    expect(link.patch).not.toContain('SECRET');

    gitIn(dir, 'add', 'link');
    gitIn(dir, 'commit', '-qm', 'link');
    fs.unlinkSync(path.join(dir, 'link'));
    fs.symlinkSync('other.txt', path.join(dir, 'link'));

    const changed = await gitFile(ws, 'working', undefined, 'link');
    if (!changed.ok) throw new Error(changed.text);
    expect(changed.original).toBe('secret.txt');
    expect(changed.modified).toBe('other.txt');
    expect(changed.patch).toContain('+other.txt');
  });

  it('reports a git failure as an error, never as an empty change list', async () => {
    repo();
    const broken: Workspace = {
      ...ws,
      run: async (argv, o) => {
        if (!argv.includes('status')) return ws.run(argv, o);
        return { code: 128, output: Buffer.alloc(0), stderr: 'fatal: index file corrupt\n', truncated: false, timedOut: false };
      },
    };
    expect(await gitStatus(broken, 'working')).toMatchObject({
      ok: false,
      reason: 'error',
      text: expect.stringContaining('index file corrupt'),
    });
  });

  it('reports a timeout as a timeout, not as a directory that is not a git repository', async () => {
    const slow: Workspace = {
      ...ws,
      run: async (argv, o) =>
        argv.includes('rev-parse')
          ? { code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true }
          : ws.run(argv, o),
    };
    const status = await gitStatus(slow, 'working');
    expect(status).toMatchObject({ ok: false, reason: 'error' });
    if (!status.ok) expect(status.text).toContain('timed out');
  });

  it('reports a command that never started, with the reason it gave', async () => {
    const gone: Workspace = {
      ...ws,
      run: async () => ({
        code: null,
        output: Buffer.alloc(0),
        stderr: '',
        truncated: false,
        timedOut: false,
        spawnError: 'spawn git ENOENT',
      }),
    };
    const status = await gitStatus(gone, 'working');
    expect(status).toMatchObject({ ok: false, reason: 'error' });
    if (!status.ok) expect(status.text).toContain('spawn git ENOENT');
  });

  it('keeps the whole list when only a numstat answer was cut off', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('--numstat') ? { ...r, truncated: true } : r;
      },
    };
    const status = await gitStatus(cut, 'working');
    if (!status.ok) throw new Error(status.text);
    // Counts are absent when their command was cut off; the list is still the list, and the row
    // says the counts were not read.
    expect(status.truncated).toBeUndefined();
    expect(status.files).toEqual([
      { path: 'base.txt', status: 'modified', additions: 0, deletions: 0, statsUnknown: true },
    ]);
  });

  it('calls a cut-off patch tooLarge, because a patch that lost lines is not a diff', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('--patch') ? { ...r, truncated: true } : r;
      },
    };
    expect(await gitFile(cut, 'working', undefined, 'base.txt')).toMatchObject({
      ok: true,
      tooLarge: true,
      patchTooLarge: true,
      original: '',
      modified: '',
      patch: '',
    });
  });

  it('refuses a branch list it could only read in part', async () => {
    repo();
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('for-each-ref') ? { ...r, truncated: true } : r;
      },
    };
    expect(await gitBranches(cut)).toMatchObject({ ok: false, text: expect.stringContaining('too many branches') });
    expect(await gitStatus(cut, 'branch', 'main')).toMatchObject({ ok: false, reason: 'error' });
    // The working comparison needs no branch list, so it still answers.
    expect((await gitStatus(cut, 'working')).ok).toBe(true);
  });

  it('says the counts were not read when there are more untracked files than it stats', async () => {
    repo();
    for (let i = 0; i < 205; i++) {
      write(path.join(dir, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x\n');
    }
    const status = await gitStatus(ws, 'working');
    if (!status.ok) throw new Error(status.text);
    const many = status.files.filter((f) => f.path.startsWith('many/'));
    expect(many).toHaveLength(205);
    expect(many.filter((f) => f.statsUnknown)).toHaveLength(205 - 200);
    expect(many.filter((f) => !f.statsUnknown && f.additions === 1)).toHaveLength(200);
  });

  it('serves a row from a truncated branch list that it did show', async () => {
    repo();
    gitIn(dir, 'checkout', '-qb', 'feature');
    write(path.join(dir, 'base.txt'), 'a\nb\nfeature\n');
    gitIn(dir, 'commit', '-qam', 'feature');
    const cut: Workspace = {
      ...ws,
      run: async (argv, o) => {
        const r = await ws.run(argv, o);
        return argv.includes('status') ? { ...r, truncated: true } : r;
      },
    };

    const status = await gitStatus(cut, 'branch', 'main');
    if (!status.ok) throw new Error(status.text);
    expect(status.truncated).toBe(true);
    expect(status.files.map((f) => f.path)).toContain('base.txt');

    // The list is incomplete, but this row came from it and is real.
    const file = await gitFile(cut, 'branch', 'main', 'base.txt');
    if (!file.ok) throw new Error(file.text);
    expect(file.modified).toContain('feature');
  });

  it('reports a readlink that could not answer instead of following the link', async () => {
    repo();
    write(path.join(dir, 'secret.txt'), 'SECRET\n');
    fs.symlinkSync('secret.txt', path.join(dir, 'link'));
    const slow: Workspace = {
      ...ws,
      run: async (argv, o) =>
        argv.includes('readlink')
          ? { code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true }
          : ws.run(argv, o),
    };
    const file = await gitFile(slow, 'working', undefined, 'link');
    expect(file).toMatchObject({ ok: false });
    if (!file.ok) expect(file.text).toContain('readlink timed out');
  });

  it('compares against a branch whose name looks like a git option', async () => {
    repo();
    gitIn(dir, 'update-ref', 'refs/heads/--all', 'HEAD');
    const status = await gitStatus(ws, 'branch', '--all');
    expect(status).toMatchObject({ ok: true });
  });

  it('hands the daemon a panel bound to a conversation workspace', async () => {
    repo();
    write(path.join(dir, 'new.txt'), 'new\n');
    const head = gitIn(dir, 'rev-parse', 'HEAD').trim();
    const panel = buildGitPanel((ref) => (ref.thread === 'a1b2c3d4' ? ws : undefined));
    const ref = { platform: 'web', channel: 'main', thread: 'a1b2c3d4', kind: 'direct' as const, user: 'owner' };

    const status = await panel.status(ref, 'working');
    expect(status.ok).toBe(true);
    expect(await panel.status({ ...ref, thread: 'ffffffff' }, 'working')).toMatchObject({
      ok: false,
      reason: 'error',
    });
    expect((await panel.branches(ref)).ok).toBe(true);

    const log = await panel.log(ref, 0);
    expect(log).toMatchObject({ ok: true, commits: [{ sha: head }], more: false });
    expect(await panel.commit(ref, head)).toMatchObject({ ok: true, commit: { sha: head } });
    expect(await panel.commitFile(ref, head, 'base.txt')).toMatchObject({ ok: true, modified: 'a\nb\n' });
    expect(await panel.log({ ...ref, thread: 'ffffffff' }, 0)).toMatchObject({ ok: false, reason: 'error' });
    expect(await panel.commit({ ...ref, thread: 'ffffffff' }, head)).toMatchObject({ ok: false, reason: 'error' });
    expect(await panel.commitFile({ ...ref, thread: 'ffffffff' }, head, 'base.txt')).toMatchObject({ ok: false });
  });

  it('reads one commit once for the files of it opened in a row', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    write(path.join(dir, 'gone.txt'), 'one\ntwo\nthree\n');
    gitIn(dir, 'commit', '-qam', 'edit both');
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();
    const ran: string[] = [];
    const counted: Workspace = {
      ...ws,
      run: (argv, o) => {
        ran.push(argv.join(' '));
        return ws.run(argv, o);
      },
    };
    const ref = { platform: 'web', channel: 'main', thread: 'a1b2c3d4', kind: 'direct' as const, user: 'owner' };
    const panel = buildGitPanel(() => counted);

    expect((await panel.commit(ref, sha)).ok).toBe(true);
    const afterCommit = ran.length;
    expect((await panel.commitFile(ref, sha, 'base.txt')).ok).toBe(true);
    expect((await panel.commitFile(ref, sha, 'gone.txt')).ok).toBe(true);

    // The commit's own fields and its whole diff are not read again for each file: only that
    // file's two sides and its patch, as the change listing is reused for a working-tree file.
    const forFiles = ran.slice(afterCommit);
    expect(forFiles.some((c) => c.includes('log -1'))).toBe(false);
    expect(forFiles.some((c) => c.includes('--name-status'))).toBe(false);
  });

  it('reuses the listing a status answer just read when a file is opened', async () => {
    repo();
    write(path.join(dir, 'base.txt'), 'a\nb\nc\n');
    const ran: string[] = [];
    const counted: Workspace = {
      ...ws,
      run: (argv, o) => {
        ran.push(argv.join(' '));
        return ws.run(argv, o);
      },
    };
    const ref = { platform: 'web', channel: 'main', thread: 'a1b2c3d4', kind: 'direct' as const, user: 'owner' };
    const panel = buildGitPanel(() => counted);

    expect((await panel.status(ref, 'working')).ok).toBe(true);
    const afterStatus = ran.length;
    expect((await panel.file(ref, 'working', undefined, 'base.txt')).ok).toBe(true);
    const forFile = ran.slice(afterStatus);
    // The whole comparison — root, branches, merge base, status, stats — is not repeated: only
    // the sides and the patch this one file needs.
    expect(forFile.some((c) => c.includes('for-each-ref'))).toBe(false);
    expect(forFile.some((c) => c.includes('--show-toplevel'))).toBe(false);
    expect(forFile.some((c) => c.includes('status --porcelain'))).toBe(false);
  });
});
