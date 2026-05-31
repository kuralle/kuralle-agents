import { describe, expect, it } from 'bun:test';
import { SessionManager } from '../src/session_manager.js';
import { createTestTransportAdapter, TestVoiceSession } from './livekit_stubs.js';

describe('SessionManager lifecycle behavior', () => {
  it('tracks sessions by adapter id and closes targeted sessions deterministically', async () => {
    const manager = new SessionManager();

    let voiceCloseA = 0;
    let voiceCloseB = 0;
    let adapterCloseA = 0;
    let adapterCloseB = 0;

    const voiceSessionA = new TestVoiceSession({
      close: async () => {
        voiceCloseA += 1;
      },
    });
    const voiceSessionB = new TestVoiceSession({
      close: async () => {
        voiceCloseB += 1;
      },
    });

    const adapterA = createTestTransportAdapter({
      id: 'transport-a',
      className: 'AdapterA',
      close: async () => {
        adapterCloseA += 1;
      },
    });
    const adapterB = createTestTransportAdapter({
      id: 'transport-b',
      className: 'AdapterB',
      close: async () => {
        adapterCloseB += 1;
      },
    });

    await manager.startSession(adapterA, voiceSessionA);
    await manager.startSession(adapterB, voiceSessionB);

    expect(manager.getSession('transport-a')).toBeTruthy();
    expect(manager.getSession('transport-b')).toBeTruthy();
    expect(manager.getActiveSessions().map((s) => s.sessionId).sort()).toEqual(['transport-a', 'transport-b']);

    await manager.closeSession('transport-a');

    expect(manager.getSession('transport-a')).toBeUndefined();
    expect(manager.getSession('transport-b')).toBeTruthy();
    expect(voiceCloseA).toBe(1);
    expect(adapterCloseA).toBe(1);
    expect(voiceCloseB).toBe(0);
    expect(adapterCloseB).toBe(0);

    await manager.closeAll();

    expect(manager.getSession('transport-b')).toBeUndefined();
    expect(voiceCloseB).toBe(1);
    expect(adapterCloseB).toBe(1);
  });
});
