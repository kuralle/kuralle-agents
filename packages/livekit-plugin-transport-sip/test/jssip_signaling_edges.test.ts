import { describe, expect, it } from 'bun:test';
import { JsSIPSignaling } from '../src/jssip/jssip_signaling.js';
import { getJsSIPSignalingTestState } from './signaling-test-access.js';

describe('JsSIPSignaling edge cases', () => {
  it('is disconnected and unregistered before start', () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    expect(signaling.status).toBe('disconnected');
    expect(signaling.isRegistered).toBe(false);
  });

  it('stop is safe before start', async () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    await signaling.stop();
    expect(signaling.status).toBe('disconnected');
  });

  it('hangup is safe for unknown call ids', async () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    await signaling.hangup('unknown-call');
    expect(signaling.getSession('unknown-call')).toBeUndefined();
  });

  it('makeCall throws when UA is not started', async () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    await expect(signaling.makeCall('sip:test@example.com')).rejects.toThrow('User agent not started');
  });

  it('stop terminates active sessions and resets UA state', async () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    const state = getJsSIPSignalingTestState(signaling);

    let terminated = 0;
    let stopped = false;

    state.ua = {
      stop: () => {
        stopped = true;
      },
      isRegistered: () => true,
      status: 1,
    };
    state.activeSessions.set('call-1', {
      terminate: async () => {
        terminated += 1;
      },
    });
    state.activeSessions.set('call-2', {
      terminate: async () => {
        terminated += 1;
      },
    });

    await signaling.stop();

    expect(terminated).toBe(2);
    expect(stopped).toBe(true);
    expect(state.activeSessions.size).toBe(0);
    expect(signaling.status).toBe('disconnected');
    expect(signaling.isRegistered).toBe(false);
  });

  it('maps UA status into connected/connecting states', () => {
    const signaling = new JsSIPSignaling({ localAddress: '127.0.0.1' });
    const state = getJsSIPSignalingTestState(signaling);

    state.ua = { status: 0, isRegistered: () => false };
    expect(signaling.status).toBe('connecting');

    state.ua = { status: 2, isRegistered: () => false };
    expect(signaling.status).toBe('connected');
  });
});
