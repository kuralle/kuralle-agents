import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { defineExtractor } from '../src/memory/extract/defineExtractor.js';
import { MemorySessionEventLog } from '../src/events/SessionEventLog.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import type { ChannelDriver } from '../src/types/channel.js';
import { InMemoryExtractedValueStore } from '../src/memory/extract/InMemoryExtractedValueStore.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import {
  mockV3GenerateResult,
  mockV3StreamResult,
} from './helpers/mockLanguageModelV3Results.js';

const colorExtractor = defineExtractor({
  name: 'Favorite Color',
  instructions: 'Extract the user favorite color.',
  schema: z.object({ value: z.string() }),
});

function conversationalDriver(): ChannelDriver {
  return {
    async runAgentTurn() {
      return { text: 'Sure.', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

describe('late extraction event log', () => {
  it('persists extraction after done and delivers it to a pre-attached follower', async () => {
    let resolveExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      resolveExtraction = resolve;
    });

    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        await extractionGate;
        return mockV3GenerateResult(JSON.stringify({ 'favorite-color': { value: 'blue' } }));
      },
      doStream: async () => mockV3StreamResult('Sure.'),
    });

    const eventLog = new MemorySessionEventLog();
    const runtime = createRuntime({
      eventLog,
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: 'each-turn' },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
    });

    const controller = new AbortController();
    const followerParts = [];
    const follower = (async () => {
      for await (const event of eventLog.follow('late-sess', 0, controller.signal)) {
        followerParts.push(event.part);
        if (event.part.type === 'extraction') {
          controller.abort();
          break;
        }
      }
    })();

    const handle = runtime.run({
      sessionId: 'late-sess',
      input: 'my favorite color is blue',
      userId: 'user-1',
      driver: conversationalDriver(),
    });

    let streamExtractionCount = 0;
    for await (const part of handle.events) {
      if (part.type === 'extraction') streamExtractionCount += 1;
      if (part.type === 'done') break;
    }
    expect(streamExtractionCount).toBe(0);

    resolveExtraction();
    await handle;
    await runtime.settled();
    await follower;

    const { events } = await eventLog.read('late-sess', 0);
    const extractionEvents = events.filter((event) => event.part.type === 'extraction');
    expect(extractionEvents.length).toBe(1);
    expect(extractionEvents[0]!.part.payload).toMatchObject({
      slug: 'favorite-color',
      value: { value: 'blue' },
      changed: true,
    });
    expect(followerParts.some((part) => part.type === 'extraction')).toBe(true);
  });
});
