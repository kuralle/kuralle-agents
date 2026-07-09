import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { executeModelToolCall } from '../../src/runtime/channels/executeModelTool.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import {
  CoreToolExecutor,
  defineTool,
  ToolTimeoutError,
} from '../../src/tools/effect/index.js';
import { createObservabilityHooks } from '../../src/hooks/builtin/observability.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { createMockSession } from '../../src/testing/mocks.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

describe('tool interim filler', () => {
  it('emits text-delta via onInterim before the tool completes', async () => {
    const parts: HarnessStreamPart[] = [];
    const slow = defineTool({
      name: 'lookup',
      description: 'Lookup',
      interim: 'one sec…',
      interimAfterMs: 10,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { found: true };
      },
    });
    const executor = new CoreToolExecutor({
      tools: { lookup: slow },
      onInterim: (message) => { const id = crypto.randomUUID(); parts.push({ type: 'text-start', id }); parts.push({ type: 'text-delta', id, delta: message }); parts.push({ type: 'text-end', id }); },
    });
    const session = createMockSession({ id: 's1' });

    const result = await executor.execute({ name: 'lookup', args: {}, session });
    expect(result).toEqual({ found: true });
    expect(parts.some((p) => p.type === 'text-delta' && p.delta === 'one sec…')).toBe(true);
    const fillerIdx = parts.findIndex((p) => p.type === 'text-delta' && p.delta === 'one sec…');
    expect(fillerIdx).toBeGreaterThanOrEqual(0);
  });

  it('does not emit filler when interim is unset', async () => {
    const parts: HarnessStreamPart[] = [];
    const fast = defineTool({
      name: 'ping',
      description: 'Ping',
      execute: async () => ({ ok: true }),
    });
    const executor = new CoreToolExecutor({
      tools: { ping: fast },
      onInterim: (message) => { const id = crypto.randomUUID(); parts.push({ type: 'text-start', id }); parts.push({ type: 'text-delta', id, delta: message }); parts.push({ type: 'text-end', id }); },
    });
    const session = createMockSession({ id: 's1' });

    await executor.execute({ name: 'ping', args: {}, session });
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(0);
  });
});

describe('tool timeoutMs', () => {
  it('throws ToolTimeoutError when execution exceeds timeoutMs', async () => {
    const hung = defineTool({
      name: 'hung',
      description: 'Never finishes in time',
      timeoutMs: 20,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { done: true };
      },
    });
    const executor = new CoreToolExecutor({ tools: { hung } });
    const session = createMockSession({ id: 's1' });

    await expect(executor.execute({ name: 'hung', args: {}, session })).rejects.toBeInstanceOf(
      ToolTimeoutError,
    );
  });

  it('routes timeout through executeModelToolCall as toolErrorResult', async () => {
    const hung = defineTool({
      name: 'hung',
      description: 'Hung',
      timeoutMs: 20,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
    });
    const { session, runStore, runState } = await setupDurableHarness('timeout-sess', 'timeout-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { hung } }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const outcome = await executeModelToolCall(
      ctx,
      { toolName: 'hung', input: {}, toolCallId: 'tc-1' },
      { hung },
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.result).toMatchObject({ error: true, message: expect.stringContaining('timeout') });
  });

  it('completes normally when timeoutMs is unset', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'Slow but allowed',
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
    });
    const executor = new CoreToolExecutor({ tools: { slow } });
    const session = createMockSession({ id: 's1' });

    await expect(executor.execute({ name: 'slow', args: {}, session })).resolves.toEqual({
      ok: true,
    });
  });

  it('clears the timeout timer on normal completion (no late throw)', async () => {
    const quick = defineTool({
      name: 'quick',
      description: 'Finishes before timeout',
      timeoutMs: 100,
      execute: async () => ({ ok: true }),
    });
    const executor = new CoreToolExecutor({ tools: { quick } });
    const session = createMockSession({ id: 's1' });

    await executor.execute({ name: 'quick', args: {}, session });
    await new Promise((r) => setTimeout(r, 150));
  });
});

