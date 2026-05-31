import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareGeminiLiveClient,
  encodeBase64Chunked,
  decodeBase64,
  buildSetupFrame,
} from '../dist/cloudflare/gemini-live.js';

// ─── Capabilities / provider / model ──────────────────────────────────────────

describe('CloudflareGeminiLiveClient — capabilities', () => {
  const client = new CloudflareGeminiLiveClient({ apiKey: 'test-key' });

  it('declares provider = "gemini"', () => {
    assert.equal(client.provider, 'gemini');
  });

  it('defaults model to gemini-2.5-flash-native-audio-preview-12-2025', () => {
    assert.equal(client.model, 'gemini-2.5-flash-native-audio-preview-12-2025');
  });

  it('respects model override from options', () => {
    const overridden = new CloudflareGeminiLiveClient({
      apiKey: 'k',
      model: 'gemini-2.5-flash-preview-native-audio-dialog',
    });
    assert.equal(overridden.model, 'gemini-2.5-flash-preview-native-audio-dialog');
  });

  it('declares turnDetection + userTranscription + audioOutput as true', () => {
    assert.equal(client.capabilities.turnDetection, true);
    assert.equal(client.capabilities.userTranscription, true);
    assert.equal(client.capabilities.audioOutput, true);
  });

  it('declares manualFunctionCalls + autoToolReplyGeneration as true', () => {
    assert.equal(client.capabilities.manualFunctionCalls, true);
    assert.equal(client.capabilities.autoToolReplyGeneration, true);
  });

  it('declares all mid-session update flags false', () => {
    assert.equal(client.capabilities.midSessionChatCtxUpdate, false);
    assert.equal(client.capabilities.midSessionInstructionsUpdate, false);
    assert.equal(client.capabilities.midSessionToolsUpdate, false);
    assert.equal(client.capabilities.messageTruncation, false);
  });

  it('throws if apiKey missing', () => {
    assert.throws(() => new CloudflareGeminiLiveClient({ apiKey: '' }), /apiKey is required/);
  });

  it('starts disconnected', () => {
    assert.equal(client.connected, false);
  });
});

// ─── buildSetupFrame snapshot ─────────────────────────────────────────────────

describe('CloudflareGeminiLiveClient — buildSetupFrame', () => {
  it('emits Charon voice and turnCoverage=ONLY_ACTIVITY by default', () => {
    const setup = buildSetupFrame(
      { apiKey: 'k' },
      { systemInstruction: 'you are helpful', tools: [] },
      'gemini-2.5-flash-native-audio-preview-12-2025',
    );
    const s = setup.setup;
    assert.equal(
      s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      'Charon',
    );
    assert.equal(s.realtimeInputConfig.turnCoverage, 'TURN_INCLUDES_ONLY_ACTIVITY');
    assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
  });

  it('enables both input and output transcription by default', () => {
    const { setup } = buildSetupFrame({ apiKey: 'k' }, { systemInstruction: '', tools: [] }, 'm');
    assert.deepEqual(setup.inputAudioTranscription, {});
    assert.deepEqual(setup.outputAudioTranscription, {});
  });

  it('enables contextWindowCompression { slidingWindow: {} } by default', () => {
    const { setup } = buildSetupFrame({ apiKey: 'k' }, { systemInstruction: '', tools: [] }, 'm');
    assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  });

  it('prefixes model with "models/"', () => {
    const { setup } = buildSetupFrame(
      { apiKey: 'k' },
      { systemInstruction: '', tools: [] },
      'gemini-2.5-flash-native-audio-preview-12-2025',
    );
    assert.equal(setup.model, 'models/gemini-2.5-flash-native-audio-preview-12-2025');
  });

  it('attaches sessionResumption handle when provided', () => {
    const { setup } = buildSetupFrame(
      { apiKey: 'k' },
      { systemInstruction: '', tools: [], resumptionHandle: 'abc123' },
      'm',
    );
    assert.deepEqual(setup.sessionResumption, { handle: 'abc123' });
  });

  it('sends { handle: null } when no resumption handle provided (primes fresh session)', () => {
    const { setup } = buildSetupFrame({ apiKey: 'k' }, { systemInstruction: '', tools: [] }, 'm');
    assert.deepEqual(setup.sessionResumption, { handle: null });
  });

  it('wraps tools into [{ functionDeclarations: [...] }] envelope', () => {
    const { setup } = buildSetupFrame(
      { apiKey: 'k' },
      {
        systemInstruction: '',
        tools: [{ name: 'get_weather', description: 'Get weather', parameters: {} }],
      },
      'm',
    );
    assert.ok(Array.isArray(setup.tools));
    assert.equal(setup.tools[0].functionDeclarations[0].name, 'get_weather');
  });

  it('omits tools entirely when empty array given (Gemini rejects empty tools)', () => {
    const { setup } = buildSetupFrame({ apiKey: 'k' }, { systemInstruction: '', tools: [] }, 'm');
    assert.equal(setup.tools, undefined);
  });

  it('honours overridden voice option', () => {
    const { setup } = buildSetupFrame(
      { apiKey: 'k', voice: 'Puck' },
      { systemInstruction: '', tools: [] },
      'm',
    );
    assert.equal(
      setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      'Puck',
    );
  });
});

