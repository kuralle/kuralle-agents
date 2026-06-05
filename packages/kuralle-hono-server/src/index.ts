import { createUIMessageStreamResponse } from 'ai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context, Handler } from 'hono';
import { harnessToUIMessageStream } from '@kuralle-agents/core';
import type {
  ConversationOutcome,
  CsatRecord,
  HarnessStreamPart,
  RunOptions,
  RuntimeLike,
  Session,
} from '@kuralle-agents/core';

// PR-20 — re-export the OpenAI-compatible router. Lets consumers do:
//   import { createOpenAICompatRouter } from '@kuralle-agents/hono-server';
export {
  createOpenAICompatRouter,
  type OpenAICompatRuntime,
  type CreateOpenAICompatRouterOptions,
  type ChatCompletionsRequest,
} from './openaiCompat.js';

export {
  shouldEmit,
  sanitizeForClient,
  type StreamEventFilter,
} from './streamFilter.js';

export { createKuralleSseChatRouter, type KuralleSseChatRouterOptions } from './chatRouter.js';

import {
  shouldEmit,
  sanitizeForClient,
  type StreamEventFilter,
} from './streamFilter.js';
import { debug } from './debug.js';

type FlowStreamPart = {
  type: string;
  id?: string;
  delta?: string;
  error?: string;
};

type FlowRouterManager = {
  process: (input: string) => AsyncGenerator<FlowStreamPart>;
  currentNodeName: string;
  nodeHistory: string[];
  hasEnded: boolean;
  collectedData: unknown;
};

type WidgetWelcomeMode = 'off' | 'model' | 'static';

export type ChatRequest = {
  sessionId?: string;
  message: string;
  userId?: string;
};

export type ChatResponse = {
  sessionId: string;
  response: string;
  timestamp: string;
};

/**
 * Body for `POST /api/chat/resume` — delivers a signal (e.g. a human approval)
 * to a paused durable run and streams the resumed turn as SSE.
 */
export type ResumeRequest = {
  sessionId: string;
  signal: { signalId: string; name: string; payload?: unknown };
};

export type FlowRequest = {
  message: string;
  sessionId?: string;
  userId?: string;
};

export type FlowResponse = {
  sessionId: string;
  currentNode: string;
  nodeHistory: string[];
  hasEnded: boolean;
  response: string;
  timestamp: string;
};

type OutcomeRequest = {
  outcome?: unknown;
  reason?: unknown;
};

type CsatRequest = {
  score?: unknown;
  comment?: unknown;
};

type AuditQuery =
  | { ok: true; value: { from?: Date; to?: Date; types?: string[] } }
  | { ok: false; error: string };

export type KuralleWebSocket = {
  send: (data: string) => void;
};

export type WebSocketEvent = {
  data?: unknown;
};

export type WebSocketHandler = {
  onOpen?: (event: unknown, ws: KuralleWebSocket) => void;
  onMessage?: (event: WebSocketEvent, ws: KuralleWebSocket) => void | Promise<void>;
  onClose?: (event: unknown, ws: KuralleWebSocket) => void;
  onError?: (event: unknown, ws: KuralleWebSocket) => void;
};

export type UpgradeWebSocket = (
  handler: (c: Context) => WebSocketHandler
) => Handler;

