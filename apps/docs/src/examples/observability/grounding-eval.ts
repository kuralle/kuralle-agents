import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';

const lastInvoice = defineTool({
  name: 'last_invoice',
  description: "Return the caller's last invoice total",
  input: z.object({}),
  execute: async () => ({ invoiceUsd: 18.5, date: '2026-07-01' }),
});

const agent = defineAgent({
  id: 'billing',
  instructions: 'Answer billing questions using last_invoice. Keep replies short.',
  model: openai('gpt-4o-mini'),
  tools: { last_invoice: lastInvoice },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'billing' });

// One complete, JSON-serializable turn instead of a live stream — built for evaluators.
const trace = await runtime.runOnce({
  sessionId: 'grounding-eval-1',
  input: 'What was my last invoice total?',
});

// Grounding check: the answer must be backed by an actual tool result, not invented.
const grounded =
  trace.usedTool &&
  trace.toolResults.some(({ result }) =>
    trace.answer.includes(String((result as { invoiceUsd: number }).invoiceUsd)),
  );

console.log({ answer: trace.answer, usedTool: trace.usedTool, grounded, traceId: trace.traceId });
