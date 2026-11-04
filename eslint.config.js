// Flat ESLint config. Keeps the codebase's existing discipline machine-enforced: zero `any`,
// no unused vars (except _-prefixed), bounded complexity/function length. Stylistic rules are
// `warn` so they surface in review without blocking CI; correctness rules stay `error`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Worktrees other sessions park inside the repo, kept out of git by `.git/info/exclude`: they
    // are whole checkouts of this tree, often mid-edit, and linting them is never meant — `eslint .`
    // walking into one turns another session's work in progress into this one's errors.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.ts', '.claude/worktrees/**', '.codebuddy/worktrees/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
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
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'max-lines-per-function': 'off',
    },
  }
);
