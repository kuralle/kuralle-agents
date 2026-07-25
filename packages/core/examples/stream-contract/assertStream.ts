/**
 * Review-only stream envelope assertions. Imported by the offline + live
 * review harnesses. Every check throws with a precise message on failure.
 *
 * These assertions are the heart of the adversarial review: they prove the
 * reshape is correct on the wire, not merely well-typed.
 */
import { PART_CHANNEL } from '../../src/types/stream.js';
import type { StreamPart } from '../../src/types/stream.js';

export class StreamAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamAssertionError';
  }
}

export function assertEnvelope(part: StreamPart, origin: string): void {
  if (part === null || typeof part !== 'object') {
    throw new StreamAssertionError(`[${origin}] part is not an object: ${JSON.stringify(part)}`);
  }
  if (typeof (part as { channel?: unknown }).channel !== 'string') {
    throw new StreamAssertionError(
      `[${origin}] part missing 'channel' string: ${JSON.stringify(part)}`,
    );
  }
  if (typeof (part as { type?: unknown }).type !== 'string') {
    throw new StreamAssertionError(
      `[${origin}] part missing 'type' string: ${JSON.stringify(part)}`,
    );
  }
  if (part.payload === undefined || part.payload === null || typeof part.payload !== 'object') {
    throw new StreamAssertionError(
      `[${origin}] part missing 'payload' object: ${JSON.stringify(part)}`,
    );
  }
}

/**
 * The single sharpest correctness check: the channel the part self-reports
 * must agree with the authoritative PART_CHANNEL classification for its type.
 * A divergence here is the exact defect class the RFC was written to prevent.
 */
export function assertChannelMatchesMap(part: StreamPart, origin: string): void {
  const declared = PART_CHANNEL[part.type];
  if (declared !== part.channel) {
    throw new StreamAssertionError(
      `[${origin}] channel drift for type='${part.type}': part.channel='${part.channel}' ` +
        `but PART_CHANNEL says '${declared}'`,
    );
  }
}

export interface SeenParts {
  types: Set<string>;
  parts: StreamPart[];
  text: string;
  sessionId?: string;
}

export function makeCollector(): SeenParts {
  return { types: new Set(), parts: [], text: '' };
}

export function record(seen: SeenParts, part: StreamPart, origin: string): void {
  assertEnvelope(part, origin);
  assertChannelMatchesMap(part, origin);
  seen.types.add(part.type);
  seen.parts.push(part);
  if (part.type === 'text-delta') seen.text += part.payload.delta;
  if (part.type === 'done') seen.sessionId = part.payload.sessionId;
}

export function assertHasType(
  seen: SeenParts,
  type: StreamPart['type'],
  origin: string,
): void {
  if (!seen.types.has(type)) {
    throw new StreamAssertionError(
      `[${origin}] expected stream to contain type='${type}'. ` +
        `Seen: ${[...seen.types].sort().join(', ')}`,
    );
  }
}

/** No part should ever carry an 'internal' channel out of a 'safe' filter. */
export function assertNoInternal(parts: { channel: string; type: string }[], origin: string): void {
  const leaked = parts.filter((p) => p.channel === 'internal');
  if (leaked.length > 0) {
    throw new StreamAssertionError(
      `[${origin}] safe filter leaked ${leaked.length} internal-channel part(s): ` +
        leaked.map((p) => p.type).join(', '),
    );
  }
}

export function summarize(label: string, seen: SeenParts): string {
  return `[${label}] types=[${[...seen.types].sort().join(',')}] text="${seen.text.slice(0, 80)}…"`;
}
