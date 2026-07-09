import { describe, expect, it, mock, spyOn, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { reply } from '../../src/types/flow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  buildMemoryService,
  resolveNodeGatherScope,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import {
  createInMemoryKnowledgeConfig,
  createInMemoryKnowledgeRetriever,
  type InMemoryKnowledgeDocument,
} from '../../src/runtime/grounding/inMemoryKnowledge.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { InMemoryMemoryService } from '../../src/memory/stores/InMemoryMemoryService.js';
import { resetMissingUserIdWarningsForTests } from '../../src/runtime/grounding/memory.js';
import type { KnowledgeRetrieverAdapter } from '../../src/types/voice.js';
import * as preloadMemory from '../../src/memory/preloadMemory.js';

afterEach(() => {
  mock.restore();
  resetMissingUserIdWarningsForTests();
});

function filterAwareRetriever(documents: InMemoryKnowledgeDocument[]): KnowledgeRetrieverAdapter {
  const base = createInMemoryKnowledgeRetriever(documents);
  return {
    retrieve: async (query, options) => {
      const results = await base.retrieve(query, options);
      const filter = options?.filter;
      if (!filter) {
        return results;
      }
      return results.filter((result) =>
        Object.entries(filter).every(([key, value]) => result.metadata?.[key] === value),
      );
    },
  };
}

function knowledgeHarness(docs: InMemoryKnowledgeDocument[]) {
  const agent = defineAgent({
    id: 'support',
    knowledge: { autoRetrieve: true },
  });
  const config = createInMemoryKnowledgeConfig(docs);
  config.retriever = filterAwareRetriever(docs);
  const provider = buildKnowledgeProvider(config);
  const autoRetrieve = buildAutoRetrieveProvider(provider, agent);
  expect(autoRetrieve).toBeDefined();
  return { agent, provider, autoRetrieve: autoRetrieve! };
}

async function ctxWithMessages(
  userContent: string,
  autoRetrieve?: ReturnType<typeof buildAutoRetrieveProvider>,
  memoryService?: ReturnType<typeof buildMemoryService>,
) {
  const { session, runStore, runState } = await setupDurableHarness('node-scope', 'node-scope-run');
  runState.messages = [{ role: 'user', content: userContent }];
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    autoRetrieve,
    memoryService,
    emit: () => {},
  });
  return { ctx, runState };
}

