import { describe, expect, it } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  FakeRealtimeAudioClient,
  flushMicrotasks,
} from '../helpers/fakeRealtimeClient.js';

async function waitForDriverReady(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe('voice barge-in (REQ-9)', () => {
  it('truncates assistant transcript to heard prefix and keeps active node', async () => {
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('barge-sess', 'barge-run');

    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const stayNode = reply({ id: 'speak', instructions: 'Say greeting', next: () => 'stay' });
    const heardPrefix = 'Hello there, welcome';
    const bargeUtterance = 'Stop, I need billing help';

    const turnPromise = driver.runAgentTurn(
      { node: stayNode, prompt: 'Say greeting', tools: {} },
      ctx,
    );

    await waitForDriverReady();
    fakeClient.injectBargeIn(bargeUtterance, heardPrefix);
    await flushMicrotasks();

    const turn = await turnPromise;
    expect(turn.interrupted).toBe(true);
    expect(turn.truncateAt).toBe(heardPrefix.length);
    expect(turn.text).toBe(heardPrefix);

    runState.messages.push({ role: 'assistant', content: turn.text });
    const signal = await driver.awaitUser(ctx);
    expect(signal.input).toBe(bargeUtterance);

    runState.activeNode = 'speak';
    runState.messages.push({ role: 'user', content: signal.input });
    expect(runState.activeNode).toBe('speak');
  });
});
