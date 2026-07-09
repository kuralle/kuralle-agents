import type { WebSocket } from 'ws';
import type { RealtimeTransportSession } from '@kuralle-agents/realtime-audio';
import type { WebSocketTransportAdapter } from './transport_adapter.js';

// ─── PCM Conversion Utilities ──────────────────────────────────────────────

/**
 * Convert float32 PCM samples to int16 PCM bytes (Uint8Array).
 * GeminiLiveSession and VoiceCallSession expect int16 PCM.
 * LiveKit AudioFrame uses float32 samples internally.
 */
export function float32ToInt16Bytes(float32: Float32Array): Uint8Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i] ?? 0));
    int16[i] = Math.round(clamped * 0x7fff);
  }
  return new Uint8Array(int16.buffer);
}

/**
 * Convert int16 PCM bytes (Uint8Array) to float32 PCM samples.
 */
export function int16BytesToFloat32(pcmBytes: Uint8Array): Float32Array {
  const int16View = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    Math.floor(pcmBytes.byteLength / 2),
  );
  const float32 = new Float32Array(int16View.length);
  for (let i = 0; i < int16View.length; i++) {
    float32[i] = (int16View[i] ?? 0) / 0x7fff;
  }
  return float32;
}

// ─── Raw WebSocket Bridge ──────────────────────────────────────────────────

/**
 * Bridge a raw WebSocket connection to a RealtimeTransportSession.
 *
 * This is the primary bridge used by WebSocketAgentServer.startNativeSession().
 * Binary WS messages are passed through directly as Uint8Array (int16 PCM)
 * without intermediate float32 conversion.
 *
 * The WebSocket client and the model client must agree on sample rate and
 * encoding. No resampling is performed in this bridge.
 */
export function bridgeWebSocketToRealtimeTransport(
  ws: WebSocket,
  options?: { sessionId?: string },
): RealtimeTransportSession {
  const audioHandlers: Array<(data: Uint8Array) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  function fireClose(): void {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      handler();
    }
  }

  // Named handlers so they can be removed on close()
  const onMessage = (data: Buffer, isBinary: boolean): void => {
    if (!isBinary || closed) return;
    const uint8 = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    for (const handler of audioHandlers) {
      handler(uint8);
    }
  };

  const onClose = (): void => fireClose();
  const onError = (): void => fireClose();

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);

  function removeListeners(): void {
    ws.removeListener('message', onMessage);
    ws.removeListener('close', onClose);
    ws.removeListener('error', onError);
  }

  const interruptHandlers: Array<() => void> = [];

  return {
    sendAudio(data: Uint8Array): void {
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(Buffer.from(data), { binary: true });
      } catch {
        // WS already closed
      }
    },

    onAudio(handler: (data: Uint8Array) => void): void {
      audioHandlers.push(handler);
    },

    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },

    onInterrupted(handler: () => void): void {
      interruptHandlers.push(handler);
    },

    clearAudioBuffer(): void {
      // Signal the client to stop playback.
      // Send a JSON control message that the frontend can act on.
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'clear_audio' }));
      } catch {
        // WS closed
      }
      for (const handler of interruptHandlers) {
        handler();
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      removeListeners();
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, 'Session ended');
      }
    },
  };
}

// ─── Adapter-Based Bridge ──────────────────────────────────────────────────

/**
 * Bridge a WebSocketTransportAdapter to a RealtimeTransportSession.
 *
 * This variant works at the adapter level, converting between LiveKit's
 * float32 AudioFrame format and VoiceCallSession int16 PCM Uint8Array.
 *
 * Use this when you already have a WebSocketTransportAdapter instance
 * (e.g., from the server's onConnection callback) and want to route it
 * through VoiceCallSession instead of KuralleVoiceSession.
 *
 * Note: This bridge subscribes to the raw WS binary messages directly
 * (same as the simple bridge) because WebSocketAudioInput doesn't expose
 * a frame event. Output is sent as raw binary on the WS, bypassing
 * WebSocketAudioOutput's AudioFrame machinery.
 */
export function bridgeAdapterToRealtimeTransport(
  adapter: WebSocketTransportAdapter,
): RealtimeTransportSession {
  const audioHandlers: Array<(data: Uint8Array) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  // Use the public rawSocket getter to access the underlying WebSocket.
  // The adapter's audioInput already listens on the WS for binary messages
  // and converts to AudioFrames. For the realtime bridge, we need the raw
  // int16 PCM bytes. We attach a second binary listener on the same WS.
  const ws = adapter.rawSocket;

  function fireClose(): void {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      handler();
    }
  }

  const onMessage = (data: Buffer, isBinary: boolean): void => {
    if (!isBinary || closed) return;
    const uint8 = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    for (const handler of audioHandlers) {
      handler(uint8);
    }
  };

  const onClose = (): void => fireClose();
  const onError = (): void => fireClose();

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);

  function removeListeners(): void {
    ws.removeListener('message', onMessage);
    ws.removeListener('close', onClose);
    ws.removeListener('error', onError);
  }

  return {
    sendAudio(data: Uint8Array): void {
      if (closed || !adapter.isOpen) return;
      try {
        ws.send(data, { binary: true });
      } catch {
        // WS closed
      }
    },

    onAudio(handler: (data: Uint8Array) => void): void {
      audioHandlers.push(handler);
    },

    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },

    close(): void {
      if (closed) return;
      closed = true;
      removeListeners();
      adapter.close().catch(() => {});
    },
  };
}
