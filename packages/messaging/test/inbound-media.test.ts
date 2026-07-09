import { describe, it, expect } from 'bun:test';
import { attachInboundMedia } from '../src/adapter/inbound-media.js';
import type { InboundMessage } from '../src/types.js';

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-1',
    platform: 'whatsapp',
    threadId: '+15551234567',
    customerId: 'u-1',
    from: { id: 'u-1' },
    timestamp: new Date(),
    type: 'text',
    ...overrides,
  };
}

const downloader = (bytes: string, mimeType = 'image/png') => ({
  async downloadMedia() {
    return { data: Buffer.from(bytes), mimeType };
  },
});

describe('attachInboundMedia', () => {
  it('passes text-only input through untouched', async () => {
    const out = await attachInboundMedia(msg({ type: 'text', text: 'hello' }), 'hello', downloader('x'));
    expect(out).toBe('hello');
  });

  it('downloads media by id and emits a base64 file part', async () => {
    const message = msg({
      type: 'image',
      media: { id: 'media-123', mimeType: 'image/png', caption: 'whats this?' },
    });
    const out = await attachInboundMedia(message, '', downloader('PNGBYTES'));
    expect(out).toEqual([
      { type: 'text', text: 'whats this?' },
      { type: 'file', data: Buffer.from('PNGBYTES').toString('base64'), mediaType: 'image/png', filename: undefined },
    ]);
  });

  it('passes a hosted url through without downloading', async () => {
    const message = msg({
      type: 'image',
      media: { id: 'media-1', url: 'https://cdn.example.com/x.jpg', mimeType: 'image/jpeg' },
    });
    const client = {
      async downloadMedia(): Promise<never> {
        throw new Error('should not download when url present');
      },
    };
    const out = await attachInboundMedia(message, '', client);
    expect(out).toEqual([
      { type: 'file', data: 'https://cdn.example.com/x.jpg', mediaType: 'image/jpeg', filename: undefined },
    ]);
  });

  it('falls back to a sensible mediaType per kind when missing', async () => {
    const message = msg({ type: 'audio', media: { id: 'voice-1' } });
    const out = (await attachInboundMedia(message, '', {
      async downloadMedia() {
        return { data: Buffer.from('OGG'), mimeType: '' };
      },
    })) as Array<{ type: string; mediaType?: string }>;
    expect(out[0]?.mediaType).toBe('audio/ogg');
  });
});
