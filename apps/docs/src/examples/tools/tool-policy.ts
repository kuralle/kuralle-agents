import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import {
  ALLOW,
  composePolicies,
  createRuntime,
  defineAgent,
  defineTool,
  readOnlyPolicy,
  type Policy,
} from '@kuralle-agents/core';

const read_file = defineTool({
  name: 'read_file',
  description: 'Read a file from the project.',
  replay: false,
  parallelSafe: true,
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => ({ path, content: '…' }),
});

const write_file = defineTool({
  name: 'write_file',
  description: 'Overwrite a file in the project.',
  input: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path }) => ({ written: true, path }),
});

const dispatch_vendor = defineTool({
  name: 'dispatch_vendor',
  description: 'Dispatch a vendor to a unit.',
  input: z.object({ unitId: z.string(), estimateUsd: z.number() }),
  execute: async ({ unitId, estimateUsd }) => ({ dispatched: true, unitId, estimateUsd }),
});

// A rule the model cannot argue with, and that `needsApproval` cannot express: the same
// tool is allowed or gated depending on the arguments it was called with.
const spendCap: Policy = {
  decide: ({ toolName, args }) => {
    if (toolName !== 'dispatch_vendor') return ALLOW;
    const { estimateUsd } = args as { estimateUsd: number };
    return estimateUsd > 250
      ? { kind: 'ask', title: `Approve $${estimateUsd} — over the $250 cap` }
      : ALLOW;
  },
};

// A worker that may look but not touch. write_file stays registered and model-visible;
// the gate is what stops it, not the prompt.
export const explorer = defineAgent({
  id: 'explorer',
  model: openai('gpt-4.1-mini'),
  instructions: 'Inspect the codebase and answer questions.',
  globalTools: { read_file, write_file },
  policy: readOnlyPolicy(['write_file']),
});

export const dispatcher = defineAgent({
  id: 'dispatcher',
  model: openai('gpt-4.1-mini'),
  instructions: 'Handle maintenance requests.',
  globalTools: { read_file, dispatch_vendor },
  // Composition can only ever be MORE restrictive: a `deny` from either policy wins, and
  // no later policy can turn it back into an allow.
  policy: composePolicies(spendCap, readOnlyPolicy([])),
});

export const runtime = createRuntime({
  agents: [explorer, dispatcher],
  defaultAgentId: 'dispatcher',
  // Runtime default for any agent that does not set its own.
  policy: { decide: () => ALLOW },
});
