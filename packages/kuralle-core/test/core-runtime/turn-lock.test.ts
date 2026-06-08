import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, decide, defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { makeTestSession, setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  consumePendingUserInput,
  hasPendingUserInput,
  peekPendingUserInput,
  setPendingUserInput,
} from '../../src/runtime/channels/inputBuffer.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';

function replyFlow() {
  const node = reply({ id: 'r', instructions: 'ok', next: () => ({ end: 'done' }) });
  return defineFlow({ name: 'reply-flow', description: 'x', start: node, nodes: [node] });
}

describe('H3 per-session turn lock', () => {
  it('does not drop user input when two runs overlap on the same session', async () => {
    const flow = replyFlow();
    const sessionStore = new MemoryStore();
    const sessionId = 'overlap-sess';
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
    });

    const h1 = runtime.run({ sessionId, input: 'A', driver });
    const h2 = runtime.run({ sessionId, input: 'B', driver });
    await Promise.all([h1, h2]);

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = await runStore.getRunState(sessionDerivedRunId(sessionId));
    const userInputs = (runState?.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => String(m.content));
    expect(userInputs).toContain('A');
    expect(userInputs).toContain('B');
  });

  it('serializes overlapping runs so only one turn body is in flight per session', async () => {
    const flow = replyFlow();
    let inFlight = 0;
    let maxInFlight = 0;
    let turn = 0;
    const order: string[] = [];

    const driver: ChannelDriver = {
      async runAgentTurn() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        turn += 1;
        const id = turn;
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`end-${id}`);
        inFlight -= 1;
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    const sessionStore = new MemoryStore();
    const sessionId = 'serial-sess';
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
    });

    const h1 = runtime.run({ sessionId, input: 'first', driver });
    const h2 = runtime.run({ sessionId, input: 'second', driver });
    await Promise.all([h1, h2]);

    expect(maxInFlight).toBe(1);
    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(order[0]).toBe('start-1');
  });

  it('allows concurrent runs on different sessionIds', async () => {
    const flow = replyFlow();
    let inFlight = 0;
    let maxInFlight = 0;

    const driver: ChannelDriver = {
      async runAgentTurn() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight -= 1;
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
    });

    await Promise.all([
      runtime.run({ sessionId: 'sess-A', input: 'a', driver }),
      runtime.run({ sessionId: 'sess-B', input: 'b', driver }),
    ]);

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('does not wedge the queue when the first turn throws', async () => {
    const flow = replyFlow();
    let hostCalls = 0;
    const sessionStore = new MemoryStore();
    const sessionId = 'error-sess';

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async (): Promise<HostSelection> => {
        hostCalls += 1;
        if (hostCalls === 1) {
          throw new Error('first turn hard fail');
        }
        return { kind: 'enterFlow', flow };
      },
    });

    let driverCalls = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        driverCalls += 1;
        // Empty host turns invoke the lazy guard; flow nodes answer with prose.
        return { text: driverCalls <= 2 ? '' : 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    await expect(runtime.run({ sessionId, input: 'one', driver })).rejects.toThrow('first turn hard fail');

    const second = await runtime.run({ sessionId, input: 'two', driver });
    expect(second.text).toBe('ok');
    expect(hostCalls).toBe(2);
  });
});

describe('H3 FIFO input inbox', () => {
  it('consumePendingUserInput on empty returns empty string without throwing', () => {
    const session = makeTestSession('empty-buffer');
    expect(consumePendingUserInput(session)).toBe('');
    expect(() => consumePendingUserInput(session)).not.toThrow();
  });

  it('dequeues in FIFO order and clears peek/has when drained', () => {
    const session = makeTestSession('fifo');
    setPendingUserInput(session, 'x');
    setPendingUserInput(session, 'y');
    expect(hasPendingUserInput(session)).toBe(true);
    expect(peekPendingUserInput(session)).toBe('x');
    expect(consumePendingUserInput(session)).toBe('x');
    expect(peekPendingUserInput(session)).toBe('y');
    expect(consumePendingUserInput(session)).toBe('y');
    expect(hasPendingUserInput(session)).toBe(false);
    expect(consumePendingUserInput(session)).toBe('');
  });

  it('coerces a legacy string slot into a single-item queue', () => {
    const session = makeTestSession('legacy');
    session.workingMemory['__v2_pendingUserInput'] = 'legacy';
    expect(peekPendingUserInput(session)).toBe('legacy');
    expect(consumePendingUserInput(session)).toBe('legacy');
    expect(hasPendingUserInput(session)).toBe(false);
  });
});

describe('H3 parking unchanged', () => {
  it('interactive decide with no pending input still pauses instead of auto-deciding', async () => {
    let decided = 0;
    const pick = decide({
      id: 'pick',
      instructions: 'Pick A or B',
      schema: z.object({ choice: z.string() }),
      decide: () => {
        decided += 1;
        return { end: 'done' };
      },
    });
    pick.choices = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const start = action({ id: 'start', run: async () => pick });
    const flow = defineFlow({ name: 'await-flow', description: 'x', start, nodes: [start, pick] });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser(ctx) {
        return { type: 'message', input: consumePendingUserInput(ctx.session) };
      },
      async runStructured() {
        return { choice: 'a' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('park-sess', 'park-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });
    ctx.turnInputConsumed = true;

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(decided).toBe(0);
  });
});
