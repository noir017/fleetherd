/**
 * Turn changes, against a real git: real snapshots, real trees, real diffs.
 *
 * Every test builds a scratch repository and points a `localWorkspace` at it, so the git commands
 * run exactly as they would on a host — the point of this file is that no part of the snapshot is
 * faked except the platform that receives the entry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import type { PlatformAdapter, TurnChangeEntry } from '../platform/adapter.js';
import type { MessageRef } from '../types.js';
import { TurnChanges, type TurnChangesOptions } from './turn-changes.js';
import { localWorkspace, type Workspace } from './workspace.js';

const REF: ConversationRef = { platform: 'web', channel: 'main', thread: 'aaaabbbb', kind: 'direct', user: 'owner' };
const ADDRESS: ConversationAddress = { channel: 'main', thread: 'aaaabbbb' };
const ID = 'web#main#aaaabbbb';

/** What one `run` was asked to run, so a test can count the git calls it costs. */
interface Ran {
  argv: string[];
}

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

/** A workspace over the local machine that also records what it runs. */
function spyWorkspace(root: string): { ws: Workspace; ran: Ran[] } {
  const base = localWorkspace(root);
  const ran: Ran[] = [];
  return {
    ran,
    ws: { ...base, run: (argv, o) => { ran.push({ argv: [...argv] }); return base.run(argv, o); } },
  };
}

interface Bench {
  changes: TurnChanges;
  repo: string;
  dir: string;
  ws: Workspace;
  ran: Ran[];
  platform: PlatformAdapter;
  entries: Array<{ address: ConversationAddress; entry: TurnChangeEntry; reply?: MessageRef }>;
  /** Wait for the next entry to arrive (the end snapshot is not awaited by the turn). */
  next: () => Promise<TurnChangeEntry>;
}

function bench(o: { files?: Record<string, string>; ws?: (ws: Workspace) => Workspace; opts?: Partial<TurnChangesOptions> } = {}): Bench {
  const repo = repoWith(o.files ?? { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': 'ignored.txt\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-state-'));
  const spy = spyWorkspace(repo);
  const ws = o.ws ? o.ws(spy.ws) : spy.ws;
  const entries: Bench['entries'] = [];
  const waiting: Array<() => void> = [];
  const platform = {
    attachTurnChanges(address: ConversationAddress, entry: TurnChangeEntry, reply?: MessageRef) {
      entries.push({ address, entry, reply });
      waiting.shift()?.();
    },
  } as unknown as PlatformAdapter;
  const changes = new TurnChanges({
    dir,
    clock: { now: () => 1_700_000_000_000 },
    workspaceFor: () => ws,
    log: () => {},
    ...o.opts,
  });
  // Hands back each entry once, in the order they arrived — a test that runs two turns asks twice.
  let consumed = 0;
  const next = (): Promise<TurnChangeEntry> =>
    new Promise((resolve, reject) => {
      const take = (): boolean => {
        const e = entries[consumed];
        if (!e) return false;
        consumed += 1;
        resolve(e.entry);
        return true;
      };
      if (take()) return;
      const timer = setTimeout(() => reject(new Error('no entry arrived')), 10_000);
      waiting.push(() => {
        clearTimeout(timer);
        take();
      });
    });
  return { changes, repo, dir, ws, ran: spy.ran, platform, entries, next };
}

/** Start a turn and hang the entry off a reply, as the runner does at turn end. */
async function begin(b: Bench, reply = 'w1'): Promise<NonNullable<Awaited<ReturnType<TurnChanges['start']>>>> {
  const handle = await b.changes.start(ID, REF, b.platform, ADDRESS);
  expect(handle).toBeDefined();
  handle!.reply = { address: ADDRESS, messageId: reply };
  return handle!;
}

async function within(ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('never happened');
}

/** The snapshot repository for a work tree, as the service names it (hash of the real path). */
function snapRoot(repo: string): string {
  const hash = createHash('sha256').update(fs.realpathSync(repo)).digest('hex').slice(0, 16);
  return `${process.env.HOME}/.fleetherd/snapshots/${hash}`;
}

function refs(repo: string): string[] {
  const out = sh(repo, 'git', '--git-dir', `${snapRoot(repo)}/.git`, 'for-each-ref', '--format=%(refname)', 'refs/turns');
  return out.trim().split('\n').filter(Boolean);
}

let b: Bench;
beforeEach(() => {
  b = bench();
});

describe('turn changes: the two snapshots', () => {
  it('records what changed between the prompt and the end of the turn', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(b.repo, 'b.txt'), 'new\n');
    b.changes.finish(handle);
    const entry = await b.next();

    expect(entry).toMatchObject({ turn: 1, files: 2, additions: 3, deletions: 1 });
    expect(b.entries[0]?.reply?.messageId).toBe('w1');
    const answer = await b.changes.status(ID, REF, 1);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.repo.root).toBe(fs.realpathSync(b.repo));
    const byPath = Object.fromEntries(answer.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['b.txt']).toEqual({ path: 'b.txt', status: 'added', additions: 1, deletions: 0 });
  });

  it('honours the work tree’s .gitignore', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'ignored.txt'), 'not mine\n');
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(handle);
    await b.next();
    const answer = await b.changes.status(ID, REF, 1);
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
    expect(await changes.start(ID, REF, b.platform, ADDRESS)).toBeUndefined();
  });

  it('does nothing for a platform with no place to show the entry', async () => {
    const chat = {} as unknown as PlatformAdapter;
    expect(await b.changes.start(ID, REF, chat, ADDRESS)).toBeUndefined();
  });

  it('leaves a turn that changed nothing without an entry, but keeps its number', async () => {
    const handle = await begin(b);
    b.changes.finish(handle);
    await within(async () => (await b.changes.status(ID, REF, 1)).ok);
    expect(b.entries).toEqual([]);
    const second = await begin(b, 'w2');
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(second);
    expect((await b.next()).turn).toBe(2);
  });
});

