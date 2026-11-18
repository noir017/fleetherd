/**
 * Turn changes, against a real git: real snapshots, real trees, real diffs.
 *
 * Every test builds a scratch repository and points a `localWorkspace` at it, so the git commands
 * run exactly as they would on a host — the point of this file is that no part of the snapshot is
 * faked except the platform that receives the entry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type { PlatformAdapter, TurnChangeEntry } from '../platform/adapter.js';
import { TurnChanges, type TurnChangesOptions } from './turn-changes.js';
import { localWorkspace, type Workspace } from './workspace.js';

const REF: ConversationRef = { platform: 'web', channel: 'main', thread: 'aaaabbbb', kind: 'direct', user: 'owner' };
const ADDRESS: ConversationAddress = { channel: 'main', thread: 'aaaabbbb' };

function sh(cwd: string, ...argv: string[]): string {
  return execFileSync(argv[0] as string, argv.slice(1), { cwd, encoding: 'utf8' });
}

function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-repo-'));
  sh(dir, 'git', 'init', '-q');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

interface Bench {
  changes: TurnChanges;
  repo: string;
  dir: string;
  ws: Workspace;
  platform: PlatformAdapter;
  entries: Array<{ address: ConversationAddress; entry: TurnChangeEntry }>;
  /** Wait for the next entry to arrive (the end snapshot is not awaited by the turn). */
  next: () => Promise<TurnChangeEntry>;
}

function bench(o: { files?: Record<string, string>; ws?: (ws: Workspace) => Workspace; opts?: Partial<TurnChangesOptions> } = {}): Bench {
  const repo = repoWith(o.files ?? { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': 'ignored.txt\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-state-'));
  const base = localWorkspace(repo);
  const ws = o.ws ? o.ws(base) : base;
  const entries: Array<{ address: ConversationAddress; entry: TurnChangeEntry }> = [];
  const waiting: Array<(e: TurnChangeEntry) => void> = [];
  const platform = {
    attachTurnChanges(address: ConversationAddress, entry: TurnChangeEntry) {
      entries.push({ address, entry });
      waiting.shift()?.(entry);
    },
  } as unknown as PlatformAdapter;
  const changes = new TurnChanges({
    dir,
    clock: { now: () => 1_700_000_000_000 },
    workspaceFor: () => ws,
    ...o.opts,
  });
  return {
    changes,
    repo,
    dir,
    ws,
    platform,
    entries,
    next: () =>
      new Promise((resolve, reject) => {
        if (entries.length > 0) return resolve(entries[entries.length - 1]!.entry);
        const timer = setTimeout(() => reject(new Error('no entry arrived')), 10_000);
        waiting.push((e) => {
          clearTimeout(timer);
          resolve(e);
        });
      }),
  };
}

let b: Bench;
beforeEach(() => {
  b = bench();
});

describe('turn changes: the two snapshots', () => {
  it('records what changed between the prompt and the end of the turn', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    expect(start).toBeDefined();
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(b.repo, 'b.txt'), 'new\n');
    b.changes.finish(start!);
    const entry = await b.next();

    expect(entry).toMatchObject({ turn: 1, files: 2, additions: 3, deletions: 1 });
    const answer = await b.changes.status('web#main#aaaabbbb', REF, 1);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.repo.root).toBe(fs.realpathSync(b.repo));
    const byPath = Object.fromEntries(answer.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['b.txt']).toEqual({ path: 'b.txt', status: 'added', additions: 1, deletions: 0 });
  });

  it('honours the work tree’s .gitignore', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'ignored.txt'), 'not mine\n');
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(start!);
    await b.next();
    const answer = await b.changes.status('web#main#aaaabbbb', REF, 1);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('takes no snapshot outside a git work tree', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-plain-'));
    const changes = new TurnChanges({
      dir: b.dir,
      clock: { now: () => 0 },
      workspaceFor: () => localWorkspace(plain),
      log: () => {},
    });
    expect(await changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS)).toBeUndefined();
  });

  it('does nothing for a platform with no place to show the entry', async () => {
    const chat = {} as unknown as PlatformAdapter;
    expect(await b.changes.start('web#main#aaaabbbb', REF, chat, ADDRESS)).toBeUndefined();
  });

  it('gives up on a snapshot that runs out of time', async () => {
    const slow = (ws: Workspace): Workspace => ({
      ...ws,
      run: (argv, o) =>
        Promise.resolve(
          o?.timeoutMs !== undefined && argv[1] === 'add'
            ? { code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true }
            : ws.run(argv, o)
        ),
    });
    const slowBench = bench({ ws: slow, opts: { startTimeoutMs: 200 } });
    const began = Date.now();
    const start = await slowBench.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    expect(start).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('never lets the end snapshot hold the turn open', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    const began = Date.now();
    b.changes.finish(start!);
    expect(Date.now() - began).toBeLessThan(50);
    await b.next();
  });
});

