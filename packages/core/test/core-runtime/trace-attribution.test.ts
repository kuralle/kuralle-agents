import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createRuntime, defineAgent, MemoryStore, MemoryTraceStore, runOnce } from '../../src/index.js';
import type { ChannelDriver } from '../../src/index.js';

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

describe('trace agent attribution', () => {
  it('escalation produces exactly one handoff span and no self-edge', async () => {
    let turns = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        turns += 1;
        if (turns === 1) {
          return { text: '', toolResults: [], control: { type: 'escalate' as const, reason: 'needs a human' } };
        }
        return { text: 'getting a human', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: '' };
      },
    };
    const traceStore = new MemoryTraceStore();
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'support', instructions: 'help', model })],
      defaultAgentId: 'support',
      sessionStore: new MemoryStore(),
      defaultModel: model,
      tracing: { store: traceStore },
      escalation: { handler: async () => ({ status: 'queued' as const, queueId: 'q1' }), summarize: false },
    });

    await runtime.run({ sessionId: 'esc', input: 'human please', driver });
    const trace = (await traceStore.listTraces('esc'))[0];
    const handoffs = (trace?.spans ?? []).filter((s) => s.kind === 'handoff');

    // Two emitters (hostLoop + Runtime) used to fire for one escalation, producing
    // a `human -> human` span that then mis-attributed every later span to `human`.
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.attributes.handoffFrom).toBe('support');
    expect(handoffs[0]?.attributes.handoffTo).toBe('human');
    expect(handoffs.some((s) => s.attributes.handoffFrom === s.attributes.handoffTo)).toBe(false);
  });

  it("runOnce honours the caller's agentId over persisted session state", async () => {
    const sessionStore = new MemoryStore();
    await sessionStore.save({
      id: 's', messages: [], workingMemory: {}, currentAgent: 'triage', version: 0,
    } as never);
    const runtime = createRuntime({
      agents: [
        defineAgent({ id: 'triage', instructions: 't', model }),
        defineAgent({ id: 'billing', instructions: 'b', model }),
      ],
      defaultAgentId: 'triage',
      sessionStore,
      defaultModel: model,
    });

    const trace = await runtime.runOnce({ sessionId: 's', agentId: 'billing', input: 'hi' });
    const turn = trace.spans.find((s) => s.kind === 'turn');
    // run() resolves `opts.agentId` first; runOnce must not disagree with it.
    expect(turn?.attributes.agentId).toBe('billing');
  });

  it('the standalone runOnce attributes spans, like the method form', async () => {
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'billing', instructions: 'b', model })],
      defaultAgentId: 'billing',
      sessionStore: new MemoryStore(),
      defaultModel: model,
    });

    const trace = await runOnce(runtime, { sessionId: 'standalone', input: 'hi' });
    expect(trace.spans.length).toBeGreaterThan(0);
    // Previously every span came back with no agentId at all.
    for (const span of trace.spans) expect(span.attributes.agentId).toBe('billing');
  });
});
