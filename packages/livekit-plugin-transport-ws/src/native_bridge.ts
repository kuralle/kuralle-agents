import WebSocket from 'ws';
import type { NativeAudioTransport } from '@kuralle-agents/livekit-plugin';

function normalizeMessageData(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/**
 * WebSocket ↔ PCM s16le {@link NativeAudioTransport}. Binary messages are raw little-endian Int16 PCM.
 */
export function createWsNativeAudioTransport(ws: WebSocket): NativeAudioTransport {
  const audioHandlers = new Set<(data: Uint8Array) => void>();
  const closeHandlers = new Set<() => void>();

  const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
    if (!isBinary) return;
    const buf = normalizeMessageData(data);
    if (buf.byteLength <= 0) return;
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const h of audioHandlers) {
      try {
        h(u8);
      } catch {
        /* ignore */
      }
    }
  };

  const onClose = (): void => {
    for (const h of closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  };

  ws.on('message', onMessage);
  ws.on('close', onClose);

  return {
    sendAudio(data: Uint8Array): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(data, { binary: true });
      } catch {
        /* ignore */
      }
    },
    onAudio(handler: (data: Uint8Array) => void): void {
      audioHandlers.add(handler);
    },
    onClose(handler: () => void): void {
      closeHandlers.add(handler);
    },
    close(): void {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
