import { randomUUID } from 'node:crypto';
import type {
  LoggedEvent,
  Runtime,
  SessionEventLog,
  SignalDelivery,
  TurnHandle,
  TurnResult,
  UserInputContent,
} from '@kuralle-agents/core';
import type { Cursor, InputResponse, SendOptions, Session, TurnResponse } from './types.js';

function pickRunOptions(sessionId: string, opts?: SendOptions) {
  return {
    sessionId,
    agentId: opts?.agentId,
    userId: opts?.userId,
    abortSignal: opts?.abortSignal,
    idempotencyKey: opts?.idempotencyKey,
    callerInstructions: opts?.callerInstructions,
  };
}

function toSignalDelivery(response: InputResponse): SignalDelivery {
  const name =
    response.decision !== undefined
      ? '__approval'
      : (response.signalName ?? '__signal');
  return {
    signalId: randomUUID(),
    requestId: response.requestId,
    name,
    actor: response.actor ?? { id: 'client', type: 'user' },
    decision: response.decision,
    reason: response.reason,
    payload: response.payload,
  };
}

function createTurnResponse(
  handle: TurnHandle,
  eventLog: SessionEventLog,
  sessionId: string,
  fromIndex: number,
): TurnResponse {
  return {
    async *[Symbol.asyncIterator]() {
      let runId: string | undefined;
      for await (const event of eventLog.follow(sessionId, fromIndex)) {
        if (runId === undefined) {
          runId = event.runId;
        }
        yield event;
        if (event.runId !== runId) {
          continue;
        }
        if (event.part.type === 'done' || event.part.type === 'paused') {
          return;
        }
      }
    },
    result(): Promise<TurnResult> {
      return handle;
    },
  };
}

export class LocalSession implements Session {
  readonly id: string;
  private activeHandle: TurnHandle | null = null;
  private readonly attachStartIndex: number | null;
  private attachStartConsumed = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly eventLog: SessionEventLog,
    sessionId: string,
    cursor?: Cursor,
  ) {
    this.id = sessionId;
    this.attachStartIndex = cursor ? cursor.index + 1 : null;
  }

  async send(message: string | UserInputContent, opts?: SendOptions): Promise<TurnResponse> {
    const fromIndex = (await this.eventLog.tail(this.id)) + 1;
    const handle = this.runtime.run({
      ...pickRunOptions(this.id, opts),
      input: message,
    });
    this.activeHandle = handle;
    return createTurnResponse(handle, this.eventLog, this.id, fromIndex);
  }

  async respond(responses: InputResponse[], opts?: SendOptions): Promise<TurnResponse> {
    if (responses.length === 0) {
      throw new Error('respond() requires at least one InputResponse');
    }
    const fromIndex = (await this.eventLog.tail(this.id)) + 1;
    const handle = this.runtime.run({
      ...pickRunOptions(this.id, opts),
      signalDelivery: toSignalDelivery(responses[0]!),
    });
    this.activeHandle = handle;
    return createTurnResponse(handle, this.eventLog, this.id, fromIndex);
  }

  async cancel(reason?: string): Promise<void> {
    if (this.activeHandle) {
      this.activeHandle.cancel(reason);
      this.activeHandle = null;
      return;
    }
    this.runtime.abortSession(this.id, reason);
  }

  stream(opts?: {
    startIndex?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<LoggedEvent> {
    const session = this;
    return {
      async *[Symbol.asyncIterator]() {
        const start = await session.resolveStreamStart(opts?.startIndex);
        if (opts?.follow) {
          yield* session.eventLog.follow(session.id, start, opts.signal);
          return;
        }
        const batch = await session.eventLog.read(session.id, start);
        for (const event of batch.events) {
          yield event;
        }
      },
    };
  }

  async snapshot(): Promise<{ events: LoggedEvent[]; cursor: Cursor }> {
    const tail = await this.eventLog.tail(this.id);
    const { events } = await this.eventLog.read(this.id, 0);
    return {
      events,
      cursor: { sessionId: this.id, index: tail },
    };
  }

  private async resolveStreamStart(override?: number): Promise<number> {
    if (override !== undefined) {
      return override;
    }
    if (this.attachStartIndex !== null && !this.attachStartConsumed) {
      this.attachStartConsumed = true;
      return this.attachStartIndex;
    }
    return (await this.eventLog.tail(this.id)) + 1;
  }
}
