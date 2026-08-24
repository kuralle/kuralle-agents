import { afterAll, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { LoggedEvent } from '@kuralle-agents/core';
import { createClient, reduce } from '../src/index.js';

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function collectEvents(iterable: AsyncIterable<LoggedEvent>): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function assistantText(events: LoggedEvent[]): string {
  return reduce(events).blocks
    .filter((block) => block.kind === 'assistant')
    .map((block) => block.text)
    .join('');
}

describe('hosted HTTP transport', () => {
  it('takes a JSON turn through the stable /api/chat contract', async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { sessionId: string; message: string };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ sessionId: body.sessionId, response: `echo: ${body.message}`, messageCount: 4 }));
    });
    const origin = await listen(server);
    try {
      const client = createClient({ kind: 'http', url: origin });
      const session = client.sessions.attach('s-1');
      const turn = await session.send('hello');
      const events = await collectEvents(turn);
      const result = await turn.result();
      expect(session.id).toBe('s-1');
      expect(assistantText(events)).toBe('echo: hello');
      expect(result.text).toBe('echo: hello');
    } finally {
      server.close();
    }
  });

  it('falls back to Hono SSE and reconstructs text deltas across chunks', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/api/chat') { response.statusCode = 404; response.end(); return; }
      response.setHeader('content-type', 'text/event-stream');
      response.write('data: {"type":"text-delta","payload":{"delta":"hel"}}\n\n');
      response.end('data: {"type":"text-delta","payload":{"delta":"lo"}}\n\n');
    });
    const origin = await listen(server);
    try {
      const client = createClient({ kind: 'http', url: origin });
      const session = client.sessions.attach('s-2');
      const seen: string[] = [];
      const turn = await session.send('hello');
      const events: LoggedEvent[] = [];
      let last = '';
      for await (const event of turn) {
        events.push(event);
        const text = assistantText(events);
        if (text !== last) {
          seen.push(text);
          last = text;
        }
      }
      await turn.result();
      expect(assistantText(events)).toBe('hello');
      expect(seen).toEqual(['hel', 'hello']);
    } finally {
      server.close();
    }
  });

  it('drives a version-pinned deployment route when an HTTP agent name is supplied', async () => {
    let requestUrl = '';
    let authorization = '';
    let idempotencyKey = '';
    let requestBody: unknown;
    const server = createServer(async (request, response) => {
      requestUrl = request.url || '';
      authorization = String(request.headers.authorization || '');
      idempotencyKey = String(request.headers['idempotency-key'] || '');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      // The deployment answers `format=events` with logged events, the same NDJSON `/events`
      // serves. Indices start at 40 here so a client that invented its own would be visible.
      const logged = (index: number, delta: string) => `${JSON.stringify({
        index,
        eventId: `srv-${index}`,
        runId: 'run-1',
        at: 1_000 + index,
        part: { channel: 'client', type: 'text-delta', payload: { id: 'a', delta } },
      })}\n`;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(logged(40, 'file '));
      response.write(logged(41, 'agent'));
      // The server ends a turn by logging `done`. A stream without one is a cut turn, and the
      // transport now says so rather than handing back a short transcript.
      response.end(`${JSON.stringify({
        index: 42,
        eventId: 'srv-42',
        runId: 'run-1',
        at: 1_042,
        part: { channel: 'client', type: 'done', payload: { sessionId: 'thread 1' } },
      })}\n`);
    });
    const origin = await listen(server);
    try {
      const client = createClient({
        kind: 'http',
        url: origin,
        agentName: 'guide-agent',
        auth: { token: 'runtime-token' },
      });
      const session = client.sessions.attach('thread 1');
      const turn = await session.send('hello');
      const events = await collectEvents(turn);
      await turn.result();

      expect(requestUrl).toBe('/v1/agents/guide-agent/threads/thread%201/messages?format=events');
      expect(authorization).toBe('Bearer runtime-token');
      expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(requestBody).toEqual({ message: 'hello' });
      expect(assistantText(events)).toBe('file agent');
      // The server's identity survives the transport. Inventing one here is the whole defect.
      expect(events.map((event) => event.index)).toEqual([40, 41, 42]);
      expect(events.map((event) => event.eventId)).toEqual(['srv-40', 'srv-41', 'srv-42']);
    } finally {
      server.close();
    }
  });
});
