/**
 * SIP signaling implementation using node.js-sip as a parser/transport shim.
 *
 * We intentionally construct server-side SIP responses and in-dialog requests
 * ourselves rather than relying on node.js-sip's higher-level UAS helpers.
 * Those helpers assume a different server/auth flow than this package uses,
 * while this transport needs explicit control over provisional responses,
 * pending INVITE cancellation, and dialog-correct BYE generation.
 */

import { createRequire } from 'node:module';
import type { RemoteInfo } from 'node:dgram';
import type { Codec } from '@kuralle-agents/transport-base/codec/g711';
import type { SIPServerOptions } from './types.js';
import {
  buildG711SdpAnswer,
  negotiateG711FromRemoteOffer,
} from './sdp_g711.js';

type NodeJsSipVoipCallback = (data: { type?: string; message?: string }) => void;

type NodeJsSipMessageHandler = (msg: Buffer, rinfo: RemoteInfo) => void;

interface NodeJsSipSocket {
  on(event: 'message', handler: NodeJsSipMessageHandler): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  once?(event: string, handler: () => void): void;
  off?(event: 'message', handler: NodeJsSipMessageHandler): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  close?(): void;
  address?(): { address: string; port: number };
}

type NodeJsSipTransport = {
  socket?: NodeJsSipSocket;
  send?: (message: string, host: string, port: number) => void;
};

export type NodeJsSipVoip = {
  transport?: NodeJsSipTransport;
};

const require = createRequire(import.meta.url);
const VOIP = require('node.js-sip') as new (
  config: { type: string; transport: { type: string; port: number } },
  callback?: NodeJsSipVoipCallback,
) => NodeJsSipVoip;
const SIP = require('node.js-sip/SIP/index.js') as {
  Parser: {
    parse: (raw: string) => IncomingSipMessage;
    ParseHeaders: (headers: Record<string, string>) => ParsedSipHeaders;
  };
  Builder: {
    Build: (message: SipWireMessage) => string;
  };
};

const DEFAULT_SIP_PORT = 5060;
const USER_AGENT = 'kuralle-sip';
const ALLOW_METHODS = 'INVITE, ACK, BYE, CANCEL, OPTIONS';

type RawSipHeaders = Record<string, string>;

interface ParsedContact {
  username?: string | null;
  ip?: string | null;
  port?: string | number | null;
}

interface ParsedSipHeaders {
  Via?: {
    uri?: ParsedContact;
    branch?: string;
  };
  From?: {
    contact?: ParsedContact;
    tag?: string;
  };
  To?: {
    contact?: ParsedContact;
    tag?: string;
  };
  Contact?: {
    contact?: ParsedContact;
    expires?: number;
  };
  CSeq?: {
    count?: string | number;
    method?: string;
  };
  'Call-ID'?: string;
  Allow?: string;
  [key: string]: unknown;
}

interface IncomingSipMessage {
  method?: string;
  statusCode?: number;
  statusText?: string;
  requestUri?: string;
  headers: RawSipHeaders;
  body?: string;
  callId?: string;
}

interface SipWireMessage {
  isResponse: boolean;
  protocol: 'SIP/2.0';
  statusCode?: number;
  statusText?: string;
  method?: string;
  requestUri?: string;
  headers: Record<string, string | number>;
  body: string;
}

interface PendingInvite {
  callId: string;
  rtpPort: number;
  localTag: string;
  localUri: string;
  localContactUri: string;
  remoteUri: string;
  remoteTargetUri: string;
  responseHost: string;
  responsePort: number;
  inviteCseq: number;
  nextLocalCseq: number;
  rawHeaders: RawSipHeaders;
  canceled: boolean;
}

interface ActiveCall {
  callId: string;
  rtpPort: number;
  localTag: string;
  remoteTag: string;
  localUri: string;
  localContactUri: string;
  remoteUri: string;
  remoteTargetUri: string;
  responseHost: string;
  responsePort: number;
  nextLocalCseq: number;
}

/**
 * Callback for incoming INVITE requests.
 *
 * The callback must finish transport/session bootstrap before the final 200 OK
 * is emitted. Throwing rejects the INVITE with a 500 response.
 */
export type OnInviteCallback = (
  callId: string,
  remoteSdp: string,
  rtpPort: number,
  negotiatedCodec: Codec,
) => void | Promise<void>;

