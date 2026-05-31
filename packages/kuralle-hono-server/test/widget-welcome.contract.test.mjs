import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createKuralleChatRouter } from '../dist/index.js';

function createFakeRuntime() {
  const calls = [];
  const makeHandle = ({ input, sessionId, userId }) => {
    calls.push({ input, sessionId, userId });
    const events = (async function* () {
      yield { type: 'text-delta', text: 'Model welcome' };
      yield { type: 'done', sessionId: sessionId ?? 'generated-session', timestamp: new Date().toISOString() };
    })();
    const handle = Promise.resolve({ text: 'Model welcome', toolResults: [] });
    handle.events = events;
    return handle;
  };
  const runtime = {
    run(opts) {
      return makeHandle(opts);
    },
    stream(opts) {
      return makeHandle(opts);
    },
    async getSession() {
      return null;
    },
    async deleteSession() {
      return undefined;
    },
    abortSession() {
      return undefined;
    },
  };

  return { runtime, calls };
}

function startServer(options) {
  const { runtime, calls } = createFakeRuntime();
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.route(
    '/',
    createKuralleChatRouter({
      runtime,
      upgradeWebSocket,
      ...options,
    }),
  );

  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server port');
  }

  return {
    calls,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)));
      }),
  };
}

function connectAndCollect(port, { waitMs = 300 } = {}) {
  const events = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/chat/test-session`);
    let finished = false;
    let timeoutId;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      ws.close();
      resolve(events);
    };

    ws.onerror = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      reject(new Error('WebSocket client error during contract test'));
    };

    ws.onopen = () => {
      timeoutId = setTimeout(finish, waitMs);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data.toString());
        events.push(payload);
        if (payload.type === 'done') {
          finish();
        }
      } catch (error) {
        reject(error);
      }
    };
  });
}

test('widgetWelcomeMode=static sends deterministic welcome and optional chips', async () => {
  const server = startServer({
    widgetWelcomeMode: 'static',
    widgetWelcomeMessage: "I'm the Ninewells Hospital virtual assistant. How can I assist you today?",
    widgetWelcomeSuggestions: ['Check Availability', 'Book an Appointment', 'Inquiries', 'Extra Chip'],
  });

  try {
    const events = await connectAndCollect(server.port);
    assert.deepEqual(
      events.map((event) => event.type),
      ['connected', 'text-delta', 'suggested-questions', 'done'],
    );
    assert.equal(events[1].text, "I'm the Ninewells Hospital virtual assistant. How can I assist you today?");
    assert.deepEqual(events[2].suggestions, ['Check Availability', 'Book an Appointment', 'Inquiries']);
    assert.equal(server.calls.length, 0, 'static mode should not invoke runtime.stream for welcome');
  } finally {
    await server.close();
  }
});

test('widgetWelcomeMode=model uses runtime streaming for welcome', async () => {
  const server = startServer({
    widgetWelcomeMode: 'model',
  });

  try {
    const events = await connectAndCollect(server.port);
    assert.deepEqual(events.map((event) => event.type), ['connected', 'text-delta', 'done']);
    assert.equal(events[1].text, 'Model welcome');
    assert.equal(server.calls.length, 1);
    assert.match(server.calls[0].input, /new user has connected/i);
  } finally {
    await server.close();
  }
});

test('widgetWelcomeMode=off does not send welcome content', async () => {
  const server = startServer({
    widgetWelcomeMode: 'off',
  });

  try {
    const events = await connectAndCollect(server.port, { waitMs: 200 });
    assert.deepEqual(events.map((event) => event.type), ['connected']);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('legacy sendWidgetWelcomeMessage=false maps to off mode', async () => {
  const server = startServer({
    sendWidgetWelcomeMessage: false,
  });

  try {
    const events = await connectAndCollect(server.port, { waitMs: 200 });
    assert.deepEqual(events.map((event) => event.type), ['connected']);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});
