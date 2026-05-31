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
 * Sidecar metadata that records *what* a cached PCM fixture was generated
 * from. Lets callers detect drift when a test changes its requested text
 * but the cache still holds the older audio.
 *
 * Stored at `${filename}.meta.json` alongside each PCM file.
 */
export interface FixtureMetadata {
  /** Source utterance the TTS run was given. Compared (normalized) on load. */
  text: string;
  /** TTS voice name used during generation. */
  voice: string;
  /** TTS model used during generation. */
  model: string;
  /** ISO-8601 timestamp of generation. Set automatically by save. */
  generatedAt?: string;
}

function metadataPath(filename: string): string {
  return join(fixturesDir, `${filename}.meta.json`);
}

function normalizeForCompare(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Save a PCM fixture together with its `.meta.json` sidecar. The sidecar
 * records the source text + voice + model so subsequent loads can detect
 * drift between a test's requested utterance and the cached PCM.
 */
export function saveFixtureWithMetadata(
  filename: string,
  data: Buffer | Uint8Array,
  meta: Omit<FixtureMetadata, 'generatedAt'> & Partial<Pick<FixtureMetadata, 'generatedAt'>>,
): void {
  saveFixture(filename, data);
  const enriched: FixtureMetadata = {
    text: meta.text,
    voice: meta.voice,
    model: meta.model,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
  };
  writeFileSync(metadataPath(filename), JSON.stringify(enriched, null, 2));
}

/**
 * Load a cached PCM fixture **only if** its sidecar metadata records the
 * same `expectedText` (whitespace + case normalized).
 *
 * Returns `null` when:
 *   - the PCM file is absent,
 *   - the sidecar `.meta.json` is absent (treat PCM-only as stale — no
 *     traceable source means we can't trust the audio),
 *   - the sidecar JSON is corrupt,
 *   - the recorded `text` differs from `expectedText`.
 *
 * Callers regenerate via TTS when this returns null.
 */
export function loadFixtureWithMetadata(
  filename: string,
  expectedText: string,
): Buffer | null {
  const pcm = loadFixture(filename);
  if (!pcm) return null;

  const metaFile = metadataPath(filename);
  if (!existsSync(metaFile)) return null;

  let parsed: FixtureMetadata;
  try {
    parsed = JSON.parse(readFileSync(metaFile, 'utf-8')) as FixtureMetadata;
  } catch {
    return null;
  }

  if (typeof parsed.text !== 'string') return null;
  if (normalizeForCompare(parsed.text) !== normalizeForCompare(expectedText)) return null;

  return pcm;
}

/**
 * Get an audio fixture, generating it via Gemini TTS if not cached.
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY env var.
 * If no key is available, falls back to a synthetic sine wave.
 */
const TTS_VOICE = 'Kore';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

export async function getOrGenerateFixture(
  text: string,
  filename: string,
): Promise<Buffer> {
  // Prefer text-checked cache; falls back to legacy PCM-only cache for
  // pre-existing fixtures that pre-date the sidecar convention.
  const checkedCached = loadFixtureWithMetadata(filename, text);
  if (checkedCached) {
    console.log(`  [fixture] Cache hit (verified): ${filename}`);
    return checkedCached;
  }

  // Legacy: a PCM exists without sidecar — surface drift instead of silently
  // re-using audio whose source text we can't verify.
  const legacyCached = loadFixture(filename);
  if (legacyCached) {
    console.warn(
      `  [fixture] Legacy cache hit (no sidecar) for "${filename}" — regenerating ` +
      `to attach metadata for "${text}"`,
    );
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log(`  [fixture] No Google API key — generating synthetic audio for: "${text}"`);
    const synthetic = generateSineWave(2000);
    saveFixtureWithMetadata(filename, synthetic, {
      text,
      voice: 'sine-wave',
      model: 'synthetic-440hz',
    });
    return Buffer.from(synthetic);
  }

  console.log(`  [fixture] Generating TTS for: "${text}"`);
  const { GoogleGenAI } = await import('@google/genai');
  const genai = new GoogleGenAI({ apiKey });

  const result = await genai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } },
      },
    },
  });

  const audioPart = result.candidates?.[0]?.content?.parts?.[0];
  if (!audioPart?.inlineData?.data) {
    throw new Error(`TTS failed for "${text}"`);
  }

  const pcm = Buffer.from(audioPart.inlineData.data, 'base64');
  saveFixtureWithMetadata(filename, pcm, {
    text,
    voice: TTS_VOICE,
    model: TTS_MODEL,
  });
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
