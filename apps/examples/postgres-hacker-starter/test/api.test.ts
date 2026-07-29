import { describe, expect, test } from 'bun:test';
import type { HackerRepository } from '../server/database';
import { createApi } from '../server/api';

describe('Hono identity boundary', () => {
  test('issues a signed cookie and reuses the same server-owned user id', async () => {
    const seen: string[] = [];
    const repository = {
      ensureProfile: async (userId: string) => {
        seen.push(userId);
        return { id: userId, name: null, email: null, preferences: {}, lastSeenAt: new Date(0).toISOString() };
      },
      listMemories: async () => [],
    } as unknown as HackerRepository;
    const app = createApi({
      repository: () => repository,
      cookieSecret: () => 'test-secret-that-is-longer-than-thirty-two-characters',
    });

    const first = await app.request('/api/bootstrap');
    expect(first.status).toBe(200);
    const cookie = first.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const second = await app.request('/api/bootstrap', { headers: { cookie: cookie!.split(';')[0]! } });
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });
});
