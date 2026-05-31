import { UA, WebSocketInterface } from 'jssip';
import type { RTCSession } from 'jssip/lib/RTCSession.js';
import type { JsSIPSignalingOptions, OnByeCallback, OnSessionCallback } from './types.js';

/**
 * SIP signaling/session lifecycle utility for SIP over WebSocket (JsSIP).
 *
 * This class handles SIP signaling and WebRTC session lifecycle only.
 * Media playout/capture should be handled via the RTCSession APIs.
 */
export class JsSIPSignaling {
  private ua: UA | null = null;
  private activeSessions: Map<string, RTCSession> = new Map();

  constructor(private options: JsSIPSignalingOptions) {}

  async start(onSession: OnSessionCallback, onBye?: OnByeCallback): Promise<void> {
    const wsProtocol = this.options.secureWebSocket === false ? 'ws' : 'wss';
    const wsUrl = `${wsProtocol}://${this.options.wsServerHost || this.options.localAddress}:${this.options.wsServerPort || 8080}/ws`;
    const sipUri = `sip:${this.options.sipUsername || 'agent'}@${this.options.sipDomain || this.options.localAddress}`;

    this.ua = new UA({
      uri: sipUri,
      sockets: [new WebSocketInterface(wsUrl)],
      password: this.options.sipPassword,
      register: this.options.shouldRegister !== false,
    });

    this.ua.on('newRTCSession', (data: { session: RTCSession }) => {
      const session = data.session;
      const callId = this.extractCallId(session);
      this.attachSession(callId, session, onBye);
      onSession(callId, session);
    });

    this.ua.on('connected', () => {
      console.log(`[JsSIPSignaling] Connected to SIP server: ${wsUrl}`);
    });

    this.ua.on('disconnected', () => {
      console.warn('[JsSIPSignaling] Disconnected from SIP server');
    });

    this.ua.on('registered', () => {
      console.log(`[JsSIPSignaling] Registered as: ${sipUri}`);
    });

    this.ua.on('registrationFailed', (event: unknown) => {
      console.error('[JsSIPSignaling] Registration failed:', event);
    });

    this.ua.start();
  }

  async makeCall(
    targetUri: string,
    onSession?: OnSessionCallback,
    onBye?: OnByeCallback,
  ): Promise<string> {
    if (!this.ua) {
      throw new Error('[JsSIPSignaling] User agent not started');
    }

    const session = this.ua.call(targetUri, {
      mediaConstraints: { audio: true, video: false },
    });

    const callId = this.extractCallId(session);
    this.attachSession(callId, session, onBye);
    onSession?.(callId, session);
    return callId;
  }

  async hangup(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      return;
    }

    try {
      await session.terminate();
    } finally {
      this.activeSessions.delete(callId);
    }
  }

  async stop(): Promise<void> {
    if (!this.ua) {
      return;
    }

    const hangupPromises = Array.from(this.activeSessions.values()).map(async (session) => {
      try {
        await session.terminate();
      } catch (error) {
        console.error('[JsSIPSignaling] Error terminating session during shutdown:', error);
      }
    });

    await Promise.allSettled(hangupPromises);
    this.activeSessions.clear();

    this.ua.stop();
    this.ua = null;
  }

  getSession(callId: string): RTCSession | undefined {
    return this.activeSessions.get(callId);
  }

  get isRegistered(): boolean {
    return this.ua?.isRegistered() ?? false;
  }

  get status(): 'disconnected' | 'connecting' | 'connected' {
    if (!this.ua) return 'disconnected';
    const uaStatus = this.ua.status;
    if (uaStatus === 0) return 'connecting';
    if (uaStatus === 1 || uaStatus === 2) return 'connected';
    return 'disconnected';
  }

  private attachSession(callId: string, session: RTCSession, onBye?: OnByeCallback): void {
    this.activeSessions.set(callId, session);

    session.on('ended', () => {
      this.activeSessions.delete(callId);
      onBye?.(callId);
    });

    session.on('failed', (error: unknown) => {
      console.error(`[JsSIPSignaling] Session ${callId} failed:`, error);
      this.activeSessions.delete(callId);
      onBye?.(callId);
    });
  }

  private extractCallId(session: RTCSession): string {
    if ('request' in session && session.request && typeof session.request === 'object') {
      const req = session.request as { call_id?: string; callId?: string };
      if (typeof req.call_id === 'string') return req.call_id;
      if (typeof req.callId === 'string') return req.callId;
    }
    return `call-${Date.now()}`;
  }
}
