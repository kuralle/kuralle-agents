import { describe, expect, it } from 'bun:test';
import { langfuseSink, OtelTraceSink, toOtlpPayload } from '../../src/tracing/OtelTraceSink.js';
import type { AgentSpan } from '../../src/types/trace.js';

const span: AgentSpan = {
  traceId: '00112233445566778899aabbccddeeff',
  spanId: '0011223344556677',
  parentSpanId: '8899aabbccddeeff',
  name: 'tool:lookup',
  kind: 'tool',
  startTime: 1000,
  endTime: 1002,
  status: 'error',
  attributes: { sessionId: 's-1', toolName: 'lookup', input: { id: 7 }, error: 'offline' },
  events: [{ name: 'retry', time: 1001, attributes: { attempt: 2 } }],
};

describe('OtelTraceSink', () => {
  it('maps AgentSpan to OTLP HTTP/JSON shape', () => {
    const mapped = toOtlpPayload([span], 'support-agent');
    const output = mapped.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(output.traceId).toBe(span.traceId);
    expect(output.spanId).toBe(span.spanId);
    expect(output.parentSpanId).toBe(span.parentSpanId);
    expect(output.startTimeUnixNano).toBe('1000000000');
    expect(output.status.code).toBe(2);
    expect(output.attributes).toContainEqual({ key: 'kuralle.toolName', value: { stringValue: 'lookup' } });
    expect(output.events[0]?.name).toBe('retry');
  });

  it('posts batches to /v1/traces and configures Langfuse basic auth', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const sink = new OtelTraceSink({ endpoint: 'https://otel.test', fetch: transport });
    sink.write(span);
    await sink.flush();
    expect(requests[0]?.url).toBe('https://otel.test/v1/traces');

    const langfuse = langfuseSink({ endpoint: 'https://lf.test/api/public/otel', publicKey: 'pk', secretKey: 'sk', fetch: transport });
    langfuse.write(span);
    await langfuse.flush();
    expect(new Headers(requests[1]?.init?.headers).get('authorization')).toBe(`Basic ${btoa('pk:sk')}`);
    expect(new Headers(requests[1]?.init?.headers).get('x-langfuse-ingestion-version')).toBe('4');
  });
});
