/**
 * Programmatic SIP UAC (User Agent Client) for testing.
 *
 * Sends SIP INVITE with G.711 SDP, completes dialog setup, exchanges
 * RTP audio, and tears down with BYE. Designed for integration tests
 * against SIPAgentServer — no external dependencies required.
 *
 * Reuses the package's own RtpSession for bidirectional audio and
 * raw SIP message construction matching the existing integration tests.
 */

import dgram from 'node:dgram';
import { RtpSession } from '../rtp/rtp_session.js';
import { PCMU, PCMA, type Codec } from '@kuralle-agents/transport-base/codec/g711';

export interface SIPTestClientOptions {
  localAddress?: string;
  localSipPort?: number;
  localRtpPort?: number;
  codec?: 'PCMU' | 'PCMA';
  callTimeoutMs?: number;
}

export class SIPTestClient {
  private sipSocket: dgram.Socket | null = null;
  private rtpSession: RtpSession | null = null;
  private localAddress: string;
  private localSipPort: number;
  private localRtpPort: number;
  private codecName: 'PCMU' | 'PCMA';
  private codec: Codec;
  private callTimeoutMs: number;
  private _callId: string = '';
  private fromTag: string = '';
  private toTag: string = '';
  private _receivedAudioBytes = 0;
  private _receivedAudioChunks = 0;
  private _isConnected = false;
  private audioHandlers = new Set<(pcm: Int16Array) => void>();
  private closeHandlers = new Set<() => void>();
  private serverHost = '';
  private serverPort = 0;
  private cseq = 1;

  constructor(options: SIPTestClientOptions = {}) {
    this.localAddress = options.localAddress ?? '127.0.0.1';
    this.localSipPort = options.localSipPort ?? 0;
    this.localRtpPort = options.localRtpPort ?? 0;
    this.codecName = options.codec ?? 'PCMU';
    this.codec = this.codecName === 'PCMU' ? PCMU : PCMA;
    this.callTimeoutMs = options.callTimeoutMs ?? 10_000;
  }

  get callId(): string { return this._callId; }
  get receivedAudioBytes(): number { return this._receivedAudioBytes; }
  get receivedAudioChunks(): number { return this._receivedAudioChunks; }
  get isConnected(): boolean { return this._isConnected; }

