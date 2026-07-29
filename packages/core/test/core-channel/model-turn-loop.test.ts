import { describe, expect, it } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import type { ModelTurnLoop } from '../../src/runtime/channels/ModelTurnLoop.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import type { StreamPart } from '../../src/types/stream.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

describe('TextDriver model-loop SPI', () => {
  it('keeps Kuralle turn composition around an injected inner loop', async () => {
    const seen: string[] = [];
    const loop: ModelTurnLoop = {
      async run(input, state, emitToken) {
        seen.push(input.system.map((message) => String(message.content)).join('\n'));
        emitToken('from ');
        emitToken('pi');
        state.usage = {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          contextTokens: 3,
        };
      },
    };
    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const result = await new TextDriver({ modelLoop: loop }).runAgentTurn(
      resolveReplyNode(reply({ id: 'answer', instructions: 'Use the injected loop' }), {}),
      ctx,
    );

    expect(seen[0]).toContain('Use the injected loop');
    expect(result.text).toBe('from pi');
    expect(result.usage?.totalTokens).toBe(5);
    expect(parts.filter((part) => part.type === 'text-delta')).toHaveLength(2);
    expect(parts.at(-1)?.type).toBe('turn-end');
  });

  it('propagates control-flow failures without turning them into text', async () => {
    const failure = new Error('synthetic inner-loop failure');
    const loop: ModelTurnLoop = {
      async run() {
        throw failure;
      },
    };
    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    await expect(
      new TextDriver({ modelLoop: loop }).runAgentTurn(
        resolveReplyNode(reply({ id: 'answer', instructions: 'Fail' }), {}),
        ctx,
      ),
    ).rejects.toBe(failure);
    expect(parts.some((part) => part.type === 'text-end')).toBe(false);
  });
});
