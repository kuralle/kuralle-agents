import { describe, test, expect } from 'bun:test';
import type { RealtimeSessionConfig } from '@kuralle-agents/core/realtime';
import {
  buildSessionUpdate,
  buildAudioAppend,
  buildToolResponseFrames,
  buildItemCreate,
  buildResponseCancel,
  canonicalizeEventName,
  OPENAI_PROFILE,
  XAI_PROFILE,
  azureProfile,
  OPENAI_FAMILY_CAPABILITIES,
} from '../protocol.js';

describe('canonicalizeEventName — GA/Beta rename table', () => {
  test('Beta names fold into GA canonical', () => {
    expect(canonicalizeEventName('response.text.delta')).toBe('response.output_text.delta');
    expect(canonicalizeEventName('response.audio.delta')).toBe('response.output_audio.delta');
    expect(canonicalizeEventName('response.audio_transcript.delta')).toBe(
      'response.output_audio_transcript.delta',
    );
    expect(canonicalizeEventName('conversation.item.created')).toBe('conversation.item.added');
  });

  test('GA names pass through unchanged', () => {
    expect(canonicalizeEventName('response.output_text.delta')).toBe('response.output_text.delta');
    expect(canonicalizeEventName('session.updated')).toBe('session.updated');
  });

  test('unknown events pass through (forwards-compat)', () => {
    expect(canonicalizeEventName('response.future.new_event')).toBe('response.future.new_event');
  });
});

describe('buildSessionUpdate', () => {
  test('produces GA-shaped session.update frame', () => {
    const frame = buildSessionUpdate({
      model: 'gpt-realtime',
      voice: 'marin',
      turnDetection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true },
      inputAudioRate: 24000,
      outputAudioRate: 24000,
      systemInstruction: 'Be helpful.',
    });
    expect(frame.type).toBe('session.update');
    const session = (frame as { session: Record<string, unknown> }).session;
    expect(session.type).toBe('realtime');
    expect(session.model).toBe('gpt-realtime');
    expect(session.output_modalities).toEqual(['audio']);
    expect(session.instructions).toBe('Be helpful.');
    const audio = session.audio as {
      input: { format: Record<string, unknown>; turn_detection: Record<string, unknown> };
      output: { format: Record<string, unknown>; voice: string };
    };
    expect(audio.input.format).toMatchObject({ type: 'audio/pcm', rate: 24000 });
    expect(audio.output.format).toMatchObject({ type: 'audio/pcm', rate: 24000 });
    expect(audio.output.voice).toBe('marin');
    expect(audio.input.turn_detection).toMatchObject({ type: 'semantic_vad' });
  });

  test('maps tools into function declarations', () => {
    const tools: RealtimeSessionConfig['tools'] = [
      { name: 'getWeather', description: 'Get weather', parameters: { type: 'object' } },
    ];
    const frame = buildSessionUpdate({
      model: 'gpt-realtime',
      voice: 'marin',
      turnDetection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200, create_response: true, interrupt_response: true },
      inputAudioRate: 24000,
      outputAudioRate: 24000,
      tools,
    });
    const mappedTools = ((frame as { session: { tools?: unknown[] } }).session.tools ?? []) as Array<
      Record<string, unknown>
    >;
    expect(mappedTools).toHaveLength(1);
    expect(mappedTools[0]).toMatchObject({
      type: 'function',
      name: 'getWeather',
      description: 'Get weather',
    });
  });

  test('omits instructions when not provided', () => {
    const frame = buildSessionUpdate({
      model: 'gpt-realtime',
      voice: 'marin',
      turnDetection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true },
      inputAudioRate: 24000,
      outputAudioRate: 24000,
    });
    const session = (frame as { session: Record<string, unknown> }).session;
    expect(session.instructions).toBeUndefined();
  });
});

