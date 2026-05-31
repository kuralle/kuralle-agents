#!/usr/bin/env node
/**
 * Reference server using Node `ws` package.
 *
 * Protocol matches what Kuralle's WebSocketAgentServer does at the byte level:
 *   - Accept WS connection.
 *   - First frame: send `{type:"session_started", t:<server-ts>}` JSON.
 *   - On each binary frame: echo it straight back (simulates a TTS frame).
 *   - On `{type:"end_of_audio"}` JSON: send a final `{type:"done"}` JSON.
 *
 * The server stamps a server-receive timestamp into each echo by prepending
 * 8 bytes of big-endian millisecond timestamp BEFORE the original payload.
 * The client uses that to compute one-way latency to the server.
 */

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 9001);
const HOST = process.env.HOST ?? '0.0.0.0';

const wss = new WebSocketServer({ port: PORT, host: HOST });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'session_started', t: Date.now() }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const stampedFrame = Buffer.alloc(8 + data.length);
      stampedFrame.writeBigUInt64BE(BigInt(Date.now()), 0);
      data.copy(stampedFrame, 8);
      ws.send(stampedFrame, { binary: true });
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'end_of_audio') {
        ws.send(JSON.stringify({ type: 'done', t: Date.now() }));
      }
    } catch {
      // ignore
    }
  });

  ws.on('error', () => {});
});

wss.on('listening', () => {
  console.log(`[ws] listening on ws://${HOST}:${PORT}`);
});
