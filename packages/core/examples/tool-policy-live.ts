/**
 * Policy, live.
 *
 * `needsApproval?: boolean` answers one question — pause for a human? — and cannot express
 * "this worker may look but not touch". A factory needs that: an explorer agent that reads a
 * repo to answer a question must not be able to write to it, and the restriction has to hold
 * at the gate rather than in the prompt. This session repeatedly showed prompt-level rules
 * failing and tool-boundary rules holding.
 *
 * Run:
 *   OPENAI_API_KEY=... bun packages/core/examples/tool-policy-live.ts
 */
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent, defineTool, readOnlyPolicy } from '../src/index.js';
import type { StreamPart } from '../src/types/stream.js';

const audit: string[] = [];

const read_file = defineTool({
  name: 'read_file',
  description: 'Read a file from the project.',
  replay: false,
  parallelSafe: true,
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    audit.push(`READ ${path}`);
    return { path, content: 'export const VERSION = "0.17.0";\n' };
  },
});

const write_file = defineTool({
  name: 'write_file',
  description: 'Overwrite a file in the project.',
  input: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path }) => {
    // If a read-only worker ever reaches here, the gate failed. That is the whole test.
    audit.push(`!!! WROTE ${path}`);
    return { written: true, path };
  },
});

const model = openai('gpt-4.1-mini');

const explorer = defineAgent({
  id: 'explorer',
  model,
  instructions:
    'You inspect a codebase and answer questions. Use the tools available to you. ' +
    'If an action is refused, say so plainly and do not try to work around it.',
  globalTools: { read_file, write_file },
  // The whole point: write_file is registered and model-visible, and still cannot run.
  policy: readOnlyPolicy(['write_file']),
});

const runtime = createRuntime({ agents: [explorer], defaultAgentId: 'explorer', defaultModel: model });

async function turn(sessionId: string, input: string): Promise<string> {
  const handle = runtime.run({ sessionId, input });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += part.payload.delta ?? '';
  }
  return text.trim();
}

console.log('── T1: a read it IS allowed to do ──');
console.log(await turn('policy-live', 'What version is declared in src/version.ts?'), '\n');

console.log('── T2: a write it is NOT ──');
console.log(await turn('policy-live', 'Now bump that version to 0.18.0 in src/version.ts.'), '\n');

console.log('── audit trail (what actually executed) ──');
for (const entry of audit) console.log(' ', entry);

const leaked = audit.filter((e) => e.startsWith('!!!'));
console.log(`\nreads: ${audit.filter((e) => e.startsWith('READ')).length}`);
console.log(`writes that reached execute: ${leaked.length}`);
console.log(leaked.length === 0 ? '\nPASS — the gate held.' : '\nFAIL — a write escaped the policy.');
process.exit(leaked.length === 0 ? 0 : 1);
