import type { RtpPacket } from './rtp_packet.js';

/**
 * Simple jitter buffer that reorders RTP packets by sequence number.
 *
 * Fixed depth (default 3 packets = 60ms at 20ms/packet).
 * Late packets are dropped. Missing packets cause the buffer to skip ahead
 * when it reaches max depth.
 */
export class JitterBuffer {
  private buffer: Map<number, RtpPacket> = new Map();
  private lastDeliveredSeq: number = -1;
  private nextExpectedSeq: number = -1;
  private maxDepth: number;

  constructor(maxDepth: number = 3) {
    this.maxDepth = maxDepth;
  }

  push(packet: RtpPacket): void {
    if (
      this.lastDeliveredSeq >= 0 &&
      this.isOlder(packet.sequenceNumber, this.lastDeliveredSeq)
    ) {
      return; // Late packet, drop
    }

    this.buffer.set(packet.sequenceNumber, packet);

    if (this.nextExpectedSeq < 0) {
      this.nextExpectedSeq = packet.sequenceNumber;
    }
  }

  pull(): RtpPacket | null {
    if (this.buffer.has(this.nextExpectedSeq)) {
      const packet = this.buffer.get(this.nextExpectedSeq)!;
      this.buffer.delete(this.nextExpectedSeq);
      this.lastDeliveredSeq = this.nextExpectedSeq;
      this.nextExpectedSeq = (this.nextExpectedSeq + 1) & 0xffff;
      return packet;
    }

    // Buffer full -- skip to oldest available
    if (this.buffer.size >= this.maxDepth) {
      const sorted = Array.from(this.buffer.keys()).sort((a, b) =>
        this.isOlder(a, b) ? -1 : 1,
      );

      const oldestSeq = sorted[0];
      const packet = this.buffer.get(oldestSeq)!;
      this.buffer.delete(oldestSeq);
      this.lastDeliveredSeq = oldestSeq;
      this.nextExpectedSeq = (oldestSeq + 1) & 0xffff;
      return packet;
    }

    return null;
  }

  private isOlder(a: number, b: number): boolean {
    const diff = (b - a) & 0xffff;
    return diff > 0 && diff < 0x8000;
  }
}
