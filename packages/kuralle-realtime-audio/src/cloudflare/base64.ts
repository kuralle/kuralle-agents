/**
 * Chunked base64 helpers for the Cloudflare-Workers runtime.
 *
 * Workerd's `btoa` / `atob` accept any string but the naive
 * `String.fromCharCode(...new Uint8Array(buf))` form trips stack-size limits
 * past ~100 KiB and exhibits O(n²) behavior on large frames. Both
 * `cloudflare/gemini-live.ts` and `cloudflare/openai-family/base.ts` shipped
 * identical 32 KiB-chunked encoders; centralized here so a future tweak
 * (e.g. swapping in `Uint8Array.prototype.toBase64()` once stable on
 * workerd) lands in one place.
 *
 * Not used on Node — `Buffer.from(u8).toString('base64')` is the right call
 * there and is faster than this loop.
 */

export function encodeBase64Chunked(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length));
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  return btoa(binary);
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
