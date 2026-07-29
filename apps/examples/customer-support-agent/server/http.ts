import type { HitlInterrupt, Runtime, StreamPart } from '@kuralle-agents/core';
import {
  requireConversationId,
  resolveSupportIdentity,
  scopedSessionId,
} from '../src/identity';
import { getSupportRuntime, requiredEnv } from './runtime';

interface ChatBody {
  conversationId?: unknown;
  message?: unknown;
}

interface ApprovalBody {
  conversationId?: unknown;
  requestId?: unknown;
  decision?: unknown;
  reason?: unknown;
}

export async function handleChatRequest(
  request: Request,
  dependencies: { runtime?: () => Promise<Runtime>; secure?: boolean } = {},
): Promise<Response> {
  try {
    const identity = await resolveSupportIdentity(
      request,
      requiredEnv('SUPPORT_IDENTITY_SECRET'),
      { secure: dependencies.secure ?? process.env.NODE_ENV === 'production' },
    );
    const body = await safeJson<ChatBody>(request);
    const conversationId = requireConversationId(body.conversationId);
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return json({ error: 'A non-empty message is required.' }, 400, identity.setCookie);
    }
    if (body.message.length > 16_000) {
      return json({ error: 'Message exceeds 16000 characters.' }, 413, identity.setCookie);
    }

    const runtime = await (dependencies.runtime ?? getSupportRuntime)();
    const result = await collect(runtime.run({
      input: body.message.trim(),
      userId: identity.userId,
      sessionId: scopedSessionId(identity.userId, conversationId),
      idempotencyKey: request.headers.get('x-idempotency-key') || undefined,
    }));
    return json({ conversationId, ...result }, 200, identity.setCookie);
  } catch (error) {
    console.error(JSON.stringify({ event: 'support_chat_failed', error: safeError(error) }));
    return json({ error: publicError(error) }, error instanceof SyntaxError ? 400 : 500);
  }
}

export async function handleApprovalRequest(
  request: Request,
  dependencies: { runtime?: () => Promise<Runtime>; secure?: boolean } = {},
): Promise<Response> {
  try {
    const identity = await resolveSupportIdentity(
      request,
      requiredEnv('SUPPORT_IDENTITY_SECRET'),
      { secure: dependencies.secure ?? process.env.NODE_ENV === 'production' },
    );
    const body = await safeJson<ApprovalBody>(request);
    const conversationId = requireConversationId(body.conversationId);
    const requestId = requiredString(body.requestId, 'requestId');
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      return json({ error: 'decision must be approve or deny.' }, 400, identity.setCookie);
    }
    const runtime = await (dependencies.runtime ?? getSupportRuntime)();
    const result = await collect(runtime.run({
      sessionId: scopedSessionId(identity.userId, conversationId),
      signalDelivery: {
        signalId: crypto.randomUUID(),
        requestId,
        name: '__approval',
        decision: body.decision,
        actor: { id: identity.userId, type: 'user' },
        ...(typeof body.reason === 'string' && body.reason.trim()
          ? { reason: body.reason.trim().slice(0, 500) }
          : {}),
      },
    }));
    return json({ conversationId, ...result }, 200, identity.setCookie);
  } catch (error) {
    console.error(JSON.stringify({ event: 'support_approval_failed', error: safeError(error) }));
    return json({ error: publicError(error) }, 500);
  }
}

async function collect(handle: ReturnType<Runtime['run']>) {
  let response = '';
  let pendingApproval: HitlInterrupt | undefined;
  let escalated = false;
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') response += part.payload.delta;
    if (part.type === 'paused' && part.payload.interrupt.kind === 'approval') {
      pendingApproval = part.payload.interrupt;
    }
    if (part.type === 'escalation') escalated = true;
    if (part.type === 'error') throw new Error(part.payload.error);
  }
  await handle;
  return {
    response: response.trim(),
    status: pendingApproval ? 'approval-required' : escalated ? 'escalated' : 'completed',
    ...(pendingApproval ? {
      pendingApproval: {
        requestId: pendingApproval.requestId,
        title: pendingApproval.display.title,
        description: pendingApproval.display.description,
      },
    } : {}),
  };
}

async function safeJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new SyntaxError('Request body must be valid JSON.');
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function json(body: unknown, status: number, setCookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (setCookie) headers.set('set-cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicError(error: unknown): string {
  return process.env.NODE_ENV === 'production'
    ? 'The support request could not be completed.'
    : safeError(error);
}
