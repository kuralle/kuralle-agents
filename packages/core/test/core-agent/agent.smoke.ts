/**
 * Live multi-turn multi-flow smoke — createRuntime + defineAgent with two flows.
 * Run: bun run smoke:agent
 */
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import { liveModel } from '../helpers/liveModel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

describeLive(`core-v2 agent live smoke (${lm?.label ?? 'no live key'})`, () => {
  it('runs 3+ turns: name flow then booking flow with flow-enter/flow-end events', async () => {
    const model = lm!.model;

    const nameDone = reply({
      id: 'name-done',
      instructions:
        'The user is updating their account name. Acknowledge the new name in one short sentence, then finish.',
      model,
      next: () => ({ end: 'name-complete' }),
    });

    const nameFlow = defineFlow({
      name: 'name-intake',
      description: 'Update or change the user account name on their profile',
      start: nameDone,
      nodes: [nameDone],
    });

    const bookingDone = reply({
      id: 'booking-done',
      instructions:
        'The user wants to book a product demo. Confirm the demo request in one short sentence, then finish.',
      model,
      next: () => ({ end: 'booking-complete' }),
    });

    const bookingFlow = defineFlow({
      name: 'book-demo',
      description: 'Book or schedule a product demo appointment',
      start: bookingDone,
      nodes: [bookingDone],
    });

    const support = defineAgent({
      id: 'support',
      name: 'Support',
      instructions: 'You are a helpful support agent.',
      model,
      flows: [nameFlow, bookingFlow],
      routes: [
        { flow: 'name-intake', when: 'update or change their name, profile name, or account name' },
        { flow: 'book-demo', when: 'book, schedule, or request a product demo or appointment' },
      ],
      routing: { model },
    });

    const sessionStore = new MemoryStore();
    const sessionId = newSessionId();
    const runtime = createRuntime({
      agents: [support],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: model,
    });

    const parts: HarnessStreamPart[] = [];
    const transcript: string[] = [];

    async function runTurn(userText: string) {
      transcript.push(`user: ${userText}`);
      const handle = runtime.run({ sessionId, input: userText });
      for await (const part of handle.events) {
        parts.push(part);
        if (part.type === 'text-delta') {
          const line = transcript[transcript.length - 1];
          if (line?.startsWith('assistant: ')) {
            transcript[transcript.length - 1] = `${line}${part.delta}`;
          } else {
            transcript.push(`assistant: ${part.delta}`);
          }
        }
      }
      const result = await handle;
      expect(result.text.length).toBeGreaterThan(0);
      return result;
    }

    await runTurn('I need to update my name on my account.');
    await runTurn('My new name is Alex Rivera.');
    await runTurn('I would like to book a product demo for next week.');

    const flowEnters = parts.filter((p) => p.type === 'flow-enter').map((p) => p.flow);
    const flowEnds = parts.filter((p) => p.type === 'flow-end').map((p) => p.flow);

    console.log('[smoke:agent] provider:', lm!.label);
    console.log('[smoke:agent] transcript:\n', transcript.join('\n'));
    console.log('[smoke:agent] flow-enter:', flowEnters);
    console.log('[smoke:agent] flow-end:', flowEnds);

    expect(flowEnters).toContain('name-intake');
    expect(flowEnters).toContain('book-demo');
    expect(flowEnds).toContain('name-intake');
  }, 180_000);
});
