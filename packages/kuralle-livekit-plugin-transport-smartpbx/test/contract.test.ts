import { describe, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { runTransportContract } from '@kuralle-agents/transport-base';
import { SmartPBXTransportAdapter } from '../src/transport_adapter.js';
import type { SmartPBXSocketLike, SmartPBXSessionState } from '../src/types.js';

initializeLogger({ pretty: false, level: 'error' });

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements SmartPBXSocketLike {
  readyState = OPEN;
  sent: unknown[] = [];
  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
  }
}

describe('SmartPBXTransportAdapter — transport contract', () => {
  it('honors the transport-base contract (adapter retains bespoke shape)', async () => {
    const socket = new FakeSocket();
    const session: SmartPBXSessionState = { callId: 'contract-call', accountId: 'acct-1', isActive: true };

    await runTransportContract(
      () =>
        new SmartPBXTransportAdapter({
          socket,
          session,
          websocketOpenState: OPEN,
          sampleRate: 16000,
        }),
      {
        // SmartPBX's TransportAdapter is not migrated onto TransportAdapterBase
        // (its isOpen is a computed predicate bound to session state) — see
        // commit message for details. The contract harness still validates the
        // public I/O surface.
        label: 'SmartPBXTransportAdapter',
      },
    );

    // After harness close, mark session inactive so isOpen reads false.
    session.isActive = false;
    socket.readyState = CLOSED;
  });
});
