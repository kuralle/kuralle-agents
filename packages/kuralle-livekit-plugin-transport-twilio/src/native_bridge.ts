import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import type { NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import { mulawDecodeArray, mulawEncodeArray } from '@kuralle-agents/transport-base/codec/g711';

const TWILIO_PCM_RATE = 8000;
const RUNNER_DEFAULT_RATE = 24000;

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

export interface TwilioNativeWsLike {
  readonly readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: () => void): unknown;
  close(): void;
}

const WS_OPEN = 1;

/**
 * Twilio Media Streams WebSocket ↔ PCM s16le at {@link RUNNER_DEFAULT_RATE} (configurable).
 * μ-law on the wire at 8 kHz; resampling matches {@link TwilioAudioInput} / {@link TwilioAudioOutput}.
 */
export function createTwilioNativeAudioTransport(
  ws: TwilioNativeWsLike,
  options?: { runnerSampleRate?: number },
): NativeAudioTransport {
  const runnerRate = options?.runnerSampleRate ?? RUNNER_DEFAULT_RATE;
  let streamSid = '';
  const toRunner = createResampler(TWILIO_PCM_RATE, runnerRate);
  const fromRunner = createResampler(runnerRate, TWILIO_PCM_RATE);

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

  const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
    if (isBinary) return;
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    let msg: { event?: string; start?: { streamSid?: string }; media?: { payload?: string } };
    try {
      msg = JSON.parse(buf.toString('utf8')) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === 'start' && msg.start?.streamSid) {
      streamSid = msg.start.streamSid;
    }
    if (msg.event !== 'media' || !msg.media?.payload) return;

    try {
      const mulawData = Uint8Array.from(atob(msg.media.payload), (c) => c.charCodeAt(0));
      const pcm8k = mulawDecodeArray(mulawData);
      const inFrame = new AudioFrame(pcm8k, TWILIO_PCM_RATE, 1, pcm8k.length);
      for (const outFrame of toRunner.push(inFrame)) {
        const bytes = int16ToBytesLe(new Int16Array(outFrame.data));
        for (const h of audioHandlers) {
          try {
            h(bytes);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  ws.on('message', onMessage);
  ws.on('close', emitClose);
  ws.on('error', emitClose);

  return {
    sendAudio(data: Uint8Array): void {
      if (ws.readyState !== WS_OPEN) return;
      let int16: Int16Array;
      try {
        int16 = bytesToInt16Le(data);
      } catch {
        return;
      }
      const inFrame = new AudioFrame(int16, runnerRate, 1, int16.length);
      try {
        for (const out8k of fromRunner.push(inFrame)) {
          const mulaw = mulawEncodeArray(new Int16Array(out8k.data));
          const base64 = Buffer.from(mulaw).toString('base64');
          const message = JSON.stringify({
            event: 'media',
            streamSid,
            sequenceNumber: `${Date.now()}`,
            media: { payload: base64 },
          });
          ws.send(message);
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
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
