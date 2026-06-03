import { describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { reply, collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

const stubModel = {} as import('ai').LanguageModel;

function captureStream(captured: Record<string, unknown>[]) {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: (args: Record<string, unknown>) => {
        captured.push(args);
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'ok' };
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        };
      },
    };
  });
}

describe('agent base layer (ADR 0001)', () => {
  it('composes base instructions + exposes global tools in a speaking turn', async () => {
    const captured: Record<string, unknown>[] = [];
    captureStream(captured);

    const greet = reply({ id: 'greet', instructions: 'NODE_GREET_RULE', next: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'b', description: 'x', start: greet, nodes: [greet] });
    const faq = defineTool({
      name: 'faq_lookup',
      description: 'Look up a returns/FAQ answer',
      input: z.object({ q: z.string() }),
      execute: async () => ({ answer: 'x' }),
    });

    const { session, runStore, runState } = await setupDurableHarness('base-1', 'base-run-1');
    const ctx = await createRunContext({
      session, runStore, runState, steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }), model: stubModel, emit: () => {},
    });
    ctx.baseInstructions = 'BASE_PERSONA_SAFETY';
    ctx.globalTools = { faq_lookup: faq };

    await runFlow(flow, runState, new TextDriver(), ctx);

    const turn = captured[0]!;
    expect(String(turn.system)).toContain('BASE_PERSONA_SAFETY'); // base composed
    expect(String(turn.system)).toContain('NODE_GREET_RULE'); // node layered on top
    expect(Object.keys((turn.tools as Record<string, unknown>) ?? {})).toContain('faq_lookup');
  });

  it('collect extraction sees base instructions but NOT global tools (safety invariant)', async () => {
    const captured: Record<string, unknown>[] = [];
    captureStream(captured);

    const ask = collect({
      id: 'name',
      schema: z.object({ name: z.string() }),
      required: ['name'],
      ask: () => 'Your name?',
      onComplete: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'c', description: 'x', start: ask, nodes: [ask] });
    const faq = defineTool({
      name: 'faq_lookup', description: 'faq', input: z.object({ q: z.string() }), execute: async () => ({}),
    });

    const { session, runStore, runState } = await setupDurableHarness('base-2', 'base-run-2');
    runState.messages = [{ role: 'user', content: 'hello' }];
    const ctx = await createRunContext({
      session, runStore, runState, steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }), model: stubModel, emit: () => {},
    });
    ctx.baseInstructions = 'BASE_PERSONA_SAFETY';
    ctx.globalTools = { faq_lookup: faq };

    await runFlow(flow, runState, new TextDriver(), ctx);

    const extraction = captured[0]!;
    const toolNames = Object.keys((extraction.tools as Record<string, unknown>) ?? {});
    expect(String(extraction.system)).toContain('BASE_PERSONA_SAFETY'); // base still present
    expect(toolNames).not.toContain('faq_lookup'); // global tools NOT exposed during extraction
    expect(toolNames.some((n) => n.startsWith('submit_'))).toBe(true); // only the submit tool
  });
});
