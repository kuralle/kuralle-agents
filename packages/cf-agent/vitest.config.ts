import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import agents from 'agents/vite';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const packageDir = import.meta.dirname;

function ignorePublishedSourceMaps(): Plugin {
  return {
    name: 'ignore-published-source-maps',
    enforce: 'pre',
    async load(id) {
      const file = id.split('?', 1)[0]!;
      if (!file.includes('/node_modules/') || !/\.[cm]?js$/.test(file)) return null;
      const code = await readFile(file, 'utf8').catch(() => undefined);
      if (!code?.includes('sourceMappingURL=')) return null;
      return {
        code: code.replace(/(?:\/\/# sourceMappingURL=.*|\/\*# sourceMappingURL=.*?\*\/)\s*$/s, ''),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [
    ignorePublishedSourceMaps(),
    agents(),
    cloudflareTest({
      wrangler: { configPath: path.join(packageDir, 'wrangler.jsonc') },
    }),
  ],
  test: {
    include: [path.join(packageDir, 'vitest/**/*.test.ts')],
    deps: {
      optimizer: {
        ssr: {
          include: ['ajv'],
        },
      },
    },
  },
});
