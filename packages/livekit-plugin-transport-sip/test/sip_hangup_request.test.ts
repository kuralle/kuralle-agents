import { describe, expect, it } from 'bun:test';
import { SIPSignaling } from '../src/sip_signaling.js';
import { getSIPSignalingTestState } from './signaling-test-access.js';

describe('SIPSignaling hangup', () => {
  it('uses stored remoteUri for BYE request target', async () => {
    const signaling = new SIPSignaling({ localAddress: '127.0.0.1', sipPort: 5060 });
    const state = getSIPSignalingTestState(signaling);

    let requestPayload: string | null = null;
    let sentPayload: { payload: string; host: string; port: number } | null = null;

    state.voip = {
      transport: {
        send: (payload: string, host: string, port: number) => {
          requestPayload = payload;
          sentPayload = { payload, host, port };
        },
        socket: {
          close: () => {},
        },
      },
    };

    state.activeCalls.set('call-remote-uri', {
      rtpPort: 10000,
      localTag: 'local-tag-1',
      remoteTag: 'remote-tag-1',
      localUri: 'sip:agent@127.0.0.1',
      localContactUri: 'sip:agent@127.0.0.1:5060',
      remoteUri: 'sip:alice@example.com:5060',
      remoteTargetUri: 'sip:alice@example.com:5060',
      responseHost: '10.0.0.10',
      responsePort: 5060,
      nextLocalCseq: 0,
    });

    await signaling.hangup('call-remote-uri');

    expect(requestPayload).toBeTruthy();
    expect(requestPayload!).toContain('BYE sip:alice@example.com:5060 SIP/2.0');
    expect(sentPayload).toBeTruthy();
    expect(sentPayload!.host).toBe('10.0.0.10');
    expect(sentPayload!.port).toBe(5060);
    expect(state.activeCalls.has('call-remote-uri')).toBe(false);
  });

  it('stop hangs up all active calls and closes transport socket', async () => {
    const signaling = new SIPSignaling({ localAddress: '127.0.0.1', sipPort: 5060 });
    const state = getSIPSignalingTestState(signaling);

    const requested: string[] = [];
    const sent: Array<{ payload: string; host: string; port: number }> = [];
    let socketClosed = false;

    state.voip = {
      transport: {
        send: (payload: string, host: string, port: number) => {
          requested.push(payload);
          sent.push({ payload, host, port });
        },
        socket: {
          close: () => {
            socketClosed = true;
          },
        },
      },
    };

    state.activeCalls.set('call-1', {
      rtpPort: 10000,
      localTag: 'local-tag-1',
      remoteTag: 'remote-tag-1',
      localUri: 'sip:agent@127.0.0.1',
      localContactUri: 'sip:agent@127.0.0.1:5060',
      remoteUri: 'sip:alice@example.com:5060',
      remoteTargetUri: 'sip:alice@example.com:5060',
      responseHost: '10.0.0.10',
      responsePort: 5060,
      nextLocalCseq: 0,
    });
    state.activeCalls.set('call-2', {
      rtpPort: 10002,
      localTag: 'local-tag-2',
      remoteTag: 'remote-tag-2',
      localUri: 'sip:agent@127.0.0.1',
      localContactUri: 'sip:agent@127.0.0.1:5060',
      remoteUri: 'sip:bob@example.com:5060',
      remoteTargetUri: 'sip:bob@example.com:5060',
      responseHost: '10.0.0.11',
      responsePort: 5060,
      nextLocalCseq: 0,
    });

    await signaling.stop();

    expect(requested.length).toBe(2);
    expect(requested.every((req) => String(req).startsWith('BYE '))).toBe(true);
    expect(sent.length).toBe(2);
    expect(socketClosed).toBe(true);
    expect(state.activeCalls.size).toBe(0);
    expect(state.voip).toBeNull();
    expect(state.ready).toBe(false);
  });
});
