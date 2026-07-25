import { describe, expect, it } from 'bun:test';
import { PART_CHANNEL } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';

type ClientStreamPart = Extract<StreamPart, { channel: 'client' }>;

const handledClientTypes: Record<ClientStreamPart['type'], true> = {
  'text-start': true,
  'text-delta': true,
  'text-end': true,
  'text-cancel': true,
  'conversation-outcome': true,
  error: true,
  done: true,
};

describe('widget stream contract', () => {
  it('handles exactly the client-channel StreamPart types', () => {
    const clientTypes = Object.entries(PART_CHANNEL)
      .filter(([, channel]) => channel === 'client')
      .map(([type]) => type)
      .sort();

    expect(clientTypes).toEqual(Object.keys(handledClientTypes).sort());
    expect(Object.keys(PART_CHANNEL).filter((type) => !(type in handledClientTypes))).toContain(
      'handoff',
    );
  });
});
