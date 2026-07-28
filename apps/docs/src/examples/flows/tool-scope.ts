import { openai } from '@ai-sdk/openai';
import {
  defineAgent,
  defineFlow,
  defineTool,
  reply,
  buildToolSet,
} from '@kuralle-agents/core';
import { z } from 'zod';

const dispatch_vendor_with_approval = defineTool({
  name: 'dispatch_vendor_with_approval',
  description: 'Request owner approval before dispatching a vendor over the spend cap.',
  input: z.object({
    workOrderId: z.string(),
    vendorId: z.string(),
    estimateUsd: z.number(),
  }),
  needsApproval: true,
  execute: async (args) => ({ requested: true, ...args }),
});

const lookup_unit = defineTool({
  name: 'lookup_unit',
  description: 'Look up a unit.',
  input: z.object({ unitId: z.string() }),
  execute: async ({ unitId }) => ({ id: unitId }),
});

const notify_resident = defineTool({
  name: 'notify_resident',
  description: 'SMS the resident.',
  input: z.object({ unitId: z.string(), message: z.string() }),
  execute: async () => ({ sent: true }),
});

// Before toolScope: putting the approval tool on the node still left every agent
// tool visible, so the model could approve a dispatch without entering the flow.
const confirmDispatch = reply({
  id: 'confirm_dispatch',
  toolScope: 'base',
  tools: buildToolSet({ dispatch_vendor_with_approval }),
  instructions:
    'Call dispatch_vendor_with_approval with the pending work order, vendor, and estimate. ' +
    'Tell the manager you requested owner approval and stop.',
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'dispatch_vendor_with_approval')
      ? { end: 'approval_requested' }
      : 'stay',
});

const agent = defineAgent({
  id: 'property-manager',
  instructions: 'Property management assistant.',
  model: openai('gpt-4o-mini'),
  // Approval tool is NOT loose — only confirm_dispatch can see it.
  tools: { notify_resident },
  globalTools: { lookup_unit },
  flows: [
    defineFlow({
      name: 'dispatch_vendor_for_work_order',
      description: 'Send a vendor when the manager asks to dispatch.',
      start: confirmDispatch,
      nodes: [confirmDispatch],
    }),
  ],
});

void agent;
