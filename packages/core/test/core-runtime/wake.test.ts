import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import {
  createInProcessScheduler,
  createWakeJobRunner,
  createScheduleFollowupTool,
  wakeJob,
  WAKE_JOB_KIND,
  type ScheduledJob,
  type WakeDelivery,
} from '../../src/scheduler/index.js';
import type { ChannelDriver, ResolvedNode } from '../../src/types/channel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { ToolContext } from '../../src/types/run-context.js';

function proactiveDriver(reply = 'Hi! Your cart is waiting — ready to check out?') {
  const prompts: string[] = [];
  const driver: ChannelDriver = {
    async runAgentTurn(node: ResolvedNode) {
      prompts.push(node.prompt);
      return { text: reply, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
  return { driver, prompts };
}

describe('wake turns', () => {
  it('runs an agent-initiated turn: wake note in history, wake part emitted, reply recorded', async () => {
    const sessionStore = new MemoryStore();
    const { driver } = proactiveDriver();
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'commerce agent', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
    });

    // seed a conversation first
    await runtime.run({ sessionId: 'wake-sess', input: 'I want the blue shirt', driver });

    const handle = runtime.run({
      sessionId: 'wake-sess',
      wake: { reason: 'cart abandoned for 2 hours', payload: { cartId: 'c-1' } },
      driver,
    });
    const parts: HarnessStreamPart[] = [];
    for await (const part of handle.events) parts.push(part);
    const result = await handle;

    const wakePart = parts.find((part) => part.type === 'wake');
    expect(wakePart).toBeDefined();
    if (wakePart?.type === 'wake') {
      expect(wakePart.reason).toBe('cart abandoned for 2 hours');
    }
    expect(result.text).toContain('ready to check out');

    const runStore = new SessionRunStore(sessionStore, 'wake-sess');
    const runState = await runStore.getRunState(sessionDerivedRunId('wake-sess'));
    const wakeNote = runState?.messages.find(
      (message) =>
        message.role === 'system' && String(message.content).includes('[Scheduled wake:'),
    );
    expect(wakeNote).toBeDefined();
    expect(String(wakeNote?.content)).toContain('cart abandoned for 2 hours');
    expect(String(wakeNote?.content)).toContain('c-1');
    // no fabricated user message
    const userMessages = runState?.messages.filter((m) => m.role === 'user') ?? [];
    expect(userMessages).toHaveLength(1);
  });

  it('rejects wake combined with input', () => {
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'x', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
    });
    expect(() => runtime.run({ sessionId: 's', input: 'hi', wake: { reason: 'r' } })).toThrow(
      'mutually exclusive',
    );
  });
});

describe('createWakeJobRunner + createInProcessScheduler', () => {
  it('delivers the wake turn output end-to-end through the scheduler', async () => {
    const sessionStore = new MemoryStore();
    const { driver } = proactiveDriver('Following up as promised!');
    const baseRuntime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'x', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
    });
    await baseRuntime.run({ sessionId: 'job-sess', input: 'remind me later', driver });

    const deliveries: WakeDelivery[] = [];
    const runWake = createWakeJobRunner(
      {
        run: ({ sessionId, wake }) => baseRuntime.run({ sessionId, wake, driver }),
      },
      { deliver: async (delivery) => void deliveries.push(delivery) },
    );

    let fire: (() => void) | undefined;
    const scheduler = createInProcessScheduler({
      run: runWake,
      timer: {
        set: (fn) => {
          fire = fn;
          return 1;
        },
        clear: () => {},
      },
    });

    await scheduler.enqueue(wakeJob({ sessionId: 'job-sess', reason: 'follow up' }), {
      delayMs: 60_000,
    });
    expect(deliveries).toHaveLength(0);
    fire!();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe('job-sess');
    expect(deliveries[0]?.text).toBe('Following up as promised!');
    expect(deliveries[0]?.parts.some((part) => part.type === 'wake')).toBe(true);
  });

  it('ignores non-wake jobs and reports wake errors via onError', async () => {
    const errors: ScheduledJob[] = [];
    const runWake = createWakeJobRunner(
      {
        run: () => {
          throw new Error('runtime down');
        },
      },
      {
        deliver: async () => {},
        onError: (_error, job) => void errors.push(job),
      },
    );

    await runWake({ kind: 'other.job', payload: {} });
    expect(errors).toHaveLength(0);

    const job = wakeJob({ sessionId: 's', reason: 'r' });
    await runWake(job);
    expect(errors).toEqual([job]);
  });
});

describe('createScheduleFollowupTool', () => {
  it('enqueues a wake job for the current session with the requested delay', async () => {
    const enqueued: Array<{ job: ScheduledJob; delayMs?: number }> = [];
    const tool = createScheduleFollowupTool({
      enqueue: async (job, opts) => {
        enqueued.push({ job, delayMs: opts?.delayMs });
        return 'job-1';
      },
      cancel: async () => {},
    });

    const result = await tool.execute(
      { delayMinutes: 30, reason: 'user said ping me after lunch' },
      { session: { id: 'sess-42' } } as unknown as ToolContext,
    );

    expect(result).toEqual({ scheduled: true, jobId: 'job-1', inMinutes: 30 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.delayMs).toBe(1_800_000);
    expect(enqueued[0]?.job.kind).toBe(WAKE_JOB_KIND);
    expect(enqueued[0]?.job.payload.sessionId).toBe('sess-42');
  });
});
