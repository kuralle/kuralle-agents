import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { TwilioTransportAdapter } from '../src/transport_adapter.js';

initializeLogger({ pretty: false, level: 'warn' });

describe('TwilioTransportAdapter', () => {
  it('propagates nested start.streamSid into outbound mark events', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = new TwilioTransportAdapter({
      send: (message) => sent.push(JSON.parse(message)),
    });

    adapter.handleMessage(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: {
          streamSid: 'MZ_nested',
          callSid: 'CA1',
          tracks: ['inbound'],
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8000,
            channels: 1,
          },
        },
      }),
    );

    await adapter.textOutput.captureText('hello');

    const mark = sent.find((msg) => msg.event === 'mark');
    expect(mark).toBeTruthy();
    expect(mark!.streamSid).toBe('MZ_nested');
    expect(mark!.mark).toEqual({ name: 'agent_response_1' });
    expect(mark!.marks).toBeUndefined();
  });

  it('falls back to top-level streamSid when start.streamSid is missing', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = new TwilioTransportAdapter({
      send: (message) => sent.push(JSON.parse(message)),
    });

    adapter.handleMessage(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: 'MZ_top',
        start: {
          callSid: 'CA2',
        },
      }),
    );

    await adapter.textOutput.captureText('world');

    const mark = sent.find((msg) => msg.event === 'mark');
    expect(mark).toBeTruthy();
    expect(mark!.streamSid).toBe('MZ_top');
  });

  it('injects current streamSid into clear events', () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = new TwilioTransportAdapter({
      send: (message) => sent.push(JSON.parse(message)),
    });

    adapter.handleMessage(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: {
          streamSid: 'MZ_clear',
          callSid: 'CA3',
        },
      }),
    );

    adapter.clearAudio();

    const clear = sent.find((msg) => msg.event === 'clear');
    expect(clear).toBeTruthy();
    expect(clear!.streamSid).toBe('MZ_clear');
  });

  it('routes media events into audio input handler', () => {
    const adapter = new TwilioTransportAdapter({
      send: () => {},
    });

    let mediaHandled = false;
    adapter.audioInput.handleMediaEvent = () => {
      mediaHandled = true;
    };

    adapter.handleMessage(
      JSON.stringify({
        event: 'media',
        sequenceNumber: '2',
        streamSid: 'MZ_media',
        media: {
          track: 'inbound',
          chunk: '1',
          timestamp: '20',
          payload: 'AQID',
        },
      }),
    );

    expect(mediaHandled).toBe(true);
  });

  it('stop event ends stream and resets stream state', () => {
    const adapter = new TwilioTransportAdapter({
      send: () => {},
    });

    let ended = false;
    adapter.audioInput.endCurrentStreamPublic = () => {
      ended = true;
    };

    adapter.handleMessage(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        start: {
          streamSid: 'MZ_stop',
          callSid: 'CA4',
        },
      }),
    );
    expect(adapter.streamSid).toBe('MZ_stop');
    expect(adapter.isOpen).toBe(true);

    adapter.handleMessage(JSON.stringify({ event: 'stop', sequenceNumber: '2', streamSid: 'MZ_stop', callSid: 'CA4' }));

    expect(ended).toBe(true);
    expect(adapter.streamSid).toBe('');
    expect(adapter.isOpen).toBe(false);
  });

  it('invalid JSON message does not throw', () => {
    const adapter = new TwilioTransportAdapter({
      send: () => {},
    });

    expect(() => adapter.handleMessage('{bad-json')).not.toThrow();
  });
});
