import { describe, expect, it } from 'bun:test';
import { SIPAgentServer } from '../src/server.js';
import { SIPSignaling } from '../src/sip_signaling.js';
import { getSIPSignalingTestState } from './signaling-test-access.js';

describe('SIP RTP transport boundaries', () => {
  it('rejects websocket transport in RTP package', () => {
    expect(() =>
      new SIPAgentServer({
        localAddress: '127.0.0.1',
        transport: 'websocket',
      }),
    ).toThrow('livekit-plugin-transport-sip-jssip');
  });

  it('closes underlying SIP socket on stop', async () => {
    const signaling = new SIPSignaling({ localAddress: '127.0.0.1' });
    const state = getSIPSignalingTestState(signaling);

    let closed = false;
    state.voip = {
      transport: {
        send: () => {},
        socket: {
          close: () => {
            closed = true;
          },
        },
      },
    };

    await signaling.stop();

    expect(closed).toBe(true);
    expect(state.ready).toBe(false);
  });
});
