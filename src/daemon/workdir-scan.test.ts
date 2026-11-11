import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKDIR_SCAN_MAX, isDirectory, scanWorkdirs } from './workdir-scan.js';
import { WORKDIR_PAGE_SIZE_MAX } from '../core/paging.js';

/**
 * The `/cd` option list, against a real filesystem.
 *
 * Real directories rather than a mocked fs on purpose: every interesting case here is one where
 * the answer depends on what the OS reports (a symlink, a broken symlink, a file that shares its
 * name with a project), and a mock would only re-state the assumption under test.
 */

const root = mkdtempSync(join(tmpdir(), 'workdir-scan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'shop-api'));
mkdirSync(join(root, 'gateway'));
mkdirSync(join(root, 'node_modules'));
mkdirSync(join(root, '.git'));
writeFileSync(join(root, 'README.md'), '#');
// A workspace laid out with symlinks into mounted volumes is normal; one of them is broken.
const external = join(root, '.external'); // dot-prefixed: the link is the offer, not this
mkdirSync(external);
symlinkSync(external, join(root, 'mounted'));
symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'));

describe('scanWorkdirs', () => {
  const scan = scanWorkdirs(root);

  it('offers the root first, so a conversation can always get back out', () => {
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.options[0]).toMatchObject({ path: root, root: true });
  });

  it('lists directories one level down, alphabetically', () => {
    if (!scan.ok) return;
    expect(scan.options.slice(1).map((o) => o.name)).toEqual([
      'gateway',
      'mounted',
      'shop-api',
    ]);
  });

  it('leaves out files, dot-directories and tooling noise', () => {
    if (!scan.ok) return;
    const names = scan.options.map((o) => o.name);
    expect(names).not.toContain('README.md');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
  });

  it('follows a symlink to a directory, and skips one that leads nowhere', () => {
    if (!scan.ok) return;
    const names = scan.options.map((o) => o.name);
    expect(names).toContain('mounted'); // a stat-following check, not dirent.isDirectory()
    expect(names).not.toContain('dangling');
  });

  it('reports an unreadable root instead of pretending it is empty', () => {
    const missing = scanWorkdirs(join(root, 'not-here'));
    expect(missing.ok).toBe(false);
    // The reason is carried through so the answer can name the config field to fix.
    expect(missing.ok === false && missing.reason.length).toBeGreaterThan(0);
  });

  it('caps the list and says how many it dropped, rather than truncating silently', () => {
    const big = mkdtempSync(join(tmpdir(), 'workdir-many-'));
    for (let i = 0; i < WORKDIR_SCAN_MAX + 3; i++) {
      mkdirSync(join(big, `p${String(i).padStart(3, '0')}`));
    }
    const many = scanWorkdirs(big);
    expect(many.ok).toBe(true);
    if (many.ok) {
      expect(many.options).toHaveLength(WORKDIR_SCAN_MAX + 1); // +1 for the root
      expect(many.truncated).toBe(3);
    }
    rmSync(big, { recursive: true, force: true });
  });

  // The web UI declares its /cd page as the workdir ceiling, whose whole point is that the menu
  // never pages there. A scan is capped at WORKDIR_SCAN_MAX sub-directories but always prepends the
  // agent's root, so the page must cover one more than the cap — if it ever stops doing so, the
  // last directories page again, and that should be a test failure rather than "the menu has a
  // Next button now".
  it('scans no more directories than a page may hold', () => {
    expect(WORKDIR_SCAN_MAX + 1).toBeLessThanOrEqual(WORKDIR_PAGE_SIZE_MAX);
  });
});

describe('isDirectory', () => {
  it('answers the click-time re-check: a directory, a file, and one that is gone', () => {
    expect(isDirectory(join(root, 'shop-api'))).toBe(true);
    expect(isDirectory(join(root, 'README.md'))).toBe(false);
    expect(isDirectory(join(root, 'not-here'))).toBe(false);
  });
});
