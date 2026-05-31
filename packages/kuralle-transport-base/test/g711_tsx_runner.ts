/**
 * tsx-runnable sibling to g711_interop.test.ts — exercises the same
 * assertions under Node's ESM resolver (where the original bug lived).
 *
 * Runs via: `npx tsx packages/kuralle-transport-base/test/g711_tsx_runner.ts`
 *
 * Process exit code 0 = all assertions pass. Non-zero = regression of
 * issue #16. This file is intentionally self-contained (no test runner)
 * so the bug-reproduction shape from the original report is preserved:
 * a plain Node ESM load through tsx.
 */
import { strict as assert } from 'node:assert';
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
const CANONICAL_MULAW = [255, 255, 127, 128, 0];
const CANONICAL_ALAW = [213, 213, 85, 170, 42];

function check(label: string, actual: Uint8Array, expected: number[]): void {
  assert.equal(actual instanceof Uint8Array, true, `${label}: not a Uint8Array`);
  assert.deepEqual([...actual], expected, `${label}: byte mismatch`);
}

check('src PCMU.encode', PCMU_src.encode(TDD_VECTOR), CANONICAL_MULAW);
check('src PCMA.encode', PCMA_src.encode(TDD_VECTOR), CANONICAL_ALAW);
check('src mulawEncodeArray', mulawEncodeArray_src(TDD_VECTOR), CANONICAL_MULAW);
assert.equal(
  mulawDecodeArray_src(Uint8Array.from(CANONICAL_MULAW)).length,
  TDD_VECTOR.length,
);

check('dist PCMU.encode', PCMU_dist.encode(TDD_VECTOR), CANONICAL_MULAW);
check('dist PCMA.encode', PCMA_dist.encode(TDD_VECTOR), CANONICAL_ALAW);
check('dist mulawEncodeArray', mulawEncodeArray_dist(TDD_VECTOR), CANONICAL_MULAW);
assert.equal(
  mulawDecodeArray_dist(Uint8Array.from(CANONICAL_MULAW)).length,
  TDD_VECTOR.length,
);

console.log('ok — G.711 interop regression guard passed under tsx');
