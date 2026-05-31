/**
 * G.711 (PCMU/PCMA) SDP negotiation for SIP UAS answers.
 *
 * Parses the remote offer’s m=audio payload type list (preference order).
 * PT 0 and PT 8 are the static assignments for PCMU and PCMA (RFC 3551).
 */
import { PCMU, PCMA, type Codec } from '@kuralle-agents/transport-base/codec/g711';

function parseAudioPayloadTypesFromMLine(remoteSdp: string): number[] {
  const lines = remoteSdp.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^m=audio\s+\d+\s+\S+\s+(.+)$/i);
    if (!m) continue;
    return m[1]
      .trim()
      .split(/\s+/)
      .map((t) => parseInt(t, 10))
      .filter((n) => !Number.isNaN(n));
  }
  return [];
}

function codecFromStaticPt(pt: number): Codec | null {
  if (pt === 0) return PCMU;
  if (pt === 8) return PCMA;
  return null;
}

/**
 * Choose G.711 codec for this call from the remote SDP offer.
 * Respects remote m= line preference order; if both PCMU and PCMA are offered,
 * uses `fallback` (server preferred codec) when that codec appears in the offer.
 */
export function negotiateG711FromRemoteOffer(
  remoteSdp: string,
  fallback: 'PCMU' | 'PCMA',
): Codec {
  fallback = fallback === 'PCMA' ? 'PCMA' : 'PCMU';
  const mPts = parseAudioPayloadTypesFromMLine(remoteSdp);
  const fallbackCodec = fallback === 'PCMA' ? PCMA : PCMU;

  const g711InOrder: Codec[] = [];
  for (const pt of mPts) {
    const c = codecFromStaticPt(pt);
    if (c && !g711InOrder.some((x) => x.payloadType === c.payloadType)) {
      g711InOrder.push(c);
    }
  }

  if (g711InOrder.length === 0) return fallbackCodec;
  if (g711InOrder.length === 1) return g711InOrder[0]!;

  const preferred = fallbackCodec;
  if (g711InOrder.some((c) => c.payloadType === preferred.payloadType)) {
    return preferred;
  }
  return g711InOrder[0]!;
}

/**
 * SDP answer body advertising a single negotiated G.711 codec (RFC 3264).
 */
export function buildG711SdpAnswer(
  localAddress: string,
  rtpPort: number,
  codec: Codec,
): string {
  const pt = codec.payloadType;
  const rtpmapLine =
    codec.payloadType === 0
      ? `a=rtpmap:0 PCMU/8000\r\n`
      : `a=rtpmap:8 PCMA/8000\r\n`;

  return (
    `v=0\r\n` +
    `o=- ${Date.now()} ${Date.now()} IN IP4 ${localAddress}\r\n` +
    `s=Kuralle Voice Agent\r\n` +
    `c=IN IP4 ${localAddress}\r\n` +
    `t=0 0\r\n` +
    `m=audio ${rtpPort} RTP/AVP ${pt}\r\n` +
    rtpmapLine +
    `a=fmtp:${pt}\r\n` +
    `a=ptime:20\r\n` +
    `a=sendrecv\r\n`
  );
}
