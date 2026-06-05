#!/usr/bin/env npx tsx
import { initializeLogger } from '@livekit/agents';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import {
  KuralleRuntimeLLMAdapter,
  type KuralleRuntimeLike,
  type KuralleRuntimeRunOptions,
} from '@kuralle-agents/livekit-plugin';
import type { VoiceMetric, VoiceMetricsSink } from '@kuralle-agents/livekit-plugin';
import { createMockTurnHandle as mockTurnHandle } from '@kuralle-agents/core/testing';

initializeLogger({ pretty: false, level: 'warn' });

type RuntimeRunCall = KuralleRuntimeRunOptions;

function mockRuntime(
  gen: (options: RuntimeRunCall) => AsyncGenerator<HarnessStreamPart>,
): KuralleRuntimeLike {
  return {
    run(options) {
      return mockTurnHandle(gen(options));
    },
  };
}

async function drainAssistantText(
  stream: AsyncIterable<{ delta?: { content?: string } }>,
): Promise<string> {
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

async function main() {
  const timeline: string[] = [];
  let resolveTtftGate!: () => void;
  const ttftGate = new Promise<void>((resolve) => {
    resolveTtftGate = resolve;
  });
  let ttftRecordedBeforeSecondDelta = false;

  const metrics: VoiceMetric[] = [];
  const onMetrics: VoiceMetricsSink = (metric) => {
    metrics.push(metric);
    if (metric.type === 'aria_runtime_ttft') {
      timeline.push(
        `  [${timeline.length + 1}] text-delta "one" → aria_runtime_ttft (ttftMs=${metric.data.ttftMs})`,
      );
      resolveTtftGate();
      return;
    }
    if (metric.type === 'aria_runtime_end') {
      timeline.push(
        `  [${timeline.length + 1}] done → aria_runtime_end (durationMs=${metric.data.durationMs}, chunks=${metric.data.chunks})`,
      );
    }
  };

  const runtime = mockRuntime(async function* () {
    timeline.push(`  [1] text-start (turn-1)`);
    timeline.push(`  [2] text-delta "one"`);
    yield { type: 'text-start', id: 'turn-1' };
    yield { type: 'text-delta', id: 'turn-1', delta: 'one' };
    await ttftGate;
    ttftRecordedBeforeSecondDelta = true;
    timeline.push(`  [${timeline.length + 1}] text-delta "two" (after aria_runtime_ttft)`);
    yield { type: 'text-delta', id: 'turn-1', delta: 'two' };
    timeline.push(`  [${timeline.length + 1}] text-delta "three"`);
    yield { type: 'text-delta', id: 'turn-1', delta: 'three' };
    timeline.push(`  [${timeline.length + 1}] text-end`);
    yield { type: 'text-end', id: 'turn-1' };
    yield { type: 'done', sessionId: 's' };
  });

  const adapter = new KuralleRuntimeLLMAdapter({ runtime, onMetrics });
  const stream = adapter.chat({ chatCtx: chatCtx('stream') });
  const text = await drainAssistantText(stream);

  const ttftMetrics = metrics.filter((m) => m.type === 'aria_runtime_ttft');
  const endMetrics = metrics.filter((m) => m.type === 'aria_runtime_end');
  const ttftIndex = metrics.findIndex((m) => m.type === 'aria_runtime_ttft');
  const endIndex = metrics.findIndex((m) => m.type === 'aria_runtime_end');
  const ttftMs = ttftMetrics[0]?.data.ttftMs as number;
  const durationMs = endMetrics[0]?.data.durationMs as number;

  console.log('S3-02 offline TTFT timeline (S3-01 deterministic harness)');
  console.log('Source: aria_runtime_llm_adapter.test.ts REQ-10 / §11 gate');
  console.log('');
  for (const line of timeline) {
    console.log(line);
  }
  console.log('');
  console.log('Assertions:');
  console.log(`  text="${text}"`);
  console.log(`  ttftRecordedBeforeSecondDelta=${ttftRecordedBeforeSecondDelta}`);
  console.log(`  ttftMetrics.length=${ttftMetrics.length}`);
  console.log(`  ttftIndex (${ttftIndex}) < endIndex (${endIndex}): ${ttftIndex < endIndex}`);
  console.log(`  ttftMs (${ttftMs}) <= durationMs (${durationMs}): ${ttftMs <= durationMs}`);
  console.log('');
  console.log(
    'Framing (§11): Ungated (token/sentence) reply ⇒ TTFT = first-token (improved); ' +
      'turn-mode gated node ⇒ buffers by design (REQ-3), TTFT = whole-turn (no improvement, expected).',
  );

  if (!ttftRecordedBeforeSecondDelta || ttftIndex >= endIndex || ttftMs > durationMs) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
