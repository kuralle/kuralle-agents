import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineExtractor,
  InMemoryExtractedValueStore,
  MemoryStore,
  type ExtractedValue,
  type ExtractedValueStore,
  type MemoryBlockScope,
  type SessionEventLog,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import { MockLanguageModelV3 } from 'ai/test';
import {
  mockV3GenerateResult,
  mockV3StreamResult,
} from '../../../core/test/helpers/mockLanguageModelV3Results.js';
import type { BuildRuntime } from '../../src/agentRuntime.js';

/**
 * A store whose write is slow on purpose.
 *
 * Extraction is background work by default, so a fast in-memory save can land before `runSend`
 * returns whether or not anything awaited it — a test built on one passes with the await removed
 * and proves nothing. The delay makes the race deterministic: without `runtime.settled()` the
 * save is still pending when runSend resolves.
 */
class SlowExtractedValueStore implements ExtractedValueStore {
  private readonly inner = new InMemoryExtractedValueStore();

  async save(value: ExtractedValue, owner: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this.inner.save(value, owner);
  }

  load(scope: MemoryBlockScope, owner: string, slug: string): Promise<ExtractedValue | null> {
    return this.inner.load(scope, owner, slug);
  }

  delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    return this.inner.delete(scope, owner, slug);
  }
}

export const extractedValueStore = new SlowExtractedValueStore();

export const drinkExtractor = defineExtractor({
  name: 'Drink',
  scope: 'user',
  instructions: 'Drinks this person named.',
  schema: z.object({ drinks: z.array(z.string()) }),
});

export const agent = defineAgent({
  id: 'extraction-agent',
  instructions: 'Take the order.',
  // doStream serves the conversational turn; doGenerate serves the extraction call, whose result
  // is keyed by extractor slug. Same split as core's late-extraction test.
  model: new MockLanguageModelV3({
    doGenerate: async () => mockV3GenerateResult(JSON.stringify({ drink: { drinks: ['tea'] } })),
    doStream: async () => mockV3StreamResult('One pot of tea.'),
  }),
  memory: {
    extract: [drinkExtractor],
    extraction: { trigger: 'each-turn' },
  },
});

export const buildRuntime: BuildRuntime = (
  sessionId = 'extraction',
  store?: SessionStore,
  traceStore?: TraceStore,
  eventLog?: SessionEventLog,
) => {
  const sessionStore = store ?? new MemoryStore();
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore,
    defaultModel: agent.model,
    extractedValueStore,
    ...(traceStore ? { tracing: { store: traceStore } } : {}),
    eventLog,
  });
  return {
    runtime,
    store: sessionStore,
    sessionId,
    agentId: agent.id,
    label: 'extraction fixture',
    readState: async () => undefined,
  };
};
