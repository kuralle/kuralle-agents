import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  parseRtpPacket,
  buildRtpPacket,
  type RtpPacket,
} from './rtp_packet.js';
import { JitterBuffer } from './jitter_buffer.js';
import {
  PCMU,
  PCMA,
  type Codec,
} from '@kuralle-agents/transport-base/codec/g711';

export interface RtpSessionOptions {
  localPort: number;
  jitterDepth?: number;
  packetDurationMs?: number;
  /**
   * When true, outbound RTP is clocked at `packetDurationMs` (default 20ms)
   * regardless of application timing: queue drains one frame per tick; idle
   * ticks send codec-encoded silence. Default false preserves immediate
   * `sendAudio` behavior.
   */
  continuousPacing?: boolean;
}

/**
 * Manages a bidirectional RTP stream over UDP.
 *
 * Inbound: receives UDP datagrams, parses RTP, passes through jitter buffer,
 * decodes with codec selected by RTP payload type (PCMU=0, PCMA=8), emits
 * 'audio' events with PCM Int16Array data.
 *
 * Outbound: accepts PCM Int16Array, encodes with the negotiated outbound
 * codec, builds RTP packets, sends as UDP datagrams.
 */
export class RtpSession extends EventEmitter {
  private socket: dgram.Socket;
  private jitterBuffer: JitterBuffer;
  private outboundCodec: Codec;

  private sendSequenceNumber: number = 0;
  private sendTimestamp: number = 0;
  private sendSsrc: number;
  private remoteAddress: string = '';
  private remotePort: number = 0;

  private samplesPerPacket: number;
  private packetDurationMs: number;

  private continuousPacing: boolean;
  private pacedQueue: Int16Array[] = [];
  private pacePending: Int16Array = new Int16Array(0);
  private paceTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPaceTime: number = 0;

  constructor(codec: Codec, options: RtpSessionOptions) {
    super();

    this.outboundCodec = codec;
    this.jitterBuffer = new JitterBuffer(options.jitterDepth ?? 3);
    this.sendSsrc = Math.floor(Math.random() * 0xffffffff);

    this.packetDurationMs = options.packetDurationMs ?? 20;
    this.samplesPerPacket =
      (codec.sampleRate * this.packetDurationMs) / 1000;

    this.continuousPacing = options.continuousPacing === true;

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      if (!this.remoteAddress) {
        this.remoteAddress = rinfo.address;
        this.remotePort = rinfo.port;
      }

      const packet = parseRtpPacket(msg);
      if (!packet) return;

      this.jitterBuffer.push(packet);

      let buffered: RtpPacket | null;
      while ((buffered = this.jitterBuffer.pull()) !== null) {
        const pcm = this.decodeByPayloadType(
          buffered.payloadType,
          buffered.payload,
        );
        this.emit('audio', pcm);
      }
    });

    this.socket.on('error', (err) => {
      console.error('[RtpSession] UDP socket error:', err.message);
    });

    this.socket.bind(options.localPort);

    if (this.continuousPacing) {
      // First `schedulePaceTick` advances by one `packetDurationMs`; start from "now"
      // so the initial delay is exactly one frame (not two).
      this.nextPaceTime = performance.now();
      this.schedulePaceTick();
    }
  }

  private decodeByPayloadType(
    payloadType: number,
    payload: Uint8Array,
  ): Int16Array {
    if (payloadType === PCMU.payloadType) {
      return PCMU.decode(payload);
    }
    if (payloadType === PCMA.payloadType) {
      return PCMA.decode(payload);
    }
    return this.outboundCodec.decode(payload);
  }

  setRemote(address: string, port: number): void {
    this.remoteAddress = address;
    this.remotePort = port;
  }

  private sendRtpPayload(encoded: Uint8Array, samplesThisPacket: number): void {
    if (!this.remoteAddress || !this.remotePort) return;

    const packet = buildRtpPacket(
      this.outboundCodec.payloadType,
      this.sendSequenceNumber,
      this.sendTimestamp,
      this.sendSsrc,
      encoded,
      this.sendSequenceNumber === 0,
    );

    this.socket.send(packet, this.remotePort, this.remoteAddress);

    this.sendSequenceNumber = (this.sendSequenceNumber + 1) & 0xffff;
    this.sendTimestamp =
      (this.sendTimestamp + samplesThisPacket) >>> 0;
  }

  /**
   * Append PCM to the paced buffer and queue full 20ms (or packetDurationMs) frames.
   */
  private enqueuePacedPcm(pcm: Int16Array): void {
    const merged =
      this.pacePending.length === 0
        ? pcm
        : concatInt16(this.pacePending, pcm);

    let offset = 0;
    while (offset + this.samplesPerPacket <= merged.length) {
      this.pacedQueue.push(
        merged.subarray(offset, offset + this.samplesPerPacket),
      );
      offset += this.samplesPerPacket;
    }
    this.pacePending =
      offset === merged.length
        ? new Int16Array(0)
        : merged.subarray(offset);
  }

  private runPacedTick(): void {
    if (!this.remoteAddress || !this.remotePort) {
      return;
    }

    const pcm =
      this.pacedQueue.length > 0
        ? this.pacedQueue.shift()!
        : new Int16Array(this.samplesPerPacket);

    const encoded = this.outboundCodec.encode(pcm);
    this.sendRtpPayload(encoded, pcm.length);
  }

  private schedulePaceTick(): void {
    const now = performance.now();
    const drift = now - this.nextPaceTime;
    if (drift > 2 * this.packetDurationMs) {
      this.nextPaceTime = now + this.packetDurationMs;
    } else {
      this.nextPaceTime += this.packetDurationMs;
    }
    const delay = Math.max(0, this.nextPaceTime - performance.now());

    this.paceTimer = setTimeout(() => {
      this.paceTimer = null;
      this.runPacedTick();
      this.schedulePaceTick();
    }, delay);
  }

  sendAudio(pcm: Int16Array): void {
    if (this.continuousPacing) {
      this.enqueuePacedPcm(pcm);
      return;
    }

    const encoded = this.outboundCodec.encode(pcm);
    this.sendRtpPayload(encoded, this.samplesPerPacket);
  }

  close(): void {
    if (this.paceTimer !== null) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
    this.pacedQueue = [];
    this.pacePending = new Int16Array(0);
    try {
      this.socket.close();
    } catch {
      // Already closed
    }
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
