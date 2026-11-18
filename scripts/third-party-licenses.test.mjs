import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectLicenses, packageDirOf, renderLicenses } from './third-party-licenses.mjs';

/**
 * The build's licence file is the only thing in the tarball that says whose code the bundle
 * carries, and nothing else in the repo can see it: the chunks are minified, and no licence text
 * survives. So the reduction from esbuild's input list to licence files is tested here, on a
 * temporary tree, rather than trusted.
 */
describe('the bundled packages’ licences', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-licenses-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A package directory with whatever files it is given. */
  function pkg(dir, files) {
    for (const [name, body] of Object.entries(files)) {
      const at = path.join(root, dir, name);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, body);
    }
  }

  it('finds the package a bundled file belongs to, scoped or nested', () => {
    expect(packageDirOf('node_modules/@codemirror/state/dist/index.js')).toBe('node_modules/@codemirror/state');
    expect(packageDirOf('node_modules/@lezer/highlight/dist/index.js')).toBe('node_modules/@lezer/highlight');
    // The innermost package is the one whose licence applies — the hoisted copy may differ.
    expect(packageDirOf('node_modules/a/node_modules/b/x.js')).toBe('node_modules/a/node_modules/b');
    expect(packageDirOf('src/platform/webui/codeview/app.ts')).toBeUndefined();
  });

  it('collects each package once, whatever how many of its modules were bundled', () => {
    pkg('node_modules/one', { 'LICENSE': 'one licence', 'index.js': '' });
    pkg('node_modules/@two/three', { 'LICENSE.md': 'three licence', 'x.js': '' });
    const { licenses, missing } = collectLicenses(
      [
        'node_modules/one/index.js',
        'node_modules/one/other.js',
        'node_modules/@two/three/x.js',
        'src/platform/webui/codeview/app.ts',
      ],
      { readdir: (d) => fs.readdirSync(path.join(root, d)), readFile: (f) => fs.readFileSync(path.join(root, f), 'utf8') }
    );
    expect(missing).toEqual([]);
    expect(licenses.map((l) => l.name)).toEqual(['@two/three', 'one']);
    expect(licenses.map((l) => l.text)).toEqual(['three licence', 'one licence']);
  });

  it('names a package that ships no licence instead of inventing one', () => {
    pkg('node_modules/bare', { 'index.js': '' });
    const { licenses, missing } = collectLicenses(['node_modules/bare/index.js'], {
      readdir: (d) => fs.readdirSync(path.join(root, d)),
      readFile: (f) => fs.readFileSync(path.join(root, f), 'utf8'),
    });
    expect(licenses).toEqual([]);
    expect(missing).toEqual(['bare']);
  });

  it('writes every licence verbatim under its package name and file', () => {
    pkg('node_modules/one', { 'COPYING': 'Copyright (c) One\n\nMIT\n' });
    const { licenses } = collectLicenses(['node_modules/one/index.js'], {
      readdir: (d) => fs.readdirSync(path.join(root, d)),
      readFile: (f) => fs.readFileSync(path.join(root, f), 'utf8'),
    });
    const text = renderLicenses(licenses);
    expect(text).toContain('one (COPYING)');
    expect(text).toContain('Copyright (c) One');
    expect(text).toContain('MIT');
    // A nested copy says where it was, since `one` alone would not identify it.
    const nested = renderLicenses([{ name: 'b', dir: 'node_modules/a/node_modules/b', file: 'LICENSE', text: 'B' }]);
    expect(nested).toContain('b — node_modules/a/node_modules/b (LICENSE)');
  });
});
