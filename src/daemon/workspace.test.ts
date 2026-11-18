import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceConflictError, localWorkspace, remoteWorkspace, sameContent } from './workspace.js';

describe('localWorkspace', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs argv in the root by default and collects stdout, stderr and the exit code', async () => {
    const ws = localWorkspace(dir);
    const r = await ws.run(['sh', '-c', 'pwd; echo oops >&2; exit 3']);
    expect(r.code).toBe(3);
    expect(fs.realpathSync(r.output.toString().trim())).toBe(fs.realpathSync(dir));
    expect(r.stderr).toBe('oops\n');
    expect(r.truncated).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('keeps the END of output past the cap and says so, as the host does', async () => {
    const r = await localWorkspace(dir).run(['sh', '-c', 'printf 0123456789'], { maxBytes: 4 });
    expect(r.output.toString()).toBe('6789');
    expect(r.truncated).toBe(true);
  });

  it('feeds stdin and passes env on top of the environment', async () => {
    const r = await localWorkspace(dir).run(['sh', '-c', 'cat; printf "$X"'], { stdin: 'in-', env: { X: 'env' } });
    expect(r.output.toString()).toBe('in-env');
  });

  it('kills a command that runs past its timeout', async () => {
    const r = await localWorkspace(dir).run(['sleep', '5'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
  });

  it('reports a command that could not start instead of throwing', async () => {
    const r = await localWorkspace(dir).run(['definitely-not-a-command-here']);
    expect(r.code).toBeNull();
    expect(r.spawnError).toMatch(/ENOENT/);
  });

  it('stats, lists through symlinks without broken ones, and refuses a read over the limit', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'broken'));
    const ws = localWorkspace(dir);
    expect(await ws.stat(path.join(dir, 'missing'))).toEqual({ exists: false });
    expect(await ws.stat(path.join(dir, 'a.txt'))).toMatchObject({ exists: true, dir: false, size: 5 });
    const listed = (await ws.listDir(dir)).sort((a, b) => a.name.localeCompare(b.name));
    expect(listed).toEqual([
      { name: 'a.txt', dir: false },
      { name: 'link', dir: true },
      { name: 'sub', dir: true },
    ]);
    expect((await ws.readFile(path.join(dir, 'a.txt'), 5)).toString()).toBe('hello');
    await expect(ws.readFile(path.join(dir, 'a.txt'), 4)).rejects.toThrow(/over the 4-byte limit/);
    await expect(ws.readFile(path.join(dir, 'sub'), 4)).rejects.toThrow(/is a directory/);
  });

  /**
   * The editor's write, held to the same three rules the host keeps: through the link, mode kept,
   * stale refused. A file written this way must look to the next reader exactly like one the
   * person saved in an editor of their own.
   */
  it('writes atomically through a symlink, keeps the mode and refuses a stale version', async () => {
    const ws = localWorkspace(dir);
    const real = path.join(dir, 'real.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(real, 'first\n', { mode: 0o640 });
    fs.symlinkSync(real, link);
    const before = fs.statSync(real);

    const out = await ws.writeFile(link, Buffer.from('second\n'), {
      size: before.size,
      mtimeMs: Math.trunc(before.mtimeMs),
    });
    const after = fs.statSync(real);
    expect(fs.readFileSync(real, 'utf8')).toBe('second\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(after.mode & 0o777).toBe(0o640);
    expect(out).toEqual({ size: after.size, mtimeMs: Math.trunc(after.mtimeMs) });

    // Someone else changes it; the old baseline is now a conflict and nothing is written.
    fs.writeFileSync(real, 'not ours\n');
    await expect(
      ws.writeFile(real, Buffer.from('from the page\n'), { size: out.size, mtimeMs: out.mtimeMs })
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
    expect(fs.readFileSync(real, 'utf8')).toBe('not ours\n');

    // The content hash catches what size and mtime cannot: a same-length body with the timestamp
    // put back.
    const bytesNow = fs.readFileSync(real);
    const sha = createHash('sha256').update(bytesNow).digest('hex');
    const now = fs.statSync(real);
    fs.writeFileSync(real, 'seconD\n');
    fs.utimesSync(real, now.atime, now.mtime);
    await expect(
      ws.writeFile(real, Buffer.from('mine\n'), {
        size: now.size,
        mtimeMs: Math.trunc(now.mtimeMs),
        sha256: sha,
      })
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
    // The right hash writes.
    await ws.writeFile(real, Buffer.from('mine\n'), {
      size: fs.statSync(real).size,
      mtimeMs: Math.trunc(fs.statSync(real).mtimeMs),
      sha256: createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
    });
    expect(fs.readFileSync(real, 'utf8')).toBe('mine\n');
    // Put the umask-default case back on a fresh file.
    fs.rmSync(real);

    // A new file gets the umask's answer, never 0600.
    const created = await ws.writeFile(path.join(dir, 'new.txt'), Buffer.from('x\n'), { missing: true });
    expect(created.size).toBe(2);
    const umask = process.umask();
    expect(fs.statSync(path.join(dir, 'new.txt')).mode & 0o777).toBe(0o666 & ~umask);
    // Expecting a new file where one exists is a conflict too, and so is a missing file expected
    // to be there.
    await expect(ws.writeFile(path.join(dir, 'new.txt'), Buffer.from('y'), { missing: true })).rejects.toBeInstanceOf(
      WorkspaceConflictError
    );
    await expect(ws.writeFile(path.join(dir, 'gone.txt'), Buffer.from('y'), { size: 1, mtimeMs: 1 })).rejects.toBeInstanceOf(
      WorkspaceConflictError
    );
    // No temporary left behind.
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('renames and removes inside the workspace only, and never a tree', async () => {
    const ws = localWorkspace(dir);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.mkdirSync(path.join(dir, 'full'));
    fs.writeFileSync(path.join(dir, 'full', 'keep'), 'k');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');

    await ws.rename(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('a');
    await expect(ws.rename(path.join(dir, 'b.txt'), path.join(dir, 'b.txt'))).rejects.toThrow(/already there/);
    await expect(ws.rename(path.join(dir, 'b.txt'), path.join(dir, '..', 'out.txt'))).rejects.toThrow(/not both under/);

    expect(await ws.remove(path.join(dir, 'b.txt'))).toEqual({ removed: true });
    expect(await ws.remove(path.join(dir, 'sub'))).toEqual({ removed: true });
    // Deleting what is already gone is the same answer the host gives, not an error.
    expect(await ws.remove(path.join(dir, 'b.txt'))).toEqual({ removed: false });
    // A directory with something in it is an answer the caller can explain, not a thrown errno.
    expect(await ws.remove(path.join(dir, 'full'))).toEqual({ removed: false, notEmpty: true });
    expect(fs.existsSync(path.join(dir, 'full', 'keep'))).toBe(true);
    await expect(ws.remove(path.join(dir, '..'))).rejects.toThrow(/not under/);
  });
});

describe('sameContent', () => {
  it('answers whether a file still has these bytes, and false when it cannot be read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-'));
    try {
      const file = path.join(dir, 'a.txt');
      fs.writeFileSync(file, 'abc');
      const sha = createHash('sha256').update('abc').digest('hex');
      expect(await sameContent(file, sha)).toBe(true);
      expect(await sameContent(file, 'b'.repeat(64))).toBe(false);
      // A path that cannot be read (here a directory) is "not this content", which the write
      // turns into a conflict — the same answer the host gives.
      expect(await sameContent(dir, sha)).toBe(false);
      expect(await sameContent(path.join(dir, 'missing'), sha)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remoteWorkspace', () => {
  it('runs on the host in the root, with the default cap and timeout, and normalises the answer', async () => {
    const seen: unknown[] = [];
    const ws = remoteWorkspace(
      {
        id: 'devbox',
        run: async (o) => {
          seen.push(o);
          return { code: 0, output: Buffer.from('ok'), truncated: true };
        },
        stat: async () => ({ exists: false }),
        listDir: async () => [],
        readFile: async () => Buffer.alloc(0),
        editWrite: async () => ({ ok: true as const, mtimeMs: 1, size: 2 }),
        mkdirp: async () => {},
        renameEntry: async () => {},
        removeEntry: async () => ({ removed: true }),
      },
      '~/work'
    );
    expect(ws.host).toBe('devbox');
    const r = await ws.run(['git', 'status']);
    expect(seen[0]).toMatchObject({ argv: ['git', 'status'], cwd: '~/work', timeoutMs: 30_000, max: 1 << 20 });
    expect(r).toEqual({ code: 0, output: Buffer.from('ok'), stderr: '', truncated: true, timedOut: false });
  });

  it('answers with the new size and mtime, and turns the host conflict into the typed error', async () => {
    const calls: unknown[] = [];
    let answer:
      | { ok: true; mtimeMs: number; size: number }
      | { ok: false; conflict: true; exists: boolean; size?: number; mtimeMs?: number } = {
      ok: true,
      mtimeMs: 7,
      size: 3,
    };
    const ws = remoteWorkspace(
      {
        id: 'devbox',
        run: async () => ({ code: 0, output: Buffer.alloc(0), truncated: false }),
        stat: async () => ({ exists: true, dir: false, size: 3, mtimeMs: 7, mode: 0o640 }),
        listDir: async () => [],
        readFile: async () => Buffer.alloc(0),
        editWrite: async (p, data, expect) => {
          calls.push({ p, data: Buffer.from(data).toString(), expect });
          return answer;
        },
        mkdirp: async () => {},
        renameEntry: async (from, to, owned) => {
          calls.push({ rename: [from, to, owned] });
        },
        removeEntry: async (p, owned) => {
          calls.push({ remove: [p, owned] });
          return { removed: true };
        },
      },
      '~/work'
    );
    expect(await ws.writeFile('~/work/a.txt', Buffer.from('abc'), { size: 3, mtimeMs: 7, sha256: 'f'.repeat(64) })).toEqual({
      mtimeMs: 7,
      size: 3,
    });
    expect(calls[0]).toEqual({
      p: '~/work/a.txt',
      data: 'abc',
      expect: { size: 3, mtimeMs: 7, sha256: 'f'.repeat(64) },
    });

    answer = { ok: false, conflict: true, exists: true, size: 9, mtimeMs: 8 };
    const err = await ws.writeFile('~/work/a.txt', Buffer.from('x'), { size: 3, mtimeMs: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceConflictError);
    expect(err).toMatchObject({ exists: true, size: 9, mtimeMs: 8 });

    await ws.rename('~/work/a.txt', '~/work/b.txt');
    await ws.remove('~/work/b.txt');
    // Both stay inside the workspace root the host is told about.
    expect(calls.slice(-2)).toEqual([
      { rename: ['~/work/a.txt', '~/work/b.txt', '~/work'] },
      { remove: ['~/work/b.txt', '~/work'] },
    ]);
    // An extra root is passed through as the fence.
    expect(await ws.remove('/mnt/other/x', '/mnt/other')).toEqual({ removed: true });
    expect(calls.at(-1)).toEqual({ remove: ['/mnt/other/x', '/mnt/other'] });
  });
});
