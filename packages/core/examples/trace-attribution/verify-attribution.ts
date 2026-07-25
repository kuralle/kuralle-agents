/**
 * Spike for F1-F3 — trace agent attribution.
 * Builds a real agent with a tool, a flow that escalates, and a handoff target,
 * then inspects the spans the runtime actually produces.
 */
import { z } from 'zod';
import {
  createRuntime, defineAgent, defineTool, defineFlow, reply, action,
  MemoryStore, MemoryTraceStore, runOnce as standaloneRunOnce,
} from '../../src/index.js';
import type { AgentSpan } from '../../src/index.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

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
});

const lookup = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ id, status: 'shipped' }),
});

const show = (label: string, spans: AgentSpan[]) => {
  console.log(`\n--- ${label} ---`);
  for (const s of spans) {
    const a = s.attributes as Record<string, unknown>;
    console.log(
      `  ${s.kind.padEnd(8)} ${s.name.padEnd(26)} agentId=${String(a.agentId ?? '∅').padEnd(10)}` +
      (s.kind === 'handoff' ? ` from=${a.handoffFrom ?? '∅'} to=${a.handoffTo ?? '∅'}` : ''),
    );
  }
  return spans;
};

// ---- F1: escalation -> how many handoff spans, and is there a self-edge? ----
const escNode = reply({ id: 'r', instructions: 'reply', next: () => ({ escalate: 'needs a human' }) });
const escFlow = defineFlow({ name: 'esc-flow', description: 'x', start: escNode, nodes: [escNode] });

let turns = 0;
const driver = {
  async runAgentTurn() {
    turns += 1;
    if (turns === 1) return { text: '', toolResults: [], control: { type: 'escalate' as const, reason: 'needs a human' } };
    return { text: 'getting a human', toolResults: [] };
  },
  async awaitUser() { return { type: 'message' as const, input: '' }; },
};

const traceStore = new MemoryTraceStore();
const rt = createRuntime({
  agents: [defineAgent({ id: 'support', instructions: 'help', model, flows: [escFlow], tools: { lookup_order: lookup } })],
  defaultAgentId: 'support',
  sessionStore: new MemoryStore(), defaultModel: model,
  tracing: { store: traceStore },
  escalation: { handler: async () => ({ status: 'queued' as const, queueId: 'q1' }), summarize: false },
});

await rt.run({ sessionId: 'f1', input: 'I need a human', driver });
const t1 = (await traceStore.listTraces('f1'))[0];
const spans1 = show('F1  escalation spans', t1?.spans ?? []);
const handoffs = spans1.filter((s) => s.kind === 'handoff');
const selfEdge = handoffs.filter((s) => {
  const a = s.attributes as Record<string, unknown>;
  return a.handoffFrom && a.handoffFrom === a.handoffTo;
});
console.log(`  => handoff spans: ${handoffs.length} (expect 1)`);
console.log(`  => self-edges   : ${selfEdge.length} (expect 0)`);

// ---- F3: standalone runOnce — does it attribute at all? ----
const store2 = new MemoryStore();
const rt2 = createRuntime({
  agents: [defineAgent({ id: 'billing', instructions: 'b', model, tools: { lookup_order: lookup } })],
  defaultAgentId: 'billing', sessionStore: store2, defaultModel: model,
});
const standalone = await standaloneRunOnce(rt2, { sessionId: 'f3', input: 'hi' });
const spans3 = show('F3  standalone runOnce spans', standalone.spans);
const attributed = spans3.filter((s) => (s.attributes as Record<string, unknown>).agentId);
console.log(`  => spans with agentId: ${attributed.length}/${spans3.length} (expect all)`);

// ---- F2: does persisted state override an explicit agentId? ----
const store3 = new MemoryStore();
await store3.save({
  id: 'f2', messages: [], workingMemory: {}, currentAgent: 'triage', version: 0,
} as never);
const rt3 = createRuntime({
  agents: [
    defineAgent({ id: 'triage', instructions: 't', model }),
    defineAgent({ id: 'billing', instructions: 'b', model }),
  ],
  defaultAgentId: 'triage', sessionStore: store3, defaultModel: model,
});
const t2 = await rt3.runOnce({ sessionId: 'f2', agentId: 'billing', input: 'hi' });
const turn = t2.spans.find((s) => s.kind === 'turn');
const got = (turn?.attributes as Record<string, unknown> | undefined)?.agentId;
console.log(`\n--- F2  runOnce agentId precedence ---`);
console.log(`  => asked for 'billing', trace says '${got}' (expect billing)`);
