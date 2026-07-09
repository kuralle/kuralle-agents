/**
 * Audio fixture utilities for e2e tests.
 *
 * Generates or loads PCM audio fixtures for testing voice pipelines.
 * Uses Gemini TTS to synthesize speech from text, caching results on disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '..', 'fixtures');

/**
 * Generate a silent PCM audio buffer (int16 LE).
 * Useful for VAD end-of-speech triggers and baseline tests.
 */
export function generateSilence(durationMs: number, sampleRate = 24000): Uint8Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  return new Uint8Array(numSamples * 2); // int16 = 2 bytes per sample
}

/**
 * Generate a sine wave PCM audio buffer (int16 LE).
 * Useful as a non-silence audio signal for testing audio path presence.
 */
export function generateSineWave(
  durationMs: number,
  frequencyHz = 440,
  sampleRate = 24000,
  amplitude = 0.5,
): Uint8Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const int16 = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    int16[i] = Math.round(Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * 0x7fff);
  }
  return new Uint8Array(int16.buffer);
}

/**
 * Load a cached PCM fixture from disk.
 * Returns null if the fixture doesn't exist.
 */
export function loadFixture(filename: string): Buffer | null {
  const path = join(fixturesDir, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/**
 * Save a PCM fixture to disk for caching.
 */
export function saveFixture(filename: string, data: Buffer | Uint8Array): void {
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, filename), data);
}

/**
 * Get an audio fixture, generating it via Gemini TTS if not cached.
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY env var.
 * If no key is available, falls back to a synthetic sine wave.
 */
export async function getOrGenerateFixture(
  text: string,
  filename: string,
): Promise<Buffer> {
  const cached = loadFixture(filename);
  if (cached) {
    console.log(`  [fixture] Cache hit: ${filename}`);
    return cached;
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log(`  [fixture] No Google API key — generating synthetic audio for: "${text}"`);
    // Generate a 2-second sine wave as a substitute
    const synthetic = generateSineWave(2000);
    saveFixture(filename, synthetic);
    return Buffer.from(synthetic);
  }

  console.log(`  [fixture] Generating TTS for: "${text}"`);
  const { GoogleGenAI } = await import('@google/genai');
  const genai = new GoogleGenAI({ apiKey });

  const result = await genai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  });

  const audioPart = result.candidates?.[0]?.content?.parts?.[0];
  if (!audioPart?.inlineData?.data) {
    throw new Error(`TTS failed for "${text}"`);
  }

  const pcm = Buffer.from(audioPart.inlineData.data, 'base64');
  saveFixture(filename, pcm);
  console.log(`  [fixture] Cached ${pcm.length} bytes → ${filename}`);
  return pcm;
}

/**
 * Standard test utterances for e2e voice testing.
 */
export const TEST_UTTERANCES = [
  {
    text: 'Hi, I would like to book an appointment please.',
    filename: 'turn1_book_appointment.pcm',
  },
  {
    text: 'My name is Alice Chen and I need a cardiology appointment next Tuesday.',
    filename: 'turn2_provide_details.pcm',
  },
  {
    text: 'Yes, that sounds great. Please confirm the appointment.',
    filename: 'turn3_confirm.pcm',
  },
];
