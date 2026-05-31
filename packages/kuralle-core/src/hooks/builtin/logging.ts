import type { HarnessHooks, RunContext, StepResult, ToolCallRecord } from '../../types/index.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  traceId?: string;
  data?: Record<string, unknown>;
}

function log(level: LogLevel, message: string, context?: RunContext, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'kuralle',
    message,
    traceId: context?.session.id,
    data,
  };

  console.log(JSON.stringify(entry));
}

export const loggingHooks: HarnessHooks = {
  onStart: async (context) => {
    log('info', 'Agent run started', context, {
      sessionId: context.session.id,
      agentId: context.agentId,
      userId: context.session.userId,
    });
  },

  onEnd: async (context, result) => {
    const duration = Date.now() - context.startTime;
    log('info', 'Agent run completed', context, {
      success: result.success,
      error: result.error?.message,
      duration,
      steps: context.stepCount,
      tokens: context.totalTokens,
      handoffs: context.handoffStack.length,
    });
  },

  onStepStart: async (context, step) => {
    log('debug', `Step ${step} started`, context, { step, agentId: context.agentId });
  },

  onStepEnd: async (context, step, result) => {
    log('debug', `Step ${step} completed`, context, {
      step,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.length,
      tokens: result.tokensUsed,
    });
  },

  onToolCall: async (context, call) => {
    log('info', `Tool called: ${call.toolName}`, context, {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
    });
  },

  onToolResult: async (context, call) => {
    log('debug', `Tool completed: ${call.toolName}`, context, {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      success: call.success,
      durationMs: call.durationMs,
      resultPreview: JSON.stringify(call.result)?.slice(0, 200),
    });
  },

  onToolError: async (context, call, error) => {
    log('error', `Tool failed: ${call.toolName}`, context, {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      error: error.message,
      stack: error.stack,
    });
  },

  onHandoff: async (context, from, to, reason) => {
    log('info', `Agent handoff: ${from} -> ${to}`, context, { from, to, reason });
  },

  onError: async (context, error) => {
    log('error', 'Agent error', context, {
      error: error.message,
      stack: error.stack,
      step: context.stepCount,
    });
  },

  onAgentStart: async (context, agentId) => {
    log('info', `Agent started: ${agentId}`, context, { agentId });
  },

  onAgentEnd: async (context, agentId) => {
    log('info', `Agent ended: ${agentId}`, context, { agentId });
  },
};

export function createLoggingHooks(
  logFn: (level: LogLevel, message: string, data?: Record<string, unknown>) => void
): HarnessHooks {
  const customLog = (
    level: LogLevel,
    message: string,
    context?: RunContext,
    data?: Record<string, unknown>
  ): void => {
    logFn(level, message, {
      ...data,
      traceId: context?.session.id,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    onStart: async (ctx) => customLog('info', 'Agent started', ctx, { agentId: ctx.agentId }),
    onEnd: async (ctx, r) => customLog('info', 'Agent ended', ctx, { success: r.success }),
    onToolCall: async (ctx, c) => customLog('info', `Tool: ${c.toolName}`, ctx, { args: c.args }),
    onHandoff: async (ctx, f, t, r) => customLog('info', `Handoff: ${f}->${t}`, ctx, { reason: r }),
    onError: async (ctx, e) => customLog('error', 'Error', ctx, { error: e.message }),
  };
}
