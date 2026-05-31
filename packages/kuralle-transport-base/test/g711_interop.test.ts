/**
 * Regression guard for issue #16 — alawmulaw CJS/ESM resolver divergence.
 *
 * Two invariants:
 *   1. `PCMU.encode` / `PCMA.encode` return concrete, non-empty Uint8Arrays
 *      matching the canonical CCITT G.711 byte sequences for a fixed input
 *      vector. If the resolver lands on a shape missing `encode`, this
 *      test throws — matching the real prod failure mode instead of just
 *      checking shape.
 *   2. Both the package-source path AND the compiled dist path produce the
 *      same bytes. The original bug was latent in the source path (Bun
 *      resolver happy-cased it) and crashed only when transport-sip
 *      consumed the compiled dist. Two imports, same assertion.
 */
import { describe, it, expect } from 'bun:test';
import {
  PCMU as PCMU_src,
  PCMA as PCMA_src,
  mulawEncodeArray as mulawEncodeArray_src,
  mulawDecodeArray as mulawDecodeArray_src,
} from '../src/codec/g711.js';
import {
  PCMU as PCMU_dist,
  PCMA as PCMA_dist,
  mulawEncodeArray as mulawEncodeArray_dist,
  mulawDecodeArray as mulawDecodeArray_dist,
} from '../dist/codec/g711.js';

const TDD_VECTOR = Int16Array.from([0, 1, -1, 32767, -32768]);
const CANONICAL_MULAW = Uint8Array.from([255, 255, 127, 128, 0]);
const CANONICAL_ALAW = Uint8Array.from([213, 213, 85, 170, 42]);

describe('G.711 vendor-shim interop (issue #16 regression)', () => {
  describe('package source entry', () => {
    it('PCMU.encode returns canonical CCITT mu-law bytes for the TDD vector', () => {
      const out = PCMU_src.encode(TDD_VECTOR);
      expect(out).toBeInstanceOf(Uint8Array);
      expect([...out]).toEqual([...CANONICAL_MULAW]);
    });

    it('PCMA.encode returns canonical CCITT A-law bytes for the TDD vector', () => {
      const out = PCMA_src.encode(TDD_VECTOR);
      expect(out).toBeInstanceOf(Uint8Array);
      expect([...out]).toEqual([...CANONICAL_ALAW]);
    });

    it('mulawEncodeArray / mulawDecodeArray round-trip via PCMU', () => {
      const encoded = mulawEncodeArray_src(TDD_VECTOR);
      expect([...encoded]).toEqual([...CANONICAL_MULAW]);
      const decoded = mulawDecodeArray_src(encoded);
      expect(decoded.length).toBe(TDD_VECTOR.length);
    });
  });

  describe('compiled dist entry (the path RtpSession consumes)', () => {
    it('PCMU.encode returns canonical CCITT mu-law bytes for the TDD vector', () => {
      const out = PCMU_dist.encode(TDD_VECTOR);
      expect(out).toBeInstanceOf(Uint8Array);
      expect([...out]).toEqual([...CANONICAL_MULAW]);
    });

    it('PCMA.encode returns canonical CCITT A-law bytes for the TDD vector', () => {
      const out = PCMA_dist.encode(TDD_VECTOR);
      expect(out).toBeInstanceOf(Uint8Array);
      expect([...out]).toEqual([...CANONICAL_ALAW]);
    });

    it('mulawEncodeArray / mulawDecodeArray round-trip via PCMU', () => {
      const encoded = mulawEncodeArray_dist(TDD_VECTOR);
      expect([...encoded]).toEqual([...CANONICAL_MULAW]);
      const decoded = mulawDecodeArray_dist(encoded);
      expect(decoded.length).toBe(TDD_VECTOR.length);
    });
  });
});
