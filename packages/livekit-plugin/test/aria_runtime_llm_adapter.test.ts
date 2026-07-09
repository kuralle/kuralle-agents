import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import {
  KuralleRuntimeLLMAdapter,
  type KuralleRuntimeLike,
  type KuralleRuntimeRunOptions,
} from '../src/llm/KuralleRuntimeLLMAdapter.js';
import type { VoiceMetric, VoiceMetricsSink } from '../src/metrics/types.js';
import { mockTurnHandle } from './mock_turn_handle.js';

initializeLogger({ pretty: false, level: 'warn' });

type RuntimeRunCall = KuralleRuntimeRunOptions;

function mockRuntime(
  gen: (options: RuntimeRunCall) => AsyncGenerator<HarnessStreamPart>,
  extra?: Pick<KuralleRuntimeLike, 'abortSession'>,
): KuralleRuntimeLike {
  return {
    run(options) {
      return mockTurnHandle(gen(options));
    },
    ...extra,
  };
}

async function drainAssistantText(stream: AsyncIterable<{ delta?: { content?: string } }>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += chunk?.delta?.content ?? '';
  }
  return text;
}

function chatCtx(input: string) {
  return {
    items: [{ type: 'message', role: 'user', content: input }],
  } as never;
}

function collectMetrics(): { sink: VoiceMetricsSink; metrics: VoiceMetric[] } {
  const metrics: VoiceMetric[] = [];
  return {
    metrics,
    sink: (metric) => metrics.push(metric),
  };
}

