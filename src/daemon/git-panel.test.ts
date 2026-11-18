import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGitPanel, gitBranches, gitFile, gitStatus } from './git-panel.js';
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

    // Not in the list: refused before any command runs. `--upload-pack` is a git option that would
    // run a program if a naive implementation put the path on the command line.
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

  it('hands the daemon a panel bound to a conversation workspace', async () => {
    repo();
    write(path.join(dir, 'new.txt'), 'new\n');
    const panel = buildGitPanel((ref) => (ref.thread === 'a1b2c3d4' ? ws : undefined));
    const ref = { platform: 'web', channel: 'main', thread: 'a1b2c3d4', kind: 'direct' as const, user: 'owner' };

    const status = await panel.status(ref, 'working');
    expect(status.ok).toBe(true);
    expect(await panel.status({ ...ref, thread: 'ffffffff' }, 'working')).toMatchObject({
      ok: false,
      reason: 'error',
    });
    expect((await panel.branches(ref)).ok).toBe(true);
  });
});
