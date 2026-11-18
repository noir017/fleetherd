import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localWorkspace, remoteWorkspace } from './workspace.js';

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
      },
      '~/work'
    );
    expect(ws.host).toBe('devbox');
    const r = await ws.run(['git', 'status']);
    expect(seen[0]).toMatchObject({ argv: ['git', 'status'], cwd: '~/work', timeoutMs: 30_000, max: 1 << 20 });
    expect(r).toEqual({ code: 0, output: Buffer.from('ok'), stderr: '', truncated: true, timedOut: false });
  });
});
