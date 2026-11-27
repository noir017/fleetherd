import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localWorkspace } from './workspace.js';
import {
  checkWorktreeCleanup,
  createWorktree,
  inspectWorktreePlan,
  removeWorktree,
  resolveWorktreeName,
  rollbackWorktree,
  slugifyWorktreeName,
  validateWorktreeName,
  WORKTREE_CLEANUP_AGE_MS,
} from './worktree-git.js';
import { WorktreeStore, type ManagedWorktree } from './worktree-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'alice',
      GIT_AUTHOR_EMAIL: 'alice@example.com',
      GIT_COMMITTER_NAME: 'alice',
      GIT_COMMITTER_EMAIL: 'alice@example.com',
    },
  }).trim();
}

function makeRepo(): string {
  const dir = tmpDir('fleetherd-wt-repo-');
  git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('worktree name validation and slugging', () => {
  it('slugifies titles and validates explicit names', () => {
    expect(slugifyWorktreeName('Fix Login Bug #42!')).toBe('fix-login-bug-42');
    expect(resolveWorktreeName(true, 'Add OAuth2 Flow')).toBe('add-oauth2-flow');
    expect(resolveWorktreeName('feat-api_1.0')).toBe('feat-api_1.0');
    expect(validateWorktreeName('  my-wt  ')).toBe('my-wt');
  });

  it('refuses invalid names, path traversal, and missing/non-ASCII titles', () => {
    expect(() => resolveWorktreeName(true)).toThrow(/requires --title/);
    expect(() => resolveWorktreeName(true, '中文标题')).toThrow(/could not derive/);
    expect(() => validateWorktreeName('../escape')).toThrow(/invalid --worktree/);
    expect(() => validateWorktreeName('a/b')).toThrow(/invalid --worktree/);
    expect(() => validateWorktreeName('-flag')).toThrow(/invalid --worktree/);
    expect(() => validateWorktreeName('foo..bar')).toThrow(/invalid --worktree/);
    expect(() => validateWorktreeName('foo.lock')).toThrow(/invalid --worktree/);
  });
});

describe('worktree planning, creation, and .git/info/exclude', () => {
  it('refuses non-git directories and unborn repositories', async () => {
    const plain = tmpDir('fleetherd-wt-nogit-');
    await expect(inspectWorktreePlan(localWorkspace(plain), 'part-a')).rejects.toThrow(/not inside a git repository/);

    const empty = tmpDir('fleetherd-wt-empty-');
    git(empty, 'init', '-b', 'main');
    await expect(inspectWorktreePlan(localWorkspace(empty), 'part-a')).rejects.toThrow(/no commits yet/);
  });

  it('validates read-only without creating anything, and refuses existing dir or branch', async () => {
    const repo = makeRepo();
    const ws = localWorkspace(repo);
    const plan = await inspectWorktreePlan(ws, 'part-a');
    expect(plan.repoRoot).toBe(repo);
    expect(plan.path).toBe(path.join(repo, '.worktrees', 'part-a'));
    expect(plan.branch).toBe('part-a');
    expect(plan.baseBranch).toBe('main');
    expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);

    // Existing branch is refused
    git(repo, 'branch', 'taken-branch');
    await expect(inspectWorktreePlan(ws, 'taken-branch')).rejects.toThrow(/branch "taken-branch" already exists/);

    // Existing worktree dir is refused
    fs.mkdirSync(path.join(repo, '.worktrees', 'taken-dir'), { recursive: true });
    await expect(inspectWorktreePlan(ws, 'taken-dir')).rejects.toThrow(/worktree "taken-dir" already exists/);
  });

  it('creates worktree on new branch and adds .worktrees/ to .git/info/exclude without editing .gitignore', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'add gitignore');
    const ws = localWorkspace(repo);

    const plan = await inspectWorktreePlan(ws, 'part-a');
    expect(fs.existsSync(plan.path)).toBe(false);
    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    const excludeBefore = fs.readFileSync(excludePath, 'utf8');
    expect(excludeBefore).not.toContain('.worktrees/');

    const created = await createWorktree(ws, plan);
    expect(created.path).toBe(plan.path);
    expect(fs.existsSync(path.join(created.path, 'README.md'))).toBe(true);
    expect(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('part-a');
    expect(fs.readFileSync(excludePath, 'utf8')).toContain('.worktrees/');
    // Tracked .gitignore must remain untouched and clean
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('rolls back a freshly created worktree and branch', async () => {
    const repo = makeRepo();
    const ws = localWorkspace(repo);
    const plan = await inspectWorktreePlan(ws, 'rollback-me');
    const created = await createWorktree(ws, plan);
    expect(fs.existsSync(created.path)).toBe(true);
    await rollbackWorktree(ws, created.repoRoot, created.path, created.branch);
    expect(fs.existsSync(created.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'rollback-me')).toBe('');
  });
});

describe('worktree cleanup rules', () => {
  it('enforces every leave-it-alone condition and removes only when all four hold', async () => {
    const repo = makeRepo();
    const ws = localWorkspace(repo);
    const plan = await inspectWorktreePlan(ws, 'feat-x');
    const created = await createWorktree(ws, plan);
    const endedAt = 1_000_000;
    const nowAfter1h = endedAt + WORKTREE_CLEANUP_AGE_MS;
    const wt: ManagedWorktree = {
      topicKey: 'web#main#c1000000',
      topic: 'web:main/c1000000',
      agent: 'local',
      repoRoot: created.repoRoot,
      path: created.path,
      name: 'feat-x',
      branch: created.branch,
      baseBranch: created.baseBranch,
      baseSha: created.baseSha,
      createdAt: endedAt - 10_000,
      lastEndedAt: endedAt,
    };

    // Make a commit on feat-x (unmerged)
    fs.writeFileSync(path.join(created.path, 'work.txt'), 'done\n');
    git(created.path, 'add', 'work.txt');
    git(created.path, 'commit', '-m', 'work on feat-x');

    // 1. Running turn -> keep
    expect(await checkWorktreeCleanup(ws, wt, { busy: true, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'turn running',
    });

    // 2. Waiting on a question -> keep
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: true, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'turn running',
    });

    // 3. Less than 1h since last turn ended -> keep
    expect(
      await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: endedAt + WORKTREE_CLEANUP_AGE_MS - 1 })
    ).toEqual({
      action: 'keep',
      reason: 'less than 1h since last turn ended',
    });

    // 4. No turn ended yet -> keep
    const noEnd: ManagedWorktree = { ...wt, lastEndedAt: undefined };
    expect(await checkWorktreeCleanup(ws, noEnd, { busy: false, asking: false, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'less than 1h since last turn ended',
    });

    // 5. Detached HEAD base -> keep
    const detached: ManagedWorktree = { ...wt, baseBranch: undefined };
    expect(await checkWorktreeCleanup(ws, detached, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'created from detached HEAD',
    });

    // 6. Unmerged branch -> keep
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'branch feat-x not merged into main',
    });

    // Merge feat-x into main
    git(repo, 'merge', '--no-ff', 'feat-x', '-m', 'merge feat-x');

    // 7. Dirty tracked file -> keep
    fs.writeFileSync(path.join(created.path, 'work.txt'), 'modified\n');
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'uncommitted or untracked changes',
    });
    git(created.path, 'checkout', '--', 'work.txt');

    // 8. Untracked file -> keep
    fs.writeFileSync(path.join(created.path, 'scratch.tmp'), 'untracked\n');
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'keep',
      reason: 'uncommitted or untracked changes',
    });
    fs.unlinkSync(path.join(created.path, 'scratch.tmp'));

    // 9. All four hold -> remove!
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'remove',
    });

    const removed = await removeWorktree(ws, wt);
    expect(removed).toEqual({ removed: true, branchDeleted: true });
    expect(fs.existsSync(created.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'feat-x')).toBe('');

    // 10. Already removed externally -> prune-missing
    expect(await checkWorktreeCleanup(ws, wt, { busy: false, asking: false, lastEndedAt: endedAt, now: nowAfter1h })).toEqual({
      action: 'prune-missing',
    });
  });
});

describe('WorktreeStore persistence', () => {
  it('persists atomically with 0600 permissions and reloads across instances', () => {
    const dir = tmpDir('fleetherd-wt-store-');
    const file = path.join(dir, 'worktrees.json');
    const store = new WorktreeStore(file);
    store.set({
      topicKey: 'web#main#c1000000',
      topic: 'web:main/c1000000',
      agent: 'local',
      repoRoot: '/home/me/projects/demo',
      path: '/home/me/projects/demo/.worktrees/part-a',
      name: 'part-a',
      branch: 'part-a',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      createdAt: 1000,
    });
    store.touchEnded('web#main#c1000000', 2000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const reloaded = new WorktreeStore(file);
    expect(reloaded.get('web#main#c1000000')).toMatchObject({
      branch: 'part-a',
      lastEndedAt: 2000,
    });
    expect(reloaded.remove('web#main#c1000000')).toBe(true);
    expect(new WorktreeStore(file).all()).toEqual([]);
  });
});
