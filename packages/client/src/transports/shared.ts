import { randomUUID } from 'node:crypto';
import type { LoggedEvent, StreamPart, TurnResult } from '@kuralle-agents/core';
import type { Auth, Cursor, TurnResponse } from '../types.js';
import { reduce } from '../reduce.js';

export function authHeaders(auth?: Auth): Record<string, string> {
  const headers: Record<string, string> = { ...(auth?.headers ?? {}) };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  return headers;
}

export class EventSequencer {
  private nextIndex: number;
  private readonly runId: string;

  constructor(runId = randomUUID(), startIndex = 0) {
    this.runId = runId;
    this.nextIndex = startIndex;
  }

  logged(part: StreamPart): LoggedEvent {
    const index = this.nextIndex++;
    return {
      index,
      eventId: `client-${this.runId}-${index}`,
      runId: this.runId,
      at: Date.now(),
      part,
    };
  }
}

export function turnResultFromEvents(events: LoggedEvent[], sessionId: string): TurnResult {
  const view = reduce(events);
  const text = view.blocks
    .filter((block) => block.kind === 'assistant')
    .map((block) => block.text)
    .join('');
  const runId = events.find((event) => event.runId)?.runId;
  return { text, toolResults: [], runId, ...(view.usage ? { usage: {
    inputTokens: view.usage.inputTokens ?? 0,
    outputTokens: view.usage.outputTokens ?? 0,
    totalTokens: (view.usage.inputTokens ?? 0) + (view.usage.outputTokens ?? 0),
    cacheReadTokens: view.usage.cacheReadTokens,
    cacheWriteTokens: view.usage.cacheWriteTokens,
    contextTokens: view.usage.contextTokens,
  } } : {}) };
}

export function createTurnResponse(
  source: AsyncIterable<LoggedEvent>,
  sessionId: string,
): TurnResponse {
  const collected: LoggedEvent[] = [];
  let resultPromise: Promise<TurnResult> | undefined;

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        collected.push(event);
        yield event;
      }
      resultPromise = Promise.resolve(turnResultFromEvents(collected, sessionId));
    },
    result(): Promise<TurnResult> {
      if (resultPromise) return resultPromise;
      return (async () => {
        for await (const event of source) {
          collected.push(event);
        }
        return turnResultFromEvents(collected, sessionId);
      })();
    },
  };
}

export async function readNdjsonEvents(response: Response): Promise<LoggedEvent[]> {
  if (!response.body) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: LoggedEvent[] = [];
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let lineBreak = buffer.indexOf('\n');
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).trim();
      buffer = buffer.slice(lineBreak + 1);
      if (line) events.push(JSON.parse(line) as LoggedEvent);
      lineBreak = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) events.push(JSON.parse(tail) as LoggedEvent);
  return events;
}

export async function* readNdjsonEventStream(response: Response): AsyncGenerator<LoggedEvent> {
  const events = await readNdjsonEvents(response);
  for (const event of events) yield event;
}

export async function* followNdjsonEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<LoggedEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body as AsyncIterable<Uint8Array>;
  for await (const chunk of reader) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let lineBreak = buffer.indexOf('\n');
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).trim();
      buffer = buffer.slice(lineBreak + 1);
      if (line) yield JSON.parse(line) as LoggedEvent;
      lineBreak = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as LoggedEvent;
}

export function sessionRouteBase(
  url: string,
  agentName: string,
  sessionId: string,
): string {
  return `${url}/v1/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function resolveAttachStart(cursor?: Cursor): number | null {
  return cursor ? cursor.index : null;
}

export class AttachCursor {
  private readonly startIndex: number | null;
  private consumed = false;

  constructor(cursor?: Cursor) {
    this.startIndex = resolveAttachStart(cursor);
  }

  take(): number | undefined {
    if (this.startIndex === null || this.consumed) return undefined;
    this.consumed = true;
    return this.startIndex;
  }
}
