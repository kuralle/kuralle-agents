import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import agents from 'agents/vite';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const appDirectory = import.meta.dirname;

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({ wrangler: { configPath: path.join(appDirectory, 'wrangler.jsonc') } }),
  ],
  test: {
    include: [path.join(appDirectory, 'cloudflare/**/*.test.ts')],
  },
});
