import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import { createInMemoryKnowledgeConfig } from '../../src/runtime/grounding/inMemoryKnowledge.js';
import { mockV3StreamTextModel } from '../helpers/mockLanguageModelV3Results.js';
import type { StreamPart } from '@kuralle-agents/core';
import type { KnowledgeEmbedderAdapter } from '../../src/types/knowledge.js';

const fakeEmbedder: KnowledgeEmbedderAdapter = {
  embed: async (text: string) => [text.length, (text.match(/[aeiou]/gi) ?? []).length, 1],
};

/**
 * Proves the Runtime run-open wiring (G6): `runCtx.retrievalCache =
 * knowledgeProvider.createSessionCache()`. A wired cache makes the retrieve
 * path emit `knowledge-cache-miss` on the first (empty) lookup; an UNWIRED
 * cache (the `const cache = undefined` bug) skips the cache block entirely and
 * emits no cache event. So the presence of the miss event is a discriminating
 * proof that the RunContext carried the cache into the auto-retrieve consumer.
 */
describe('Runtime session retrieval cache wiring (G6, run-open → consumer)', () => {
  it('carries a defined cache into auto-retrieve — first turn emits knowledge-cache-miss', async () => {
    const model = mockV3StreamTextModel('The return window is 45 days.');

    const agent = defineAgent({
      id: 'returns',
      instructions: 'Answer using retrieved knowledge only.',
      model,
      knowledge: { autoRetrieve: true },
    });

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'returns',
      sessionStore: new MemoryStore(),
      defaultModel: model,
      knowledge: createInMemoryKnowledgeConfig(
        [{ id: 'returns', text: "Acme's return window is 45 days.", score: 0.99 }],
        { embedder: fakeEmbedder },
      ),
    });

    const handle = runtime.run({
      sessionId: newSessionId(),
      input: 'How long is the return window?',
    });

    const events: StreamPart[] = [];
    for await (const part of handle.events) {
      events.push(part);
    }
    await handle;

    expect(events.some((e) => e.type === 'knowledge-cache-miss')).toBe(true);
  });
});