export type KuralleChatRouterOptions = {
  runtime: RuntimeLike;
  upgradeWebSocket?: UpgradeWebSocket;
  /**
   * Controls widget welcome behavior for `/agents/chat/:sessionId`.
   * - `off`: do not send a welcome turn on connect.
   * - `model`: generate welcome by calling `runtime.stream(...)`.
   * - `static`: send `widgetWelcomeMessage` directly without model inference.
   */
  widgetWelcomeMode?: WidgetWelcomeMode;
  /**
   * Whether `/agents/chat/:sessionId` should auto-greet on socket open.
   * Deprecated. Use `widgetWelcomeMode` instead.
   * Backward compatibility mapping:
   * - `false` => `off`
   * - `true` + `widgetWelcomeMessage` => `static`
   * - `true` + no message => `model`
   */
  sendWidgetWelcomeMessage?: boolean;
  /**
   * Optional static welcome text to send immediately on socket open.
   * If provided, this is sent directly instead of running a runtime turn.
   */
  widgetWelcomeMessage?: string;
  /**
   * Optional static quick-reply suggestions for the initial widget state.
   */
  widgetWelcomeSuggestions?: string[];
  /**
   * Controls which HarnessStreamPart events are sent to external clients (SSE + widget/flow WebSockets).
   * - `'safe'`: only user-facing events (text-delta, done, sanitized error, suggested-questions, input).
   * - `'all'`: full stream (Studio / dev tooling).
   * - function: custom predicate; return true to emit.
   * @default 'safe'
   */
  streamFilter?: StreamEventFilter;
};

export type KuralleRouterOptions = {
  flowManager: FlowRouterManager;
  sessionId: string;
  upgradeWebSocket?: UpgradeWebSocket;
};

const parseJsonBody = async <T>(c: Context): Promise<T | null> => {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
};

const wantsRawStreamFormat = (c: Context): boolean => c.req.query('format') === 'raw';

const extractInputFromBody = (body: Record<string, unknown>): { input: string; sessionId?: string } => {
  if (typeof body.message === 'string') {
    return { input: body.message, sessionId: body.sessionId as string | undefined };
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const messages = body.messages as Array<{ parts?: Array<{ type: string; text?: string }> }>;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.parts && Array.isArray(lastMessage.parts)) {
      const textPart = lastMessage.parts.find((p) => p.type === 'text');
      const input = textPart?.text || '';
      const sessionId = typeof body.id === 'string' ? body.id : undefined;
      return { input, sessionId };
    }
  }

  return { input: '', sessionId: undefined };
};

const coerceToString = (data: unknown): string => {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer as ArrayBuffer);
  }

  return String(data ?? '');
};

async function* iterateRuntimeParts(
  runtime: RuntimeLike,
  opts: RunOptions,
): AsyncGenerator<HarnessStreamPart> {
  const handle = runtime.run({
    ...opts,
    sessionId: opts.sessionId ?? crypto.randomUUID(),
  });
  yield* handle.events;
  await handle;
}

const collectResponse = async (
  runtime: RuntimeLike,
  message: string,
  sessionId?: string,
  userId?: string
): Promise<{ sessionId: string; response: string }> => {
  let response = '';
  let resolvedSessionId = sessionId ?? '';

  for await (const part of iterateRuntimeParts(runtime, { input: message, sessionId, userId })) {
    if (part.type === 'text-delta') {
      response += part.delta;
    }

    if (part.type === 'error') {
      throw new Error(part.error);
    }

    if (part.type === 'done') {
      resolvedSessionId = part.sessionId;
    }
  }

  return {
    response,
    sessionId: resolvedSessionId,
  };
};

const sendSSEPart = async (
  stream: { writeSSE: (data: { event: string; data: string }) => Promise<void> },
  part: HarnessStreamPart,
  filter: StreamEventFilter,
) => {
  if (!shouldEmit(part, filter)) return;
  const safe = sanitizeForClient(part);
  await stream.writeSSE({ event: safe.type, data: JSON.stringify(safe) });
};

