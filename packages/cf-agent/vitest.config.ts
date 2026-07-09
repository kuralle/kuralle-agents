import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['vitest/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        // The agents SDK keeps SQLite WAL handles open across requests, which
        // isolated-storage snapshotting cannot pop. Tests use distinct DO
        // names instead of per-test storage isolation.
        isolatedStorage: false,
      },
    },
  },
});