describe('turn changes: bounded, and not repeated when a directory is slow', () => {
  it('gives up on a start snapshot that never answers', async () => {
    // The shape of a remote host that went away: ws.run is a promise nobody will ever settle,
    // which no per-command timeout can help — only the race around the whole snapshot can.
    const hung = bench({ opts: { startTimeoutMs: 150 }, ws: (ws) => ({ ...ws, run: () => new Promise(() => {}) }) }).changes;
    const began = Date.now();
    const handle = await hung.start(ID, REF, b.platform, ADDRESS);
    expect(handle).toBeUndefined();
    // The race, not a git timeout: nothing here ever settles.
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('does not pay the wait again in the same directory', async () => {
    const slow = bench({
      opts: { startTimeoutMs: 100 },
      ws: (ws) => ({ ...ws, run: (argv, o) => (argv[1] === 'rev-parse' ? new Promise(() => {}) : ws.run(argv, o)) }),
    });
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeUndefined();
    const calls = slow.ran.length;
    const began = Date.now();
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(50);
    expect(slow.ran.length).toBe(calls);
  });

  it('never lets the end snapshot hold the turn open', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    const began = Date.now();
    b.changes.finish(handle);
    expect(Date.now() - began).toBeLessThan(50);
    await b.next();
  });
});

describe('turn changes: numbers and replies', () => {
  it('numbers turns when they end, not when their snapshots finish', async () => {
    // The first turn's end snapshot is held for 300 ms; the second's finishes first. Numbers and
    // replies must still follow the order the turns ended in.
    let delayNextAdd = 0;
    const held = bench({
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (delayNextAdd > 0 && argv[1] === 'add') {
            delayNextAdd -= 1;
            await new Promise((r) => setTimeout(r, 300));
          }
          return ws.run(argv, o);
        },
      }),
    });
    const first = await begin(held, 'reply-1');
    fs.writeFileSync(path.join(held.repo, 'a.txt'), 'first\n');
    delayNextAdd = 1;
    held.changes.finish(first);
    const second = await begin(held, 'reply-2');
    fs.writeFileSync(path.join(held.repo, 'a.txt'), 'second\n');
    held.changes.finish(second);

    await within(() => held.entries.length === 2);
    const byReply = Object.fromEntries(held.entries.map((e) => [e.reply?.messageId, e.entry.turn]));
    expect(byReply).toEqual({ 'reply-1': 1, 'reply-2': 2 });
    const one = await held.changes.status(ID, REF, 1);
    const two = await held.changes.status(ID, REF, 2);
    if (!one.ok || !two.ok) throw new Error('both turns should be recorded');
    expect(one.repo.base).not.toBe(two.repo.base);
  });
});

