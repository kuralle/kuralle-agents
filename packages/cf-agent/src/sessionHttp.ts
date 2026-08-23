import { shouldEmit, type StreamEventFilter } from '@kuralle-agents/core';
import {
  PART_CHANNEL,
  sanitizePart,
  scanMemoryWrite,
  scrubSecrets,
  type ExtractedValue,
  type LoggedEvent,
  type SessionEventLog,
  type StreamPart,
} from '@kuralle-agents/core';
import { scopedKey } from '@kuralle-agents/deployment';
import type { SqlExecutor } from './types.js';


export interface SessionPrincipal {
  tenantId: string;
  userId: string;
}

function applyNoBufferingHeaders(headers: Headers): void {
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Content-Encoding', 'identity');
  headers.set('X-Accel-Buffering', 'no');
}

type SessionRouteMatch =
  | { kind: 'events'; agent: string; sessionId: string }
  | { kind: 'snapshot'; agent: string; sessionId: string }
  | { kind: 'cancel'; agent: string; sessionId: string }
  | { kind: 'memory'; agent: string; userId: string };

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchSessionRoute(pathname: string): SessionRouteMatch | null {
  const events = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/events$/);
  if (events?.[1] && events[2]) {
    return { kind: 'events', agent: decodePathSegment(events[1]), sessionId: decodePathSegment(events[2]) };
  }
  const snapshot = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/snapshot$/);
  if (snapshot?.[1] && snapshot[2]) {
    return { kind: 'snapshot', agent: decodePathSegment(snapshot[1]), sessionId: decodePathSegment(snapshot[2]) };
  }
  const cancel = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/cancel$/);
  if (cancel?.[1] && cancel[2]) {
    return { kind: 'cancel', agent: decodePathSegment(cancel[1]), sessionId: decodePathSegment(cancel[2]) };
  }
  const memory = pathname.match(/\/v1\/agents\/([^/]+)\/users\/([^/]+)\/memory$/);
  if (memory?.[1] && memory[2]) {
    return { kind: 'memory', agent: decodePathSegment(memory[1]), userId: decodePathSegment(memory[2]) };
  }
  return null;
}

