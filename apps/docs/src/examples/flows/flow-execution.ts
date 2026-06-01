import { openai } from '@ai-sdk/openai';
import { defineAgent, defineFlow, collect, action, reply, defineTool } from '@kuralle-agents/core';
import { z } from 'zod';

const bookShipment = defineTool({
  name: 'bookShipment',
  description: 'Book a shipment to the given address',
  input: z.object({ address: z.string() }),
  execute: async ({ address }) => ({ id: `trk_${address.length}` }),
});

const done = reply({
  id: 'done',
  // `reset_with_summary` collapses the gathering turns into a single summary
  // line before this node runs, keeping the model focused on the confirmation.
  context: 'reset_with_summary',
  instructions: 'Confirm the shipment was booked with its tracking id, then end.',
  next: () => ({ end: 'booked' }),
});

const book = action({
  id: 'book',
  // `outputSchema` gates the transition OUT of this node. It validates the
  // merged { ...state, ...data }; if it fails, runFlow holds position
  // (awaitingUser) instead of advancing to `done`.
  outputSchema: z.object({ trackingId: z.string().min(1) }),
  run: async (state, ctx) => {
    const receipt = (await ctx.tool('bookShipment', { address: state.address })) as { id: string };
    // `data` is merged into flow state on the transition, so `done` and the
    // verify check above both see `trackingId`.
    return { goto: done, data: { trackingId: receipt.id } };
  },
});

const getAddress = collect({
  id: 'get_address',
  schema: z.object({ address: z.string() }),
  required: ['address'],
  maxTurns: 5,
  instructions: (missing) => `Ask the customer for: ${missing.join(', ')}`,
  onComplete: () => book,
});

export const shippingAgent = defineAgent({
  id: 'shipping',
  instructions: 'You book shipments for customers.',
  model: openai('gpt-4o-mini'),
  effectTools: { bookShipment },
  flows: [
    defineFlow({
      name: 'ship',
      description: 'Collect an address, book the shipment, then confirm',
      start: getAddress,
      nodes: [getAddress, book, done],
      maxOscillations: 2,
    }),
  ],
});
