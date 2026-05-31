/**
 * Type declarations for node.js-sip library v1.0.9
 * https://github.com/Nik-Hendricks/node.js-sip
 *
 * Minimal type definitions covering the API surface used by SIPSignaling.
 */

declare module 'node.js-sip' {
  export interface VOIPTransport {
    socket?: {
      close?: () => void;
    };
    send(message: string | Uint8Array, ip: string, port: number): void;
  }

  /**
   * VOIP configuration options
   */
  export interface VOIPOptions {
    /** Server or client mode */
    type: 'server' | 'client';
    /** Transport configuration */
    transport: {
      /** Transport protocol (must be uppercase per examples) */
      type: 'UDP' | 'TCP' | 'WS' | 'WSS';
      /** Port number for UDP/TCP or port for WS server */
      port?: number;
      /** Host address for WS/WSS connections */
      host?: string;
      /** WebSocket server URL (for WS/WSS transport) */
      server?: string;
    };
    /** Optional authentication credentials */
    authorization?: {
      username?: string;
      password?: string;
      realm?: string;
    };
  }

  /**
   * SIP message representation
   */
  export interface SIPMessage {
    /** SIP method (INVITE, BYE, ACK, REGISTER, etc.) */
    method?: string;
    /** SIP status code (for responses) */
    statusCode?: number;
    /** SIP status text (for responses) */
    statusText?: string;
    /** SIP headers map as returned by the library parser */
    headers: Record<string, string>;
    /** SDP body or message body */
    body?: string;
    /** Optional Call-ID extracted from headers */
    callId?: string;
  }

  /**
   * SIP header representation
   */
  export interface SIPHeader {
    name: string;
    value: string;
  }

  /**
   * Options for creating a SIP response
   */
  export interface SIPResponseOptions {
    /** True if this is a response, false for request */
    isResponse: boolean;
    /** SIP status code (100, 180, 200, 404, 486, etc.) */
    statusCode: number;
    /** SIP status text */
    statusText: string;
    /** SIP headers */
    headers: SIPHeader[];
    /** Message body */
    body: string;
  }

  /**
   * Options for creating a SIP request
   */
  export interface SIPRequestOptions {
    /** SIP method (INVITE, BYE, ACK, REGISTER, etc.) */
    method: string;
    /** Request URI (e.g., "sip:user@host:port") */
    requestUri: string;
    /** SIP headers */
    headers: SIPHeader[];
    /** Message body */
    body: string;
  }

  /**
   * VOIP event types emitted by the callback
   */
  export type VOIPEvent =
    | { type: 'UAS_READY'; message?: undefined }
    | { type: 'INVITE'; message: SIPMessage }
    | { type: 'BYE'; message: SIPMessage }
    | { type: 'ACK'; message: SIPMessage }
    | { type: 'REGISTER'; message: SIPMessage }
    | { type: 'CANCEL'; message: SIPMessage }
    | { type: 'OPTIONS'; message: SIPMessage }
    | { type: string; message?: SIPMessage };

  /**
   * Callback type for VOIP events
   */
  export type VOIPCallback = (data: VOIPEvent) => void;

  /**
   * Users database callback result
   */
  export type UsersDatabase = Record<string, unknown>;

  /**
   * Response/user callback type
   */
  export type SIPResponseCallback = (
    response: SIPMessage,
    users: UsersDatabase
  ) => void;

  /**
   * VOIP class - main entry point for node.js-sip
   */
  export class VOIP {
    transport: VOIPTransport;

    /**
     * Create a new VOIP instance
     * @param options - VOIP configuration
     * @param callback - Event callback for SIP messages
     */
    constructor(options: VOIPOptions, callback: VOIPCallback);

    /**
     * Send a SIP message
     * @param message - SIP message to send
     */
    send(message: SIPMessage): void;

    /**
     * Create a SIP response message
     * @param options - Response options
     * @returns SIP message object
     */
    response(options: SIPResponseOptions): SIPMessage;

    /**
     * Create a SIP request message
     * @param options - Request options
     * @returns SIP message object
     */
    request(options: SIPRequestOptions): SIPMessage;

    /**
     * Handle incoming INVITE request (UAS mode)
     * @param message - INVITE message
     * @param users - Users database for authentication
     * @param callback - Callback with response to send
     */
    uas_handle_invite(
      message: SIPMessage,
      users: UsersDatabase,
      callback: SIPResponseCallback
    ): void;

    /**
     * Handle incoming BYE request (UAS mode)
     * @param message - BYE message
     * @param users - Users database
     * @param callback - Callback with response to send
     */
    uas_handle_bye(
      message: SIPMessage,
      users: UsersDatabase,
      callback: SIPResponseCallback
    ): void;

    /**
     * Handle incoming REGISTER request (UAS mode)
     * @param message - REGISTER message
     * @param users - Users database for authentication
     * @param callback - Callback with response to send
     */
    uas_handle_registration(
      message: SIPMessage,
      users: UsersDatabase,
      callback: SIPResponseCallback
    ): void;
  }
}

declare module 'node.js-sip/SIP/index.js' {
  /**
   * SIP parser utilities
   */
  export namespace Parser {
    function parse(raw: string): {
      method?: string;
      statusCode?: number;
      statusText?: string;
      requestUri?: string;
      headers: Record<string, string>;
      body?: string;
      callId?: string;
      isResponse?: boolean;
    };

    /**
     * Parse SIP headers from array
     * @param headers - Array of SIP headers
     * @returns Object mapping header names to values
     */
    function ParseHeaders(headers: Record<string, string> | unknown[]): Record<string, string | string[]>;
  }

  /**
   * SIP constants
   */
  export namespace Constants {
    const BYE: 'BYE';
    const INVITE: 'INVITE';
    const ACK: 'ACK';
    const REGISTER: 'REGISTER';
    const CANCEL: 'CANCEL';
    const OPTIONS: 'OPTIONS';
  }

  export namespace Builder {
    function Build(message: {
      isResponse: boolean;
      protocol: string;
      statusCode?: number;
      statusText?: string;
      method?: string;
      requestUri?: string;
      headers: Record<string, string | number>;
      body: string;
    }): string;
  }

  // Re-export constants for convenience
  export { Constants as SIP };
}

// Make sure we don't get export conflicts
export {};
