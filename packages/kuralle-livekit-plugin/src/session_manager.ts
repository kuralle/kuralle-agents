import { voice } from '@livekit/agents';
import type { TransportAdapter } from './transport_adapter.js';
import type { TransportSessionInfo } from './types.js';
import { KuralleVoiceSession } from './session/KuralleVoiceSession.js';

/**
 * Manages the lifecycle of KuralleVoiceSessions backed by TransportAdapters.
 *
 * Handles:
 *   - Starting sessions with KuralleVoiceSession
 *   - Tracking active sessions for monitoring and graceful shutdown
 *
 * @example
 * ```typescript
 * const sessionManager = new SessionManager();
 *
 * const voiceSession = new KuralleVoiceSession({...});
 * const agentSession = await sessionManager.startSession(transport, voiceSession);
 * ```
 */
export class SessionManager {
  private activeSessions: Map<
    string,
    {
      voiceSession: KuralleVoiceSession;
      agentSession: voice.AgentSession;
      adapter: TransportAdapter;
      info: TransportSessionInfo;
    }
  > = new Map();

  /**
   * Start an KuralleVoiceSession with a transport adapter.
   *
   * @param adapter - The transport adapter for audio I/O
   * @param voiceSession - The Kuralle voice session to start
   * @returns The LiveKit AgentSession
   */
  async startSession(
    adapter: TransportAdapter,
    voiceSession: KuralleVoiceSession,
  ): Promise<voice.AgentSession> {
    const agentSession = await voiceSession.start(adapter);

    const info: TransportSessionInfo = {
      sessionId: adapter.id,
      transportType: adapter.constructor.name,
      createdAt: new Date(),
    };

    this.activeSessions.set(adapter.id, {
      voiceSession,
      agentSession,
      adapter,
      info,
    });

    return agentSession;
  }

  getActiveSessions(): TransportSessionInfo[] {
    return Array.from(this.activeSessions.values()).map((entry) => entry.info);
  }

  getSession(adapterId: string): voice.AgentSession | undefined {
    return this.activeSessions.get(adapterId)?.agentSession;
  }

  getVoiceSession(adapterId: string): KuralleVoiceSession | undefined {
    return this.activeSessions.get(adapterId)?.voiceSession;
  }

  async closeSession(adapterId: string): Promise<void> {
    const entry = this.activeSessions.get(adapterId);
    if (!entry) return;

    // Remove first to prevent concurrent double-close
    this.activeSessions.delete(adapterId);

    const errors: unknown[] = [];
    try { await entry.voiceSession.close(); } catch (err) { errors.push(err); }
    try { await entry.adapter.close(); } catch (err) { errors.push(err); }

    if (errors.length > 0) {
      console.warn('[SessionManager] closeSession errors:', {
        adapterId,
        errors: errors.map((e) => (e instanceof Error ? e.message : String(e))),
      });
    }
  }

  /**
   * Evict sessions whose transport adapter is no longer open.
   * Call periodically or on transport close/error events.
   */
  async evictDeadSessions(): Promise<number> {
    let evicted = 0;
    for (const [id, entry] of this.activeSessions) {
      if (!entry.adapter.isOpen) {
        await this.closeSession(id);
        evicted++;
      }
    }
    return evicted;
  }

  get activeSessionCount(): number {
    return this.activeSessions.size;
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.activeSessions.keys()).map((id) =>
      this.closeSession(id),
    );
    await Promise.allSettled(promises);
  }
}
