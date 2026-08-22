import { describe, expect, it } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { mockV3CapturingStreamModel } from '../helpers/mockLanguageModelV3Results.js';
import {
  buildMemoryService,
  resetMissingUserIdWarningsForTests,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { factsExtractor } from '../../src/memory/extract/builtin/factsExtractor.js';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.js';

function systemFromCapture(captured: Record<string, unknown>[]): string {
  const system = captured[0]?.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((message: { content?: unknown }) =>
        typeof message?.content === 'string' ? message.content : '',
      )
      .join('\n\n');
  }
  return '';
}

describe('memory preload via extracted facts', () => {
  it('preloads prior extracted facts into gather context when userId is present', async () => {
    const captured: Record<string, unknown>[] = [];
    const model = mockV3CapturingStreamModel(captured, 'Got it.');

    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts: ['User favorite color is teal'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'user-1',
    );

    const { session, runStore, runState } = await setupDurableHarness('mem-sess', 'mem-run');
    session.userId = 'user-1';
    runState.messages = [{ role: 'user', content: 'What is my favorite color?' }];

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: true, tokenBudget: 500 }, extract: [factsExtractor()] },
    });
    const v2Memory = buildMemoryService(agent, store);
    expect(v2Memory?.preload).toBeDefined();

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      memoryService: v2Memory,
      emit: () => {},
    });

    const gather = await runGatherPhase(ctx);
    expect(gather.memoryBlock).toContain('teal');

    const node = reply({ id: 'answer', instructions: 'Answer using memory.' });
    await new TextDriver().runAgentTurn(resolveReplyNode(node, runState.state), ctx);
    expect(systemFromCapture(captured)).toContain('teal');
  });

  it('skips preload without userId and warns', async () => {
    resetMissingUserIdWarningsForTests();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts: ['Some fact'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'anon',
    );

    const { session, runStore, runState } = await setupDurableHarness('no-user-sess', 'no-user-run');
    delete session.userId;
    runState.messages = [{ role: 'user', content: 'hello' }];

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: true }, extract: [factsExtractor()] },
    });
    const v2Memory = buildMemoryService(agent, store);

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: mockV3CapturingStreamModel([], 'ok'),
      memoryService: v2Memory,
      emit: () => {},
    });

    const block = await v2Memory!.preload!(ctx);
    expect(block).toBeUndefined();
  });
});
