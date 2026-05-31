import { describe, test, expect } from 'bun:test';

import { validateAnalyticsEvent, AnalyticsEventSchema } from '../src/schema.js';

describe('Zod validation', () => {
  test('valid event parses', () => {
    const ev = validateAnalyticsEvent({
      sessionId: 's1',
      agentId: 'a1',
      workspaceId: 'w1',
      type: 'conversation.started',
      data: {},
    });
    expect(ev.sessionId).toBe('s1');
  });

  test('missing sessionId throws', () => {
    expect(() =>
      validateAnalyticsEvent({
        agentId: 'a1',
        workspaceId: 'w1',
        type: 'conversation.started',
        data: {},
      }),
    ).toThrow();
  });

  test('empty sessionId throws', () => {
    expect(() =>
      validateAnalyticsEvent({
        sessionId: '',
        agentId: 'a1',
        workspaceId: 'w1',
        type: 'conversation.started',
        data: {},
      }),
    ).toThrow();
  });

  test('invalid type enum throws', () => {
    expect(() =>
      validateAnalyticsEvent({
        sessionId: 's1',
        agentId: 'a1',
        workspaceId: 'w1',
        type: 'not-a-real-event',
        data: {},
      }),
    ).toThrow();
  });

  test('accepts custom type', () => {
    const r = AnalyticsEventSchema.safeParse({
      sessionId: 's1',
      agentId: 'a1',
      workspaceId: 'w1',
      type: 'custom',
      data: { anything: 'goes' },
    });
    expect(r.success).toBe(true);
  });
});
