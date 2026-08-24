import { describe, expect, it } from 'bun:test';
import { httpTransport, reduce, type LoggedEvent } from '@kuralle-agents/client';
import { MockSession, toolTurnEvents } from './helpers.js';

/**
 * REQ-10: the TUI shows the same conversation whichever transport it is pointed at.
 *
 * The first version of this test built both sides from the same `MockSession` class with the same
 * arguments and compared their recorder frames. No transport was involved on either side, so it
 * could not fail and proved nothing. This one puts a real HTTP server between the halves: the
 * in-process side reads the events directly, the hosted side reads the same turn back through
 * `httpTransport`, exercising the SSE parser and the client-side sequencer. A transport that
 * reorders, drops, or reshapes a part fails it.
 *
 * It compares reduced transcript blocks rather than rendered frames, and compares them whole,
 * timings included. That is the point of the assertion now: the versioned route answers
 * `format=events` with the log's own envelope, so a tool span the server measured at 200ms still
 * reduces to 200ms over HTTP. While the client stamped `at: Date.now()` on receipt instead, every
 * hosted duration collapsed to 0 and this test had to strip the timing fields to pass.
 */
const parityEvents = (): LoggedEvent[] => toolTurnEvents(0, 'parity-session');

function serveTurn(events: LoggedEvent[]) {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  return Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/messages')) {
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

async function collect(turn: AsyncIterable<LoggedEvent>): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
}

describe('hosted parity', () => {
  it('in-process and HTTP transports deliver the same parts and reduce to the same transcript', async () => {
    const server = serveTurn(parityEvents());
    try {
      const inProcess = await collect(
        await new MockSession({ reply: () => parityEvents() }).send('check order'),
      );
      const hosted = await collect(
        await httpTransport({
          kind: 'http',
          url: server.url.origin,
          agentName: 'parity-agent',
        }).sessions.attach('parity-session').send('check order'),
      );

      expect(hosted.map((event) => event.part)).toEqual(inProcess.map((event) => event.part));
      expect(reduce(hosted).blocks).toEqual(reduce(inProcess).blocks);
    } finally {
      server.stop(true);
    }
  });
});
