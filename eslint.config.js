import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `web/` is a separate Vite + React workspace with its own toolchain; the root
  // lint (no React plugin, no JSX-aware config) doesn't apply to it.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'web/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
