import {
  PART_CHANNEL,
  scanMemoryWrite,
  type ExtractedValue,
  type LoggedEvent,
  type SessionEventLog,
  type StreamPart,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

export type StreamEventFilter = 'safe' | 'all' | ((part: StreamPart) => boolean);

export function shouldEmit(part: StreamPart, filter: StreamEventFilter): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'function') return filter(part);
  return PART_CHANNEL[part.type] === 'client';
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

function matchSessionRoute(pathname: string): SessionRouteMatch | null {
  const events = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/events\/?$/);
  if (events?.[1] && events[2]) {
    return { kind: 'events', agent: decodeURIComponent(events[1]), sessionId: decodeURIComponent(events[2]) };
  }
  const snapshot = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/snapshot\/?$/);
  if (snapshot?.[1] && snapshot[2]) {
    return { kind: 'snapshot', agent: decodeURIComponent(snapshot[1]), sessionId: decodeURIComponent(snapshot[2]) };
  }
  const cancel = pathname.match(/\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/cancel\/?$/);
  if (cancel?.[1] && cancel[2]) {
    return { kind: 'cancel', agent: decodeURIComponent(cancel[1]), sessionId: decodeURIComponent(cancel[2]) };
  }
  const memory = pathname.match(/\/v1\/agents\/([^/]+)\/users\/([^/]+)\/memory\/?$/);
  if (memory?.[1] && memory[2]) {
    return { kind: 'memory', agent: decodeURIComponent(memory[1]), userId: decodeURIComponent(memory[2]) };
  }
  return null;
}

function parseFromIndex(value: string | null): number | null {
  if (value == null || value === '') return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseLimit(value: string | null): number | null {
  if (value == null || value === '') return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseFollow(value: string | null): boolean {
  if (value == null || value === '') return true;
  return value !== 'false' && value !== '0';
}

function filterLoggedEvent(event: LoggedEvent, filter: StreamEventFilter): LoggedEvent | null {
  if (shouldEmit(event.part, filter)) return event;
  return null;
}

async function loadMemoryBlocks(
  sql: SqlExecutor,
  owner: string,
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
  const rows = sql<{
    key: string;
    scope: string;
    content: string;
    char_limit: number;
  }>`
    SELECT key, scope, content, char_limit
    FROM working_memory_blocks
    WHERE owner = ${owner}
    ORDER BY scope, key
  `;
  const blocks: Array<{ key: string; scope: string; chars: number; limit: number; content: string }> = [];
  for (const row of rows) {
    if (!scanMemoryWrite(row.content).safe) continue;
    blocks.push({
      key: row.key,
      scope: row.scope,
      chars: row.content.length,
      limit: row.char_limit,
      content: row.content,
    });
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
      value: parsed.value,
      updatedAt: parsed.updatedAt,
    });
  }
  return extracted;
}

export interface SessionHttpOptions {
  request: Request;
  boundSessionId: string;
  eventLog: SessionEventLog;
  sql: SqlExecutor;
  cancelTurn: () => boolean;
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
      return handleMemory(options.request, options.sql, match.userId);
  }
}

async function handleEvents(
  request: Request,
  eventLog: SessionEventLog,
  sessionId: string,
  url: URL,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const from = parseFromIndex(url.searchParams.get('from'));
  if (from === null) {
    return Response.json({ error: 'from must be a non-negative integer' }, { status: 400 });
  }

  const follow = parseFollow(url.searchParams.get('follow'));
  const filter: StreamEventFilter = 'safe';
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
    const headers = new Headers({ 'content-type': 'application/x-ndjson' });
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
  const headers = new Headers({ 'content-type': 'application/x-ndjson' });
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
    return new Response('Method Not Allowed', { status: 405 });
  }
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) {
    return Response.json({ error: 'limit must be a non-negative integer' }, { status: 400 });
  }

  const filter: StreamEventFilter = 'safe';
  const { events, next } = await eventLog.read(sessionId, 0, limit);
  const visible = events
    .map((event) => filterLoggedEvent(event, filter))
    .filter((event): event is LoggedEvent => event != null);

  return Response.json({
    events: visible,
    cursor: { sessionId, index: next },
  });
}

function handleCancel(request: Request, cancelTurn: () => boolean): Response {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const cancelled = cancelTurn();
  return Response.json({
    status: cancelled ? 'cancelled' : 'no_active_turn',
  });
}

async function handleMemory(request: Request, sql: SqlExecutor, userId: string): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const blocks = await loadMemoryBlocks(sql, userId);
  const extracted = await loadExtractedValues(sql, userId);
  return Response.json({ blocks, extracted });
}
