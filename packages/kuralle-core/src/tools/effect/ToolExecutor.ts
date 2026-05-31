import { randomUUID } from 'node:crypto';
import type { Session, ToolCallRecord } from '../../types/session.js';
import type { EffectToolExecutor, ToolContext } from '../../types/run-context.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import type { ToolEnforcer } from '../../guards/ToolEnforcer.js';
import {
  cancelledPlaceholder,
  inProgressPlaceholder,
  PairingTracker,
  type ToolCallPair,
} from './pairing.js';
import { ToolValidationError, validateAndSanitize, validateOutput } from './schema.js';

export interface CoreToolExecutorConfig {
  tools: Record<string, AnyTool>;
  enforcer?: ToolEnforcer;
  parallelExecution?: boolean;
  agentId?: string;
  onInterim?: (message: string, toolName: string) => void;
}

export interface CoreExecuteArgs {
  name: string;
  args: unknown;
  session: Session;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  toolCtx?: ToolContext;
  /**
   * Explicit tool definition for per-node (flow-local) tools that are not in
   * the executor's registry. When present it's used in preference to the
   * registry so local tools get the same validation/interim/pairing path.
   */
  def?: AnyTool;
}

export class CoreToolExecutor implements EffectToolExecutor {
  private readonly tools: Map<string, Tool>;
  private readonly enforcer?: ToolEnforcer;
  private readonly parallelExecution: boolean;
  private readonly agentId: string;
  private readonly onInterim?: (message: string, toolName: string) => void;
  private readonly pairing = new PairingTracker();
  private executionGate: Promise<void> = Promise.resolve();
  private callHistory: ToolCallRecord[] = [];

  constructor(config: CoreToolExecutorConfig) {
    this.tools = new Map(Object.entries(config.tools));
    this.enforcer = config.enforcer;
    this.parallelExecution = config.parallelExecution ?? false;
    this.agentId = config.agentId ?? 'agent';
    this.onInterim = config.onInterim;
  }

  getPairs(): ToolCallPair[] {
    return this.pairing.getAllPairs();
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(args: CoreExecuteArgs): Promise<unknown> {
    if (!this.parallelExecution) {
      return this.withSerialGate(() => this.executeInner(args));
    }
    return this.executeInner(args);
  }

  private async withSerialGate<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.executionGate;
    let release!: () => void;
    this.executionGate = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async executeInner(args: CoreExecuteArgs): Promise<unknown> {
    const { name, session, abortSignal, toolCallId, toolCtx } = args;
    const def = this.tools.get(name) ?? args.def;
    if (!def) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const requestId: string = toolCallId ?? randomUUID();
    this.pairing.openRequest(name, args.args, requestId);

    if (abortSignal?.aborted) {
      const placeholder = cancelledPlaceholder(requestId, name);
      this.pairing.closePair(requestId, 'cancelled', placeholder);
      return placeholder;
    }

    let sanitizedArgs: unknown;
    try {
      sanitizedArgs = await validateAndSanitize(def.input, args.args, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pairing.closePair(requestId, 'validation_failed', undefined, message);
      throw error;
    }

    const callRecord: ToolCallRecord = {
      toolCallId: requestId,
      toolName: name,
      args: sanitizedArgs,
      success: true,
      timestamp: Date.now(),
    };

    if (this.enforcer) {
      const enforcement = await this.enforcer.check(callRecord, {
        previousCalls: this.callHistory,
        currentStep: this.callHistory.length,
        sessionState: session.state ?? {},
      });
      if (!enforcement.allowed) {
        const reason = enforcement.reason ?? 'Tool call blocked by enforcement';
        callRecord.success = false;
        callRecord.error = new Error(reason);
        this.callHistory.push(callRecord);
        this.pairing.closePair(requestId, 'validation_failed', undefined, reason);
        throw callRecord.error;
      }
    }

    let interimTimer: ReturnType<typeof setTimeout> | undefined;
    let interimSent = false;

    const onAbort = (): void => {
      if (interimTimer) clearTimeout(interimTimer);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (def.interim && def.interimAfterMs != null && def.interimAfterMs >= 0) {
        interimTimer = setTimeout(() => {
          interimSent = true;
          this.onInterim?.(def.interim!, name);
          this.pairing.closePair(
            requestId,
            'in_progress',
            inProgressPlaceholder(requestId, name, def.interim),
          );
        }, def.interimAfterMs);
        if (typeof interimTimer === 'object' && 'unref' in interimTimer) {
          (interimTimer as NodeJS.Timeout).unref();
        }
      }

      const executePromise = Promise.resolve(
        def.execute(sanitizedArgs, toolCtx),
      ).then(async (result) => {
        if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
          const chunks: unknown[] = [];
          for await (const chunk of result as AsyncIterable<unknown>) {
            chunks.push(chunk);
          }
          return chunks.length === 1 ? chunks[0] : chunks;
        }
        return result;
      });

      const abortPromise =
        abortSignal && def.interruptible !== false
          ? new Promise<never>((_, reject) => {
              if (abortSignal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              abortSignal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            })
          : null;

      const rawResult = abortPromise
        ? await Promise.race([executePromise, abortPromise])
        : await executePromise;

      if (interimTimer) clearTimeout(interimTimer);

      const validated = await validateOutput(def.output, rawResult, name);
      callRecord.result = validated;
      callRecord.durationMs = Date.now() - callRecord.timestamp;
      this.callHistory.push(callRecord);

      if (!interimSent) {
        this.pairing.closePair(requestId, 'completed', validated);
      } else {
        this.pairing.closePair(requestId, 'completed', validated);
      }

      return validated;
    } catch (error) {
      if (interimTimer) clearTimeout(interimTimer);

      if (error instanceof DOMException && error.name === 'AbortError') {
        const placeholder = cancelledPlaceholder(requestId, name);
        callRecord.success = false;
        callRecord.error = error;
        callRecord.durationMs = Date.now() - callRecord.timestamp;
        this.callHistory.push(callRecord);
        this.pairing.closePair(requestId, 'cancelled', placeholder);
        return placeholder;
      }

      if (error instanceof ToolValidationError) {
        this.pairing.closePair(requestId, 'validation_failed', undefined, error.message);
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      callRecord.success = false;
      callRecord.error = err;
      callRecord.durationMs = Date.now() - callRecord.timestamp;
      this.callHistory.push(callRecord);
      this.pairing.closePair(requestId, 'completed', undefined, err.message);
      throw err;
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
  }
}
