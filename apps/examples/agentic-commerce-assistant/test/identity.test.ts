import { describe, expect, it } from 'bun:test';
import {
  resolveCommerceIdentity,
  scopedSessionId,
  signIdentityCookie,
  verifyIdentityCookie,
} from '../src/identity.js';

const secret = 'identity-test-secret-that-is-at-least-thirty-two-characters';
const userId = '39e6032d-311f-4fd0-b2f7-2020c6467aa1';

describe('server-owned commerce identity', () => {
  it('round-trips a signed identity and rejects tampering', async () => {
    const signed = await signIdentityCookie(userId, secret);
    expect(await verifyIdentityCookie(signed, secret)).toBe(userId);
    expect(await verifyIdentityCookie(`${signed.slice(0, -1)}x`, secret)).toBeNull();
  });

  it('mints an HTTP-only cookie and scopes client conversation ids under it', async () => {
    const identity = await resolveCommerceIdentity(
      new Request('http://localhost/api/chat'),
      secret,
      { secure: false },
    );
    expect(identity.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.setCookie).toContain('HttpOnly');
    expect(identity.setCookie).toContain('SameSite=Lax');
    expect(scopedSessionId(identity.userId, 'commerce_12345678')).toBe(
      `${identity.userId}:commerce_12345678`,
    );
    expect(() => scopedSessionId(identity.userId, '../another-session')).toThrow(/conversation/i);
  });

  it('rejects weak signing secrets', async () => {
    await expect(resolveCommerceIdentity(
      new Request('http://localhost/api/chat'),
      'too-short',
      { secure: false },
    )).rejects.toThrow(/32 characters/);
  });
});
