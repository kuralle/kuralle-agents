import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineTool, CoreToolExecutor, ToolValidationError } from '../../src/tools/effect/index.js';
import { createMockSession } from '../../src/testing/mocks.js';

describe('core-v2 tools pairing', () => {
  it('every tool call leaves a request+response pair on success', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo input',
      execute: async (args) => args,
    });
    const executor = new CoreToolExecutor({ tools: { echo } });
    const session = createMockSession({ id: 's1' });

    const result = await executor.execute({ name: 'echo', args: { msg: 'hi' }, session });
    expect(result).toEqual({ msg: 'hi' });

    const pairs = executor.getPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.request.name).toBe('echo');
    expect(pairs[0]?.response.status).toBe('completed');
    expect(pairs[0]?.response.result).toEqual({ msg: 'hi' });
  });

  it('cancelled tool yields CANCELLED placeholder with no dangling request', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'Slow tool',
      interruptible: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { done: true };
      },
    });
    const executor = new CoreToolExecutor({ tools: { slow } });
    const session = createMockSession({ id: 's1' });
    const controller = new AbortController();

    const pending = executor.execute({
      name: 'slow',
      args: {},
      session,
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const result = await pending;
    expect(result).toEqual({
      __tool_status: 'CANCELLED',
      requestId: expect.any(String),
      name: 'slow',
    });

    const pairs = executor.getPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.response.status).toBe('cancelled');
    expect(pairs[0]?.response.result).toMatchObject({ __tool_status: 'CANCELLED' });
  });

  it('pre-aborted signal returns CANCELLED without calling execute', async () => {
    let executed = false;
    const tool = defineTool({
      name: 'noop',
      description: 'Noop',
      execute: async () => {
        executed = true;
        return {};
      },
    });
    const executor = new CoreToolExecutor({ tools: { noop: tool } });
    const session = createMockSession({ id: 's1' });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute({
      name: 'noop',
      args: {},
      session,
      abortSignal: controller.signal,
    });

    expect(result).toMatchObject({ __tool_status: 'CANCELLED' });
    expect(executed).toBe(false);
    expect(executor.getPairs()[0]?.response.status).toBe('cancelled');
  });
});

describe('core-v2 tools arg sanitization', () => {
  it('rejects bad args before execute hits backend', async () => {
    let backendHit = false;
    const tool = defineTool({
      name: 'create_ticket',
      description: 'Create ticket',
      input: z.object({
        title: z.string().min(1),
        priority: z.enum(['low', 'high']),
      }),
      execute: async (args) => {
        backendHit = true;
        return args;
      },
    });
    const executor = new CoreToolExecutor({ tools: { create_ticket: tool } });
    const session = createMockSession({ id: 's1' });

    await expect(
      executor.execute({
        name: 'create_ticket',
        args: { title: '', priority: 'urgent' },
        session,
      }),
    ).rejects.toBeInstanceOf(ToolValidationError);

    expect(backendHit).toBe(false);
    expect(executor.getPairs()[0]?.response.status).toBe('validation_failed');
  });

  it('passes sanitized args to execute', async () => {
    let received: unknown;
    const tool = defineTool({
      name: 'trim_echo',
      description: 'Trim echo',
      input: z.object({ name: z.string().trim().min(1) }),
      execute: async (args) => {
        received = args;
        return args;
      },
    });
    const executor = new CoreToolExecutor({ tools: { trim_echo: tool } });
    const session = createMockSession({ id: 's1' });

    await executor.execute({ name: 'trim_echo', args: { name: '  alice  ' }, session });
    expect(received).toEqual({ name: 'alice' });
  });
});

describe('core-v2 tools parallel-off', () => {
  it('executes two tool calls sequentially by default', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = defineTool({
      name: 'first',
      description: 'First',
      execute: async () => {
        order.push('first-start');
        await gate;
        order.push('first-end');
        return { n: 1 };
      },
    });
    const second = defineTool({
      name: 'second',
      description: 'Second',
      execute: async () => {
        order.push('second-start');
        order.push('second-end');
        return { n: 2 };
      },
    });

    const executor = new CoreToolExecutor({ tools: { first, second } });
    const session = createMockSession({ id: 's1' });

    const p1 = executor.execute({ name: 'first', args: {}, session });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = executor.execute({ name: 'second', args: {}, session });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
});

describe('core-v2 tools interim watchdog', () => {
  it('emits interim IN_PROGRESS placeholder for slow tools', async () => {
    const interimMessages: string[] = [];
    const slow = defineTool({
      name: 'lookup',
      description: 'Lookup',
      interim: 'Still searching…',
      interimAfterMs: 30,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { found: true };
      },
    });
    const executor = new CoreToolExecutor({
      tools: { lookup: slow },
      onInterim: (msg) => interimMessages.push(msg),
    });
    const session = createMockSession({ id: 's1' });

    const result = await executor.execute({ name: 'lookup', args: {}, session });
    expect(result).toEqual({ found: true });
    expect(interimMessages).toEqual(['Still searching…']);

    const pair = executor.getPairs()[0];
    expect(pair?.response.status).toBe('completed');
  });
});
