/**
 * Live smoke test — hits a REAL provider (Google/xAI/OpenAI, whichever key is live).
 * Run: bun run smoke:textdriver
 */
import { describe, expect, it } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createEventBus } from '../../src/events/TurnHandle.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { liveModel } from '../helpers/liveModel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { ModelMessage } from 'ai';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

describeLive(`TextDriver live smoke (${lm?.label ?? 'no live key'})`, () => {
  it('streams a non-empty assistant response from a real provider', async () => {
    const model = lm!.model;

    const { session, runStore, runState } = await setupDurableHarness('live-sess', 'live-run');
    const userMessage = 'Reply with exactly one short sentence confirming you are a helpful assistant.';
    const messages: ModelMessage[] = [{ role: 'user', content: userMessage }];
    runState.messages = messages;

    const bus = createEventBus();
    const toolExecutor = new CoreToolExecutor({ tools: {} });
    const parts: HarnessStreamPart[] = [];

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model,
      emit: (p) => {
        parts.push(p);
        bus.emit(p);
      },
    });

    const node = reply({ id: 'reply', instructions: 'You are a helpful assistant. Be concise.', model });

    const driver = new TextDriver();
    const result = await driver.runAgentTurn(resolveReplyNode(node, runState.state), ctx);

    const streamedText = parts
      .filter((p): p is Extract<HarnessStreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('');

    expect(streamedText.length).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toBe(streamedText);

    console.log(`[smoke] ${lm!.label} response:`, result.text);
  }, 60_000);
});