/**
 * Callback for call termination (remote BYE, local CANCEL unwind, etc.).
 */
export type OnByeCallback = (callId: string) => void | Promise<void>;

export class SIPSignaling {
  private voip: NodeJsSipVoip | null = null;
  private activeCalls = new Map<string, ActiveCall>();
  private pendingInvites = new Map<string, PendingInvite>();
  private nextRtpPort: number;
  private localAddress: string;
  private localPort: number;
  private g711Preferred: 'PCMU' | 'PCMA';
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private transportMessageListener:
    | ((msg: Buffer, rinfo: RemoteInfo) => void)
    | null = null;

  private static readonly MIN_RTP_PORT = 10000;
  private static readonly MAX_RTP_PORT = 60000;

  private onInviteCallback: OnInviteCallback = () => {};
  private onByeCallback: OnByeCallback = () => {};

  constructor(private options: SIPServerOptions) {
    this.localAddress = options.localAddress;
    this.localPort = options.sipPort ?? DEFAULT_SIP_PORT;
    this.nextRtpPort = options.rtpPortStart ?? 10000;
    this.g711Preferred = options.codec === 'PCMA' ? 'PCMA' : 'PCMU';

    if (options.sipProtocol && options.sipProtocol !== 'udp') {
      throw new Error(
        `[SIPSignaling] sipProtocol="${options.sipProtocol}" is not supported. ` +
          'This transport currently supports UDP only.',
      );
    }
  }

