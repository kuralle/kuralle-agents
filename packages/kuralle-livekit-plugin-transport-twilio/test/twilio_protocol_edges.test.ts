import { describe, expect, it } from 'bun:test';
import {
  extractMediaPayload,
  isMediaEvent,
  parseTwilioMessage,
  type TwilioMediaEvent,
} from '../src/twilio_protocol.js';

describe('Twilio protocol edge cases', () => {
  it('returns null for invalid JSON', () => {
    expect(parseTwilioMessage('{bad-json')).toBeNull();
  });

  it('returns null when event type is unknown', () => {
    expect(parseTwilioMessage(JSON.stringify({ event: 'bad_event', sequenceNumber: '1' }))).toBeNull();
  });

  it('returns null when event field is missing', () => {
    expect(parseTwilioMessage(JSON.stringify({ sequenceNumber: '1' }))).toBeNull();
  });

  it('isMediaEvent false when media payload missing', () => {
    const event = parseTwilioMessage(
      JSON.stringify({ event: 'media', sequenceNumber: '2', media: { track: 'inbound', chunk: '1', timestamp: '10' } }),
    );
    expect(event).toBeTruthy();
    expect(isMediaEvent(event!)).toBe(false);
  });

  it('extractMediaPayload returns null when payload is missing', () => {
    const event: TwilioMediaEvent = {
      event: 'media',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '1',
        payload: '',
      },
    };
    expect(extractMediaPayload(event)).toBeNull();
  });
});
