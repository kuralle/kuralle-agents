/**
 * SIP transport type.
 */
export type SIPTransport = 'udp' | 'websocket';

/**
 * Configuration options for SIP server.
 */
export interface SIPServerOptions {
  /**
   * Transport type:
   * - 'udp': production RTP telephony in this package
   * - 'websocket': deprecated here, use @kuralle/livekit-plugin-transport-sip-jssip
   * Default: 'udp'
   */
  transport?: SIPTransport;

  /** Port for SIP signaling (UDP transport). Default: 5060. */
  sipPort?: number;

  /** Protocol for UDP transport ('udp' or 'tcp'). Default: 'udp'. */
  sipProtocol?: 'udp' | 'tcp';

  /** Starting port for RTP media. Each call uses two consecutive ports. Default: 10000. */
  rtpPortStart?: number;

  /** Local IP address to advertise in SDP. */
  localAddress: string;

  /** Preferred codec. Default: 'PCMU' (G.711 μ-law). */
  codec?: 'PCMU' | 'PCMA';

  /**
   * Send RTP on a fixed wall clock with silence fill when idle (see RtpSession).
   * Default false.
   */
  continuousPacing?: boolean;

  // WebSocket transport options (for JsSIP)

  /** WebSocket server host (for WebSocket transport). Default: localAddress. */
  wsServerHost?: string;

  /** WebSocket server port (for WebSocket transport). Default: 8080. */
  wsServerPort?: number;

  /** Use secure WebSocket (WSS) instead of WS (for WebSocket transport). Default: true. */
  secureWebSocket?: boolean;

  /** SIP username for registration (for WebSocket transport). */
  sipUsername?: string;

  /** SIP password for registration (for WebSocket transport). */
  sipPassword?: string;

  /** SIP domain for registration (for WebSocket transport). Default: localAddress. */
  sipDomain?: string;

  /** Whether to register with SIP server (for WebSocket transport). Default: true. */
  shouldRegister?: boolean;
}
