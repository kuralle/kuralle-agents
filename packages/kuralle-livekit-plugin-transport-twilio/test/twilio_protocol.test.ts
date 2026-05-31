import { describe, expect, it } from 'bun:test';
import {
  createClearMessage,
  createMarkMessage,
  isMediaEvent,
  parseTwilioMessage,
} from '../src/twilio_protocol.js';

describe('Twilio protocol fixtures', () => {
  it('parses nested start event and preserves streamSid', () => {
    const fixture = JSON.stringify({
      event: 'start',
      sequenceNumber: '2',
      start: {
        streamSid: 'MZ123',
        callSid: 'CA123',
        tracks: ['inbound'],
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    });

    const parsed = parseTwilioMessage(fixture);
    expect(parsed).toBeTruthy();
    expect(parsed?.event).toBe('start');
    expect(parsed?.start?.streamSid).toBe('MZ123');
    expect(parsed?.start?.callSid).toBe('CA123');
  });

  it('parses media payload shape and passes media guard', () => {
    const fixture = JSON.stringify({
      event: 'media',
      sequenceNumber: '3',
      streamSid: 'MZ123',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '20',
        payload: 'AQID',
      },
    });

    const parsed = parseTwilioMessage(fixture);
    expect(parsed).toBeTruthy();
    expect(isMediaEvent(parsed!)).toBe(true);
    if (parsed && isMediaEvent(parsed)) {
      expect(parsed.media.payload).toBe('AQID');
    }
  });

  it('serializes outbound mark message with Twilio mark object', () => {
    const raw = createMarkMessage('turn_end');
    const parsed = JSON.parse(raw);

    expect(parsed.event).toBe('mark');
    expect(parsed.mark).toEqual({ name: 'turn_end' });
    expect(parsed.marks).toBeUndefined();
  });

  it('serializes clear message fixture', () => {
    const raw = createClearMessage();
    const parsed = JSON.parse(raw);

    expect(parsed.event).toBe('clear');
    expect(typeof parsed.sequenceNumber).toBe('string');
    expect(parsed.streamSid).toBe('');
  });
});
