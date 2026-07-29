import type { EscalationOutcome, EscalationRequest } from '@kuralle-agents/core';
import { z } from 'zod';

export interface SupportOrder {
  id: string;
  status: 'processing' | 'shipped' | 'delivered' | 'cancelled';
  summary: string;
  placedAt: string;
  estimatedDelivery?: string;
  carrier?: string;
  trackingUrl?: string;
}

export interface SupportCase {
  id: string;
  status: 'queued';
  subject: string;
  createdAt: string;
}

export interface SupportBackend {
  lookupOrder(input: { customerId: string; orderId: string }): Promise<SupportOrder | null>;
  createCase(input: {
    customerId: string;
    subject: string;
    details: string;
    idempotencyKey: string;
  }): Promise<SupportCase>;
  queueEscalation(request: EscalationRequest): Promise<EscalationOutcome>;
}

const orderSchema = z.object({
  id: z.string(),
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  summary: z.string(),
  placedAt: z.string(),
  estimatedDelivery: z.string().optional(),
  carrier: z.string().optional(),
  trackingUrl: z.string().url().optional(),
});

const supportCaseSchema = z.object({
  id: z.string(),
  status: z.literal('queued'),
  subject: z.string(),
  createdAt: z.string(),
});

const escalationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('queued'), queueId: z.string(), estimatedWaitSec: z.number().optional() }),
  z.object({ status: z.literal('connected'), operatorId: z.string() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

export interface HttpSupportBackendOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Thin production adapter. Keep credentials and authorization in this server-side
 * boundary; the model sees only the minimum validated response fields.
 */
export function createHttpSupportBackend(options: HttpSupportBackendOptions): SupportBackend {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = options.token.trim();
  if (!token) throw new Error('SUPPORT_API_TOKEN is required for the HTTP support backend.');
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await call(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Support backend returned ${response.status}.`);
    return response.json();
  }

  return {
    async lookupOrder({ customerId, orderId }) {
      const result = await request(
        `/v1/customers/${encodeURIComponent(customerId)}/orders/${encodeURIComponent(orderId)}`,
        { method: 'GET' },
      );
      return result === null ? null : orderSchema.parse(result);
    },
    async createCase(input) {
      const result = await request('/v1/cases', {
        method: 'POST',
        headers: { 'idempotency-key': input.idempotencyKey },
        body: JSON.stringify(input),
      });
      return supportCaseSchema.parse(result);
    },
    async queueEscalation(escalation) {
      try {
        const result = await request('/v1/escalations', {
          method: 'POST',
          headers: { 'idempotency-key': `escalation:${escalation.sessionId}` },
          body: JSON.stringify(escalation),
        });
        return escalationSchema.parse(result);
      } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error.message : 'Escalation failed.' };
      }
    },
  };
}

/** Local evaluation fixture. It is deliberately rejected in production hosts. */
export function createDemoSupportBackend(): SupportBackend {
  const cases = new Map<string, SupportCase>();
  return {
    async lookupOrder({ orderId }) {
      if (orderId !== 'NS-100042') return null;
      return {
        id: orderId,
        status: 'shipped',
        summary: 'Northstar desk kit',
        placedAt: '2026-07-24T14:30:00.000Z',
        estimatedDelivery: '2026-08-01',
        carrier: 'Parcel North',
        trackingUrl: 'https://tracking.example.com/NS-100042',
      };
    },
    async createCase(input) {
      const existing = cases.get(input.idempotencyKey);
      if (existing) return existing;
      const created: SupportCase = {
        id: `CASE-${String(cases.size + 1).padStart(4, '0')}`,
        status: 'queued',
        subject: input.subject,
        createdAt: new Date().toISOString(),
      };
      cases.set(input.idempotencyKey, created);
      return created;
    },
    async queueEscalation(request) {
      return {
        status: 'queued',
        queueId: `HUMAN-${request.sessionId.slice(-8)}`,
        estimatedWaitSec: 600,
      };
    },
  };
}

export function supportBackendFromEnv(env: {
  SUPPORT_DEMO_MODE?: string;
  SUPPORT_API_URL?: string;
  SUPPORT_API_TOKEN?: string;
  production: boolean;
}): SupportBackend {
  if (env.SUPPORT_DEMO_MODE === 'true') {
    if (env.production) {
      throw new Error('SUPPORT_DEMO_MODE is forbidden in production. Configure SUPPORT_API_URL and SUPPORT_API_TOKEN.');
    }
    return createDemoSupportBackend();
  }
  return createHttpSupportBackend({
    baseUrl: required(env.SUPPORT_API_URL, 'SUPPORT_API_URL'),
    token: required(env.SUPPORT_API_TOKEN, 'SUPPORT_API_TOKEN'),
  });
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('SUPPORT_API_URL must use HTTPS, except on localhost.');
  }
  return url.toString().replace(/\/$/, '');
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
