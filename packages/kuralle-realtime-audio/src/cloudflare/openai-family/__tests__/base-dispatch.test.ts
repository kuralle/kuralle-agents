/**
 * Frame dispatch + chat_ctx mirror integration tests for the shared base.
 *
 * Exercises `dispatchFrame` directly without a live WS. Verifies event
 * canonicalization (GA/Beta dual names), transcript→mirror wiring, and
 * tool-call extraction from `response.output_item.done`.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { OpenAIFamilyRealtimeClient } from '../base.js';
import { OPENAI_PROFILE, XAI_PROFILE } from '../protocol.js';

function makeClient(): OpenAIFamilyRealtimeClient {
  return new OpenAIFamilyRealtimeClient(OPENAI_PROFILE, { apiKey: 'sk-test' });
}

describe('base — event dispatch', () => {
  let client: OpenAIFamilyRealtimeClient;
  beforeEach(() => {
    client = makeClient();
  });

  test('Beta response.audio.delta folds to GA emits audio', () => {
    const received: Uint8Array[] = [];
    client.on('audio', (data) => {
      received.push(data);
    });
    // "AAAA" base64 decodes to [0x00, 0x00, 0x00]
    client.dispatchFrame({ type: 'response.audio.delta', delta: 'AAAA' });
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([0, 0, 0]);
  });

  test('GA response.output_audio.delta emits audio', () => {
    const received: Uint8Array[] = [];
    client.on('audio', (data) => {
      received.push(data);
    });
    client.dispatchFrame({ type: 'response.output_audio.delta', delta: 'AAAA' });
    expect(received).toHaveLength(1);
  });

  test('user transcription completed emits transcript + updates mirror', () => {
    const transcripts: Array<{ text: string; role: string }> = [];
    client.on('transcript', (text, role) => {
      transcripts.push({ text, role });
    });
    client.dispatchFrame({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello world',
      item_id: 'item-1',
    });
    expect(transcripts).toEqual([{ text: 'hello world', role: 'user' }]);
    const snap = client.snapshotChatCtx();
    expect(snap).toHaveLength(1);
    expect(snap[0].itemId).toBe('item-1');
    expect(snap[0].content).toEqual([{ type: 'input_text', text: 'hello world' }]);
  });

  test('assistant transcript.done updates mirror without emitting transcript event', () => {
    // The delta stream has already emitted incremental transcript events; the
    // .done frame is authoritative for the mirror only.
    client.dispatchFrame({
      type: 'response.output_audio_transcript.done',
      transcript: 'final reply',
      item_id: 'item-a',
    });
    const snap = client.snapshotChatCtx();
    expect(snap[0].itemId).toBe('item-a');
    expect(snap[0].content).toEqual([{ type: 'output_text', text: 'final reply' }]);
  });

  test('conversation.item.added tracks item + audio-capable set', () => {
    client.dispatchFrame({
      type: 'conversation.item.added',
      item: { id: 'x1', type: 'message', role: 'assistant', content: [] },
    });
    expect(client.snapshotChatCtx()).toHaveLength(1);
  });

  test('Beta conversation.item.created canonicalizes to added', () => {
    client.dispatchFrame({
      type: 'conversation.item.created',
      item: { id: 'x2', type: 'message', role: 'user', content: [] },
    });
    expect(client.snapshotChatCtx()).toHaveLength(1);
  });

  test('response.output_item.done with function_call emits tool-call', () => {
    const calls: Array<{ id: string; name: string; args: unknown }> = [];
    client.on('tool-call', (id, name, args) => {
      calls.push({ id, name, args });
    });
    client.dispatchFrame({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call-xyz',
        name: 'getWeather',
        arguments: '{"city":"Tokyo"}',
      },
    });
    expect(calls).toEqual([{ id: 'call-xyz', name: 'getWeather', args: { city: 'Tokyo' } }]);
  });

  test('malformed function_call arguments defaults to empty object', () => {
    const calls: Array<{ args: unknown }> = [];
    client.on('tool-call', (_id, _name, args) => {
      calls.push({ args });
    });
    client.dispatchFrame({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'c', name: 'n', arguments: 'not json{' },
    });
    expect(calls[0].args).toEqual({});
  });

  test('response.done emits turn-complete', () => {
    let turns = 0;
    client.on('turn-complete', () => {
      turns += 1;
    });
    client.dispatchFrame({ type: 'response.done', response: {} });
    expect(turns).toBe(1);
  });

  test('input_audio_buffer.speech_started emits interrupted', () => {
    let interrupts = 0;
    client.on('interrupted', () => {
      interrupts += 1;
    });
    client.dispatchFrame({ type: 'input_audio_buffer.speech_started' });
    expect(interrupts).toBe(1);
  });

  test('error frame emits error with message', () => {
    const errors: string[] = [];
    client.on('error', (msg) => {
      errors.push(msg);
    });
    client.dispatchFrame({ type: 'error', error: { code: 'invalid_request_error', message: 'bad key' } });
    expect(errors).toEqual(['bad key']);
  });

  test('unknown event type is ignored (forwards-compat)', () => {
    const errors: string[] = [];
    client.on('error', (msg) => {
      errors.push(msg);
    });
    // Should not throw, should not emit error — unknown is silently skipped.
    client.dispatchFrame({ type: 'response.future_event_that_does_not_exist_yet' });
    expect(errors).toHaveLength(0);
  });
});

describe('base — capabilities declaration', () => {
  test('OpenAI client declares replay reconnect strategy', () => {
    const c = new OpenAIFamilyRealtimeClient(OPENAI_PROFILE, { apiKey: 'sk-x' });
    expect(c.capabilities.reconnectStrategy).toBe('replay');
  });

  test('xAI uses server_vad default; OpenAI uses semantic_vad', () => {
    expect(XAI_PROFILE.turnDetectionDefault.type).toBe('server_vad');
    expect(OPENAI_PROFILE.turnDetectionDefault.type).toBe('semantic_vad');
  });
});

describe('base — chat_ctx hydration + replay (frames-only)', () => {
  test('hydrateChatCtx + snapshot roundtrip preserves items', () => {
    const c = makeClient();
    c.hydrateChatCtx([
      {
        itemId: 'a',
        role: 'user',
        kind: 'message',
        content: [{ type: 'input_text', text: 'yo' }],
        position: 0,
      },
    ]);
    expect(c.snapshotChatCtx()).toHaveLength(1);
  });
});
