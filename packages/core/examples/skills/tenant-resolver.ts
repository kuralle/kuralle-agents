/**
 * Skills v2, live — mode 4 of 4: resolver (`SkillResolver`).
 *
 * One agent definition, a per-session skill set resolved from tenant state. Proves two things
 * live: (1) two sessions against the same agent see genuinely different catalogs — not a shared
 * mutable roster — and (2) the resolver runs once per session, not once per turn: a second turn
 * on the same session reuses the persisted result instead of calling the resolver again.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/core/examples/skills/tenant-resolver.ts
 */
import { xai } from '@ai-sdk/xai';
import { createRuntime, defineAgent, defineSkill } from '../../src/index.js';
import type { StreamPart } from '../../src/types/stream.js';

const TENANT_DISCOUNTS: Record<string, string> = {
  'tenant-acme': '10%',
  'tenant-globex': '25%',
};

let resolverCalls = 0;

const agent = defineAgent({
  id: 'sales',
  model: xai('grok-3'),
  instructions: 'You are a sales assistant. Load the matching skill before answering discount questions.',
  skills: [
    async ({ session }) => {
      resolverCalls += 1;
      const discount = TENANT_DISCOUNTS[session.id] ?? '0%';
      return [
        defineSkill({
          name: 'tenant-discount',
          description: "This tenant's current discount rate. Use when asked about the discount.",
          instructions: `The discount for this account is exactly ${discount}. State that figure.`,
        }),
      ];
    },
  ],
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'sales',
  defaultModel: xai('grok-3'),
});

async function ask(sessionId: string, input: string): Promise<string> {
  const handle = runtime.run({ sessionId, input });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += part.payload.delta ?? '';
  }
  return text.trim();
}

async function main(): Promise<void> {
  const acme = await ask('tenant-acme', 'What is our discount?');
  console.log('--- tenant-acme, turn 1 ---\n' + acme + '\n');

  const globex = await ask('tenant-globex', 'What is our discount?');
  console.log('--- tenant-globex, turn 1 ---\n' + globex + '\n');

  const callsAfterFirstTurns = resolverCalls;

  const acmeAgain = await ask('tenant-acme', 'Remind me of that number.');
  console.log('--- tenant-acme, turn 2 ---\n' + acmeAgain + '\n');

  console.log(`resolver invocations: ${resolverCalls} (after two sessions' first turns: ${callsAfterFirstTurns})`);

  const failures: string[] = [];
  if (!acme.includes('10%')) failures.push('tenant-acme did not receive its own 10% discount');
  if (!globex.includes('25%')) failures.push('tenant-globex did not receive its own 25% discount');
  if (acme.includes('25%')) failures.push('tenant-acme leaked tenant-globex\'s discount');
  if (callsAfterFirstTurns !== 2) failures.push(`expected exactly 2 resolver calls after 2 sessions' first turns, got ${callsAfterFirstTurns}`);
  if (!acmeAgain.includes('10%')) failures.push('tenant-acme turn 2 did not have the resolved skill available');
  if (resolverCalls !== callsAfterFirstTurns) {
    failures.push(`resolver ran again on tenant-acme's second turn (${resolverCalls} calls) — expected reuse of the persisted result`);
  }

  if (failures.length > 0) {
    console.error('FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('PASS — per-tenant resolution held, and the resolver ran once per session, not once per turn.');
}

await main();
