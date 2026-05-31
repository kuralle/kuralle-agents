/**
 * RTP packet parser and builder (RFC 3550).
 *
 * For G.711 at 8000 Hz with 20ms packets:
 *   Payload: 160 bytes (160 samples * 1 byte per G.711 sample)
 *   Timestamp increment: 160 per packet
 *   Total: 12 (header) + 160 (payload) = 172 bytes
 */

export interface RtpPacket {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

export function parseRtpPacket(data: Buffer): RtpPacket | null {
  if (data.length < 12) return null;

  const firstByte = data[0];
  const version = (firstByte >> 6) & 0x03;
  if (version !== 2) return null;

  const padding = ((firstByte >> 5) & 0x01) === 1;
  const extension = ((firstByte >> 4) & 0x01) === 1;
  const csrcCount = firstByte & 0x0f;

  const secondByte = data[1];
  const marker = ((secondByte >> 7) & 0x01) === 1;
  const payloadType = secondByte & 0x7f;

  const sequenceNumber = data.readUInt16BE(2);
  const timestamp = data.readUInt32BE(4);
  const ssrc = data.readUInt32BE(8);

  const headerLength = 12 + csrcCount * 4;

  let payloadOffset = headerLength;
  if (extension && data.length > headerLength + 4) {
    const extensionLength = data.readUInt16BE(headerLength + 2);
    payloadOffset = headerLength + 4 + extensionLength * 4;
  }

  if (payloadOffset >= data.length) return null;

  let payloadLength = data.length - payloadOffset;
  if (padding && payloadLength > 0) {
    const paddingLength = data[data.length - 1];
    payloadLength -= paddingLength;
  }

  if (payloadLength <= 0) return null;

  const payload = new Uint8Array(
    data.buffer,
    data.byteOffset + payloadOffset,
    payloadLength,
  );

  return {
    version,
    padding,
    extension,
    csrcCount,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload,
  };
}

export function buildRtpPacket(
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  ssrc: number,
  payload: Uint8Array,
  marker: boolean = false,
): Buffer {
  const header = Buffer.alloc(12);

  header[0] = 0x80; // Version=2
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  return Buffer.concat([header, Buffer.from(payload)]);
}
