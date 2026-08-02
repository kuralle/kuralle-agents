import { jsonSchema, parseJsonEventStream } from 'ai';
import type { StreamPart } from '../types/stream.js';

/**
 * One `StreamPart` sequence covering every variant `harnessToUIMessageStream`
 * maps, so three independently-written serialisers can be compared against a
 * single input.
 *
 * Scope note: only seven variants carry `channel: 'client'` at the type level
 * (`text-*`, `conversation-outcome`, `error`, `done`). The rest are `internal`
 * and reach a browser only under `streamFilter: 'all'` — but the canonical
 * adapter maps them, so a serialiser that drops them is still divergent. The
 * fixture therefore follows the adapter's switch, not the channel tag.
 *
 * `error` is deliberately last: the adapter throws `ClientStreamError` on it,
 * which terminates the stream. Placing it earlier would truncate everything
 * after it and hide the very drift this fixture exists to expose.
 */
export const ALL_CLIENT_STREAM_PARTS: StreamPart[] = [
  { channel: 'client', type: 'text-start', payload: { id: 't1' } },
  { channel: 'client', type: 'text-delta', payload: { id: 't1', delta: 'Hello' } },
  { channel: 'client', type: 'text-end', payload: { id: 't1' } },
  { channel: 'client', type: 'text-cancel', payload: { id: 't2', reason: 'superseded' } },
  {
    channel: 'internal',
    type: 'tool-call',
    payload: { toolName: 'lookup_order', args: { id: 'KX-4417' }, toolCallId: 'call-1' },
  },
  {
    channel: 'internal',
    type: 'tool-result',
    payload: { toolName: 'lookup_order', result: { status: 'shipped' }, toolCallId: 'call-1' },
  },
  { channel: 'internal', type: 'node-enter', payload: { nodeName: 'collect' } },
  { channel: 'internal', type: 'node-exit', payload: { nodeName: 'collect' } },
  { channel: 'internal', type: 'flow-enter', payload: { flow: 'checkout' } },
  { channel: 'internal', type: 'flow-transition', payload: { from: 'collect', to: 'confirm' } },
  { channel: 'internal', type: 'flow-end', payload: { flow: 'checkout', reason: 'completed' } },
  { channel: 'internal', type: 'handoff', payload: { targetAgent: 'billing', reason: 'refund' } },
  {
    channel: 'internal',
    type: 'interactive',
    payload: { nodeId: 'approve-1', prompt: 'Approve refund?', options: ['yes', 'no'] },
  },
  {
    channel: 'internal',
    type: 'safety-blocked',
    payload: {
      moderator: 'default',
      rationale: 'contains PII',
      userFacingMessage: 'I cannot help with that.',
    },
  },
  {
    channel: 'internal',
    type: 'pipeline-validation-block',
    payload: { rationale: 'ungrounded claim', userFacingMessage: 'Let me check that.' },
  },
  { channel: 'client', type: 'conversation-outcome', payload: { outcome: 'resolved' } },
  { channel: 'internal', type: 'interrupted', payload: { reason: 'user barge-in' } },
  {
    channel: 'internal',
    type: 'paused',
    payload: { waitingFor: 'approval', interrupt: { requestId: 'req-1' } },
  },
  { channel: 'internal', type: 'custom', payload: { name: 'metric', data: { latencyMs: 42 } } },
  { channel: 'internal', type: 'turn-end', payload: {} },
  { channel: 'client', type: 'done', payload: { sessionId: 's1' } },
  { channel: 'client', type: 'error', payload: { error: 'upstream exploded' } },
] as StreamPart[];

/** Four adapter cases mint a random `id`; normalise so frames compare stably. */
const VOLATILE_ID_TYPES = new Set([
  'data-kuralle-handoff',
  'data-kuralle-safety',
  'data-kuralle-outcome',
]);

/**
 * Drains an SSE `ReadableStream` into parsed frame objects.
 *
 * The SSE decoding is the AI SDK's `parseJsonEventStream` rather than a
 * hand-rolled splitter — it already handles chunk boundaries, the `[DONE]`
 * sentinel, and malformed frames, and it is the same parser the SDK's own
 * clients use, so the test decodes the wire exactly as a real consumer does.
 *
 * Frames are compared whole rather than by `type` alone: the divergences this
 * exists to catch include a missing `id` on text frames and differently-named
 * `data-*` parts, both of which a type-only comparison would wave through.
 */
export async function drainSSEFrames(
  stream: ReadableStream,
): Promise<Array<Record<string, unknown>>> {
  const parsed = parseJsonEventStream<Record<string, unknown>>({
    stream: stream as ReadableStream<Uint8Array>,
    schema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
  });

  const frames: Array<Record<string, unknown>> = [];
  const reader = parsed.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value.success) continue;
    const frame = value.value;
    frames.push(
      typeof frame.id === 'string' && VOLATILE_ID_TYPES.has(String(frame.type))
        ? { ...frame, id: '<generated>' }
        : frame,
    );
  }
  return frames;
}

/** Wraps a plain array as the `AsyncIterable<StreamPart>` the adapters consume. */
export async function* asStreamPartSource(
  parts: readonly StreamPart[] = ALL_CLIENT_STREAM_PARTS,
): AsyncGenerator<StreamPart> {
  for (const part of parts) yield part;
}
