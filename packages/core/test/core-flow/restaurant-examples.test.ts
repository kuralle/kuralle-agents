import { describe, expect, test } from 'bun:test';

describe('restaurant reservation examples', () => {
  test('bind the reservation SOP instead of allowing free-conversation collection', async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    const standard = await import('../../examples/flows/restaurant-reservation.js');
    const direct = await import('../../examples/flows/restaurant-reservation-direct-functions.js');
    expect(standard.agent.flows?.[0]?.binding).toBeTrue();
    expect(direct.agent.flows?.[0]?.binding).toBeTrue();
  });

  test('parks on repeated unavailable checks instead of self-oscillating', async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    const examples = await Promise.all([
      import('../../examples/flows/restaurant-reservation.js'),
      import('../../examples/flows/restaurant-reservation-direct-functions.js'),
    ]);

    for (const { agent } of examples) {
      const node = agent.flows?.[0]?.nodes.find((candidate) => candidate.id === 'no_availability');
      expect(node?.kind).toBe('reply');
      if (node?.kind !== 'reply' || !node.next) throw new Error('missing no_availability reply');

      const transition = await node.next({
        text: '',
        toolResults: [{
          name: 'check_availability',
          result: { available: false, alternative_times: ['9:00 PM'] },
        }],
      } as import('../../src/types/channel.js').TurnResult, {});
      expect(transition).toBe('stay');
    }
  });
});
