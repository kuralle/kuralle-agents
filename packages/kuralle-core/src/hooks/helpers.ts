import type { AgentContext, RunContext, HarnessHooks, ToolCallRecord, StepResult } from '../types/index.js';
import type { TracingConfig, Span, SpanEvent, MetricsConfig, ObservabilityMetrics, SessionTelemetry } from '../types/index.js';
import { TracingService } from '../services/TracingService.js';
import { InMemoryMetricsService } from '../services/MetricsService.js';

// Legacy Singleton for backward compatibility
const defaultTracingService = new TracingService();
let defaultMetricsService: ObservabilityMetrics | null = null;

// Re-export specific legacy functions delegated to services

export function initTracing(config: TracingConfig): void {
  defaultTracingService.init(config);
}

export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
  parentSpanId?: string
): Span {
  return defaultTracingService.startSpan(name, attributes, parentSpanId);
}

export function endSpan(span: Span, status?: 'success' | 'error', error?: Error): Span {
  return defaultTracingService.endSpan(span, status, error);
}

export function addSpanEvent(
  span: Span,
  name: string,
  attributes?: Record<string, string | number | boolean>
): void {
  defaultTracingService.addSpanEvent(span, name, attributes);
}

export function getCurrentSpan(): Span | undefined {
  return defaultTracingService.getCurrentSpan();
}

/**
 * Creates tracing hooks.
 * @param service Optional TracingService instance. If not provided, uses the global singleton (legacy).
 */
export function createTracingHooks(service: TracingService = defaultTracingService): HarnessHooks {
  return {
    onAgentStart: async (context, agentId) => {
      service.startSpan('agent.run', { agentId, sessionId: context.session.id });
    },

    onAgentEnd: async (context) => {
      const span = service.getCurrentSpan();
      if (span) {
        service.endSpan(span, 'success');
      }
    },

    onStepStart: async (context, step) => {
      service.startSpan('agent.step', { step, agentId: context.agentId });
    },

    onStepEnd: async (context, step, result) => {
      const span = service.getCurrentSpan();
      if (span) {
        service.endSpan(span, 'success');
      }
    },

    onToolCall: async (context, call) => {
      service.startSpan('tool.call', {
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      });
    },

    onToolResult: async (context, call) => {
      const span = service.getCurrentSpan();
      if (span) {
        service.addSpanEvent(span, 'tool.result', {
          success: String(call.success),
          durationMs: call.durationMs ?? 0,
        });
        service.endSpan(span, call.success ? 'success' : 'error', call.error);
      }
    },

    onHandoff: async (context, from, to, reason) => {
      service.startSpan('agent.handoff', { from, to, reason });
      service.endSpan(service.getCurrentSpan()!, 'success');
    },

    onError: async (context, error) => {
      const span = service.getCurrentSpan();
      if (span) {
        service.endSpan(span, 'error', error);
      }
    },
  };
}

// Metrics delegation

export function createObservabilityMetrics(config: MetricsConfig = {}): ObservabilityMetrics {
  return new InMemoryMetricsService(config);
}

export function initMetrics(metrics: ObservabilityMetrics): void {
  defaultMetricsService = metrics;
}

export function getMetrics(): ObservabilityMetrics {
  if (!defaultMetricsService) {
    throw new Error('Metrics not initialized. Call initMetrics() first.');
  }
  return defaultMetricsService;
}

export function createObservabilityHooks(service: ObservabilityMetrics = getMetrics()): HarnessHooks {
  const metrics = service;

  return {
    onStart: async (context) => {
      metrics.increment('run.start', 1, { agent: context.agentId });
      metrics.gauge('run.active', 1);
    },

    onEnd: async (context, result) => {
      const duration = Date.now() - context.startTime;
      metrics.increment(result.success ? 'run.success' : 'run.failure');
      metrics.gauge('run.active', -1);
      metrics.timing('run.duration', duration);
      metrics.histogram('run.steps', context.stepCount);
      metrics.histogram('run.tokens', context.totalTokens);
      metrics.histogram('run.handoffs', context.handoffStack.length);
    },

    onStepStart: async (context, step) => {
      metrics.increment('step.start', 1, { agent: context.agentId });
    },

    onStepEnd: async (context, step, result) => {
      metrics.increment('step.end', 1, { agent: context.agentId, reason: result.finishReason });
    },

    onToolCall: async (context, call) => {
      metrics.increment('tool.call', 1, { tool: call.toolName });
    },

    onToolResult: async (context, call) => {
      metrics.increment('tool.result', 1, { tool: call.toolName, success: String(call.success) });
      if (call.durationMs) {
        metrics.timing('tool.duration', call.durationMs, { tool: call.toolName });
      }
    },

    onToolError: async (context, call) => {
      metrics.increment('tool.error', 1, { tool: call.toolName });
    },

    onHandoff: async (context, from, to) => {
      metrics.increment('handoff', 1, { from, to });
    },

    onError: async () => {
      metrics.increment('error', 1);
    },
  };
}

export function captureSessionTelemetry(
  context: RunContext,
  result: { success: boolean; error?: Error }
): SessionTelemetry {
  return {
    sessionId: context.session.id,
    agentId: context.agentId,
    startTime: new Date(context.startTime),
    endTime: new Date(),
    duration: Date.now() - context.startTime,
    steps: context.stepCount,
    tokens: context.totalTokens,
    toolCalls: context.toolCallHistory.length,
    errors: context.toolCallHistory.filter(c => !c.success).length,
    handoffs: context.handoffStack.length,
    success: result.success,
  };
}

export function createTelemetryHooks(): HarnessHooks {
  const sessions: SessionTelemetry[] = [];

  return {
    onStart: async (context) => {
      sessions.push({
        sessionId: context.session.id,
        agentId: context.agentId,
        startTime: new Date(),
        steps: 0,
        tokens: 0,
        toolCalls: 0,
        errors: 0,
        handoffs: 0,
        success: false,
      });
    },

    onEnd: async (context, result) => {
      const session = sessions.find(s => s.sessionId === context.session.id);
      if (session) {
        session.endTime = new Date();
        session.duration = Date.now() - context.startTime;
        session.steps = context.stepCount;
        session.tokens = context.totalTokens;
        session.toolCalls = context.toolCallHistory.length;
        session.errors = context.toolCallHistory.filter(c => !c.success).length;
        session.handoffs = context.handoffStack.length;
        session.success = result.success;
      }
    },

    onStepEnd: async (context, step, result) => {
      const session = sessions.find(s => s.sessionId === context.session.id);
      if (session) {
        session.steps = step + 1;
        session.tokens += result.tokensUsed;
        session.toolCalls += result.toolCalls.length;
      }
    },
  };
}

// Previously removed generateSpanId is now in TracingService

