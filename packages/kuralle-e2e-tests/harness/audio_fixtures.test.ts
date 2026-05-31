import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadFixtureWithMetadata,
  saveFixtureWithMetadata,
  type FixtureMetadata,
} from './audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '..', 'fixtures');
const tempStem = 'tmp_fixture_test';

function tempPaths() {
  return {
    pcm: join(fixturesDir, `${tempStem}.pcm`),
    meta: join(fixturesDir, `${tempStem}.pcm.meta.json`),
  };
}

beforeEach(() => {
  mkdirSync(fixturesDir, { recursive: true });
  const { pcm, meta } = tempPaths();
  if (existsSync(pcm)) rmSync(pcm);
  if (existsSync(meta)) rmSync(meta);
});

afterEach(() => {
  const { pcm, meta } = tempPaths();
  if (existsSync(pcm)) rmSync(pcm);
  if (existsSync(meta)) rmSync(meta);
});

describe('audio_fixtures sidecar metadata', () => {
  test('saveFixtureWithMetadata writes both PCM and sidecar JSON', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    saveFixtureWithMetadata(`${tempStem}.pcm`, pcm, {
      text: 'hello world',
      voice: 'Kore',
      model: 'gemini-2.5-flash-preview-tts',
    });

    const { pcm: pcmPath, meta: metaPath } = tempPaths();
    expect(existsSync(pcmPath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as FixtureMetadata;
    expect(parsed.text).toBe('hello world');
    expect(parsed.voice).toBe('Kore');
    expect(parsed.model).toBe('gemini-2.5-flash-preview-tts');
    expect(typeof parsed.generatedAt).toBe('string');
  });

  test('loadFixtureWithMetadata returns null when fixture is missing', () => {
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'any text');
    expect(result).toBeNull();
  });

  test('loadFixtureWithMetadata returns the buffer when text matches the sidecar', () => {
    const pcm = new Uint8Array([5, 6, 7]);
    saveFixtureWithMetadata(`${tempStem}.pcm`, pcm, {
      text: 'matching text',
      voice: 'Kore',
      model: 'm',
    });
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'matching text');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(Array.from(result!)).toEqual([5, 6, 7]);
  });

  test('loadFixtureWithMetadata returns null when text drifts from sidecar', () => {
    const pcm = new Uint8Array([5, 6, 7]);
    saveFixtureWithMetadata(`${tempStem}.pcm`, pcm, {
      text: 'original',
      voice: 'Kore',
      model: 'm',
    });
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'different');
    expect(result).toBeNull();
  });

  test('loadFixtureWithMetadata returns null when sidecar is missing (PCM-only is treated as stale)', () => {
    const { pcm: pcmPath } = tempPaths();
    writeFileSync(pcmPath, new Uint8Array([9, 9, 9]));
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'any text');
    expect(result).toBeNull();
  });

  test('loadFixtureWithMetadata returns null when sidecar JSON is corrupt', () => {
    const { pcm: pcmPath, meta: metaPath } = tempPaths();
    writeFileSync(pcmPath, new Uint8Array([1, 2]));
    writeFileSync(metaPath, '{ not valid json');
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'any');
    expect(result).toBeNull();
  });

  test('text comparison normalizes whitespace and case', () => {
    const pcm = new Uint8Array([1]);
    saveFixtureWithMetadata(`${tempStem}.pcm`, pcm, {
      text: '  Hello  World  ',
      voice: 'v',
      model: 'm',
    });
    const result = loadFixtureWithMetadata(`${tempStem}.pcm`, 'hello world');
    expect(result).not.toBeNull();
  });
});
