/**
 * The KuralleAnalytics client. Wires together the Batcher and a Sink,
 * enriches events with context, and runs Zod validation before enqueue.
 */

import { Batcher } from "./batcher.js";
import { HttpSink, type Sink } from "./sink.js";
import {
  validateAnalyticsEvent,
  type AnalyticsClient,
  type AnalyticsConfig,
  type AnalyticsContext,
  type AnalyticsEvent,
  type VoiceCallData,
} from "./schema.js";

export interface KuralleAnalyticsInternalConfig extends AnalyticsConfig {
  /** Override the default HttpSink (for stdout, S3, tests, etc.). */
  sink?: Sink;
}

export class KuralleAnalytics implements AnalyticsClient {
  private config: Required<AnalyticsConfig>;
  private batcher: Batcher;
  private context: AnalyticsContext;
  private userId?: string;
  private userTraits?: Record<string, unknown>;
  private sink: Sink;

  constructor(config: KuralleAnalyticsInternalConfig) {
    this.config = {
      apiKey: config.apiKey,
      endpoint: config.endpoint ?? "https://analytics.kuralle.dev/api/v1",
      workspaceId: config.workspaceId,
      flushInterval: config.flushInterval ?? 5000,
      maxBatchSize: config.maxBatchSize ?? 20,
      enableDebug: config.enableDebug ?? false,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 500,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 30_000,
      retryMaxAttempts: config.retryMaxAttempts ?? 5,
    };

    this.context = { workspaceId: this.config.workspaceId };

    this.sink = config.sink ?? new HttpSink({
      endpoint: this.config.endpoint,
      apiKey: this.config.apiKey,
      enableDebug: this.config.enableDebug,
    });

    this.batcher = new Batcher({
      maxBatchSize: this.config.maxBatchSize,
      flushInterval: this.config.flushInterval,
      onFlush: (events) => this.sink.sendEvents(events),
      enableDebug: this.config.enableDebug,
      retryBaseDelayMs: this.config.retryBaseDelayMs,
      retryMaxDelayMs: this.config.retryMaxDelayMs,
      retryMaxAttempts: this.config.retryMaxAttempts,
    });
  }

  async track(event: AnalyticsEvent): Promise<void> {
    const enriched = this.enrichEvent(event);
    // Validate AFTER enrichment so missing workspaceId/sessionId from config
    // fallbacks still pass. Throws loud on bad caller input.
    const validated = validateAnalyticsEvent(enriched);
    this.batcher.add(validated);
  }

  async trackBatch(events: AnalyticsEvent[]): Promise<void> {
    for (const event of events) {
      await this.track(event);
    }
  }

  async trackVoiceCall(data: VoiceCallData): Promise<void> {
    await this.sink.sendVoiceCall(data);
  }

  async updateVoiceCall(sessionId: string, data: Partial<VoiceCallData>): Promise<void> {
    await this.sink.updateVoiceCall(sessionId, data);
  }

  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  setContext(context: Partial<AnalyticsContext>): void {
    this.context = { ...this.context, ...context };
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    this.userId = userId;
    this.userTraits = traits;
  }

  private enrichEvent(event: AnalyticsEvent): AnalyticsEvent {
    return {
      ...event,
      workspaceId: event.workspaceId || this.context.workspaceId,
      sessionId: event.sessionId || this.context.sessionId || "",
      agentId: event.agentId || this.context.agentId || "",
      conversationId: event.conversationId ?? this.context.conversationId,
      timestamp: event.timestamp ?? new Date(),
      data: {
        ...event.data,
        userId: event.data.userId ?? this.userId,
        userTraits: this.userTraits,
      },
    };
  }

  destroy(): void {
    this.batcher.destroy();
  }
}

export function createAnalyticsClient(config: KuralleAnalyticsInternalConfig): AnalyticsClient {
  return new KuralleAnalytics(config);
}