const formatSessionResponse = (session: Session) => ({
  sessionId: session.id,
  currentAgent: session.currentAgent ?? session.activeAgentId,
  messageCount: session.messages.length,
  messages: session.messages,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const isConversationOutcome = (value: unknown): value is ConversationOutcome =>
  value === 'resolved' ||
  value === 'unresolved' ||
  value === 'escalated' ||
  value === 'abandoned';

const ensureMetadata = (session: Session): NonNullable<Session['metadata']> => {
  if (!session.metadata) {
    const now = new Date();
    session.metadata = {
      createdAt: session.createdAt,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    };
  }
  return session.metadata;
};

const parseAuditQuery = (c: Context): AuditQuery => {
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const typesRaw = c.req.query('types');
  const value: { from?: Date; to?: Date; types?: string[] } = {};

  if (fromRaw) {
    const from = new Date(fromRaw);
    if (Number.isNaN(from.getTime())) return { ok: false, error: 'from must be a valid date' };
    value.from = from;
  }
  if (toRaw) {
    const to = new Date(toRaw);
    if (Number.isNaN(to.getTime())) return { ok: false, error: 'to must be a valid date' };
    value.to = to;
  }
  if (typesRaw) {
    const types = typesRaw
      .split(',')
      .map(type => type.trim())
      .filter(Boolean);
    if (types.length > 0) value.types = types;
  }
  return { ok: true, value };
};

const resolveWidgetWelcomeMode = (
  mode: WidgetWelcomeMode | undefined,
  sendWidgetWelcomeMessage: boolean | undefined,
  widgetWelcomeMessage: string | undefined
): WidgetWelcomeMode => {
  if (mode) return mode;
  if (sendWidgetWelcomeMessage === false) return 'off';
  if ((widgetWelcomeMessage ?? '').trim().length > 0) return 'static';
  return 'model';
};

export const createKuralleChatRouter = ({
  runtime,
  upgradeWebSocket,
  widgetWelcomeMode,
  sendWidgetWelcomeMessage = true,
  widgetWelcomeMessage,
  widgetWelcomeSuggestions,
  streamFilter: streamFilterOption,
}: KuralleChatRouterOptions): Hono => {
  const streamFilter: StreamEventFilter = streamFilterOption ?? 'safe';
  const app = new Hono();
  const effectiveWelcomeMode = resolveWidgetWelcomeMode(
    widgetWelcomeMode,
    sendWidgetWelcomeMessage,
    widgetWelcomeMessage
  );

  const sendHarnessPartToWs = (ws: KuralleWebSocket, part: HarnessStreamPart) => {
    if (!shouldEmit(part, streamFilter)) return;
    ws.send(JSON.stringify(sanitizeForClient(part)));
  };

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/api/chat', async (c) => {
    const body = await parseJsonBody<ChatRequest>(c);
    if (!body || !body.message) {
      return c.json({ error: 'message required' }, 400);
    }

    try {
      const result = await collectResponse(
        runtime,
        body.message,
        body.sessionId,
        body.userId
      );

      return c.json({
        sessionId: result.sessionId,
        response: result.response,
        timestamp: new Date().toISOString(),
      } satisfies ChatResponse);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post('/api/chat/stream', async (c) => {
    const body = await parseJsonBody<Record<string, unknown>>(c);
    if (!body) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { input, sessionId } = extractInputFromBody(body);

    if (!input) {
      return c.json({ error: 'message required' }, 400);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of iterateRuntimeParts(runtime, {
            input,
            sessionId,
            userId: body.userId as string | undefined,
          })) {
            if (part.type === 'text-delta') {
              controller.enqueue(encoder.encode(part.delta));
            }
          }
        } catch (error) {
          controller.enqueue(encoder.encode(`\nError: ${(error as Error).message}`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  });

  app.post('/api/chat/sse', async (c) => {
    const body = await parseJsonBody<Record<string, unknown>>(c);
    if (!body) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { input, sessionId: bodySessionId } = extractInputFromBody(body);
    if (!input) {
      return c.json({ error: 'message required' }, 400);
    }

    const sessionId =
      bodySessionId ??
      (typeof body.sessionId === 'string' ? body.sessionId : undefined) ??
      crypto.randomUUID();
    const userId = typeof body.userId === 'string' ? body.userId : undefined;

    if (wantsRawStreamFormat(c)) {
      return streamSSE(c, async (stream) => {
        try {
          for await (const part of iterateRuntimeParts(runtime, {
            input,
            sessionId,
            userId,
          })) {
            await sendSSEPart(stream, part, streamFilter);
          }
        } catch (error) {
          console.error('[Kuralle] SSE stream error:', error);
          const message =
            streamFilter === 'all'
              ? (error as Error).message
              : 'An error occurred. Please try again.';
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: message }),
          });
        }
      });
    }

    const handle = runtime.run({ input, sessionId, userId });
    return handle.toUIMessageStreamResponse({ sessionId });
  });

  app.post('/api/chat/resume', async (c) => {
    const body = await parseJsonBody<ResumeRequest>(c);
    if (!body?.sessionId || !body.signal?.signalId || !body.signal?.name) {
      return c.json({ error: 'sessionId and signal { signalId, name } required' }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const part of iterateRuntimeParts(runtime, {
          sessionId: body.sessionId,
          signalDelivery: {
            signalId: body.signal.signalId,
            name: body.signal.name,
            payload: body.signal.payload,
          },
        })) {
          await sendSSEPart(stream, part, streamFilter);
        }
      } catch (error) {
        console.error('[Kuralle] SSE resume error:', error);
        const message =
          streamFilter === 'all'
            ? (error as Error).message
            : 'An error occurred. Please try again.';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: message }),
        });
      }
    });
  });

  app.get('/api/session/:id', async (c) => {
    const sessionId = c.req.param('id');
    const session = await runtime.getSession(sessionId);

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json(formatSessionResponse(session));
  });

  app.post('/api/sessions/:id/outcome', async (c) => {
    const sessionId = c.req.param('id');
    const body = await parseJsonBody<OutcomeRequest>(c);
    if (!body || !isConversationOutcome(body.outcome)) {
      return c.json({ error: 'valid outcome required' }, 400);
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return c.json({ error: 'reason must be a string' }, 400);
    }

    try {
      await runtime.markOutcome(sessionId, body.outcome, {
        markedBy: 'http',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      const session = await runtime.getSession(sessionId);
      return c.json({ outcome: session?.metadata?.outcome });
    } catch (error) {
      const message = (error as Error).message;
      const status = /session not found/i.test(message) ? 404 : 500;
      return c.json({ error: message }, status as 404 | 500);
    }
  });

  app.get('/api/sessions/:id/outcome', async (c) => {
    const sessionId = c.req.param('id');
    const session = await runtime.getSession(sessionId);
    if (!session?.metadata?.outcome) {
      return c.json({ error: 'Outcome not found' }, 404);
    }

    return c.json({ outcome: session.metadata.outcome });
  });

  app.get('/api/sessions/:id/audit', async (c) => {
    const sessionId = c.req.param('id');
    const query = parseAuditQuery(c);
    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }

    try {
      const entries = await runtime.replayAuditLog(sessionId, query.value);
      return c.json({ entries, total: entries.length });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post('/api/sessions/:id/csat', async (c) => {
    const sessionId = c.req.param('id');
    const body = await parseJsonBody<CsatRequest>(c);
    const score = body?.score;
    if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5) {
      return c.json({ error: 'score must be an integer from 1 to 5' }, 400);
    }
    if (body?.comment !== undefined && typeof body.comment !== 'string') {
      return c.json({ error: 'comment must be a string' }, 400);
    }

    const session = await runtime.getSession(sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const csat: CsatRecord = {
      score: score as CsatRecord['score'],
      ...(body?.comment ? { comment: body.comment } : {}),
      collectedAt: new Date().toISOString(),
    };
    ensureMetadata(session).csat = csat;
    await runtime.getSessionStore().save(session);

    return c.json({ csat });
  });

  app.delete('/api/session/:id', async (c) => {
    const sessionId = c.req.param('id');
    await runtime.deleteSession(sessionId);
    return c.json({ success: true });
  });

  // PR-13 — manual compaction trigger. Useful for /compress slash
  // commands in UIs and pre-emptive compression before known-expensive
  // turns. Body: { focusTopic?: string, force?: boolean }.
  app.post('/api/session/:id/compress', async (c) => {
    const sessionId = c.req.param('id');
    let body: { focusTopic?: string; force?: boolean } = {};
    try {
      body = (await c.req.json()) as { focusTopic?: string; force?: boolean };
    } catch {
      // No body is fine — use defaults
    }
    if (typeof runtime.compressNow !== 'function') {
      return c.json({ error: 'compressNow not available on this Runtime' }, 501);
    }
    try {
      const result = await runtime.compressNow(sessionId, body);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'compression failed';
      const code = /session not found/i.test(message) ? 404 : 500;
      return c.json({ error: message }, code as 404 | 500);
    }
  });

  // Agent configuration endpoint
  app.get('/api/agent/:agentId', (c) => {
    const agentId = c.req.param('agentId');

    // Get the base URL for WebSocket connections
    const protocol = c.req.header('x-forwarded-proto') || (c.req.url.startsWith('https://') ? 'wss' : 'ws');
    const host = c.req.header('host') || c.req.header('x-forwarded-host') || 'localhost:3333';
    const wsBaseUrl = `${protocol}://${host}`;

    // Return agent configuration
    // In production, this would look up the agent in a database
    const agentConfig = {
      id: agentId,
      name: agentId === 'support' ? 'Support Agent' :
            agentId === 'hospital' ? 'Hospital Support' :
            agentId === 'triage' ? 'Triage Agent' : 'Unknown Agent',
      wsUrl: `${wsBaseUrl}/agents/chat`,
      status: 'active',
      capabilities: ['chat', 'streaming'],
      config: {
        primaryColor: "#14B8A6",
        position: "bottom-right",
        theme: "light",
        title: agentId === 'hospital' ? "Hospital Support" : "Chat Support",
        subtitle: "We're here to help!",
        avatarUrl: undefined,
        maxRetries: 3,
        reconnectDelay: 1000
      }
    };

    return c.json(agentConfig);
  });

  // Agent WebSocket endpoint for widgets (matches widget client expectations)
  if (upgradeWebSocket) {
    app.get('/agents/chat/:sessionId', upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId') ?? '';

      return {
        onOpen: async (_event, ws) => {
          debug(`[Kuralle] New widget connection: ${sessionId}`);

          // Send connected message
          ws.send(
            JSON.stringify({
              type: 'connected',
              sessionId,
              timestamp: new Date().toISOString(),
            })
          );

          if (effectiveWelcomeMode !== 'off') {
            const staticWelcome = widgetWelcomeMessage?.trim();
            if (effectiveWelcomeMode === 'static') {
              const welcomeId = crypto.randomUUID();
              ws.send(JSON.stringify({ type: 'text-start', id: welcomeId }));
              ws.send(JSON.stringify({
                type: 'text-delta',
                id: welcomeId,
                delta: staticWelcome || 'Hello! How can I help you today?',
              }));
              ws.send(JSON.stringify({ type: 'text-end', id: welcomeId }));

              const suggestions = (widgetWelcomeSuggestions ?? [])
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 3);

              if (suggestions.length > 0) {
                ws.send(JSON.stringify({
                  type: 'suggested-questions',
                  suggestions,
                  isPartial: false,
                }));
              }

              ws.send(JSON.stringify({
                type: 'done',
                sessionId,
                timestamp: new Date().toISOString(),
              }));
            } else {
              // Optionally start conversation with a generated greeting.
              try {
                const systemPrompt = `[SYSTEM: A new user has connected to the chat widget. Greet them warmly and introduce yourself briefly. Ask how you can help them today.]`;

                for await (const part of iterateRuntimeParts(runtime, {
                  input: systemPrompt,
                  sessionId,
                  userId: 'widget-user',
                })) {
                  sendHarnessPartToWs(ws, part);
                }
              } catch (error) {
                console.error(`[Kuralle] Failed to send greeting for session ${sessionId}:`, error);
                // Send a simple greeting if streaming fails
                const fallbackId = crypto.randomUUID();
                ws.send(JSON.stringify({ type: 'text-start', id: fallbackId }));
                ws.send(JSON.stringify({
                  type: 'text-delta',
                  id: fallbackId,
                  delta: 'Hello! How can I help you today?',
                }));
                ws.send(JSON.stringify({ type: 'text-end', id: fallbackId }));
                ws.send(JSON.stringify({
                  type: 'done',
                  sessionId,
                  timestamp: new Date().toISOString(),
                }));
              }
            }
          }
        },

        async onMessage(event, ws) {
          try {
            const payload = JSON.parse(coerceToString(event.data));

            // Handle the widget's message format
            const input = payload.message;
            if (typeof input !== 'string' || !input.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'message content required' }));
              return;
            }

            for await (const part of iterateRuntimeParts(runtime, {
              input,
              sessionId,
              userId: payload.userId,
            })) {
              sendHarnessPartToWs(ws, part);
            }
          } catch (error) {
            console.error('[Kuralle] Widget WebSocket error:', error);
            ws.send(
              JSON.stringify({
                type: 'error',
                error:
                  streamFilter === 'all'
                    ? (error as Error).message
                    : 'An error occurred. Please try again.',
              })
            );
          }
        },
      };
    }));
  }

  if (upgradeWebSocket) {
    app.get('/ws/:sessionId', upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId') ?? '';

      return {
        onOpen(_event, ws) {
          ws.send(
            JSON.stringify({
              type: 'connected',
              sessionId,
              timestamp: new Date().toISOString(),
            })
          );
        },

        async onMessage(event, ws) {
          try {
            const payload = JSON.parse(coerceToString(event.data));

            // Handle cancellation (barge-in)
            if (payload.type === 'cancel') {
              runtime.abortSession(sessionId, payload.reason ?? 'User interrupted');
              ws.send(
                JSON.stringify({
                  type: 'cancelled',
                  sessionId,
                  timestamp: new Date().toISOString(),
                })
              );
              return;
            }

            const input = payload.content ?? payload.message;

            if (payload.type === 'message') {
              if (typeof input !== 'string' || !input.trim()) {
                ws.send(JSON.stringify({ type: 'error', error: 'message content required' }));
                return;
              }
              for await (const part of iterateRuntimeParts(runtime, {
                input,
                sessionId,
                userId: payload.userId,
              })) {
                sendHarnessPartToWs(ws, part);
              }

              return;
            }

            if (payload.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } catch (error) {
            console.error('[Kuralle] Flow WebSocket error:', error);
            ws.send(
              JSON.stringify({
                type: 'error',
                error:
                  streamFilter === 'all'
                    ? (error as Error).message
                    : 'An error occurred. Please try again.',
              })
            );
          }
        },
      };
    }));
  }

  return app;
};

