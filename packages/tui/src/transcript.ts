import { reduce, type Block, type LoggedEvent } from '@kuralle-agents/client';

function userTurnText(event: LoggedEvent): string | null {
  if (event.part.type !== 'custom' || event.part.payload.name !== 'user-turn') return null;
  const data = event.part.payload.data;
  if (typeof data === 'object' && data !== null && 'text' in data) {
    return String((data as { text: unknown }).text);
  }
  return String(data ?? '');
}

function splitTurnSegments(events: LoggedEvent[]): LoggedEvent[][] {
  const segments: LoggedEvent[][] = [];
  let current: LoggedEvent[] = [];
  for (const event of events) {
    if (userTurnText(event) !== null) continue;
    current.push(event);
    if (event.part.type === 'done') {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function blocksFromEvents(events: LoggedEvent[], sessionUsers: Block[] = []): Block[] {
  const loggedUsers: Block[] = [];
  for (const event of events) {
    const text = userTurnText(event);
    if (text !== null) {
      loggedUsers.push({ id: `user-${event.index}`, kind: 'user', text });
    }
  }

  const segments = splitTurnSegments(events);
  const users = [...loggedUsers, ...sessionUsers];
  const blocks: Block[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    if (users[i]) blocks.push(users[i]!);
    blocks.push(...reduce(segments[i]!).blocks);
  }
  for (let i = segments.length; i < users.length; i += 1) {
    blocks.push(users[i]!);
  }
  return blocks;
}

export function nextUserId(seq: number): string {
  return `user-live-${seq}`;
}
