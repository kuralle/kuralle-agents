import {
  cancelSession,
  readEvents,
  readMemory,
  readSnapshot,
  type LoggedEvent,
  type SessionEventLog,
  type SessionRouteDeps,
  type StreamEventFilter,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

export interface SessionPrincipal {
  tenantId: string;
  userId: string;
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

function applyNoBufferingHeaders(headers: Headers): void {
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Content-Encoding', 'identity');
  headers.set('X-Accel-Buffering', 'no');
}

function ndjsonResponse(source: AsyncIterable<LoggedEvent>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of source) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const headers = new Headers({
    'content-type': 'application/x-ndjson; charset=utf-8',
    Connection: 'keep-alive',
  });
  applyNoBufferingHeaders(headers);
  return new Response(stream, { headers });
}

async function loadMemoryBlocks(
  sql: SqlExecutor,
  owner: string,
  agentId: string,
): Promise<Array<{ key: string; scope: string; content: string; charLimit: number }>> {
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
  const blocks: Array<{ key: string; scope: string; content: string; charLimit: number }> = [];
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
      blocks.push({
        key: row.key,
        scope: row.scope,
        content: row.content,
        charLimit: row.char_limit,
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
    const parsed = JSON.parse(row.value) as { slug: string; scope: string; value: unknown; updatedAt: string };
    extracted.push({
      slug: parsed.slug,
      scope: parsed.scope,
      value: parsed.value,
      updatedAt: parsed.updatedAt,
    });
  }
  return extracted;
}

function buildMemoryDeps(sql: SqlExecutor, agentId: string): SessionRouteDeps['memory'] {
  return {
    readBlocks: (owner) => loadMemoryBlocks(sql, owner, agentId),
    readExtracted: (owner) => loadExtractedValues(sql, owner),
  };
}

export interface SessionHttpOptions {
  request: Request;
  boundSessionId: string;
  /** Agent this DO serves. The agent path segment is validated against it, or it is decoration. */
  boundAgentId: string;
  eventLog: SessionEventLog;
  sql: SqlExecutor;
  cancelTurn: () => boolean;
  resolvePrincipal?: (request: Request) => SessionPrincipal | null | Promise<SessionPrincipal | null>;
  streamFilter?: StreamEventFilter;
}

export async function dispatchSessionRequest(options: SessionHttpOptions): Promise<Response | null> {
  const url = new URL(options.request.url);
  const match = matchSessionRoute(url.pathname);
  if (!match) return null;

  const filter = options.streamFilter ?? 'safe';
  const principal = options.resolvePrincipal
    ? await options.resolvePrincipal(options.request)
    : null;

  if (match.kind !== 'memory' && !principal) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // A path segment that changes nothing is a lie: Node 404s an unknown agent, so this must too.
  if (match.agent !== options.boundAgentId) {
    return new Response(JSON.stringify({ error: 'agent not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (match.kind !== 'memory' && match.sessionId !== options.boundSessionId) {
    return Response.json({ error: 'session not found' }, { status: 404 });
  }

  const baseDeps: SessionRouteDeps = {
    eventLog: options.eventLog,
    memory: buildMemoryDeps(options.sql, match.kind === 'memory' ? match.agent : ''),
    cancelTurn: async () => (options.cancelTurn() ? 'cancelled' : 'no_active_turn'),
    // Raw owner, matching what this runtime writes (KuralleAgent passes the request's userId
    // through unscoped) — read and write agree, which is the property that matters most here.
    // It is NOT justified by the instance boundary: the memory arm of matchSessionRoute never
    // compares against boundSessionId, so that argument does not cover this route. Whether a DO
    // instance is genuinely a tenant boundary is an open question, tracked as its own task.
    memoryOwner: (p, requestedUserId) => (p.userId === requestedUserId ? requestedUserId : null),
    abortSignal: options.request.signal,
  };

  switch (match.kind) {
    case 'events': {
      if (options.request.method !== 'GET') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const outcome = await readEvents(baseDeps, match.sessionId, {
        from: url.searchParams.get('from') ?? undefined,
        follow: url.searchParams.get('follow') ?? undefined,
      }, filter);
      if (outcome.ndjson) return ndjsonResponse(outcome.ndjson);
      return Response.json(outcome.body, { status: outcome.status });
    }
    case 'snapshot': {
      if (options.request.method !== 'GET') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const outcome = await readSnapshot(baseDeps, match.sessionId, {
        limit: url.searchParams.get('limit') ?? undefined,
      }, filter);
      return Response.json(outcome.body, { status: outcome.status });
    }
    case 'cancel': {
      if (options.request.method !== 'POST') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const outcome = await cancelSession(baseDeps, match.sessionId);
      return Response.json(outcome.body, { status: outcome.status });
    }
    case 'memory': {
      if (options.request.method !== 'GET') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      if (!principal) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const outcome = await readMemory(
        { ...baseDeps, memory: buildMemoryDeps(options.sql, match.agent) },
        principal,
        match.userId,
      );
      return Response.json(outcome.body, { status: outcome.status });
    }
  }
}
