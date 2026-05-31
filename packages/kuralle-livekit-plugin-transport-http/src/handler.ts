import { SessionManager, KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import type { voice } from '@livekit/agents';
import { HTTPTransportAdapter } from './transport_adapter.js';
import { createSSEWriter, type SessionStartedEvent } from './sse.js';
import type { HTTPTransportOptions, ClientInput } from './types.js';

export interface AgentHandlerOptions {
  /** Factory function that creates an KuralleVoiceSession for each new session. */
  agent: () => KuralleVoiceSession;
  transportOptions?: HTTPTransportOptions;
}

/**
 * Framework-agnostic HTTP request handler for Kuralle voice sessions.
 *
 * Manages two kinds of requests:
 *   GET  /session?id=<id>  -- Establish SSE stream for server->client events
 *   POST /session?id=<id>  -- Send user input (text or audio)
 */
export class AgentHandler {
  private sessionManager: SessionManager = new SessionManager();
  private adapters: Map<string, HTTPTransportAdapter> = new Map();

  constructor(private options: AgentHandlerOptions) {}

  /** Handle GET request to establish SSE connection. */
  async handleSSE(request: Request): Promise<Response> {
    const url = new URL(request.url, 'http://localhost');
    let sessionId = url.searchParams.get('id');

    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }

    let adapter = this.adapters.get(sessionId);
    if (!adapter) {
      adapter = new HTTPTransportAdapter({
        id: sessionId,
        sampleRate: this.options.transportOptions?.defaultSampleRate,
        numChannels: this.options.transportOptions?.defaultNumChannels,
        sessionTimeout: this.options.transportOptions?.sessionTimeout,
      });
      this.adapters.set(sessionId, adapter);

      // Create Kuralle voice session
      const voiceSession = this.options.agent();

      // Start the session
      await this.sessionManager.startSession(adapter, voiceSession);
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const sseWriter = createSSEWriter(writable);

    adapter.attachSSE(sseWriter);

    sseWriter.writeEvent('session_started', {
      sessionId,
    } as SessionStartedEvent);

    request.signal?.addEventListener('abort', () => {
      this.closeSession(sessionId!);
    });

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Session-Id': sessionId,
      },
    });
  }

  /** Handle POST request with user input (text or audio). */
  async handleInput(request: Request): Promise<Response> {
    const url = new URL(request.url, 'http://localhost');
    const sessionId = url.searchParams.get('id');

    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Missing session ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const adapter = this.adapters.get(sessionId);
    if (!adapter || !adapter.isOpen) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    adapter.touch();

    let body: ClientInput;
    try {
      body = (await request.json()) as ClientInput;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    switch (body.type) {
      case 'user_text': {
        // Text input is processed via session.generateReply()
        const session = this.sessionManager.getSession(sessionId);
        if (session) {
          try {
            await session.generateReply({ userInput: body.text });
          } catch (err) {
            console.error('[AgentHandler] generateReply error:', err instanceof Error ? err.message : String(err));
            return new Response(JSON.stringify({ error: 'Failed to generate reply' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        break;
      }

      case 'user_audio': {
        const audioBytes = Buffer.from(body.audio, 'base64');
        adapter.audioInput.pushAudioBuffer(
          audioBytes.buffer.slice(
            audioBytes.byteOffset,
            audioBytes.byteOffset + audioBytes.byteLength,
          ),
          body.sampleRate,
          body.numChannels,
        );
        break;
      }

      case 'end_session':
        await this.closeSession(sessionId);
        break;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async closeSession(sessionId: string): Promise<void> {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) return;

    this.adapters.delete(sessionId);
    await this.sessionManager.closeSession(sessionId);
  }

  get sessions(): SessionManager {
    return this.sessionManager;
  }

  async close(): Promise<void> {
    const closePromises = Array.from(this.adapters.keys()).map((id) =>
      this.closeSession(id).catch((err) => {
        console.warn('[AgentHandler] Error closing session during shutdown:', id, err);
      }),
    );
    await Promise.allSettled(closePromises);
    this.adapters.clear();
    await this.sessionManager.closeAll();
  }
}

export function createAgentHandler(options: AgentHandlerOptions): AgentHandler {
  return new AgentHandler(options);
}
