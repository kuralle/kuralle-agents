import { describe, it, expect } from 'bun:test';
import {
  SessionResolverChain,
  ThreadIdResolver,
  PhoneLookupResolver,
} from '../src/adapter/session-resolver-chain.js';
import type { InboundMessage } from '../src/types.js';

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-1',
    platform: 'whatsapp',
    threadId: '+15551234567',
    customerId: 'u-1',
    from: { id: 'u-1', phone: '+15551234567' },
    timestamp: new Date(),
    type: 'text',
    text: 'hi',
    ...overrides,
  };
}

describe('SessionResolverChain', () => {
  it('requires at least one plugin', () => {
    expect(() => new SessionResolverChain([])).toThrow();
  });

  it('returns the first plugin that resolves', async () => {
    const phoneLookup = new PhoneLookupResolver(async () => 'known-user-42');
    const chain = new SessionResolverChain([phoneLookup, new ThreadIdResolver()]);
    const out = await chain.resolve(msg());
    expect(out).toEqual({ sessionId: 'known-user-42', userId: 'known-user-42' });
  });

  it('falls back to ThreadIdResolver when PhoneLookup defers', async () => {
    const phoneLookup = new PhoneLookupResolver(async () => null);
    const chain = new SessionResolverChain([phoneLookup, new ThreadIdResolver()]);
    const out = await chain.resolve(msg());
    expect(out).toEqual({ sessionId: 'whatsapp:+15551234567', userId: 'u-1' });
  });

  it('PhoneLookupResolver defers when phone is missing', async () => {
    const phoneLookup = new PhoneLookupResolver(async () => 'unexpected');
    const chain = new SessionResolverChain([phoneLookup, new ThreadIdResolver()]);
    const out = await chain.resolve(msg({ from: { id: 'u-2' } }));
    expect(out.sessionId).toBe('whatsapp:+15551234567');
  });

  it('throws if no plugin matches', async () => {
    const alwaysDefer = {
      name: 'defer',
      async tryResolve() {
        return undefined;
      },
    };
    const chain = new SessionResolverChain([alwaysDefer]);
    await expect(chain.resolve(msg())).rejects.toThrow('no plugin matched');
  });
});
