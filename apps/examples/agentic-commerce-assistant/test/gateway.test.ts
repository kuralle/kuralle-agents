import { afterEach, describe, expect, it } from 'bun:test';
import { createGatewayFetch } from '../src/gateway.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Cloudflare AI Gateway transport', () => {
  it('uses the gateway token header and strips upstream provider credentials', async () => {
    let captured: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      captured = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;

    await createGatewayFetch('cf-token')('https://gateway.example/openai/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer upstream-key', 'x-api-key': 'upstream-key' },
    });

    expect(captured?.get('cf-aig-authorization')).toBe('Bearer cf-token');
    expect(captured?.has('authorization')).toBe(false);
    expect(captured?.has('x-api-key')).toBe(false);
  });
});
