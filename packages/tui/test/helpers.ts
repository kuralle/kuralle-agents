import type {
  Cursor,
  InputResponse,
  LoggedEvent,
  SendOptions,
  Session,
  TurnResponse,
  TurnView,
} from '@kuralle-agents/client';

export type PendingInterrupt = TurnView['pending'][number];

export const sampleApprovalInterrupt: PendingInterrupt = {
  requestId: 'req-approve-1',
  kind: 'approval',
  signalName: 'tool_approval',
  operation: {
    toolCallId: 'call-refund',
    toolName: 'issue_refund',
    args: { orderId: '4471', amount: 42 },
    argsHash: 'abc123',
  },
  display: { title: 'Approve refund', description: 'Refund $42 for order 4471' },
  responseSchema: { type: 'object' },
  deadline: null,
  allowedDecisions: ['approve', 'deny'],
  createdAt: 1_700_000_000_000,
};

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

export function approvalPauseEvents(indexBase: number, interrupt = sampleApprovalInterrupt): LoggedEvent[] {
  return [
    logged(indexBase, { channel: 'client', type: 'text-start', payload: { id: 'a1' } }),
    logged(indexBase + 1, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Confirm?' } }),
    logged(indexBase + 2, {
      channel: 'internal',
      type: 'tool-call',
      payload: {
        toolName: interrupt.operation?.toolName ?? 'tool',
        args: interrupt.operation?.args,
        toolCallId: interrupt.operation?.toolCallId ?? 'call-1',
      },
    }),
    logged(indexBase + 3, {
      channel: 'internal',
      type: 'paused',
      payload: { waitingFor: 'approval', interrupt },
    }),
  ];
}

export function approvalResumeEvents(
  indexBase: number,
  decision: 'approve' | 'deny',
  sessionId = 'mock-session',
): LoggedEvent[] {
  const text = decision === 'approve' ? 'Refund issued.' : 'Refund denied.';
  return [
    logged(indexBase, { channel: 'client', type: 'text-start', payload: { id: 'a2' } }),
    logged(indexBase + 1, { channel: 'client', type: 'text-delta', payload: { id: 'a2', delta: text } }),
    logged(indexBase + 2, { channel: 'client', type: 'text-end', payload: { id: 'a2' } }),
    logged(indexBase + 3, { channel: 'client', type: 'done', payload: { sessionId } }),
  ];
}

export interface MockSessionOptions {
  id?: string;
  seed?: LoggedEvent[];
  reply?: (input: string, turn: number) => LoggedEvent[];
  onRespond?: (responses: InputResponse[], turn: number) => LoggedEvent[];
  onCancel?: () => void;
  stallAfterDelta?: boolean;
}

export class MockSession implements Session {
  readonly id: string;
  private events: LoggedEvent[];
  private turn = 0;
  private active = false;
  private readonly reply: (input: string, turn: number) => LoggedEvent[];
  private readonly onRespond?: (responses: InputResponse[], turn: number) => LoggedEvent[];
  private readonly onCancel?: () => void;
  private readonly stallAfterDelta: boolean;
  private respondTurn = 0;
  lastRespondPayload: InputResponse[] | null = null;

  constructor(options: MockSessionOptions = {}) {
    this.id = options.id ?? 'mock-session';
    this.events = [...(options.seed ?? [])];
    this.reply = options.reply ?? (() => assistantTurnEvents(0, 'ok'));
    this.onRespond = options.onRespond;
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

  async respond(responses: InputResponse[], _opts?: SendOptions): Promise<TurnResponse> {
    this.lastRespondPayload = responses;
    const startIndex = (this.events.at(-1)?.index ?? -1) + 1;
    const decision = responses[0]?.decision ?? 'approve';
    const scripted = this.onRespond
      ? this.onRespond(responses, this.respondTurn++)
      : approvalResumeEvents(startIndex, decision, this.id);
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
        }
        session.active = false;
      },
      result: async () => ({ text: '', toolResults: [], runId: 'run-1' }),
    };
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
