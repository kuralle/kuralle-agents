import tseslint from 'typescript-eslint';

const strictCastPaths = [
  'packages/*/src/**/*.ts',
  'packages/*/test/**/*.ts',
  'packages/*/tests/**/*.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/routeTree.gen.ts',
      '**/*.bak',
      'apps/**',
      'playground/**',
    ],
  },
  {
    files: strictCastPaths,
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
