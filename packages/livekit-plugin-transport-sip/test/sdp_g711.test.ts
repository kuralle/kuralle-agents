import { describe, expect, it } from 'bun:test';
import { PCMU, PCMA } from '@kuralle-agents/transport-base/codec/g711';
import {
  buildG711SdpAnswer,
  negotiateG711FromRemoteOffer,
} from '../src/sdp_g711.js';

describe('sdp_g711 negotiation', () => {
  it('uses the only listed G.711 codec', () => {
    expect(
      negotiateG711FromRemoteOffer('m=audio 1234 RTP/AVP 8\r\n', 'PCMU'),
    ).toBe(PCMA);
    expect(
      negotiateG711FromRemoteOffer('m=audio 1234 RTP/AVP 0\r\n', 'PCMA'),
    ).toBe(PCMU);
  });

  it('when both 0 and 8 are offered, uses server fallback preference', () => {
    const remote08 = 'm=audio 1234 RTP/AVP 0 8\r\n';
    expect(negotiateG711FromRemoteOffer(remote08, 'PCMA')).toBe(PCMA);
    expect(negotiateG711FromRemoteOffer(remote08, 'PCMU')).toBe(PCMU);

    const remote80 = 'm=audio 1234 RTP/AVP 8 0\r\n';
    expect(negotiateG711FromRemoteOffer(remote80, 'PCMU')).toBe(PCMU);
    expect(negotiateG711FromRemoteOffer(remote80, 'PCMA')).toBe(PCMA);
  });

  it('answer SDP lists single payload type', () => {
    const sdp = buildG711SdpAnswer('10.0.0.1', 10000, PCMA);
    expect(sdp).toContain('m=audio 10000 RTP/AVP 8');
    expect(sdp).toContain('a=rtpmap:8 PCMA/8000');
    expect(sdp).not.toContain('RTP/AVP 0 8');
  });
});
