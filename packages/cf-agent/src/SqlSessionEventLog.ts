import { createHash } from 'node:crypto';
import type { LoggedEvent, SessionEventLog } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MIN_MAX_BYTES = 256;
const POISON_MARKER_BYTES = 198;
const FOLLOW_POLL_MS = 250;

export interface SqlSessionEventLogOptions {
  maxEvents?: number;
  maxBytes?: number;
}

interface SessionMeta {
  nextIndex: number;
  bytesUsed: number;
  droppedFrom: number;
  droppedTo: number;
  truncatedAt: number;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function defaultMeta(): SessionMeta {
  return {
    nextIndex: 0,
    bytesUsed: 0,
    droppedFrom: -1,
    droppedTo: -1,
    truncatedAt: 0,
  };
}

function serializeOnce(event: LoggedEvent): { json: string; bytes: number } | null {
  try {
    const json = JSON.stringify(event);
    if (json === undefined) return null;
    return { json, bytes: Buffer.byteLength(json, 'utf8') };
  } catch {
    return null;
  }
}

function poisonPart(originalType: string): StreamPart {
  return {
    channel: 'internal',
    type: 'custom',
    payload: { name: 'log-poison', data: { originalType, reason: 'unserializable' } },
  };
}

function stableEventId(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

function hasDroppedRange(meta: SessionMeta): boolean {
  return meta.droppedFrom >= 0 && meta.droppedTo > meta.droppedFrom;
}

function synthesizeTruncationMarker(meta: SessionMeta, cursor: number): LoggedEvent {
  const fromIndex = meta.droppedFrom;
  const toIndex = meta.droppedTo - 1;
  return {
    index: Math.max(cursor, fromIndex),
    eventId: `truncated:${fromIndex}:${meta.droppedTo}`,
    runId: '',
    at: meta.truncatedAt,
    part: {
      channel: 'internal',
      type: 'log-truncated',
      payload: { fromIndex, toIndex },
    },
  };
}

function nextAfterEvent(meta: SessionMeta, event: LoggedEvent): number {
  if (event.part.type !== 'log-truncated') {
    return event.index + 1;
  }
  const { toIndex } = event.part.payload;
  return event.index < toIndex ? meta.droppedTo : event.index + 1;
}

function parsePart(value: unknown): StreamPart {
  if (typeof value === 'string') return JSON.parse(value) as StreamPart;
  return value as StreamPart;
}

function rowToEvent(row: Record<string, unknown>): LoggedEvent {
  return {
    index: asNumber(row.idx),
    eventId: String(row.event_id),
    runId: String(row.run_id),
    at: asNumber(row.at),
    part: parsePart(row.part),
  };
}

export class SqlSessionEventLog implements SessionEventLog {
  private initialized = false;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(
    private readonly sql: SqlExecutor,
    options?: SqlSessionEventLogOptions,
  ) {
    const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (maxEvents < 1) {
      throw new RangeError('SqlSessionEventLog: maxEvents must be >= 1');
    }
    if (maxBytes < MIN_MAX_BYTES) {
      throw new RangeError(`SqlSessionEventLog: maxBytes must be >= ${MIN_MAX_BYTES}`);
    }
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.ensureTables();
  }

  async append(sessionId: string, parts: StreamPart[], runId: string): Promise<void> {
    const previous = this.appendChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(
      () => {
        this.doAppend(sessionId, parts, runId);
      },
      () => {
        this.doAppend(sessionId, parts, runId);
      },
    );
    this.appendChains.set(sessionId, next);
    await next;
  }

  async read(
    sessionId: string,
    from: number,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<{ events: LoggedEvent[]; next: number }> {
    if (limit <= 0) {
      return { events: [], next: from };
    }
    const meta = this.loadMeta(sessionId);
    if (!this.hasAnyEvents(sessionId, meta) && !hasDroppedRange(meta)) {
      return { events: [], next: from };
    }
    return this.readFromMeta(sessionId, meta, from, limit);
  }

  async *follow(sessionId: string, from: number, signal?: AbortSignal): AsyncIterable<LoggedEvent> {
    let cursor = from;
    while (!signal?.aborted) {
      const batch = await this.read(sessionId, cursor, 1);
      if (batch.events.length > 0) {
        yield batch.events[0]!;
        cursor = batch.next;
        continue;
      }
      // Poll SQLite instead of in-memory waiters: waiters die with the DO
      // isolate, but the log in SQLite is authoritative across hibernation.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, FOLLOW_POLL_MS);
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort);
      });
    }
  }

