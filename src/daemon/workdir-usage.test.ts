import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkdirUsageStore } from './workdir-usage.js';

/**
 * The `/cd` usage file.
 *
 * What matters here is not the arithmetic (core/frecency.test.ts pins that) but that this thing can
 * never break a directory change: every failure mode — no file, a corrupt file, a half-valid entry,
 * an unwritable directory — has to degrade to "no ranking", which is the alphabetical order the
 * menu had before any of this existed.
 */

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'workdir-usage-')), 'workdir-usage.json');
}

describe('WorkdirUsageStore', () => {
  it('starts empty when the file does not exist', () => {
    const store = new WorkdirUsageStore(tempFile());
    expect(store.stat('/w/shop-api')).toBeUndefined();
  });

  it('records a use and reads it back through a fresh instance', () => {
    const file = tempFile();
    new WorkdirUsageStore(file).record('/w/shop-api', 1000);
    expect(new WorkdirUsageStore(file).stat('/w/shop-api')).toEqual({ score: 1, last: 1000 });
  });

  it('accumulates repeat uses of the same directory', () => {
    const file = tempFile();
    const store = new WorkdirUsageStore(file);
    store.record('/w/shop-api', 1000);
    store.record('/w/shop-api', 2000);
    const stat = store.stat('/w/shop-api')!;
    // Two visits a second apart: the first has decayed, but only by ~6e-7 of itself, so ~2.
    expect(stat.score).toBeCloseTo(2, 5);
    expect(stat.score).toBeLessThan(2); // it IS decayed, not merely counted
    expect(stat.last).toBe(2000);
  });

  it('keeps directories apart', () => {
    const store = new WorkdirUsageStore(tempFile());
    store.record('/w/a', 1000);
    expect(store.stat('/w/b')).toBeUndefined();
  });

  it('degrades to empty on a corrupt file rather than throwing', () => {
    const file = tempFile();
    writeFileSync(file, 'not json at all');
    const store = new WorkdirUsageStore(file);
    expect(store.stat('/w/a')).toBeUndefined();
    // And it is still usable: a corrupt file must not disable ranking forever.
    store.record('/w/a', 5);
    expect(store.stat('/w/a')).toEqual({ score: 1, last: 5 });
  });

  it('drops malformed entries and keeps the good ones', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        '/w/good': { score: 3, last: 10 },
        '/w/string-score': { score: '3', last: 10 },
        '/w/negative': { score: -1, last: 10 },
        '/w/nan': { score: Number.NaN, last: 10 },
        '/w/no-last': { score: 3 },
        '/w/not-an-object': 7,
      })
    );
    const store = new WorkdirUsageStore(file);
    expect(store.stat('/w/good')).toEqual({ score: 3, last: 10 });
    for (const bad of ['/w/string-score', '/w/negative', '/w/nan', '/w/no-last', '/w/not-an-object']) {
      expect(store.stat(bad)).toBeUndefined();
    }
  });

  it('survives an unwritable path without throwing (a ranking hint is never worth a failure)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workdir-usage-ro-'));
    // A file path whose PARENT is a file: mkdir/write both fail, which is the shape of a read-only
    // or vanished config dir.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const store = new WorkdirUsageStore(join(blocker, 'nested', 'workdir-usage.json'));
    expect(() => store.record('/w/a', 1)).not.toThrow();
    // In memory it still ranks for the life of this process; only persistence was lost.
    expect(store.stat('/w/a')).toEqual({ score: 1, last: 1 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes only the two numbers, keyed by absolute path', () => {
    const file = tempFile();
    new WorkdirUsageStore(file).record('/w/shop-api', 42);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      '/w/shop-api': { score: 1, last: 42 },
    });
  });
});
