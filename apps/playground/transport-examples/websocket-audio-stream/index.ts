/**
 * Text-over-WebSocket Agent (Direct Runtime)
 *
 * This example connects a WebSocket directly to Kuralle's Runtime.stream()
 * with no voice pipeline (no STT, TTS, VAD, or LiveKit dependencies).
 *
 * Usage:
 *   bun run websocket-audio-stream
 *
 * Client Protocol:
 *   Send: {"type": "user_text", "text": "Hello!"}
 *   Receive: {"type": "session_started", "sessionId": "..."}
 *   Receive: {"type": "text-delta", "text": "..."}
 *   Receive: {"type": "tool-call", "toolName": "...", "args": {...}}
 *   Receive: {"type": "tool-result", "toolName": "...", "result": {...}}
 *   Receive: {"type": "done", "sessionId": "..."}
 *   Receive: {"type": "error", "error": "..."}
 *
 * Test with the included test client:
 *   bun run test-client
 */

import { WebSocketServer, WebSocket } from 'ws';
import { openai } from '@ai-sdk/openai';
import { buildSupportRuntime } from '../support-agent/index.js';

const PORT = 8080;
const HOST = '0.0.0.0';

const runtime = buildSupportRuntime(openai('gpt-4o-mini'));

// WebSocket server
const wss = new WebSocketServer({ port: PORT, host: HOST });
const activeAbortControllers = new Map<string, AbortController>();

wss.on('connection', async (ws: WebSocket, req) => {
  const url = req.url || '/';
  const match = url.match(/\/ws\/([^\/]+)/);
  const sessionId = match ? match[1] : crypto.randomUUID();

  console.log(`[${sessionId}] Client connected`);

  ws.send(JSON.stringify({ type: 'session_started', sessionId }));

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type !== 'user_text' || !msg.text) {
        ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
        return;
      }

      console.log(`[${sessionId}] User: ${msg.text}`);

      // Abort any in-flight generation for this session
      activeAbortControllers.get(sessionId)?.abort();

      const abortController = new AbortController();
      activeAbortControllers.set(sessionId, abortController);

      try {
        const handle = runtime.stream({
          input: msg.text,
          sessionId,
          abortSignal: abortController.signal,
        });

        for await (const part of handle.events) {
          if (ws.readyState !== WebSocket.OPEN) break;

          // Forward all stream parts directly — the Runtime protocol IS the WS protocol
          ws.send(JSON.stringify(part));
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        const error = err instanceof Error ? err.message : 'Stream failed';
        console.error(`[${sessionId}] Stream error:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', error }));
        }
      } finally {
        if (activeAbortControllers.get(sessionId) === abortController) {
          activeAbortControllers.delete(sessionId);
        }
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] Client disconnected`);
    activeAbortControllers.get(sessionId)?.abort();
    activeAbortControllers.delete(sessionId);
  });

  ws.on('error', (error: Error) => {
    console.error(`[${sessionId}] WebSocket error:`, error);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  for (const [id, controller] of activeAbortControllers) {
    console.log(`Aborting session: ${id}`);
    controller.abort();
  }
  activeAbortControllers.clear();
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

console.log(`Text WebSocket Agent listening on ws://${HOST}:${PORT}`);
console.log('');
console.log('Endpoint: ws://localhost:8080/ws/<session-id>');
console.log('');
console.log('Protocol:');
console.log('  Send:    {"type":"user_text","text":"Your message"}');
console.log('  Receive: {"type":"text-delta","text":"..."}');
console.log('  Receive: {"type":"tool-call","toolName":"...","args":{...}}');
console.log('  Receive: {"type":"done","sessionId":"..."}');
console.log('');
console.log('Test with: bun run test-client');
