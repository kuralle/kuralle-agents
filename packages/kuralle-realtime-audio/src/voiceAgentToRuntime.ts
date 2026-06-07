import type { LanguageModel } from 'ai';
import { defineAgent, wrapAiSdkTool, type EffectTool } from '@kuralle-agents/core';
import type { AgentConfig } from '@kuralle-agents/core';
import type { ToolSet } from '@kuralle-agents/core/types';
import type { VoiceAgentConfig } from './types.js';

function voiceToolsToAgentTools(tools?: ToolSet): Record<string, EffectTool> | undefined {
  if (!tools) return undefined;
  const out: Record<string, EffectTool> = {};
  for (const [name, aiTool] of Object.entries(tools)) {
    out[name] = wrapAiSdkTool(name, aiTool);
  }
  return out;
}

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
      tools: voiceToolsToAgentTools(agent.tools),
      flows: [agent.flow],
    });
  }
  return defineAgent({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    instructions,
    model,
    tools: voiceToolsToAgentTools(agent.tools),
  });
}
