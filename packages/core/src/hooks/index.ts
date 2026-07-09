export { HookRunner, createHookRunner } from './HookRunner.js';
export { loggingHooks, createLoggingHooks } from './builtin/logging.js';
export { createMetricsHooks, InMemoryMetrics } from './builtin/metrics.js';
export type { Metrics } from './builtin/metrics.js';

export { TracingService } from '../services/TracingService.js';
export { MetricsService, InMemoryMetricsService } from '../services/MetricsService.js';

export type {
  TracingConfig,
  Span,
  SpanEvent,
  ObservabilityMetrics,
  SessionTelemetry,
} from '../types/index.js';

export {
  initTracing,
  startSpan,
  endSpan,
  addSpanEvent,
  getCurrentSpan,
  createTracingHooks,
  initMetrics,
  getMetrics,
  createObservabilityMetrics,
  createObservabilityHooks,
  createTelemetryHooks,
  captureSessionTelemetry,
} from './helpers.js';

