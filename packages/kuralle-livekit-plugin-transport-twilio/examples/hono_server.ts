/**
 * Hono Server for Twilio Media Streams with Kuralle
 *
 * This example shows how to use Twilio Media Streams with Hono and Kuralle
 * on Cloudflare Workers.
 *
 * Deploy this file as a Cloudflare Worker.
 *
 * Twilio Setup:
 * Point your TwiML to: wss://your-domain.com/twilio/media
 */

import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { streamText } from 'hono/streaming';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { TwilioTransportAdapter } from '../src/index.js';
import { initializeLogger } from '@livekit/agents';

type TwilioMediaWebSocket = WebSocket & {
  __transport?: TwilioTransportAdapter;
  __voiceSession?: KuralleVoiceSession;
};

function asTwilioMediaWebSocket(ws: WebSocket | import('hono/ws').WSContext<WebSocket>): TwilioMediaWebSocket {
  return ws as TwilioMediaWebSocket;
}

// Types for Hono bindings (Cloudflare Workers)
type Bindings = {
  OPENAI_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Create Kuralle Runtime
const runtime = new Runtime({
  agents: [{
    id: 'assistant',
    name: 'Voice Assistant',
    model: openai('gpt-4o-mini'),
    instructions: `You are a helpful AI voice assistant.

Be conversational and friendly. Keep responses concise.`,
  }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});
initializeLogger({ pretty: true });

/**
 * Health check endpoint
 */
app.get('/', (c) => {
  return c.text(
    'Twilio Media Streams Server with Kuralle\n\nEndpoints:\nGET  /health\nWS   /twilio/media',
  );
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

/**
 * TwiML endpoint for Twilio
 */
app.get('/twilio/twiml', (c) => {
  const host = c.req.header('host') || 'localhost:8080';
  const wsUrl = `wss://${host}/twilio/media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  c.header('Content-Type', 'application/xml');
  return c.text(twiml);
});

/**
 * WebSocket endpoint for Twilio Media Streams
 */
app.get(
  '/twilio/media',
  upgradeWebSocket((c) => ({
    onMessage: async (event, ws) => {
      const message = event.data;

      // Get transport from WebSocket state
      const transport = asTwilioMediaWebSocket(ws).__transport;
      if (!transport) return;

      try {
        transport.handleMessage(message as string);
      } catch (error) {
        console.error('[HonoServer] Error handling message:', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    onOpen: async (ws: any, _c: unknown) => {
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      console.log(`[HonoServer] New connection: ${clientId}`);

      // Create Twilio transport adapter
      const transport = new TwilioTransportAdapter({
        id: `twilio-${clientId}`,
        send: (message) => {
          try {
            ws.send(message);
          } catch (error) {
            console.error('[HonoServer] Error sending:', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      // Store transport for message handling
      asTwilioMediaWebSocket(ws).__transport = transport;

      // Create Kuralle voice session
      const voiceSession = new KuralleVoiceSession({
        runtime: runtime,
        stt: new GeminiLiveSTT(),
        tts: new GeminiLiveTTS(),
        greeting: 'Hello! How can I help you today?',
      });

      // Start the session
      await voiceSession.start(transport);

      console.log(`[HonoServer] Session started: ${transport.id}`);

      // Store session for cleanup
      asTwilioMediaWebSocket(ws).__voiceSession = voiceSession;
    },

    onClose: async (ws: any, _c: unknown) => {
      console.log('[HonoServer] Connection closed');

      const mediaWs = asTwilioMediaWebSocket(ws);
      const voiceSession = mediaWs.__voiceSession;
      const transport = mediaWs.__transport;

      if (voiceSession) {
        await voiceSession.close();
      }
      if (transport) {
        await transport.close();
      }
    },

    onError: (e: Event, _ws: any) => {
      console.error('[HonoServer] WebSocket error:', e);
    },
  })),
);

/**
 * SSE endpoint for real-time events (optional, for monitoring)
 */
app.get('/events', (c) => {
  return streamText(c, async (stream) => {
    await stream.write(`data: {"status":"connected"}\n\n`);

    // Keep connection alive with periodic heartbeats
    const interval = setInterval(() => {
      stream.write(`data: {"type":"heartbeat","timestamp":${Date.now()}}\n\n`);
    }, 30000);

    // Cleanup on close
    c.req.raw.signal?.addEventListener('abort', () => {
      clearInterval(interval);
    });
  });
});

// Export for different runtimes
export default app;