describe('defineTool filler alias convergence', () => {
  it('maps filler and estimatedDurationMs to interim fields', async () => {
    const parts: string[] = [];
    const legacy = defineTool({
      name: 'legacy',
      description: 'Legacy filler',
      filler: 'hold on…',
      estimatedDurationMs: 10,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    });
    expect(legacy.interim).toBe('hold on…');
    expect(legacy.interimAfterMs).toBe(10);

    const executor = new CoreToolExecutor({
      tools: { legacy },
      onInterim: (msg) => parts.push(msg),
    });
    await executor.execute({ name: 'legacy', args: {}, session: createMockSession({ id: 's1' }) });
    expect(parts).toEqual(['hold on…']);
  });
});

describe('extraction telemetry', () => {
  it('emits flow.extraction.submission and update from collect merge', async () => {
    const replyNode = reply({
      id: 'confirm',
      instructions: 'Confirm.',
      next: () => ({ end: 'done' }),
    });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1), email: z.string().optional() }),
      required: ['name'],
      onComplete: () => replyNode,
    });
    const flow = defineFlow({
      name: 'telemetry-flow',
      description: 'telemetry',
      start: collectNode,
      nodes: [collectNode, replyNode],
    });

    const parts: HarnessStreamPart[] = [];
    const driver = {
      async runExtraction() {
        return {
          text: 'ignored',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Riley', email: '' },
              result: { name: 'Riley', email: '' },
            },
          ],
        };
      },
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'Riley here' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('ext-tel-sess', 'ext-tel-run');
    runState.messages = [{ role: 'user', content: 'Riley here' }];
    runState.activeFlow = flow.name;
    runState.activeNode = collectNode.id;
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    await runFlow(flow, runState, driver, ctx);

    const submission = parts.find(
      (p) => p.type === 'custom' && p.name === 'flow.extraction.submission',
    );
    expect(submission).toBeDefined();
    if (submission?.type === 'custom') {
      const data = submission.data as {
        fieldsAccepted?: string[];
        fieldsRejected?: string[];
      };
      expect(data.fieldsAccepted).toContain('name');
      expect(data.fieldsRejected).toContain('email');
    }

    const update = parts.find((p) => p.type === 'custom' && p.name === 'flow.extraction.update');
    expect(update).toBeDefined();
    if (update?.type === 'custom') {
      const data = update.data as { collected?: Record<string, unknown>; missing?: string[] };
      expect(data.collected?.name).toBe('Riley');
      expect(data.missing).toEqual([]);
    }
  });

  it('feeds the observability hook extractionSubmissions', async () => {
    let exported: import('../../src/types/telemetry.js').SessionTrace | null = null;
    const hooks = createObservabilityHooks({
      exporter: async (trace) => {
        exported = trace;
      },
    });
    const { session, runStore, runState } = await setupDurableHarness('obs-ext-sess', 'obs-ext-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });
    const hookCtx: import('../../src/types/session.js').RunContext = {
      session,
      agentId: runState.activeAgentId ?? 'test-agent',
      stepCount: 0,
      totalTokens: 0,
      handoffStack: [],
      startTime: Date.now(),
      consecutiveErrors: 0,
      toolCallHistory: [],
    };
    await hooks.onStart?.(hookCtx);
    await hooks.onStreamPart?.(hookCtx, {
      type: 'custom',
      name: 'flow.extraction.submission',
      data: { node: 'contact', fieldsAccepted: ['name'], fieldsRejected: ['notes'] },
    });
    await hooks.onSessionEnd?.(session, { success: true });

    expect(exported).not.toBeNull();
    expect(exported!.extractionSubmissions).toEqual([
      {
        node: 'contact',
        fieldsAccepted: ['name'],
        fieldsRejected: ['notes'],
      },
    ]);
  });
});