describe('node-scoped grounding (W3)', () => {
  it('node filter scopes retrieval to topic metadata', async () => {
    const docs: InMemoryKnowledgeDocument[] = [
      { id: 'returns-doc', text: 'Returns policy: 45 day window.', metadata: { topic: 'returns' } },
      { id: 'shipping-doc', text: 'Shipping policy: free over $50.', metadata: { topic: 'shipping' } },
    ];
    const { autoRetrieve } = knowledgeHarness(docs);
    const { ctx } = await ctxWithMessages('returns shipping', autoRetrieve);

    const returnsNode = reply({
      id: 'returns',
      instructions: 'returns',
      grounding: { knowledge: { filter: { topic: 'returns' } } },
    });
    const shippingNode = reply({
      id: 'shipping',
      instructions: 'shipping',
      grounding: { knowledge: { filter: { topic: 'shipping' } } },
    });

    const returnsScope = resolveNodeGatherScope(returnsNode, ctx.runState.state, ctx.runState.messages);
    const shippingScope = resolveNodeGatherScope(shippingNode, ctx.runState.state, ctx.runState.messages);

    const returnsGather = await runGatherPhase(ctx, returnsScope);
    const shippingGather = await runGatherPhase(ctx, shippingScope);

    expect(returnsGather.retrievalBlock).toContain('45 day');
    expect(returnsGather.retrievalBlock).not.toContain('free over');
    expect(shippingGather.retrievalBlock).toContain('free over');
    expect(shippingGather.retrievalBlock).not.toContain('45 day');
  });

  it('node query overrides latest user message', async () => {
    const docs: InMemoryKnowledgeDocument[] = [
      {
        id: 'policy',
        text: 'Return window policy allows forty-five days for refunds.',
      },
      { id: 'noise', text: 'Unrelated shipping rates and handling fees.' },
    ];
    const { autoRetrieve } = knowledgeHarness(docs);
    const { ctx } = await ctxWithMessages('ok', autoRetrieve);

    const scopedNode = reply({
      id: 'policy',
      instructions: 'policy',
      grounding: { query: 'return window policy' },
    });
    const scope = resolveNodeGatherScope(scopedNode, ctx.runState.state, ctx.runState.messages);
    const scoped = await runGatherPhase(ctx, scope);

    const baseline = await runGatherPhase(ctx);
    expect(baseline.retrievalBlock).toBeUndefined();

    expect(scoped.retrievalBlock).toContain('forty-five days');
  });

  it('no grounding matches agent-wide baseline gather', async () => {
    const docs: InMemoryKnowledgeDocument[] = [
      { text: 'Agent-wide return window is 30 days.', id: 'returns' },
    ];
    const { autoRetrieve } = knowledgeHarness(docs);
    const { ctx } = await ctxWithMessages('return window', autoRetrieve);

    const plainNode = reply({ id: 'plain', instructions: 'plain' });
    const nodeScope = resolveNodeGatherScope(plainNode, ctx.runState.state, ctx.runState.messages);
    expect(nodeScope).toBeUndefined();

    const baseline = await runGatherPhase(ctx);
    const viaNode = await runGatherPhase(ctx, nodeScope);

    expect(viaNode.retrievalBlock).toBe(baseline.retrievalBlock);
    expect(viaNode.memoryBlock).toBe(baseline.memoryBlock);
    expect(baseline.retrievalBlock).toContain('30 days');
  });

  it('knowledge.autoRetrieve false skips retrieval for that node', async () => {
    const docs: InMemoryKnowledgeDocument[] = [
      { text: 'Should not appear when autoRetrieve is off.', id: 'hidden' },
    ];
    const { autoRetrieve } = knowledgeHarness(docs);
    const { ctx } = await ctxWithMessages('Should not appear autoRetrieve', autoRetrieve);

    const offNode = reply({
      id: 'silent',
      instructions: 'silent',
      grounding: { knowledge: { autoRetrieve: false } },
    });
    const scope = resolveNodeGatherScope(offNode, ctx.runState.state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);

    expect(gather.retrievalBlock).toBeUndefined();

    const baseline = await runGatherPhase(ctx);
    expect(baseline.retrievalBlock).toContain('Should not appear');
  });

  it('memory.preload false skips preload; tokenBudget is forwarded', async () => {
    const memoryStore = new InMemoryMemoryService();
    const priorSession = {
      id: 'prior',
      conversationId: 'prior',
      channelId: 'api',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [{ role: 'user' as const, content: 'Favorite snack is mango.' }],
      workingMemory: {},
      currentAgent: 'support',
      activeAgentId: 'support',
      agentStates: {},
      handoffHistory: [],
    };
    await memoryStore.addSessionToMemory(priorSession);

    const agent = defineAgent({
      id: 'support',
      memory: { preload: { enabled: true, tokenBudget: 500 }, ingest: { enabled: false } },
    });
    const memoryService = buildMemoryService(memoryStore, agent);
    expect(memoryService?.preload).toBeDefined();

    const { ctx } = await ctxWithMessages('What snack do I like?', undefined, memoryService);
    ctx.session.userId = 'user-1';

    const offNode = reply({
      id: 'no-mem',
      instructions: 'x',
      grounding: { memory: { preload: false } },
    });
    const offScope = resolveNodeGatherScope(offNode, ctx.runState.state, ctx.runState.messages);
    const offGather = await runGatherPhase(ctx, offScope);
    expect(offGather.memoryBlock).toBeUndefined();

    const capturedBudgets: number[] = [];
    const preloadSpy = spyOn(preloadMemory, 'preloadMemoryContext').mockImplementation(
      async (_service, _session, _userInput, maxTokens) => {
        capturedBudgets.push(maxTokens);
        return '## Context from Past Conversations\n\nbudget probe';
      },
    );

    const budgetNode = reply({
      id: 'budget',
      instructions: 'x',
      grounding: { memory: { tokenBudget: 42 } },
    });
    const budgetScope = resolveNodeGatherScope(budgetNode, ctx.runState.state, ctx.runState.messages);
    const budgetGather = await runGatherPhase(ctx, budgetScope);
    expect(capturedBudgets).toContain(42);
    expect(budgetGather.memoryBlock).toContain('budget probe');

    preloadSpy.mockRestore();
  });

  it('query function receives state and history', async () => {
    const docs: InMemoryKnowledgeDocument[] = [
      { text: 'State-driven topic alpha retrieval content.', id: 'alpha' },
    ];
    const { autoRetrieve } = knowledgeHarness(docs);
    const { ctx, runState } = await ctxWithMessages('ignored', autoRetrieve);
    runState.state = { topicKey: 'alpha' };
    const history: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'ignored' },
    ];
    ctx.runState.messages = history;

    let seenState: Record<string, unknown> | undefined;
    let seenHistory: ModelMessage[] | undefined;

    const node = reply({
      id: 'fn',
      instructions: 'fn',
      grounding: {
        query: (state, msgs) => {
          seenState = state;
          seenHistory = msgs;
          return `topic ${String(state.topicKey)} retrieval`;
        },
      },
    });

    const scope = resolveNodeGatherScope(node, ctx.runState.state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);

    expect(seenState).toEqual({ topicKey: 'alpha' });
    expect(seenHistory).toBe(history);
    expect(gather.retrievalBlock).toContain('alpha retrieval');
  });

  it('resolveNodeGatherScope resolves undefined, string, and function query', () => {
    const plain = reply({ id: 'plain', instructions: 'x' });
    expect(resolveNodeGatherScope(plain, {}, [])).toBeUndefined();

    const stringQuery = reply({
      id: 'sq',
      instructions: 'x',
      grounding: { query: 'fixed query', knowledge: { topK: 2 } },
    });
    expect(resolveNodeGatherScope(stringQuery, { a: 1 }, [])).toEqual({
      query: 'fixed query',
      knowledge: { topK: 2 },
      memory: undefined,
    });

    const fnQuery = reply({
      id: 'fq',
      instructions: 'x',
      grounding: {
        query: (state) => `from-${String(state.id)}`,
        memory: { preload: false, tokenBudget: 99 },
      },
    });
    expect(resolveNodeGatherScope(fnQuery, { id: 'node-9' }, [])).toEqual({
      query: 'from-node-9',
      knowledge: undefined,
      memory: { preload: false, tokenBudget: 99 },
    });
  });
});
