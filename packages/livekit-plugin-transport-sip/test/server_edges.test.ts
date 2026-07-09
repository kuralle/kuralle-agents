import { describe, expect, it } from 'bun:test';
import { SIPAgentServer } from '../src/server.js';
import { getSIPAgentServerTestState } from './signaling-test-access.js';

describe('SIPAgentServer edge behavior', () => {
  it('hangup delegates to signaling even when no active transport/session exists', async () => {
    const server = new SIPAgentServer({
      localAddress: '127.0.0.1',
      transport: 'udp',
    });

    let hangupCallId = '';
    getSIPAgentServerTestState(server).signaling = {
      hangup: async (callId: string) => {
        hangupCallId = callId;
      },
      stop: async () => {},
      getRtpPort: () => undefined,
    };

    await server.hangup('call-edge-1');
    expect(hangupCallId).toBe('call-edge-1');
  });

  it('close calls signaling.stop and sessionManager.closeAll', async () => {
    const server = new SIPAgentServer({ localAddress: '127.0.0.1' });
    const state = getSIPAgentServerTestState(server);

    let stopped = false;
    let closedAll = false;

    state.signaling = {
      stop: async () => {
        stopped = true;
      },
    };
    state.sessionManager = {
      closeAll: async () => {
        closedAll = true;
      },
    };

    await server.close();

    expect(stopped).toBe(true);
    expect(closedAll).toBe(true);
  });

  it('status and registration getters are stable for RTP server', () => {
    const server = new SIPAgentServer({ localAddress: '127.0.0.1' });
    expect(server.isRegistered).toBe(true);
    expect(server.status).toBe('connected');
  });
});
