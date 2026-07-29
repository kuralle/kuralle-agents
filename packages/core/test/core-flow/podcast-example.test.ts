import { describe, expect, test } from 'bun:test';

describe('podcast interview example', () => {
  test('advancing an aspect parks for user input instead of self-oscillating', async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    const { agent } = await import('../../examples/flows/podcast-interview.js');
    const node = agent.flows?.[0]?.nodes.find((candidate) => candidate.id === 'interview');
    if (node?.kind !== 'reply' || !node.next) throw new Error('missing interview node');
    const state: Record<string, unknown> = {};
    const transition = await node.next({
      text: '',
      toolResults: [{ name: 'next_question', args: {}, result: { aspects_covered: 1 } }],
    }, state);
    expect(transition).toBe('stay');
    expect(state.aspects_covered).toBe(1);
  });
});
