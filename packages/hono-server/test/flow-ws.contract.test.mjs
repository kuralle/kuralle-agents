import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createKuralleRouter } from '../dist/index.js';

function startServer() {
  const flowManager = {
    currentNodeName: 'start',
    nodeHistory: ['start'],
    hasEnded: false,
    collectedData: {},
    async *process() {
      yield {
        channel: 'internal',
        type: 'tool-call',
        payload: { toolName: 'secret_tool', args: { token: 'hidden' } },
      };
      yield {
        channel: 'client',
        type: 'text-start',
        payload: { id: 'flow-text' },
      };
      yield {
        channel: 'client',
        type: 'text-delta',
        payload: { id: 'flow-text', delta: 'Hello from flow' },
      };
      yield {
        channel: 'client',
        type: 'error',
        payload: { error: 'database password should not cross the wire' },
      };
      yield {
        channel: 'client',
        type: 'done',
        payload: { sessionId: 'flow-session' },
      };
    },
  };

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.route(
    '/',
    createKuralleRouter({
      flowManager,
      sessionId: 'flow-session',
      upgradeWebSocket,
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to resolve test port');

  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function collectFrames(port) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for flow WebSocket frames'));
    }, 2000);

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Flow WebSocket error'));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data.toString());
      frames.push(frame);
      if (frame.type === 'connected') {
        ws.send(JSON.stringify({ type: 'message', message: 'hello' }));
      }
      if (frame.type === 'done') {
        clearTimeout(timeout);
        ws.close();
        resolve(frames);
      }
    };
  });
}

test('flow WebSocket emits safe StreamPart envelopes and sanitizes errors', async () => {
  const server = startServer();
  try {
    const frames = await collectFrames(server.port);
    assert.deepEqual(frames.map((frame) => frame.type), [
      'connected',
      'text-start',
      'text-delta',
      'error',
      'done',
    ]);
    assert.ok(frames.slice(1).every((frame) => frame.channel === 'client' && frame.payload));
    assert.equal(frames[3].payload.error, 'An error occurred. Please try again.');
    assert.equal(frames.some((frame) => frame.type === 'tool-call'), false);
  } finally {
    await server.close();
  }
});
