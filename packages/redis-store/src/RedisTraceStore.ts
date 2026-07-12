import type { AgentSpan, AgentTrace, TraceListWindow, TraceStore } from '@kuralle-agents/core';
import { traceFromSpans } from '@kuralle-agents/core/tracing';
import type { RedisClientLike } from './RedisSessionStore.js';
import { callCommand, rangeByScore, setExpiration, setScore } from './redisHelpers.js';

export interface RedisTraceStoreOptions {
  client: RedisClientLike;
  prefix?: string;
  traceTtlSeconds?: number;
}

export class RedisTraceStore implements TraceStore {
  private readonly prefix: string;
  private queue = Promise.resolve();

  constructor(private readonly options: RedisTraceStoreOptions) {
    this.prefix = options.prefix ?? 'kuralle';
  }

  write(span: AgentSpan): Promise<void> { return this.putSpan(span); }

  putSpan(span: AgentSpan): Promise<void> {
    const operation = this.queue.then(() => this.putSpanDirect(span));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async getTrace(traceId: string): Promise<AgentTrace | null> {
    await this.queue;
    const raw = await callCommand<unknown>(this.options.client, ['get'], this.traceKey(traceId));
    if (!raw) return null;
    const spans = typeof raw === 'string' ? JSON.parse(raw) as AgentSpan[] : raw as AgentSpan[];
    return traceFromSpans(spans);
  }

  async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
    await this.queue;
    const min = window?.from?.getTime() ?? '-inf';
    const max = window?.to?.getTime() ?? '+inf';
    const ids = (await rangeByScore(this.options.client, this.sessionIndexKey(sessionId), min, max)).reverse();
    const selected = window?.limit === undefined ? ids : ids.slice(0, window.limit);
    const traces = await Promise.all(selected.map((id) => this.getTrace(id)));
    return traces.filter((trace): trace is AgentTrace => trace !== null);
  }

  flush(): Promise<void> { return this.queue; }

  private async putSpanDirect(span: AgentSpan): Promise<void> {
    const key = this.traceKey(span.traceId);
    const raw = await callCommand<unknown>(this.options.client, ['get'], key);
    const spans = raw
      ? (typeof raw === 'string' ? JSON.parse(raw) as AgentSpan[] : raw as AgentSpan[])
      : [];
    const index = spans.findIndex((entry) => entry.spanId === span.spanId);
    if (index >= 0) spans[index] = span; else spans.push(span);
    await callCommand(this.options.client, ['set'], key, JSON.stringify(spans));
    await setExpiration(this.options.client, key, this.options.traceTtlSeconds);
    await setScore(
      this.options.client,
      this.sessionIndexKey(span.attributes.sessionId),
      Math.min(...spans.map((entry) => entry.startTime)),
      span.traceId,
    );
    await setExpiration(this.options.client, this.sessionIndexKey(span.attributes.sessionId), this.options.traceTtlSeconds);
  }

  private traceKey(traceId: string): string { return `${this.prefix}:trace:${traceId}`; }
  private sessionIndexKey(sessionId: string): string { return `${this.prefix}:traces:${sessionId}`; }
}
