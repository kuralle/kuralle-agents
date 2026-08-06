import { afterAll, describe, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { extractedValueStoreConformanceCases } from '../../src/memory/extract/testing.js';
import type { ExtractedValueStore } from '../../src/memory/extract/store.js';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.js';
import { FileExtractedValueStore } from '../../src/memory/extract/FileExtractedValueStore.js';

/**
 * The cases are framework-neutral so `postgres-store`, `redis-store` and
 * `cf-agent` can run the identical list under `node:test`. This is the bun
 * wrapper; theirs is the same three lines with a different `it`.
 */
function conform(name: string, makeStore: () => ExtractedValueStore): void {
  describe(`ExtractedValueStore conformance: ${name}`, () => {
    for (const testCase of extractedValueStoreConformanceCases) {
      it(testCase.name, async () => {
        await testCase.run(makeStore());
      });
    }
  });
}

conform('InMemory', () => new InMemoryExtractedValueStore());

const roots: string[] = [];
conform('File', () => {
  const rootDir = path.join(
    os.tmpdir(),
    `kuralle-ev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.push(rootDir);
  return new FileExtractedValueStore({ rootDir });
});

afterAll(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