  async tail(sessionId: string): Promise<number> {
    const meta = this.loadMeta(sessionId);
    if (meta.nextIndex === 0) {
      return -1;
    }
    return meta.nextIndex - 1;
  }

  async delete(sessionId: string): Promise<void> {
    this.ensureTables();
    this.sql`DELETE FROM session_events WHERE session_id = ${sessionId}`;
    this.sql`DELETE FROM session_event_meta WHERE session_id = ${sessionId}`;
    this.appendChains.delete(sessionId);
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        part TEXT NOT NULL,
        event_bytes INTEGER NOT NULL,
        PRIMARY KEY (session_id, idx)
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS session_events_session_idx
      ON session_events (session_id, idx)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS session_event_meta (
        session_id TEXT PRIMARY KEY,
        next_index INTEGER NOT NULL,
        bytes_used INTEGER NOT NULL,
        dropped_from INTEGER NOT NULL,
        dropped_to INTEGER NOT NULL,
        truncated_at INTEGER NOT NULL
      )
    `;
    this.initialized = true;
  }

  private hasAnyEvents(sessionId: string, meta: SessionMeta): boolean {
    if (meta.nextIndex > 0) return true;
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM session_events WHERE session_id = ${sessionId}
    `;
    return asNumber(rows[0]?.n ?? 0) > 0;
  }

