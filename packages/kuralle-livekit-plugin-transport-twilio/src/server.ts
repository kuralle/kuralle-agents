import { WebSocketServer as WSServer, type WebSocket } from 'ws';
import { SessionManager, type KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import type { voice } from '@livekit/agents';
import type { IncomingMessage } from 'node:http';
import { TwilioTransportAdapter } from './transport_adapter.js';
import type { TwilioEvent } from './twilio_protocol.js';

/**
 * Options for TwilioAgentServer
 */
export interface TwilioServerOptions {
  port?: number;
  host?: string;
}

/**
 * A WebSocket server that accepts Twilio Media Streams connections and creates agent sessions.
 *
 * Usage:
 *   const server = new TwilioAgentServer({ port: 8080 });
 *
 *   server.onCall(async (callId, transport) => {
 *     const voiceSession = new KuralleVoiceSession({
 *       runtime: runtime,
 *       stt: new GeminiLiveSTT(),
 *       tts: new GeminiLiveTTS(),
 *     });
 *     await server.startSession(callId, voiceSession);
 *   });
 *
 *   await server.listen();
 */
export class TwilioAgentServer {
  private wss: WSServer | null = null;
  private sessionManager: SessionManager = new SessionManager();
  private callHandler:
    | ((callId: string, transport: TwilioTransportAdapter) => void | Promise<void>)
    | null = null;
  private callIdCounter = 0;

  constructor(private options: TwilioServerOptions = {}) {}

  onCall(
    handler: (callId: string, transport: TwilioTransportAdapter) => void | Promise<void>,
  ): void {
    this.callHandler = handler;
  }

  async startSession(
    callId: string,
    voiceSession: KuralleVoiceSession,
  ): Promise<voice.AgentSession> {
    const transport = this.transports.get(callId);
    if (!transport) {
      throw new Error(`Transport not found for call: ${callId}`);
    }
    return this.sessionManager.startSession(transport, voiceSession);
  }

  private transports = new Map<string, TwilioTransportAdapter>();

  async listen(): Promise<void> {
    const port = this.options.port ?? 8080;
    const host = this.options.host ?? '0.0.0.0';

    this.wss = new WSServer({ port, host });

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const callId = `call-${++this.callIdCounter}`;
      console.log(`[TwilioServer] New connection: ${callId}`);

      const transport = new TwilioTransportAdapter({
        id: callId,
        send: (message) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(message);
          }
        },
      });

      // Store transport
      this.transports.set(callId, transport);

      // Handle incoming messages from Twilio
      ws.on('message', (data: Buffer) => {
        try {
          const message = data.toString();

          // Parse to detect start event
          const event: TwilioEvent = JSON.parse(message);

          // Log events
          if (event.event === 'connected') {
            console.log(`[TwilioServer] [${callId}] Connected to Twilio`);
          } else if (event.event === 'start') {
            const streamSid = event.start?.streamSid ?? event.streamSid ?? '(missing)';
            console.log(`[TwilioServer] [${callId}] Stream started: ${streamSid}`);
          } else if (event.event === 'stop') {
            console.log(`[TwilioServer] [${callId}] Stream stopped`);
          }

          // Route to transport
          transport.handleMessage(message);

          // Trigger call handler on start event (when streamSid is available)
          if (event.event === 'start' && this.callHandler) {
            this.callHandler(callId, transport);
          }
        } catch (error) {
          console.error('[TwilioServer] Error handling message:', {
            error: error instanceof Error ? error.message : String(error),
            callId,
          });
        }
      });

      // Handle disconnect
      ws.on('close', async () => {
        console.log(`[TwilioServer] Connection closed: ${callId}`);
        await this.sessionManager.closeSession(callId).catch((err) => {
          console.error('[TwilioServer] Error closing session:', {
            error: err instanceof Error ? err.message : String(err),
            callId,
          });
        });
        await transport.close();
        this.transports.delete(callId);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('[TwilioServer] WebSocket error:', {
          error: error.message,
          callId,
        });
      });
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
    await this.sessionManager.closeAll();
    if (this.wss) {
      this.wss.close();
    }
  }
}
