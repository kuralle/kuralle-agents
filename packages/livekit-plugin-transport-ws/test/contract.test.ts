import { describe, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { runTransportContract } from '@kuralle-agents/transport-base';
import { EventEmitter } from 'node:events';
import { WebSocketTransportAdapter } from '../src/transport_adapter.js';
import type { WebSocket } from 'ws';

initializeLogger({ pretty: false, level: 'error' });

class FakeWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  OPEN = 1;
  sent: unknown[] = [];
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3; // CLOSED
  }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  // @ts-expect-error — test-only cast; FakeWebSocket is a partial WebSocket mock
  return socket as WebSocket;
}

describe('WebSocketTransportAdapter — transport contract', () => {
  it('honors the transport-base contract', async () => {
    await runTransportContract(
      () => new WebSocketTransportAdapter(asWebSocket(new FakeWebSocket())),
    );
  });
});
