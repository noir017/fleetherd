import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run only colocated unit tests under src/.
    include: ['src/**/*.test.ts'],
    /**
     * The 5 s default is too tight on a 2-vCPU container running 158 files: a few tests walk a
     * fake clock a minute at a time (~3000 timer turns) or wait on a spawned child, and finish in
     * 3–5 s idle — under the suite's parallel load they crossed 5 s and failed for being slow, not
     * wrong (observed 2026-11-04 on schedules and the /cd→/model menu). Still bounded, so a real
     * hang fails.
     */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Exclude tests, type-only and pure-wiring entrypoints that carry no testable branches.
      exclude: ['src/**/*.test.ts', 'src/types.ts', 'src/cli.ts'],
      // Thresholds focus on the platform-agnostic core + security-critical guards. Raise over time.
      thresholds: {
        'src/core/**': { statements: 70, branches: 70, functions: 70, lines: 70 },
        // attachment-io: the IO closures (download/save) are integration-level; the threshold
        // guards the security-critical pure guards, which are branch-heavy and well covered.
        'src/daemon/attachment-io.ts': { statements: 55, branches: 85, functions: 80, lines: 55 },
        'src/ipc/protocol.ts': { statements: 80, branches: 70, functions: 80, lines: 80 },
      },
    },
  },
});
