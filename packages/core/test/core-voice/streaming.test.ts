import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import {
  FakeRealtimeAudioClient,
  flushMicrotasks,
} from '../helpers/fakeRealtimeClient.js';

const TEXT_LIFECYCLE = new Set(['text-start', 'text-delta', 'text-end', 'text-cancel']);

async function waitForDriverReady(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  mock.restore();
});

describe('S2-01 VoiceDriver transcript streaming', () => {
  it('REQ-8: multi-chunk assistant turn yields >1 text-delta before turn-end', async () => {
    const chunks = ['Hello', ' there', ', welcome', '!'];
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const parts: HarnessStreamPart[] = [];
    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('s2-stream-sess', 's2-stream-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (p) => parts.push(p),
    });

    const node = { node: { kind: 'reply' as const, id: 'r', instructions: 'Greet' }, prompt: 'Greet', tools: {} };
    const turnPromise = driver.runAgentTurn(node, ctx);
    await waitForDriverReady();
    fakeClient.emitAssistantChunks(chunks);
    await flushMicrotasks();

    const turn = await turnPromise;
    expect(turn.text).toBe(chunks.join(''));

    const deltas = parts.filter((p) => p.type === 'text-delta');
    expect(deltas.length).toBeGreaterThan(1);
    const firstDeltaIdx = parts.findIndex((p) => p.type === 'text-delta');
    const turnEndIdx = parts.findIndex((p) => p.type === 'turn-end');
    expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(turnEndIdx).toBeGreaterThan(firstDeltaIdx);
    expect(parts.some((p) => p.type === 'text-start')).toBe(true);
    expect(parts.some((p) => p.type === 'text-end')).toBe(true);
  });

  it('terminates when turn completes with no assistant transcript', async () => {
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('s2-empty-sess', 's2-empty-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const node = { node: { kind: 'reply' as const, id: 'r', instructions: 'Silent' }, prompt: 'Silent', tools: {} };
    const turnPromise = driver.runAgentTurn(node, ctx);
    await waitForDriverReady();
    fakeClient.emitTurnCompleteOnly();
    await flushMicrotasks();

    const turn = await turnPromise;
    expect(turn.text).toBe('');
  });

  it('REQ-12: runExtraction emits zero text lifecycle events', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'would speak' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    await fakeClient.connect({ systemInstruction: '', tools: [] });
    const driver = new VoiceDriver({ client: fakeClient });
    const parts: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('s2-extract-sess', 's2-extract-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (p) => parts.push(p),
    });

    const node = reply({ id: 'extract', instructions: 'Extract only' });
    await driver.runExtraction(resolveReplyNode(node, {}), ctx);

    expect(parts.filter((p) => TEXT_LIFECYCLE.has(p.type))).toHaveLength(0);
  });
});
