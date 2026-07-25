import { Hono } from 'hono';
import type { Context } from 'hono';
import type { TurnHandle, Runtime } from '@kuralle-agents/core';
import {
  shouldEmit,
  sanitizeForClient,
  type StreamEventFilter,
} from './streamFilter.js';

export type ChatRequest = {
  sessionId?: string;
  message: string;
  userId?: string;
};

export type KuralleSseChatRouterOptions = {
  runtime: Runtime;
  streamFilter?: StreamEventFilter;
};

const parseJsonBody = async <T>(c: Context): Promise<T | null> => {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
};

export function createKuralleSseChatRouter({
  runtime,
  streamFilter: streamFilterOption,
}: KuralleSseChatRouterOptions): Hono {
  const streamFilter: StreamEventFilter = streamFilterOption ?? 'safe';
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/api/chat/sse', async (c) => {
    const body = await parseJsonBody<ChatRequest>(c);
    if (!body?.message) {
      return c.json({ error: 'message required' }, 400);
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const handle: TurnHandle = runtime.run({
      sessionId,
      input: body.message,
      userId: body.userId,
    });

    const encoder = new TextEncoder();

    const filtered = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of handle.events) {
            if (!shouldEmit(part, streamFilter)) continue;
            const safe = sanitizeForClient(part);
            const payload = `data: ${JSON.stringify(safe)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          }
          await handle;
          controller.close();
        } catch (error) {
          const message =
            streamFilter === 'all'
              ? (error as Error).message
              : 'An error occurred. Please try again.';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              channel: 'client',
              type: 'error',
              payload: { error: message },
            })}\n\n`),
          );
          controller.close();
        } finally {
          void handle.catch(() => {});
        }
      },
    });

    return new Response(filtered, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}
