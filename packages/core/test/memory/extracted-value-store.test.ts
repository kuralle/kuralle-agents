import { afterAll } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runExtractedValueStoreConformance } from '../../src/memory/extract/testing.js';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.js';
import { FileExtractedValueStore } from '../../src/memory/extract/FileExtractedValueStore.js';

runExtractedValueStoreConformance('InMemory', () => new InMemoryExtractedValueStore());

const roots: string[] = [];
runExtractedValueStoreConformance('File', () => {
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
