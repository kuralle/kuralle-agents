import { WebSocketServer as WSServer, type WebSocket } from 'ws';
import { SessionManager, type KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { voice } from '@livekit/agents';
import type { IncomingMessage } from 'node:http';
import type { Runtime } from '@kuralle-agents/core';
import type { RealtimeAudioClient, RealtimeSessionHandle } from '@kuralle-agents/core/realtime';
import { VoiceCallSession } from '@kuralle-agents/realtime-audio';
import { WebSocketTransportAdapter } from './transport_adapter.js';
import { bridgeWebSocketToRealtimeTransport } from './realtime_bridge.js';
import { parseClientMessage, serializeServerMessage, type ServerMessage } from './protocol.js';
import type { WebSocketServerOptions } from './types.js';
import { debug } from './debug.js';

/**
 * Options for starting a native audio session through VoiceCallSession.
 */
export interface NativeSessionOptions {
  /** The VoiceCallSession / VoiceEngine stack to route audio through. */
  runtime: Runtime;
  /** Factory that creates a RealtimeAudioClient for each session. */
  createModelClient: () => RealtimeAudioClient;
  /** Optional session ID (generated if not provided). */
  sessionId?: string;
  /** Optional user ID for session scoping. */
  userId?: string;
  /** Optional agent ID override. */
  agentId?: string;
}

/**
 * Options for starting a direct AgentSession backed by a LiveKit realtime LLM.
 *
 * Intended for @livekit/agents-plugin-google beta realtime models, but typed
 * against AgentSession's public llm option so this transport package does not
 * require the Google plugin at runtime.
 */
export interface RealtimeSessionOptions {
  /** Realtime LLM model, e.g. google.beta.realtime.RealtimeModel. */
  model: NonNullable<voice.AgentSessionOptions['llm']>;
  /** LiveKit voice agent with instructions and llm.tool() definitions. */
  agent: voice.Agent;
  /** Max consecutive tool steps. Defaults to AgentSession's configured default. */
  maxToolSteps?: number;
  /** Optional session ID emitted to the WebSocket client. */
  sessionId?: string;
  /** Called when the session closes or the WebSocket disconnects. */
  onSessionEnd?: (reason: string) => void;
}

/**
 * A WebSocket server that accepts connections and creates agent sessions.
 *
 * Usage:
 *   const server = new WebSocketAgentServer({ port: 8080 });
 *
 *   server.onConnection(async (transport) => {
 *     const voiceSession = new KuralleVoiceSession({
 *       runtime: runtime,
 *       stt: new GeminiLiveSTT(),
 *       tts: new GeminiLiveTTS(),
 *     });
 *     await server.startSession(transport, voiceSession);
 *   });
 *
 *   await server.listen();
 */
export class WebSocketAgentServer {
  private wss: WSServer | null = null;
  private sessionManager: SessionManager = new SessionManager();
  private nativeSessions = new Map<string, RealtimeSessionHandle>();
  private realtimeSessions = new Map<string, voice.AgentSession>();
  private sessionStartedSent = new Set<string>();
  private connectionHandler:
    | ((adapter: WebSocketTransportAdapter) => void | Promise<void>)
    | null = null;

  constructor(private options: WebSocketServerOptions = {}) {}

  onConnection(
    handler: (adapter: WebSocketTransportAdapter) => void | Promise<void>,
  ): void {
    this.connectionHandler = handler;
  }

  async startSession(
    adapter: WebSocketTransportAdapter,
    voiceSession: KuralleVoiceSession,
  ): Promise<voice.AgentSession> {
    return this.sessionManager.startSession(adapter, voiceSession);
  }

  /**
   * Start a direct LiveKit AgentSession over the WebSocket transport.
   *
   * This path is for native realtime models such as
   * @livekit/agents-plugin-google's RealtimeModel. It wires the transport's
   * AudioInput/AudioOutput/TextOutput directly into AgentSession, with no
   * LiveKit Room.
   */
  async startRealtimeSession(
    adapter: WebSocketTransportAdapter,
    options: RealtimeSessionOptions,
  ): Promise<voice.AgentSession> {
    const ws = adapter.rawSocket;
    const sessionId = options.sessionId ?? adapter.id;
    let sessionEnded = false;

    const session = new voice.AgentSession({
      llm: options.model,
      maxToolSteps: options.maxToolSteps,
    });

    session.input.audio = adapter.audioInput;
    session.output.audio = adapter.audioOutput;
    session.output.transcription = adapter.textOutput;

    const sendJson = (payload: ServerMessage): void => {
      this.sendServerMessage(ws, payload);
    };

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      sendJson({ type: 'agent_state', state: event.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      sendJson({ type: 'user_state', state: event.newState });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      sendJson({
        type: 'user_transcription',
        text: event.transcript,
        isFinal: event.isFinal,
      });
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
      event.functionCalls.forEach((call, index) => {
        sendJson({
          type: 'tool_result',
          toolName: call.name,
          success: Boolean(event.functionCallOutputs[index]),
        });
      });
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      sendJson({
        type: 'metrics_collected',
        metricsType: typeof event.metrics?.type === 'string' ? event.metrics.type : undefined,
      });
    });

    session.on(voice.AgentSessionEventTypes.Close, (event) => {
      if (sessionEnded) return;
      sessionEnded = true;
      this.realtimeSessions.delete(adapter.id);
      options.onSessionEnd?.(String(event.reason));
    });

    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      this.sendServerMessage(ws, {
        type: 'error',
        message: event.error instanceof Error ? event.error.message : String(event.error),
        code: 'realtime_session_error',
      });
    });

    const closeRealtimeSession = (reason: string): void => {
      if (sessionEnded) return;
      sessionEnded = true;
      this.realtimeSessions.delete(adapter.id);
      options.onSessionEnd?.(reason);
      session.close().catch((err) => {
        console.error('[WebSocketServer] realtime session close error:', {
          error: err instanceof Error ? err.message : String(err),
          adapterId: adapter.id,
          timestamp: new Date().toISOString(),
        });
      });
    };

    ws.once('close', () => closeRealtimeSession('client_disconnect'));
    ws.once('error', () => closeRealtimeSession('socket_error'));

    try {
      await session.start({ agent: options.agent });
    } catch (err) {
      try { await session.close(); } catch { /* swallow cleanup errors */ }
      this.sendServerMessage(ws, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        code: 'realtime_session_start_failed',
      });
      if (ws.readyState === ws.OPEN) {
        ws.close(4000, 'Realtime session start failed');
      }
      throw err;
    }

    this.realtimeSessions.set(adapter.id, session);
    this.sendSessionStarted(adapter, sessionId);

    return session;
  }

  /**
   * Start a native audio session that routes audio directly through
   * VoiceCallSession instead of the cascaded STT→LLM→TTS pipeline.
   *
   * This uses the WS-to-RealtimeTransport bridge to convert the raw
   * WebSocket connection into a RealtimeTransportSession, then starts
   * a session via VoiceCallSession.
   *
   * The model client handles STT, reasoning, and TTS in a single
   * persistent connection (e.g., Gemini Live, OpenAI Realtime).
   *
   * @example
   * ```typescript
   * server.onConnection(async (transport) => {
   *   await server.startNativeSession(transport, {
   *     runtime: realtimeRuntime,
   *     createModelClient: () => new GeminiLiveSession({ apiKey, model }),
   *   });
   * });
   * ```
   */
  async startNativeSession(
    adapter: WebSocketTransportAdapter,
    options: NativeSessionOptions,
  ): Promise<RealtimeSessionHandle> {
    const ws = adapter.rawSocket;

    const realtimeTransport = bridgeWebSocketToRealtimeTransport(ws, {
      sessionId: adapter.id,
    });

    const modelClient = options.createModelClient();

    const sessionId = options.sessionId ?? adapter.id;
    const handle = new VoiceCallSession({
      runtime: options.runtime,
      modelClient,
      transport: realtimeTransport,
      sessionId,
      userId: options.userId,
      agentId: options.agentId,
    });
    await handle.start();

    this.nativeSessions.set(adapter.id, handle);

    // Wire cleanup on WS close
    ws.on('close', () => {
      const nativeHandle = this.nativeSessions.get(adapter.id);
      if (nativeHandle) {
        this.nativeSessions.delete(adapter.id);
        nativeHandle.stop().catch((err) => {
          console.error('[WebSocketServer] native session stop error:', {
            error: err instanceof Error ? err.message : String(err),
            adapterId: adapter.id,
            timestamp: new Date().toISOString(),
          });
        });
      }
    });

    console.info('[WebSocketServer] native session started', {
      adapterId: adapter.id,
      sessionId: handle.sessionId,
      callId: handle.callId,
      timestamp: new Date().toISOString(),
    });

    return handle;
  }

  private sendServerMessage(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(serializeServerMessage(message));
    } catch {
      // WebSocket already closed.
    }
  }

  private sendSessionStarted(adapter: WebSocketTransportAdapter, sessionId = adapter.id): void {
    if (this.sessionStartedSent.has(adapter.id)) return;

    this.sendServerMessage(adapter.rawSocket, {
      type: 'session_started',
      sessionId,
      config: {
        sampleRate: adapter.config.sampleRate,
        numChannels: adapter.config.numChannels,
        encoding: adapter.config.encoding,
      },
    });
    this.sessionStartedSent.add(adapter.id);
  }

  async listen(): Promise<void> {
    const port = this.options.port ?? 8080;
    const host = this.options.host ?? '0.0.0.0';

    this.wss = new WSServer({ port, host });

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const connectedAt = Date.now();
      let binaryMessageCount = 0;
      let firstBinaryAt: number | null = null;

      // Authentication
      if (this.options.authenticate) {
        const allowed = await this.options.authenticate(req);
        if (!allowed) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      const sampleRate = this.options.defaultSampleRate ?? 24000;
      const numChannels = this.options.defaultNumChannels ?? 1;

      const adapter = new WebSocketTransportAdapter(ws, {
        sampleRate,
        numChannels,
      });

      console.info('[WebSocketServer] client connected', {
        adapterId: adapter.id,
        remoteAddress: req.socket.remoteAddress,
        timestamp: new Date().toISOString(),
      });

      // Handle text and control messages
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          binaryMessageCount += 1;
          if (!firstBinaryAt) {
            firstBinaryAt = Date.now();
            console.info('[WebSocketServer] first binary audio packet received', {
              adapterId: adapter.id,
              bytes: data.byteLength,
              msSinceConnect: firstBinaryAt - connectedAt,
              timestamp: new Date().toISOString(),
            });
          } else if (binaryMessageCount % 100 === 0) {
            debug('[WebSocketServer] binary audio packet progress', {
              adapterId: adapter.id,
              count: binaryMessageCount,
              bytes: data.byteLength,
              timestamp: new Date().toISOString(),
            });
          }
          return;
        }
        const msg = parseClientMessage(data.toString());
        if (!msg) {
          console.warn('[WebSocketServer] unrecognized client message', {
            adapterId: adapter.id,
            payloadPreview: data.toString().slice(0, 120),
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (msg.type === 'end_of_audio') {
          console.info('[WebSocketServer] end_of_audio received', {
            adapterId: adapter.id,
            binaryMessageCount,
            timestamp: new Date().toISOString(),
          });
          adapter.audioInput.endOfAudio();
        } else if (msg.type === 'user_text') {
          console.info('[WebSocketServer] user_text received', {
            adapterId: adapter.id,
            chars: msg.text.length,
            timestamp: new Date().toISOString(),
          });
          const session = this.sessionManager.getSession(adapter.id);
          if (session) {
            try {
              const handle = session.generateReply({ userInput: msg.text });
              handle.addDoneCallback(() => {
                // Intentionally noop: callback is used to attach completion lifecycle
                // in one place for future telemetry hooks.
              });
            } catch (err) {
              console.error('[WebSocketServer] generateReply error:', {
                error: err instanceof Error ? err.message : String(err),
                adapterId: adapter.id,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      });

      // Handle disconnect
      ws.on('close', (code, reasonBuffer) => {
        const disconnectedAt = Date.now();
        console.info('[WebSocketServer] client disconnected', {
          adapterId: adapter.id,
          code,
          reason: reasonBuffer.toString(),
          binaryMessageCount,
          sessionDurationMs: disconnectedAt - connectedAt,
          timestamp: new Date().toISOString(),
        });
        this.sessionManager.closeSession(adapter.id).catch((err) => {
          console.error('[WebSocketServer] Error closing session:', {
            error: err instanceof Error ? err.message : String(err),
            adapterId: adapter.id,
            timestamp: new Date().toISOString(),
          });
        });
        const realtimeSession = this.realtimeSessions.get(adapter.id);
        if (realtimeSession) {
          this.realtimeSessions.delete(adapter.id);
          realtimeSession.close().catch((err) => {
            console.error('[WebSocketServer] Error closing realtime session:', {
              error: err instanceof Error ? err.message : String(err),
              adapterId: adapter.id,
              timestamp: new Date().toISOString(),
            });
          });
        }
        this.sessionStartedSent.delete(adapter.id);
      });

      if (this.connectionHandler) {
        await this.connectionHandler(adapter);
      }

      if (this.options.autoSendSessionStarted !== false) {
        this.sendSessionStarted(adapter);
        console.info('[WebSocketServer] session_started sent', {
          adapterId: adapter.id,
          sampleRate,
          numChannels,
          timestamp: new Date().toISOString(),
        });
      }
    });

    return new Promise<void>((resolve) => {
      this.wss!.on('listening', () => {
        resolve();
      });
    });
  }

  get sessions(): SessionManager {
    return this.sessionManager;
  }

  async close(): Promise<void> {
    // Stop all native sessions
    const nativeStops = Array.from(this.nativeSessions.values()).map(
      (handle) => handle.stop().catch(() => {}),
    );
    await Promise.allSettled(nativeStops);
    this.nativeSessions.clear();

    // Close all direct realtime AgentSessions
    const realtimeStops = Array.from(this.realtimeSessions.values()).map(
      (session) => session.close().catch(() => {}),
    );
    await Promise.allSettled(realtimeStops);
    this.realtimeSessions.clear();
    this.sessionStartedSent.clear();

    // Close all cascaded sessions
    await this.sessionManager.closeAll();
    if (this.wss) {
      this.wss.close();
    }
  }
}