describe('buildAudioAppend', () => {
  test('wraps base64 into input_audio_buffer.append', () => {
    const f = buildAudioAppend('AAAA');
    expect(f).toEqual({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  });
});

describe('buildToolResponseFrames', () => {
  test('emits function_call_output items then a single response.create', () => {
    const frames = buildToolResponseFrames([
      { id: 'call-1', name: 'foo', output: { a: 1 } },
      { id: 'call-2', name: 'bar', output: 'ok' },
    ]);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call-1' },
    });
    expect(frames[1]).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call-2' },
    });
    expect(frames[2]).toEqual({ type: 'response.create' });
  });

  test('output is JSON-stringified', () => {
    const [f] = buildToolResponseFrames([{ id: 'c', name: 'n', output: { k: 'v' } }]);
    const item = (f as { item: { output: string } }).item;
    expect(typeof item.output).toBe('string');
    expect(JSON.parse(item.output)).toEqual({ k: 'v' });
  });
});

describe('buildItemCreate', () => {
  test('threads previous_item_id when present', () => {
    const f = buildItemCreate({ type: 'message', role: 'user', content: [] }, 'prev-id');
    expect(f).toMatchObject({ type: 'conversation.item.create', previous_item_id: 'prev-id' });
  });

  test('omits previous_item_id when null (first item)', () => {
    const f = buildItemCreate({ type: 'message', role: 'user', content: [] }, null);
    expect((f as Record<string, unknown>).previous_item_id).toBeUndefined();
  });
});

describe('ProviderProfiles', () => {
  test('OpenAI URL and subprotocols', () => {
    expect(OPENAI_PROFILE.buildUrl('gpt-realtime')).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    );
    const sp = OPENAI_PROFILE.buildSubprotocols('sk-test123');
    expect(sp).toHaveLength(3);
    expect(sp[0]).toBe('realtime');
    expect(sp[1]).toBe('openai-insecure-api-key.sk-test123');
    expect(sp[2]).toMatch(/^kuralle-realtime-audio\./);
  });

  test('xAI URL, default model, voice, VAD', () => {
    expect(XAI_PROFILE.modelDefault).toBe('grok-4-1-fast-non-reasoning');
    expect(XAI_PROFILE.voiceDefault).toBe('ara');
    expect(XAI_PROFILE.turnDetectionDefault.type).toBe('server_vad');
    expect(XAI_PROFILE.buildUrl('grok-test')).toBe('wss://api.x.ai/v1/realtime?model=grok-test');
  });

  test('Azure URL construction', () => {
    const p = azureProfile({
      endpoint: 'https://my.openai.azure.com',
      apiVersion: '2025-04-01-preview',
      deployment: 'gpt-rt',
    });
    expect(p.modelDefault).toBe('gpt-rt');
    const url = p.buildUrl('gpt-rt');
    expect(url).toContain('wss://my.openai.azure.com/openai/realtime');
    expect(url).toContain('api-version=2025-04-01-preview');
    expect(url).toContain('deployment=gpt-rt');
  });

  test('Azure strips trailing slash from endpoint', () => {
    const p = azureProfile({
      endpoint: 'https://my.openai.azure.com/',
      apiVersion: '2025-04-01-preview',
      deployment: 'd',
    });
    expect(p.buildUrl('d')).not.toContain('.azure.com//');
  });
});

describe('OPENAI_FAMILY_CAPABILITIES', () => {
  test('declares reconnectStrategy: replay', () => {
    expect(OPENAI_FAMILY_CAPABILITIES.reconnectStrategy).toBe('replay');
  });

  test('declares mid-session update support (the upside over Gemini)', () => {
    expect(OPENAI_FAMILY_CAPABILITIES.midSessionChatCtxUpdate).toBe(true);
    expect(OPENAI_FAMILY_CAPABILITIES.midSessionInstructionsUpdate).toBe(true);
    expect(OPENAI_FAMILY_CAPABILITIES.midSessionToolsUpdate).toBe(true);
  });
});

describe('buildResponseCancel', () => {
  test('emits response.cancel frame', () => {
    expect(buildResponseCancel()).toEqual({ type: 'response.cancel' });
  });
});
