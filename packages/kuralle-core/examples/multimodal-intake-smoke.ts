#!/usr/bin/env bun
/**
 * Multimodal intake smoke — offline mock model + mock transcriber, no API key.
 * Run:    bun run packages/kuralle-core/examples/multimodal-intake-smoke.ts
 * Assert: prints "OK: image part reached model" and "OK: voice note transcribed".
 *
 * Proves the end-to-end multimodal path: a user turn carrying AI SDK file parts
 * (image + audio) threads through `runtime.run({ input })` into the model prompt,
 * and audio is transcribed to text first when a transcriptionModel is configured.
 */

import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { ModelMessage, TranscriptionModel } from 'ai';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import { newSessionId } from '../src/runtime/openRun.js';
import type { UserInputContent } from '../src/runtime/userInput.js';

const STREAM_ID = 'mock-stream';
const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// 1x1 transparent PNG as a data URL — what a web client would upload.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let capturedPrompt: ModelMessage[] = [];

const model = new MockLanguageModelV3({
  doStream: async (options) => {
    capturedPrompt = options.prompt as ModelMessage[];
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] as const },
          { type: 'text-start' as const, id: STREAM_ID },
          { type: 'text-delta' as const, id: STREAM_ID, delta: 'got it' },
          { type: 'text-end' as const, id: STREAM_ID },
          {
            type: 'finish' as const,
            usage: DEFAULT_USAGE,
            finishReason: { unified: 'stop' as const, raw: undefined },
          },
        ],
      }),
    } as never;
  },
});

const transcriber: TranscriptionModel = {
  specificationVersion: 'v3',
  provider: 'mock',
  modelId: 'mock-stt',
  async doGenerate() {
    return {
      text: 'two chocolate cakes to Colombo',
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      warnings: [],
      response: { timestamp: new Date(0), modelId: 'mock-stt' },
    };
  },
};

const agent = defineAgent({
  id: 'multimodal-smoke',
  name: 'Multimodal Smoke',
  instructions: 'Acknowledge what the user sent.',
  model,
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore: new MemoryStore(),
  defaultModel: model,
  transcriptionModel: transcriber,
});

function lastUserContent(): UserInputContent {
  for (let i = capturedPrompt.length - 1; i >= 0; i -= 1) {
    if (capturedPrompt[i]?.role === 'user') return capturedPrompt[i]!.content as UserInputContent;
  }
  return '';
}

// --- Case 1: text + image in one turn (the ai-chatbot shape) ---
const imageTurn: UserInputContent = [
  { type: 'text', text: 'whats in this photo?' },
  { type: 'file', mediaType: 'image/png', data: PNG_DATA_URL },
];
await runtime.run({ sessionId: newSessionId(), input: imageTurn });
const c1 = lastUserContent();
const sawImage =
  Array.isArray(c1) && c1.some((p) => p.type === 'file' && p.mediaType?.startsWith('image/'));
if (!sawImage) throw new Error(`image part did not reach model: ${JSON.stringify(c1)}`);
console.log('OK: image part reached model');

// --- Case 2: a voice note, transcribed before the turn (text-only model path) ---
const voiceTurn: UserInputContent = [
  { type: 'file', mediaType: 'audio/ogg', data: 'data:audio/ogg;base64,AAAA' },
];
await runtime.run({ sessionId: newSessionId(), input: voiceTurn });
const c2 = lastUserContent();
const transcribed =
  Array.isArray(c2) && c2.every((p) => p.type === 'text') &&
  JSON.stringify(c2).includes('chocolate cakes');
if (!transcribed) throw new Error(`voice note was not transcribed: ${JSON.stringify(c2)}`);
console.log('OK: voice note transcribed');
