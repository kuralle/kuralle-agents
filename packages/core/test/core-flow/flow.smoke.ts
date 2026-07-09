/**
 * Live flow smoke — collect→reply against a real provider (liveModel()).
 * Run: bun run smoke:flow
 */
import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { liveModel } from '../helpers/liveModel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

describeLive(`core-v2 flow live smoke (${lm?.label ?? 'no live key'})`, () => {
  it('collects schema across turns then replies', async () => {
    const model = lm!.model;
    const replyNode = reply({
      id: 'confirm',
      instructions:
        'Confirm the collected name in one short friendly sentence. Do not ask more questions.',
      model,
      next: () => ({ end: 'completed' }),
    });

    const collectNode = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      maxTurns: 4,
      instructions: (missing) =>
        `Collect the user's name. Missing: ${missing.join(', ') || 'none'}. ` +
        `Ask briefly for one missing field. When the user gives their name, call submit_name_data with { name: "<their name>" }.`,
      onComplete: () => replyNode,
    });

    const flow = defineFlow({
      name: 'name-intake',
      description: 'Collect a name then confirm',
      start: collectNode,
      nodes: [collectNode, replyNode],
    });

    const driver = new TextDriver();
    const toolExecutor = new CoreToolExecutor({ tools: {} });
    const { session, runStore, runState } = await setupDurableHarness('flow-live-sess', 'flow-live-run');

    const transcript: string[] = [];
    const parts: HarnessStreamPart[] = [];

    const seedUser = (text: string) => {
      setPendingUserInput(session, text);
      runState.messages = [...runState.messages, { role: 'user', content: text } satisfies ModelMessage];
      transcript.push(`user: ${text}`);
    };

    seedUser('My name is Jordan.');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model,
      emit: (part) => {
        parts.push(part);
        if (part.type === 'text-delta') {
          const last = transcript[transcript.length - 1];
          if (last?.startsWith('assistant: ')) {
            transcript[transcript.length - 1] = `assistant: ${last.slice('assistant: '.length)}${part.delta}`;
          } else {
            transcript.push(`assistant: ${part.delta}`);
          }
        }
      },
    });

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result.kind).toBe('ended');
    expect(parts.some((part) => part.type === 'flow-enter' && part.flow === 'name-intake')).toBe(true);
    expect(parts.some((part) => part.type === 'node-enter' && part.nodeName === 'name')).toBe(true);
    expect(parts.some((part) => part.type === 'flow-transition' && part.from === 'name' && part.to === 'confirm')).toBe(
      true,
    );

    const assistantText = parts
      .filter((part): part is Extract<HarnessStreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.delta)
      .join('');

    expect(assistantText.length).toBeGreaterThan(0);
    console.log('[smoke:flow] transcript:', transcript.join('\n'));
    console.log('[smoke:flow] assistant:', assistantText);
  }, 120_000);
});
