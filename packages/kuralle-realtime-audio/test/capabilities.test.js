import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiLiveSession } from '../dist/node/GeminiLiveSession.js';
import { OpenAIRealtimeClient } from '../dist/openai/OpenAIRealtimeClient.js';

// Construction is pure: no network, no I/O. apiKey is opaque to the client ctor.
const geminiStub = new GeminiLiveSession({
  gemini: { apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview' },
  agent: { id: 'test-agent', instructions: 'test', tools: {} },
  onEvent: () => {},
});

const openaiStub = new OpenAIRealtimeClient({
  apiKey: 'test-key',
  model: 'gpt-realtime',
});

describe('RealtimeCapabilities — GeminiLiveSession', () => {
  it('declares turnDetection = true', () => {
    assert.equal(geminiStub.capabilities.turnDetection, true);
  });

  it('declares autoToolReplyGeneration = true', () => {
    assert.equal(geminiStub.capabilities.autoToolReplyGeneration, true);
  });

  it('declares mid-session tools update as unsupported', () => {
    assert.equal(geminiStub.capabilities.midSessionToolsUpdate, false);
  });
});

describe('RealtimeCapabilities — OpenAIRealtimeClient', () => {
  it('declares turnDetection = true', () => {
    assert.equal(openaiStub.capabilities.turnDetection, true);
  });

  it('declares autoToolReplyGeneration = false', () => {
    assert.equal(openaiStub.capabilities.autoToolReplyGeneration, false);
  });

  it('declares mid-session tools update = true', () => {
    assert.equal(openaiStub.capabilities.midSessionToolsUpdate, true);
  });
});

describe('provider + model accessors', () => {
  it('GeminiLiveSession returns a stable provider string', () => {
    assert.equal(geminiStub.provider, 'gemini');
  });

  it('OpenAIRealtimeClient returns a stable provider string', () => {
    assert.equal(openaiStub.provider, 'openai');
  });

  it('GeminiLiveSession surfaces configured model', () => {
    assert.equal(geminiStub.model, 'gemini-3.1-flash-live-preview');
  });

  it('OpenAIRealtimeClient surfaces configured model', () => {
    assert.equal(openaiStub.model, 'gpt-realtime');
  });
});
