import { describe, it, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));

describe('@kuralle-agents/ws-bench smoke', () => {
  it('ships bench orchestrator and echo server entrypoints', () => {
    expect(existsSync(join(packageRoot, '../bench.mjs'))).toBe(true);
    expect(existsSync(join(packageRoot, '../servers/ws-server.mjs'))).toBe(true);
    expect(existsSync(join(packageRoot, '../servers/sockudo-server.mjs'))).toBe(true);
  });
});
