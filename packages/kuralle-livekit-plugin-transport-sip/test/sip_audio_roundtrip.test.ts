/**
 * Integration tests for SIP transport — signaling + RTP audio round-trip.
 *
 * These tests verify the full SIP call lifecycle using SIPTestClient
 * against a real SIPAgentServer. No external API keys needed.
 *
 * What's tested:
 * - INVITE → 100 Trying → 180 Ringing → 200 OK → ACK handshake
 * - RTP audio round-trip: sent PCM → G.711 encode → RTP → server echo → RTP → G.711 decode → received PCM
 * - Audio fidelity: tone energy preserved, silence stays quiet
 * - BYE teardown and cleanup
 * - Transport adapter sample rate configuration
 * - Multiple sequential calls on the same server
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { SIPAgentServer } from '../src/server.js';
import { SIPTestClient } from '../src/testing/sip_test_client.js';

// Use a random high port base for isolation from other test files
const BASE_PORT = 52000 + Math.floor(Math.random() * 3000);

/** RMS energy of a PCM buffer. */
function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i]! * pcm[i]!;
  }
  return Math.sqrt(sum / pcm.length);
}

/** Peak absolute sample value. */
function peak(pcm: Int16Array): number {
  let max = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]!);
    if (abs > max) max = abs;
  }
  return max;
}

beforeAll(() => {
  initializeLogger({ pretty: false });
});

describe('SIP audio round-trip', () => {
  let server: SIPAgentServer;

  const callIds: string[] = [];
  let lastSampleRate: number | undefined;

  beforeAll(async () => {
    server = new SIPAgentServer({
      localAddress: '127.0.0.1',
      sipPort: BASE_PORT,
      rtpPortStart: BASE_PORT + 100,
      codec: 'PCMU',
    });

    server.onCall(async (transport, callId) => {
      callIds.push(callId);
      lastSampleRate = transport.config.sampleRate;

      // Echo: send received RTP audio back to caller
      transport.rtpSession.on('audio', (pcm: Int16Array) => {
        transport.rtpSession.sendAudio(pcm);
      });
    });

    await server.listen();
  });

  afterAll(async () => {
    await server.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it('440Hz tone survives G.711 encode → RTP → decode round-trip', async () => {
    const client = new SIPTestClient({
      localAddress: '127.0.0.1',
      localRtpPort: BASE_PORT + 200,
      codec: 'PCMU',
    });

    try {
      await client.call('127.0.0.1', BASE_PORT);
      expect(client.isConnected).toBe(true);

      // Generate a 440Hz tone at 8kHz for 300ms (15 RTP packets)
      const sampleRate = 8000;
      const durationMs = 300;
      const totalSamples = (sampleRate * durationMs) / 1000;
      const tone = new Int16Array(totalSamples);
      for (let i = 0; i < totalSamples; i++) {
        tone[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
      }

      const sentRms = rms(tone);
      const sentPeak = peak(tone);

      // Listen for echoed audio, then send the tone
      const audioPromise = client.waitForAudio(5000, 500);
      await client.sendAudio(tone, 20);

      const received = await audioPromise;

      // --- Audio content assertions ---

      // 1. We got back a meaningful amount of audio
      //    300ms at 8kHz = 2400 samples; jitter/timing means we may get less
      expect(received.length).toBeGreaterThan(800); // at least ~100ms worth

      // 2. Received audio has energy (not silence)
      const receivedRms = rms(received);
      expect(receivedRms).toBeGreaterThan(1000); // tone energy present (silence ~= 0)

      // 3. G.711 is lossy (8-bit companded) but preserves ~90% of energy for tones
      //    Allow generous tolerance: received RMS should be at least 50% of sent
      expect(receivedRms).toBeGreaterThan(sentRms * 0.5);

      // 4. Peak level preserved within G.711 quantization tolerance
      const receivedPeak = peak(received);
      expect(receivedPeak).toBeGreaterThan(sentPeak * 0.5);
      expect(receivedPeak).toBeLessThan(sentPeak * 1.5); // no clipping/amplification

      // 5. Total received byte count makes sense
      expect(client.receivedAudioBytes).toBeGreaterThan(0);

      await client.hangup();
      expect(client.isConnected).toBe(false);
    } finally {
      client.close();
    }
  }, 15_000);

  it('silence stays silent through G.711 round-trip', async () => {
    await new Promise((r) => setTimeout(r, 300));

    const client = new SIPTestClient({
      localAddress: '127.0.0.1',
      localRtpPort: BASE_PORT + 210,
      codec: 'PCMU',
    });

    try {
      await client.call('127.0.0.1', BASE_PORT);
      expect(client.isConnected).toBe(true);

      // Send 500ms of silence
      const audioPromise = client.waitForAudio(5000, 500);
      await client.sendSilence(500, 20);

      const received = await audioPromise;

      // --- Silence assertions ---

      // 1. Got audio back
      expect(received.length).toBeGreaterThan(0);

      // 2. RMS should be very low (G.711 silence = near-zero PCM)
      const receivedRms = rms(received);
      expect(receivedRms).toBeLessThan(500); // effectively silent

      // 3. Peak should be very low
      const receivedPeak = peak(received);
      expect(receivedPeak).toBeLessThan(1000); // G.711 quantization noise only

      await client.hangup();
    } finally {
      client.close();
    }
  }, 15_000);

  it('transport adapter reports 24kHz output sample rate', () => {
    expect(lastSampleRate).toBe(24000);
  });

  it('server handled multiple sequential calls with unique IDs', () => {
    expect(callIds.length).toBeGreaterThanOrEqual(2);
    const uniqueIds = new Set(callIds);
    expect(uniqueIds.size).toBe(callIds.length);
  });
});
