import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import WebSocket from 'ws';
import { createRuntime, defineAgent, MemoryStore } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '../src/index.js';

const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'runtime-text' },
        { type: 'text-delta', id: 'runtime-text', delta: 'Hello from the real runtime.' },
        { type: 'text-end', id: 'runtime-text' },
        {
          type: 'finish',
          usage: {
            inputTokens: { total: 1, noCache: 1 },
            outputTokens: { total: 5, text: 5 },
          },
          finishReason: { unified: 'stop', raw: undefined },
        },
      ],
    }),
  }) as never,
});

const agent = defineAgent({
  id: 'ws-smoke-agent',
  name: 'WebSocket smoke agent',
  instructions: 'Reply briefly.',
  model,
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore: new MemoryStore(),
  defaultModel: model,
});

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket, widgetWelcomeMode: 'off' }));

const server = serve({ fetch: app.fetch, port: 0 });
injectWebSocket(server);
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to resolve smoke port');

const frames: unknown[] = [];
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/ws-smoke-session`);
  const timeout = setTimeout(() => {
    ws.close();
    reject(new Error('Timed out waiting for runtime WebSocket turn'));
  }, 10_000);

  ws.on('open', () => ws.send(JSON.stringify({ type: 'message', message: 'Say hello.' })));
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as unknown;
    frames.push(frame);
    console.log(`[ws-frame] ${JSON.stringify(frame)}`);
    if (isDoneFrame(frame)) {
      clearTimeout(timeout);
      ws.close();
      resolve();
    }
  });
  ws.on('error', reject);
});

await new Promise<void>((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

if (!frames.some(isTextDeltaFrame) || !frames.some(isDoneFrame)) {
  throw new Error(`Expected text-delta and done frames, got ${frames.length} frames`);
}

function isDoneFrame(value: unknown): value is { type: 'done'; payload: { sessionId: string } } {
  if (!value || typeof value !== 'object') return false;
  const frame = value as { type?: unknown; payload?: { sessionId?: unknown } };
  return frame.type === 'done' && typeof frame.payload?.sessionId === 'string';
}

function isTextDeltaFrame(value: unknown): value is { type: 'text-delta'; payload: { delta: string } } {
  if (!value || typeof value !== 'object') return false;
  const frame = value as { type?: unknown; payload?: { delta?: unknown } };
  return frame.type === 'text-delta' && typeof frame.payload?.delta === 'string';
}
