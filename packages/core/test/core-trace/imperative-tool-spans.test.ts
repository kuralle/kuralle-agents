import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { runOnce } from '../../src/runtime/TraceRecorder.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { setupDurableHarness, makeTestSession, makeRunState, stubModel } from '../core-durable/helpers.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import {
  mockV3MultiStepStreamModel,
  mockV3StreamResult,
  mockV3ToolCallStreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

describe('imperative ctx.tool spans', () => {
  it('action node ctx.tool calls produce imperative tool spans', async () => {
    const alpha = defineTool({
      name: 'alpha',
      description: 'Alpha',
      input: z.object({}),
      execute: async () => ({ a: 1 }),
    });
    const beta = defineTool({
      name: 'beta',
      description: 'Beta',
      input: z.object({}),
      execute: async () => ({ b: 2 }),
    });

    const act = action({
      id: 'act',
      run: async (_state, actCtx) => {
        await actCtx.tool('alpha', {});
        await actCtx.tool('beta', {});
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'imperative-flow',
      description: 'Imperative tools',
      start: act,
      nodes: [act],
    });

    const { session, runStore, runState } = await setupDurableHarness('imp-span', 'imp-span');
    runState.activeFlow = flow.name;
    const parts: import('../../src/types/stream.js').StreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { alpha, beta } }),
      model: stubModel,
      emit: (p) => parts.push(p),
    });

    await runFlow(flow, runState, new TextDriver({ toolDefs: { alpha, beta } }), ctx);

    const toolCalls = parts.filter((p) => p.type === 'tool-call');
    const toolResults = parts.filter((p) => p.type === 'tool-result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(toolCalls.every((p) => p.payload.imperative === true)).toBe(true);
    expect(toolCalls.map((p) => p.payload.toolName).sort()).toEqual(['alpha', 'beta']);
  });

  it('model-issued tool call produces exactly one span (no duplicate from ctx.tool)', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Lookup',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const ask = reply({
      id: 'ask',
      instructions: 'Use lookup',
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({
      name: 'model-tool-flow',
      description: 'Model tool',
      start: ask,
      nodes: [ask],
    });
    const model = mockV3MultiStepStreamModel([
      () => mockV3ToolCallStreamResult('lookup', 'call-1', '{}', 5),
      () => mockV3StreamResult('Done', 5),
    ]);
    const agent = defineAgent({
      id: 'model-tool-agent',
      instructions: 'Use lookup',
      model,
      tools: { lookup },
      flows: [flow],
    });

    const sessionId = 'model-tool-span';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });

    const trace = await runOnce(runtime, { sessionId, input: 'look up' });
    const lookupSpans = trace.spans.filter(
      (span) => span.kind === 'tool' && span.attributes.toolName === 'lookup',
    );
    expect(lookupSpans).toHaveLength(1);
    expect(lookupSpans[0]?.attributes.imperative).not.toBe(true);
  });
});
