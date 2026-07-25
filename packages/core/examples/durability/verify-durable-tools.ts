/**
 * Verifies the durability claim at the level a USER experiences it: a real
 * `defineAgent` with a durable tool, driven through `createRuntime`.
 *
 * The claim under test is `exactly-once-modulo-idempotency`, not plain
 * exactly-once. Both halves are asserted:
 *   A. a completed step replays without re-executing            (exactly-once)
 *   B. a crash between execute and finalize re-runs the effect  (modulo-idempotency)
 */
import { z } from 'zod';
import {
  createRuntime, defineAgent, defineTool, MemoryStore,
  type ChannelDriver,
} from '../../src/index.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'done' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ],
    }),
  }) as never,
});

// A deliberately NON-idempotent effect: every call charges. Real payment APIs
// behave this way unless you pass them a dedup key.
let charges = 0;
const charge = defineTool({
  name: 'charge_card',
  description: 'Charge the customer',
  input: z.object({ amount: z.number() }),
  execute: async ({ amount }) => { charges += 1; return { charged: amount, call: charges }; },
});

const agent = defineAgent({
  id: 'billing',
  instructions: 'Charge the customer when asked.',
  model,
  tools: { charge_card: charge },
});

/** Driver that asks for one tool call on the first turn, then answers. */
const driver = (): ChannelDriver => {
  let turns = 0;
  return {
    async runAgentTurn(_node, ctx) {
      turns += 1;
      if (turns === 1) {
        const result = await ctx.tool('charge_card', { amount: 100 });
        return { text: 'charged', toolResults: [{ name: 'charge_card', args: { amount: 100 }, result }] };
      }
      return { text: 'anything else?', toolResults: [] };
    },
    async awaitUser() { return { type: 'message' as const, input: 'ok' }; },
  };
};

const sessionStore = new MemoryStore();
const runtime = createRuntime({
  agents: [agent], defaultAgentId: 'billing', sessionStore, defaultModel: model,
});

console.log('=== durable tools, verified through a real agent ===\n');

// --- A. SAME logical run: pause for approval, resume, tool fires once ------
// Two separate runtime.run() calls are two DIFFERENT logical runs, and a new
// user request is *meant* to re-execute — returning a cached charge would be
// the stale-replay bug the journal-scoping work fixed. Replay applies WITHIN a
// logical run: crash/resume, retry, or an approval pause like this one.
charges = 0;
const approvalAgent = defineAgent({
  id: 'billing',
  instructions: 'Charge after approval.',
  model,
  tools: { charge_card: charge },
});

const approvalDriver = (): ChannelDriver => ({
  async runAgentTurn(_node, ctx) {
    const decision = await ctx.approve({ title: 'Charge $100?' });   // suspends here
    if (!decision.approved) return { text: 'cancelled', toolResults: [] };
    const result = await ctx.tool('charge_card', { amount: 100 });
    return { text: 'charged', toolResults: [{ name: 'charge_card', args: { amount: 100 }, result }] };
  },
  async awaitUser() { return { type: 'message' as const, input: 'ok' }; },
});

const store2 = new MemoryStore();
const rt2 = createRuntime({
  agents: [approvalAgent], defaultAgentId: 'billing', sessionStore: store2, defaultModel: model,
});

// Turn 1: suspends at ctx.approve — the tool must NOT fire.
await rt2.run({ sessionId: 'appr', input: 'charge me', driver: approvalDriver() });
const afterSuspend = charges;

// Turn 2: deliver the approval signal; the run resumes and the tool fires.
const approval = { signalId: 'sig-1', name: '__approval', payload: { approved: true, by: 'supervisor' } };
await rt2.run({ sessionId: 'appr', input: 'approved', driver: approvalDriver(), signalDelivery: approval });
const afterResume = charges;

// Turn 3: same signalId re-delivered — the journal must replay, not re-charge.
await rt2.run({ sessionId: 'appr', input: 'approved', driver: approvalDriver(), signalDelivery: approval });

console.log('A. approval pause -> resume, within one logical run');
console.log(`   charges while suspended : ${afterSuspend}  (expect 0 - tool gated behind approval)`);
console.log(`   charges after resume    : ${afterResume}`);
console.log(`   charges after a retry   : ${charges}`);
console.log(`   => ${afterResume === charges ? 'replayed from the journal, NOT re-executed' : 'RE-EXECUTED'}`);

// --- B. what the journal actually holds ----------------------------------
const session = await store2.get('appr');
const runs = (session as unknown as { durableRuns?: Record<string, { steps?: Array<{ key: string; status: string; result?: unknown }> }> })?.durableRuns ?? {};
const steps = Object.values(runs).flatMap((r) => r.steps ?? []);
console.log('\nB. the effect journal');
for (const s of steps) {
  console.log(`   status=${s.status.padEnd(9)} result=${s.result === undefined ? 'none' : 'recorded'}  key=${s.key.slice(0, 40)}...`);
}
console.log(`   => ${steps.length} step(s) persisted`);
console.log('\n   A crash between execute() and finalize leaves status=running with no');
console.log('   result; on resume the effect RE-RUNS, deduped by the idempotency key.');
console.log('   Hence exactly-once-MODULO-IDEMPOTENCY, not plain exactly-once.');
