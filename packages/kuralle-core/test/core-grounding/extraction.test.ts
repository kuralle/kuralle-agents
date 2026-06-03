import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { getCollectData, projectCollectData, schemaSatisfied } from '../../src/flow/extraction.js';

describe('collect extraction regression', () => {
  it('completes collect via submit tool without regression', async () => {
    const replyNode = reply({
      id: 'confirm',
      instructions: 'Confirm the name.',
      next: () => ({ end: 'done' }),
    });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      onComplete: () => replyNode,
    });
    const flow = defineFlow({
      name: 'name-flow',
      description: 'collect name',
      start: collectNode,
      nodes: [collectNode, replyNode],
    });

    const driver = new TextDriver();
    const { session, runStore, runState } = await setupDurableHarness('collect-reg-sess', 'collect-reg-run');
    runState.messages = [{ role: 'user', content: 'My name is Riley.' }];
    runState.activeFlow = flow.name;
    runState.activeNode = collectNode.id;

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const collectingDriver = {
      async runAgentTurn() {
        return {
          text: 'Thanks.',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Riley' },
              result: { name: 'Riley' },
            },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
    };

    const result = await runFlow(flow, runState, collectingDriver, ctx);
    expect(result.kind).toBe('ended');
    expect(schemaSatisfied(collectNode, runState.state)).toBe(true);
    expect(getCollectData(runState.state, collectNode.id).name).toBe('Riley');
  });

  it('projects optional collected fields to onComplete, not just required ones', () => {
    // A node may require only `intent` but also collect optional fields (e.g. a
    // welcome step that classifies AND captures occasion/recipient). onComplete
    // must receive those optionals — projecting only `required` silently drops
    // them, breaking any routing that reads them.
    const node = collect({
      id: 'welcome',
      schema: z.object({
        intent: z.enum(['gift', 'browse', 'track']),
        occasion: z.string().optional(),
        recipient: z.string().optional(),
      }),
      required: ['intent'],
      onComplete: () => ({ end: 'done' }),
    });
    const state = {
      __collect_welcome: { intent: 'gift', occasion: 'birthday', recipient: 'amma' },
    } as Record<string, unknown>;

    const projected = projectCollectData(node, state) as Record<string, unknown>;
    expect(projected.intent).toBe('gift');
    expect(projected.occasion).toBe('birthday');
    expect(projected.recipient).toBe('amma');
  });
});
