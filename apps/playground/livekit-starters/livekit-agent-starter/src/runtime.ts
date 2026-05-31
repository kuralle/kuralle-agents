import { createRuntime, defineAgent, type AgentConfig } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

// The agent's "brain". Everything that makes the bot smart — instructions,
// and later tools, flows, routing, and handoffs — lives here in Kuralle.
// The LiveKit session (src/main.ts) only handles speech in/out and the room.
const model = openai('gpt-4o-mini');

export const assistantAgent: AgentConfig = defineAgent({
  id: 'assistant',
  name: 'Assistant',
  model,
  instructions: `You are a helpful voice AI assistant. The user is talking to you by voice.
Keep replies short, natural, and free of formatting, emojis, or symbols.
Be friendly and to the point.`,
});

export function createBotRuntime() {
  return createRuntime({
    agents: [assistantAgent],
    defaultAgentId: 'assistant',
    defaultModel: model,
    voiceMode: true,
  });
}