export type { HarnessStreamPart };

// ═══════════════════════════════════════════════════════════════
// Flow Support
// ═══════════════════════════════════════════════════════════════

const sendFlowSSEPart = async (
  stream: { writeSSE: (data: { event: string; data: string }) => Promise<void> },
  part: FlowStreamPart
) => {
  await stream.writeSSE({ event: part.type, data: JSON.stringify(part) });
};

const collectFlowResponse = async (
  flowManager: FlowRouterManager,
  message: string
): Promise<{ response: string; hasEnded: boolean }> => {
  let response = '';

  for await (const part of flowManager.process(message)) {
    if (part.type === 'text-delta') {
      response += part.delta;
    }

    if (part.type === 'error') {
      throw new Error(part.error);
    }
  }

  return {
    response,
    hasEnded: flowManager.hasEnded,
  };
};

export const createKuralleRouter = ({
  flowManager,
  sessionId,
  upgradeWebSocket,
}: KuralleRouterOptions): Hono => {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/info', (c) =>
    c.json({
      sessionId,
      currentNode: flowManager.currentNodeName,
      nodeHistory: flowManager.nodeHistory,
      hasEnded: flowManager.hasEnded,
      collectedData: flowManager.collectedData,
      timestamp: new Date().toISOString(),
    })
  );

  app.get('/flow-state', (c) =>
    c.json({
      currentNode: flowManager.currentNodeName,
      nodeHistory: flowManager.nodeHistory,
      collectedData: flowManager.collectedData,
      hasEnded: flowManager.hasEnded,
    })
  );

  app.post('/api/flow/chat', async (c) => {
    const body = await parseJsonBody<FlowRequest>(c);
    if (!body || !body.message) {
      return c.json({ error: 'message required' }, 400);
    }

    try {
      const result = await collectFlowResponse(flowManager, body.message);

      return c.json({
        sessionId,
        currentNode: flowManager.currentNodeName,
        nodeHistory: flowManager.nodeHistory,
        hasEnded: flowManager.hasEnded,
        response: result.response,
        timestamp: new Date().toISOString(),
      } satisfies FlowResponse);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post('/api/flow/stream', async (c) => {
    const body = await parseJsonBody<Record<string, unknown>>(c);
    if (!body) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { input, sessionId } = extractInputFromBody(body);

    if (!input) {
      return c.json({ error: 'message required' }, 400);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of flowManager.process(input)) {
            if (part.type === 'text-delta') {
              controller.enqueue(encoder.encode(part.delta));
            }
          }
        } catch (error) {
          controller.enqueue(encoder.encode(`\nError: ${(error as Error).message}`));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  });

  app.post('/api/flow/sse', async (c) => {
    const body = await parseJsonBody<Record<string, unknown>>(c);
    if (!body) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { input, sessionId: bodySessionId } = extractInputFromBody(body);
    if (!input) {
      return c.json({ error: 'message required' }, 400);
    }

    if (wantsRawStreamFormat(c)) {
      return streamSSE(c, async (stream) => {
        try {
          for await (const part of flowManager.process(input)) {
            await sendFlowSSEPart(stream, part);
          }
        } catch (error) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: (error as Error).message }),
          });
        }
      });
    }

    async function* flowHarnessParts(): AsyncGenerator<HarnessStreamPart> {
      for await (const part of flowManager.process(input)) {
        if (
          part.type === 'text-start' ||
          part.type === 'text-delta' ||
          part.type === 'text-end' ||
          part.type === 'text-cancel' ||
          part.type === 'tool-call' ||
          part.type === 'tool-result' ||
          part.type === 'node-enter' ||
          part.type === 'node-exit' ||
          part.type === 'flow-enter' ||
          part.type === 'flow-transition' ||
          part.type === 'flow-end' ||
          part.type === 'handoff' ||
          part.type === 'interactive' ||
          part.type === 'safety-blocked' ||
          part.type === 'pipeline-validation-block' ||
          part.type === 'conversation-outcome' ||
          part.type === 'interrupted' ||
          part.type === 'paused' ||
          part.type === 'custom' ||
          part.type === 'error' ||
          part.type === 'done' ||
          part.type === 'turn-end'
        ) {
          yield part as HarnessStreamPart;
        }
      }
    }

    return createUIMessageStreamResponse({
      stream: harnessToUIMessageStream(flowHarnessParts(), {
        sessionId: bodySessionId ?? sessionId,
      }),
    });
  });

  if (upgradeWebSocket) {
    app.get('/ws', upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        // Generate sessionId for this connection
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        ws.send(
          JSON.stringify({
            type: 'connected',
            sessionId,
            timestamp: new Date().toISOString(),
          })
        );

        // Note: Automatic greeting would require async, but this is sync
        // The greeting will be sent on first message instead
      },

      async onMessage(event, ws) {
        try {
          const payload = JSON.parse(coerceToString(event.data));
          const input = payload.content ?? payload.message;

          if (payload.type === 'message') {
            if (typeof input !== 'string' || !input.trim()) {
              ws.send(JSON.stringify({ type: 'error', error: 'message content required' }));
              return;
            }

            // For the first message, prepend a greeting
            let fullInput = input;
            if (!payload.sessionId) {
              const greeting = "Hello! I'm here to help you. ";
              fullInput = greeting + input;
            }

            for await (const part of flowManager.process(fullInput)) {
              ws.send(JSON.stringify(part));
            }

            return;
          }

          if (payload.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: (error as Error).message,
            })
          );
        }
      }
    })));
  }

  return app;
};
