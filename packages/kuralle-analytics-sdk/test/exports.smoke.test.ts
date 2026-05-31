import { describe, it, expect } from 'bun:test';
import {
  AnalyticsEventSchema,
  validateAnalyticsEvent,
  Batcher,
  HttpSink,
  createAnalyticsClient,
} from '../src/index.js';

describe('@kuralle-agents/analytics-sdk smoke', () => {
  it('validates a minimal analytics event', () => {
    const event = validateAnalyticsEvent({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      type: 'conversation.started',
      data: {},
    });
    expect(event.sessionId).toBe('sess-1');
    expect(AnalyticsEventSchema.safeParse(event).success).toBe(true);
  });

  it('exports client factory and sink types', () => {
    expect(typeof createAnalyticsClient).toBe('function');
    expect(typeof Batcher).toBe('function');
    expect(typeof HttpSink).toBe('function');
  });
});
