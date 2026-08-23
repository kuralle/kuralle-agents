import type { LoggedEvent, SessionEventLog } from './SessionEventLog.js';
import { sanitizePart } from './sanitizePart.js';
import { shouldEmit, type StreamEventFilter } from './shouldEmit.js';
import { scrubSecrets } from './scrubSecrets.js';
import { scanMemoryWrite } from '../memory/blocks/safetyScanner.js';

export interface SessionRouteDeps {
  eventLog: SessionEventLog;
  memory: {
    readBlocks(owner: string): Promise<Array<{ key: string; scope: string; content: string; charLimit: number }>>;
    readExtracted(owner: string): Promise<Array<{ slug: string; scope: string; value: unknown; updatedAt: string }>>;
  };
  cancelTurn(sessionId: string, reason?: string): Promise<'cancelled' | 'no_active_turn'>;
  /**
   * Owner key for a memory read, or null to deny (403). Return the SAME key the runtime writes
   * memory under — a transport that returns a differently-scoped key reads a keyspace nothing
   * writes and silently returns empty. Tenancy is enforced by returning null, not by partitioning
   * the key.
   */
  memoryOwner(principal: { tenantId: string; userId: string }, requestedUserId: string): string | null;
  /** Set by the transport per request when streaming with follow=true. */
  abortSignal?: AbortSignal;
}

export interface RouteOutcome {
  status: number;
  body?: unknown;
  ndjson?: AsyncIterable<LoggedEvent>;
}

export interface SessionEventsQuery {
  from?: string;
  follow?: string;
}

export interface SessionSnapshotQuery {
  limit?: string;
}

const SNAPSHOT_LIMIT_DEFAULT = 100;
const SNAPSHOT_LIMIT_MAX = 1000;

function parseFromIndex(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return SNAPSHOT_LIMIT_DEFAULT;
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, SNAPSHOT_LIMIT_MAX);
}

function parseFollow(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

function filterLoggedEvent(event: LoggedEvent, filter: StreamEventFilter): LoggedEvent | null {
  if (!shouldEmit(event.part, filter)) return null;
  return {
    ...event,
    part: sanitizePart(event.part),
  };
}

function scrubExtractedValue(value: unknown): unknown {
  const scrubbed = scrubSecrets({
    channel: 'internal',
    type: 'extraction',
    payload: { slug: 'memory-export', value, changed: false },
  });
  if (scrubbed.type === 'extraction') {
    return scrubbed.payload.value;
  }
  return value;
}

function gateMemoryContent(content: string): string {
  return scanMemoryWrite(content).safe ? content : '';
}

async function* boundedEventFollow(
  eventLog: SessionEventLog,
  sessionId: string,
  from: number,
  endIndex: number,
  filter: StreamEventFilter,
): AsyncGenerator<LoggedEvent> {
  let cursor = from;
  while (endIndex >= 0 && cursor <= endIndex) {
    const { events, next } = await eventLog.read(sessionId, cursor);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.index > endIndex) return;
      const filtered = filterLoggedEvent(event, filter);
      if (filtered) yield filtered;
    }
    if (next <= cursor) break;
    cursor = next;
  }
}

async function readTailSnapshot(
  eventLog: SessionEventLog,
  sessionId: string,
  limit: number,
  filter: StreamEventFilter,
): Promise<{ events: LoggedEvent[]; cursorIndex: number }> {
  const tail = await eventLog.tail(sessionId);
  if (tail < 0) {
    return { events: [], cursorIndex: 0 };
  }

  const visible: LoggedEvent[] = [];
  for (let index = tail; index >= 0 && visible.length < limit; index -= 1) {
    const { events } = await eventLog.read(sessionId, index, 1);
    if (events.length === 0) continue;
    const filtered = filterLoggedEvent(events[0]!, filter);
    if (filtered) visible.unshift(filtered);
  }

  return { events: visible, cursorIndex: tail + 1 };
}

export async function readEvents(
  deps: SessionRouteDeps,
  sessionId: string,
  query: SessionEventsQuery,
  filter: StreamEventFilter,
): Promise<RouteOutcome> {
  const fromParsed = parseFromIndex(query.from);
  if (fromParsed === null) {
    return { status: 400, body: { error: 'from must be a non-negative integer' } };
  }
  const from = fromParsed;

  const follow = parseFollow(query.follow);
  if (!follow) {
    const tailAtOpen = await deps.eventLog.tail(sessionId);
    return {
      status: 200,
      ndjson: boundedEventFollow(deps.eventLog, sessionId, from, tailAtOpen, filter),
    };
  }

  async function* followFiltered(): AsyncGenerator<LoggedEvent> {
    for await (const event of deps.eventLog.follow(sessionId, from, deps.abortSignal)) {
      const filtered = filterLoggedEvent(event, filter);
      if (filtered) yield filtered;
    }
  }

  return { status: 200, ndjson: followFiltered() };
}

export async function readSnapshot(
  deps: SessionRouteDeps,
  sessionId: string,
  query: SessionSnapshotQuery,
  filter: StreamEventFilter,
  rawSessionId?: string,
): Promise<RouteOutcome> {
  const limit = parseLimit(query.limit);
  if (limit === null) {
    return { status: 400, body: { error: 'limit must be a positive integer' } };
  }

  const { events, cursorIndex } = await readTailSnapshot(deps.eventLog, sessionId, limit, filter);
  return {
    status: 200,
    body: {
      events,
      cursor: { sessionId: rawSessionId ?? sessionId, index: cursorIndex },
    },
  };
}

export async function cancelSession(
  deps: SessionRouteDeps,
  sessionId: string,
): Promise<RouteOutcome> {
  const status = await deps.cancelTurn(sessionId);
  return { status: 200, body: { status } };
}

export async function readMemory(
  deps: SessionRouteDeps,
  principal: { tenantId: string; userId: string },
  requestedUserId: string,
): Promise<RouteOutcome> {
  const owner = deps.memoryOwner(principal, requestedUserId);
  if (owner === null) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const rawBlocks = await deps.memory.readBlocks(owner);
  const blocks = rawBlocks.map((block) => {
    const content = gateMemoryContent(block.content);
    return {
      key: block.key,
      scope: block.scope,
      chars: content.length,
      limit: block.charLimit,
      content,
    };
  });

  const extracted = (await deps.memory.readExtracted(owner)).map((entry) => ({
    slug: entry.slug,
    scope: entry.scope,
    value: scrubExtractedValue(entry.value),
    updatedAt: entry.updatedAt,
  }));

  return { status: 200, body: { blocks, extracted } };
}

/** Exported for unit tests that assert query parsing semantics. */
export const sessionRouteParsing = {
  parseFromIndex,
  parseLimit,
  parseFollow,
};