describe('turn changes: one file', () => {
  it('hands back both sides and a unified diff', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'one\nTWO\nthree\n');
    b.changes.finish(handle);
    await b.next();

    const answer = await b.changes.file(ID, REF, 1, 'a.txt');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.original).toBe('one\ntwo\nthree\n');
    expect(answer.modified).toBe('one\nTWO\nthree\n');
    expect(answer.patch).toContain('--- a/a.txt');
    expect(answer.patch).toContain('-two');
    expect(answer.patch).toContain('+TWO');
  });

  it('has an empty side for a file that was added or deleted', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'b.txt'), 'new\n');
    fs.rmSync(path.join(b.repo, 'a.txt'));
    b.changes.finish(handle);
    await b.next();

    const added = await b.changes.file(ID, REF, 1, 'b.txt');
    if (added.ok) expect([added.status, added.original, added.modified]).toEqual(['added', '', 'new\n']);
    else throw new Error(added.text);

    const deleted = await b.changes.file(ID, REF, 1, 'a.txt');
    if (deleted.ok) expect([deleted.status, deleted.original, deleted.modified]).toEqual(['deleted', 'one\ntwo\nthree\n', '']);
    else throw new Error(deleted.text);
  });

  it('refuses a path the turn did not change', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(handle);
    await b.next();
    const answer = await b.changes.file(ID, REF, 1, '../etc/passwd');
    expect(answer.ok).toBe(false);
    const untracked = await b.changes.file(ID, REF, 1, 'nope.txt');
    expect(untracked.ok).toBe(false);
  });

  it('says so instead of sending a binary file’s bytes', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
    b.changes.finish(handle);
    await b.next();
    const answer = await b.changes.file(ID, REF, 1, 'bin.dat');
    if (!answer.ok) throw new Error(answer.text);
    expect(answer.binary).toBe(true);
    expect([answer.original, answer.modified, answer.patch]).toEqual(['', '', '']);
  });

  it('says a file is too large rather than reading it whole', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'big.txt'), `${'x'.repeat(300 * 1024)}\n`);
    b.changes.finish(handle);
    await b.next();
    const answer = await b.changes.file(ID, REF, 1, 'big.txt');
    if (!answer.ok) throw new Error(answer.text);
    expect(answer.tooLarge).toBe(true);
    expect([answer.original, answer.modified, answer.patch]).toEqual(['', '', '']);
  });

  it('diffs the two trees once, however many files are opened', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(b.repo, 'b.txt'), 'new\n');
    b.changes.finish(handle);
    await b.next();
    const afterTurn = b.ran.length;
    await b.changes.status(ID, REF, 1);
    await b.changes.status(ID, REF, 1);
    await b.changes.file(ID, REF, 1, 'a.txt');
    await b.changes.file(ID, REF, 1, 'b.txt');
    expect(
      b.ran.slice(afterTurn).filter((r) => r.argv[1] === 'diff' && (r.argv[2] === '--numstat' || r.argv[2] === '--raw'))
    ).toEqual([]);
  });
});

