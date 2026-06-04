import { describe, expect, it, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { ValidationCapability } from '../../src/capabilities/ValidationCapability.js';
import {
  FakeRealtimeAudioClient,
  flushMicrotasks,
} from '../helpers/fakeRealtimeClient.js';

async function waitForDriverReady(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  // no mock.module in this suite
});

describe('S2-02 honest post-hoc gate (REQ-9)', () => {
  it('blocking gate emits safety-* + requests correction; gateScope is advisory', async () => {
    const unsafe = 'UNSAFE-ASSISTANT-CONTENT';
    const safeMessage = 'Safe correction only';
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const blockPolicy: ValidationCapability = {
      name: 'req9-block',
      async validate() {
        return {
          decision: 'block',
          confidence: 0,
          rationale: 'policy block',
          userFacingMessage: safeMessage,
        };
      },
    };

    const parts: HarnessStreamPart[] = [];
    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('s2-posthoc-sess', 's2-posthoc-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: [blockPolicy],
      emit: (p) => parts.push(p),
    });

    const node = reply({ id: 'blocked', instructions: 'Answer' });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.emitAssistantChunks([unsafe]);
    await flushMicrotasks();

    const turn = await turnPromise;

    expect(turn.text).toBe(safeMessage);
    expect(turn.gateScope).toBe('advisory');
    expect(parts.some((p) => p.type === 'safety-blocked')).toBe(true);
    expect(fakeClient.correctionRequests).toEqual([safeMessage]);

    const safety = parts.find((p) => p.type === 'safety-blocked');
    expect(safety).toBeDefined();
    if (safety?.type === 'safety-blocked') {
      expect(safety.userFacingMessage).toBe(safeMessage);
      expect(safety.rationale).toBe('policy block');
    }
  });

  it('client without requestResponse does not throw on post-hoc block', async () => {
    const fakeClient = Object.assign(new FakeRealtimeAudioClient({ responses: {} }), {
      requestResponse: undefined,
    }) as FakeRealtimeAudioClient;
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const blockPolicy: ValidationCapability = {
      name: 'no-speak-method',
      async validate() {
        return {
          decision: 'block',
          confidence: 0,
          rationale: 'blocked',
          userFacingMessage: 'safe',
        };
      },
    };

    const parts: HarnessStreamPart[] = [];
    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('s2-nospeak-sess', 's2-nospeak-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      validationPolicies: [blockPolicy],
      emit: (p) => parts.push(p),
    });

    const node = reply({ id: 'blocked', instructions: 'Answer' });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.emitAssistantChunks(['leaked']);
    await flushMicrotasks();

    const turn = await turnPromise;
    expect(turn.gateScope).toBe('advisory');
    expect(parts.some((p) => p.type === 'safety-blocked')).toBe(true);
    expect(fakeClient.correctionRequests).toHaveLength(0);
  });
});
