import { defineWorkspace } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Files that mock module imports via `vi.mock()` need a clean module graph per file.
// Everything else runs with `isolate: false` to avoid rebuilding module graphs 240+ times.
const ISOLATED_TESTS = [
  'src/daemon/attachment-io.test.ts',
  'src/daemon/skill-library.test.ts',
  'src/remote/remote.integration.test.ts',
];

const sharedTest = baseConfig.test ?? {};

export default defineWorkspace([
  {
    test: {
      ...sharedTest,
      name: 'unit',
      isolate: false,
      poolOptions: { forks: { isolate: false } },
      exclude: ['**/node_modules/**', '**/dist/**', ...ISOLATED_TESTS],
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
