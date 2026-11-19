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
  /** What the service said, for a test about a snapshot it refused. */
  logs: string[];
  /** Wait for the next entry to arrive (the end snapshot is not awaited by the turn). */
  next: () => Promise<TurnChangeEntry>;
}

function bench(o: { files?: Record<string, string>; ws?: (ws: Workspace) => Workspace; opts?: Partial<TurnChangesOptions> } = {}): Bench {
  const repo = repoWith(o.files ?? { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': 'ignored.txt\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-state-'));
  const spy = spyWorkspace(repo);
  const ws = o.ws ? o.ws(spy.ws) : spy.ws;
  const entries: Bench['entries'] = [];
  const logs: string[] = [];
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
    log: (line) => logs.push(line),
    // Real git under a loaded machine (the full suite) can take seconds; the production 3 s budget
    // would turn that into a flaky "no snapshot". A test about the budget sets its own.
    startTimeoutMs: 30_000,
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
  return { changes, repo, dir, ws, ran: spy.ran, platform, entries, logs, next };
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
    // A 2 s budget against a 1 s bound: paying the wait again would show as two seconds, and a
    // loaded machine's event loop cannot stretch an in-memory skip that far.
    const slow = bench({
      opts: { startTimeoutMs: 2_000 },
      ws: (ws) => ({ ...ws, run: (argv, o) => (argv[1] === 'rev-parse' ? new Promise(() => {}) : ws.run(argv, o)) }),
    });
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeUndefined();
    const calls = slow.ran.length;
    const began = Date.now();
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(slow.ran.length).toBe(calls);
  });

  it('does not start a queued init whose budget went to the wait', async () => {
    // The first init holds the queue past the second start's deadline. The second must not spawn
    // a git it cannot wait for, and the log must say the wait timed out — never `exit null`.
    let inits = 0;
    const slow = bench({
      opts: { startTimeoutMs: 150 },
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (argv[1] === 'init') {
            inits += 1;
            if (inits === 1) await new Promise((r) => setTimeout(r, 300));
          }
          return ws.run(argv, o);
        },
      }),
    });
    const both = await Promise.all([
      slow.changes.start(ID, REF, slow.platform, ADDRESS),
      slow.changes.start(ID, REF, slow.platform, ADDRESS),
    ]);
    expect(both).toEqual([undefined, undefined]);
    await within(() => slow.logs.some((l) => l.includes('(timed out)')));
    expect(inits).toBe(1);
    expect(slow.logs.join('\n')).not.toContain('exit null');
  });

  it('never lets the end snapshot hold the turn open', async () => {
    const handle = await begin(b);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    const began = Date.now();
    b.changes.finish(handle);
    // finish returns before git is even started; the bound only has to beat one git process.
    expect(Date.now() - began).toBeLessThan(250);
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

  it('answers busy, not slow, when the queue left too little of the budget', async () => {
    // A snapshot that waited most of its budget away must not start a scan it cannot finish: the
    // killed add reads as "no answer" and would mark a busy directory as slow for ten minutes.
    let adds = 0;
    let holdFirst = true;
    // Wide margins on both sides, so a loaded machine cannot move the outcome: the first snapshot
    // has 20 s to finish, and the queued one finds less than the 18 s floor left once the first
    // has held its add for 3 s — busy, whatever the real git calls cost.
    const slow = bench({
      opts: { startTimeoutMs: 20_000, minQueuedBudgetMs: 18_000 },
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (argv[1] === 'add') {
            adds += 1;
            if (holdFirst) {
              holdFirst = false;
              await new Promise((r) => setTimeout(r, 3_000));
            }
          }
          return ws.run(argv, o);
        },
      }),
    });
    const both = await Promise.all([
      slow.changes.start(ID, REF, slow.platform, ADDRESS),
      slow.changes.start(ID, REF, slow.platform, ADDRESS),
    ]);
    // Which call reaches the queue first is not the order they were made in — each resolves its
    // repository with git before queueing, and on a loaded machine the second can get there first
    // (2026-11-18, the coverage run). What holds either way: one snapshot, one busy.
    expect(both.filter((h) => h !== undefined)).toHaveLength(1);
    // The queued turn never reached git — that is what "busy" means here.
    expect(adds).toBe(1);
    // And nothing was remembered as slow: the next turn runs its own snapshot.
    expect(await slow.changes.start(ID, REF, slow.platform, ADDRESS)).toBeDefined();
    expect(adds).toBe(2);
  }, 60_000);

  it('takes one snapshot at a time per repository', async () => {
    // add releases index.lock when it returns and write-tree reads the index after it. Two turns
    // of one repository interleaving there would write one turn's state into the other's tree.
    const order: string[] = [];
    const queued = bench({
      // The order is the point, not the budget: room enough that a loaded machine cannot turn the
      // second snapshot into "busy" (2026-11-18, the full suite did).
      opts: { startTimeoutMs: 30_000 },
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
  }, 60_000);

  it('prepares the snapshot repository once, even when two turns start together', async () => {
    // `git init` is idempotent on an existing repository, but not safe to run twice AT ONCE on the
    // same directory: it takes `.git/config`'s lock and copies the template hooks, and the loser
    // fails with "File exists" (2026-11-19, the release workflow). Two topics in one directory
    // start their turns together, and the loser used to lose its snapshot with no log at all.
    let inits = 0;
    let holdFirst = true;
    const together = bench({
      ws: (ws) => ({
        ...ws,
        run: async (argv, o) => {
          if (argv[1] !== 'init') return ws.run(argv, o);
          if (inits > 0) {
            // Exactly what a second real `git init` answers while the first holds the lock.
            return {
              code: 128,
              output: Buffer.alloc(0),
              stderr: "fatal: Unable to create '/s/.git/config.lock': File exists.",
              truncated: false,
              timedOut: false,
            };
          }
          inits += 1;
          try {
            // Hold the first one open so the other start reaches git while it is still running:
            // the queue must keep the second call from arriving here at all.
            if (holdFirst) {
              holdFirst = false;
              await new Promise((r) => setTimeout(r, 300));
            }
            return await ws.run(argv, o);
          } finally {
            inits -= 1;
          }
        },
      }),
    });
    const [one, two] = await Promise.all([
      together.changes.start(ID, REF, together.platform, ADDRESS),
      together.changes.start(ID, REF, together.platform, ADDRESS),
    ]);
    expect(one).toBeDefined();
    expect(two).toBeDefined();
  }, 60_000);

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

  it('replaces the exclude line, so an add beside it never sees it empty', async () => {
    // The work tree that contains the snapshot store ($HOME as the project root) needs
    // `info/exclude`; two starts of one repository rewrite the same line. A redirect would truncate
    // it first, and the other start's `git add` would read it empty and sweep the store into the
    // tree. The write is held here to make that window as wide as it can be.
    const root = repoWith({ 'a.txt': 'one\n' });
    vi.stubEnv('HOME', root);
    try {
      const shown = { attachTurnChanges: () => {} } as unknown as PlatformAdapter;
      const first = new TurnChanges({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-exclude-')),
        clock: { now: () => 0 },
        workspaceFor: () => localWorkspace(root),
        log: () => {},
      });
      const warm = await first.start(ID, REF, shown, ADDRESS);
      expect(warm).toBeDefined();
      first.finish(warm!);
      await within(async () => (await first.status(ID, REF, 1)).ok);

      const snap = snapRoot(root);
      const exclude = `${snap}/.git/info/exclude`;
      const line = `/${path.relative(fs.realpathSync(root), snap)}/\n`;
      expect(fs.readFileSync(exclude, 'utf8')).toBe(line);

      let held = 0;
      const base = localWorkspace(root);
      const env = { GIT_DIR: `${snap}/.git`, GIT_WORK_TREE: fs.realpathSync(root), GIT_INDEX_FILE: `${snap}/check` };
      const hooked: Workspace = {
        ...base,
        writeFile: async (p, data, want) => {
          if (p !== exclude) return base.writeFile(p, data, want);
          held += 1;
          // The replacement is in flight and the rename has not happened: an `add` running now
          // must still see the complete line, not an empty file.
          const add = await base.run(['git', 'add', '-A'], { cwd: root, env });
          expect(add.code).toBe(0);
          const staged = (await base.run(['git', 'ls-files'], { cwd: root, env })).output.toString('utf8');
          expect(staged.trim().split('\n')).toEqual(['a.txt']);
          return base.writeFile(p, data, want);
        },
      };
      const second = new TurnChanges({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'turn-changes-exclude-')),
        clock: { now: () => 0 },
        workspaceFor: () => hooked,
        log: () => {},
      });
      expect(await second.start(ID, REF, shown, ADDRESS)).toBeDefined();
      expect(held, 'the exclude is replaced through writeFile, not a redirect').toBe(1);
      expect(fs.readFileSync(exclude, 'utf8')).toBe(line);
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

  it('drops the forgotten mark once nothing is in flight', async () => {
    const internals = (c: TurnChanges): { forgotten: Set<string>; openHandles: Map<string, number> } =>
      c as unknown as { forgotten: Set<string>; openHandles: Map<string, number> };

    // Nothing running: the mark has no reader, and a set that only grew would outlive the process
    // for every topic ever deleted.
    b.changes.forget(ID, REF);
    expect(internals(b.changes).forgotten.size).toBe(0);
    expect(internals(b.changes).openHandles.size).toBe(0);

    // With a turn in flight it is held until that turn's end snapshot has landed.
    const handle = await begin(b);
    expect(internals(b.changes).openHandles.get(ID)).toBe(1);
    fs.writeFileSync(path.join(b.repo, 'a.txt'), 'changed\n');
    b.changes.forget(ID, REF);
    expect(internals(b.changes).forgotten.has(ID)).toBe(true);
    b.changes.finish(handle);
    await within(() => internals(b.changes).forgotten.size === 0);
    expect(internals(b.changes).openHandles.size).toBe(0);
    expect((await b.changes.status(ID, REF, 1)).ok).toBe(false);
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
    // The entry is announced before `update-ref` has answered (the refs are what a gc must keep,
    // not what the page reads), so a loaded machine can get here first.
    await within(() => refs(b.repo).length === 2);

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
