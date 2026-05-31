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

    const responseStream = handle.toResponseStream('sse');
    const reader = responseStream.getReader();
    const encoder = new TextEncoder();

    const filtered = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            for (const line of chunk.split('\n\n')) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice('data: '.length);
              if (!raw.trim()) continue;
              let part: { type: string };
              try {
                part = JSON.parse(raw) as { type: string };
              } catch {
                controller.enqueue(value);
                continue;
              }
              if (!shouldEmit(part, streamFilter)) continue;
              const safe = sanitizeForClient(part);
              const payload = `data: ${JSON.stringify(safe)}\n\n`;
              controller.enqueue(encoder.encode(payload));
            }
          }
          controller.close();
        } catch (error) {
          const message =
            streamFilter === 'all'
              ? (error as Error).message
              : 'An error occurred. Please try again.';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`),
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
