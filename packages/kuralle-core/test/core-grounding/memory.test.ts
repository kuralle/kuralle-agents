import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { InMemoryMemoryService } from '../../src/memory/stores/InMemoryMemoryService.js';
import {
  buildMemoryService,
  resetMissingUserIdWarningsForTests,
  runMemoryIngest,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import type { Session } from '../../src/types/session.js';

afterEach(() => {
  mock.restore();
  resetMissingUserIdWarningsForTests();
});

describe('memory preload and ingest', () => {
  it('preloads prior user memory into gather context when userId is present', async () => {
    let capturedSystem = '';
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { system?: string }) => {
          capturedSystem = opts.system ?? '';
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', text: 'Got it.' };
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const memoryService = new InMemoryMemoryService();
    const priorSession: Session = {
      id: 'prior-session',
      conversationId: 'prior-session',
      channelId: 'api',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [{ role: 'user', content: 'My favorite color is teal.' }],
      workingMemory: {},
      currentAgent: 'support',
      activeAgentId: 'support',
      agentStates: {},
      handoffHistory: [],
    };
    await memoryService.addSessionToMemory(priorSession);

    const { session, runStore, runState } = await setupDurableHarness('mem-sess', 'mem-run');
    session.userId = 'user-1';
    runState.messages = [{ role: 'user', content: 'What is my favorite color?' }];

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: true, tokenBudget: 500 }, ingest: { enabled: true } },
    });
    const v2Memory = buildMemoryService(memoryService, agent);
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

  it('skips ingest without userId and warns', async () => {
    const memoryService = new InMemoryMemoryService();
    let ingestCalls = 0;
    const originalAdd = memoryService.addSessionToMemory.bind(memoryService);
    memoryService.addSessionToMemory = async (session, options) => {
      ingestCalls += 1;
      return originalAdd(session, options);
    };

    const { session, runStore, runState } = await setupDurableHarness('no-user-sess', 'no-user-run');
    delete session.userId;
    runState.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: false }, ingest: { enabled: true } },
    });
    const v2Memory = buildMemoryService(memoryService, agent);
    expect(v2Memory?.ingest).toBeDefined();

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

    await runMemoryIngest(ctx);
    expect(ingestCalls).toBe(0);
  });

  it('ingests session messages when userId is present', async () => {
    const memoryService = new InMemoryMemoryService();
    let ingestCalls = 0;
    const originalAdd = memoryService.addSessionToMemory.bind(memoryService);
    memoryService.addSessionToMemory = async (session, options) => {
      ingestCalls += 1;
      return originalAdd(session, options);
    };

    const { session, runStore, runState } = await setupDurableHarness('ingest-sess', 'ingest-run');
    session.userId = 'user-2';
    runState.messages = [
      { role: 'user', content: 'I prefer email contact.' },
      { role: 'assistant', content: 'Noted.' },
    ];

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: false }, ingest: { enabled: true } },
    });
    const v2Memory = buildMemoryService(memoryService, agent);

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

    await runMemoryIngest(ctx);
    expect(ingestCalls).toBe(1);

    const search = await memoryService.searchMemory({
      userId: 'user-2',
      query: 'email contact',
      limit: 5,
    });
    expect(search.memories.some((entry) => entry.content.includes('email contact'))).toBe(true);
  });
});
