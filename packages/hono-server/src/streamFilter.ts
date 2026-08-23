import { PART_CHANNEL } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';

export type StreamEventFilter = 'safe' | 'all' | ((part: StreamPart) => boolean);

export function shouldEmit(part: StreamPart, filter: StreamEventFilter): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'function') return filter(part);
  return PART_CHANNEL[part.type] === 'client';
}
