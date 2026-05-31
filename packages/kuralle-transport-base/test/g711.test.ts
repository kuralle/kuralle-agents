import { describe, it, expect } from 'bun:test';
import { PCMU, PCMA, mulawEncodeArray, mulawDecodeArray } from '../src/codec/g711.js';

describe('G.711 PCMU (mu-law) CCITT compliance', () => {
  it('zero byte decodes to max negative sample', () => {
    const decoded = PCMU.decode(new Uint8Array([0x00]));
    expect(decoded[0]).toBe(-32124);
  });

  it('0x80 decodes to max positive sample', () => {
    const decoded = PCMU.decode(new Uint8Array([0x80]));
    expect(decoded[0]).toBe(32124);
  });

  it('0xFF decodes to zero', () => {
    const decoded = PCMU.decode(new Uint8Array([0xff]));
    expect(decoded[0]).toBe(0);
  });

  it('0x7F decodes to zero', () => {
    const decoded = PCMU.decode(new Uint8Array([0x7f]));
    expect(decoded[0]).toBe(0);
  });

  it('round-trip is lossy but stable', () => {
    const input = new Int16Array([0, 1000, -1000, 5000, -5000, 30000, -30000]);
    const encoded = PCMU.encode(input);
    const decoded = PCMU.decode(encoded);
    expect(decoded.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      // Average mu-law error bound; exact values handled by library.
      expect(Math.abs(decoded[i]! - input[i]!)).toBeLessThanOrEqual(400);
    }
  });

  it('codec metadata', () => {
    expect(PCMU.name).toBe('PCMU');
    expect(PCMU.payloadType).toBe(0);
    expect(PCMU.sampleRate).toBe(8000);
    expect(PCMU.channels).toBe(1);
  });

  it('convenience wrappers match PCMU codec', () => {
    const input = new Int16Array([10, -20, 500]);
    const a = PCMU.encode(input);
    const b = mulawEncodeArray(input);
    expect([...a]).toEqual([...b]);
    const da = PCMU.decode(a);
    const db = mulawDecodeArray(a);
    expect([...da]).toEqual([...db]);
  });
});

describe('G.711 PCMA (A-law)', () => {
  it('codec metadata', () => {
    expect(PCMA.name).toBe('PCMA');
    expect(PCMA.payloadType).toBe(8);
    expect(PCMA.sampleRate).toBe(8000);
    expect(PCMA.channels).toBe(1);
  });

  it('round-trip is lossy but stable', () => {
    const input = new Int16Array([0, 1000, -1000, 5000, -5000]);
    const encoded = PCMA.encode(input);
    const decoded = PCMA.decode(encoded);
    expect(decoded.length).toBe(input.length);
  });
});
