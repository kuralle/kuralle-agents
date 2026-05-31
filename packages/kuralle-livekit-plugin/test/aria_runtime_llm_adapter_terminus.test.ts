/**
 * Stream-termination contract for KuralleRuntimeLLMAdapter.
 *
 * Pins the behavior that LiveKit's TTS pipeline depends on: the cascaded
 * adapter MUST cleanly terminate its LLMStream when the Kuralle Runtime
 * stream ends — regardless of the final part's type (`text-delta`,
 * `handoff`, `flow-transition`, `done`, or simply running off the end).
 *
 * Symptom this test guards against: GH #29 — Deepgram TTS stalls until
 * force-close because a downstream consumer waits for an explicit terminus
 * that never arrives. The base LiveKit `LLMStream` closes its queue when
 * the `mainTask().finally(...)` settles (i.e. when `run()` returns), so
 * the contract here is: `run()` MUST return within a deterministic
 * deadline, not block forever.
 */

import { describe, expect, test } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import {
  KuralleRuntimeLLMAdapter,
  type KuralleRuntimeLike,
  type KuralleRuntimeRunOptions,
} from '../src/llm/KuralleRuntimeLLMAdapter.js';
import { mockTurnHandle } from './mock_turn_handle.js';

initializeLogger({ pretty: false, level: 'warn' });

type DeltaShape = { delta?: { content?: string } };

function mockRuntime(
  gen: () => AsyncGenerator<HarnessStreamPart>,
): KuralleRuntimeLike {
  return {
    run() {
      return mockTurnHandle(gen());
    },
  };
}

async function drainWithDeadline(
  stream: AsyncIterable<DeltaShape>,
  deadlineMs: number,
): Promise<{ text: string; closedWithinDeadline: boolean }> {
  let text = '';
  const start = Date.now();
  const drainPromise = (async () => {
    for await (const chunk of stream) {
      text += chunk?.delta?.content ?? '';
    }
  })();

  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), deadlineMs),
  );
  const result = await Promise.race([drainPromise.then(() => 'done' as const), timeout]);
  const closedWithinDeadline = result === 'done' && Date.now() - start <= deadlineMs;
  return { text, closedWithinDeadline };
}

function chatCtx(input: string) {
  return {
    items: [{ type: 'message', role: 'user', content: input }],
  } as never;
}

describe('KuralleRuntimeLLMAdapter terminus contract (GH #29 regression guard)', () => {
  test('closes cleanly when Runtime stream ends with text-delta only', async () => {
    const runtime = mockRuntime(async function* () {
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'text-delta', text: ' world' };
    });
    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({ chatCtx: chatCtx('greet') });
    const { text, closedWithinDeadline } = await drainWithDeadline(stream, 2000);
    expect(closedWithinDeadline).toBe(true);
    expect(text).toBe('hello world');
  });

  test('closes cleanly when Runtime stream ends on a handoff event (no trailing text)', async () => {
    const handoffEvents: Array<{ targetAgent: string; reason: string }> = [];
    const runtime = mockRuntime(async function* () {
      yield { type: 'text-delta', text: 'transferring' };
      yield {
        type: 'handoff',
        targetAgent: 'tracking',
        reason: 'user wants order tracking',
      };
    });
    const adapter = new KuralleRuntimeLLMAdapter({
      runtime,
      onKuralleHandoff: (targetAgent, reason) => {
        handoffEvents.push({ targetAgent, reason });
      },
    });

    const stream = adapter.chat({ chatCtx: chatCtx('track my order') });
    const { closedWithinDeadline } = await drainWithDeadline(stream, 2000);

    expect(closedWithinDeadline).toBe(true);
    expect(handoffEvents).toEqual([
      { targetAgent: 'tracking', reason: 'user wants order tracking' },
    ]);
  });

  test('closes cleanly when Runtime stream ends on a flow-transition event (no trailing text)', async () => {
    const runtime = mockRuntime(async function* () {
      yield { type: 'text-delta', text: 'switching nodes' };
      yield {
        type: 'flow-transition',
        from: 'hub',
        to: 'tracking',
      };
    });
    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({ chatCtx: chatCtx('show me the menu') });
    const { closedWithinDeadline } = await drainWithDeadline(stream, 2000);
    expect(closedWithinDeadline).toBe(true);
  });

  test('closes cleanly when Runtime stream is empty (no events at all)', async () => {
    const runtime = mockRuntime(async function* () {
      // intentionally empty
    });
    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({ chatCtx: chatCtx('hi') });
    const { closedWithinDeadline } = await drainWithDeadline(stream, 2000);
    expect(closedWithinDeadline).toBe(true);
  });

  test('handoff callback rejection does NOT keep the stream open past Runtime end', async () => {
    const runtime = mockRuntime(async function* () {
      yield {
        type: 'handoff',
        targetAgent: 'b',
        reason: 'because',
      };
    });
    const adapter = new KuralleRuntimeLLMAdapter({
      runtime,
      onKuralleHandoff: async () => {
        throw new Error('downstream consumer is broken');
      },
    });

    const stream = adapter.chat({ chatCtx: chatCtx('go') });
    const { closedWithinDeadline } = await drainWithDeadline(stream, 2000);
    expect(closedWithinDeadline).toBe(true);
  });

  test('forwarding still emits text-delta to LiveKit queue when interleaved with handoff', async () => {
    const handoffEvents: Array<{ targetAgent: string; reason: string }> = [];
    const runtime = mockRuntime(async function* () {
      yield { type: 'text-delta', text: 'pre' };
      yield {
        type: 'handoff',
        targetAgent: 'b',
        reason: 'r',
      };
      yield { type: 'text-delta', text: ' post' };
    });
    const adapter = new KuralleRuntimeLLMAdapter({
      runtime,
      onKuralleHandoff: (targetAgent, reason) => {
        handoffEvents.push({ targetAgent, reason });
      },
    });

    const stream = adapter.chat({ chatCtx: chatCtx('combine') });
    const { text, closedWithinDeadline } = await drainWithDeadline(stream, 2000);

    expect(closedWithinDeadline).toBe(true);
    expect(text).toBe('pre post');
    expect(handoffEvents).toHaveLength(1);
  });

  test('rapid stream completion (sub-microsecond) still terminates within deadline', async () => {
    const runtime = mockRuntime(async function* () {
      for (let i = 0; i < 50; i++) {
        yield { type: 'text-delta', text: `${i} ` };
      }
      yield {
        type: 'handoff',
        targetAgent: 'b',
        reason: 'r',
      };
    });
    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({ chatCtx: chatCtx('flood') });
    const { closedWithinDeadline } = await drainWithDeadline(stream, 1000);
    expect(closedWithinDeadline).toBe(true);
  });
});
