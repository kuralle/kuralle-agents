import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import type { Session } from '../types/session.js';
import type {
  EffectToolExecutor,
  MemoryService,
  AutoRetrieveProvider,
  RunContext,
} from '../types/run-context.js';
import type { StreamPart } from '../types/stream.js';
import type { RefinementCapability } from '../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../capabilities/ValidationCapability.js';
import type { InputProcessor, OutputProcessor } from '../types/processors.js';
import type { Limits } from '../types/guardrails.js';
import type { FileSystem } from '../types/filesystem.js';
import type { RunState, StepKind, StepRecord } from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { SuspendError } from './durable/RunStore.js';
import {
  clockEffectKey,
  idempotencyKey,
  logicalRunId,
  pauseEffectKey,
  toolEffectKey,
} from './durable/idempotency.js';
import { findStepByKey } from './durable/replay.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';
import { needsApprovalPolicy, type Policy } from './policies/toolPolicy.js';

const APPROVAL_SIGNAL = '__approval';

interface EffectClock {
  now(): number;
  uuid(): string;
}

export interface CtxDeps {
  session: Session;
  runState: RunState;
  runStore: RunStore;
  steps: StepRecord[];
  toolExecutor: EffectToolExecutor;
  model: LanguageModel;
  controlModel?: LanguageModel;
  outOfBandControl?: boolean;
  refinementPolicies?: RefinementCapability[];
  validationPolicies?: ValidationCapability[];
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
  limits?: Limits;
  autoRetrieve?: AutoRetrieveProvider;
  memoryService?: MemoryService;
  fs?: FileSystem;
  bargeIn?: AbortSignal;
  abortSignal?: AbortSignal;
  clock?: EffectClock;
  emit?: (part: StreamPart) => void;
  /** Decides allow / ask / deny per tool call. Defaults to honouring `needsApproval`. */
  policy?: Policy;
}

