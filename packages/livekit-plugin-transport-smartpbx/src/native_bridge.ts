import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import type { NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import { mulawDecodeArray, mulawEncodeArray } from '@kuralle-agents/transport-base/codec/g711';
import {
  DEFAULT_WEBSOCKET_OPEN_STATE,
  type SmartPBXSessionState,
  type SmartPBXSocketLike,
} from './types.js';

export type SmartPbxWireEncoding = 'pcm_s16le' | 'g711_ulaw';

export interface SmartPbxNativeAudioTransportOptions {
  socket: SmartPBXSocketLike;
  session: SmartPBXSessionState;
  websocketOpenState?: number;
  /** Wire format for SmartPBX `media` payloads (base64). */
  wire: { encoding: SmartPbxWireEncoding; sampleRate: number };
  /** Sample rate expected by the native runner / Gemini (default 24000). */
  runnerSampleRate?: number;
}

export interface SmartPbxNativeAudioTransport extends NativeAudioTransport {
  /**
   * Feed inbound SmartPBX WebSocket text frames (JSON). The host should call this
   * from its `message` handler; {@link SmartPBXSocketLike} does not include it.
   */
  ingestInboundMessage(raw: string): void;
}

function isSocketOpen(
  socket: SmartPBXSocketLike,
  session: SmartPBXSessionState,
  websocketOpenState: number,
): boolean {
  return session.isActive && socket.readyState === websocketOpenState;
}

function bytesToInt16Le(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
  }
  return out;
}

function int16ToBytesLe(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return out;
}

function base64ToU8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function u8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * SmartPBX AI Provider–style JSON media events ↔ PCM s16le for the native runner.
 */
export function createSmartPbxNativeAudioTransport(
  options: SmartPbxNativeAudioTransportOptions,
): SmartPbxNativeAudioTransport {
  const socket = options.socket;
  const session = options.session;
  const wsOpen = options.websocketOpenState ?? DEFAULT_WEBSOCKET_OPEN_STATE;
  const wire = options.wire;
  const runnerRate = options.runnerSampleRate ?? 24000;
  const wirePcmRate = wire.encoding === 'g711_ulaw' ? 8000 : wire.sampleRate;

  const toRunner = createResampler(wirePcmRate, runnerRate);
  const fromRunner = createResampler(runnerRate, wirePcmRate);

  const audioHandlers = new Set<(data: Uint8Array) => void>();
  const closeHandlers = new Set<() => void>();

  const emitClose = (): void => {
    for (const h of closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  };

  const sendWireFrame = (pcmWire: Int16Array): void => {
    if (!isSocketOpen(socket, session, wsOpen)) return;
    let payload: Uint8Array;
    if (wire.encoding === 'g711_ulaw') {
      payload = mulawEncodeArray(pcmWire);
    } else {
      payload = int16ToBytesLe(pcmWire);
    }
    try {
      socket.send(
        JSON.stringify({
          event: 'media',
          media: { payload: u8ToBase64(payload) },
        }),
      );
    } catch {
      /* ignore */
    }
  };

  return {
    sendAudio(data: Uint8Array): void {
      let int16: Int16Array;
      try {
        int16 = bytesToInt16Le(data);
      } catch {
        return;
      }
      const inFrame = new AudioFrame(int16, runnerRate, 1, int16.length);
      try {
        for (const outFrame of fromRunner.push(inFrame)) {
          sendWireFrame(new Int16Array(outFrame.data));
        }
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
      for (const outFrame of fromRunner.flush()) {
        sendWireFrame(new Int16Array(outFrame.data));
      }
      emitClose();
    },
    ingestInboundMessage(raw: string): void {
      let msg: { event?: string; media?: { payload?: string } };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (msg.event !== 'media' || typeof msg.media?.payload !== 'string') return;

      let pcmWire: Int16Array;
      try {
        const bytes = base64ToU8(msg.media.payload);
        if (wire.encoding === 'g711_ulaw') {
          pcmWire = mulawDecodeArray(bytes);
        } else {
          pcmWire = bytesToInt16Le(bytes);
        }
      } catch {
        return;
      }

      const inFrame = new AudioFrame(pcmWire, wirePcmRate, 1, pcmWire.length);
      try {
        for (const outFrame of toRunner.push(inFrame)) {
          const bytesOut = int16ToBytesLe(new Int16Array(outFrame.data));
          for (const h of audioHandlers) {
            try {
              h(bytesOut);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    },
  };
}
