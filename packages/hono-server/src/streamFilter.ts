import { PART_CHANNEL } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';

export type StreamEventFilter = 'safe' | 'all' | ((part: StreamPart) => boolean);

export function shouldEmit(part: StreamPart, filter: StreamEventFilter): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'function') return filter(part);
  return PART_CHANNEL[part.type] === 'client';
}

export function sanitizeForClient(part: StreamPart): StreamPart {
  if (part.type === 'error') {
    console.error('[Kuralle] Client-facing error suppressed:', part.payload.error);
    return {
      ...part,
      payload: { error: 'An error occurred. Please try again.' },
    };
  }
  return part;
}
