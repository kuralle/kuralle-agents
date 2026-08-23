import type {
  Cursor,
  InputResponse,
  LoggedEvent,
  SendOptions,
  Session,
  TurnResponse,
} from '@kuralle-agents/client';

export function logged(
  index: number,
  part: LoggedEvent['part'],
  overrides: Partial<Omit<LoggedEvent, 'index' | 'part'>> = {},
): LoggedEvent {
  return {
    index,
    eventId: overrides.eventId ?? `evt-${index}`,
    runId: overrides.runId ?? 'run-1',
    at: overrides.at ?? index * 100,
    part,
    ...overrides,
  };
}

export function userTurnEvent(index: number, text: string): LoggedEvent {
  return logged(index, {
    channel: 'internal',
    type: 'custom',
    payload: { name: 'user-turn', data: { text } },
  });
}

export function assistantTurnEvents(
  indexBase: number,
  text: string,
  sessionId = 'mock-session',
): LoggedEvent[] {
  const id = `a-${indexBase}`;
  return [
    logged(indexBase, { channel: 'client', type: 'text-start', payload: { id } }),
    logged(indexBase + 1, { channel: 'client', type: 'text-delta', payload: { id, delta: text } }),
    logged(indexBase + 2, { channel: 'client', type: 'text-end', payload: { id } }),
    logged(indexBase + 3, { channel: 'client', type: 'done', payload: { sessionId } }),
  ];
}

export interface MockSessionOptions {
  id?: string;
  seed?: LoggedEvent[];
  reply?: (input: string, turn: number) => LoggedEvent[];
  onCancel?: () => void;
  stallAfterDelta?: boolean;
}

export class MockSession implements Session {
  readonly id: string;
  private events: LoggedEvent[];
  private turn = 0;
  private active = false;
  private readonly reply: (input: string, turn: number) => LoggedEvent[];
  private readonly onCancel?: () => void;
  private readonly stallAfterDelta: boolean;

  constructor(options: MockSessionOptions = {}) {
    this.id = options.id ?? 'mock-session';
    this.events = [...(options.seed ?? [])];
    this.reply = options.reply ?? (() => assistantTurnEvents(0, 'ok'));
    this.onCancel = options.onCancel;
    this.stallAfterDelta = options.stallAfterDelta ?? false;
  }

  async snapshot(): Promise<{ events: LoggedEvent[]; cursor: Cursor }> {
    const tail = this.events.at(-1)?.index ?? -1;
    return {
      events: [...this.events],
      cursor: { sessionId: this.id, index: tail },
    };
  }

  async send(message: string | { type: string }, _opts?: SendOptions): Promise<TurnResponse> {
    const input = typeof message === 'string' ? message : '';
    const startIndex = (this.events.at(-1)?.index ?? -1) + 1;
    const scripted = this.reply(input, this.turn++);
    const session = this;

    return {
      async *[Symbol.asyncIterator]() {
        session.active = true;
        let offset = 0;
        for (const template of scripted) {
          if (!session.active) return;
          const event: LoggedEvent = {
            ...template,
            index: startIndex + offset,
            eventId: `evt-${startIndex + offset}`,
          };
          offset += 1;
          session.events.push(event);
          yield event;
          if (session.stallAfterDelta && event.part.type === 'text-delta') {
            while (session.active) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return;
          }
        }
        session.active = false;
      },
      result: async () => ({ text: '', toolResults: [], runId: 'run-1' }),
    };
  }

  async respond(_responses: InputResponse[], _opts?: SendOptions): Promise<TurnResponse> {
    throw new Error('respond() not implemented in MockSession');
  }

  async cancel(_reason?: string): Promise<void> {
    this.active = false;
    this.onCancel?.();
  }

  stream(): AsyncIterable<LoggedEvent> {
    throw new Error('stream() not implemented in MockSession');
  }
}

export function seedFiveTurnHistory(sessionId = 'history-session'): LoggedEvent[] {
  const events: LoggedEvent[] = [];
  let index = 0;
  for (let turn = 1; turn <= 5; turn += 1) {
    events.push(userTurnEvent(index++, `history turn ${turn}`));
    events.push(...assistantTurnEvents(index, `reply ${turn}`, sessionId));
    index += 4;
  }
  return events;
}
