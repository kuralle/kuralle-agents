import { afterAll, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  clearHostedConnection,
  readHostedConnection,
  resolveHostedConnection,
  saveHostedConnection,
} from '../src/hostedConnection.js';
import { runHostedTurn } from '../src/hostedClient.js';

const previousConfig = process.env.KURALLE_CONFIG;
const configPath = join(mkdtempSync(join(tmpdir(), 'kuralle-hosted-')), 'connection.json');
process.env.KURALLE_CONFIG = configPath;

afterAll(() => {
  if (previousConfig === undefined) delete process.env.KURALLE_CONFIG;
  else process.env.KURALLE_CONFIG = previousConfig;
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('hosted connection', () => {
  it('persists a non-secret default and lets --local opt out', async () => {
    await clearHostedConnection();
    await saveHostedConnection({ server: 'https://agent.example/', transport: 'cloudflare', agentName: 'pharmacy-agent' });
    expect(await readHostedConnection()).toEqual({
      server: 'https://agent.example', transport: 'cloudflare', agentName: 'pharmacy-agent',
    });
    expect(await resolveHostedConnection(['chat', '--local'])).toBeUndefined();
    expect(await clearHostedConnection()).toBe(true);
  });
});

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
      await expect(runHostedTurn({ server: origin, transport: 'http' }, 's-1', 'hello')).resolves.toMatchObject({
        sessionId: 's-1', text: 'echo: hello', messageCount: 4,
      });
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
      const seen: string[] = [];
      const result = await runHostedTurn({ server: origin, transport: 'http' }, 's-2', 'hello', {
        onText: (text) => seen.push(text),
      });
      expect(result.text).toBe('hello');
      expect(seen).toEqual(['hel', 'hello']);
    } finally {
      server.close();
    }
  });
});

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
      const result = await runHostedTurn({
        server: `http://127.0.0.1:${address.port}`,
        transport: 'cloudflare',
        agentName: 'pharmacy-agent',
      }, 'thread-7', 'hello');
      expect(path).toBe('/agents/pharmacy-agent/thread-7');
      expect(result).toMatchObject({ text: 'persisted answer', messageCount: 2 });
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
