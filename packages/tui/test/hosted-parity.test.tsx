import { describe, expect, it } from 'bun:test';
import { httpTransport, reduce, type Block, type LoggedEvent } from '@kuralle-agents/client';
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
 * It compares reduced transcript blocks rather than rendered frames, and strips two timing fields
 * before comparing. `LoggedEventSequencer.logged()` stamps `at: Date.now()` on receipt, so the
 * server's timestamps do not survive the versioned send route: a tool span the server measured at
 * 200ms reduces to `ms: 0` over HTTP. That is a gap in the wire format, not a rendering bug, and it
 * is tracked separately — comparing frames whole would only encode the gap as expected.
 */
const parityEvents = (): LoggedEvent[] => toolTurnEvents(0, 'parity-session');

function serveTurn(events: LoggedEvent[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event.part)}\n\n`).join('');
  return Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/messages')) {
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
}

/** Drops the fields the wire format cannot carry today, so everything else is compared strictly. */
function untimed(blocks: Block[]): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    const { ms, startedAt, ...rest } = block as unknown as Record<string, unknown>;
    return rest;
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
      expect(untimed(reduce(hosted).blocks)).toEqual(untimed(reduce(inProcess).blocks));
    } finally {
      server.stop(true);
    }
  });
});
