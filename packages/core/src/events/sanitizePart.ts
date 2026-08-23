import type { StreamPart } from '../types/stream.js';

export function sanitizePart(part: StreamPart): StreamPart {
  if (part.type === 'error') {
    console.error('[Kuralle] Client-facing error suppressed:', part.payload.error);
    return {
      ...part,
      payload: { error: 'An error occurred. Please try again.' },
    };
  }
  return part;
}
