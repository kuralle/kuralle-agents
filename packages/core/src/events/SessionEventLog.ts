import { createHash } from 'node:crypto';
import type { StreamPart } from '../types/stream.js';

export interface LoggedEvent {
  index: number;
  eventId: string;
  runId: string;
  at: number;
  part: StreamPart;
}

/** Durable session event log — the keystone interface backend authors implement against. */
export interface SessionEventLog {
  /**
   * Append already-scrubbed parts for a session. At-least-once: a durable backend recovering
   * after restart may re-append; consumers dedupe on `eventId`, so ids must be derived from
   * stable content, not from a counter. Backends must not re-scrub.
   */
  append(sessionId: string, parts: StreamPart[], runId: string): Promise<void>;
  /**
   * Read events from an absolute `from` index. Over a truncated range returns a synthesized
   * `log-truncated` marker rather than silently fewer events. Real events keep their storage
   * index; the marker is derived from session drop counters and surfaced at
   * `max(from, droppedFrom)` so a reader's index sequence is always increasing.
   */
  read(sessionId: string, from: number, limit?: number): Promise<{ events: LoggedEvent[]; next: number }>;
  /**
   * Stream every retained event at or after `from`, in strictly increasing index order, exactly
   * once. Synthesizes the same `log-truncated` marker as `read` when `from` falls in a dropped
   * range; use `read` for catch-up over dropped ranges.
   */
  follow(sessionId: string, from: number, signal?: AbortSignal): AsyncIterable<LoggedEvent>;
  /** Highest assigned index, or -1 when the session has no events. */
  tail(sessionId: string): Promise<number>;
  /** Remove all retained state for a session. */
  delete(sessionId: string): Promise<void>;
}

const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Floor for maxBytes — must fit the largest serialised event we can commit (poison marker). */
const MIN_MAX_BYTES = 256;
const POISON_MARKER_BYTES = 198;

export interface MemorySessionEventLogOptions {
  maxEvents?: number;
  maxBytes?: number;
}

interface SessionState {
  events: LoggedEvent[];
  eventBytes: Map<number, number>;
  nextIndex: number;
  bytesUsed: number;
  droppedFrom: number;
  droppedTo: number;
  truncatedAt: number;
  appendChain: Promise<void>;
  waiters: Array<(event: LoggedEvent | null) => void>;
}

// One serialization decides all three questions — serializable, how big, what id. Three separate
// JSON.stringify calls also let a payload with a stateful toJSON pass the first and throw on a later one.
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

function findFirstAtOrAfter(state: SessionState, from: number): number {
  let lo = 0;
  let hi = state.events.length - 1;
  let result = state.events.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.events[mid]!.index >= from) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

function hasDroppedRange(state: SessionState): boolean {
  return state.droppedFrom >= 0 && state.droppedTo > state.droppedFrom;
}

function synthesizeTruncationMarker(state: SessionState, cursor: number): LoggedEvent {
  const fromIndex = state.droppedFrom;
  const toIndex = state.droppedTo - 1;
  return {
    index: Math.max(cursor, fromIndex),
    eventId: `truncated:${fromIndex}:${state.droppedTo}`,
    runId: '',
    at: state.truncatedAt,
    part: {
      channel: 'internal',
      type: 'log-truncated',
      payload: { fromIndex, toIndex },
    },
  };
}

function nextAfterEvent(state: SessionState, event: LoggedEvent): number {
  if (event.part.type !== 'log-truncated') {
    return event.index + 1;
  }
  const { toIndex } = event.part.payload;
  return event.index < toIndex ? state.droppedTo : event.index + 1;
}