  async start(onInvite: OnInviteCallback, onBye?: OnByeCallback): Promise<void> {
    this.onInviteCallback = onInvite;
    this.onByeCallback = onBye ?? (() => {});

    return new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(
          new Error(
            `[SIPSignaling] Server did not become ready within 10 seconds on ` +
              `${this.localAddress}:${this.localPort}`,
          ),
        );
      }, 10_000);

      this.readyResolve = () => {
        clearTimeout(readyTimeout);
        resolve();
      };

      try {
        this.voip = new VOIP(
          {
            type: 'server',
            transport: {
              type: 'UDP',
              port: this.localPort,
            },
          },
          (data: Parameters<NodeJsSipVoipCallback>[0]) => {
            if (data.type === 'UAS_READY') {
              console.log(
                `[SIPSignaling] UAS_READY - Server ready on ${this.localAddress}:${this.localPort}`,
              );
            }
          },
        );

        if (this.voip?.transport?.socket?.on) {
          const socket = this.voip.transport.socket;
          const markReady = () => {
            if (this.ready) return;
            this.ready = true;
            this.readyResolve?.();
            this.readyResolve = null;
          };
          if (this.isSocketBound(socket)) {
            markReady();
          } else {
            socket.once?.('listening', markReady);
          }

          this.transportMessageListener = (msg: Buffer, rinfo: RemoteInfo) => {
            this.handleTransportMessage(msg.toString(), rinfo).catch((error) => {
              console.error('[SIPSignaling] Unhandled SIP transport error:', error);
            });
          };
          socket.on!('message', this.transportMessageListener);
        }
      } catch (error) {
        clearTimeout(readyTimeout);
        this.readyResolve = null;
        console.error('[SIPSignaling] Error starting VOIP server:', error);
        reject(error);
      }
    });
  }

  private async handleTransportMessage(
    rawMessage: string,
    rinfo: RemoteInfo,
  ): Promise<void> {
    const message = SIP.Parser.parse(rawMessage) as IncomingSipMessage;
    if (!message?.headers) {
      return;
    }
    const callId = this.extractCallId(message);
    const method = message.method?.toUpperCase();

    switch (method) {
      case 'INVITE':
        await this.handleInviteRequest(message, callId, rinfo);
        return;

      case 'BYE':
        await this.handleByeRequest(message, callId, rinfo);
        return;

      case 'CANCEL':
        await this.handleCancelRequest(message, callId, rinfo);
        return;

      case 'OPTIONS':
        this.handleOptionsRequest(message, rinfo);
        return;

      case 'ACK':
        console.log(`[SIPSignaling] ACK received for call: ${callId}`);
        return;

      case 'REGISTER':
        this.handleRegisterRequest(message, rinfo);
        return;

      default:
        console.log(`[SIPSignaling] Event: ${method ?? 'UNKNOWN'}`);
        return;
    }
  }

  private async handleInviteRequest(
    message: IncomingSipMessage,
    callId: string,
    rinfo?: RemoteInfo,
  ): Promise<void> {
    const parsedHeaders = this.parseHeaders(message.headers);
    const responseTarget = this.getResponseTarget(parsedHeaders, rinfo);

    if (!responseTarget) {
      console.warn(
        `[SIPSignaling] INVITE ${callId} missing routable response target; rejecting`,
      );
      this.sendResponse(message, parsedHeaders, 400, 'Bad Request');
      return;
    }

    if (this.activeCalls.has(callId) || this.pendingInvites.has(callId)) {
      console.warn(
        `[SIPSignaling] Call ${callId} already exists, sending 486 Busy Here`,
      );
      this.sendResponse(message, parsedHeaders, 486, 'Busy Here');
      return;
    }

    const remoteSdp = message.body || '';
    const negotiatedCodec = negotiateG711FromRemoteOffer(
      remoteSdp,
      this.g711Preferred,
    );

    const rtpPort = this.allocateRtpPort();
    const localTag = this.generateTag();
    const localUri = this.buildLocalUri(parsedHeaders, message);
    const localContactUri = this.buildLocalContactUri(parsedHeaders);
    const remoteUri = this.extractRemoteUri(message.headers, parsedHeaders);
    const remoteTargetUri = this.extractRemoteTargetUri(message.headers, parsedHeaders);
    const inviteCseq = this.extractCseq(parsedHeaders);

    const pending: PendingInvite = {
      callId,
      rtpPort,
      localTag,
      localUri,
      localContactUri,
      remoteUri,
      remoteTargetUri,
      responseHost: responseTarget.host,
      responsePort: responseTarget.port,
      inviteCseq,
      nextLocalCseq: 0,
      rawHeaders: message.headers,
      canceled: false,
    };

    this.pendingInvites.set(callId, pending);

    const sdpAnswer = buildG711SdpAnswer(
      this.localAddress,
      rtpPort,
      negotiatedCodec,
    ).replace(/^[ \t]+/gm, '');

    console.log(`[SIPSignaling] Received INVITE for call: ${callId}`);

    this.sendResponse(message, parsedHeaders, 100, 'Trying');
    this.sendResponse(message, parsedHeaders, 180, 'Ringing', {
      toHeader: this.ensureTag(message.headers.To ?? '', localTag),
    });

    try {
      await this.onInviteCallback(callId, remoteSdp, rtpPort, negotiatedCodec);
    } catch (error) {
      this.pendingInvites.delete(callId);
      this.sendResponse(message, parsedHeaders, 500, 'Server Internal Error', {
        toHeader: this.ensureTag(message.headers.To ?? '', localTag),
      });
      throw error;
    }

    const current = this.pendingInvites.get(callId);
    if (!current || current.canceled) {
      if (!current) {
        return;
      }
      this.pendingInvites.delete(callId);
      return;
    }

    this.sendResponse(message, parsedHeaders, 200, 'OK', {
      body: sdpAnswer,
      toHeader: this.ensureTag(message.headers.To ?? '', localTag),
      contactUri: localContactUri,
    });

    this.activeCalls.set(callId, {
      callId,
      rtpPort,
      localTag,
      remoteTag: parsedHeaders.From?.tag ?? '',
      localUri,
      localContactUri,
      remoteUri,
      remoteTargetUri,
      responseHost: responseTarget.host,
      responsePort: responseTarget.port,
      nextLocalCseq: current.nextLocalCseq,
    });
    this.pendingInvites.delete(callId);
  }

  private async handleByeRequest(
    message: IncomingSipMessage,
    callId: string,
    rinfo?: RemoteInfo,
  ): Promise<void> {
    const parsedHeaders = this.parseHeaders(message.headers);

    console.log(`[SIPSignaling] Received BYE for call: ${callId}`);

    const call = this.activeCalls.get(callId);
    if (!call) {
      console.warn(`[SIPSignaling] Received BYE for unknown call: ${callId}`);
      this.sendResponse(message, parsedHeaders, 481, 'Call/Transaction Does Not Exist', {
        targetHost: rinfo?.address,
        targetPort: rinfo?.port,
      });
      return;
    }

    this.sendResponse(message, parsedHeaders, 200, 'OK', {
      targetHost: rinfo?.address,
      targetPort: rinfo?.port,
    });
    this.activeCalls.delete(callId);
    await this.onByeCallback(callId);
  }

  private async handleCancelRequest(
    message: IncomingSipMessage,
    callId: string,
    rinfo?: RemoteInfo,
  ): Promise<void> {
    const parsedHeaders = this.parseHeaders(message.headers);
    const pending = this.pendingInvites.get(callId);

    this.sendResponse(message, parsedHeaders, 200, 'OK', {
      targetHost: rinfo?.address,
      targetPort: rinfo?.port,
    });

    if (!pending) {
      console.warn(`[SIPSignaling] CANCEL for unknown or established call: ${callId}`);
      return;
    }

    pending.canceled = true;
    this.pendingInvites.delete(callId);

    const inviteParsed = this.parseHeaders(pending.rawHeaders);
    this.sendResponse(
      {
        headers: pending.rawHeaders,
        body: '',
      },
      inviteParsed,
      487,
      'Request Terminated',
      {
        toHeader: this.ensureTag(pending.rawHeaders.To ?? '', pending.localTag),
        targetHost: pending.responseHost,
        targetPort: pending.responsePort,
        contactUri: pending.localContactUri,
      },
    );

    await this.onByeCallback(callId);
  }

  private handleOptionsRequest(
    message: IncomingSipMessage,
    rinfo?: RemoteInfo,
  ): void {
    const parsedHeaders = this.parseHeaders(message.headers);
    this.sendResponse(message, parsedHeaders, 200, 'OK', {
      headers: {
        Allow: ALLOW_METHODS,
        Accept: 'application/sdp',
      },
      targetHost: rinfo?.address,
      targetPort: rinfo?.port,
    });
  }

  private handleRegisterRequest(
    message: IncomingSipMessage,
    rinfo?: RemoteInfo,
  ): void {
    const parsedHeaders = this.parseHeaders(message.headers);
    this.sendResponse(message, parsedHeaders, 405, 'Method Not Allowed', {
      headers: {
        Allow: ALLOW_METHODS,
      },
      targetHost: rinfo?.address,
      targetPort: rinfo?.port,
    });
  }

  async hangup(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      console.warn(`[SIPSignaling] No active call: ${callId}`);
      return;
    }

    call.nextLocalCseq += 1;

    const branch = this.generateBranch();
    const bye = this.buildRequestMessage({
      method: 'BYE',
      requestUri: call.remoteTargetUri,
      headers: {
        Via: `SIP/2.0/UDP ${this.localAddress}:${this.localPort};branch=${branch};rport`,
        To: this.buildAddressHeader(call.remoteUri, call.remoteTag || undefined),
        From: this.buildAddressHeader(call.localUri, call.localTag),
        'Call-ID': callId,
        CSeq: `${call.nextLocalCseq} BYE`,
        Contact: `<${call.localContactUri}>`,
        'Max-Forwards': '70',
        'User-Agent': USER_AGENT,
        Allow: ALLOW_METHODS,
        'Content-Length': '0',
      },
      body: '',
    });

    this.sendToPeer(bye, call.responseHost, call.responsePort);
    this.activeCalls.delete(callId);
    console.log(`[SIPSignaling] Sent BYE for call: ${callId}`);
  }

  async stop(): Promise<void> {
    if (this.voip) {
      for (const callId of this.activeCalls.keys()) {
        try {
          await this.hangup(callId);
        } catch (error) {
          console.error(
            `[SIPSignaling] Error hanging up ${callId} during shutdown:`,
            error,
          );
        }
      }

      const transportSocket = this.voip.transport?.socket;
      if (
        this.transportMessageListener &&
        transportSocket &&
        typeof transportSocket.off === 'function'
      ) {
        transportSocket.off('message', this.transportMessageListener);
        this.transportMessageListener = null;
      }
      if (transportSocket && typeof transportSocket.close === 'function') {
        try {
          transportSocket.close();
        } catch (error) {
          console.error('[SIPSignaling] Error closing SIP transport socket:', error);
        }
      }
      this.voip = null;
    }
    this.activeCalls.clear();
    this.pendingInvites.clear();
    this.ready = false;
    console.log('[SIPSignaling] Stopped');
  }

  getRtpPort(callId: string): number | undefined {
    return this.activeCalls.get(callId)?.rtpPort ?? this.pendingInvites.get(callId)?.rtpPort;
  }

  private sendResponse(
    message: IncomingSipMessage,
    parsedHeaders: ParsedSipHeaders,
    statusCode: number,
    statusText: string,
    options?: {
      body?: string;
      toHeader?: string;
      headers?: Record<string, string>;
      targetHost?: string;
      targetPort?: number;
      contactUri?: string;
    },
  ): void {
    const responseTarget =
      options?.targetHost && options?.targetPort
        ? { host: options.targetHost, port: options.targetPort }
        : this.getResponseTarget(parsedHeaders);

    if (!responseTarget) {
      console.warn(
        `[SIPSignaling] Cannot send ${statusCode} ${statusText}; missing response target`,
      );
      return;
    }

    const body = options?.body ?? '';
    const wire = this.buildResponseMessage({
      statusCode,
      statusText,
      rawHeaders: message.headers,
      parsedHeaders,
      body,
      toHeader:
        options?.toHeader ??
        message.headers.To ??
        this.buildAddressHeader(this.buildLocalUri(parsedHeaders, message)),
      contactUri: options?.contactUri,
      extraHeaders: options?.headers,
    });

    this.sendToPeer(wire, responseTarget.host, responseTarget.port);
  }

  private buildResponseMessage(args: {
    statusCode: number;
    statusText: string;
    rawHeaders: RawSipHeaders;
    parsedHeaders: ParsedSipHeaders;
    body: string;
    toHeader: string;
    contactUri?: string;
    extraHeaders?: Record<string, string>;
  }): SipWireMessage {
    const headers: Record<string, string | number> = {
      Via: args.rawHeaders.Via ?? '',
      To: args.toHeader,
      From: args.rawHeaders.From ?? '',
      'Call-ID': args.rawHeaders['Call-ID'] ?? '',
      CSeq: args.rawHeaders.CSeq ?? '',
      Contact: `<${args.contactUri ?? this.buildLocalContactUri(args.parsedHeaders)}>`,
      'Max-Forwards': '70',
      'User-Agent': USER_AGENT,
      Allow: ALLOW_METHODS,
    };

    if (args.extraHeaders) {
      for (const [key, value] of Object.entries(args.extraHeaders)) {
        headers[key] = value;
      }
    }

    if (args.body) {
      headers['Content-Type'] = 'application/sdp';
      headers['Content-Length'] = String(args.body.length);
    } else {
      headers['Content-Length'] = '0';
    }

    return {
      isResponse: true,
      protocol: 'SIP/2.0',
      statusCode: args.statusCode,
      statusText: args.statusText,
      headers,
      body: args.body,
    };
  }

  private buildRequestMessage(args: {
    method: string;
    requestUri: string;
    headers: Record<string, string | number>;
    body: string;
  }): SipWireMessage {
    return {
      isResponse: false,
      protocol: 'SIP/2.0',
      method: args.method,
      requestUri: args.requestUri,
      headers: args.headers,
      body: args.body,
    };
  }

  private sendToPeer(message: SipWireMessage, host: string, port: number): void {
    if (!this.voip?.transport?.send) {
      throw new Error('[SIPSignaling] transport.send is unavailable');
    }
    const built = SIP.Builder.Build(message);
    this.voip.transport.send(built, host, port);
  }

  private allocateRtpPort(): number {
    const rtpPort = this.nextRtpPort;
    this.nextRtpPort += 2;
    if (this.nextRtpPort >= SIPSignaling.MAX_RTP_PORT) {
      this.nextRtpPort = SIPSignaling.MIN_RTP_PORT;
      console.warn(
        '[SIPSignaling] RTP port range exhausted, wrapping around to',
        this.nextRtpPort,
      );
    }
    return rtpPort;
  }

  private parseHeaders(headers: RawSipHeaders): ParsedSipHeaders {
    return SIP.Parser.ParseHeaders(headers);
  }

  private isSocketBound(socket: { address?: () => unknown }): boolean {
    if (typeof socket.address !== 'function') {
      return false;
    }
    try {
      socket.address();
      return true;
    } catch {
      return false;
    }
  }

  private getResponseTarget(
    parsedHeaders: ParsedSipHeaders,
    rinfo?: RemoteInfo,
  ): { host: string; port: number } | null {
    if (rinfo?.address && rinfo?.port) {
      return { host: rinfo.address, port: rinfo.port };
    }

    const contactHost = parsedHeaders.Contact?.contact?.ip;
    const contactPort = this.toPort(parsedHeaders.Contact?.contact?.port);
    if (contactHost && contactPort) {
      return { host: contactHost, port: contactPort };
    }

    const viaHost = parsedHeaders.Via?.uri?.ip;
    const viaPort = this.toPort(parsedHeaders.Via?.uri?.port) ?? DEFAULT_SIP_PORT;
    if (viaHost) {
      return { host: viaHost, port: viaPort };
    }

    return null;
  }

  private extractCallId(message: IncomingSipMessage): string {
    if (message.callId) return message.callId;
    if (typeof message.headers['Call-ID'] === 'string') return message.headers['Call-ID'];

    const parsedHeaders = this.parseHeaders(message.headers);
    if (parsedHeaders['Call-ID']) return parsedHeaders['Call-ID'];

    return `call-${Date.now()}`;
  }

  private extractCseq(parsedHeaders: ParsedSipHeaders): number {
    const count = parsedHeaders.CSeq?.count;
    if (typeof count === 'number') return count;
    if (typeof count === 'string') {
      const parsed = parseInt(count, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }

  private buildLocalUri(
    parsedHeaders: ParsedSipHeaders,
    message?: IncomingSipMessage,
  ): string {
    const requestUri =
      message?.requestUri ??
      this.extractHeaderUri(message?.headers?.To) ??
      undefined;
    if (requestUri) {
      return this.normalizeSipUri(requestUri);
    }

    const user = parsedHeaders.To?.contact?.username ?? 'agent';
    return `sip:${user}@${this.localAddress}`;
  }

  private buildLocalContactUri(parsedHeaders: ParsedSipHeaders): string {
    const user = parsedHeaders.To?.contact?.username ?? 'agent';
    return `sip:${user}@${this.localAddress}:${this.localPort}`;
  }

  private extractRemoteUri(
    rawHeaders: RawSipHeaders,
    parsedHeaders: ParsedSipHeaders,
  ): string {
    return (
      this.normalizeSipUri(this.extractHeaderUri(rawHeaders.From)) ??
      this.buildFallbackRemoteUri(parsedHeaders)
    );
  }

  private extractRemoteTargetUri(
    rawHeaders: RawSipHeaders,
    parsedHeaders: ParsedSipHeaders,
  ): string {
    return (
      this.normalizeSipUri(this.extractHeaderUri(rawHeaders.Contact)) ??
      this.normalizeSipUri(this.extractHeaderUri(rawHeaders.From)) ??
      this.buildFallbackRemoteUri(parsedHeaders)
    );
  }

  private buildFallbackRemoteUri(parsedHeaders: ParsedSipHeaders): string {
    const username = parsedHeaders.From?.contact?.username ?? 'unknown';
    const host = parsedHeaders.Contact?.contact?.ip ?? parsedHeaders.Via?.uri?.ip ?? 'unknown';
    const port = this.toPort(parsedHeaders.Contact?.contact?.port);
    return port ? `sip:${username}@${host}:${port}` : `sip:${username}@${host}`;
  }

  private extractHeaderUri(value?: string): string | null {
    if (!value) return null;
    const angleMatch = value.match(/<([^>]+)>/);
    if (angleMatch?.[1]) return angleMatch[1].trim();
    const sipMatch = value.match(/sip:[^;\s]+/i);
    if (sipMatch?.[0]) return sipMatch[0].trim();
    return null;
  }

  private normalizeSipUri(uri?: string | null): string {
    if (!uri) {
      return `sip:unknown@${this.localAddress}`;
    }
    return uri.trim();
  }

  private buildAddressHeader(uri: string, tag?: string): string {
    return tag ? `<${uri}>;tag=${tag}` : `<${uri}>`;
  }

  private ensureTag(headerValue: string, tag: string): string {
    if (!headerValue) {
      return this.buildAddressHeader(`sip:agent@${this.localAddress}`, tag);
    }
    if (/(^|;)tag=/i.test(headerValue)) {
      return headerValue;
    }
    return `${headerValue};tag=${tag}`;
  }

  private toPort(value: string | number | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  private generateTag(): string {
    return Math.random().toString(36).slice(2, 12);
  }

  private generateBranch(): string {
    return `z9hG4bK${Math.random().toString(36).slice(2, 12)}`;
  }
}
