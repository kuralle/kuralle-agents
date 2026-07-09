import { describe, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { runTransportContract } from '@kuralle-agents/transport-base';
import { SIPTransportAdapter } from '../src/transport_adapter.js';
import { RtpSession } from '../src/rtp/rtp_session.js';
import { PCMU } from '@kuralle-agents/transport-base/codec/g711';

initializeLogger({ pretty: false, level: 'error' });

describe('SIPTransportAdapter — transport contract', () => {
  it('honors the transport-base contract', async () => {
    const rtp = new RtpSession(PCMU, { localPort: 0 });
    try {
      await runTransportContract(
        () =>
          new SIPTransportAdapter(rtp, PCMU, {
            id: 'sip-contract-test',
            outputSampleRate: 24000,
          }),
      );
    } finally {
      // RtpSession is closed transitively via SIPTransportAdapter.onClose
    }
  });
});
