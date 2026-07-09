import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import type { NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import type { RtpSession } from './rtp/rtp_session.js';

const RTP_PCM_RATE = 8000;
const RUNNER_DEFAULT_RATE = 24000;

function bytesToInt16Le(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
  }
  return out;
}

/** Copy PCM samples into a plain array (avoids TS 5.9 Int16Array<ArrayBuffer> vs ArrayBufferLike issues). */
function pcmToNumbers(data: ArrayLike<number>): number[] {
  const len = data.length;
  const out: number[] = new Array(len);
  for (let i = 0; i < len; i++) out[i] = data[i] as number;
  return out;
}

function appendPcm(dst: number[], data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i++) dst.push(data[i] as number);
}

/**
 * RTP (G.711 payload) session ↔ PCM s16le for the native LiveKit runner.
 * Decoded RTP PCM is 8 kHz; resampled to the runner rate (default 24 kHz).
 */
export function createSipNativeAudioTransport(
  rtpSession: RtpSession,
  options?: {
    runnerSampleRate?: number;
    codecSampleRate?: number;
    packetDurationMs?: number;
  },
): NativeAudioTransport {
  const runnerRate = options?.runnerSampleRate ?? RUNNER_DEFAULT_RATE;
  const codecRate = options?.codecSampleRate ?? RTP_PCM_RATE;
  const packetDurationMs = options?.packetDurationMs ?? 20;
  const samplesPerPacket = (codecRate * packetDurationMs) / 1000;

  const toRunner = createResampler(codecRate, runnerRate);
  const fromRunner = createResampler(runnerRate, codecRate);

  const audioHandlers = new Set<(data: Uint8Array) => void>();
  const closeHandlers = new Set<() => void>();

  let outboundRemainder: number[] = [];

  const emitClose = (): void => {
    for (const h of closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  };

  const onRtpPcm = (pcm: Int16Array): void => {
    const inFrame = new AudioFrame(pcm, codecRate, 1, pcm.length);
    try {
      for (const outFrame of toRunner.push(inFrame)) {
        const samples = pcmToNumbers(outFrame.data);
        const bytes = new Uint8Array(samples.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
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

  rtpSession.on('audio', onRtpPcm);

  const flushOutbound = (): void => {
    for (const outFrame of fromRunner.flush()) {
      appendPcm(outboundRemainder, outFrame.data);
    }
    while (outboundRemainder.length >= samplesPerPacket) {
      const chunk = outboundRemainder.splice(0, samplesPerPacket);
      rtpSession.sendAudio(new Int16Array(chunk));
    }
    if (outboundRemainder.length > 0) {
      const padded = new Int16Array(samplesPerPacket);
      padded.set(outboundRemainder);
      rtpSession.sendAudio(padded);
      outboundRemainder = [];
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
          appendPcm(outboundRemainder, outFrame.data);
          while (outboundRemainder.length >= samplesPerPacket) {
            const chunk = outboundRemainder.splice(0, samplesPerPacket);
            rtpSession.sendAudio(new Int16Array(chunk));
          }
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
        flushOutbound();
      } catch {
        /* ignore */
      }
      rtpSession.off('audio', onRtpPcm);
      emitClose();
      rtpSession.close();
    },
  };
}
