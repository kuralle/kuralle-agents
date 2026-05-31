/**
 * @module base-client-contract
 *
 * Contract test harness for every {@link BaseMetaClient} subclass.
 *
 * Each concrete client (WhatsApp, Messenger, Instagram) passes a factory that
 * yields a fresh instance against its fixture data. `runBaseMetaClientContract`
 * exercises the shared template-method surface — webhook verification, payload
 * normalization, handler dispatch, per-handler error aggregation — so every
 * client is provably compatible with the base.
 *
 * The harness relies on `bun:test`. Callers wire it up inside their own test
 * file under the package's `test/` folder.
 */

import { describe, it, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { PlatformClient } from '@kuralle-agents/messaging';

/** Fixtures a subclass must provide for the shared contract. */
export interface BaseMetaClientContractFixtures {
  /** App secret that will sign the POST payloads below. */
  appSecret: string;
  /** Verify token matching the GET subscription challenge. */
  verifyToken: string;
  /** A valid inbound message payload for this platform. Will be HMAC-signed. */
  inboundMessagePayload: unknown;
  /** ID of the message inside `inboundMessagePayload` so handlers can assert on it. */
  expectedMessageId: string;
}

/** Factory signature supplied to {@link runBaseMetaClientContract}. */
export type BaseMetaClientFactory = (
  overrides?: { onHandlerError?: (errors: Array<{ error: Error }>) => void },
) => PlatformClient;

/**
 * Run the shared contract suite.
 *
 * @param name     - `describe` label (typically the platform name).
 * @param factory  - Builds a fresh client per test. Accepts optional overrides
 *                   to inject an `onHandlerError` capture for the error
 *                   aggregation test.
 * @param fixtures - Platform-specific fixtures.
 */
export function runBaseMetaClientContract(
  name: string,
  factory: BaseMetaClientFactory,
  fixtures: BaseMetaClientContractFixtures,
): void {
  describe(`BaseMetaClient contract — ${name}`, () => {
    const sign = (rawBody: string): string =>
      'sha256=' + createHmac('sha256', fixtures.appSecret).update(rawBody).digest('hex');

    const postRequest = (body: unknown): Request => {
      const raw = JSON.stringify(body);
      return new Request('https://localhost/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
        },
        body: raw,
      });
    };

    it('GET subscribe + matching verify_token returns the challenge', async () => {
      const client = factory();
      const req = new Request(
        `https://localhost/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
          fixtures.verifyToken,
        )}&hub.challenge=abc123`,
        { method: 'GET' },
      );
      const res = await client.handleWebhook(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('abc123');
    });

    it('GET subscribe with wrong verify_token returns 403', async () => {
      const client = factory();
      const req = new Request(
        'https://localhost/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc',
        { method: 'GET' },
      );
      const res = await client.handleWebhook(req);
      expect(res.status).toBe(403);
    });

    it('POST without signature returns 401', async () => {
      const client = factory();
      const req = new Request('https://localhost/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fixtures.inboundMessagePayload),
      });
      const res = await client.handleWebhook(req);
      expect(res.status).toBe(401);
    });

    it('POST with tampered signature returns 401', async () => {
      const client = factory();
      const req = new Request('https://localhost/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=' + 'f'.repeat(64),
        },
        body: JSON.stringify(fixtures.inboundMessagePayload),
      });
      const res = await client.handleWebhook(req);
      expect(res.status).toBe(401);
    });

    it('POST with valid signature dispatches to every message handler', async () => {
      const client = factory();
      const seen: string[] = [];
      client.onMessage(async (msg) => {
        seen.push(msg.id);
      });
      client.onMessage(async (msg) => {
        seen.push(`${msg.id}-b`);
      });

      const res = await client.handleWebhook(postRequest(fixtures.inboundMessagePayload));
      expect(res.status).toBe(200);
      expect(seen).toContain(fixtures.expectedMessageId);
      expect(seen).toContain(`${fixtures.expectedMessageId}-b`);
    });

    it('one failing handler does not block siblings; errors surface via onHandlerError', async () => {
      const capture: Array<{ error: Error }> = [];
      const client = factory({
        onHandlerError: (errors) => {
          for (const e of errors) capture.push(e);
        },
      });

      let siblingRan = false;
      client.onMessage(async () => {
        throw new Error('boom');
      });
      client.onMessage(async () => {
        siblingRan = true;
      });

      const res = await client.handleWebhook(postRequest(fixtures.inboundMessagePayload));
      expect(res.status).toBe(200);
      expect(siblingRan).toBe(true);
      expect(capture.length).toBeGreaterThanOrEqual(1);
      expect(capture[0].error.message).toBe('boom');
    });
  });
}