  /**
   * Establish a SIP call with the server.
   * Sends INVITE, waits for 200 OK, sends ACK, configures RTP.
   */
  async call(serverHost: string, serverPort: number): Promise<void> {
    this.serverHost = serverHost;
    this.serverPort = serverPort;
    this._callId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.fromTag = Math.random().toString(36).slice(2, 12);
    this.cseq = 1;

    // Bind SIP signaling socket
    this.sipSocket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      this.sipSocket!.once('error', reject);
      this.sipSocket!.bind(this.localSipPort, this.localAddress, () => {
        this.sipSocket!.off('error', reject);
        resolve();
      });
    });
    this.localSipPort = this.sipSocket.address().port;

    // Bind RTP session
    // Use a fixed port if specified, or pick a port manually to avoid bind(0) issues
    if (this.localRtpPort === 0) {
      this.localRtpPort = 30000 + Math.floor(Math.random() * 10000);
    }
    this.rtpSession = new RtpSession(this.codec, { localPort: this.localRtpPort });

    // Small delay for the RTP socket to bind
    await new Promise<void>((r) => setTimeout(r, 50));

    // Wire audio reception
    this.rtpSession.on('audio', (pcm: Int16Array) => {
      this._receivedAudioBytes += pcm.byteLength;
      this._receivedAudioChunks++;
      for (const h of this.audioHandlers) {
        try { h(pcm); } catch { /* ignore */ }
      }
    });

    // Build and send INVITE
    const sdp = this.buildSdpOffer();
    const invite = this.buildRequest('INVITE', sdp);
    this.sendSip(invite);

    // Wait for 200 OK
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SIP call timeout after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);

      const onMessage = (data: Buffer) => {
        const raw = data.toString();
        const statusMatch = raw.match(/^SIP\/2\.0\s+(\d+)/);
        if (!statusMatch) return;
        const code = parseInt(statusMatch[1]!, 10);

        if (code >= 100 && code < 200) {
          // Provisional response — continue waiting
          return;
        }

        if (code === 200) {
          clearTimeout(timer);
          this.sipSocket?.off('message', onMessage);

          // Extract To tag
          const toMatch = raw.match(/To:.*?;tag=([^\s;>\r\n]+)/i);
          if (toMatch) this.toTag = toMatch[1]!;

          // Extract remote RTP from SDP
          const cMatch = raw.match(/c=IN\s+IP[46]\s+(\S+)/);
          const mMatch = raw.match(/m=audio\s+(\d+)/);
          if (cMatch && mMatch) {
            this.rtpSession!.setRemote(cMatch[1]!, parseInt(mMatch[1]!, 10));
          }

          // Send ACK
          const ack = this.buildRequest('ACK');
          this.sendSip(ack);

          this._isConnected = true;
          resolve();
          return;
        }

        if (code >= 400) {
          clearTimeout(timer);
          this.sipSocket?.off('message', onMessage);
          reject(new Error(`SIP call rejected with ${code}`));
          return;
        }
      };

      this.sipSocket!.on('message', onMessage);
    });
  }

  /** Register a handler for received audio PCM frames. */
  onAudio(handler: (pcm: Int16Array) => void): void {
    this.audioHandlers.add(handler);
  }

  /** Register a handler for call close (remote BYE or disconnect). */
  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  /**
   * Send PCM audio over RTP at real-time pace.
   * PCM is expected at the codec sample rate (8kHz for G.711).
   */
  async sendAudio(pcm: Int16Array, paceMs = 20): Promise<void> {
    if (!this.rtpSession) throw new Error('Not connected');
    const samplesPerPacket = (this.codec.sampleRate * paceMs) / 1000;

    for (let offset = 0; offset < pcm.length; offset += samplesPerPacket) {
      let chunk = pcm.slice(offset, offset + samplesPerPacket);
      if (chunk.length < samplesPerPacket) {
        const padded = new Int16Array(samplesPerPacket);
        padded.set(chunk);
        chunk = padded;
      }
      this.rtpSession.sendAudio(chunk);
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }

  /** Send silence for the specified duration. */
  async sendSilence(durationMs: number, paceMs = 20): Promise<void> {
    const totalSamples = (this.codec.sampleRate * durationMs) / 1000;
    await this.sendAudio(new Int16Array(totalSamples), paceMs);
  }

  /**
   * Wait until at least one audio chunk is received, then collect
   * for an additional `collectMs` after the first chunk.
   */
  async waitForAudio(timeoutMs = 10000, collectMs = 500): Promise<Int16Array> {
    return new Promise<Int16Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.audioHandlers.delete(handler);
        reject(new Error(`Timeout waiting for audio after ${timeoutMs}ms`));
      }, timeoutMs);

      const chunks: Int16Array[] = [];
      let collecting = false;

      const handler = (pcm: Int16Array): void => {
        chunks.push(new Int16Array(pcm));
        if (!collecting) {
          collecting = true;
          setTimeout(() => {
            clearTimeout(timer);
            this.audioHandlers.delete(handler);
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const merged = new Int16Array(total);
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            resolve(merged);
          }, collectMs);
        }
      };

      this.audioHandlers.add(handler);
    });
  }

  /** Send SIP BYE and wait for 200 OK. */
  async hangup(): Promise<void> {
    if (!this._isConnected) return;
    this._isConnected = false;

    this.cseq++;
    const bye = this.buildRequest('BYE');
    this.sendSip(bye);

    // Wait for 200 OK to BYE (best-effort)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const onMessage = (data: Buffer) => {
        const raw = data.toString();
        if (raw.includes('200 OK') && raw.includes('BYE')) {
          clearTimeout(timer);
          this.sipSocket?.off('message', onMessage);
          resolve();
        }
      };
      this.sipSocket?.on('message', onMessage);
    });
  }

  /** Close all sockets and clean up. */
  close(): void {
    this._isConnected = false;
    if (this.rtpSession) {
      this.rtpSession.close();
      this.rtpSession = null;
    }
    if (this.sipSocket) {
      try { this.sipSocket.close(); } catch { /* already closed */ }
      this.sipSocket = null;
    }
    for (const h of this.closeHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }

  private buildSdpOffer(): string {
    const pt = this.codec.payloadType;
    const codecName = this.codecName;
    return [
      'v=0',
      `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.localAddress}`,
      's=SIPTestClient',
      `c=IN IP4 ${this.localAddress}`,
      't=0 0',
      `m=audio ${this.localRtpPort} RTP/AVP ${pt}`,
      `a=rtpmap:${pt} ${codecName}/${this.codec.sampleRate}`,
      'a=ptime:20',
      'a=sendrecv',
    ].join('\r\n') + '\r\n';
  }

  private buildRequest(method: string, body?: string): string {
    const branch = `z9hG4bK-${Math.random().toString(36).slice(2, 10)}`;
    const cseq = method === 'ACK' ? this.cseq : (method === 'BYE' ? this.cseq : this.cseq);
    const toHeader = this.toTag
      ? `<sip:agent@${this.serverHost}>;tag=${this.toTag}`
      : `<sip:agent@${this.serverHost}>`;

    const lines: string[] = [
      `${method} sip:agent@${this.serverHost}:${this.serverPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localAddress}:${this.localSipPort};branch=${branch};rport`,
      `From: <sip:test@${this.localAddress}>;tag=${this.fromTag}`,
      `To: ${toHeader}`,
      `Call-ID: ${this._callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <sip:test@${this.localAddress}:${this.localSipPort}>`,
      `Max-Forwards: 70`,
    ];

    if (body) {
      lines.push('Content-Type: application/sdp');
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    } else {
      lines.push('Content-Length: 0');
    }

    return lines.join('\r\n') + '\r\n\r\n' + (body ?? '');
  }

  private sendSip(message: string): void {
    if (!this.sipSocket) return;
    const buf = Buffer.from(message);
    this.sipSocket.send(buf, 0, buf.length, this.serverPort, this.serverHost);
  }
}
