import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface TestMemoryEnv {
  TEST_MEMORY_DO: DurableObjectNamespace;
}

describe('test:sql-memory-workers', () => {
  it('SqlPersistentMemoryStore round-trips in workerd DO sqlite', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const id = bindings.TEST_MEMORY_DO.idFromName('memory-durability');
    const stub = bindings.TEST_MEMORY_DO.get(id);
    const response = await stub.fetch('http://do/roundtrip');
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { content: string | null };
    expect(body.content).toBe('workerd-durable');
  });

  it('SqlTraceStore round-trips JSON in workerd DO sqlite', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const stub = bindings.TEST_MEMORY_DO.get(bindings.TEST_MEMORY_DO.idFromName('trace-durability'));
    const response = await stub.fetch('http://do/trace-roundtrip');
    expect(response.ok).toBe(true);
    const trace = (await response.json()) as { traceId: string; sessionId: string; spans: unknown[] };
    expect(trace.traceId).toBe('workerd-trace');
    expect(trace.sessionId).toBe('workerd-session');
    expect(trace.spans).toHaveLength(1);
  });

  it('exports OTLP HTTP/JSON with fetch in workerd', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const stub = bindings.TEST_MEMORY_DO.get(bindings.TEST_MEMORY_DO.idFromName('otel-export'));
    const response = await stub.fetch('http://do/otel-smoke');
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { resourceSpans: unknown[] };
    expect(payload.resourceSpans).toHaveLength(1);
  });
});
