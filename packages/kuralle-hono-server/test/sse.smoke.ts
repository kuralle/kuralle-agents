/**
 * Live SSE smoke — createKuralleChatRouter + createRuntime against a real provider.
 * Run: bun test ./test/v2-sse.smoke.ts (from packages/kuralle-hono-server after build)
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineAgent } from '@kuralle-agents/core';
import { createRuntime } from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core';
import { createKuralleSseChatRouter } from '../src/chatRouter.js';

config({ path: resolve(import.meta.dir, '../../../.env') });

import { liveModel } from '../../kuralle-core/test/helpers/liveModel.js';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

async function parseSseBody(body: string): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const parts: Array<{ type: string; [key: string]: unknown }> = [];
  for (const block of body.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) continue;
    parts.push(JSON.parse(line.slice('data: '.length)) as { type: string });
  }
  return parts;
}

describeLive(`v2 hono SSE live smoke (${lm?.label ?? 'no live key'})`, () => {
  it('streams text-delta + done and preserves session across two POSTs', async () => {
    const model = lm!.model;
    const agent = defineAgent({
      id: 'support',
      name: 'Support',
      instructions: 'You are a helpful assistant. Reply in one short sentence.',
      model,
    });

    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: model,
    });

    const app = createKuralleSseChatRouter({ runtime, streamFilter: 'all' });

    const first = await app.request('http://localhost/api/chat/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Say hello in exactly three words.' }),
    });

    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const firstParts = await parseSseBody(firstBody);
    const deltas = firstParts.filter((p) => p.type === 'text-delta');
    const done = firstParts.find((p) => p.type === 'done') as { sessionId?: string } | undefined;

    expect(deltas.length).toBeGreaterThan(0);
    expect((deltas[0] as { text?: string }).text?.length).toBeGreaterThan(0);
    expect(done?.sessionId).toBeTruthy();

    const sessionId = done!.sessionId as string;

    const second = await app.request('http://localhost/api/chat/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What was my first message about? Answer in one short sentence.',
        sessionId,
      }),
    });

    expect(second.status).toBe(200);
    const secondParts = await parseSseBody(await second.text());
    const secondDone = secondParts.find((p) => p.type === 'done') as { sessionId?: string } | undefined;
    expect(secondDone?.sessionId).toBe(sessionId);

    console.log('[smoke:sse] provider:', lm!.label);
    console.log('[smoke:sse] first deltas:', deltas.length, 'sessionId:', sessionId);
  }, 120_000);
});
