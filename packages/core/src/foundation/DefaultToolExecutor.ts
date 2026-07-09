import crypto from 'node:crypto';
import type { ToolExecutionOptions as AIToolExecutionOptions } from 'ai';
import type { Session, ToolCallRecord, EnforcementContext } from '../types/index.js';
import type { ToolExecutor, ExecutableTool } from './ToolExecutor.js';
import type { ToolEnforcer } from '../guards/ToolEnforcer.js';
import type { HookRunner } from '../hooks/HookRunner.js';
import type { MemoryService } from '../memory/MemoryService.js';
import { isRecord } from '../utils/isRecord.js';

export interface DefaultToolExecutorConfig {
  enforcer: ToolEnforcer;
  hookRunner: HookRunner;
  memoryService?: MemoryService;
  /** Default timeout in milliseconds for tool execution. Defaults to 30000 (30s). */
  defaultToolTimeoutMs?: number;
}

/**
 * Error thrown when a tool execution exceeds the configured timeout.
 */
export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timeout after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Default tool executor extracted from Runtime.wrapToolsWithEnforcement().
 *
 * Handles:
 * - Enforcement checks via ToolEnforcer
 * - Idempotency key generation
 * - Context enrichment (experimental_context)
 * - Error propagation via HookRunner
 */
export class DefaultToolExecutor implements ToolExecutor {
  private enforcer: ToolEnforcer;
  private hookRunner: HookRunner;
  private memoryService?: MemoryService;
  private defaultToolTimeoutMs?: number;

  constructor(config: DefaultToolExecutorConfig) {
    this.enforcer = config.enforcer;
    this.hookRunner = config.hookRunner;
    this.memoryService = config.memoryService;
    this.defaultToolTimeoutMs = config.defaultToolTimeoutMs;
  }

  async execute(args: {
    session: Session;
    userId?: string;
    agentId: string;
    toolName: string;
    tool: ExecutableTool;
    input: unknown;
    toolCallId?: string;
    abortSignal?: AbortSignal;
    step?: number;
    turn?: number;
    toolCallHistory?: ToolCallRecord[];
  }): Promise<unknown> {
    const {
      session,
      agentId,
      toolName,
      tool,
      input,
      step = 0,
      turn = 0,
      toolCallHistory = [],
    } = args;

    const toolCallId = args.toolCallId ?? crypto.randomUUID();
    const idempotencyKey = this.buildIdempotencyKey({
      sessionId: session.id,
      agentId,
      step,
      toolName,
      toolCallId,
    });

    const callRecord: ToolCallRecord = {
      toolCallId,
      toolName,
      args: input,
      idempotencyKey,
      success: true,
      timestamp: Date.now(),
    };

    // Enforcement check
    const enforcement = await this.enforcer.check(callRecord, {
      previousCalls: toolCallHistory,
      currentStep: step,
      sessionState: session.state ?? {},
    });

    if (!enforcement.allowed) {
      const reason = enforcement.reason ?? 'Tool call blocked by enforcement';
      callRecord.success = false;
      callRecord.error = new Error(reason);
      toolCallHistory.push(callRecord);

      const runContext = {
        session,
        agentId,
        stepCount: step,
        totalTokens: 0,
        handoffStack: [],
        startTime: Date.now(),
        consecutiveErrors: 0,
        toolCallHistory,
      };
      await this.hookRunner.onToolError(runContext, callRecord, callRecord.error);
      throw callRecord.error;
    }

    // Build enriched options for the tool's execute function
    if (!('execute' in tool) || typeof tool.execute !== 'function') {
      throw new Error(`Tool "${toolName}" does not have an execute function`);
    }

    const enrichedOptions = this.withToolExecutionMetadata(
      undefined,
      { session, agentId, step, turn, toolName, toolCallId, idempotencyKey },
    );

    try {
      const timeoutMs =
        (tool as ExecutableTool & { timeout?: number }).timeout ??
        this.defaultToolTimeoutMs ??
        30_000;
      const exec = tool.execute.bind(tool);
      const result = await Promise.race([
        exec(input, enrichedOptions),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new ToolTimeoutError(toolName, timeoutMs)),
            timeoutMs,
          );
          if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as NodeJS.Timeout).unref();
          }
        }),
      ]);
      return result;
    } catch (error) {
      console.error(`[ToolExecutor] Tool execution failed for ${toolName}:`, error);
      throw error;
    }
  }

  buildIdempotencyKey(args: {
    sessionId: string;
    agentId: string;
    step: number;
    toolName: string;
    toolCallId: string;
  }): string {
    return `${args.sessionId}:${args.agentId}:${args.step}:${args.toolName}:${args.toolCallId}`;
  }

  private withToolExecutionMetadata(
    options: AIToolExecutionOptions | undefined,
    ctx: {
      session: Session;
      agentId: string;
      step: number;
      turn: number;
      toolName: string;
      toolCallId: string;
      idempotencyKey: string;
    },
  ): AIToolExecutionOptions {
    const baseOptions: AIToolExecutionOptions = options ?? {
      toolCallId: ctx.toolCallId,
      messages: [],
    };
    const existingContext = isRecord(baseOptions.experimental_context)
      ? baseOptions.experimental_context
      : {};

    return {
      ...baseOptions,
      toolCallId: ctx.toolCallId,
      experimental_context: {
        ...existingContext,
        session: ctx.session,
        sessionId: ctx.session.id,
        agentId: ctx.agentId,
        step: ctx.step,
        turn: ctx.turn,
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        idempotencyKey: ctx.idempotencyKey,
        memoryService: this.memoryService,
      },
    };
  }
}
