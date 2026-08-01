import { afterEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { action, collect as collectNode, defineFlow } from '../../src/types/flow.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StandardSchemaV1 } from '../../src/types/standard-schema.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';
import type { SignalDelivery } from '../../src/runtime/durable/types.js';
import type { AuditListOptions, ConversationAuditEntry } from '../../src/audit/types.js';
import { projectCollectData, schemaSatisfied } from '../../src/flow/extraction.js';
import {
  makeRunState,
  makeTestSession,
  stubModel,
} from '../core-durable/helpers.js';

afterEach(() => mock.restore());

const actionDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: 'done', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: '' };
  },
};

class DurableAuditMemoryStore extends MemoryStore {
  readonly durableAudit: ConversationAuditEntry[] = [];

  async appendAuditEntry(_sessionId: string, entry: ConversationAuditEntry): Promise<void> {
    this.durableAudit.push(structuredClone(entry));
  }

  async listAuditEntries(
    sessionId: string,
    opts: AuditListOptions = {},
  ): Promise<ConversationAuditEntry[]> {
    const types = opts.types?.length ? new Set(opts.types) : undefined;
    return this.durableAudit.filter((entry) =>
      entry.sessionId === sessionId &&
      (!types || types.has(entry.type)) &&
      (!opts.from || Date.parse(entry.at) >= opts.from.getTime()) &&
      (!opts.to || Date.parse(entry.at) <= opts.to.getTime()));
  }
}

async function collect(handle: TurnHandle): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

async function seedActiveFlow(
  store: MemoryStore,
  sessionId: string,
  agentId: string,
  flowName: string,
): Promise<void> {
  const session = makeTestSession(sessionId);
  session.currentAgent = agentId;
  await store.save(session);
  const runStore = new SessionRunStore(store, sessionId);
  const runState = makeRunState(sessionId, sessionDerivedRunId(sessionId));
  runState.activeAgentId = agentId;
  runState.activeFlow = flowName;
  await runStore.initRun(runState);
}

