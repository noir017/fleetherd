import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach } from 'vitest';

/**
 * Registers an `afterEach` hook that removes every temporary directory created through the
 * returned factory. Prefer this over bare `fs.mkdtempSync(...)` in tests so `/tmp` does not
 * accumulate leaked directories across runs.
 */
export function useTempDirs(defaultPrefix = 'fleetherd-test-'): (prefix?: string) => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return (prefix = defaultPrefix): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}

/**
 * Suite-scoped variant of `useTempDirs`: cleans up in `afterAll`, for tests that create a shared
 * fixture directory once inside `describe(...)` or `beforeAll(...)`.
 */
export function useSuiteTempDirs(defaultPrefix = 'fleetherd-test-'): (prefix?: string) => string {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return (prefix = defaultPrefix): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
