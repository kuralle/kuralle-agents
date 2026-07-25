/**
 * EscalationOutcome end-to-end, plus its latency cost.
 *
 * Shows the three outcome shapes a handler can return, what the handler
 * receives, and — the reason this example exists — what escalation costs on the
 * user's latency path. `summarize` defaults to ON and is an extra LLM call.
 */
import {
  createRuntime, defineAgent, MemoryStore,
  type ChannelDriver, type EscalationRequest, type EscalationOutcome,
} from '../../src/index.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const SUMMARY_LATENCY_MS = 40; // stand-in for a real provider round-trip

const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'ok' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ],
    }),
  }) as never,
  doGenerate: async () => {
    await new Promise((r) => setTimeout(r, SUMMARY_LATENCY_MS)); // the summarize call
    return {
      content: [{ type: 'text', text: 'Customer wants a refund on order 42.' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    } as never;
  },
});

const driver = (): ChannelDriver => {
  let turns = 0;
  return {
    async runAgentTurn() {
      turns += 1;
      if (turns === 1) {
        return { text: '', toolResults: [], control: { type: 'escalate' as const, reason: 'user asked for a human' } };
      }
      return { text: 'connecting you', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message' as const, input: '' };
    },
  };
};

let received: EscalationRequest | undefined;

/** The three shapes a handler may return. */
const handlers: Record<string, (r: EscalationRequest) => Promise<EscalationOutcome>> = {
  queued:    async (r) => { received = r; return { status: 'queued', queueId: 'TKT-42', estimatedWaitSec: 300 }; },
  connected: async ()  => ({ status: 'connected', operatorId: 'op-7' }),
  failed:    async ()  => ({ status: 'failed', error: 'pager unreachable' }),
};

async function runWith(name: string, summarize: boolean) {
  const runtime = createRuntime({
    agents: [defineAgent({ id: 'support', instructions: 'help', model })],
    defaultAgentId: 'support',
    sessionStore: new MemoryStore(),
    defaultModel: model,
    escalation: { handler: handlers[name]!, summarize },
  });
  const started = performance.now();
  const handle = runtime.run({ sessionId: `esc-${name}-${summarize}`, input: 'get me a human', driver: driver() });
  const parts: string[] = [];
  let escalationPayload: unknown;
  for await (const p of handle.events) {
    parts.push(p.type);
    if (p.type === 'escalation') escalationPayload = p.payload;
  }
  await handle;
  return { ms: performance.now() - started, parts, escalationPayload };
}

console.log('=== outcome shapes ===');
for (const name of Object.keys(handlers)) {
  const { escalationPayload } = await runWith(name, false);
  console.log(`  ${name.padEnd(10)} → stream payload.outcome = ${JSON.stringify((escalationPayload as Record<string, unknown>)?.outcome)}`);
}

console.log('\n=== what the handler receives ===');
console.log('  keys:', Object.keys(received ?? {}).join(', '));
console.log('  reason:', received?.reason, '| category:', received?.category ?? '∅');
console.log('  recentMessages:', received?.recentMessages?.length ?? 0, '| summary:', received?.summary ?? '∅ (summarize:false)');

console.log('\n=== latency: does escalation sit on the user path? ===');
const off = [] as number[]; const on = [] as number[];
for (let i = 0; i < 5; i += 1) {
  off.push((await runWith('queued', false)).ms);
  on.push((await runWith('queued', true)).ms);
}
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(1);
console.log(`  summarize:false  median ${med(off)} ms`);
console.log(`  summarize:true   median ${med(on)} ms   (adds one LLM call, mocked at ${SUMMARY_LATENCY_MS}ms)`);
console.log(`  delta            ${(Number(med(on)) - Number(med(off))).toFixed(1)} ms`);
