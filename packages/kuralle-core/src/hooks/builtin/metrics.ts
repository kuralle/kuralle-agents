import type { HarnessHooks } from '../../types/index.js';
import type { Metrics } from '../../types/index.js';
import { InMemoryMetricsService } from '../../services/MetricsService.js';

export { Metrics };

// Re-export as alias for compatibility
export class InMemoryMetrics extends InMemoryMetricsService implements Metrics { }

export function createMetricsHooks(metrics: Metrics): HarnessHooks {
  const toolStartTimes = new Map<string, number>();

  return {
    onStart: async (context) => {
      metrics.increment('agent.starts', 1, { agent: context.agentId });
      metrics.gauge('agent.active', 1);
    },

    onEnd: async (context, result) => {
      const duration = Date.now() - context.startTime;

      metrics.increment(result.success ? 'agent.success' : 'agent.failure');
      metrics.gauge('agent.active', -1);
      metrics.timing('agent.duration', duration);
      metrics.histogram('agent.steps', context.stepCount);
      metrics.histogram('agent.tokens', context.totalTokens);
      metrics.histogram('agent.handoffs', context.handoffStack.length);
    },

    onToolCall: async (_context, call) => {
      metrics.increment('tool.calls', 1, { tool: call.toolName });
      toolStartTimes.set(call.toolCallId, Date.now());
    },

    onToolResult: async (_context, call) => {
      const startTime = toolStartTimes.get(call.toolCallId);
      if (startTime) {
        metrics.timing('tool.duration', Date.now() - startTime, { tool: call.toolName });
        toolStartTimes.delete(call.toolCallId);
      }
      metrics.increment('tool.success', 1, { tool: call.toolName });
    },

    onToolError: async (_context, call) => {
      const startTime = toolStartTimes.get(call.toolCallId);
      if (startTime) {
        metrics.timing('tool.duration', Date.now() - startTime, { tool: call.toolName });
        toolStartTimes.delete(call.toolCallId);
      }
      metrics.increment('tool.errors', 1, { tool: call.toolName });
    },

    onHandoff: async (_context, from, to) => {
      metrics.increment('agent.handoffs', 1, { from, to });
    },

    onError: async () => {
      metrics.increment('agent.errors');
    },

    onStreamPart: async (_context, part) => {
      // Capture flow-level metrics emitted as custom stream events
      if (part.type === 'custom' && typeof part.name === 'string' && part.name.startsWith('flow.')) {
        const data = part.data as Record<string, unknown> | undefined;
        if (data && typeof data.durationMs === 'number') {
          metrics.timing(part.name, data.durationMs);
        } else {
          metrics.increment(part.name);
        }
      }
    },
  };
}
