import { PART_CHANNEL, type StreamPart } from '@kuralle-agents/core';

interface WireEvent {
  type?: string;
  channel?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

function isStreamPart(value: unknown): value is StreamPart {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; payload?: unknown; channel?: unknown };
  return typeof candidate.type === 'string'
    && candidate.payload !== undefined
    && typeof candidate.channel === 'string';
}

function partFromWire(type: string, payload: Record<string, unknown>): StreamPart | undefined {
  if (type === 'text-delta') {
    const delta = typeof payload.delta === 'string'
      ? payload.delta
      : typeof payload.text === 'string'
        ? payload.text
        : '';
    const id = typeof payload.id === 'string' ? payload.id : 'default';
    return { channel: 'client', type: 'text-delta', payload: { id, delta } };
  }
  if (!(type in PART_CHANNEL)) return undefined;
  const channel = PART_CHANNEL[type as StreamPart['type']];
  return { channel, type, payload } as StreamPart;
}

/**
 * The fields of an AI SDK chunk, which carries them flat — `{ type, id, delta }` — where a Kuralle
 * part nests them under `payload`. Lifting all of them keeps `id`, which `reduce()` keys assistant
 * blocks on. Copying `delta` alone collapsed every block onto 'default', so a turn that spoke on
 * either side of a tool call rendered as a single block.
 */
function flatChunkFields(chunk: WireEvent): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(chunk)) {
    if (key !== 'type' && key !== 'channel') fields[key] = value;
  }
  return fields;
}

function eventFromData(data: string): StreamPart | undefined {
  try {
    const parsed = JSON.parse(data) as WireEvent;
    if (isStreamPart(parsed)) return parsed;
    if (typeof parsed.type !== 'string') return undefined;
    return partFromWire(parsed.type, parsed.payload ?? flatChunkFields(parsed));
  } catch {
    return undefined;
  }
}

function eventFromSseBlock(block: string, data: string): StreamPart | undefined {
  const direct = eventFromData(data);
  if (direct) return direct;
  const event = block.split('\n')
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  if (!event) return undefined;
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    return partFromWire(event, payload);
  } catch {
    return undefined;
  }
}

export function consumeSse(
  source: string,
  state: { buffer: string },
  onPart: (part: StreamPart) => void,
): void {
  state.buffer += source.replace(/\r\n/g, '\n');
  let boundary = state.buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const block = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') {
      const part = eventFromSseBlock(block, data);
      if (part) onPart(part);
    }
    boundary = state.buffer.indexOf('\n\n');
  }
}

/** Cloudflare's native Agents socket carries one AI SDK data-stream JSON part per
 * response frame. Older adapters may wrap the same parts as SSE, so accept both. */
export function consumeCloudflareBody(
  source: string,
  sseState: { buffer: string },
  onPart: (part: StreamPart) => void,
): void {
  const part = eventFromData(source);
  if (!part) {
    consumeSse(source, sseState, onPart);
    return;
  }
  onPart(part);
}

export async function* partsFromSseBody(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
  const state = { buffer: '' };
  const queue: StreamPart[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let error: Error | undefined;

  const onPart = (part: StreamPart) => {
    queue.push(part);
    notify?.();
  };

  const pump = (async () => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of body) {
        consumeSse(decoder.decode(chunk, { stream: true }), state, onPart);
      }
      consumeSse(`${decoder.decode()}\n\n`, state, onPart);
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      done = true;
      notify?.();
    }
  })();

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
    notify = undefined;
    if (error) throw error;
  }

  await pump;
}

export function parseJsonTurnResponse(data: {
  sessionId?: string;
  response?: string;
  error?: string;
}): StreamPart[] {
  if (data.error && !data.response) throw new Error(data.error);
  const text = data.response || '';
  const id = 'json-turn';
  const parts: StreamPart[] = [];
  if (text) {
    parts.push({ channel: 'client', type: 'text-start', payload: { id } });
    parts.push({ channel: 'client', type: 'text-delta', payload: { id, delta: text } });
    parts.push({ channel: 'client', type: 'text-end', payload: { id } });
  }
  return parts;
}

export function flushSseBuffer(
  state: { buffer: string },
  onPart: (part: StreamPart) => void,
): void {
  consumeSse('\n\n', state, onPart);
}

export { eventFromData, eventFromSseBlock };
