import { describe, it, expect } from 'bun:test';
import { defaultSessionResolver } from '../src/adapter/session-resolver.js';
import type { InboundMessage } from '../src/types.js';

function makeMessage(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: '1234567890',
    from: { id: 'user-1', name: 'Test User' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

describe('defaultSessionResolver', () => {
  it('resolves sessionId as {platform}:{threadId}', async () => {
    const msg = makeMessage({ platform: 'whatsapp', threadId: '1234567890' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('whatsapp:1234567890');
  });

  it('returns from.id as userId', async () => {
    const msg = makeMessage({ from: { id: 'user-42' } });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.userId).toBe('user-42');
  });

  it('works with WhatsApp-style thread IDs (phone numbers)', async () => {
    const msg = makeMessage({ platform: 'whatsapp', threadId: '+14155552671' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('whatsapp:+14155552671');
  });

  it('works with Messenger-style thread IDs (numeric IDs)', async () => {
    const msg = makeMessage({ platform: 'messenger', threadId: 't_10158763254390149' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('messenger:t_10158763254390149');
  });

  it('produces unique sessionIds for same threadId on different platforms', async () => {
    const waMsg = makeMessage({ platform: 'whatsapp', threadId: '1234567890' });
    const fbMsg = makeMessage({ platform: 'messenger', threadId: '1234567890' });

    const waResult = await defaultSessionResolver.resolve(waMsg);
    const fbResult = await defaultSessionResolver.resolve(fbMsg);

    expect(waResult.sessionId).not.toBe(fbResult.sessionId);
  });
});
