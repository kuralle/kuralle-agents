/**
 * @kuralle-agents/analytics-sdk public barrel. The implementation is split
 * across schema.ts / sink.ts / batcher.ts / emitter.ts to keep each file
 * focused and under the 250-LOC file budget.
 */

export type {
  AnalyticsEvent,
  AnalyticsEventType,
  AnalyticsConfig,
  AnalyticsContext,
  AnalyticsClient,
  VoiceCallData,
} from "./schema.js";

export { AnalyticsEventSchema, validateAnalyticsEvent } from "./schema.js";

export { Batcher } from "./batcher.js";
export type { BatcherOptions } from "./batcher.js";

export type { Sink, HttpSinkOptions } from "./sink.js";
export { HttpSink } from "./sink.js";

export { KuralleAnalytics, createAnalyticsClient } from "./emitter.js";
export type { KuralleAnalyticsInternalConfig } from "./emitter.js";

export { KuralleAnalytics as default } from "./emitter.js";