function makeCtx(deps: CtxDeps): RunContext {
  let effectOrdinal = 0;
  const steps = deps.steps;
  const clock: EffectClock = deps.clock ?? {
    now: () => Date.now(),
    uuid: () => randomUUID(),
  };

  const emit = deps.emit ?? (() => {});

  // Mutable holder: handoff reassigns runCtx.toolExecutor; ctx.tool must see the swap.
  const toolExecutorHolder = { executor: deps.toolExecutor };
  // Swappable for the same reason the executor is: a handoff changes which agent is
  // acting, and the new agent's policy must govern its calls. Leaving the source agent's
  // policy in place would let a delegated read-only worker inherit write permission.
  const policyHolder = { policy: deps.policy ?? needsApprovalPolicy };

  let pendingAppendTail = Promise.resolve();
  const serializePendingAppend = <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = pendingAppendTail;
    let release!: () => void;
    pendingAppendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  };

  const consumeCallsite = (): string => {
    const site = String(effectOrdinal);
    effectOrdinal += 1;
    return site;
  };

  const isFinishedStep = (hit: StepRecord): boolean => {
    if (hit.status === 'finished') {
      return true;
    }
    if (hit.status === 'running') {
      return false;
    }
    if (hit.status === 'error' || hit.error) {
      return false;
    }
    return hit.result !== undefined;
  };

  const updateLocalStep = (key: string, patch: Partial<StepRecord>): void => {
    const idx = steps.findIndex((step) => step.key === key);
    if (idx >= 0) {
      steps[idx] = { ...steps[idx]!, ...patch };
    }
  };

  const appendPendingStep = async (
    key: string,
    kind: StepKind,
    name: string,
    index: number,
    signalId?: string,
  ): Promise<void> => {
    const startedAt = Date.now();
    const record: StepRecord = {
      index,
      key,
      kind,
      name,
      signalId,
      status: 'running',
      startedAt,
      epoch: deps.runState.runEpoch ?? 0,
    };
    await deps.runStore.appendStep(deps.runState.runId, record);
    const localIdx = steps.findIndex((step) => step.index === index);
    if (localIdx >= 0) {
      steps[localIdx] = record;
    } else {
      while (steps.length < index) {
        steps.push({
          index: steps.length,
          key: `__reserve:${deps.runState.runId}:${steps.length}`,
          kind: 'tool',
          name: '__reserve',
          status: 'running',
          startedAt,
          epoch: deps.runState.runEpoch ?? 0,
        });
      }
      if (steps.length === index) {
        steps.push(record);
      } else {
        steps[index] = record;
      }
    }
  };

  const replayOrExecute = async (
    key: string,
    kind: StepKind,
    name: string,
    execute: () => Promise<unknown>,
    options?: { index?: number },
  ): Promise<unknown> => {
    const hit = findStepByKey(steps, key);
    if (hit) {
      if (hit.status === 'error' || hit.error) {
        throw Object.assign(new Error(hit.error!.message), { name: hit.error!.name });
      }
      if (isFinishedStep(hit)) {
        return hit.result;
      }
    }

    const isRetry = hit?.status === 'running';
    const stepIndex = options?.index ?? hit?.index;

    if (!isRetry) {
      const append = async () => {
        let index = stepIndex;
        if (index === undefined) {
          if (deps.runStore.reserveSteps) {
            index = (await deps.runStore.reserveSteps(deps.runState.runId, 1))[0];
          } else {
            // ctx.tool owns ordinal assignment: use the store's atomic reservation when available,
            // and serialize legacy stores that do not expose reserveSteps within this context.
            index = steps.length;
          }
        }
        await appendPendingStep(key, kind, name, index);
      };

      if (stepIndex === undefined && !deps.runStore.reserveSteps) {
        await serializePendingAppend(append);
      } else {
        await append();
      }
    }

    let result: unknown;
    try {
      result = await execute();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const finishedAt = Date.now();
      await deps.runStore.finalizeStep(deps.runState.runId, key, {
        status: 'error',
        error: { name: err.name, message: err.message },
        finishedAt,
      });
      updateLocalStep(key, {
        status: 'error',
        error: { name: err.name, message: err.message },
        finishedAt,
      });
      throw err;
    }

    const finishedAt = Date.now();
    await deps.runStore.finalizeStep(deps.runState.runId, key, {
      status: 'finished',
      result,
      finishedAt,
    });
    updateLocalStep(key, { status: 'finished', result, finishedAt });
    deps.runState.updatedAt = finishedAt;
    await deps.runStore.putRunState(deps.runState);
    return result;
  };

  const effectRunId = () =>
    logicalRunId(deps.runState.runId, deps.runState.runEpoch);

  const suspendForSignal = async (
    signalName: string,
    callsite: string,
    meta?: { deadline?: number; meta?: Record<string, unknown>; approval?: { title: string; description?: string } },
  ): Promise<never> => {
    deps.runState.waitingFor = {
      signalName,
      callsite,
      deadline: meta?.deadline,
      meta: meta?.meta,
      approval: meta?.approval,
    };
    deps.runState.status = 'paused';
    deps.runState.updatedAt = Date.now();
    await deps.runStore.putRunState(deps.runState);
    emit({ channel: 'internal', type: 'paused', payload: { waitingFor: signalName } });
    throw new SuspendError(signalName);
  };

  const pauseEffect = async (
    signalName: string,
    meta?: { deadline?: number; meta?: Record<string, unknown>; approval?: { title: string; description?: string } },
  ): Promise<unknown> => {
    const callsite = consumeCallsite();
    const key = pauseEffectKey(effectRunId(), callsite, signalName);
    const hit = findStepByKey(steps, key);
    if (hit) {
      if (hit.status === 'error' || hit.error) {
        throw Object.assign(new Error(hit.error!.message), { name: hit.error!.name });
      }
      if (hit.status === 'finished' || hit.result !== undefined) {
        return hit.result;
      }
    }

    await suspendForSignal(signalName, callsite, meta);
    throw new Error('unreachable');
  };

  return {
    session: deps.session,
    runState: deps.runState,
    runStore: deps.runStore,
    emit,
    get toolExecutor() {
      return toolExecutorHolder.executor;
    },
    set toolExecutor(executor: EffectToolExecutor) {
      toolExecutorHolder.executor = executor;
    },
    get policy() {
      return policyHolder.policy;
    },
    set policy(policy: Policy) {
      policyHolder.policy = policy ?? needsApprovalPolicy;
    },
    model: deps.model,
    controlModel: deps.controlModel ?? deps.model,
    outOfBandControl: deps.outOfBandControl ?? false,
    refinementPolicies: deps.refinementPolicies ?? [],
    validationPolicies: deps.validationPolicies ?? [],
    inputProcessors: deps.inputProcessors ?? [],
    outputProcessors: deps.outputProcessors ?? [],
    limits: deps.limits,
    autoRetrieve: deps.autoRetrieve,
    memoryService: deps.memoryService,
    fs: deps.fs,
    bargeIn: deps.bargeIn,
    abortSignal: deps.abortSignal,
    turnInputConsumed: false,
    // Rebase durable effect callsites to 0. Called at flow entry so a flow's
    // effects (and any suspend/resume callsite) are anchored to the flow itself —
    // identical whether the flow was entered fresh after an answering turn (which
    // may have consumed callsites via enter_flow / tool calls) or re-entered on
    // resume (where that answering turn does not re-run). Without this, a suspend's
    // recorded callsite would not match on resume and the run would re-suspend.
    resetCallsites: () => {
      effectOrdinal = 0;
    },
    reserveCallsites: (count: number) => {
      const sites: string[] = [];
      for (let i = 0; i < count; i++) {
        sites.push(consumeCallsite());
      }
      return sites;
    },
    tool: async (name, args, options) => {
      // needsApproval gate: a tool flagged `needsApproval` must be approved by a human
      // before it runs. Approval is a durable pause (the `__approval` signal); on resume
      // the recorded decision is replayed, then the tool effect runs exactly once. The
      // approval pause consumes its own callsite ordinal before the tool effect, so the
      // ordering is deterministic across replays. NOTE: the surrounding agent turn is not
      // itself a replayable effect — this is fully deterministic for flow `action` tools;
      // for model-issued tool calls, resume re-enters the agent turn.
      const def = options?.def ?? toolExecutorHolder.executor.getTool?.(name);
      const verdict = await policyHolder.policy.decide({ toolName: name, args, def });
      if (verdict.kind === 'deny') {
        // Denied by rule, not by a person: no pause, nothing to wait for. Reuses the
        // approval-denied path so the model still receives it as a readable result rather
        // than a crash — "was not approved, do not retry" is correct for a rule too.
        throw new ToolApprovalDeniedError(name, 'policy', verdict.reason);
      }
      if (verdict.kind === 'ask') {
        const decision = (await pauseEffect(APPROVAL_SIGNAL, {
          approval: { title: verdict.title ?? `Approve tool: ${name}` },
        })) as { approved: boolean; by?: string };
        if (!decision.approved) {
          throw new ToolApprovalDeniedError(name, decision.by);
        }
      }
      const callsite = options?.callsite ?? consumeCallsite();
      const logicalId = effectRunId();
      const key =
        def?.idempotencyKey != null
          ? def.idempotencyKey(args)
          : idempotencyKey(logicalId, callsite, { name, args });
      const imperative = options?.toolCallId === undefined;
      const toolCallId = options?.toolCallId ?? randomUUID();
      if (imperative) {
        emit({
          channel: 'internal',
          type: 'tool-call',
          payload: { toolName: name, args, toolCallId, imperative: true },
        });
      }
      const executeTool = () =>
        toolExecutorHolder.executor.execute({
          name,
          args,
          session: deps.session,
          toolCallId,
          abortSignal: deps.bargeIn ?? deps.abortSignal,
          def: options?.def,
          toolCtx: options?.toolCtx,
        });

      const finishImperative = async (result: unknown) => {
        if (imperative) {
          emit({
            channel: 'internal',
            type: 'tool-result',
            payload: { toolName: name, result, toolCallId, imperative: true },
          });
        }
        return result;
      };

      if (def?.replay === false) {
        const auditKey = `${key}:${steps.length}:${options?.index ?? callsite}`;
        return finishImperative(
          await replayOrExecute(auditKey, 'tool', name, executeTool, { index: options?.index }),
        );
      }

      return finishImperative(
        await replayOrExecute(key, 'tool', name, executeTool, { index: options?.index }),
      );
    },
    approve: async (req) => {
      return pauseEffect(APPROVAL_SIGNAL, { approval: req }) as Promise<{
        approved: boolean;
        by?: string;
      }>;
    },
    signal: async (name, opts) => {
      return pauseEffect(name, {
        deadline: opts?.deadline,
        meta: opts?.meta,
      });
    },
    now: async () => {
      const callsite = consumeCallsite();
      const key = clockEffectKey(effectRunId(), callsite, 'now');
      return replayOrExecute(key, 'now', 'now', async () => clock.now()) as Promise<number>;
    },
    uuid: async () => {
      const callsite = consumeCallsite();
      const key = clockEffectKey(effectRunId(), callsite, 'uuid');
      return replayOrExecute(key, 'uuid', 'uuid', async () => clock.uuid()) as Promise<string>;
    },
  };
}

export async function createRunContext(deps: CtxDeps): Promise<RunContext> {
  const steps = deps.steps.length > 0 ? deps.steps : await deps.runStore.getSteps(deps.runState.runId);
  return makeCtx({ ...deps, steps });
}
