import { describe, expect, test } from 'bun:test';

describe('LLM switching example', () => {
  test('target agents retain weather and switching tools after handoff', async () => {
    process.env.OPENAI_API_KEY ||= 'test-key';
    const { agents } = await import('../../examples/flows/llm-switching.js');
    expect(agents).toHaveLength(4);
    for (const agent of agents) {
      expect(Object.keys(agent.tools ?? {}).sort()).toEqual([
        'get_current_weather',
        'switch_llm',
      ]);
    }
  });
});
