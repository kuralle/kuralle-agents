import { describe, expect, test } from 'bun:test';

describe('warm transfer example', () => {
  test('a repeated store lookup parks instead of self-oscillating', async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    const { agent } = await import('../../examples/flows/warm-transfer.js');
    const flow = agent.flows?.[0];
    const initial = flow?.nodes.find((node) => node.id === 'customer_interaction');
    const continued = flow?.nodes.find((node) => node.id === 'continued_customer_interaction');
    if (initial?.kind !== 'reply' || continued?.kind !== 'reply' || !initial.next || !continued.next) {
      throw new Error('missing customer interaction nodes');
    }
    const turn = {
      text: '',
      toolResults: [{
        name: 'check_store_location_and_hours_of_operation',
        args: {},
        result: { store_location: '123 Main St' },
      }],
    };
    expect(await initial.next(turn, {})).toBe(continued);
    expect(await continued.next(turn, {})).toBe('stay');
  });
});