function readFromState(
  state: SessionState,
  from: number,
  limit: number,
): { events: LoggedEvent[]; next: number } {
  const events: LoggedEvent[] = [];
  let cursor = from;

  while (events.length < limit) {
    if (hasDroppedRange(state) && cursor < state.droppedTo) {
      const marker = synthesizeTruncationMarker(state, cursor);
      events.push(marker);
      cursor = nextAfterEvent(state, marker);
      continue;
    }

    const pos = findFirstAtOrAfter(state, cursor);
    if (pos >= state.events.length) {
      break;
    }

    const event = state.events[pos]!;
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
  return { events, next: nextAfterEvent(state, last) };
}

export class MemorySessionEventLog implements SessionEventLog {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(options?: MemorySessionEventLogOptions) {
    const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (maxEvents < 1) {
      throw new RangeError('MemorySessionEventLog: maxEvents must be >= 1');
    }
    if (maxBytes < MIN_MAX_BYTES) {
      throw new RangeError(`MemorySessionEventLog: maxBytes must be >= ${MIN_MAX_BYTES}`);
    }
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
  }

  private getSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        events: [],
        eventBytes: new Map(),
        nextIndex: 0,
        bytesUsed: 0,
        droppedFrom: -1,
        droppedTo: -1,
        truncatedAt: 0,
        appendChain: Promise.resolve(),
        waiters: [],
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async append(sessionId: string, parts: StreamPart[], runId: string): Promise<void> {
    const state = this.getSession(sessionId);
    state.appendChain = state.appendChain.then(
      () => {
        this.doAppend(state, parts, runId);
      },
      () => {
        this.doAppend(state, parts, runId);
      },
    );
    await state.appendChain;
  }

  private doAppend(state: SessionState, parts: StreamPart[], runId: string): void {
    const at = Date.now();
    for (const part of parts) {
      this.commitEvent(state, runId, at, part);
    }
    this.enforceCeiling(state);
  }

  private commitEvent(state: SessionState, runId: string, at: number, part: StreamPart): void {
    const index = state.nextIndex;
    const draft: LoggedEvent = { index, eventId: '', runId, at, part };
    let serialized = serializeOnce(draft);

    if (serialized === null) {
      const poison: LoggedEvent = { index, eventId: '', runId, at, part: poisonPart(part.type) };
      serialized = serializeOnce(poison);
      if (serialized === null) {
        // A poison marker that cannot serialise would wedge the log; drop the index rather than throw.
        state.nextIndex += 1;
        return;
      }
      poison.eventId = stableEventId(serialized.json);
      this.store(state, poison, serialized.bytes);
      return;
    }

    draft.eventId = stableEventId(serialized.json);
    this.store(state, draft, serialized.bytes);
  }

  private store(state: SessionState, event: LoggedEvent, bytes: number): void {
    state.nextIndex += 1;
    state.bytesUsed += bytes;
    state.eventBytes.set(event.index, bytes);
    state.events.push(event);
    this.wakeWaiters(state, event);
  }

  private enforceCeiling(state: SessionState): void {
    // Batching the sweep to 90% keeps markers to a small fraction of retained records at real
    // ceilings, but floors to 0 below 10 — so maxEvents: 1 meant "keep one" and delivered "keep
    // none, usually". Everything dropped was still correctly marked; the count was just a lie.
    const targetCount = Math.max(1, Math.floor(this.maxEvents * 0.9));

    while (state.events.length > this.maxEvents || state.bytesUsed > this.maxBytes) {
      let removedCount = 0;

      while (state.events.length > 0) {
        if (state.events.length <= targetCount && state.bytesUsed <= this.maxBytes) {
          break;
        }

        const removed = state.events.shift()!;
        removedCount += 1;
        state.bytesUsed -= state.eventBytes.get(removed.index) ?? 0;
        state.eventBytes.delete(removed.index);

        if (state.droppedFrom < 0) {
          state.droppedFrom = removed.index;
        }
        state.droppedTo = Math.max(state.droppedTo, removed.index + 1);
      }

      if (removedCount === 0) {
        throw new Error(
          'MemorySessionEventLog: enforceCeiling made no progress — a single retained event may exceed maxBytes',
        );
      }

      state.truncatedAt = Date.now();
    }
  }

  private wakeWaiters(state: SessionState, event: LoggedEvent): void {
    for (const wake of state.waiters.splice(0)) {
      wake(event);
    }
  }

  async read(
    sessionId: string,
    from: number,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<{ events: LoggedEvent[]; next: number }> {
    if (limit <= 0) {
      return { events: [], next: from };
    }

    const state = this.sessions.get(sessionId);
    if (!state) {
      return { events: [], next: from };
    }
    if (state.events.length === 0 && !hasDroppedRange(state)) {
      return { events: [], next: from };
    }

    return readFromState(state, from, limit);
  }

  async *follow(sessionId: string, from: number, signal?: AbortSignal): AsyncIterable<LoggedEvent> {
    let cursor = from;

    while (!signal?.aborted) {
      const state = this.getSession(sessionId);
      const batch = readFromState(state, cursor, 1);

      if (batch.events.length > 0) {
        yield batch.events[0]!;
        cursor = batch.next;
        continue;
      }

      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const waiter = (_event: LoggedEvent | null) => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          signal?.removeEventListener('abort', onAbort);
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        state.waiters.push(waiter);
      });
    }
  }

  async tail(sessionId: string): Promise<number> {
    const state = this.sessions.get(sessionId);
    if (!state || state.nextIndex === 0) {
      return -1;
    }
    return state.nextIndex - 1;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

export { MIN_MAX_BYTES, POISON_MARKER_BYTES };
