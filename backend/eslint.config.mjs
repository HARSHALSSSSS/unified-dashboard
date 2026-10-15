import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'packages/database/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Test code asserts on untyped JSON response bodies.
  { files: ['tests/**/*.ts', 'packages/testing/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Module boundary: cross-module imports must go through the package entry point.
      'no-restricted-imports': ['error', { patterns: [{ group: ['@oms/mod-*/src/*', '@oms/mod-*/*'], message: 'Import other modules only through their public entry point.' }] }],
    },
  },
);
