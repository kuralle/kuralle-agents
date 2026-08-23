import { describe, expect, it } from 'bun:test';
import { WebSocketServer } from 'ws';
import type { LoggedEvent } from '@kuralle-agents/core';
import { createClient, reduce } from '../src/index.js';

async function collectEvents(iterable: AsyncIterable<LoggedEvent>): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('hosted Cloudflare transport', () => {
  it('speaks the native Agents chat WebSocket protocol and uses persisted output', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (typeof address === 'string') throw new Error('Expected TCP address.');
    let path = '';
    wss.on('connection', (socket, request) => {
      path = request.url || '';
      socket.once('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { type: string };
        expect(frame.type).toBe('cf_agent_use_chat_request');
        socket.send(JSON.stringify({
          type: 'cf_agent_use_chat_response',
          body: '{"type":"text-delta","delta":"streamed"}',
          done: true,
        }));
        socket.send(JSON.stringify({
          type: 'cf_agent_chat_messages',
          messages: [
            { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
            { role: 'assistant', parts: [{ type: 'text', text: 'persisted answer' }] },
          ],
        }));
      });
    });
    try {
      const client = createClient({
        kind: 'cloudflare',
        url: `http://127.0.0.1:${address.port}`,
        agentName: 'pharmacy-agent',
      });
      const session = client.sessions.attach('thread-7');
      const turn = await session.send('hello');
      const events = await collectEvents(turn);
      await turn.result();
      const text = reduce(events).blocks
        .filter((block) => block.kind === 'assistant')
        .map((block) => block.text)
        .join('');
      expect(path).toBe('/agents/pharmacy-agent/thread-7');
      expect(text).toBe('persisted answer');
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
