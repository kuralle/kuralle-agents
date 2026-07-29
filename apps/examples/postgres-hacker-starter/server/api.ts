import type { HitlInterrupt, Runtime, StreamPart } from '@kuralle-agents/core';
import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { getRepository, getRuntime } from './runtime';
import { requireServerEnv } from './env';

const identityCookie = () => process.env.NODE_ENV === 'production' ? '__Host-kuralle_hacker_id' : 'kuralle_hacker_id';
const CONVERSATION_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

interface Identity {
  userId: string;
  created: boolean;
}

interface ChatBody {
  id?: unknown;
  sessionId?: unknown;
  messages?: unknown;
}

interface ApprovalBody {
  conversationId?: unknown;
  requestId?: unknown;
  name?: unknown;
  decision?: unknown;
  reason?: unknown;
}

export function scopedSessionId(userId: string, conversationId: string): string {
  if (!CONVERSATION_PATTERN.test(conversationId)) throw new Error('Invalid conversation id.');
  return `${userId}:${conversationId}`;
}

export function createApi(dependencies: {
  runtime?: () => Promise<Runtime>;
  repository?: typeof getRepository;
  cookieSecret?: () => string;
} = {}) {
  const resolveRuntime = dependencies.runtime ?? getRuntime;
  const resolveRepository = dependencies.repository ?? getRepository;
  const resolveSecret = dependencies.cookieSecret ?? (() => requireServerEnv('KURALLE_COOKIE_SECRET'));
  const app = new Hono().basePath('/api');

  app.onError((error, c) => {
    console.error('API request failed', error);
    const message = process.env.NODE_ENV === 'production' ? 'The request could not be completed.' : error.message;
    return c.json({ error: message }, 500);
  });

  app.get('/health', async (c) => {
    await resolveRuntime();
    return c.json({ status: 'ok', driver: process.env.KURALLE_DRIVER?.trim() || 'pi' });
  });

  app.get('/bootstrap', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    const repository = resolveRepository();
    const [profile, memories] = await Promise.all([
      repository.ensureProfile(identity.userId),
      repository.listMemories(identity.userId),
    ]);
    return c.json({
      profile: publicProfile(profile),
      memories,
      newIdentity: identity.created,
      driver: process.env.KURALLE_DRIVER?.trim() || 'pi',
    });
  });

  app.get('/profile', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    return c.json({ profile: publicProfile(await resolveRepository().getProfile(identity.userId)) });
  });

  app.get('/memories', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    return c.json({ memories: await resolveRepository().listMemories(identity.userId) });
  });

  app.get('/sessions', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    return c.json({ sessions: await resolveRepository().listSessionReports(identity.userId) });
  });

  app.get('/orders/:orderId', async (c) => {
    await resolveIdentity(c, resolveSecret());
    const order = await resolveRepository().getOrder(c.req.param('orderId'));
    return order ? c.json({ order }) : c.json({ error: 'Order not found.' }, 404);
  });

  app.get('/knowledge/search', async (c) => {
    await resolveIdentity(c, resolveSecret());
    const query = c.req.query('q')?.trim();
    if (!query) return c.json({ error: 'q is required.' }, 400);
    const results = await resolveRepository().searchKnowledge(query, { limit: 5 });
    return c.json({ results: results.map(({ embedding: _embedding, ...result }) => result) });
  });

  app.post('/chat', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    await resolveRepository().ensureProfile(identity.userId);
    const body = await safeJson<ChatBody>(c);
    const conversationId = conversationIdFromBody(body);
    const input = extractLatestUserText(body.messages);
    if (!input) return c.json({ error: 'A user text message is required.' }, 400);
    const runtime = await resolveRuntime();
    const handle = runtime.run({
      input,
      userId: identity.userId,
      sessionId: scopedSessionId(identity.userId, conversationId),
    });
    return handle.toUIMessageStreamResponse({ sessionId: conversationId });
  });

  app.post('/chat/approval', async (c) => {
    const identity = await resolveIdentity(c, resolveSecret());
    const body = await safeJson<ApprovalBody>(c);
    const conversationId = requiredString(body.conversationId, 'conversationId');
    const requestId = requiredString(body.requestId, 'requestId');
    const name = requiredString(body.name, 'name');
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      return c.json({ error: 'decision must be approve or deny.' }, 400);
    }
    const runtime = await resolveRuntime();
    const handle = runtime.run({
      sessionId: scopedSessionId(identity.userId, conversationId),
      signalDelivery: {
        signalId: crypto.randomUUID(),
        requestId,
        name,
        actor: { id: identity.userId, type: 'user' },
        decision: body.decision,
        ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
      },
    });
    let text = '';
    let pending: HitlInterrupt | undefined;
    for await (const part of handle.events as AsyncIterable<StreamPart>) {
      if (part.type === 'text-delta') text += part.payload.delta;
      if (part.type === 'paused') pending = part.payload.interrupt;
      if (part.type === 'error') throw new Error(part.payload.error);
    }
    return c.json({ text, pending });
  });

  return app;
}

async function resolveIdentity(c: Context, secret: string): Promise<Identity> {
  const existing = await getSignedCookie(c, secret, identityCookie());
  if (typeof existing === 'string' && /^[0-9a-f-]{36}$/i.test(existing)) {
    return { userId: existing, created: false };
  }
  const userId = crypto.randomUUID();
  await setSignedCookie(c, identityCookie(), userId, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return { userId, created: true };
}

async function safeJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function conversationIdFromBody(body: ChatBody): string {
  const candidate = typeof body.sessionId === 'string' ? body.sessionId : typeof body.id === 'string' ? body.id : '';
  if (!CONVERSATION_PATTERN.test(candidate)) throw new Error('A valid conversation id is required.');
  return candidate;
}

function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; parts?: unknown };
    if (message.role !== 'user' || !Array.isArray(message.parts)) continue;
    return message.parts
      .filter((part): part is { type: 'text'; text: string } => Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'))
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function publicProfile(profile: { name: string | null; email: string | null; preferences: Record<string, string>; lastSeenAt: string }) {
  return { name: profile.name, email: profile.email, preferences: profile.preferences, lastSeenAt: profile.lastSeenAt };
}

export const api = createApi();
