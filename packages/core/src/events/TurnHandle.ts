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

/**
 * Tells every intermediary to hand this stream through untouched.
 *
 * A turn can be perfectly streamed on the wire and still arrive at the browser all at once,
 * because something between the two buffered it. Measured against the marketing-team example,
 * same prompt, counting the gap between the first and last text delta:
 *
 *   direct to the server, plain            streaming
 *   direct to the server, --compressed     streaming
 *   through a Next.js rewrite, plain       streaming
 *   through a Next.js rewrite, compressed  BUFFERED — every delta arrived together
 *
 * The last row is what a browser does, because a browser always sends `Accept-Encoding`. The
 * result was a spinner for 37 seconds and then the whole turn in one frame: 18 DOM mutations,
 * 17 of them inside the final 700ms. A plain `curl` sends no `Accept-Encoding`, so the obvious
 * wire check looks healthy while the UI does not — which is exactly how this hid.
 *
 * `no-transform` is the standard "do not re-encode this response" signal, `identity` refuses
 * compression outright (compressing an SSE stream buys nothing and costs the flush boundary),
 * and `X-Accel-Buffering: no` is nginx's equivalent for anyone terminating there.
 *
 * This belongs here rather than at each call site: every runtime that streams a turn —
 * hono-server, cf-agent, an app's own route — goes through this method, and a proxy in front of
 * it is the normal deployment, not the exception.
 */
function applyNoBufferingHeaders(headers: Headers): void {
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Content-Encoding', 'identity');
  headers.set('X-Accel-Buffering', 'no');
}

export interface TurnHandleOptions {
  run: () => Promise<import('../types/channel.js').TurnResult>;
  bus: EventBus;
  abortController?: AbortController;
  /** Settles when the run is opened, not when the turn body finishes. */
  runId?: Promise<string>;
}

export function createTurnHandle(options: TurnHandleOptions): TurnHandle {
  const abortController = options.abortController ?? new AbortController();
  const bus = options.bus;

  const resultPromise = options.run().finally(() => {
    bus.close();
  });

  // A failing turn delivers its error twice: once onto the bus as a `client` error part, which
  // the stream surfaces to the caller, and once by rejecting this promise. Consumers that only
  // stream — `toUIMessageStreamResponse()`, `toResponseStream()`, or `for await (…of handle
  // .events)` — never touch the promise side, so that second delivery lands with no handler
  // attached and takes the whole process down on `unhandledRejection`. One bad provider call
  // then kills a server for every other session on it.
  //
  // Attaching the sink here rather than at each call site is deliberate: the hazard belongs to
  // the handle's dual nature (it is a promise AND an event source), so every consumer that
  // opts out of the promise half would otherwise have to remember this. `hono-server`'s SSE
  // router did remember; the UIMessageStream path did not.
  //
  // This marks the rejection handled without swallowing it — `handle` is the same object, so
  // anyone who does `await runtime.run(...)` still gets the error. A sink on a *derived*
  // promise would not settle the original's handled-ness, which is why the `.catch` goes on
  // `resultPromise` itself and its return value is discarded.
  void resultPromise.catch(() => undefined);

  const runId = options.runId ?? resultPromise.then((result) => result.runId ?? '');
  void runId.catch(() => undefined);

  const handle = Object.assign(resultPromise, {
    events: bus.events(),
    runId,
    toResponseStream(format: 'sse' | 'ndjson' = 'sse'): ReadableStream {
      return createResponseStream(bus.events(), format);
    },
    toUIMessageStreamResponse(opts?: { sessionId?: string }): Response {
      const response = createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(bus.events(), opts),
      });
      applyNoBufferingHeaders(response.headers);
      return response;
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
