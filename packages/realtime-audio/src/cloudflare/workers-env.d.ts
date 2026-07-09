/**
 * Minimal ambient declarations for Cloudflare Workers runtime primitives used
 * by `CloudflareGeminiLiveClient` that are NOT present in `@types/node`
 * (WebSocket, MessageEvent shapes for Worker-delivered frames).
 *
 * We intentionally do NOT depend on `@cloudflare/workers-types` to keep the
 * package install footprint unchanged. Consumers running under the Workers
 * runtime will see the real global types; this file only exists so tsc (Node
 * typing) doesn't reject structural references in `gemini-live.ts`.
 */

declare global {
  /** Shapes workerd may deliver as WebSocket MessageEvent.data. */
  type CFWorkerMessagePayload = string | ArrayBuffer | ArrayBufferView | Blob;

  interface CFWorkerMessageEvent<T extends CFWorkerMessagePayload = CFWorkerMessagePayload> {
    readonly data: T;
  }

  /** fetch()+Upgrade response — workerd attaches webSocket; @types/node Response does not. */
  interface CFWorkerUpgradeResponse {
    readonly status?: number;
    readonly webSocket?: CFWorkerWebSocket | null;
  }

  interface CFWorkerWebSocketCloseEvent {
    readonly code?: number;
    readonly reason?: string;
  }

  interface CFWorkerWebSocketErrorEvent {
    readonly type?: string;
    readonly message?: string;
    readonly error?: { message?: string };
    readonly reason?: string;
    readonly code?: number;
  }

  interface CFWorkerWebSocket {
    binaryType?: string;
    readonly readyState: number;
    send(data: string | ArrayBufferLike | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    accept(): void;
    addEventListener(
      type: 'message',
      listener: (event: CFWorkerMessageEvent) => void,
    ): void;
    addEventListener(
      type: 'close',
      listener: (event: CFWorkerWebSocketCloseEvent) => void,
    ): void;
    addEventListener(
      type: 'error',
      listener: (event: CFWorkerWebSocketErrorEvent) => void,
    ): void;
    addEventListener(type: 'open', listener: () => void): void;
  }
}

export {};