describe('KuralleRuntimeLLMAdapter session behavior', () => {
  it('forwards explicit session context to runtime.run', async () => {
    const calls: RuntimeRunCall[] = [];

    const runtime = mockRuntime(async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', id: 't', delta: 'hello' };
      yield { type: 'done', sessionId: options.sessionId ?? 'generated' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    adapter.setSessionContext({ sessionId: 'call-100', userId: 'user-100' });

    const stream = adapter.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'need help' }],
      } as never,
    });

    const text = await drainAssistantText(stream);
    expect(text).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('need help');
    expect(calls[0]?.sessionId).toBe('call-100');
    expect(calls[0]?.userId).toBe('user-100');
  });

  it('generates a default livekit-prefixed session id when none is provided', async () => {
    const calls: RuntimeRunCall[] = [];

    const runtime = mockRuntime(async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', id: 't', delta: 'ok' };
      yield { type: 'done', sessionId: options.sessionId ?? 'generated' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'hello' }],
      } as never,
    });

    const text = await drainAssistantText(stream);
    expect(text).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]?.sessionId).toBe('string');
    expect(calls[0]?.sessionId?.startsWith('livekit-')).toBe(true);
  });

  it('keeps session ids isolated across concurrent adapter instances', async () => {
    const calls: RuntimeRunCall[] = [];

    const runtime = mockRuntime(async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', id: 't', delta: `reply:${options.input}` };
      yield { type: 'done', sessionId: options.sessionId ?? 'generated' };
    });

    const adapterA = new KuralleRuntimeLLMAdapter({ runtime });
    adapterA.setSessionContext({ sessionId: 'call-A', userId: 'u-A' });

    const adapterB = new KuralleRuntimeLLMAdapter({ runtime });
    adapterB.setSessionContext({ sessionId: 'call-B', userId: 'u-B' });

    const streamA = adapterA.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'alpha' }],
      } as never,
    });
    const streamB = adapterB.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'beta' }],
      } as never,
    });

    const [textA, textB] = await Promise.all([
      drainAssistantText(streamA),
      drainAssistantText(streamB),
    ]);

    expect(textA).toBe('reply:alpha');
    expect(textB).toBe('reply:beta');
    expect(calls).toHaveLength(2);

    const byInput = new Map(calls.map((call) => [call.input, call]));
    expect(byInput.get('alpha')?.sessionId).toBe('call-A');
    expect(byInput.get('alpha')?.userId).toBe('u-A');
    expect(byInput.get('beta')?.sessionId).toBe('call-B');
    expect(byInput.get('beta')?.userId).toBe('u-B');
  });

  it('propagates abort to runtime.abortSession with current session id', async () => {
    const abortCalls: Array<{ sessionId: string; reason?: string }> = [];
    const calls: RuntimeRunCall[] = [];

    const runtime = mockRuntime(
      async function* (options) {
        calls.push(options);
        while (!options.abortSignal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
      {
        abortSession(sessionId: string, reason?: string) {
          abortCalls.push({ sessionId, reason });
        },
      },
    );

    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    adapter.setSessionContext({ sessionId: 'call-abort' });

    const stream = adapter.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'long-running' }],
      } as never,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toHaveLength(1);
    expect(abortCalls.some((call) => call.sessionId === 'call-abort')).toBe(true);
  });

  it('uses LiveKit instructions message when no user message exists', async () => {
    const calls: RuntimeRunCall[] = [];

    const runtime = mockRuntime(async function* (options) {
      calls.push(options);
      yield { type: 'text-delta', id: 't', delta: 'hello from instructions' };
      yield { type: 'done', sessionId: options.sessionId ?? 'generated' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({
      chatCtx: {
        items: [
          {
            type: 'message',
            id: 'lk.agent_task.instructions',
            role: 'system',
            content: 'Greet the user in a helpful and friendly manner.',
          },
        ],
      } as never,
    });

    const text = await drainAssistantText(stream);
    expect(text).toBe('hello from instructions');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('Greet the user in a helpful and friendly manner.');
  });

  it('drops post-cancel deltas for the canceled turn id and forwards the safe lifecycle', async () => {
    const runtime = mockRuntime(async function* () {
      yield { type: 'text-start', id: 'turn-1' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'pre' };
      yield { type: 'text-cancel', id: 'turn-1', reason: 'policy-block' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'leak' };
      yield { type: 'text-start', id: 'safe-1' };
      yield { type: 'text-delta', id: 'safe-1', delta: 'safe' };
      yield { type: 'text-end', id: 'safe-1' };
      yield { type: 'done', sessionId: 's' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime });
    const stream = adapter.chat({
      chatCtx: {
        items: [{ type: 'message', role: 'user', content: 'blocked' }],
      } as never,
    });

    const text = await drainAssistantText(stream);
    expect(text).toBe('presafe');
    expect(text).not.toContain('leak');
  });
});

describe('KuralleRuntimeLLMAdapter TTFT (REQ-10 / §11 gate)', () => {
  it('records aria_runtime_ttft at the first text-delta, before later deltas and turn-end', async () => {
    let resolveTtftGate!: () => void;
    const ttftGate = new Promise<void>((resolve) => {
      resolveTtftGate = resolve;
    });
    let ttftRecordedBeforeSecondDelta = false;

    const { metrics, sink } = collectMetrics();
    const onMetrics: VoiceMetricsSink = (metric) => {
      sink(metric);
      if (metric.type === 'aria_runtime_ttft') {
        resolveTtftGate();
      }
    };

    const runtime = mockRuntime(async function* () {
      yield { type: 'text-start', id: 'turn-1' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'one' };
      await ttftGate;
      ttftRecordedBeforeSecondDelta = true;
      yield { type: 'text-delta', id: 'turn-1', delta: 'two' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'three' };
      yield { type: 'text-end', id: 'turn-1' };
      yield { type: 'done', sessionId: 's' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime, onMetrics });
    const stream = adapter.chat({ chatCtx: chatCtx('stream') });

    const text = await drainAssistantText(stream);
    expect(text).toBe('onetwothree');
    expect(ttftRecordedBeforeSecondDelta).toBe(true);

    const ttftMetrics = metrics.filter((m) => m.type === 'aria_runtime_ttft');
    const endMetrics = metrics.filter((m) => m.type === 'aria_runtime_end');
    expect(ttftMetrics).toHaveLength(1);
    expect(endMetrics).toHaveLength(1);

    const ttftIndex = metrics.findIndex((m) => m.type === 'aria_runtime_ttft');
    const endIndex = metrics.findIndex((m) => m.type === 'aria_runtime_end');
    expect(ttftIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(ttftIndex);

    const ttftMs = ttftMetrics[0]!.data.ttftMs;
    expect(typeof ttftMs).toBe('number');
    expect(ttftMs).toBeGreaterThanOrEqual(0);
    expect(ttftMs).toBeLessThanOrEqual(endMetrics[0]!.data.durationMs as number);
  });

  it('records TTFT at a single trailing text-delta without waiting for done', async () => {
    const { metrics, sink } = collectMetrics();

    const runtime = mockRuntime(async function* () {
      yield { type: 'text-start', id: 'turn-1' };
      yield { type: 'text-end', id: 'turn-1' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'buffered' };
      yield { type: 'done', sessionId: 's' };
    });

    const adapter = new KuralleRuntimeLLMAdapter({ runtime, onMetrics: sink });
    const stream = adapter.chat({ chatCtx: chatCtx('buffered') });

    const text = await drainAssistantText(stream);
    expect(text).toBe('buffered');

    const ttftMetrics = metrics.filter((m) => m.type === 'aria_runtime_ttft');
    const endMetrics = metrics.filter((m) => m.type === 'aria_runtime_end');
    expect(ttftMetrics).toHaveLength(1);
    expect(endMetrics).toHaveLength(1);

    const ttftIndex = metrics.findIndex((m) => m.type === 'aria_runtime_ttft');
    const endIndex = metrics.findIndex((m) => m.type === 'aria_runtime_end');
    expect(ttftIndex).toBeLessThan(endIndex);
    expect(ttftMetrics[0]!.data.ttftMs).toBeGreaterThanOrEqual(0);
  });
});
