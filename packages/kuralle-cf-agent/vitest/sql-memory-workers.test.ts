import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestMemoryEnv {
  TEST_MEMORY_DO: DurableObjectNamespace;
}

describe('test:sql-memory-workers', () => {
  it('SqlPersistentMemoryStore round-trips in workerd DO sqlite', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const id = bindings.TEST_MEMORY_DO.idFromName('memory-durability');
    const stub = bindings.TEST_MEMORY_DO.get(id);
    const response = await stub.fetch('http://do/roundtrip');
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { content: string | null };
    expect(body.content).toBe('workerd-durable');
  });
});
