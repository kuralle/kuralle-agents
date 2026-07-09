import { describe, expect, it } from 'bun:test';
import { StreamMapper } from '../src/adapter/stream-mapper.js';
import { OutboundPipeline } from '../src/adapter/outbound-pipeline.js';
import { windowGuard } from '../src/adapter/middleware/window-guard.js';
import { InMemoryWindowStore } from '../src/adapter/window-store.js';
import type { PlatformClient } from '../src/types.js';
import type { HarnessStreamPart } from '@kuralle-agents/core';

function fakePlatform(sent: Array<{ kind: string; payload: unknown }>): PlatformClient {
  return {
    platform: 'whatsapp',
    formatConverter: { toPlatformFormat: (t: string) => t, fromPlatformFormat: (t: string) => t },
    sendText: async (threadId: string, text: string) => {
      sent.push({ kind: 'text', payload: text });
      return { messageId: 'm1', threadId, timestamp: new Date() };
    },
    sendInteractive: async (threadId: string, msg: unknown) => {
      sent.push({ kind: 'interactive', payload: msg });
      return { messageId: 'm2', threadId, timestamp: new Date() };
    },
    sendMedia: async () => ({ messageId: 'm3', threadId: 't', timestamp: new Date() }),
    sendRaw: async () => ({ messageId: 'm4', threadId: 't', timestamp: new Date() }),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    onMessage: () => {},
    onStatus: () => {},
    onReaction: () => {},
    webhookRouter: () => new Response('ok'),
  } as unknown as PlatformClient;
}

async function* stream(parts: HarnessStreamPart[]) {
  for (const part of parts) yield part;
}

describe('StreamMapper default mapping — interactive parts', () => {
  it('renders a trailing interactive part as native buttons (no custom mapper needed)', async () => {
    const sent: Array<{ kind: string; payload: unknown }> = [];
    const platform = fakePlatform(sent);
    const windowStore = new InMemoryWindowStore();
    await windowStore.recordInbound('t1', new Date());
    const mapper = new StreamMapper();

    await mapper.mapStream(
      stream([
        {
          type: 'interactive',
          nodeId: 'pick',
          prompt: 'Which cake would you like?',
          options: [
            { id: 'choc', label: 'Chocolate' },
            { id: 'van', label: 'Vanilla' },
          ],
        },
        { type: 'done', sessionId: 's1' },
      ]),
      platform,
      't1',
      {
        pipeline: new OutboundPipeline([windowGuard], platform),
        windowStore,
        sessionId: 's1',
      },
    );

    const interactive = sent.find((s) => s.kind === 'interactive');
    expect(interactive).toBeDefined();
    const msg = interactive!.payload as { type: string; body: string; action: { type: string; buttons: Array<{ id: string }> } };
    expect(msg.type).toBe('buttons');
    expect(msg.body).toBe('Which cake would you like?');
    expect(msg.action.buttons.map((b) => b.id)).toEqual(['choc', 'van']);
  });

  it('sends distinct text first, then the interactive; skips text equal to the prompt', async () => {
    const sent: Array<{ kind: string; payload: unknown }> = [];
    const platform = fakePlatform(sent);
    const windowStore = new InMemoryWindowStore();
    await windowStore.recordInbound('t2', new Date());
    const mapper = new StreamMapper();

    await mapper.mapStream(
      stream([
        { type: 'text-start', id: 'x' },
        { type: 'text-delta', id: 'x', delta: 'Great news — those are in stock!' },
        { type: 'text-end', id: 'x' },
        {
          type: 'interactive',
          nodeId: 'pick',
          prompt: 'Pick one:',
          options: [{ id: 'a', label: 'A' }],
        },
        { type: 'done', sessionId: 's2' },
      ]),
      platform,
      't2',
      { pipeline: new OutboundPipeline([windowGuard], platform), windowStore, sessionId: 's2' },
    );

    expect(sent.map((s) => s.kind)).toEqual(['text', 'interactive']);
    expect(sent[0]!.payload).toBe('Great news — those are in stock!');
  });
});