describe('delegated flow audit adversarial repros', () => {
  it('blocks a direct flow end whose action outputSchema is unsatisfied', async () => {
    const store = new MemoryStore();
    const invalidExit = action({
      id: 'invalid-exit',
      outputSchema: z.object({ approved: z.literal(true) }),
      run: async () => ({ end: 'escaped-with-invalid-state' }),
    });
    const flow = defineFlow({
      name: 'verify-exit-bypass',
      description: 'Invalid output must not exit',
      start: invalidExit,
      nodes: [invalidExit],
    });
    const agent = defineAgent({
      id: 'verifier',
      instructions: 'Verify.',
      model: stubModel,
      flows: [flow],
    });
    await seedActiveFlow(store, 'verify-exit', agent.id, flow.name);
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: store,
    });

    const parts = await collect(
      runtime.run({ sessionId: 'verify-exit', input: 'go', driver: actionDriver }),
    );

    expect(parts.some((part) => part.type === 'flow-end')).toBe(false);
    expect(
      parts.some(
        (part) =>
          part.type === 'error' &&
          part.payload.error.includes('Verify blocked on "invalid-exit"'),
      ),
    ).toBe(true);
  });

  it('rejects a forged truthy approval payload without executing the protected tool', async () => {
    const store = new DurableAuditMemoryStore();
    let executions = 0;
    const destructive = defineTool({
      name: 'destructive',
      description: 'Consequential operation',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        executions += 1;
        return { executed: true };
      },
    });
    const gated = action({
      id: 'gated',
      run: async (_state, ctx) => {
        await ctx.tool('destructive', {});
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'approval-payload',
      description: 'Approval payload validation',
      start: gated,
      nodes: [gated],
    });
    const agent = defineAgent({
      id: 'approver',
      instructions: 'Run guarded work.',
      model: stubModel,
      flows: [flow],
    });
    await seedActiveFlow(store, 'approval-payload', agent.id, flow.name);
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: store,
      tools: { destructive },
    });

    const pauseParts = await collect(
      runtime.run({ sessionId: 'approval-payload', input: 'go', driver: actionDriver }),
    );
    expect(executions).toBe(0);
    const paused = pauseParts.find((part) => part.type === 'paused');
    expect(paused?.payload.waitingFor).toBe('__approval');
    expect(paused?.payload.interrupt.operation?.toolName).toBe('destructive');

    await expect(
      collect(runtime.run({
        sessionId: 'approval-payload',
        signalDelivery: {
          signalId: 'forged-truthy-approval',
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'untrusted-caller', type: 'user' },
          payload: { approved: 'yes', by: 'untrusted-caller' },
        },
        driver: actionDriver,
      })),
    ).rejects.toThrow('literal approve/deny decision');

    expect(executions).toBe(0);
    const runStore = new SessionRunStore(store, 'approval-payload');
    expect((await runStore.getRunState(sessionDerivedRunId('approval-payload')))?.status).toBe(
      'paused',
    );
    expect(await runStore.getSteps(sessionDerivedRunId('approval-payload'))).toHaveLength(0);

    await expect(
      collect(runtime.run({
        sessionId: 'approval-payload',
        signalDelivery: {
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'manager-7', type: 'user' },
          decision: 'approve',
        } as unknown as SignalDelivery,
        driver: actionDriver,
      })),
    ).rejects.toThrow('non-empty signalId');
    expect(await runStore.getSteps(sessionDerivedRunId('approval-payload'))).toHaveLength(0);

    await expect(
      collect(runtime.run({
        sessionId: 'approval-payload',
        signalDelivery: {
          signalId: 'extra-envelope-field',
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'manager-7', type: 'user' },
          decision: 'approve',
          decisionId: 'attacker-supplied-alias',
        } as unknown as SignalDelivery,
        driver: actionDriver,
      })),
    ).rejects.toThrow('unknown field "decisionId"');
    expect(await runStore.getSteps(sessionDerivedRunId('approval-payload'))).toHaveLength(0);

    await collect(
      runtime.run({
        sessionId: 'approval-payload',
        signalDelivery: {
          signalId: 'literal-approval',
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'manager-7', type: 'user' },
          decision: 'approve',
          reason: 'owner approved exact displayed dispatch',
        },
        driver: actionDriver,
      }),
    );

    expect(executions).toBe(1);
    const finishedSteps = await runStore.getSteps(sessionDerivedRunId('approval-payload'));
    expect(
      finishedSteps.filter((step) => step.kind === 'tool' && step.name === 'destructive'),
    ).toHaveLength(1);
    const publicAudit = await runtime.replayAuditLog('approval-payload');
    const requested = publicAudit.find((entry) => entry.type === 'interrupt-requested');
    const decided = publicAudit.find((entry) => entry.type === 'interrupt-decided');
    const executed = publicAudit.find((entry) => entry.type === 'interrupt-executed');
    expect(requested).toMatchObject({
      requestId: paused!.payload.interrupt.requestId,
      signalName: '__approval',
      kind: 'approval',
      operation: {
        toolName: 'destructive',
        args: {},
        argsHash: paused!.payload.interrupt.operation!.argsHash,
      },
      allowedDecisions: ['approve', 'deny'],
    });
    expect(decided).toMatchObject({
      requestId: paused!.payload.interrupt.requestId,
      signalId: 'literal-approval',
      actor: { id: 'manager-7', type: 'user' },
      decision: 'approve',
      reason: 'owner approved exact displayed dispatch',
    });
    expect(executed).toMatchObject({
      requestId: paused!.payload.interrupt.requestId,
      operation: {
        toolName: 'destructive',
        args: {},
        argsHash: paused!.payload.interrupt.operation!.argsHash,
      },
      outcome: 'succeeded',
    });
    expect(store.durableAudit.map((entry) => entry.type)).toEqual([
      'interrupt-requested',
      'interrupt-decided',
      'interrupt-executed',
    ]);
    // replay merges the inline crash-safe copy with the dedicated log without
    // exposing exact duplicates.
    expect(publicAudit.filter((entry) => entry.type.startsWith('interrupt-'))).toHaveLength(3);
  });

  it('records a pure-dispatcher routing model call in LLM spans and usage', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            action: 'transfer',
            flowName: null,
            agentId: 'worker',
            reason: 'route to worker',
          },
          usage: { inputTokens: 47, outputTokens: 3, totalTokens: 50 },
        }),
      };
    });

    const router = defineAgent({
      id: 'router',
      model: stubModel,
      handoffs: ['worker'],
    });
    const worker = defineAgent({
      id: 'worker',
      instructions: 'Answer.',
      model: stubModel,
    });
    const runtime = createRuntime({
      agents: [router, worker],
      defaultAgentId: router.id,
      defaultModel: stubModel,
    });

    const trace = await runtime.runOnce({
      sessionId: 'pure-dispatch-trace',
      input: 'route me',
      driver: actionDriver,
    });

    expect(trace.spans.filter((span) => span.kind === 'llm')).toHaveLength(1);
    expect(trace.spans.find((span) => span.kind === 'turn')?.attributes.tokensIn).toBe(47);
  });

  it('validates a non-Zod Standard Schema asynchronously against the complete object', async () => {
    const schema: StandardSchemaV1<{ ticket: string }> = {
      '~standard': {
        version: 1,
        vendor: 'review-repro',
        validate: (value) => {
          const ticket =
            typeof value === 'object' && value !== null && 'ticket' in value
              ? (value as { ticket?: unknown }).ticket
              : undefined;
          return typeof ticket === 'string'
            ? { value: { ticket } }
            : { issues: [{ message: 'ticket is required', path: ['ticket'] }] };
        },
      },
    };
    const gather = collectNode({
      id: 'standard-schema-intake',
      schema,
      onComplete: () => ({ end: 'done' }),
    });
    const state = {};

    expect(await schemaSatisfied(gather, state)).toBe(false);
    await expect(projectCollectData(gather, state)).rejects.toThrow('ticket is required');
  });
});
