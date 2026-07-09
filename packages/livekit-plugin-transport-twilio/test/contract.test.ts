import { describe, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { runTransportContract } from '@kuralle-agents/transport-base';
import { TwilioTransportAdapter } from '../src/transport_adapter.js';

initializeLogger({ pretty: false, level: 'error' });

describe('TwilioTransportAdapter — transport contract', () => {
  it('honors the transport-base contract', async () => {
    await runTransportContract(
      () =>
        new TwilioTransportAdapter({
          send: () => {},
        }),
    );
  });
});
