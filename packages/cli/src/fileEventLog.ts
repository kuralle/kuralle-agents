/**
 * JSONL file-backed SessionEventLog so stream parts survive across separate CLI
 * invocations — the substrate for `--resume`, session history, and attach.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggedEvent, SessionEventLog, StreamPart } from '@kuralle-agents/core';

interface StoredEvent extends LoggedEvent {
  sessionId: string;
}

function serializeOnce(event: StoredEvent): { json: string; bytes: number } | null {
  try {
    const json = JSON.stringify(event);
    if (json === undefined) return null;
    return { json, bytes: Buffer.byteLength(json, 'utf8') };
  } catch {
    return null;
  }
}

function stableEventId(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

function poisonPart(originalType: string): StreamPart {
  return {
    channel: 'internal',
    type: 'custom',
    payload: { name: 'log-poison', data: { originalType, reason: 'unserializable' } },
  };
}

function readStoredEvents(path: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  if (!existsSync(path)) return events;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as StoredEvent;
      if (typeof record.sessionId !== 'string' || typeof record.index !== 'number') continue;
      events.push(record);
    } catch {
      // skip a torn/partial line rather than fail the read
    }
  }
  return events;
}

function tailIndex(events: StoredEvent[], sessionId: string): number {
  let tail = -1;
  for (const event of events) {
    if (event.sessionId === sessionId && event.index > tail) tail = event.index;
  }
  return tail;
}

function toLoggedEvent(event: StoredEvent): LoggedEvent {
  return {
    index: event.index,
    eventId: event.eventId,
    runId: event.runId,
    at: event.at,
    part: event.part,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function fileSessionEventLog(path: string): SessionEventLog {
  let dirReady = false;
  let appendChain = Promise.resolve();

  const ensureDir = (): void => {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
  };

  const commitEvent = (
    sessionId: string,
    index: number,
    runId: string,
    at: number,
    part: StreamPart,
  ): void => {
    const draft: StoredEvent = { sessionId, index, eventId: '', runId, at, part };
    let serialized = serializeOnce(draft);

    if (serialized === null) {
      const poison: StoredEvent = {
        sessionId,
        index,
        eventId: '',
        runId,
        at,
        part: poisonPart(part.type),
      };
      serialized = serializeOnce(poison);
      if (serialized === null) return;
      poison.eventId = stableEventId(serialized.json);
      appendFileSync(path, `${serialized.json}\n`);
      return;
    }

    draft.eventId = stableEventId(serialized.json);
    appendFileSync(path, `${serialized.json}\n`);
  };

  const doAppend = (sessionId: string, parts: StreamPart[], runId: string): void => {
    ensureDir();
    const at = Date.now();
    const events = readStoredEvents(path);
    let nextIndex = tailIndex(events, sessionId) + 1;
    for (const part of parts) {
      commitEvent(sessionId, nextIndex, runId, at, part);
      nextIndex += 1;
    }
  };

  return {
    async append(sessionId: string, parts: StreamPart[], runId: string): Promise<void> {
      appendChain = appendChain.then(
        () => {
          doAppend(sessionId, parts, runId);
        },
        () => {
          doAppend(sessionId, parts, runId);
        },
      );
      await appendChain;
    },

    async read(
      sessionId: string,
      from: number,
      limit = Number.POSITIVE_INFINITY,
    ): Promise<{ events: LoggedEvent[]; next: number }> {
      if (limit <= 0) return { events: [], next: from };

      const matched = readStoredEvents(path)
        .filter((event) => event.sessionId === sessionId && event.index >= from)
        .sort((a, b) => a.index - b.index)
        .slice(0, limit)
        .map(toLoggedEvent);

      if (matched.length === 0) return { events: [], next: from };
      return { events: matched, next: matched[matched.length - 1]!.index + 1 };
    },

    async *follow(sessionId: string, from: number, signal?: AbortSignal): AsyncIterable<LoggedEvent> {
      let cursor = from;
      while (!signal?.aborted) {
        const batch = await this.read(sessionId, cursor, 1);
        if (batch.events.length > 0) {
          yield batch.events[0]!;
          cursor = batch.next;
          continue;
        }
        await sleep(50, signal);
      }
    },

    async tail(sessionId: string): Promise<number> {
      return tailIndex(readStoredEvents(path), sessionId);
    },

    async delete(sessionId: string): Promise<void> {
      if (!existsSync(path)) return;
      const kept = readStoredEvents(path).filter((event) => event.sessionId !== sessionId);
      if (kept.length === 0) {
        writeFileSync(path, '');
        return;
      }
      writeFileSync(path, `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`);
    },
  };
}