describe('turn changes: the repository it keeps', () => {
  it('reuses one index, rather than scanning the tree from scratch every turn', async () => {
    const first = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'first\n');
    b.changes.finish(first);
    await b.next();
    expect(fs.existsSync(`${snapRoot(b.repo)}/index`)).toBe(true);

    const second = await begin(b, 'w2');
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'second\n');
    b.changes.finish(second);
    await within(() => b.entries.length === 2);
    // A temporary index is only ever a fallback, and it is removed on the way out.
    expect(fs.readdirSync(snapRoot(b.repo)).filter((n) => n.startsWith('index-'))).toEqual([]);
  });

  it('does not call a repository slow when its index was merely busy', async () => {
    // The bug this pins: a held index fell back to a full scan, the fallback ran out of budget,
    // and the directory was then left alone for ten minutes — two topics sharing one directory is
    // the documented case, not a bad repository.
    let adds = 0;
    const contended = bench({
      opts: { startTimeoutMs: 100 },
      ws: (ws) => ({
        ...ws,
        run: (argv, o) => {
          if (argv[1] === 'add') {
            adds += 1;
            return Promise.resolve(
              o?.env?.GIT_INDEX_FILE?.endsWith('/index')
                ? { code: 128, output: Buffer.alloc(0), stderr: "fatal: Unable to create 'index.lock': File exists.", truncated: false, timedOut: false }
                : { code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true }
            );
          }
          return ws.run(argv, o);
        },
      }),
    });
    expect(await contended.changes.start(ID, REF, contended.platform, ADDRESS)).toBeUndefined();
    const before = adds;
    expect(await contended.changes.start(ID, REF, contended.platform, ADDRESS)).toBeUndefined();
    // Still trying: the second start reached git again rather than being skipped as "slow".
    expect(adds).toBeGreaterThan(before);
  });

  it('treats a timed-out add as no answer, and keeps the shared index', async () => {
    const first = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'first\n');
    b.changes.finish(first);
    await b.next();
    const indexPath = `${snapRoot(b.repo)}/index`;
    expect(fs.existsSync(indexPath)).toBe(true);

    let timeoutsLeft = 0;
    const slow = bench({
      ws: (ws) => ({
        ...ws,
        run: (argv, o) => {
          if (argv[1] === 'add' && timeoutsLeft > 0) {
            timeoutsLeft -= 1;
            return Promise.resolve({ code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true });
          }
          return ws.run(argv, o);
        },
      }),
      opts: { startTimeoutMs: 200 },
    });
    // The bench above has its own repository: build a warm index there first.
    const warm = await slow.changes.start(ID, REF, slow.platform, ADDRESS);
    expect(warm).toBeDefined();
    warm!.reply = { address: ADDRESS, messageId: 'w1' };
    fs.writeFileSync(path.join(slow.repo, 'a.txt'), 'warm\n');
    slow.changes.finish(warm!);
    await slow.next();
    const slowIndex = `${snapRoot(slow.repo)}/index`;
    expect(fs.existsSync(slowIndex)).toBe(true);

    timeoutsLeft = 1;
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeUndefined();
    expect(fs.existsSync(slowIndex)).toBe(true);
  });

  it('keeps the shared index when write-tree is the one that timed out', async () => {
    const timed = bench({
      opts: { startTimeoutMs: 300 },
      ws: (ws) => ({
        ...ws,
        run: (argv, o) => {
          if (argv[1] === 'write-tree') {
            return Promise.resolve({ code: null, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: true });
          }
          return ws.run(argv, o);
        },
      }),
    });
    expect(await timed.changes.start(ID, REF, timed.platform, ADDRESS)).toBeUndefined();
    // The add had already written it, warm and correct: deleting it would throw away the scan.
    expect(fs.existsSync(`${snapRoot(timed.repo)}/index`)).toBe(true);
  });

  it('takes one snapshot at a time per repository', async () => {
    // add releases index.lock when it returns and write-tree reads the index after it. Two turns
    // of one repository interleaving there would write one turn's state into the other's tree.
    const order: string[] = [];
    const queued = bench({
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (argv[1] === 'add' || argv[1] === 'write-tree') {
            order.push(argv[1]);
            await new Promise((r) => setTimeout(r, 20));
          }
          return ws.run(argv, o);
        },
      }),
    });
    const [one, two] = await Promise.all([
      queued.changes.start(ID, REF, queued.platform, ADDRESS),
      queued.changes.start(ID, REF, queued.platform, ADDRESS),
    ]);
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(order).toEqual(['add', 'write-tree', 'add', 'write-tree']);
  });

  it('falls back to a temporary index when the shared one is busy', async () => {
    // What a second turn in the same directory meets: `git add` cannot take the index.lock.
    let busy = 0;
    const contended = bench({
      ws: (ws) => ({
        ...ws,
        run: (argv, o) => {
          if (argv[1] === 'add' && o?.env?.GIT_INDEX_FILE?.endsWith('/index') && busy === 0) {
            busy = 1;
            return Promise.resolve({
              code: 128,
              output: Buffer.alloc(0),
              stderr: "fatal: Unable to create '/s/index.lock': File exists.",
              truncated: false,
              timedOut: false,
            });
          }
          return ws.run(argv, o);
        },
      }),
    });
    const handle = await contended.changes.start(ID, REF, contended.platform, ADDRESS);
    expect(handle).toBeDefined();
    handle!.reply = { address: ADDRESS, messageId: 'w1' };
    fs.writeFileSync(path.join(contended.repo, 'a.txt'), 'changed\n');
    contended.changes.finish(handle!);
    expect((await contended.next()).files).toBe(1);
  });

  it('clears an index.lock a killed snapshot left behind', async () => {
    const first = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'first\n');
    b.changes.finish(first);
    await b.next();
    // SIGKILL leaves the lock; without clearing it every later snapshot would take the slow path.
    const lock = `${snapRoot(b.repo)}/index.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lock, old, old);

    const second = await begin(b, 'w2');
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'second\n');
    b.changes.finish(second);
    expect((await b.next()).turn).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('keeps the snapshot repository out of a work tree that contains it', async () => {
    // $HOME as the project root is the case that made `git add` refuse the whole tree.
    const root = repoWith({ 'a.txt': 'one\n' });
    vi.stubEnv('HOME', root);
    try {
      const inside = bench();
      const changes = new TurnChanges({
        dir: inside.dir,
        clock: { now: () => 0 },
        workspaceFor: () => localWorkspace(root),
        log: () => {},
      });
      const handle = await changes.start(ID, REF, inside.platform, ADDRESS);
      expect(handle).toBeDefined();
      handle!.reply = { address: ADDRESS, messageId: 'w1' };
      fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
      changes.finish(handle!);
      await within(async () => (await changes.status(ID, REF, 1)).ok);
      const answer = await changes.status(ID, REF, 1);
      if (!answer.ok) throw new Error(answer.text);
      expect(answer.files.map((f) => f.path)).toEqual(['a.txt']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names the project’s branch, not the snapshot store’s', async () => {
    sh(b.repo, 'git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed');
    const expected = sh(b.repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    expect(expected).not.toBe('HEAD');
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(handle);
    await b.next();
    const answer = await b.changes.status(ID, REF, 1);
    if (!answer.ok) throw new Error(answer.text);
    expect(answer.repo.branch).toBe(expected);
  });

  it('keeps the last turns and releases the refs of the rest', async () => {
    const changes = new TurnChanges({
      dir: b.dir,
      clock: { now: () => 0 },
      workspaceFor: () => b.ws,
      keepTurns: 2,
      log: () => {},
    });
    const shown = { attachTurnChanges: () => {} } as unknown as PlatformAdapter;
    for (let i = 0; i < 3; i++) {
      const handle = await changes.start(ID, REF, shown, ADDRESS);
      handle!.reply = { address: ADDRESS, messageId: `r${i}` };
      fs.writeFileSync(path.join(b.repo, 'a.txt'), `turn ${i}\n`);
      changes.finish(handle!);
      await within(async () => (await changes.status(ID, REF, i + 1)).ok);
    }
    expect((await changes.status(ID, REF, 1)).ok).toBe(false);
    expect((await changes.status(ID, REF, 3)).ok).toBe(true);
    await within(() => refs(b.repo).length === 4);
  });

  it('does not write a record back after its topic was dropped', async () => {
    // The end snapshot runs long after the turn; the topic can be gone before it lands.
    let delay = 0;
    const slow = bench({
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (delay > 0 && argv[1] === 'add') {
            delay -= 1;
            await new Promise((r) => setTimeout(r, 300));
          }
          return ws.run(argv, o);
        },
      }),
    });
    const handle = await begin(slow);
    fs.writeFileSync(path.join(slow.repo, 'a.txt'), 'changed\n');
    delay = 1;
    slow.changes.finish(handle);
    slow.changes.forget(ID, REF);
    await new Promise((r) => setTimeout(r, 700));

    expect((await slow.changes.status(ID, REF, 1)).ok).toBe(false);
    expect(refs(slow.repo)).toEqual([]);
  });

  it('forgets a conversation’s records and refs when its topic goes', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(handle);
    await b.next();
    expect(refs(b.repo)).toHaveLength(2);

    b.changes.forget(ID, REF);
    expect((await b.changes.status(ID, REF, 1)).ok).toBe(false);
    await within(() => refs(b.repo).length === 0);
  });
});

describe('turn changes: the records', () => {
  it('reads its records back after a restart', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.finish(handle);
    await b.next();

    const reopened = new TurnChanges({
      dir: b.dir,
      clock: { now: () => 0 },
      workspaceFor: () => b.ws,
      log: () => {},
    });
    const answer = await reopened.status(ID, REF, 1);
    expect(answer.ok).toBe(true);
    const file = await reopened.file(ID, REF, 1, 'a.txt');
    expect(file.ok).toBe(true);
  });

  it('answers a failure shape for a turn it never recorded', async () => {
    const answer = await b.changes.status(ID, REF, 9);
    expect(answer).toMatchObject({ ok: false, reason: 'error' });
    const file = await b.changes.file(ID, REF, 9, 'a.txt');
    expect(file.ok).toBe(false);
  });
});
