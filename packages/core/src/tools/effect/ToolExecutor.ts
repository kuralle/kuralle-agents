import { randomUUID } from 'node:crypto';
import { debug } from '../../debug.js';
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
import { ToolTimeoutError } from './errors.js';
import { ToolValidationError, validateAndSanitize, validateOutput } from './schema.js';
import { isControlFlowSignal } from '../../runtime/controlFlowSignal.js';

export interface CoreToolExecutorConfig {
  tools: Record<string, AnyTool>;
  enforcer?: ToolEnforcer;
  parallelExecution?: boolean;
  agentId?: string;
  onInterim?: (message: string, toolName: string) => void;
  /**
   * Called for each chunk an async-iterable tool yields, as it arrives. The aggregate is
   * still the tool's result; this is progress, not output.
   */
  onChunk?: (chunk: unknown, toolName: string, toolCallId: string) => void;
}

/**
 * Merges the caller's abort with a timeout so the tool sees one signal. `AbortSignal.any` is
 * present on Node 20+, Bun, and workerd; the manual path keeps older runtimes working.
 * Mirrors `composeSignals` in `@kuralle-agents/fs`.
 */
function composeSignals(
  signal?: AbortSignal,
  timeoutSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!signal) return timeoutSignal;
  if (!timeoutSignal) return signal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted || timeoutSignal.aborted) onAbort();
  return controller.signal;
}

function rejectOnAbort(signal: AbortSignal, makeError: () => Error): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(makeError());
      return;
    }
    signal.addEventListener('abort', () => reject(makeError()), { once: true });
  });
}

export interface CoreExecuteArgs {
  name: string;
  args: unknown;
  session: Session;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  toolCtx?: ToolContext;
  /** Flow-local tool def passed by the driver; wins over the registry when both exist. */
  def?: AnyTool;
}

export class CoreToolExecutor implements EffectToolExecutor {
  private readonly tools: Map<string, Tool>;
  private readonly enforcer?: ToolEnforcer;
  private readonly parallelExecution: boolean;
  private readonly agentId: string;
  private readonly onInterim?: (message: string, toolName: string) => void;
  private readonly onChunk?: (chunk: unknown, toolName: string, toolCallId: string) => void;
  private readonly pairing = new PairingTracker();
  private executionGate: Promise<void> = Promise.resolve();
  private callHistory: ToolCallRecord[] = [];

  constructor(config: CoreToolExecutorConfig) {
    this.tools = new Map(Object.entries(config.tools));
    this.enforcer = config.enforcer;
    this.parallelExecution = config.parallelExecution ?? false;
    this.agentId = config.agentId ?? 'agent';
    this.onInterim = config.onInterim;
    this.onChunk = config.onChunk;
  }

  getPairs(): ToolCallPair[] {
    return this.pairing.getAllPairs();
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(args: CoreExecuteArgs): Promise<unknown> {
    const registryDef = this.tools.get(args.name);
    const def = args.def ?? registryDef;
    const parallelSafe = def?.parallelSafe === true || def?.replay === false;
    if (!this.parallelExecution && !parallelSafe) {
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
    const registryDef = this.tools.get(name);
    if (args.def && registryDef) {
      debug(`[ToolExecutor] flow-local tool "${name}" shadows a same-named registry tool`);
    }
    const def = args.def ?? registryDef;
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

    const onAbort = (): void => {
      if (interimTimer) clearTimeout(interimTimer);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (def.interim && def.interimAfterMs != null && def.interimAfterMs >= 0) {
        interimTimer = setTimeout(() => {
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

      const timeoutMs = def.timeoutMs;
      // The tool receives the timeout as an abort, so a cooperative tool stops working when
      // we stop waiting for it. Racing alone abandoned the promise while the work continued.
      const timeoutSignal =
        timeoutMs != null && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const effectiveSignal = composeSignals(abortSignal, timeoutSignal);

      const executeCtx: ToolContext | undefined = toolCtx
        ? { ...toolCtx, abortSignal: effectiveSignal }
        : effectiveSignal
          ? ({ abortSignal: effectiveSignal } as ToolContext)
          : undefined;

      const executePromise = Promise.resolve(
        def.execute(sanitizedArgs, executeCtx),
      ).then(async (result) => {
        if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
          const chunks: unknown[] = [];
          for await (const chunk of result as AsyncIterable<unknown>) {
            chunks.push(chunk);
            // Surface progress as it arrives. Observational only — the journal records the
            // aggregate below, so a replayed step emits nothing and stays deterministic.
            this.onChunk?.(chunk, name, requestId);
          }
          return chunks.length === 1 ? chunks[0] : chunks;
        }
        return result;
      });

      // The signals above cancel a cooperative tool; these racers stop us waiting on one that
      // ignores them. Both are needed — neither alone bounds the call.
      const abortPromise =
        abortSignal && def.interruptible !== false
          ? rejectOnAbort(abortSignal, () => new DOMException('Aborted', 'AbortError'))
          : null;
      const timeoutPromise = timeoutSignal
        ? rejectOnAbort(timeoutSignal, () => new ToolTimeoutError(name, timeoutMs!))
        : null;

      const racers: Promise<unknown>[] = [executePromise];
      if (abortPromise) racers.push(abortPromise);
      if (timeoutPromise) racers.push(timeoutPromise);
      const rawResult =
        racers.length > 1 ? await Promise.race(racers) : await executePromise;

      if (interimTimer) clearTimeout(interimTimer);

      const validated = await validateOutput(def.output, rawResult, name);
      callRecord.result = validated;
      callRecord.durationMs = Date.now() - callRecord.timestamp;
      this.callHistory.push(callRecord);

      this.pairing.closePair(requestId, 'completed', validated);

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

      if (error instanceof ToolTimeoutError || isControlFlowSignal(error)) {
        // A timeout and a suspend are decisions about the run, not results the tool may
        // reinterpret. They reach the caller unchanged.
        throw error;
      }

      if (def.onError) {
        // Recovery runs before the failure is recorded, so a handled error is journaled as
        // the success it became. A throwing handler falls through to the generic path below.
        try {
          const recovered = await def.onError(
            error instanceof Error ? error : new Error(String(error)),
            sanitizedArgs,
          );
          const validatedRecovery = await validateOutput(def.output, recovered, name);
          callRecord.result = validatedRecovery;
          callRecord.durationMs = Date.now() - callRecord.timestamp;
          this.callHistory.push(callRecord);
          this.pairing.closePair(requestId, 'completed', validatedRecovery);
          return validatedRecovery;
        } catch (recoveryError) {
          error = recoveryError;
        }
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
