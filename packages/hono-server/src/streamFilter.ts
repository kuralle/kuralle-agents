export type StreamEventFilter = 'safe' | 'all' | ((part: { type: string }) => boolean);

const SAFE_EVENT_TYPES = new Set<string>([
  'text-start',
  'text-delta',
  'text-end',
  'text-cancel',
  'text-clear',
  'done',
  'error',
  'suggested-questions',
  'conversation-outcome',
  'knowledge-citation',
  'knowledge-no-results',
  'input',
]);

export function shouldEmit(part: { type: string }, filter: StreamEventFilter): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'function') return filter(part);
  return SAFE_EVENT_TYPES.has(part.type);
}

export function sanitizeForClient(part: { type: string; error?: string }): { type: string; error?: string } {
  if (part.type === 'error') {
    console.error('[Kuralle] Client-facing error suppressed:', part.error);
    return { type: 'error', error: 'An error occurred. Please try again.' };
  }
  return part;
}
