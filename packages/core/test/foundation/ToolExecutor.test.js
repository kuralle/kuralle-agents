import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DefaultToolExecutor } from '../../dist/foundation/DefaultToolExecutor.js';
import { ToolEnforcer } from '../../dist/guards/ToolEnforcer.js';
import { HookRunner } from '../../dist/hooks/HookRunner.js';

function makeSession(overrides = {}) {
  const now = new Date();
  return {
    id: 'sess-1',
    messages: [],
    createdAt: now,
    updatedAt: now,
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    state: {},
    metadata: { createdAt: now, lastActiveAt: now, totalTokens: 0, totalSteps: 0, handoffHistory: [] },
    agentStates: {},
    handoffHistory: [],
    ...overrides,
  };
}

function makeTool(fn = async () => 'ok') {
  return {
    description: 'test tool',
    parameters: z.object({}),
    execute: fn,
  };
}

describe('DefaultToolExecutor', () => {
  it('executes a tool and returns result', async () => {
    const executor = new DefaultToolExecutor({
      enforcer: new ToolEnforcer([]),
      hookRunner: new HookRunner(),
    });

    const result = await executor.execute({
      session: makeSession(),
      agentId: 'agent-1',
      toolName: 'echo',
      tool: makeTool(async () => 'hello'),
      input: {},
    });

    assert.equal(result, 'hello');
  });

  it('blocks execution when enforcement denies', async () => {
    const blockRule = {
      name: 'block-all',
      description: 'blocks everything',
      appliesTo: '*',
      check: () => ({ allowed: false, reason: 'denied' }),
    };

    const hookErrors = [];
    const hookRunner = new HookRunner({
      onToolError: async (_ctx, call, err) => { hookErrors.push({ call, err }); },
    });

    const executor = new DefaultToolExecutor({
      enforcer: new ToolEnforcer([blockRule]),
      hookRunner,
    });

    await assert.rejects(
      () => executor.execute({
        session: makeSession(),
        agentId: 'agent-1',
        toolName: 'echo',
        tool: makeTool(),
        input: {},
      }),
      { message: 'denied' },
    );

    assert.equal(hookErrors.length, 1);
    assert.equal(hookErrors[0].err.message, 'denied');
  });

  it('generates correct idempotency key format', () => {
    const executor = new DefaultToolExecutor({
      enforcer: new ToolEnforcer([]),
      hookRunner: new HookRunner(),
    });

    const key = executor.buildIdempotencyKey({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      step: 3,
      toolName: 'book',
      toolCallId: 'tc-42',
    });

    assert.equal(key, 'sess-1:agent-1:3:book:tc-42');
  });

  it('throws if tool has no execute function', async () => {
    const executor = new DefaultToolExecutor({
      enforcer: new ToolEnforcer([]),
      hookRunner: new HookRunner(),
    });

    await assert.rejects(
      () => executor.execute({
        session: makeSession(),
        agentId: 'agent-1',
        toolName: 'bad',
        tool: { description: 'no exec', parameters: z.object({}) },
        input: {},
      }),
      { message: /does not have an execute function/ },
    );
  });

  it('propagates tool execution errors', async () => {
    const executor = new DefaultToolExecutor({
      enforcer: new ToolEnforcer([]),
      hookRunner: new HookRunner(),
    });

    await assert.rejects(
      () => executor.execute({
        session: makeSession(),
        agentId: 'agent-1',
        toolName: 'fail',
        tool: makeTool(async () => { throw new Error('boom'); }),
        input: {},
      }),
      { message: 'boom' },
    );
  });
});
