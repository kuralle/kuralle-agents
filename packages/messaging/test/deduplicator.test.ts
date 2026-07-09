import { describe, expect, it } from 'bun:test';
import { InMemoryInboundLedger, type ConversationKey } from '../src/inbound/ledger.js';
import type { InboundEvent } from '../src/inbound/types.js';

const key: ConversationKey = {
  platform: 'whatsapp',
  businessId: 'phone-1',
  threadId: 'user-1',
};

function message(id: string, ts = 1): InboundEvent {
  return {
    kind: 'message',
    id,
    ts,
    data: {
      id,
      platform: 'whatsapp',
      threadId: 'whatsapp:phone-1:user-1',
      customerId: 'user-1',
      from: { id: 'user-1' },
      timestamp: new Date(ts),
      type: 'text',
      text: id,
    },
  };
}

describe('InMemoryInboundLedger', () => {
  it('claims a new event and reports in_progress until complete', async () => {
    const ledger = new InMemoryInboundLedger();

    expect(await ledger.claim(key, 'msg-1')).toBe('claimed');
    expect(await ledger.claim(key, 'msg-1')).toBe('in_progress');

    await ledger.complete(key, 'msg-1');
    expect(await ledger.claim(key, 'msg-1')).toBe('duplicate');
  });

  it('isolates claims by platform/business/thread key', async () => {
    const ledger = new InMemoryInboundLedger();
    const otherPhone = { ...key, businessId: 'phone-2' };

    expect(await ledger.claim(key, 'same-message-id')).toBe('claimed');
    expect(await ledger.claim(otherPhone, 'same-message-id')).toBe('claimed');
  });

  it('appends ordered unprocessed events and advances the cursor with CAS', async () => {
    const ledger = new InMemoryInboundLedger();

    await ledger.append(key, message('early', 10));
    await ledger.append(key, message('late', 20));

    expect((await ledger.readUnprocessed(key)).map((event) => event.id)).toEqual([
      'early',
      'late',
    ]);
    expect(await ledger.commitCursor(key, 1, 1)).toBe(false);
    expect(await ledger.commitCursor(key, 1, 0)).toBe(true);
    expect((await ledger.readUnprocessed(key)).map((event) => event.id)).toEqual(['late']);
  });

  it('prunes events below the committed cursor after ttl', async () => {
    const ledger = new InMemoryInboundLedger();

    await ledger.append(key, message('a', 1));
    await ledger.append(key, message('b', 2));
    expect(await ledger.commitCursor(key, 1, 0)).toBe(true);

    expect(await ledger.prune(key, -1)).toBe(1);
    expect((await ledger.readUnprocessed(key)).map((event) => event.id)).toEqual(['b']);
  });
});