function parseFromIndex(value: string | null): number | null {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseLimit(value: string | null): number | null {
  if (value == null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, 1000);
}

function parseFollow(value: string | null): boolean {
  if (value == null || value === '') return true;
  return value !== 'false' && value !== '0';
}

const clientSafeFilter: StreamEventFilter = (part) => shouldEmit(part, 'safe');

function filterLoggedEvent(event: LoggedEvent, filter: StreamEventFilter): LoggedEvent | null {
  if (!shouldEmit(event.part, filter)) return null;
  return {
    ...event,
    part: sanitizePart(event.part),
  };
}

function scrubExtractedValue(value: unknown): unknown {
  const part = scrubSecrets({
    channel: 'internal',
    type: 'extraction',
    payload: { slug: 'memory-export', value, changed: false },
  });
  if (part.type === 'extraction') {
    return part.payload.value;
  }
  return value;
}

async function loadMemoryBlocks(
  sql: SqlExecutor,
  owner: string,
  agentId: string,
): Promise<Array<{ key: string; scope: string; chars: number; limit: number; content: string }>> {
  sql`
    CREATE TABLE IF NOT EXISTS working_memory_blocks (
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      char_limit INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, owner, key)
    )
  `;
  const owners = [
    { scope: 'user', owner },
    { scope: 'shared', owner },
    { scope: 'agent', owner: agentId },
  ];
  const blocks: Array<{ key: string; scope: string; chars: number; limit: number; content: string }> = [];
  for (const { scope, owner: blockOwner } of owners) {
    const rows = sql<{
      key: string;
      scope: string;
      content: string;
      char_limit: number;
    }>`
      SELECT key, scope, content, char_limit
      FROM working_memory_blocks
      WHERE scope = ${scope} AND owner = ${blockOwner}
      ORDER BY key
    `;
    for (const row of rows) {
      const content = scanMemoryWrite(row.content).safe ? row.content : '';
      blocks.push({
        key: row.key,
        scope: row.scope,
        chars: content.length,
        limit: row.char_limit,
        content,
      });
    }
  }
  return blocks;
}

async function loadExtractedValues(
  sql: SqlExecutor,
  owner: string,
): Promise<Array<{ slug: string; scope: string; value: unknown; updatedAt: string }>> {
  sql`
    CREATE TABLE IF NOT EXISTS extracted_values (
      scope TEXT NOT NULL,
      owner TEXT NOT NULL,
      slug TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (scope, owner, slug)
    )
  `;
  const rows = sql<{ value: string }>`
    SELECT value FROM extracted_values WHERE owner = ${owner}
  `;
  const extracted: Array<{ slug: string; scope: string; value: unknown; updatedAt: string }> = [];
  for (const row of rows) {
    const parsed = JSON.parse(row.value) as ExtractedValue;
    extracted.push({
      slug: parsed.slug,
      scope: parsed.scope,
      value: scrubExtractedValue(parsed.value),
      updatedAt: parsed.updatedAt,
    });
  }
  return extracted;
}

async function readVisibleSnapshot(
  eventLog: SessionEventLog,
  sessionId: string,
  limit: number,
  filter: StreamEventFilter,
): Promise<{ events: LoggedEvent[]; next: number }> {
  const visible: LoggedEvent[] = [];
  let cursor = 0;
  let next = 0;

  while (visible.length < limit) {
    const batch = await eventLog.read(sessionId, cursor, limit);
    if (batch.events.length === 0) {
      next = cursor;
      break;
    }
    for (const event of batch.events) {
      const filtered = filterLoggedEvent(event, filter);
      if (filtered) {
        visible.push(filtered);
        if (visible.length >= limit) {
          return { events: visible, next: batch.next };
        }
      }
    }
    if (batch.next <= cursor) {
      next = batch.next;
      break;
    }
    cursor = batch.next;
    next = batch.next;
  }

  return { events: visible, next };
}

export interface SessionHttpOptions {
  request: Request;
  boundSessionId: string;
  eventLog: SessionEventLog;
  sql: SqlExecutor;
  cancelTurn: () => boolean;
  resolvePrincipal?: (request: Request) => SessionPrincipal | null | Promise<SessionPrincipal | null>;
}

export async function dispatchSessionRequest(options: SessionHttpOptions): Promise<Response | null> {
  const url = new URL(options.request.url);
  const match = matchSessionRoute(url.pathname);
  if (!match) return null;

  if (match.kind !== 'memory' && match.sessionId !== options.boundSessionId) {
    return Response.json({ error: 'session not found' }, { status: 404 });
  }

  switch (match.kind) {
    case 'events':
      return handleEvents(options.request, options.eventLog, match.sessionId, url);
    case 'snapshot':
      return handleSnapshot(options.request, options.eventLog, match.sessionId, url);
    case 'cancel':
      return handleCancel(options.request, options.cancelTurn);
    case 'memory':
      return handleMemory(
        options.request,
        options.sql,
        match.agent,
        match.userId,
        options.resolvePrincipal,
      );
  }
}

async function handleEvents(
  request: Request,
  eventLog: SessionEventLog,
  sessionId: string,
  url: URL,
): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const from = parseFromIndex(url.searchParams.get('from'));
  if (from === null) {
    return Response.json({ error: 'from must be a non-negative integer' }, { status: 400 });
  }

  const follow = parseFollow(url.searchParams.get('follow'));
  const filter = clientSafeFilter;
  const encoder = new TextEncoder();

  if (!follow) {
    const tailAtOpen = await eventLog.tail(sessionId);
    const stream = new ReadableStream({
      async start(controller) {
        let cursor = from;
        while (tailAtOpen >= 0 && cursor <= tailAtOpen) {
          const batch = await eventLog.read(sessionId, cursor);
          if (batch.events.length === 0) break;
          for (const event of batch.events) {
            const filtered = filterLoggedEvent(event, filter);
            if (filtered) {
              controller.enqueue(encoder.encode(`${JSON.stringify(filtered)}\n`));
            }
          }
          if (batch.next <= cursor) break;
          cursor = batch.next;
        }
        controller.close();
      },
    });
    const headers = new Headers({ 'content-type': 'application/x-ndjson; charset=utf-8' });
    applyNoBufferingHeaders(headers);
    return new Response(stream, { headers });
  }

  const abortSignal = request.signal;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of eventLog.follow(sessionId, from, abortSignal)) {
          const filtered = filterLoggedEvent(event, filter);
          if (filtered) {
            controller.enqueue(encoder.encode(`${JSON.stringify(filtered)}\n`));
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const headers = new Headers({ 'content-type': 'application/x-ndjson; charset=utf-8' });
  applyNoBufferingHeaders(headers);
  return new Response(stream, { headers });
}

async function handleSnapshot(
  request: Request,
  eventLog: SessionEventLog,
  sessionId: string,
  url: URL,
): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) {
    return Response.json({ error: 'limit must be a positive integer' }, { status: 400 });
  }

  const filter = clientSafeFilter;
  const { events, next } = await readVisibleSnapshot(eventLog, sessionId, limit, filter);

  return Response.json({
    events,
    cursor: { sessionId, index: next },
  });
}

function handleCancel(request: Request, cancelTurn: () => boolean): Response {
  if (request.method !== 'POST') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const cancelled = cancelTurn();
  return Response.json({
    status: cancelled ? 'cancelled' : 'no_active_turn',
  });
}

async function handleMemory(
  request: Request,
  sql: SqlExecutor,
  agentId: string,
  userId: string,
  resolvePrincipal?: (request: Request) => SessionPrincipal | null | Promise<SessionPrincipal | null>,
): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const principal = resolvePrincipal ? await resolvePrincipal(request) : null;
  if (!principal) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (principal.userId !== userId) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  const owner = scopedKey(principal.tenantId, userId);
  const blocks = await loadMemoryBlocks(sql, owner, agentId);
  const extracted = await loadExtractedValues(sql, owner);
  return Response.json({ blocks, extracted });
}
