import { describe, it, expect } from 'bun:test';
import { defaultSessionResolver } from '../src/adapter/session-resolver.js';
import type { InboundMessage } from '../src/types.js';

function makeMessage(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: '1234567890',
    customerId: 'user-1',
    from: { id: 'user-1', name: 'Test User' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

describe('defaultSessionResolver', () => {
  it('resolves sessionId as threadId (no platform prefix)', async () => {
    const msg = makeMessage({ platform: 'whatsapp', threadId: '1234567890' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('1234567890');
  });

  it('returns customerId as userId when set', async () => {
    const msg = makeMessage({ customerId: 'wa-42', from: { id: 'display-42' } });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.userId).toBe('wa-42');
  });

  it('falls back to from.id when customerId is missing at runtime', async () => {
    const msg = makeMessage({ from: { id: 'user-42' } });
    (msg as { customerId?: string }).customerId = undefined;
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.userId).toBe('user-42');
  });

  it('works with WhatsApp-style thread IDs (already platform-scoped)', async () => {
    const msg = makeMessage({
      platform: 'whatsapp',
      threadId: 'whatsapp:PNID:+14155552671',
      customerId: '+14155552671',
    });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('whatsapp:PNID:+14155552671');
  });

  it('works with Messenger-style thread IDs', async () => {
    const msg = makeMessage({
      platform: 'messenger',
      threadId: 'messenger:page:t_10158763254390149',
      customerId: 't_10158763254390149',
    });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('messenger:page:t_10158763254390149');
  });

  it('session_id_not_double_prefixed', async () => {
    const msg = makeMessage({
      platform: 'whatsapp',
      threadId: 'whatsapp:PNID:15551234',
      customerId: '15551234',
      from: { id: '15551234' },
    });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('whatsapp:PNID:15551234');
    expect(result.sessionId).not.toBe('whatsapp:whatsapp:PNID:15551234');
    expect(result.userId).toBe('15551234');
  });

  it('produces distinct sessionIds for fully-qualified threadIds on different platforms', async () => {
    const waMsg = makeMessage({
      platform: 'whatsapp',
      threadId: 'whatsapp:pn1:1234567890',
      customerId: '1234567890',
    });
    const fbMsg = makeMessage({
      platform: 'messenger',
      threadId: 'messenger:page1:1234567890',
      customerId: '1234567890',
    });

    const waResult = await defaultSessionResolver.resolve(waMsg);
    const fbResult = await defaultSessionResolver.resolve(fbMsg);

    expect(waResult.sessionId).not.toBe(fbResult.sessionId);
  });
});