  private loadMeta(sessionId: string): SessionMeta {
    this.ensureTables();
    const rows = this.sql<Record<string, unknown>>`
      SELECT next_index, bytes_used, dropped_from, dropped_to, truncated_at
      FROM session_event_meta WHERE session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) return defaultMeta();
    return {
      nextIndex: asNumber(row.next_index),
      bytesUsed: asNumber(row.bytes_used),
      droppedFrom: asNumber(row.dropped_from),
      droppedTo: asNumber(row.dropped_to),
      truncatedAt: asNumber(row.truncated_at),
    };
  }

  private saveMeta(sessionId: string, meta: SessionMeta): void {
    this.sql`
      INSERT INTO session_event_meta (
        session_id, next_index, bytes_used, dropped_from, dropped_to, truncated_at
      ) VALUES (
        ${sessionId}, ${meta.nextIndex}, ${meta.bytesUsed},
        ${meta.droppedFrom}, ${meta.droppedTo}, ${meta.truncatedAt}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        next_index = excluded.next_index,
        bytes_used = excluded.bytes_used,
        dropped_from = excluded.dropped_from,
        dropped_to = excluded.dropped_to,
        truncated_at = excluded.truncated_at
    `;
  }

  private fetchEventAtOrAfter(sessionId: string, from: number): LoggedEvent | null {
    const rows = this.sql<Record<string, unknown>>`
      SELECT idx, event_id, run_id, at, part
      FROM session_events
      WHERE session_id = ${sessionId} AND idx >= ${from}
      ORDER BY idx ASC
      LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToEvent(row) : null;
  }

  private readFromMeta(
    sessionId: string,
    meta: SessionMeta,
    from: number,
    limit: number,
  ): { events: LoggedEvent[]; next: number } {
    const events: LoggedEvent[] = [];
    let cursor = from;

    while (events.length < limit) {
      if (hasDroppedRange(meta) && cursor < meta.droppedTo) {
        const marker = synthesizeTruncationMarker(meta, cursor);
        events.push(marker);
        cursor = nextAfterEvent(meta, marker);
        continue;
      }

      const event = this.fetchEventAtOrAfter(sessionId, cursor);
      if (!event) {
        break;
      }
      if (event.index > cursor) {
        break;
      }

      events.push(event);
      cursor = event.index + 1;
    }

    if (events.length === 0) {
      return { events: [], next: from };
    }

    const last = events[events.length - 1]!;
    return { events, next: nextAfterEvent(meta, last) };
  }

  private doAppend(sessionId: string, parts: StreamPart[], runId: string): void {
    const meta = this.loadMeta(sessionId);
    const at = Date.now();
    for (const part of parts) {
      this.commitEvent(sessionId, meta, runId, at, part);
    }
    this.enforceCeiling(sessionId, meta);
    this.saveMeta(sessionId, meta);
  }

  private commitEvent(
    sessionId: string,
    meta: SessionMeta,
    runId: string,
    at: number,
    part: StreamPart,
  ): void {
    const index = meta.nextIndex;
    const draft: LoggedEvent = { index, eventId: '', runId, at, part };
    let serialized = serializeOnce(draft);

    if (serialized === null) {
      const poison: LoggedEvent = { index, eventId: '', runId, at, part: poisonPart(part.type) };
      serialized = serializeOnce(poison);
      if (serialized === null) {
        meta.nextIndex += 1;
        return;
      }
      poison.eventId = stableEventId(serialized.json);
      this.storeEvent(sessionId, meta, poison, serialized.bytes);
      return;
    }

    draft.eventId = stableEventId(serialized.json);
    this.storeEvent(sessionId, meta, draft, serialized.bytes);
  }

  private storeEvent(
    sessionId: string,
    meta: SessionMeta,
    event: LoggedEvent,
    bytes: number,
  ): void {
    this.sql`
      INSERT INTO session_events (
        session_id, idx, event_id, run_id, at, part, event_bytes
      ) VALUES (
        ${sessionId}, ${event.index}, ${event.eventId}, ${event.runId},
        ${event.at}, ${JSON.stringify(event.part)}, ${bytes}
      )
    `;
    meta.nextIndex += 1;
    meta.bytesUsed += bytes;
  }

  private enforceCeiling(sessionId: string, meta: SessionMeta): void {
    const targetCount = Math.floor(this.maxEvents * 0.9);

    while (true) {
      const countRows = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM session_events WHERE session_id = ${sessionId}
      `;
      const count = asNumber(countRows[0]?.n ?? 0);
      if (count <= this.maxEvents && meta.bytesUsed <= this.maxBytes) {
        return;
      }

      let removedCount = 0;
      while (count - removedCount > targetCount || meta.bytesUsed > this.maxBytes) {
        const oldest = this.sql<Record<string, unknown>>`
          SELECT idx, event_bytes FROM session_events
          WHERE session_id = ${sessionId}
          ORDER BY idx ASC
          LIMIT 1
        `;
        const row = oldest[0];
        if (!row) break;

        const removedIndex = asNumber(row.idx);
        const removedBytes = asNumber(row.event_bytes);
        this.sql`DELETE FROM session_events WHERE session_id = ${sessionId} AND idx = ${removedIndex}`;
        removedCount += 1;
        meta.bytesUsed -= removedBytes;

        if (meta.droppedFrom < 0) {
          meta.droppedFrom = removedIndex;
        }
        meta.droppedTo = Math.max(meta.droppedTo, removedIndex + 1);
      }

      if (removedCount === 0) {
        throw new Error(
          'SqlSessionEventLog: enforceCeiling made no progress — a single retained event may exceed maxBytes',
        );
      }

      meta.truncatedAt = Date.now();
    }
  }
}

export { POISON_MARKER_BYTES };
