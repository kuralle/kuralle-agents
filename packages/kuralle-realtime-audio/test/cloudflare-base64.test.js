import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encodeBase64Chunked, decodeBase64 } from '../dist/cloudflare/base64.js';

describe('cloudflare base64', () => {
  it('round-trips small payloads', () => {
    const u8 = new Uint8Array([0, 1, 2, 3, 4, 250, 251, 252]);
    const b64 = encodeBase64Chunked(u8);
    const back = decodeBase64(b64);
    assert.deepEqual(Array.from(back), Array.from(u8));
  });

  it('round-trips a payload larger than the 32 KiB chunk size', () => {
    const u8 = new Uint8Array(0x8000 * 3 + 17);
    for (let i = 0; i < u8.length; i++) u8[i] = i % 256;
    const back = decodeBase64(encodeBase64Chunked(u8));
    assert.equal(back.length, u8.length);
    for (let i = 0; i < u8.length; i++) {
      assert.equal(back[i], u8[i]);
    }
  });

  it('encodes empty input to empty string', () => {
    assert.equal(encodeBase64Chunked(new Uint8Array(0)), '');
    assert.equal(decodeBase64('').length, 0);
  });
});
