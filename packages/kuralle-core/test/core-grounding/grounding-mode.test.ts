import { afterEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { InMemoryFs } from '@kuralle-agents/fs';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { executeModelToolCall } from '../../src/runtime/channels/executeModelTool.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { setupDurableHarness, stubModel, reloadRunState } from '../core-durable/helpers.js';
import {
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  buildKnowledgeTool,
  runGatherPhase,
} from '../../src/runtime/grounding/index.js';
import { createInMemoryKnowledgeConfig } from '../../src/runtime/grounding/inMemoryKnowledge.js';

const SEED_DOC = { text: 'Free shipping on orders over $50.', id: 'shipping' };

function knowledgeProvider() {
  return buildKnowledgeProvider(createInMemoryKnowledgeConfig([SEED_DOC]));
}

afterEach(() => {
  mock.restore();
});

describe('declared grounding contract', () => {
  it('guaranteed default builds pre-injection provider and no knowledge tool', () => {
    const provider = knowledgeProvider();

    for (const knowledge of [{}, { autoRetrieve: true }]) {
      const agent = defineAgent({ id: 'support', knowledge });
      expect(buildAutoRetrieveProvider(provider, agent)).toBeDefined();
      expect(buildKnowledgeTool(provider, agent)).toBeUndefined();
    }
  });

  it('knowledge_search rejects blank or whitespace-only queries', async () => {
    const provider = knowledgeProvider();
    const agent = defineAgent({ id: 'support', knowledge: { autoRetrieve: false } });
    const tool = buildKnowledgeTool(provider, agent);
    expect(tool).toBeDefined();

    const { session, runStore, runState } = await setupDurableHarness(
      'blank-knowledge-query',
      'blank-knowledge-run',
    );
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { knowledge_search: tool! } }),
      model: stubModel,
      emit: () => {},
    });

    for (const query of ['', '   ']) {
      const outcome = await executeModelToolCall(
        ctx,
        { toolName: 'knowledge_search', input: { query }, toolCallId: `blank-${query.length}` },
        { knowledge_search: tool! },
      );
      expect(outcome.failed).toBe(true);
    }
  });

  it('on-demand (autoRetrieve:false) skips pre-injection and exposes knowledge_search tool', async () => {
    const provider = knowledgeProvider();
    const agent = defineAgent({ id: 'support', knowledge: { autoRetrieve: false } });

    expect(buildAutoRetrieveProvider(provider, agent)).toBeUndefined();

    const tool = buildKnowledgeTool(provider, agent);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('knowledge_search');

    const result = await tool!.execute({ query: 'shipping' });
    expect(result).toEqual({
      documents: [SEED_DOC.text],
    });
  });

  it('on-demand gather phase does not pre-inject retrieval', async () => {
    const { session, runStore, runState } = await setupDurableHarness();
    runState.messages = [{ role: 'user', content: 'shipping cost' }];

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      autoRetrieve: undefined,
      emit: () => {},
    });

    const gather = await runGatherPhase(ctx);
    expect(gather.retrievalBlock).toBeUndefined();
  });

  it('handoff target on-demand knowledge_search executes through the driver-injected global tool def', async () => {
    const modelTurns = [
      {
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolName: 'transfer_to_agent',
            toolCallId: 'handoff-1',
            input: { targetAgentId: 'specialist', reason: 'needs specialist' },
          },
        ],
      },
      {
        finishReason: 'stop',
        toolCalls: [],
      },
      {
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolName: 'knowledge_search',
            toolCallId: 'knowledge-1',
            input: { query: 'shipping' },
          },
        ],
      },
      {
        text: 'Shipping is free over $50.',
        finishReason: 'stop',
        toolCalls: [],
      },
    ];
    const seenToolSets: string[][] = [];

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { tools?: Record<string, unknown> }) => {
          seenToolSets.push(Object.keys(opts.tools ?? {}).sort());
          const turn = modelTurns.shift();
          if (!turn) {
            throw new Error('unexpected extra model turn');
          }
          return {
            fullStream: (async function* () {
              if (turn.text) {
                yield Object.assign({ type: 'text-delta' }, { text: turn.text });
              }
            })(),
            finishReason: Promise.resolve(turn.finishReason),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve(turn.toolCalls),
          };
        },
      };
    });

    const specialist = defineAgent({
      id: 'specialist',
      instructions: 'Answer with knowledge.',
      knowledge: { autoRetrieve: false },
      model: stubModel,
    });
    const host = defineAgent({
      id: 'host',
      instructions: 'Route when needed.',
      handoffs: ['specialist'],
      agents: [specialist],
      model: stubModel,
    });
    const runtime = createRuntime({
      agents: [host, specialist],
      defaultAgentId: 'host',
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      knowledge: createInMemoryKnowledgeConfig([SEED_DOC]),
    });

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    const handle = runtime.run({
      sessionId: 'handoff-on-demand-knowledge',
      input: 'I need shipping help',
      driver: new TextDriver(),
    });
    for await (const part of handle.events) {
      parts.push(part);
    }
    const result = await handle;

    expect(result.text).toContain('Shipping is free over $50.');
    expect(seenToolSets[0]).toContain('transfer_to_agent');
    expect(seenToolSets.some((toolNames) => toolNames.includes('knowledge_search'))).toBe(true);
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'tool-result', toolName: 'knowledge_search' }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'knowledge-search', query: 'shipping' }),
    );
  });

  it('handoff rebuilds the full target tool surface without opening-agent leakage', async () => {
    const hostMarker = { seen: false };
    const specialistMarker = { seen: false };
    const hostOnly = defineTool({
      name: 'host_only',
      description: 'Host-only lookup',
      input: z.object({ q: z.string() }),
      execute: async () => {
        hostMarker.seen = true;
        return { agent: 'host' };
      },
    });
    const specialistOnly = defineTool({
      name: 'specialist_only',
      description: 'Specialist-only lookup',
      input: z.object({ q: z.string() }),
      execute: async () => {
        specialistMarker.seen = true;
        return { agent: 'specialist' };
      },
    });

    const modelTurns = [
      {
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolName: 'transfer_to_agent',
            toolCallId: 'handoff-1',
            input: { targetAgentId: 'specialist', reason: 'needs specialist' },
          },
        ],
      },
      { finishReason: 'stop', toolCalls: [] },
      {
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolName: 'specialist_only',
            toolCallId: 'specialist-1',
            input: { q: 'ping' },
          },
          {
            toolName: 'memory_block',
            toolCallId: 'memory-1',
            input: { action: 'add', block: 'USER', content: 'likes teal' },
          },
          {
            toolName: 'knowledge_search',
            toolCallId: 'knowledge-1',
            input: { query: 'shipping' },
          },
          {
            toolName: 'workspace',
            toolCallId: 'workspace-1',
            input: { op: 'cat', path: '/marker.txt' },
          },
        ],
      },
      {
        text: 'Specialist answered with grounded context.',
        finishReason: 'stop',
        toolCalls: [],
      },
    ];
    const seenToolSets: string[][] = [];
    let capturedSpecialistSystem = '';

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: { tools?: Record<string, unknown>; system?: string }) => {
          seenToolSets.push(Object.keys(opts.tools ?? {}).sort());
          if (seenToolSets.length >= 3) {
            capturedSpecialistSystem = opts.system ?? '';
          }
          const turn = modelTurns.shift();
          if (!turn) {
            throw new Error('unexpected extra model turn');
          }
          return {
            fullStream: (async function* () {
              if (turn.text) {
                yield Object.assign({ type: 'text-delta' }, { text: turn.text });
              }
            })(),
            finishReason: Promise.resolve(turn.finishReason),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve(turn.toolCalls),
          };
        },
      };
    });

    const memoryStore = new InMemoryPersistentMemoryStore();
    const specialist = defineAgent({
      id: 'specialist',
      instructions: 'Answer with knowledge.',
      knowledge: { autoRetrieve: false },
      globalTools: { specialist_only: specialistOnly },
      workspace: new InMemoryFs({ '/marker.txt': 'SPECIALIST_FS' }),
      memory: {
        workingMemory: {
          store: memoryStore,
          autoLoad: [{ scope: 'user', key: 'USER' }],
        },
      },
      skills: [
        {
          name: 'specialist-skill',
          description: 'Specialist policy.',
          body: 'SPECIALIST_SKILL_MARKER',
          allowedTools: [],
        },
      ],
      model: stubModel,
    });
    const host = defineAgent({
      id: 'host',
      instructions: 'Route when needed.',
      handoffs: ['specialist'],
      globalTools: { host_only: hostOnly },
      workspace: new InMemoryFs({ '/marker.txt': 'HOST_FS' }),
      skills: [
        {
          name: 'host-skill',
          description: 'Host policy.',
          body: 'HOST_SKILL_MARKER',
          allowedTools: [],
        },
      ],
      agents: [specialist],
      model: stubModel,
    });
    const runtime = createRuntime({
      agents: [host, specialist],
      defaultAgentId: 'host',
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
      knowledge: createInMemoryKnowledgeConfig([SEED_DOC]),
    });

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    const handle = runtime.run({
      sessionId: 'handoff-full-surface',
      input: 'I need shipping help',
      userId: 'user-handoff-surface',
      driver: new TextDriver(),
    });
    for await (const part of handle.events) {
      parts.push(part);
    }
    const result = await handle;

    const specialistToolSet = seenToolSets[seenToolSets.length - 2] ?? [];
    expect(result.text).toContain('Specialist answered with grounded context.');
    expect(specialistToolSet).toContain('knowledge_search');
    expect(specialistToolSet).toContain('memory_block');
    expect(specialistToolSet).toContain('specialist_only');
    expect(specialistToolSet).toContain('workspace');
    expect(specialistToolSet).not.toContain('host_only');
    expect(capturedSpecialistSystem).toContain('specialist-skill');
    expect(capturedSpecialistSystem).not.toContain('host-skill');
    expect(hostMarker.seen).toBe(false);
    expect(specialistMarker.seen).toBe(true);
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'tool-result', toolName: 'knowledge_search' }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'tool-result', toolName: 'memory_block' }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        toolName: 'workspace',
        result: expect.objectContaining({ content: 'SPECIALIST_FS' }),
      }),
    );
  });

  it('driver-injected global tool def remains exactly-once across replay', async () => {
    const spy = { count: 0 };
    const injectedGlobalTool = defineTool({
      name: 'global_lookup',
      description: 'Global lookup',
      input: z.object({ query: z.string() }),
      execute: async () => {
        spy.count += 1;
        return { answer: 'cached' };
      },
    });
    const { session, runStore, runState } = await setupDurableHarness(
      'injected-global-once',
      'injected-global-run',
    );

    const ctx1 = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });
    const call = {
      toolName: 'global_lookup',
      input: { query: 'policy' },
      toolCallId: 'global-call-1',
    };

    const first = await executeModelToolCall(ctx1, call, { global_lookup: injectedGlobalTool });
    expect(first).toMatchObject({ failed: false, result: { answer: 'cached' } });
    expect(spy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await createRunContext({
      session,
      runState: reloaded,
      runStore,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });
    const second = await executeModelToolCall(ctx2, call, { global_lookup: injectedGlobalTool });

    expect(second).toMatchObject({ failed: false, result: { answer: 'cached' } });
    expect(spy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });

  it('registry-shadow global tool def remains exactly-once across replay', async () => {
    const spy = { count: 0 };
    const registryTool = defineTool({
      name: 'global_lookup',
      description: 'Registry lookup',
      input: z.object({ query: z.string() }),
      execute: async () => {
        spy.count += 1;
        return { answer: 'registry' };
      },
    });
    const injectedGlobalTool = defineTool({
      name: 'global_lookup',
      description: 'Injected lookup',
      input: z.object({ query: z.string() }),
      execute: async () => {
        spy.count += 1;
        return { answer: 'injected' };
      },
    });
    const { session, runStore, runState } = await setupDurableHarness(
      'registry-shadow-once',
      'registry-shadow-run',
    );

    const ctx1 = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { global_lookup: registryTool } }),
      model: stubModel,
      emit: () => {},
    });
    const call = {
      toolName: 'global_lookup',
      input: { query: 'policy' },
      toolCallId: 'global-call-1',
    };

    const first = await executeModelToolCall(ctx1, call, { global_lookup: injectedGlobalTool });
    expect(first).toMatchObject({ failed: false, result: { answer: 'injected' } });
    expect(spy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await createRunContext({
      session,
      runState: reloaded,
      runStore,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor: new CoreToolExecutor({ tools: { global_lookup: registryTool } }),
      model: stubModel,
      emit: () => {},
    });
    const second = await executeModelToolCall(ctx2, call, { global_lookup: injectedGlobalTool });

    expect(second).toMatchObject({ failed: false, result: { answer: 'injected' } });
    expect(spy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });
});
