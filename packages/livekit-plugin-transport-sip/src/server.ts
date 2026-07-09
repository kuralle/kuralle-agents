/**
 * SIP Agent Server for Kuralle Voice Agents.
 *
 * Production SIP server for SIP trunking and RTP telephony.
 *
 * UDP Transport:
 * - Direct SIP signaling over UDP (port 5060)
 * - Works with PBX systems and SIP gateways
 * - G.711 codec negotiation
 *
 * Supports three session modes:
 * - Cascaded: startSession() — STT → LLM → TTS pipeline
 * - Native:   startNativeSession() — VoiceCallSession + RealtimeAudioClient
 * - Realtime: startRealtimeSession() — LiveKit AgentSession + provider RealtimeModel
 *
 * For WebSocket/WebRTC SIP signaling, use
 * `@kuralle/livekit-plugin-transport-sip-jssip`.
 */

import { SessionManager, type KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import type { NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { voice } from '@livekit/agents';
import type { Runtime } from '@kuralle-agents/core';
import type { RealtimeAudioClient, RealtimeSessionHandle } from '@kuralle-agents/core/realtime';
import { VoiceCallSession } from '@kuralle-agents/realtime-audio';
import { SIPTransportAdapter } from './transport_adapter.js';
import { RtpSession } from './rtp/rtp_session.js';
import type { Codec } from '@kuralle-agents/transport-base/codec/g711';
import { SIPSignaling } from './sip_signaling.js';
import type { SIPServerOptions, SIPTransport } from './types.js';
import { createSipNativeAudioTransport } from './native_bridge.js';
import { debug } from './debug.js';

/**
 * Optional event sink for AgentSession events in realtime mode.
 * SIP has no text channel — use this callback for observability.
 */
export type SIPAgentEventSink = (event: {
  type: string;
  callId: string;
  timestamp: number;
  data: unknown;
}) => void;

/**
 * Options for starting a native audio session through VoiceCallSession.
 */
export interface SIPNativeSessionOptions {
  runtime: Runtime;
  createModelClient: () => RealtimeAudioClient;
  sessionId?: string;
  userId?: string;
  agentId?: string;
}

/**
 * Options for starting a direct AgentSession backed by a LiveKit realtime LLM.
 */
export interface SIPRealtimeSessionOptions {
  model: NonNullable<voice.AgentSessionOptions['llm']>;
  agent: voice.Agent;
  maxToolSteps?: number;
  sessionId?: string;
  onSessionEnd?: (reason: string) => void;
  onEvent?: SIPAgentEventSink;
}

/**
 * Parse the remote RTP endpoint from an SDP body.
 * Extracts the connection address (c= line) and audio port (m= line).
 */
function parseSdpRemoteEndpoint(sdp: string): { host: string; port: number } | null {
  const connectionMatch = sdp.match(/c=IN\s+IP[46]\s+(\S+)/);
  if (!connectionMatch) return null;
  const host = connectionMatch[1];

  const mediaMatch = sdp.match(/m=audio\s+(\d+)/);
  if (!mediaMatch) return null;
  const port = parseInt(mediaMatch[1], 10);

  if (isNaN(port) || port <= 0 || port > 65535) return null;

  return { host, port };
}

/**
 * A SIP server that accepts incoming calls and creates agent sessions.
 *
 * Supports three session modes:
 *
 * **Cascaded** (startSession):
 *   server.onCall(async (transport, callId) => {
 *     const voiceSession = new KuralleVoiceSession({ runtime, stt, tts });
 *     await server.startSession(callId, voiceSession);
 *   });
 *
 * **Native** (startNativeSession):
 *   server.onCall(async (transport, callId) => {
 *     await server.startNativeSession(callId, {
 *       runtime: realtimeRuntime,
 *       createModelClient: () => new GeminiLiveSession({ apiKey, model }),
 *     });
 *   });
 *
 * **Realtime** (startRealtimeSession):
 *   server.onCall(async (transport, callId) => {
 *     await server.startRealtimeSession(callId, {
 *       model: new google.beta.realtime.RealtimeModel({ apiKey }),
 *       agent: new voice.Agent({ instructions, tools }),
 *     });
 *   });
 *
 * For authority-backed provider realtime (Kuralle tools/flows over a provider
 * RealtimeModel), use `@kuralle-agents/realtime-audio` (`VoiceEngine`).
 */
export class SIPAgentServer {
  private sessionManager: SessionManager = new SessionManager();
  private callHandler:
    | ((adapter: SIPTransportAdapter, callId: string) => void | Promise<void>)
    | null = null;
  private signaling: SIPSignaling;
  private nextRtpPort: number;
  private activeTransports: Map<string, SIPTransportAdapter> = new Map();
  private transportType: SIPTransport;
  private activeVoiceSessions: Map<string, KuralleVoiceSession> = new Map();
  private nativeSessions = new Map<string, { handle: RealtimeSessionHandle; transport: NativeAudioTransport }>();
  private realtimeSessions = new Map<string, { session: voice.AgentSession; close: (reason: string) => void }>();

  constructor(private options: SIPServerOptions) {
    this.transportType = options.transport ?? 'udp';
    this.nextRtpPort = options.rtpPortStart ?? 10000;

    if (this.transportType === 'websocket') {
      throw new Error(
        '[SIPAgentServer] WebSocket SIP signaling was moved to @kuralle/livekit-plugin-transport-sip-jssip. ' +
          'Use transport: "udp" in this package for RTP telephony.',
      );
    }
    this.signaling = new SIPSignaling(options);
  }

  onCall(
    handler: (adapter: SIPTransportAdapter, callId: string) => void | Promise<void>,
  ): void {
    this.callHandler = handler;
  }

  /**
   * Start a cascaded voice session (STT → LLM → TTS).
   */
  async startSession(
    callId: string,
    voiceSession: KuralleVoiceSession,
  ): Promise<voice.AgentSession> {
    const transport = this.activeTransports.get(callId);
    if (!transport) {
      throw new Error(`Transport not found for call: ${callId}`);
    }
    const agentSession = await this.sessionManager.startSession(transport, voiceSession);
    this.activeVoiceSessions.set(callId, voiceSession);
    return agentSession;
  }

  /**
   * Start a native audio session that routes audio directly through
   * VoiceCallSession (e.g., Gemini Live, OpenAI Realtime).
   *
   * Uses the SIP native audio bridge to convert RTP 8kHz ↔ 24kHz PCM
   * for the realtime model client.
   */
  async startNativeSession(
    callId: string,
    options: SIPNativeSessionOptions,
  ): Promise<RealtimeSessionHandle> {
    const adapter = this.activeTransports.get(callId);
    if (!adapter) {
      throw new Error(`Transport not found for call: ${callId}`);
    }

    const nativeTransport = createSipNativeAudioTransport(adapter.rtpSession);
    const modelClient = options.createModelClient();

    let handle: RealtimeSessionHandle;
    try {
      const sessionId = options.sessionId ?? callId;
      handle = new VoiceCallSession({
        runtime: options.runtime,
        modelClient,
        transport: nativeTransport,
        sessionId,
        userId: options.userId,
        agentId: options.agentId,
      });
      await handle.start();
    } catch (err) {
      nativeTransport.close();
      throw err;
    }

    this.nativeSessions.set(callId, { handle, transport: nativeTransport });

    debug(`[SIPAgentServer] native session started for call: ${callId}`);
    return handle;
  }

  /**
   * Start a direct LiveKit AgentSession over the SIP transport.
   *
   * This path is for native realtime models such as
   * @livekit/agents-plugin-google's RealtimeModel. It wires the transport's
   * AudioInput/AudioOutput/TextOutput directly into AgentSession.
   */
  async startRealtimeSession(
    callId: string,
    options: SIPRealtimeSessionOptions,
  ): Promise<voice.AgentSession> {
    const adapter = this.activeTransports.get(callId);
    if (!adapter) {
      throw new Error(`Transport not found for call: ${callId}`);
    }

    const sessionId = options.sessionId ?? callId;
    let sessionEnded = false;

    const session = new voice.AgentSession({
      llm: options.model,
      maxToolSteps: options.maxToolSteps,
    });

    // Wire I/O directly
    session.input.audio = adapter.audioInput;
    session.output.audio = adapter.audioOutput;
    session.output.transcription = adapter.textOutput;

    const emitEvent = options.onEvent
      ? (type: string, data: unknown) => {
          options.onEvent!({ type, callId, timestamp: Date.now(), data });
        }
      : undefined;

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      emitEvent?.('agent_state', event.newState);
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      emitEvent?.('user_state', event.newState);
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      emitEvent?.('user_transcription', { text: event.transcript, isFinal: event.isFinal });
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
      event.functionCalls.forEach((call, index) => {
        emitEvent?.('tool_result', {
          toolName: call.name,
          success: Boolean(event.functionCallOutputs[index]),
        });
      });
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      emitEvent?.('metrics_collected', {
        metricsType: typeof event.metrics?.type === 'string' ? event.metrics.type : undefined,
      });
    });

    session.on(voice.AgentSessionEventTypes.Close, () => {
      if (sessionEnded) return;
      sessionEnded = true;
      this.realtimeSessions.delete(callId);
      options.onSessionEnd?.('session_close');
    });

    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      const msg = event.error instanceof Error ? event.error.message : String(event.error);
      console.error(`[SIPAgentServer] realtime session error for ${callId}: ${msg}`);
      emitEvent?.('error', { message: msg });
    });

    const closeRealtimeSession = (reason: string): void => {
      if (sessionEnded) return;
      sessionEnded = true;
      this.realtimeSessions.delete(callId);
      options.onSessionEnd?.(reason);
      session.close().catch((err) => {
        console.error(`[SIPAgentServer] realtime session close error for ${callId}:`,
          err instanceof Error ? err.message : String(err));
      });
    };

    try {
      await session.start({ agent: options.agent });
    } catch (err) {
      try { await session.close(); } catch { /* swallow cleanup errors */ }
      throw err;
    }

    this.realtimeSessions.set(callId, { session, close: closeRealtimeSession });

    debug(`[SIPAgentServer] realtime session started for call: ${callId}`);
    return session;
  }

  /**
   * Allocate a local RTP port and create a transport adapter.
   * This is called internally when a SIP INVITE is received.
   */
  private createTransport(
    callId: string,
    rtpPort: number,
    remoteSdp: string,
    negotiatedCodec: Codec,
  ): SIPTransportAdapter {
    const rtpSession = new RtpSession(negotiatedCodec, {
      localPort: rtpPort,
      continuousPacing: this.options.continuousPacing === true,
    });

    // Parse the remote SDP to extract RTP endpoint so the agent can
    // send audio before the remote sends first (e.g., greeting).
    const remoteEndpoint = parseSdpRemoteEndpoint(remoteSdp);
    if (remoteEndpoint) {
      rtpSession.setRemote(remoteEndpoint.host, remoteEndpoint.port);
    } else {
      console.warn(
        `[SIPAgentServer] Could not parse remote RTP endpoint from SDP for call ${callId}. ` +
        'Agent-initiated audio will not work until the remote sends first.',
      );
    }

    return new SIPTransportAdapter(rtpSession, negotiatedCodec, {
      id: callId,
    });
  }

  /**
   * Start listening for SIP INVITE requests.
   */
  async listen(): Promise<void> {
    const transportName = this.transportType === 'websocket' ? 'WebSocket' : 'UDP';
    debug(`[SIPAgentServer] Starting SIP server using ${transportName} transport`);

    await this.signaling.start(
      async (callId, remoteSdp, rtpPort, negotiatedCodec) => {
        debug(`[SIPAgentServer] Creating transport for call: ${callId} on RTP port ${rtpPort}`);

        // Create transport with the allocated RTP port and remote SDP
        const transport = this.createTransport(
          callId,
          rtpPort,
          remoteSdp,
          negotiatedCodec,
        );
        this.activeTransports.set(callId, transport);

        // Invoke the call handler
        if (this.callHandler) {
          try {
            await this.callHandler(transport, callId);
          } catch (error) {
            console.error(`[SIPAgentServer] Error in call handler for ${callId}:`, error);
            this.activeTransports.delete(callId);
            await transport.close();
            this.activeVoiceSessions.delete(callId);
            throw error;
          }
        }
      },
      async (callId) => {
        // Handle BYE from remote party
        debug(`[SIPAgentServer] Remote party hung up call: ${callId}`);
        await this.cleanupCall(callId, 'remote_hangup');
      }
    );

    debug(`[SIPAgentServer] Listening for calls (${transportName})`);
  }

  /**
   * Clean up all resources for a call across all three session modes.
   */
  private async cleanupCall(callId: string, reason: string): Promise<void> {
    // Cascaded cleanup
    const voiceSession = this.activeVoiceSessions.get(callId);
    if (voiceSession) {
      this.activeVoiceSessions.delete(callId);
      await voiceSession.close().catch((err) => {
        console.error(`[SIPAgentServer] voice session close error for ${callId}:`,
          err instanceof Error ? err.message : String(err));
      });
    }

    // Native cleanup
    const nativeEntry = this.nativeSessions.get(callId);
    if (nativeEntry) {
      this.nativeSessions.delete(callId);
      await nativeEntry.handle.stop().catch((err) => {
        console.error(`[SIPAgentServer] native session stop error for ${callId}:`,
          err instanceof Error ? err.message : String(err));
      });
      nativeEntry.transport.close();
    }

    // Realtime cleanup
    const realtimeEntry = this.realtimeSessions.get(callId);
    if (realtimeEntry) {
      realtimeEntry.close(reason);
    }

    // Transport cleanup (last — sessions may still be using it)
    const transport = this.activeTransports.get(callId);
    if (transport) {
      this.activeTransports.delete(callId);
      await transport.close().catch((err) => {
        console.error(`[SIPAgentServer] transport close error for ${callId}:`,
          err instanceof Error ? err.message : String(err));
      });
    }
  }

  /**
   * Hang up an active call.
   */
  async hangup(callId: string): Promise<void> {
    await this.cleanupCall(callId, 'local_hangup');
    await this.signaling.hangup(callId);
  }

  get sessions(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the RTP port for a specific call.
   */
  getRtpPort(callId: string): number | undefined {
    return this.signaling.getRtpPort?.(callId);
  }

  /**
   * SIP trunk server is connectionless once listening on UDP.
   */
  get isRegistered(): boolean {
    return true;
  }

  /**
   * SIP trunk server status.
   */
  get status(): 'disconnected' | 'connecting' | 'connected' {
    return 'connected';
  }

  async close(): Promise<void> {
    // Close all cascaded voice sessions
    const voiceSessionPromises = Array.from(this.activeVoiceSessions.values()).map((s) =>
      s.close().catch(() => {}),
    );
    await Promise.allSettled(voiceSessionPromises);
    this.activeVoiceSessions.clear();

    // Stop all native sessions
    const nativeStops = Array.from(this.nativeSessions.values()).map(async (entry) => {
      await entry.handle.stop().catch(() => {});
      entry.transport.close();
    });
    await Promise.allSettled(nativeStops);
    this.nativeSessions.clear();

    // Close all realtime sessions
    for (const [, entry] of this.realtimeSessions) {
      entry.close('server_shutdown');
    }
    this.realtimeSessions.clear();

    // Close all active transports
    const closePromises = Array.from(this.activeTransports.values()).map((t) =>
      t.close().catch(() => {}),
    );
    await Promise.allSettled(closePromises);
    this.activeTransports.clear();

    await this.sessionManager.closeAll();
    await this.signaling.stop();
  }
}
