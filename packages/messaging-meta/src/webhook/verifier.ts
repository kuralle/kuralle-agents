/**
 * @module webhook/verifier
 *
 * HMAC-SHA256 signature verification for Meta webhook payloads.
 *
 * Meta signs every webhook delivery with a `X-Hub-Signature-256` header
 * containing `sha256=<hex>`. This module validates that signature using
 * the app secret, ensuring the payload was not tampered with in transit.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link verifySignature}. */
export interface VerifySignatureOptions {
  /** The Meta app secret used as the HMAC key. */
  appSecret: string;
  /** Raw request body exactly as received (before any JSON parsing). */
  rawBody: Buffer | string;
  /** Value of the `X-Hub-Signature-256` header (e.g. `"sha256=abcdef..."`). */
  signatureHeader: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC-SHA256 signature of a Meta webhook payload.
 *
 * Uses timing-safe comparison to prevent timing attacks. Returns `false`
 * (rather than throwing) when the signature is missing, malformed, or invalid
 * so that callers can respond with an appropriate HTTP status.
 *
 * @param options - Verification parameters.
 * @returns `true` if the signature is valid, `false` otherwise.
 *
 * @example
 * ```ts
 * const valid = verifySignature({
 *   appSecret: process.env.META_APP_SECRET!,
 *   rawBody: request.rawBody,
 *   signatureHeader: request.headers['x-hub-signature-256'] ?? '',
 * });
 *
 * if (!valid) {
 *   return new Response('Invalid signature', { status: 403 });
 * }
 * ```
 */
export function verifySignature(options: VerifySignatureOptions): boolean {
  const { appSecret, rawBody, signatureHeader } = options;

  // The header must start with the `sha256=` prefix.
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signatureHeader.slice(7); // Strip `sha256=` prefix.

  // Validate that the expected signature is plausible hex (64 hex chars for SHA-256).
  if (!/^[0-9a-f]{64}$/i.test(expectedSignature)) {
    return false;
  }

  const actualSignature = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody)
    .digest('hex');

  // Use timing-safe comparison to prevent timing side-channel attacks.
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(actualSignature, 'hex'),
    );
  } catch {
    // `timingSafeEqual` throws if buffers have different lengths.
    return false;
  }
}
