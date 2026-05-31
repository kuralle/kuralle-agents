import type { LanguageModel } from 'ai';
import { defineAgent } from '@kuralle-agents/core';
import type { AgentConfig } from '@kuralle-agents/core';
import type { VoiceAgentConfig } from './types.js';

function resolveVoiceInstructions(agent: VoiceAgentConfig): string | undefined {
  const extended = agent as VoiceAgentConfig & { instructions?: string };
  if (typeof extended.instructions === 'string') return extended.instructions;
  if (typeof agent.prompt === 'string') return agent.prompt;
  return undefined;
}

export function voiceAgentToRuntimeAgent(
  agent: VoiceAgentConfig,
  defaultModel?: LanguageModel,
): AgentConfig {
  const model = (agent as { model?: LanguageModel }).model ?? defaultModel;
  const instructions = resolveVoiceInstructions(agent);
  if (agent.flow) {
    return defineAgent({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      instructions,
      model,
      tools: agent.tools,
      flows: [agent.flow],
    });
  }
  return defineAgent({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    instructions,
    model,
    tools: agent.tools,
  });
}
