import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConversationRef } from '../core/conversation.js';
import { MAX_EDIT_BYTES, buildFilesPanel } from './file-panel.js';
import type { Workspace } from './workspace.js';
import { WorkspaceConflictError, localWorkspace } from './workspace.js';

const REF: ConversationRef = { platform: 'webui', channel: 'main', thread: '0a0b0c0d', kind: 'thread', user: 'owner' };

describe('buildFilesPanel on this machine', () => {
  let dir: string;
  let extra: string;
  const logs: string[] = [];

  function panel(roots: string[] = []) {
    return buildFilesPanel({
      instance: 'webui',
      roots,
      workspaceForRef: () => localWorkspace(dir),
      log: (line) => logs.push(line),
    });
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')));
    extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-extra-')));
    logs.length = 0;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  });

  it('lists the workspace root, a relative path and an absolute one, and refuses an escape', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');

    const root = await panel().list(REF, '');
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.path).toBe(dir);
    expect(root.rel).toBe('');
    expect(root.entries.map((e) => e.name)).toEqual(['src', 'a.txt']);

    const sub = await panel().list(REF, 'src');
    expect(sub.ok && sub.path).toBe(path.join(dir, 'src'));
    const abs = await panel().list(REF, path.join(dir, 'src'));
    expect(abs.ok && abs.rel).toBe('src');

    const dotted = await panel().list(REF, 'src/../src');
    expect(dotted.ok && dotted.rel).toBe('src');

    for (const escape of ['..', '../', 'src/../..', '/etc', path.join(dir, '..')]) {
      const r = await panel().list(REF, escape);
      expect(r.ok, escape).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/outside this topic's workspace|climbs out/);
    }
  });

  it('allows an extra root, and keeps relative paths against the working directory', async () => {
    fs.writeFileSync(path.join(extra, 'shared.md'), '# shared\n');
    const r = await panel([extra]).list(REF, extra);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(extra);
      // Not under the working directory, so no rel: the page shows the absolute path.
      expect(r.rel).toBeUndefined();
      expect(r.entries.map((e) => e.name)).toContain('shared.md');
    }
    expect((await panel([extra]).read(REF, path.join(extra, 'shared.md'))).ok).toBe(true);
    // An unlisted root is still refused.
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-other-')));
    try {
      expect((await panel([extra]).list(REF, other)).ok).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('reads text, renders markdown on request, and refuses to edit what is not UTF-8 text', async () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Hi\n\nbody\n');
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x61, 0x00, 0x62]));
    fs.writeFileSync(path.join(dir, 'bad'), Buffer.from([0xff, 0xfe]));
    fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(MAX_EDIT_BYTES + 1, 0x61));
    fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const md = await panel().read(REF, 'notes.md', { preview: true });
    expect(md.ok).toBe(true);
    if (md.ok) {
      expect(md.kind).toBe('text');
      expect(md.text).toBe('# Hi\n\nbody\n');
      expect(md.html).toContain('<h1>');
      expect(md.mode).toBeTypeOf('number');
    }
    const plain = await panel().read(REF, 'notes.md');
    expect(plain.ok && plain.html).toBeUndefined();

    const bin = await panel().read(REF, 'bin');
    expect(bin.ok && bin.kind).toBe('binary');
    expect(bin.ok && bin.note).toMatch(/Binary/);
    const bad = await panel().read(REF, 'bad');
    expect(bad.ok && bad.kind).toBe('binary');
    const big = await panel().read(REF, 'big.txt');
    expect(big.ok && big.kind).toBe('big');
    expect(big.ok && big.text).toBeUndefined();
    const img = await panel().read(REF, 'p.png');
    expect(img.ok && img.kind).toBe('image');
    expect(img.ok && img.dataUrl).toMatch(/^data:image\/png;base64,/);
    const missing = await panel().read(REF, 'nope');
    expect(missing.ok).toBe(false);
  });

  it('writes through a symlink, logs who and where, and turns a stale save into a conflict', async () => {
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'one\n', { mode: 0o640 });
    fs.symlinkSync(real, path.join(dir, 'link.txt'));
    const st = fs.statSync(real);

    const first = await panel().write(REF, 'link.txt', 'two\n', { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
    expect(first.ok).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('two\n');
    expect(fs.lstatSync(path.join(dir, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    expect(logs.at(-1)).toContain('owner@webui');
    expect(logs.at(-1)).toContain(`local:${path.join(dir, 'link.txt')}`);
    expect(logs.at(-1)).toMatch(/wrote .*\(4 bytes\)/);

    fs.writeFileSync(real, 'changed\n');
    const stale = await panel().write(REF, 'link.txt', 'mine\n', {
      size: first.ok ? first.size : 0,
      mtimeMs: first.ok ? first.mtimeMs : 0,
    });
    expect(stale.ok).toBe(false);
    expect(stale).toMatchObject({ conflict: true, exists: true });
    expect(fs.readFileSync(real, 'utf8')).toBe('changed\n');

    // Overwrite is the person's answer: same write, no version check.
    const forced = await panel().write(REF, 'link.txt', 'mine\n', { force: true });
    expect(forced.ok).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('mine\n');

    // A save over 1 MiB is refused before it reaches the machine.
    const huge = await panel().write(REF, 'link.txt', 'x'.repeat(MAX_EDIT_BYTES + 1), { force: true });
    expect(huge.ok).toBe(false);
  });

  it('creates, renames and deletes single entries, and never a tree', async () => {
    const p = panel();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.mkdirSync(path.join(dir, 'full'));
    fs.writeFileSync(path.join(dir, 'full', 'keep'), 'k');

    expect(await p.create(REF, 'fresh', true)).toMatchObject({ ok: true, dir: true });
    expect(fs.statSync(path.join(dir, 'fresh')).isDirectory()).toBe(true);
    expect(await p.create(REF, 'sub/new.txt', false)).toMatchObject({ ok: true, dir: false });
    expect(fs.readFileSync(path.join(dir, 'sub/new.txt'), 'utf8')).toBe('');
    // The same name again is a refusal, not a truncation.
    expect((await p.create(REF, 'sub/new.txt', false)).ok).toBe(false);

    expect(await p.rename(REF, 'sub/new.txt', 'sub/renamed.txt')).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(dir, 'sub', 'renamed.txt'))).toBe(true);
    expect((await p.rename(REF, 'sub/renamed.txt', 'full')).ok).toBe(false);

    expect(await p.remove(REF, 'sub/renamed.txt')).toMatchObject({ ok: true });
    expect(await p.remove(REF, 'sub')).toMatchObject({ ok: true });
    expect((await p.remove(REF, 'full')).ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'full', 'keep'))).toBe(true);
    // The root itself is never a delete.
    expect((await p.remove(REF, '')).ok).toBe(false);
    expect((await p.remove(REF, '..')).ok).toBe(false);
  });

  it('searches by file name in a directory that is not a repository, skipping dependency trees', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'wanted-file.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'wanted-file.js'), 'x');
    fs.writeFileSync(path.join(dir, 'other.ts'), 'x');

    const r = await panel().search(REF, 'WANTED');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits.map((h) => h.rel)).toEqual(['src/wanted-file.ts']);
    expect(r.truncated).toBe(false);

    expect((await panel().search(REF, '  ')).ok).toBe(false);
  });

  it('searches with git where there is a repository, and keeps only paths inside the workspace', async () => {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
    } catch {
      return; // no git on this machine: the walk above already covers the fallback
    }
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.writeFileSync(path.join(dir, 'app.ts.bak'), 'x');

    const r = await panel().search(REF, 'app');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hits.map((h) => h.rel).sort()).toEqual(['app.ts.bak', 'src/app.ts']);
      expect(r.hits.every((h) => h.dir === false)).toBe(true);
    }
  });
});