// ─── Base64 roundtrip ─────────────────────────────────────────────────────────

describe('CloudflareGeminiLiveClient — chunked base64', () => {
  it('encodes then decodes back to original bytes for small payload', () => {
    const original = new Uint8Array([0, 1, 2, 3, 4, 255, 128, 127]);
    const enc = encodeBase64Chunked(original);
    const dec = decodeBase64(enc);
    assert.deepEqual(Array.from(dec), Array.from(original));
  });

  it('matches Buffer.toString("base64") for 1 MiB payload (chunk boundary sanity)', () => {
    const size = 1 << 20; // 1 MiB — exercises multiple 32 KiB chunks
    const u8 = new Uint8Array(size);
    for (let i = 0; i < size; i++) u8[i] = (i * 31 + 7) & 0xff;
    const ours = encodeBase64Chunked(u8);
    const nodeRef = Buffer.from(u8).toString('base64');
    assert.equal(ours, nodeRef);
  });

  it('roundtrips an exactly-at-chunk-boundary buffer (32 KiB)', () => {
    const size = 0x8000;
    const u8 = new Uint8Array(size);
    for (let i = 0; i < size; i++) u8[i] = i & 0xff;
    const enc = encodeBase64Chunked(u8);
    const dec = decodeBase64(enc);
    assert.deepEqual(Array.from(dec), Array.from(u8));
  });

  it('handles empty buffer', () => {
    assert.equal(encodeBase64Chunked(new Uint8Array(0)), '');
    assert.deepEqual(Array.from(decodeBase64('')), []);
  });
});

// ─── Tool response envelope (load-bearing) ───────────────────────────────────

describe('CloudflareGeminiLiveClient — tool response envelope', () => {
  it('wraps raw output as { result: output } (NOT raw output)', () => {
    const sent = [];
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    // Inject a fake WebSocket to intercept `send`.
    const fakeWs = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    // @ts-ignore — accessing private for test intent is the whole point here.
    client.ws = fakeWs;

    client.sendToolResponse([
      { id: 'call_1', name: 'get_weather', output: { temperature: 72, unit: 'F' } },
    ]);

    assert.equal(sent.length, 1);
    const frame = sent[0];
    assert.ok(frame.toolResponse);
    assert.equal(frame.toolResponse.functionResponses[0].id, 'call_1');
    assert.equal(frame.toolResponse.functionResponses[0].name, 'get_weather');
    // ── load-bearing shape check ──
    assert.deepEqual(frame.toolResponse.functionResponses[0].response, {
      result: { temperature: 72, unit: 'F' },
    });
    // And the raw output must NOT appear at `response` directly.
    assert.notDeepEqual(frame.toolResponse.functionResponses[0].response, {
      temperature: 72,
      unit: 'F',
    });
  });

  it('preserves string output shape inside { result }', () => {
    const sent = [];
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const fakeWs = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    // @ts-ignore
    client.ws = fakeWs;

    client.sendToolResponse([{ id: 'x', name: 'echo', output: 'hello' }]);
    assert.deepEqual(sent[0].toolResponse.functionResponses[0].response, { result: 'hello' });
  });
});

// ─── Frame dispatcher ────────────────────────────────────────────────────────

