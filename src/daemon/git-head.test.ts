import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHead } from './git-head.js';
import { localWorkspace } from './workspace.js';

/**
 * The review loop's one read of a directory (git-head.ts), against real git: the two-line answer
 * `rev-parse HEAD --abbrev-ref HEAD` gives is git's behaviour, not something a fake could vouch for.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-git-head-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return dir;
}

describe('readHead', () => {
  it('answers the commit and the branch it is on', async () => {
    const dir = repo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    await expect(readHead(localWorkspace(dir))).resolves.toEqual({ sha, branch: 'main' });
  });

  it('leaves the branch out on a detached HEAD', async () => {
    const dir = repo();
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
    const head = await readHead(localWorkspace(dir));
    expect(head?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(head).not.toHaveProperty('branch');
  });

  it('answers nothing outside a repository, and for an unborn branch', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-git-head-'));
    dirs.push(plain);
    // A directory under the system temp dir: git would climb to a repository above it only if one
    // were there, and the ceiling keeps it from finding one this machine happens to have.
    process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
    try {
      await expect(readHead(localWorkspace(plain))).resolves.toBeUndefined();
      execFileSync('git', ['init', '-q'], { cwd: plain });
      await expect(readHead(localWorkspace(plain))).resolves.toBeUndefined();
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });
});
