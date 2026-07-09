import { describe, it, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryWindowStore } from '@kuralle-agents/messaging';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { createWhatsAppServerApp } from './app.js';

const VERIFY_TOKEN = 'test-verify-token';
const APP_SECRET = 'test-app-secret';

describe('whatsapp-server smoke', () => {
  it('mounts the messaging router and passes Meta webhook verification', async () => {
    const whatsapp = createWhatsAppClient({
      accessToken: 'test-access-token',
      appSecret: APP_SECRET,
      phoneNumberId: '123456789',
      verifyToken: VERIFY_TOKEN,
    });

    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        ({
          content: [{ type: 'text', text: 'Hello' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }) as never,
    });

    const app = createWhatsAppServerApp({
      whatsapp,
      model,
      wabaId: 'waba-test',
      windowStore: new InMemoryWindowStore(),
      selector: { select: async () => null },
    });

    const challenge = 'challenge-abc-123';
    const verifyUrl =
      `http://localhost/messaging/whatsapp/webhook` +
      `?hub.mode=subscribe` +
      `&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}` +
      `&hub.challenge=${encodeURIComponent(challenge)}`;

    const verifyRes = await app.fetch(new Request(verifyUrl, { method: 'GET' }));
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.text()).toBe(challenge);

    const healthRes = await app.fetch(new Request('http://localhost/health'));
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { status: string; platforms: string[] };
    expect(health.status).toBe('ok');
    expect(health.platforms).toEqual(['whatsapp']);
  });
});
