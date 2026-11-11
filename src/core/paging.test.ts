import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE,
  PAGE_SIZE_MAX,
  WORKDIR_PAGE_SIZE_MAX,
  pageCount,
  pageOf,
  pageSlice,
  resolvePageSize,
  wrapPage,
} from './paging.js';

/**
 * Page arithmetic, now that the size is a parameter rather than a constant.
 *
 * The failure this guards against is specific: a menu DRAWN at one size and PAGED at another. The
 * daemon avoids it by freezing the size with the option snapshot, and these tests pin the half that
 * makes freezing meaningful — that every function here agrees about where a page starts and ends
 * for whatever size it is handed, including the defaulted one.
 */

describe('resolvePageSize', () => {
  it('falls back to the conservative default when a platform declares nothing', () => {
    expect(resolvePageSize(undefined)).toBe(PAGE_SIZE);
  });

  it('takes a declared size as given', () => {
    expect(resolvePageSize(12)).toBe(12);
  });

  // Not defensive noise: a page past the ceiling is taller than a phone screen in the web UI, and a
  // typo'd size on a chat platform is a menu the platform rejects outright.
  it('clamps a declared size to the ceiling', () => {
    expect(resolvePageSize(100)).toBe(PAGE_SIZE_MAX);
  });

  // The workdir menu declares its own ceiling (web UI): a directory list is short labels, so the
  // number that keeps /model to one screen is not its bound. Undeclared still means PAGE_SIZE —
  // the ceiling changes, the "nobody checked this platform" default does not.
  it('clamps to the ceiling the menu it belongs to carries', () => {
    expect(resolvePageSize(WORKDIR_PAGE_SIZE_MAX, WORKDIR_PAGE_SIZE_MAX)).toBe(WORKDIR_PAGE_SIZE_MAX);
    expect(resolvePageSize(100, WORKDIR_PAGE_SIZE_MAX)).toBe(WORKDIR_PAGE_SIZE_MAX);
    expect(resolvePageSize(undefined, WORKDIR_PAGE_SIZE_MAX)).toBe(PAGE_SIZE);
  });

  it('keeps the workdir ceiling above the shared one', () => {
    expect(WORKDIR_PAGE_SIZE_MAX).toBeGreaterThan(PAGE_SIZE_MAX);
    // Its exact value is the scan's cap plus the root, pinned in daemon/workdir-scan.test.ts where
    // both halves are visible — core cannot import the daemon.
  });

  it('refuses a size that would page forever', () => {
    expect(resolvePageSize(0)).toBe(1);
    expect(resolvePageSize(-5)).toBe(1);
  });

  it('ignores a non-number that slipped through (NaN, Infinity)', () => {
    expect(resolvePageSize(Number.NaN)).toBe(PAGE_SIZE);
    expect(resolvePageSize(Infinity)).toBe(PAGE_SIZE);
  });

  it('truncates a fractional size instead of slicing on one', () => {
    expect(resolvePageSize(7.9)).toBe(7);
  });
});

describe('page math at a given size', () => {
  it('counts pages, with at least one for an empty list', () => {
    expect(pageCount(0, 12)).toBe(1);
    expect(pageCount(12, 12)).toBe(1);
    expect(pageCount(13, 12)).toBe(2);
    expect(pageCount(24, 12)).toBe(2);
  });

  it('places an index on its page', () => {
    expect(pageOf(0, 12)).toBe(0);
    expect(pageOf(11, 12)).toBe(0);
    expect(pageOf(12, 12)).toBe(1);
  });

  it('slices with absolute start offsets', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(pageSlice(items, 0, 12)).toEqual({ start: 0, items: items.slice(0, 12) });
    expect(pageSlice(items, 1, 12)).toEqual({ start: 12, items: items.slice(12) });
  });

  it('defaults to PAGE_SIZE when no size is passed', () => {
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageOf(PAGE_SIZE)).toBe(1);
    expect(pageSlice([1, 2, 3, 4, 5, 6, 7], 1).start).toBe(PAGE_SIZE);
  });

  // The size flows through every function, so the three must agree about the same list: the last
  // index of page N must slice into page N, for any size.
  it('keeps pageOf and pageSlice consistent across sizes', () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    for (const size of [1, 5, 6, 12, 22]) {
      for (let index = 0; index < items.length; index++) {
        const page = pageOf(index, size);
        const { start, items: slice } = pageSlice(items, page, size);
        expect(slice).toContain(index);
        expect(index - start).toBeGreaterThanOrEqual(0);
        expect(index - start).toBeLessThan(size);
      }
      expect(pageOf(items.length - 1, size)).toBe(pageCount(items.length, size) - 1);
    }
  });
});

describe('wrapPage', () => {
  it('wraps both ways so the edge buttons are never dead', () => {
    expect(wrapPage(-1, 3)).toBe(2);
    expect(wrapPage(3, 3)).toBe(0);
    expect(wrapPage(1, 3)).toBe(1);
  });

  it('tolerates a zero page count', () => {
    expect(wrapPage(5, 0)).toBe(0);
  });
});
