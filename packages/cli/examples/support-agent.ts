/**
 * Bare-agent export shape — the CLI calls createRuntime for you.
 *   kuralle chat --agent ./examples/support-agent.ts
 */
import { openai } from '@ai-sdk/openai';
import { defineAgent } from '@kuralle-agents/core';

export default defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent. Keep replies to one or two sentences.',
  model: openai('gpt-4o-mini'),
});