import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sqlFileSystem } from '@kuralle-agents/fs';
import type { PharmacyAgent } from './agent.js';

describe('pharmacy example in the Cloudflare runtime', () => {
  it('serves substrate health and validates hosted chat before touching the model', async () => {
    const health = await SELF.fetch('https://example.test/health');
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      runtime: 'cloudflare-durable-object',
      driver: 'pi',
      workspace: 'durable-sqlite',
    });

    const invalid = await SELF.fetch('https://example.test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '../escape', message: 'hello' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('persists notes in one DO workspace and isolates another session', async () => {
    const first = env.PharmacyAgent.getByName('workspace-a');
    const second = env.PharmacyAgent.getByName('workspace-b');

    await runInDurableObject(first, async (_instance: PharmacyAgent, state) => {
      const fs = sqlFileSystem(state.storage.sql, { namespace: 'pharmacy_notes' });
      await fs.mkdir('/cases', { recursive: true });
      await fs.writeFile('/cases/follow-up.md', 'durable on workerd');
    });

    const reread = await runInDurableObject(first, async (_instance: PharmacyAgent, state) => {
      const fs = sqlFileSystem(state.storage.sql, { namespace: 'pharmacy_notes' });
      return fs.readFile('/cases/follow-up.md');
    });
    const isolated = await runInDurableObject(second, async (_instance: PharmacyAgent, state) => {
      const fs = sqlFileSystem(state.storage.sql, { namespace: 'pharmacy_notes' });
      return fs.exists('/cases/follow-up.md');
    });

    expect(reread).toBe('durable on workerd');
    expect(isolated).toBe(false);
  });
});
