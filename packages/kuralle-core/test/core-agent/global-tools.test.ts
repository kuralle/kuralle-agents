import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';

const stub = {} as import('ai').LanguageModel;

describe('agent globalTools are executable (ADR 0001)', () => {
  it('a model call to a global tool actually runs its executor', async () => {
    const spy = { count: 0 };
    const faq = defineTool({
      name: 'faq_lookup',
      description: 'Look up a policy answer',
      input: z.object({ question: z.string() }),
      execute: async () => {
        spy.count += 1;
        return { answer: 'Refunds within 7 days.' };
      },
    });

    const node = reply({ id: 'r', instructions: 'answer', next: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'f', description: 'x', start: node, nodes: [node] });
    const agent = defineAgent({
      id: 'a',
      instructions: 'base persona',
      model: stub,
      globalTools: { faq_lookup: faq },
      flows: [flow],
    });

    // Driver simulates the model invoking the global tool during a speaking turn.
    const driver: ChannelDriver = {
      async runAgentTurn(_node, ctx: RunContext) {
        const result = await ctx.tool('faq_lookup', { question: 'returns?' });
        return { text: JSON.stringify(result), toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
      defaultModel: stub,
      hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
    });

    const handle = runtime.run({ sessionId: 'g1', input: 'what is your returns policy?', driver });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;

    // Before the fix the executor only knew tools, so this call could not run.
    expect(spy.count).toBeGreaterThan(0);
  });
});
