import { describe, it, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../src/webhook/verifier.ts';

const APP_SECRET = 'test_app_secret_12345';

/** Helper to produce a valid `sha256=<hex>` signature header. */
function sign(body: string, secret: string = APP_SECRET): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('verifySignature', () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a valid HMAC-SHA256 signature', () => {
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: sign(body),
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = sign(body);
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body + 'TAMPERED',
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it('rejects wrong secret', () => {
    const signature = sign(body, 'wrong_secret');
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it('rejects missing sha256= prefix', () => {
    const hex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: hex, // no sha256= prefix
      }),
    ).toBe(false);
  });

  it('rejects empty signature header', () => {
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: '',
      }),
    ).toBe(false);
  });

  it('handles Buffer input for rawBody', () => {
    const bufBody = Buffer.from(body, 'utf-8');
    // The HMAC is computed identically for string and buffer with the same bytes
    const signature = sign(body);
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: bufBody,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });

  it('handles string input for rawBody', () => {
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: sign(body),
      }),
    ).toBe(true);
  });

  it('does not throw on length mismatches (different hex lengths)', () => {
    // A signature that is valid hex but not 64 chars should be rejected, not throw
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: 'sha256=abcd',
      }),
    ).toBe(false);

    // Very long hex
    expect(
      verifySignature({
        appSecret: APP_SECRET,
        rawBody: body,
        signatureHeader: 'sha256=' + 'a'.repeat(128),
      }),
    ).toBe(false);
  });
});