describe('CloudflareGeminiLiveClient — dispatchFrame', () => {
  it('emits "audio" for serverContent.modelTurn inlineData audio parts, downsampling 24k → 16k', () => {
    // dispatchFrame decodes the base64 payload, treats it as Int16 PCM at
    // 24kHz, and 3:2-downsamples to 16kHz before emitting. Feed six Int16
    // samples (12 bytes) so the downsampler can complete two windows and
    // produce four output samples.
    const inputSamples = Int16Array.from([100, 200, 300, 400, 500, 600]);
    const inputBytes = new Uint8Array(
      inputSamples.buffer,
      inputSamples.byteOffset,
      inputSamples.byteLength,
    );

    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const got = [];
    client.on('audio', (data) => got.push(data));
    client.dispatchFrame({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: encodeBase64Chunked(inputBytes),
              },
            },
          ],
        },
      },
    });

    assert.equal(got.length, 1);
    // 3:2 ratio: 6 input samples → 4 output samples → 8 bytes.
    assert.equal(got[0].byteLength, 8);
    const outputSamples = new Int16Array(
      got[0].buffer,
      got[0].byteOffset,
      got[0].byteLength / 2,
    );
    // Window 1: avg(100,200)=150, avg(200,300)=250
    // Window 2: avg(400,500)=450, avg(500,600)=550
    assert.deepEqual(Array.from(outputSamples), [150, 250, 450, 550]);
  });

  it('downsample24kTo16k contract: output sample count is floor(input * 2 / 3)', () => {
    // Independent guard on the ratio rule — protects the 3:2 contract
    // separately from the frame-dispatch plumbing that consumes it.
    const samples = new Int16Array(24); // 24 @ 24kHz → 16 @ 16kHz
    for (let i = 0; i < samples.length; i++) samples[i] = i * 1000;
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const got = [];
    client.on('audio', (data) => got.push(data));
    client.dispatchFrame({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: encodeBase64Chunked(bytes) } }],
        },
      },
    });

    assert.equal(got.length, 1);
    const outSamples = got[0].byteLength / 2;
    assert.equal(outSamples, Math.floor((samples.length * 2) / 3));
  });

  it('emits "transcript" with role=user for inputTranscription', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const got = [];
    client.on('transcript', (text, role) => got.push({ text, role }));
    client.dispatchFrame({ serverContent: { inputTranscription: { text: 'hello' } } });
    assert.deepEqual(got, [{ text: 'hello', role: 'user' }]);
  });

  it('emits "transcript" with role=assistant for outputTranscription', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const got = [];
    client.on('transcript', (text, role) => got.push({ text, role }));
    client.dispatchFrame({ serverContent: { outputTranscription: { text: 'world' } } });
    assert.deepEqual(got, [{ text: 'world', role: 'assistant' }]);
  });

  it('emits "turn-complete" on serverContent.turnComplete', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    let fired = 0;
    client.on('turn-complete', () => fired++);
    client.dispatchFrame({ serverContent: { turnComplete: true } });
    assert.equal(fired, 1);
  });

  it('emits "interrupted" on serverContent.interrupted', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    let fired = 0;
    client.on('interrupted', () => fired++);
    client.dispatchFrame({ serverContent: { interrupted: true } });
    assert.equal(fired, 1);
  });

  it('emits "tool-call" per functionCall', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    const got = [];
    client.on('tool-call', (id, name, args) => got.push({ id, name, args }));
    client.dispatchFrame({
      toolCall: {
        functionCalls: [
          { id: 'c1', name: 'f1', args: { x: 1 } },
          { id: 'c2', name: 'f2', args: { y: 2 } },
        ],
      },
    });
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { id: 'c1', name: 'f1', args: { x: 1 } });
    assert.deepEqual(got[1], { id: 'c2', name: 'f2', args: { y: 2 } });
  });

  it('captures sessionResumptionUpdate.newHandle when resumable=true', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    assert.equal(client.sessionResumptionHandle, null);
    client.dispatchFrame({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-abc' },
    });
    assert.equal(client.sessionResumptionHandle, 'handle-abc');
  });

  it('does NOT capture handle if resumable=false', () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    client.dispatchFrame({
      sessionResumptionUpdate: { resumable: false, newHandle: 'should-not-save' },
    });
    assert.equal(client.sessionResumptionHandle, null);
  });
});

// ─── ArrayBuffer text frame decode (js-genai#715 regression guard) ───────────

describe('CloudflareGeminiLiveClient — ArrayBuffer text frame', () => {
  it('decodes ArrayBuffer-delivered JSON via TextDecoder then JSON.parse', async () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    let fired = 0;
    client.on('turn-complete', () => fired++);

    const payload = JSON.stringify({ serverContent: { turnComplete: true } });
    const bytes = new TextEncoder().encode(payload);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    // @ts-ignore — exercise the private frame handler with an ArrayBuffer, like
    // Workers would deliver in the js-genai#715 regression scenario.
    await client.handleFrame({ data: ab });

    assert.equal(fired, 1);
  });

  it('emits "error" on malformed JSON frame instead of throwing', async () => {
    const client = new CloudflareGeminiLiveClient({ apiKey: 'k' });
    let err = null;
    client.on('error', (e) => (err = e));
    // @ts-ignore
    await client.handleFrame({ data: '{not-json' });
    assert.match(err, /Invalid JSON frame/);
  });
});
