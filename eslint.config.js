// Flat ESLint config. Keeps the codebase's existing discipline machine-enforced: zero `any`,
// no unused vars (except _-prefixed), bounded complexity/function length. Stylistic rules are
// `warn` so they surface in review without blocking CI; correctness rules stay `error`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Worktrees other sessions park inside the repo, kept out of git by `.git/info/exclude`: they
    // are whole checkouts of this tree, often mid-edit, and linting them is never meant — `eslint .`
    // walking into one turns another session's work in progress into this one's errors.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'blob-report/**', '*.config.js', '*.config.ts', '.claude/worktrees/**', '.codebuddy/worktrees/**', '.worktrees/**'],
  },
  {
    // The web UI's client script as it was moved out of page.ts (refactor Phase 1 Step 1A):
    // twelve thousand lines of ES5-style browser code that no lint ever saw while it was a string.
    // Its later steps split it into typed modules and lint those; until then it is out, by name,
    // so a new file beside it is linted from the start. tsconfig.json leaves client/ out too.
    ignores: ['src/platform/webui/client/legacy-app.ts'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      complexity: ['warn', 18],
      'max-lines-per-function': ['warn', { max: 140, skipBlankLines: true, skipComments: true }],
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.test-helpers.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines-per-function': 'off',
    },
  }
);
