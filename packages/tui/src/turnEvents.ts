import type { LoggedEvent } from '@kuralle-agents/client';

export function turnEventsSince(events: LoggedEvent[], startIndex: number): LoggedEvent[] {
  return events.filter((event) => event.index >= startIndex);
}

export function nextEventIndex(events: LoggedEvent[]): number {
  return (events.at(-1)?.index ?? -1) + 1;
}
