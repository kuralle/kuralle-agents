import { describe, expect, it } from 'bun:test';
import type { TranscriptionModel } from 'ai';
import {
  userInputToText,
  hasMediaParts,
  transcribeAudioParts,
  type UserInputContent,
} from '../../src/runtime/userInput.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fakeTranscriber(text: string): TranscriptionModel {
  return {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake-stt',
    async doGenerate() {
      return {
        text,
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'fake-stt' },
      };
    },
  };
}

const cannedDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: 'ack', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: '' };
  },
};

describe('multimodal user input', () => {
  describe('userInputToText', () => {
    it('passes a plain string through', () => {
      expect(userInputToText('hello')).toBe('hello');
    });

    it('extracts text parts and drops file parts', () => {
      const input: UserInputContent = [
        { type: 'text', text: 'whats in this photo' },
        { type: 'file', mediaType: 'image/png', data: PNG_DATA_URL },
      ];
      expect(userInputToText(input)).toBe('whats in this photo');
    });

    it('returns empty string for media-only input', () => {
      const input: UserInputContent = [{ type: 'file', mediaType: 'image/png', data: PNG_DATA_URL }];
      expect(userInputToText(input)).toBe('');
    });
  });

  describe('hasMediaParts', () => {
    it('is false for plain text', () => {
      expect(hasMediaParts('hi')).toBe(false);
      expect(hasMediaParts([{ type: 'text', text: 'hi' }])).toBe(false);
    });
    it('is true when a file part is present', () => {
      expect(
        hasMediaParts([
          { type: 'text', text: 'hi' },
          { type: 'file', mediaType: 'image/png', data: PNG_DATA_URL },
        ]),
      ).toBe(true);
    });
  });

  describe('transcribeAudioParts', () => {
    it('replaces an audio part with its transcript when a model is configured', async () => {
      const input: UserInputContent = [
        { type: 'file', mediaType: 'audio/ogg', data: 'data:audio/ogg;base64,AAAA' },
      ];
      const out = await transcribeAudioParts(input, fakeTranscriber('order two cakes'));
      expect(out).toEqual([{ type: 'text', text: 'order two cakes' }]);
    });

    it('passes audio through untouched when no model is configured', async () => {
      const input: UserInputContent = [
        { type: 'file', mediaType: 'audio/ogg', data: 'data:audio/ogg;base64,AAAA' },
      ];
      expect(await transcribeAudioParts(input, undefined)).toBe(input);
    });

    it('leaves non-audio parts untouched', async () => {
      const input: UserInputContent = [
        { type: 'text', text: 'look' },
        { type: 'file', mediaType: 'image/png', data: PNG_DATA_URL },
      ];
      const out = await transcribeAudioParts(input, fakeTranscriber('ignored'));
      expect(out).toEqual(input);
    });
  });

  describe('runtime.run with multimodal input', () => {
    it('persists the multimodal user message verbatim in session history', async () => {
      const sessionStore = new MemoryStore();
      const runtime = createRuntime({
        agents: [defineAgent({ id: 'a', instructions: 'be helpful', model: stubModel })],
        defaultAgentId: 'a',
        sessionStore,
        defaultModel: stubModel,
      });

      const input: UserInputContent = [
        { type: 'text', text: 'describe this' },
        { type: 'file', mediaType: 'image/png', data: PNG_DATA_URL },
      ];
      const handle = runtime.run({ sessionId: 's1', input, driver: cannedDriver });
      await handle;

      const session = await sessionStore.get('s1');
      const userMsg = session?.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toEqual(input);
    });

    it('transcribes inbound audio to text before the turn when transcriptionModel is set', async () => {
      const sessionStore = new MemoryStore();
      const runtime = createRuntime({
        agents: [defineAgent({ id: 'a', instructions: 'be helpful', model: stubModel })],
        defaultAgentId: 'a',
        sessionStore,
        defaultModel: stubModel,
        transcriptionModel: fakeTranscriber('two chocolate cakes please'),
      });

      const input: UserInputContent = [
        { type: 'file', mediaType: 'audio/ogg', data: 'data:audio/ogg;base64,AAAA' },
      ];
      const handle = runtime.run({ sessionId: 's2', input, driver: cannedDriver });
      await handle;

      const session = await sessionStore.get('s2');
      const userMsg = session?.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toEqual([{ type: 'text', text: 'two chocolate cakes please' }]);
    });
  });
});
