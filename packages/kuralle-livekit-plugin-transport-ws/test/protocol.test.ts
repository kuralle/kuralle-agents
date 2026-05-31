import { describe, expect, it } from 'bun:test';
import { parseClientMessage, serializeServerMessage } from '../src/protocol.js';

describe('WS protocol parser edge cases', () => {
  it('parses valid configure message', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'configure', sampleRate: 16000, numChannels: 1, encoding: 'pcm_s16le' }),
    );
    expect(parsed).toBeTruthy();
    expect(parsed?.type).toBe('configure');
  });

  it('parses valid user_text message', () => {
    const parsed = parseClientMessage(JSON.stringify({ type: 'user_text', text: 'hello' }));
    expect(parsed).toBeTruthy();
    expect(parsed?.type).toBe('user_text');
    if (parsed?.type === 'user_text') {
      expect(parsed.text).toBe('hello');
    }
  });

  it('parses valid end_of_audio message', () => {
    const parsed = parseClientMessage(JSON.stringify({ type: 'end_of_audio' }));
    expect(parsed).toBeTruthy();
    expect(parsed?.type).toBe('end_of_audio');
  });

  it('returns null for invalid JSON', () => {
    expect(parseClientMessage('{not-json')).toBeNull();
  });

  it('returns null for unknown message type', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
  });

  it('returns null when type is missing', () => {
    expect(parseClientMessage(JSON.stringify({ text: 'missing type' }))).toBeNull();
  });

  it('returns null for user_text without string text', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'user_text', text: 123 }))).toBeNull();
  });

  it('returns null for configure with invalid sampleRate', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'configure', sampleRate: -1 }))).toBeNull();
  });

  it('returns null for configure with invalid numChannels', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'configure', numChannels: 0 }))).toBeNull();
  });

  it('returns null for configure with unknown encoding', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'configure', encoding: 'pcm_u8' }))).toBeNull();
  });

  it('serializes server message JSON', () => {
    const serialized = serializeServerMessage({
      type: 'session_started',
      sessionId: 's1',
      config: { sampleRate: 24000, numChannels: 1, encoding: 'pcm_s16le' },
    });
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe('session_started');
    expect(parsed.sessionId).toBe('s1');
  });
});
