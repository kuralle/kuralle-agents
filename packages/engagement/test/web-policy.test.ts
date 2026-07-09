import { describe, it, expect } from 'bun:test';
import type { InboundMessage } from '@kuralle-agents/messaging';
import { webPolicy } from '../src/policies/web.js';

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-1',
    platform: 'web',
    threadId: 't-1',
    customerId: 'u-1',
    from: { id: 'u-1' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

describe('web_null_policy_always_open', () => {
  it('is the null adapter per RFC §4.12', async () => {
    const policy = webPolicy();
    expect(policy.channel).toBe('web');
    expect(policy.hasWindow).toBe(false);
    expect(await policy.isWindowOpen('x')).toBe(true);
    expect(policy.consentRequired).toBe(false);
    expect(policy.closedWindow).toEqual({ kind: 'none' });

    const interactive = policy.renderInteractive([{ id: 'a', label: 'A' }], 'pick');
    expect(interactive.type).toBe('buttons');
    expect(interactive.body).toBe('pick');
    expect(interactive.action).toEqual({
      type: 'buttons',
      buttons: [{ id: 'a', title: 'A' }],
    });

    expect(policy.resolveInbound(msg())).toEqual({ input: 'hello' });
  });
});
