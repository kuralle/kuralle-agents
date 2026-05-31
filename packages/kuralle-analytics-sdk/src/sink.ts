/**
 * Sink abstraction for analytics delivery.
 *
 * Built-in: HttpSink (POST batches to the Kuralle Analytics API). Custom
 * sinks (stdout, S3, Kafka, OpenTelemetry exporter) implement `Sink` and are
 * passed into `KuralleAnalytics` via `config.sink`. The default HttpSink
 * preserves the pre-refactor behavior byte-for-byte.
 */

import type { AnalyticsEvent, VoiceCallData } from "./schema.js";

export interface Sink {
  /** Send a batch of events. Throw to trigger the batcher's retry path. */
  sendEvents(events: AnalyticsEvent[]): Promise<void>;
  /** Send a completed voice call record (sent synchronously, not batched). */
  sendVoiceCall(data: VoiceCallData): Promise<void>;
  /** Update an in-flight voice call record. */
  updateVoiceCall(sessionId: string, data: Partial<VoiceCallData>): Promise<void>;
}

export interface HttpSinkOptions {
  endpoint: string;
  apiKey: string;
  enableDebug?: boolean;
}

export class HttpSink implements Sink {
  constructor(private readonly options: HttpSinkOptions) {}

  async sendEvents(events: AnalyticsEvent[]): Promise<void> {
    const response = await fetch(`${this.options.endpoint}/events`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ events }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send events: ${error}`);
    }
  }

  async sendVoiceCall(data: VoiceCallData): Promise<void> {
    if (this.options.enableDebug) {
      console.log("[Analytics] Tracking voice call:", data.sessionId);
    }
    const response = await fetch(`${this.options.endpoint}/voice-call`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to track voice call: ${error}`);
    }
  }

  async updateVoiceCall(sessionId: string, data: Partial<VoiceCallData>): Promise<void> {
    if (this.options.enableDebug) {
      console.log("[Analytics] Updating voice call:", sessionId);
    }
    const response = await fetch(`${this.options.endpoint}/voice-call/${sessionId}`, {
      method: "PUT",
      headers: this.jsonHeaders(),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update voice call: ${error}`);
    }
  }

  private jsonHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.apiKey}`,
    };
  }
}