describe('buildFilesPanel against a remote host (a fake workspace)', () => {
  /** A host workspace whose every answer is scripted, so the panel's path handling is visible. */
  function fakeHost(over: Partial<Workspace> = {}): Workspace & { calls: string[][] } {
    const calls: string[][] = [];
    const base: Workspace & { calls: string[][] } = {
      calls,
      host: 'devbox',
      root: '~/work',
      async run(argv) {
        calls.push([...argv]);
        if (argv[0] === 'pwd') return { code: 0, output: Buffer.from('/home/u/work\n'), stderr: '', truncated: false, timedOut: false };
        if (argv[0] === 'printenv') return { code: 0, output: Buffer.from('/home/u\n'), stderr: '', truncated: false, timedOut: false };
        return { code: 0, output: Buffer.alloc(0), stderr: '', truncated: false, timedOut: false };
      },
      async stat(p) {
        calls.push(['stat', p]);
        return { exists: true, dir: false, size: 3, mtimeMs: 7, mode: 0o644 };
      },
      async listDir(p) {
        calls.push(['listDir', p]);
        return [{ name: 'a.txt', dir: false }];
      },
      async readFile(p) {
        calls.push(['readFile', p]);
        return Buffer.from('abc');
      },
      async writeFile(p, data, expect) {
        calls.push(['writeFile', p, JSON.stringify(expect), Buffer.from(data).toString()]);
        return { mtimeMs: 8, size: data.length };
      },
      async mkdirp(p) {
        calls.push(['mkdirp', p]);
      },
      async rename(from, to, owned) {
        calls.push(['rename', from, to, owned ?? '']);
      },
      async remove(p, owned) {
        calls.push(['remove', p, owned ?? '']);
      },
      ...over,
    };
    return base;
  }

  it('asks the host for its real working directory, then joins POSIX paths under it', async () => {
    const ws = fakeHost();
    const panel = buildFilesPanel({ instance: 'webui', roots: ['~/extra'], workspaceForRef: () => ws });
    const r = await panel.list(REF, '');
    expect(r).toMatchObject({ ok: true, path: '/home/u/work', rel: '' });
    expect(ws.calls[0]).toEqual(['pwd']);
    expect(ws.calls[1]).toEqual(['printenv', 'HOME']);
    expect(ws.calls.at(-1)).toEqual(['listDir', '/home/u/work']);

    await panel.list(REF, 'src');
    expect(ws.calls.at(-1)).toEqual(['listDir', '/home/u/work/src']);

    // An extra root written with ~ is the REMOTE home, not this one.
    const extra = await panel.list(REF, '~/extra');
    expect(extra.ok).toBe(true);
    expect(ws.calls.at(-1)).toEqual(['listDir', '/home/u/extra']);

    const escape = await panel.list(REF, '../../../etc');
    expect(escape.ok).toBe(false);
    // The daemon's own root is still reachable by absolute path.
    expect((await panel.list(REF, '/home/u/work')).ok).toBe(true);
  });

  it('writes and deletes through the host with the resolved root as the fence', async () => {
    const ws = fakeHost();
    const panel = buildFilesPanel({ instance: 'webui', roots: ['~/extra'], workspaceForRef: () => ws });
    expect(await panel.write(REF, 'a.txt', 'xyz', { size: 3, mtimeMs: 7 })).toEqual({ ok: true, mtimeMs: 8, size: 3 });
    expect(ws.calls.at(-1)).toEqual(['writeFile', '/home/u/work/a.txt', '{"size":3,"mtimeMs":7}', 'xyz']);
    await panel.remove(REF, 'a.txt');
    expect(ws.calls.at(-1)).toEqual(['remove', '/home/u/work/a.txt', '/home/u/work']);
    await panel.remove(REF, '/home/u/extra/x');
    expect(ws.calls.at(-1)).toEqual(['remove', '/home/u/extra/x', '/home/u/extra']);
    // A conflict comes back as a conflict, not as a thrown error.
    const conflict = buildFilesPanel({
      instance: 'webui',
      roots: [],
      workspaceForRef: () =>
        fakeHost({
          async writeFile() {
            throw new WorkspaceConflictError('changed', true, 9, 10);
          },
        }),
    });
    expect(await conflict.write(REF, 'a.txt', 'x', { size: 1, mtimeMs: 2 })).toMatchObject({
      ok: false,
      conflict: true,
      exists: true,
      size: 9,
      mtimeMs: 10,
    });
  });

  it('refuses when the topic has no workspace, instead of guessing one', async () => {
    const panel = buildFilesPanel({ instance: 'webui', roots: [], workspaceForRef: () => undefined });
    const r = await panel.list(REF, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no workspace/);
  });
});
