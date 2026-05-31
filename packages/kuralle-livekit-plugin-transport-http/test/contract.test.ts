import { describe, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { runTransportContract } from '@kuralle-agents/transport-base';
import { HTTPTransportAdapter } from '../src/transport_adapter.js';

initializeLogger({ pretty: false, level: 'error' });

describe('HTTPTransportAdapter — transport contract', () => {
  it('honors the transport-base contract', async () => {
    // Very long timeout so the auto-close timer does not race with the test.
    await runTransportContract(
      () => new HTTPTransportAdapter({ sessionTimeout: 60_000 }),
    );
  });
});
