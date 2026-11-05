import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'python'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // Core must stay pure: no DOM, no three.js, no editor imports, no ambient randomness.
      'no-restricted-imports': ['error', { patterns: ['three', 'three/*', '**/editor/**', '@editor/*', 'preact', 'preact/*'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'navigator'],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'Use the seeded Rng from core/math/rng.ts' }],
    },
  },
);
