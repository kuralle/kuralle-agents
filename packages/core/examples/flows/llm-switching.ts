#!/usr/bin/env node

import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import type { AgentConfig } from '../../src/authoring/defineAgent.js';
import type { HandoffResult } from '../../src/tools/handoff.js';
import { loadExampleEnv, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

type ProviderName = 'OpenAI' | 'Google' | 'Anthropic' | 'AWS';

const providerToAgent: Record<ProviderName, string> = {
  OpenAI: 'llm-openai',
  Google: 'llm-google',
  Anthropic: 'llm-anthropic',
  AWS: 'llm-aws',
};

const rolePrompt =
  "You are a helpful LLM in a WebRTC call. Your goal is to demonstrate your capabilities in a succinct way. Your output will be converted to audio so don't include special characters in your answers. Respond to what the user said in a creative and helpful way.";

function createProviderFlow(currentAgentId: string, model: ReturnType<typeof openai>) {
  const summary = reply({
    id: 'summary',
    instructions:
      'Say the conversation summary, which was already retrieved (do not invoke summarize_conversation again).',
    context: 'reset_with_summary',
    model,
    tools: buildToolSet({
      switch_llm: defineTool({
        name: 'switch_llm',
        description: 'Switch the current LLM service.',
        input: z.object({ llm: z.enum(['OpenAI', 'Google', 'Anthropic', 'AWS']) }),
        execute: async ({ llm }) => switchProvider(currentAgentId, llm),
      }),
      get_current_weather: defineTool({
        name: 'get_current_weather',
        description: 'Get the current weather for a location and format.',
        input: z.object({
          location: z.string(),
          format: z.enum(['celsius', 'fahrenheit']),
        }),
        execute: async ({ format }) => ({
          status: 'success',
          conditions: 'sunny',
          temperature: format === 'fahrenheit' ? 75 : 24,
        }),
      }),
    }),
    next: (turn) => {
      const handoff = turn.toolResults.find((r) => r.name === 'switch_llm');
      if (handoff?.result && typeof handoff.result === 'object' && '__handoff' in handoff.result) {
        const h = handoff.result as HandoffResult;
        return { handoff: h.targetAgentId, reason: h.reason };
      }
      return 'stay';
    },
  });

  const main = reply({
    id: 'main',
    instructions: 'Say a brief hello.',
    model,
    tools: buildToolSet({
      switch_llm: defineTool({
        name: 'switch_llm',
        description: 'Switch the current LLM service.',
        input: z.object({ llm: z.enum(['OpenAI', 'Google', 'Anthropic', 'AWS']) }),
        execute: async ({ llm }) => switchProvider(currentAgentId, llm),
      }),
      get_current_weather: defineTool({
        name: 'get_current_weather',
        description: 'Get the current weather for a location and format.',
        input: z.object({
          location: z.string(),
          format: z.enum(['celsius', 'fahrenheit']),
        }),
        execute: async ({ format }) => ({
          status: 'success',
          conditions: 'sunny',
          temperature: format === 'fahrenheit' ? 75 : 24,
        }),
      }),
      summarize_conversation: defineTool({
        name: 'summarize_conversation',
        description: 'Summarize the conversation so far.',
        input: z.object({}),
        execute: async () => ({ summarized: true }),
      }),
    }),
    next: (turn) => {
      const handoff = turn.toolResults.find((r) => r.name === 'switch_llm');
      if (handoff?.result && typeof handoff.result === 'object' && '__handoff' in handoff.result) {
        const h = handoff.result as HandoffResult;
        return { handoff: h.targetAgentId, reason: h.reason };
      }
      if (turn.toolResults.some((r) => r.name === 'summarize_conversation')) return summary;
      return 'stay';
    },
  });

  return defineFlow({
    name: `llm-switch-${currentAgentId}`,
    description: `${currentAgentId} provider demo flow`,
    start: main,
    nodes: [main, summary],
  });
}

function switchProvider(currentAgentId: string, llm: ProviderName): HandoffResult | Record<string, string> {
  const targetAgentId = providerToAgent[llm];
  if (targetAgentId === currentAgentId) {
    return { status: 'success', message: `Already using ${llm} LLM service.` };
  }
  return {
    __handoff: true,
    targetAgentId,
    targetAgent: targetAgentId,
    reason: `Switch requested to ${llm}`,
    summary: `Switching active provider from ${currentAgentId} to ${targetAgentId}.`,
  };
}

const model = openai('gpt-4o-mini');

function createProviderAgent(id: string, name: string): AgentConfig {
  return defineAgent({
    id,
    name,
    description: `${name} provider persona.`,
    instructions: rolePrompt,
    model,
    flows: [createProviderFlow(id, model)],
    handoffs: Object.values(providerToAgent).filter((target) => target !== id),
  });
}

const agents: AgentConfig[] = [
  createProviderAgent('llm-openai', 'OpenAI'),
  createProviderAgent('llm-google', 'Google'),
  createProviderAgent('llm-anthropic', 'Anthropic'),
  createProviderAgent('llm-aws', 'AWS'),
];

runV2Conversation({
  title: 'Pipecat LLM Switching (v2)',
  agent: agents[0]!,
  agents,
  model,
  prompts: [
    'Hi there',
    'Please use switch_llm and switch to Google.',
    'What is the weather in San Francisco in fahrenheit?',
    'Please summarize this conversation so far',
    'Please use switch_llm and switch to AWS.',
    'Give me a quick creative goodbye',
  ],
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
