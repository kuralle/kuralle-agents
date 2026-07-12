import type { AgentSpan } from '../types/trace.js';
import type { TraceSink } from './TraceStore.js';

export interface OtelTraceSinkOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  batchSize?: number;
  fetch?: typeof fetch;
}

export class OtelTraceSink implements TraceSink {
  private readonly pending: AgentSpan[] = [];
  private exporting?: Promise<void>;

  constructor(private readonly options: OtelTraceSinkOptions) {}

  write(span: AgentSpan): Promise<void> | void {
    this.pending.push(structuredClone(span));
    if (this.pending.length >= (this.options.batchSize ?? 32)) return this.flush();
  }

  async flush(): Promise<void> {
    if (this.exporting) await this.exporting;
    if (this.pending.length === 0) return;
    const spans = this.pending.splice(0);
    this.exporting = this.export(spans).finally(() => { this.exporting = undefined; });
    await this.exporting;
  }

  private async export(spans: AgentSpan[]): Promise<void> {
    const transport = this.options.fetch ?? globalThis.fetch;
    const response = await transport(otlpUrl(this.options.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.options.headers },
      body: JSON.stringify(toOtlpPayload(spans, this.options.serviceName)),
    });
    if (!response.ok) throw new Error(`OTLP trace export failed: ${response.status}`);
  }
}

export function otelSink(options: OtelTraceSinkOptions): OtelTraceSink {
  return new OtelTraceSink(options);
}

export interface LangfuseSinkOptions {
  endpoint?: string;
  publicKey: string;
  secretKey: string;
  serviceName?: string;
  batchSize?: number;
  fetch?: typeof fetch;
}

export function langfuseSink(options: LangfuseSinkOptions): OtelTraceSink {
  return new OtelTraceSink({
    endpoint: options.endpoint ?? 'https://cloud.langfuse.com/api/public/otel',
    headers: {
      Authorization: `Basic ${btoa(`${options.publicKey}:${options.secretKey}`)}`,
      'x-langfuse-ingestion-version': '4',
    },
    serviceName: options.serviceName,
    batchSize: options.batchSize,
    fetch: options.fetch,
  });
}

export function toOtlpPayload(spans: AgentSpan[], serviceName = 'kuralle-agent') {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: '@kuralle-agents/core' },
        spans: spans.map(toOtlpSpan),
      }],
    }],
  };
}

function toOtlpSpan(span: AgentSpan) {
  return {
    traceId: normalizeHex(span.traceId, 32),
    spanId: normalizeHex(span.spanId, 16),
    ...(span.parentSpanId ? { parentSpanId: normalizeHex(span.parentSpanId, 16) } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: millisecondsToNanos(span.startTime),
    endTimeUnixNano: millisecondsToNanos(span.endTime ?? span.startTime),
    attributes: [
      otlpAttribute('kuralle.kind', span.kind),
      ...Object.entries(span.attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => otlpAttribute(`kuralle.${key}`, value)),
    ],
    events: (span.events ?? []).map((event) => ({
      name: event.name,
      timeUnixNano: millisecondsToNanos(event.time),
      attributes: Object.entries(event.attributes ?? {}).map(([key, value]) => otlpAttribute(`kuralle.${key}`, value)),
    })),
    status: { code: span.status === 'error' ? 2 : 1 },
  };
}

function otlpAttribute(key: string, value: unknown) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number' && Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } };
}

function normalizeHex(value: string, length: number): string {
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.padStart(length, '0').slice(-length);
}

function millisecondsToNanos(value: number): string {
  return (BigInt(Math.trunc(value)) * 1_000_000n).toString();
}

function otlpUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, '');
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}
