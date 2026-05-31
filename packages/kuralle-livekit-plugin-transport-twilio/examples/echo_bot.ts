/**
 * Simple Twilio Media Streams Echo Bot.
 *
 * This example loops inbound media frames back to Twilio as outbound media.
 * It is intended for protocol verification and transport smoke testing.
 *
 * Run:
 *   bun run examples/echo_bot.ts
 *
 * Twilio Setup:
 *   <Connect>
 *     <Stream url="wss://your-domain.com/twilio/echo" />
 *   </Connect>
 */

import { WebSocketServer } from 'ws';
import { parseTwilioMessage, TwilioTransportAdapter, type TwilioMediaEvent } from '../src/index.js';

const PORT = parseInt(process.env.PORT || '8080');
const HOST = process.env.HOST || '0.0.0.0';

interface ConnectionState {
  transport: TwilioTransportAdapter;
  streamSid: string;
}

async function main() {
  console.log('[EchoBot] Starting Twilio echo bot...');
  console.log(`[EchoBot] Listening on ws://${HOST}:${PORT}`);

  const wss = new WebSocketServer({ port: PORT, host: HOST });
  const connections = new Map<string, ConnectionState>();

  wss.on('connection', (ws) => {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const transport = new TwilioTransportAdapter({
      id: `twilio-${clientId}`,
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(message);
      },
    });

    const state: ConnectionState = {
      transport,
      streamSid: '',
    };
    connections.set(clientId, state);

    console.log(`[EchoBot] Connected: ${clientId}`);

    ws.on('message', (data: Buffer) => {
      const message = data.toString();
      const event = parseTwilioMessage(message);

      if (!event) {
        console.warn(`[EchoBot] [${clientId}] Invalid JSON event`);
        return;
      }

      if (event.event === 'start') {
        state.streamSid = event.start?.streamSid ?? event.streamSid ?? '';
        console.log(`[EchoBot] [${clientId}] Stream started: ${state.streamSid || '(missing)'}`);
      }

      if (event.event === 'media' && state.streamSid) {
        const media = event as TwilioMediaEvent;
        if (media.media?.payload) {
          ws.send(
            JSON.stringify({
              event: 'media',
              streamSid: state.streamSid,
              sequenceNumber: `${Date.now()}`,
              media: { payload: media.media.payload },
            }),
          );
        }
      }

      if (event.event === 'stop') {
        console.log(`[EchoBot] [${clientId}] Stream stopped`);
      }

      // Keep adapter state in sync for clear/mark and stream lifecycle handling.
      transport.handleMessage(message);
    });

    ws.on('close', () => {
      console.log(`[EchoBot] Closed: ${clientId}`);
      connections.delete(clientId);
      transport.close().catch((err) => {
        console.error('[EchoBot] Error closing transport:', err);
      });
    });

    ws.on('error', (error) => {
      console.error('[EchoBot] WebSocket error:', {
        error: error.message,
        clientId,
      });
    });
  });

  process.on('SIGINT', async () => {
    console.log('[EchoBot] Shutting down...');
    for (const [, state] of connections) {
      await state.transport.close();
    }
    connections.clear();
    wss.close(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error('[EchoBot] Fatal error:', error);
  process.exit(1);
});
