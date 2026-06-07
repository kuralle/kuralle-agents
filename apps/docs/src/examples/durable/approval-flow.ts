import { openai } from '@ai-sdk/openai';
import { defineAgent, defineFlow, action, collect, reply, defineTool } from '@kuralle-agents/core';
import { z } from 'zod';

const processRefund = defineTool({
  name: 'processRefund',
  description: 'Issue a refund to the customer',
  input: z.object({ amount: z.number() }),
  execute: async ({ amount }) => ({ refunded: amount }),
});

const confirmed = reply({
  id: 'confirmed',
  instructions: 'Tell the customer the refund was approved and processed, then end.',
  next: () => ({ end: 'refunded' }),
});

const declined = reply({
  id: 'declined',
  instructions: 'Tell the customer the refund was declined by a supervisor, then end.',
  next: () => ({ end: 'declined' }),
});

// An `action` node runs no model turn. It pauses for human approval — a durable
// signal that survives a process restart — then runs the refund tool exactly once.
const issueRefund = action({
  id: 'issue_refund',
  run: async (state, ctx) => {
    const amount = Number(state.amount);

    // Suspends the run: status -> 'paused', a SuspendError unwinds the turn,
    // and the run is persisted. It resumes only when an `__approval` signal is
    // delivered via runtime.run({ signalDelivery }).
    const decision = await ctx.approve({
      title: `Approve $${amount} refund?`,
      description: `Customer requested a refund of $${amount}.`,
    });

    if (!decision.approved) {
      return { goto: declined };
    }

    // Recorded in the effect log. If the run resumes after this point, the
    // recorded result is replayed instead of charging the customer twice.
    const receipt = await ctx.tool('processRefund', { amount });
    return { goto: confirmed, data: { receipt } };
  },
});

const collectAmount = collect({
  id: 'collect_amount',
  schema: z.object({ amount: z.number() }),
  required: ['amount'],
  instructions: (missing) => `Ask the customer for: ${missing.join(', ')}`,
  onComplete: () => issueRefund,
});

export const refundAgent = defineAgent({
  id: 'refunds',
  instructions: 'You process customer refund requests.',
  model: openai('gpt-4o-mini'),
  tools: { processRefund },
  flows: [
    defineFlow({
      name: 'refund',
      description: 'Collect a refund amount, get supervisor approval, then refund',
      start: collectAmount,
      nodes: [collectAmount, issueRefund, confirmed, declined],
    }),
  ],
});
