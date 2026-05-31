/**
 * Live grounded reply smoke — in-memory knowledge + liveModel().
 * Run: bun run smoke:knowledge
 */
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import { createInMemoryKnowledgeConfig } from '../../src/runtime/grounding/inMemoryKnowledge.js';
import { liveModel } from '../helpers/liveModel.js';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

describeLive(`core-v2 knowledge live smoke (${lm?.label ?? 'no live key'})`, () => {
  it('answers with the retrieved return-window fact (45 days)', async () => {
    const model = lm!.model;
    const agent = defineAgent({
      id: 'returns',
      name: 'Returns Support',
      instructions:
        'You answer return-policy questions using only the Retrieved Knowledge section. ' +
        'State the return window in days when asked. Be concise.',
      model,
      knowledge: { autoRetrieve: true },
    });

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'returns',
      sessionStore: new MemoryStore(),
      defaultModel: model,
      knowledge: createInMemoryKnowledgeConfig([
        {
          id: 'returns-policy',
          text: "Acme's return window is 45 days from the delivery date.",
          score: 0.99,
        },
      ]),
    });

    const sessionId = newSessionId();
    const handle = runtime.run({
      sessionId,
      input: 'How long do I have to return something?',
    });

    let answer = '';
    for await (const part of handle.events) {
      if (part.type === 'text-delta') {
        answer += part.text;
      }
    }
    await handle;

    expect(answer.toLowerCase()).toMatch(/45/);
  });
});
