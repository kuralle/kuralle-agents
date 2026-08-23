import type { StreamPart } from '../types/stream.js';
import { PART_CHANNEL } from '../types/stream.js';

export type StreamEventFilter = 'safe' | 'all' | ((part: StreamPart) => boolean);

export function shouldEmit(part: StreamPart, filter: StreamEventFilter): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'function') return filter(part);
  // log-truncated is internal but must reach clients, or a dropped range looks like nothing happened.
  if (part.type === 'log-truncated') return true;
  // Keyed on PART_CHANNEL, never part.channel: a part must not be able to lie its way past the filter.
  return PART_CHANNEL[part.type] === 'client';
}
