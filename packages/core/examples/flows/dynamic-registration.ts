#!/usr/bin/env bun

import { createXai } from '@ai-sdk/xai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import type { FlowDefinition } from '../../src/flows/definition/index.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';
import type { ChannelDriver } from '../../src/types/channel.js';

loadExampleEnv(import.meta.url);

function exampleModel() {
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    return { model: createXai({ apiKey: xaiKey })('grok-3'), label: 'xai:grok-3' };
  }
  return requireLiveModel();
}

const { model } = exampleModel();

const definition: FlowDefinition = {
  name: 'refund',
  description: 'Refund a payment',
  start: 'say',
  nodes: [
    {
      kind: 'reply',
      id: 'say',
      response: { template: 'Refund started via a flow registered at runtime.' },
      next: { end: 'done' },
    },
  ],
};

export const agent = defineAgent({
  id: 'dynamic-registration',
  name: 'Dynamic registration',
  instructions: 'You help with refunds. Enter the refund flow by name when it is available.',
  model,
});

export default agent;

async function main(): Promise<void> {
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
    flowDefinitionsStore: new MemoryFlowDefinitionsStore(),
  });

  await runtime.addDynamicFlows([definition], { agentId: agent.id });

  let turns = 0;
  const driver: ChannelDriver = {
    async runAgentTurn(node) {
      turns += 1;
      if (turns === 1 && 'enter_flow' in (node.tools ?? {})) {
        return {
          text: '',
          toolResults: [
            {
              name: 'enter_flow',
              args: { flowName: 'refund', reason: 'user asked' },
              result: { __enterFlow: true, flowName: 'refund' },
            },
          ],
          control: { type: 'enterFlow', flowName: 'refund' },
        };
      }
      return { text: 'How can I help?', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };

  const input = 'Please start a refund';
  console.log('Dynamic flow registration (addDynamicFlows at runtime)');
  console.log('Registered flow bundle: refund');
  console.log(`\n${'='.repeat(70)}\nUser: ${input}\n${'='.repeat(70)}`);

  const handle = runtime.run({ sessionId: 'dynamic-registration-example', input, driver });
  let response = '';
  let flowEnded = false;
  for await (const part of handle.events) {
    if (part.type === 'text-delta') response += part.payload.delta;
    if (part.type === 'flow-enter') console.log(`[Flow] ${part.payload.flow}`);
    if (part.type === 'flow-end') {
      flowEnded = true;
      console.log(`[Flow end] ${part.payload.flow} (${part.payload.reason})`);
    }
  }
  await handle;
  console.log(`Assistant: ${response.trim()}`);
  console.log('\nTranscript:');
  console.log(`user: ${input}`);
  console.log(`assistant: ${response.trim()}`);
  if (!flowEnded) {
    throw new Error('Expected the dynamically registered refund flow to reach a terminal node');
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
