import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationCommitPaths, gitSync, hasHead, initRepo } from './skills-git.js';

/** A throwaway repository; nothing here touches the live gateway's store. */

let root: string;
let plain: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-git-'));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-git-plain-'));
  initRepo(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

/** A commit at a pinned time, so nothing here depends on the clock or on how fast git runs. */
const commit = (file: string, message: string, at: string): void => {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${message}\n`);
  gitSync(root, ['add', '-A']);
  gitSync(root, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_NAME: 'talkcode',
    GIT_AUTHOR_EMAIL: 'talkcode@localhost',
    GIT_COMMITTER_NAME: 'talkcode',
    GIT_COMMITTER_EMAIL: 'talkcode@localhost',
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  });
};

const T0 = '2026-11-01T00:00:00Z';
const T1 = '2026-11-01T00:01:00Z';

describe('hasHead', () => {
  it('is false before the first commit, and true after it', () => {
    expect(hasHead(root)).toBe(false);
    commit('skills/deploy-check/SKILL.md', 'skills: create deploy-check', T0);
    expect(hasHead(root)).toBe(true);
  });

  it('throws when git cannot answer, rather than reporting an empty history', () => {
    // Not a repository at all: git exits 128, which is not "no commit yet".
    expect(() => hasHead(plain)).toThrow(/not a git repository/);
  });
});

describe('conversationCommitPaths', () => {
  // `--since` is git's approxidate, not a timestamp: "@0" is read as *now* and "@1" as the 1st of
  // this month. A since of 0 therefore cut the log off at the moment it ran, and a commit made in
  // an earlier second was dropped — the flake this test pins down (2026-11-20).
  it('reads every commit when asked for everything since 0', () => {
    commit('skills/deploy-check/SKILL.md', 'skills: patch deploy-check\n\nTalkcode-Conversation: web:main/c1', T0);
    expect(conversationCommitPaths(root, 'web:main/c1', 0)).toEqual(['skills/deploy-check/SKILL.md']);
  });

  it('takes a commit made at the moment asked for, and leaves out an older one', () => {
    commit('skills/one/SKILL.md', 'skills: create one\n\nFleetherd-Conversation: web:main/c1', T0);
    commit('skills/two/SKILL.md', 'skills: create two\n\nFleetherd-Conversation: web:main/c1', T1);
    expect(conversationCommitPaths(root, 'web:main/c1', Date.parse(T0))).toEqual(['skills/two/SKILL.md', 'skills/one/SKILL.md']);
    expect(conversationCommitPaths(root, 'web:main/c1', Date.parse(T1))).toEqual(['skills/two/SKILL.md']);
    expect(conversationCommitPaths(root, 'web:main/c1', Date.parse(T1) + 1000)).toEqual([]);
  });

  it('is empty for a conversation no commit names, and for a repository with no commits', () => {
    expect(conversationCommitPaths(root, 'web:main/c1', 0)).toEqual([]);
    commit('skills/one/SKILL.md', 'skills: create one\n\nFleetherd-Conversation: web:main/c2', T0);
    expect(conversationCommitPaths(root, 'web:main/c1', 0)).toEqual([]);
  });
});
