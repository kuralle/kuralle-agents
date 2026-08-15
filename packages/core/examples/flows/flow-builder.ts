#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import {
  createFlowBuilderAgent,
  FLOW_BUILDER_TOOL_NAMES,
  type FlowBuilderHost,
  type SaveFlowResult,
} from '../../src/flows/authoring/index.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';
import type { ChannelDriver } from '../../src/types/channel.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const lookup = defineTool({
  name: 'lookup',
  description: 'Look up refund eligibility for an account id and return a verdict.',
  input: z.object({ accountId: z.string().min(1) }),
  execute: async ({ accountId }) => {
    const eligible = accountId.startsWith('acc-');
    return {
      accountId,
      eligible,
      verdict: eligible ? 'eligible for refund' : 'not eligible',
    };
  },
});

export const clerk = defineAgent({
  id: 'refund-clerk',
  name: 'Refund clerk',
  instructions: 'You check refund eligibility. Enter the refund-eligibility flow when it is available.',
  model,
  tools: { lookup },
});

let runtime: ReturnType<typeof createRuntime>;

const host: FlowBuilderHost = {
  targetAgentId: clerk.id,
  getRuntime: () => {
    if (!runtime) {
      throw new Error('flow-builder host runtime is not bound');
    }
    return runtime;
  },
  tools: () => clerk.tools ?? {},
  flows: () =>
    (clerk.flows ?? []).map((flow) => ({
      id: flow.name,
      name: flow.name,
      description: flow.description,
    })),
  agents: () => [{ id: clerk.id, name: clerk.name, description: clerk.instructions as string }],
};

export const agent = createFlowBuilderAgent({
  id: 'flow-builder',
  name: 'Flow builder',
  model,
  surfaceInstructions:
    'You author flows for the refund clerk on this runtime. Discover catalogs first. Prefer response.template over generate: true. After a successful save, confirm the flow name in one short sentence and stop.',
  host,
});

export default agent;

const BRIEF =
  'build a refund-eligibility flow that collects an account id, checks eligibility with the lookup tool, and replies with the verdict';

function savedNamesFrom(result: unknown): string[] | undefined {
  const value = result as SaveFlowResult | undefined;
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) return undefined;
  return value.names;
}

async function authorFlow(): Promise<string> {
  const sessionId = 'flow-builder-author';
  let saved: string | undefined;
  const prompts = [
    BRIEF,
    'Apply any repair actions from save_flow and call save_flow once more with the complete definition. Do not ask questions.',
  ];

  for (const input of prompts) {
    if (saved) break;
    console.log(`\n${'='.repeat(70)}\nUser: ${input}\n${'='.repeat(70)}`);
    const handle = runtime.run({ sessionId, input, agentId: agent.id });
    let response = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') response += part.payload.delta;
      if (part.type === 'tool-call') console.log(`[Tool call] ${part.payload.toolName}`);
      if (part.type === 'tool-result') {
        console.log(`[Tool result] ${part.payload.toolName}`);
        if (part.payload.toolName === FLOW_BUILDER_TOOL_NAMES.saveFlow) {
          const names = savedNamesFrom(part.payload.result);
          if (names && names.length > 0) saved = names[names.length - 1];
        }
      }
    }
    await handle;
    console.log(`Assistant: ${response.trim()}`);
  }

  if (!saved) {
    throw new Error('Builder never registered a flow (save_flow did not succeed)');
  }
  return saved;
}

async function executeFlow(flowName: string): Promise<void> {
  const sessionId = 'flow-builder-exec';
  let flowEnded = false;
  let flowEntered = false;

  const enterDriver: ChannelDriver = {
    async runAgentTurn(node) {
      if ('enter_flow' in (node.tools ?? {})) {
        return {
          text: '',
          toolResults: [
            {
              name: 'enter_flow',
              args: { flowName, reason: 'execute authored flow' },
              result: { __enterFlow: true, flowName },
            },
          ],
          control: { type: 'enterFlow', flowName },
        };
      }
      return { text: '', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };

  async function turn(input: string, driver?: ChannelDriver) {
    const sep = '='.repeat(70);
    console.log(`\n${sep}\nUser: ${input}\n${sep}`);
    const handle = runtime.run({
      sessionId,
      input,
      agentId: clerk.id,
      ...(driver ? { driver } : {}),
    });
    let response = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') response += part.payload.delta;
      if (part.type === 'node-enter') console.log(`[Node] ${part.payload.nodeName}`);
      if (part.type === 'flow-transition') {
        console.log(`[Transition] ${part.payload.from} -> ${part.payload.to}`);
      }
      if (part.type === 'flow-enter') {
        flowEntered = true;
        console.log(`[Flow] ${part.payload.flow}`);
      }
      if (part.type === 'tool-call') console.log(`[Tool call] ${part.payload.toolName}`);
      if (part.type === 'flow-end') {
        flowEnded = true;
        console.log(`[Flow end] ${part.payload.flow} (${part.payload.reason})`);
      }
    }
    await handle;
    console.log(`Assistant: ${response.trim()}`);
  }

  await turn(`Start ${flowName}`, enterDriver);
  if (!flowEntered) {
    throw new Error(`Saved flow "${flowName}" never executed (no flow-enter)`);
  }
  if (!flowEnded) {
    await turn('My account id is acc-1');
  }
  if (!flowEnded) {
    throw new Error(`Saved flow "${flowName}" never reached a terminal node`);
  }
}

async function main(): Promise<void> {
  runtime = createRuntime({
    agents: [agent, clerk],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
    flowDefinitionsStore: new MemoryFlowDefinitionsStore(),
  });

  console.log('Flow builder (discover → author → save → execute)');
  const flowName = await authorFlow();
  console.log(`Registered flow: ${flowName}`);
  await executeFlow(flowName);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
