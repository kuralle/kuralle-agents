import { describe, expect, it } from 'bun:test';
import { SessionManager } from '../src/session_manager.js';
import { createTestTransportAdapter, TestVoiceSession } from './livekit_stubs.js';

describe('SessionManager error handling (Phase 3 fixes)', () => {
  it('H3: closeSession still closes adapter and removes entry when voiceSession.close() throws', async () => {
    const manager = new SessionManager();

    let adapterClosed = false;

    const voiceSession = new TestVoiceSession({
      close: async () => {
        throw new Error('voice session close failed');
      },
    });

    const adapter = createTestTransportAdapter({
      id: 'transport-fail',
      close: async () => {
        adapterClosed = true;
      },
    });

    await manager.startSession(adapter, voiceSession);
    expect(manager.getSession('transport-fail')).toBeTruthy();

    // Should NOT throw, even though voiceSession.close() throws
    await manager.closeSession('transport-fail');

    // Entry should be removed
    expect(manager.getSession('transport-fail')).toBeUndefined();
    // Adapter should still have been closed
    expect(adapterClosed).toBe(true);
  });

  it('H3: closeSession still removes entry when adapter.close() throws', async () => {
    const manager = new SessionManager();

    let voiceClosed = false;

    const voiceSession = new TestVoiceSession({
      close: async () => {
        voiceClosed = true;
      },
    });

    const adapter = createTestTransportAdapter({
      id: 'transport-adapter-fail',
      close: async () => {
        throw new Error('adapter close failed');
      },
    });

    await manager.startSession(adapter, voiceSession);

    await manager.closeSession('transport-adapter-fail');

    expect(manager.getSession('transport-adapter-fail')).toBeUndefined();
    expect(voiceClosed).toBe(true);
  });

  it('M8: evictDeadSessions removes sessions with closed adapters', async () => {
    const manager = new SessionManager();

    let voiceClosed = false;

    const voiceSession = new TestVoiceSession({
      close: async () => {
        voiceClosed = true;
      },
    });

    const adapter = createTestTransportAdapter({
      id: 'transport-dead',
      isOpen: false,
    });

    await manager.startSession(adapter, voiceSession);
    expect(manager.activeSessionCount).toBe(1);

    const evicted = await manager.evictDeadSessions();

    expect(evicted).toBe(1);
    expect(manager.activeSessionCount).toBe(0);
    expect(voiceClosed).toBe(true);
  });

  it('M8: evictDeadSessions does not evict live sessions', async () => {
    const manager = new SessionManager();

    const voiceSession = new TestVoiceSession();

    const adapter = createTestTransportAdapter({
      id: 'transport-alive',
      isOpen: true,
    });

    await manager.startSession(adapter, voiceSession);

    const evicted = await manager.evictDeadSessions();

    expect(evicted).toBe(0);
    expect(manager.activeSessionCount).toBe(1);
  });

  it('H3: concurrent closeSession calls do not double-close', async () => {
    const manager = new SessionManager();

    let closeCount = 0;

    const voiceSession = new TestVoiceSession({
      close: async () => {
        closeCount++;
        // Simulate slow close
        await new Promise((r) => setTimeout(r, 10));
      },
    });

    const adapter = createTestTransportAdapter({
      id: 'transport-concurrent',
    });

    await manager.startSession(adapter, voiceSession);

    // Fire two concurrent close calls
    await Promise.all([
      manager.closeSession('transport-concurrent'),
      manager.closeSession('transport-concurrent'),
    ]);

    // voiceSession.close() should only be called once because the second
    // closeSession sees the entry already removed from the map
    expect(closeCount).toBe(1);
  });
});
