import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HackerRepository, getPool, migrateDatabase } from '../server/database';

if (process.env.RUN_PG_INTEGRATION === '1') describe('local Postgres integration', () => {
  const pool = getPool();
  const fakeEmbedding = async (text: string) => {
    const vector = Array.from({ length: 1536 }, () => 0);
    vector[Math.abs(hash(text)) % vector.length] = 1;
    return vector;
  };
  const repository = new HackerRepository(pool, fakeEmbedding);
  const userId = randomUUID();

  afterAll(async () => {
    await pool.query('DELETE FROM profiles WHERE id = $1', [userId]);
    await pool.end();
  });

  test('migrates, scopes profile and memory, and performs CRUD', async () => {
    await migrateDatabase(pool);
    expect((await repository.ensureProfile(userId)).id).toBe(userId);
    expect((await repository.updateProfile(userId, 'name', 'Ada')).name).toBe('Ada');
    expect((await repository.remember(userId, 'preferred editor', 'Neovim')).memoryType).toBe('preferred_editor');
    expect((await repository.recall(userId, 'preferred_editor'))?.content).toBe('Neovim');
    expect((await repository.searchMemories(userId, 'editor', 3))[0]?.memoryType).toBe('preferred_editor');
    expect(await repository.forget(userId, 'preferred_editor')).toBe(true);
    expect(await repository.recall(userId, 'preferred_editor')).toBeNull();
  });
});
else test.skip('local Postgres integration requires RUN_PG_INTEGRATION=1', () => {});

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = ((result << 5) - result + char.charCodeAt(0)) | 0;
  return result;
}