describe('turn changes: one file', () => {
  it('hands back both sides and a unified diff', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'one\nTWO\nthree\n');
    b.changes.finish(start!);
    await b.next();

    const answer = await b.changes.file('web#main#aaaabbbb', REF, 1, 'a.txt');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.original).toBe('one\ntwo\nthree\n');
    expect(answer.modified).toBe('one\nTWO\nthree\n');
    expect(answer.patch).toContain('--- a/a.txt');
    expect(answer.patch).toContain('-two');
    expect(answer.patch).toContain('+TWO');
  });

  it('has an empty side for a file that was added or deleted', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'b.txt'), 'new\n');
    fs.rmSync(path.join(b.repo, 'a.txt'));
    b.changes.finish(start!);
    await b.next();

    const added = await b.changes.file('web#main#aaaabbbb', REF, 1, 'b.txt');
    if (added.ok) expect([added.status, added.original, added.modified]).toEqual(['added', '', 'new\n']);
    else throw new Error(added.text);

    const deleted = await b.changes.file('web#main#aaaabbbb', REF, 1, 'a.txt');
    if (deleted.ok) expect([deleted.status, deleted.original, deleted.modified]).toEqual(['deleted', 'one\ntwo\nthree\n', '']);
    else throw new Error(deleted.text);
  });

  it('refuses a path the turn did not change', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(start!);
    await b.next();
    const answer = await b.changes.file('web#main#aaaabbbb', REF, 1, '../etc/passwd');
    expect(answer.ok).toBe(false);
    const untracked = await b.changes.file('web#main#aaaabbbb', REF, 1, 'nope.txt');
    expect(untracked.ok).toBe(false);
  });

  it('says so instead of sending a binary file’s bytes', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
    b.changes.finish(start!);
    await b.next();
    const answer = await b.changes.file('web#main#aaaabbbb', REF, 1, 'bin.dat');
    if (!answer.ok) throw new Error(answer.text);
    expect(answer.binary).toBe(true);
    expect([answer.original, answer.modified, answer.patch]).toEqual(['', '', '']);
  });

  it('says a file is too large rather than reading it whole', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'big.txt'), `${'x'.repeat(300 * 1024)}\n`);
    b.changes.finish(start!);
    await b.next();
    const answer = await b.changes.file('web#main#aaaabbbb', REF, 1, 'big.txt');
    if (!answer.ok) throw new Error(answer.text);
    expect(answer.tooLarge).toBe(true);
    expect([answer.original, answer.modified, answer.patch]).toEqual(['', '', '']);
  });
});

describe('turn changes: the records', () => {
  it('numbers the turns of one conversation and keeps the last ones', async () => {
    const changes = new TurnChanges({
      dir: b.dir,
      clock: { now: () => 0 },
      workspaceFor: () => b.ws,
      keepTurns: 2,
    });
    const entries: TurnChangeEntry[] = [];
    const show = { attachTurnChanges: (_a: ConversationAddress, e: TurnChangeEntry) => entries.push(e) } as unknown as PlatformAdapter;
    for (let i = 0; i < 3; i++) {
      const start = await changes.start('web#main#aaaabbbb', REF, show, ADDRESS);
      fs.writeFileSync(path.join(b.repo, 'a.txt'), `turn ${i}\n`);
      changes.finish(start!);
      await within(() => entries.length === i + 1);
    }
    expect(entries.map((e) => e.turn)).toEqual([1, 2, 3]);
    expect((await changes.status('web#main#aaaabbbb', REF, 1)).ok).toBe(false);
    expect((await changes.status('web#main#aaaabbbb', REF, 3)).ok).toBe(true);
    // The refs of the dropped turn went with its record.
    const refs = sh(b.repo, 'git', '--git-dir', `${snapRoot(b.repo)}/.git`, 'for-each-ref', '--format=%(refname)', 'refs/turns').trim();
    expect(refs.split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('reads its records back after a restart', async () => {
    const start = await b.changes.start('web#main#aaaabbbb', REF, b.platform, ADDRESS);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(start!);
    await b.next();

    const reopened = new TurnChanges({
      dir: b.dir,
      clock: { now: () => 0 },
      workspaceFor: () => b.ws,
    });
    const answer = await reopened.status('web#main#aaaabbbb', REF, 1);
    expect(answer.ok).toBe(true);
    const file = await reopened.file('web#main#aaaabbbb', REF, 1, 'a.txt');
    expect(file.ok).toBe(true);
  });

  it('answers a failure shape for a turn it never recorded', async () => {
    const answer = await b.changes.status('web#main#aaaabbbb', REF, 9);
    expect(answer).toMatchObject({ ok: false, reason: 'error' });
    const file = await b.changes.file('web#main#aaaabbbb', REF, 9, 'a.txt');
    expect(file.ok).toBe(false);
  });
});

/** Wait for a condition the end snapshot settles asynchronously. */
async function within(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('never happened');
}

/** The snapshot repository for a work tree, as the service names it (hash of the real path). */
function snapRoot(repo: string): string {
  const hash = createHash('sha256').update(fs.realpathSync(repo)).digest('hex').slice(0, 16);
  return `${process.env.HOME}/.fleetherd/snapshots/${hash}`;
}
