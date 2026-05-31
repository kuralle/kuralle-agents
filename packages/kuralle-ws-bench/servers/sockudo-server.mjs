#!/usr/bin/env node
/**
 * Same protocol as ws-server.mjs but powered by @sockudo/ws.
 *
 * sockudo's API differs from `ws` (Message wrapper, onMessage/onClose
 * callbacks rather than EventEmitter), so this file is a direct port that
 * does the same observable thing: accept, send session_started, echo binary
 * with an 8-byte server-receive timestamp prepended, respond `done` to
 * end_of_audio.
 */

import { WebSocketServer, Message, initRuntime } from '@sockudo/ws';

const PORT = Number(process.env.PORT ?? 9002);
const HOST = process.env.HOST ?? '0.0.0.0';
const WORKER_THREADS = Number(process.env.SOCKUDO_THREADS ?? 0);

initRuntime(WORKER_THREADS); // 0 → use all cores

const server = new WebSocketServer({ port: PORT, host: HOST });

// NAPI quirk in @sockudo/ws@1.6.10: the connection callback is invoked
// with `(null, [WebSocket, ConnectionInfo])` rather than the documented
// `(ws, info)` two-arg shape. Pull the ws out of args[1] when that's the
// case, fall back to args[0] otherwise (in case it gets fixed upstream).
await server.start((...args) => {
  const ws = Array.isArray(args[1])
    ? args[1][0]
    : (args[0] && typeof args[0].send === 'function' ? args[0] : null);
  if (!ws) {
    console.error('[sockudo] connection callback got no ws, args:', args.map((a) => typeof a));
    return;
  }

  ws.send(Message.text(JSON.stringify({ type: 'session_started', t: Date.now() })));

  ws.onMessage((msg) => {
    if (msg.isBinary) {
      const data = msg.asBuffer();
      if (!data) return;
      const stampedFrame = Buffer.alloc(8 + data.length);
      stampedFrame.writeBigUInt64BE(BigInt(Date.now()), 0);
      data.copy(stampedFrame, 8);
      ws.send(Message.binary(stampedFrame));
      return;
    }
    if (msg.isText) {
      try {
        const parsed = JSON.parse(msg.asText());
        if (parsed?.type === 'end_of_audio') {
          ws.send(Message.text(JSON.stringify({ type: 'done', t: Date.now() })));
        }
      } catch {
        // ignore
      }
    }
  });
});

console.log(`[sockudo] listening on ws://${HOST}:${PORT} (worker_threads=${WORKER_THREADS || 'all'})`);
