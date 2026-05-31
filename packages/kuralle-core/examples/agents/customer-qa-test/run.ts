#!/usr/bin/env node
// QA: ToolLoopAgent judges Kuralle v2 support agent responses.

import { z } from 'zod';
import { ToolLoopAgent, tool } from 'ai';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../../src/runtime/openRun.js';
import { loadExampleEnv, requireLiveModel } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const getOrderStatus = defineTool({
  name: 'getOrderStatus',
  description: 'Get order status by order number',
  input: z.object({ orderNumber: z.string() }),
  execute: async ({ orderNumber }) => ({ orderNumber, status: 'shipped', estimatedDelivery: 'March 5' }),
});

const lookupOrder = defineTool({
  name: 'lookupOrder',
  description: 'Look up order by order number or email',
  input: z.object({ orderNumber: z.string().optional(), email: z.string().optional() }),
  execute: async () => ({ found: true, orderNumber: '12345', total: 149.99 }),
});

const getRefundPolicy = defineTool({
  name: 'getRefundPolicy',
  description: 'Get refund policy',
  input: z.object({ productType: z.string().optional() }),
  execute: async () => ({ policy: '30 days', restockingFee: '15% for opened' }),
});

const supportTools = { getOrderStatus, lookupOrder, getRefundPolicy };

const supportAgent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  description: 'Handles customer support.',
  instructions: 'Helpful customer support specialist. Be concise.',
  model,
  tools: buildToolSet(supportTools),
  effectTools: supportTools,
});

const qaRecordFinding = tool({
  description: 'Record a finding from your QA evaluation',
  inputSchema: z.object({
    finding: z.string(),
    severity: z.enum(['critical', 'major', 'minor']),
    aspect: z.enum(['accuracy', 'completeness', 'clarity', 'empathy', 'tool_usage']),
  }),
  execute: async (input) => ({ recorded: true, ...input }),
});

const qaContinueTesting = tool({
  description: 'Continue to the next test scenario',
  inputSchema: z.object({ nextScenario: z.string() }),
  execute: async (input) => ({ continuing: true, ...input }),
});

const qaFinish = tool({
  description: 'Finish QA testing and provide summary',
  inputSchema: z.object({ summary: z.string(), totalFindings: z.number() }),
  execute: async (input) => ({ finished: true, ...input }),
});

const qaAgent = new ToolLoopAgent({
  model,
  instructions: `QA tester evaluating customer support responses. Find FLAWS in accuracy, completeness, clarity, empathy, tool usage.
Use qaRecordFinding for issues, qaContinueTesting for next scenario, qaFinish when done.`,
  tools: { qaRecordFinding, qaContinueTesting, qaFinish },
});

const scenarios = [
  { input: 'I want to return something but I dont have the order number.', description: 'Missing order number - can agent offer alternatives?' },
  { input: 'What is your refund policy?', description: 'Generic policy question - does agent clarify product type?' },
  { input: 'The item was delivered but damaged. I dont have photos.', description: 'Damaged item without proof - does agent ask for evidence?' },
  { input: 'Can I get a refund for an order from 2 months ago?', description: 'Old order - does agent check policy window?' },
  { input: 'I ordered wrong size but already used the product. Can I return it?', description: 'Used item return - does agent address restocking fee?' },
];

async function runQATest(): Promise<void> {
  console.log('='.repeat(70));
  console.log('QA TEST: ToolLoopAgent evaluating Kuralle v2 support agent');
  console.log('='.repeat(70));

  const runtime = createRuntime({
    agents: [supportAgent],
    defaultAgentId: 'support',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });

  const sessionId = newSessionId();
  const findings: Array<{ scenario: string; finding: string; severity: string }> = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    console.log(`\n${'─'.repeat(70)}\nSCENARIO ${i + 1}/${scenarios.length}: ${scenario.description}\nCustomer: ${scenario.input}\n${'─'.repeat(70)}`);

    let supportResponse = '';
    const handle = runtime.run({ sessionId, input: scenario.input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') supportResponse += part.text;
    }
    await handle;
    console.log(`Support: ${supportResponse.slice(0, 200)}${supportResponse.length > 200 ? '...' : ''}`);

    console.log(`\n${'─'.repeat(70)}\nQA Agent evaluating...`);
    const qaResult = await qaAgent.generate({
      prompt: `CUSTOMER SAID: ${scenario.input}\n\nSUPPORT REPLY: ${supportResponse}\n\nEvaluate using qaRecordFinding for issues, then qaContinueTesting.`,
    });
    console.log(`[QA] Response: ${qaResult.text.slice(0, 300)}`);

    if (qaResult.steps) {
      for (const step of qaResult.steps) {
        for (const tc of step.toolCalls ?? []) {
          const tcAny = tc as { toolName: string; input?: Record<string, unknown>; args?: Record<string, unknown> };
          console.log(`[QA Tool] ${tc.toolName}: ${JSON.stringify(tcAny.input ?? tcAny.args ?? {}).slice(0, 200)}`);
          if (tc.toolName === 'qaRecordFinding') {
            const input = tcAny.input ?? tcAny.args;
            if (input) findings.push({ scenario: scenario.description, finding: String(input.finding ?? 'unknown'), severity: String(input.severity ?? 'minor') });
          }
        }
      }
    }
  }

  console.log(`\n${'='.repeat(70)}\nQA TEST SUMMARY\n${'='.repeat(70)}`);
  console.log(`Total scenarios: ${scenarios.length}`);
  console.log(`Total findings: ${findings.length}`);
  if (findings.length > 0) {
    for (const [label, sev] of [['Critical', 'critical'], ['Major', 'major'], ['Minor', 'minor']] as const) {
      console.log(`  ${label}: ${findings.filter((f) => f.severity === sev).length}`);
    }
    findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.severity}] ${f.finding}`));
  } else {
    console.log('\nNo issues detected.');
  }
}

runQATest().catch(console.error);
