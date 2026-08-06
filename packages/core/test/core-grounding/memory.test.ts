import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  buildMemoryService,
  resetMissingUserIdWarningsForTests,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { factsExtractor } from '../../src/memory/extract/builtin/factsExtractor.js';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.js';

afterEach(() => {
  mock.restore();
  resetMissingUserIdWarningsForTests();
});

describe('memory preload via extracted facts', () => {
  it('preloads prior extracted facts into gather context when userId is present', async () => {
    let capturedSystem = '';
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { system?: unknown }) => {
          capturedSystem =
            typeof opts.system === 'string'
              ? opts.system
              : Array.isArray(opts.system)
                ? opts.system
                    .map((m: { content?: unknown }) =>
                      typeof m?.content === 'string' ? m.content : '',
                    )
                    .join('\n\n')
                : '';
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Got it.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

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
      model: stubModel,
      memoryService: v2Memory,
      emit: () => {},
    });

    const gather = await runGatherPhase(ctx);
    expect(gather.memoryBlock).toContain('teal');

    const node = reply({ id: 'answer', instructions: 'Answer using memory.' });
    await new TextDriver().runAgentTurn(resolveReplyNode(node, runState.state), ctx);
    expect(capturedSystem).toContain('teal');
  });

  it('skips preload without userId and warns', async () => {
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
      model: stubModel,
      memoryService: v2Memory,
      emit: () => {},
    });

    const block = await v2Memory!.preload!(ctx);
    expect(block).toBeUndefined();
  });
});
