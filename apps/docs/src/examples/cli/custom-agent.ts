import { openai } from '@ai-sdk/openai';
import { defineAgent } from '@kuralle-agents/core';

// Bare agent — the CLI owns createRuntime, session store, readState, and label.
export default defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});