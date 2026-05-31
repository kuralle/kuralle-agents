#!/usr/bin/env npx tsx
/**
 * Compatibility entry point for the Gemini sandbox POC.
 *
 * Prefer:
 *   npx tsx src/deploy.ts
 */

import { main } from './deploy.js';

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
