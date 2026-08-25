import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSqlFileSystem } from '../src/node/node-sql-fs.js';

describe('nodeSqlFileSystem', () => {
  it('round-trips read/write through the built-in sync SQLite driver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kuralle-node-sql-fs-'));
    try {
      const fs = nodeSqlFileSystem(join(dir, 'agent.db'));
      await fs.writeFile('/hello.txt', 'hello from nodeSqlFileSystem');
      expect(await fs.readFile('/hello.txt')).toBe('hello from nodeSqlFileSystem');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
