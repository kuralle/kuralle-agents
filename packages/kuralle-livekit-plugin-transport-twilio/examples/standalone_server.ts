/**
 * Standalone WebSocket Server for Twilio Media Streams with Kuralle
 *
 * This example shows how to run an Kuralle voice agent that receives
 * calls from Twilio using Media Streams over WebSocket.
 *
 * Run:
 *   bun run examples/standalone_server.ts
 *
 * Twilio Setup:
 * 1. Create a TwiML Application in your Twilio console
 * 2. Set the Voice URL to: wss://your-domain.com/twilio/media
 * 3. Or use ngrok for local testing: ngrok http 8080
 */

import { WebSocketServer } from 'ws';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { TwilioTransportAdapter, parseTwilioMessage } from '../src/index.js';
import { initializeLogger } from '@livekit/agents';

const PORT = parseInt(process.env.PORT || '8080');
const HOST = process.env.HOST || '0.0.0.0';

// Create Kuralle Runtime
const runtime = new Runtime({
  agents: [{
    id: 'assistant',
    name: 'Voice Assistant',
    model: openai('gpt-4o-mini'),
    instructions: `You are a helpful AI voice assistant.

Be conversational and friendly. Keep responses concise and natural.
If you need more information, ask clarifying questions.`,
  }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});
initializeLogger({ pretty: true });

/**
 * Main server setup
 */
async function main() {
  console.log('[Server] Starting Twilio Media Streams server...');
  console.log(`[Server] Listening on ws://${HOST}:${PORT}`);
  console.log('[Server] Ready for Twilio connections');

  const wss = new WebSocketServer({ port: PORT, host: HOST });
  const voiceSessions = new Map<string, KuralleVoiceSession>();

  wss.on('connection', async (ws, req) => {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    console.log(`[Server] New connection: ${clientId}`);

    // Log connection info
    const url = req.url || '/';
    console.log(`[Server] URL: ${url}`);

    // Create Twilio transport adapter
    const transport = new TwilioTransportAdapter({
      id: `twilio-${clientId}`,
      send: (message) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      },
    });

    let sessionStarted = false;
    let startEventTimeout: NodeJS.Timeout | null = setTimeout(() => {
      if (!sessionStarted) {
        console.warn(`[Server] No 'start' event received from Twilio for ${clientId}`);
      }
    }, 5000);

    // Route incoming WebSocket messages to the transport.
    // We start the voice session once the canonical Twilio `start` event arrives.
    ws.on('message', (data: Buffer) => {
      try {
        const message = data.toString();
        const event = parseTwilioMessage(message);

        if (event?.event === 'start' && !sessionStarted) {
          const streamSid = event.start?.streamSid ?? event.streamSid ?? '(missing)';
          console.log(`[Server] [${clientId}] Stream started: ${streamSid}`);

          const voiceSession = new KuralleVoiceSession({
            runtime: runtime,
            stt: new GeminiLiveSTT(),
            tts: new GeminiLiveTTS(),
            greeting: 'Hello! Thank you for calling. How can I help you today?',
          });

          voiceSession.start(transport).then(() => {
            sessionStarted = true;
            if (startEventTimeout) clearTimeout(startEventTimeout);
            startEventTimeout = null;

            console.log(`[Server] [${clientId}] Session started`);
            voiceSessions.set(transport.id, voiceSession);
          }).catch((error) => {
            console.error('[Server] Failed to start session:', {
              error: error instanceof Error ? error.message : String(error),
              clientId,
            });
          });
        }

        transport.handleMessage(message);
      } catch (error) {
        console.error('[Server] Error handling message:', {
          error: error instanceof Error ? error.message : String(error),
          clientId,
        });
      }
    });

    // Handle WebSocket close
    ws.on('close', async () => {
      console.log(`[Server] Connection closed: ${clientId}`);

      const voiceSession = voiceSessions.get(transport.id);
      if (voiceSession) {
        await voiceSession.close();
        voiceSessions.delete(transport.id);
      }
      if (startEventTimeout) {
        clearTimeout(startEventTimeout);
        startEventTimeout = null;
      }

      await transport.close();
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error('[Server] WebSocket error:', {
        error: error.message,
        clientId,
      });
    });

  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('[Server] Shutting down...');

    // Close all sessions
    for (const [id, voiceSession] of voiceSessions) {
      console.log(`[Server] Closing session: ${id}`);
      await voiceSession.close();
    }
    voiceSessions.clear();

    // Close WebSocket server
    wss.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
