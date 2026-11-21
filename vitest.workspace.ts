import { defineWorkspace } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Files that mock module imports via `vi.mock()` need a clean module graph per file.
// Everything else runs with `isolate: false` to avoid rebuilding module graphs 240+ times —
// except under `--coverage`, where Vitest 2.1.9 calls `Profiler.stopPreciseCoverage()` between
// files on a reused worker, stripping V8 block coverage for cached modules (repro:
// `npx vitest run --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1 --coverage --coverage.include=src/ipc/protocol.ts src/ipc/protocol.test.ts src/daemon/schedule-ipc.test.ts`).
const ISOLATED_TESTS = [
  'src/daemon/attachment-io.test.ts',
  'src/daemon/skill-library.test.ts',
  'src/remote/remote.integration.test.ts',
];

const withCoverage = process.argv.some(
  (arg) =>
    arg === '--coverage' ||
    arg === '--coverage.enabled' ||
    /^--coverage(?:\.enabled)?=(?:true|1)$/i.test(arg)
);

// Workspace project `exclude` overrides CLI `--exclude` in Vitest 2.1.9; forward it explicitly
// so `npm run test:coverage` does not run `page.dom.*.test.ts` twice.
const extraExcludes: string[] = [];
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg === '--exclude' && process.argv[i + 1]) extraExcludes.push(process.argv[++i]!);
  else if (arg.startsWith('--exclude=')) extraExcludes.push(arg.slice('--exclude='.length));
}

const sharedTest = baseConfig.test ?? {};

export default defineWorkspace([
  {
    test: {
      ...sharedTest,
      name: 'unit',
      isolate: withCoverage,
      poolOptions: { forks: { isolate: withCoverage } },
      exclude: ['**/node_modules/**', '**/dist/**', ...ISOLATED_TESTS, ...extraExcludes],
    },
  },
  {
    test: {
      ...sharedTest,
      name: 'isolated',
      isolate: true,
      poolOptions: { forks: { isolate: true } },
      include: ISOLATED_TESTS,
    },
  },
]);
