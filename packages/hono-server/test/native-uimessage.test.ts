import { describe, expect, it } from 'bun:test';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import type { UserInputContent } from '@kuralle-agents/core';
import { createKuralleChatRouter, createKuralleRouter } from '../src/index.ts';

type StreamChunk = { type: string; [key: string]: unknown };

async function parseUiMessageSse(body: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice('data: '.length);
      if (!payload || payload === '[DONE]') continue;
      chunks.push(JSON.parse(payload) as StreamChunk);
    }
  }
  return chunks;
}

async function parseRawHarnessSse(body: string): Promise<StreamChunk[]> {
  const parts: StreamChunk[] = [];
  for (const block of body.split('\n\n')) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as StreamChunk;
    if (eventLine) {
      parsed.type = eventLine.slice('event: '.length);
    }
    parts.push(parsed);
  }
  return parts;
}

function sessionIdFromUiStream(chunks: StreamChunk[]): string | undefined {
  for (const chunk of chunks) {
    if (
      chunk.type === 'start' ||
      chunk.type === 'finish' ||
      chunk.type === 'message-metadata'
    ) {
      const metadata = chunk.messageMetadata as { sessionId?: string } | undefined;
      if (metadata?.sessionId) {
        return metadata.sessionId;
      }
    }
  }
  return undefined;
}

describe('native UIMessageStream default', () => {
  it('POST /api/chat/sse returns native text-* chunks for useChat-shaped body', async () => {
    const runtime = createMockRuntime([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello' },
      { type: 'text-end', id: 't1' },
      { type: 'node-enter', nodeName: 'greet' },
      { type: 'done', sessionId: 'sess-ui' },
    ]);

    const app = createKuralleChatRouter({ runtime, streamFilter: 'all' });
    const res = await app.request('/api/chat/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const chunks = await parseUiMessageSse(await res.text());
    expect(chunks.some((c) => c.type === 'text-start')).toBe(true);
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'Hello')).toBe(true);
    expect(chunks.some((c) => c.type === 'text-end')).toBe(true);
    expect(chunks.some((c) => c.type === 'data-kuralle-node')).toBe(true);
  });

  it('concatenates all text parts from the last user message for runtime.run input', async () => {
    let capturedInput: UserInputContent | undefined;
    const runtime = createMockRuntime(
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'ok' },
        { type: 'text-end', id: 't1' },
        { type: 'done', sessionId: 'sess-inbound' },
      ],
      {
        onRun: (call) => {
          capturedInput = call.input;
        },
      },
    );

    const app = createKuralleChatRouter({ runtime, streamFilter: 'all' });
    const res = await app.request('/api/chat/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'first ' },
              { type: 'text', text: 'second' },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(capturedInput).toBe('first second');
  });

  it('native default exposes server sessionId in message metadata for useChat clients', async () => {
    const runtime = createMockRuntime([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello' },
      { type: 'text-end', id: 't1' },
      { type: 'done', sessionId: 'sess-ui' },
    ]);

    const app = createKuralleChatRouter({ runtime, streamFilter: 'all' });
    const res = await app.request('/api/chat/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'sess-ui',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    });

    expect(res.status).toBe(200);
    const chunks = await parseUiMessageSse(await res.text());
    expect(sessionIdFromUiStream(chunks)).toBe('sess-ui');
  });

  it('POST /api/chat/sse?format=raw returns legacy HarnessStreamPart JSON-SSE', async () => {
    const runtime = createMockRuntime([
      { type: 'text-delta', id: 't1', delta: 'raw' },
      { type: 'done', sessionId: 'sess-raw' },
    ]);

    const app = createKuralleChatRouter({ runtime, streamFilter: 'all' });
    const res = await app.request('/api/chat/sse?format=raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: 'sess-raw' }),
    });

    expect(res.status).toBe(200);
    const parts = await parseRawHarnessSse(await res.text());
    expect(parts.some((p) => p.type === 'text-delta' && p.delta === 'raw')).toBe(true);
    expect(parts.some((p) => p.type === 'done' && p.sessionId === 'sess-raw')).toBe(true);
  });

  it('POST /api/flow/sse defaults to native UIMessageStream', async () => {
    const flowManager = {
      currentNodeName: 'start',
      nodeHistory: ['start'],
      hasEnded: false,
      collectedData: {},
      process: async function* () {
        yield { type: 'text-start', id: 'f1' };
        yield { type: 'text-delta', id: 'f1', delta: 'flow' };
        yield { type: 'text-end', id: 'f1' };
      },
    };

    const app = createKuralleRouter({ flowManager, sessionId: 'flow-sess' });
    const res = await app.request('/api/flow/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
      }),
    });

    expect(res.status).toBe(200);
    const chunks = await parseUiMessageSse(await res.text());
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'flow')).toBe(true);
  });

  it('POST /api/flow/sse?format=raw returns legacy flow JSON-SSE', async () => {
    const flowManager = {
      currentNodeName: 'start',
      nodeHistory: ['start'],
      hasEnded: false,
      collectedData: {},
      process: async function* () {
        yield { type: 'text-delta', id: 'f1', delta: 'legacy' };
      },
    };

    const app = createKuralleRouter({ flowManager, sessionId: 'flow-sess' });
    const res = await app.request('/api/flow/sse?format=raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'go' }),
    });

    expect(res.status).toBe(200);
    const parts = await parseRawHarnessSse(await res.text());
    expect(parts.some((p) => p.type === 'text-delta' && p.delta === 'legacy')).toBe(true);
  });
});
