import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { createInMemoryKnowledgeConfig } from '../../src/runtime/grounding/inMemoryKnowledge.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';

afterEach(() => {
  mock.restore();
});

describe('knowledge gather', () => {
  it('runs autoRetrieve in gather phase and injects retrieved text into the system prompt', async () => {
    let capturedSystem = '';

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { system?: string }) => {
          capturedSystem = opts.system ?? '';
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Answer' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness();
    runState.messages = [{ role: 'user', content: 'How long do I have to return something?' }];

    const agent = defineAgent({
      id: 'support',
      knowledge: { autoRetrieve: true },
    });
    const knowledgeProvider = buildKnowledgeProvider(
      createInMemoryKnowledgeConfig([
        { text: "Acme's return window is 45 days.", id: 'returns' },
      ]),
    );
    const autoRetrieve = buildAutoRetrieveProvider(knowledgeProvider, agent);
    expect(autoRetrieve).toBeDefined();

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      autoRetrieve,
      emit: () => {},
    });

    const gather = await runGatherPhase(ctx);
    expect(gather.retrievalBlock).toContain('45 days');

    const node = reply({
      id: 'answer',
      instructions: 'Answer using retrieved knowledge only.',
    });
    const driver = new TextDriver();
    await driver.runAgentTurn(resolveReplyNode(node, runState.state), ctx);

    expect(capturedSystem).toContain('45 days');
    expect(capturedSystem).toContain('Retrieved Knowledge');
  });

  it('does not call autoRetrieve when the agent has no knowledge config', async () => {
    let retrieveCalls = 0;
    const { session, runStore, runState } = await setupDurableHarness();
    runState.messages = [{ role: 'user', content: 'hello' }];

    const agent = defineAgent({ id: 'plain' });
    const knowledgeProvider = buildKnowledgeProvider(
      createInMemoryKnowledgeConfig([{ text: 'hidden fact' }]),
    );
    const autoRetrieve = buildAutoRetrieveProvider(knowledgeProvider, agent);
    expect(autoRetrieve).toBeUndefined();

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      autoRetrieve: {
        retrieve: async () => {
          retrieveCalls += 1;
          return 'should not run';
        },
      },
      emit: () => {},
    });

    const gather = await runGatherPhase({ ...ctx, autoRetrieve: undefined });
    expect(gather.retrievalBlock).toBeUndefined();
    expect(retrieveCalls).toBe(0);
  });
});
