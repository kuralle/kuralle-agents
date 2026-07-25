import { createUIMessageStreamResponse } from 'ai';
import { harnessToUIMessageStream } from '../ai-sdk/uiMessageStream.js';
import type { StreamPart, TurnHandle } from '../types/stream.js';

export interface EventBus {
  emit(part: StreamPart): void;
  events(): AsyncIterable<StreamPart>;
  close(): void;
}

export function createEventBus(): EventBus {
  const events: StreamPart[] = [];
  const waiters: Array<(part: StreamPart | null) => void> = [];
  let closed = false;

  const wakeAll = (): void => {
    for (const wake of waiters.splice(0)) {
      wake(null);
    }
  };

  const emit = (part: StreamPart): void => {
    events.push(part);
    for (const wake of waiters.splice(0)) {
      wake(part);
    }
  };

  async function* eventsIterator(): AsyncIterable<StreamPart> {
    let index = 0;
    while (true) {
      while (index < events.length) {
        yield events[index]!;
        index += 1;
      }
      if (closed) {
        break;
      }
      await new Promise<StreamPart | null>((resolve) => {
        waiters.push(resolve);
      });
    }
  }

  return {
    emit,
    events: eventsIterator,
    close() {
      closed = true;
      wakeAll();
    },
  };
}

export interface TurnHandleOptions {
  run: () => Promise<import('../types/channel.js').TurnResult>;
  bus: EventBus;
  abortController?: AbortController;
}

export function createTurnHandle(options: TurnHandleOptions): TurnHandle {
  const abortController = options.abortController ?? new AbortController();
  const bus = options.bus;

  const resultPromise = options.run().finally(() => {
    bus.close();
  });

  const handle = Object.assign(resultPromise, {
    events: bus.events(),
    toResponseStream(format: 'sse' | 'ndjson' = 'sse'): ReadableStream {
      return createResponseStream(bus.events(), format);
    },
    toUIMessageStreamResponse(opts?: { sessionId?: string }): Response {
      return createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(bus.events(), opts),
      });
    },
    cancel(reason?: string): void {
      abortController.abort(reason);
      bus.close();
    },
  }) as TurnHandle;

  return handle;
}

function createResponseStream(
  events: AsyncIterable<StreamPart>,
  format: 'sse' | 'ndjson',
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const part of events) {
          const payload = format === 'sse'
            ? `data: ${JSON.stringify(part)}\n\n`
            : `${JSON.stringify(part)}\n`;
          controller.enqueue(encoder.encode(payload));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
