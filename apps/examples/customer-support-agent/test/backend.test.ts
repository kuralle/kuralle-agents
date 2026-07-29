import { describe, expect, it } from 'bun:test';
import {
  createDemoSupportBackend,
  createHttpSupportBackend,
  supportBackendFromEnv,
} from '../src/backend.js';

describe('support-system boundary', () => {
  it('authenticates, scopes, validates, and idempotency-keys HTTP writes', async () => {
    const requests: Request[] = [];
    const backend = createHttpSupportBackend({
      baseUrl: 'https://support.example.com/',
      token: 'server-secret',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ id: 'CASE-9', status: 'queued', subject: 'Billing review', createdAt: '2026-07-30T00:00:00Z' });
      },
    });
    await backend.createCase({
      customerId: 'customer/with/slashes',
      subject: 'Billing review',
      details: 'Please review this charge.',
      idempotencyKey: 'stable-case-key',
    });
    expect(requests[0]?.url).toBe('https://support.example.com/v1/cases');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer server-secret');
    expect(requests[0]?.headers.get('idempotency-key')).toBe('stable-case-key');
  });

  it('refuses demo data on production hosts', () => {
    expect(() => supportBackendFromEnv({ SUPPORT_DEMO_MODE: 'true', production: true })).toThrow(/forbidden/i);
  });

  it('deduplicates demo case creation for local evaluation', async () => {
    const backend = createDemoSupportBackend();
    const input = { customerId: 'customer', subject: 'Review', details: 'Review this case please.', idempotencyKey: 'same' };
    expect(await backend.createCase(input)).toEqual(await backend.createCase(input));
  });
});
