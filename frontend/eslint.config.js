// ESLint 9 flat config — React 19 + TypeScript.
//
// Requires these devDependencies (owned by the lead, see README / handoff):
//   eslint, @eslint/js, typescript-eslint,
//   eslint-plugin-react-hooks, eslint-plugin-react-refresh
//
// Run with: npm run lint
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    // Never lint build output, dependencies or generated Tauri schemas.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        URL: 'readonly',
        DragEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLDivElement: 'readonly',
        ResizeObserver: 'readonly',
        AbortController: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // --- React hooks correctness: these are the ones that catch real bugs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Vite HMR needs component modules to export components only.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // --- TypeScript
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // --- General hygiene
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
);
