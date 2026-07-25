import { describe, expect, it } from 'bun:test';
import { PART_CHANNEL } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import type { WebSocketTransportFrame } from '../src/index.ts';

type WebSocketFrame = StreamPart | WebSocketTransportFrame;

const acceptsOnlyWireFrames = (frame: WebSocketFrame): WebSocketFrame => frame;

describe('WebSocket wire contract', () => {
  it('keeps stream and transport frames distinct', () => {
    const streamFrame = acceptsOnlyWireFrames({
      channel: 'client',
      type: 'text-delta',
      payload: { id: 'text-1', delta: 'hello' },
    });
    const transportFrame = acceptsOnlyWireFrames({ type: 'pong' });

    expect(streamFrame).toMatchObject({ channel: 'client', type: 'text-delta' });
    expect(transportFrame).toEqual({ type: 'pong' });
  });

  it('uses PART_CHANNEL as the sole stream audience classification', () => {
    expect(PART_CHANNEL['text-delta']).toBe('client');
    expect(PART_CHANNEL['tool-call']).toBe('internal');
  });
});
