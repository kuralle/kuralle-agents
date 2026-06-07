import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import type { Session } from '../types/session.js';
import type {
  EffectToolExecutor,
  HookRunner,
  MemoryService,
  AutoRetrieveProvider,
  RunContext,
} from '../types/run-context.js';
import type { HarnessStreamPart } from '../types/stream.js';
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
  pauseEffectKey,
  toolEffectKey,
} from './durable/idempotency.js';
import { findStepByKey } from './durable/replay.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';

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
  hookRunner?: HookRunner;
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
  emit?: (part: HarnessStreamPart) => void;
}

function makeCtx(deps: CtxDeps): RunContext {
  let effectOrdinal = 0;
  const steps = deps.steps;
  const clock: EffectClock = deps.clock ?? {
    now: () => Date.now(),
    uuid: () => randomUUID(),
  };

  const emit = deps.emit ?? (() => {});

  const consumeCallsite = (): string => {
    const site = String(effectOrdinal);
    effectOrdinal += 1;
    return site;
  };

  const appendLiveStep = async (
    key: string,
    kind: StepKind,
    name: string,
    result: unknown,
    signalId?: string,
  ): Promise<void> => {
    const startedAt = Date.now();
    const record: StepRecord = {
      index: steps.length,
      key,
      kind,
      name,
      signalId,
      result,
      startedAt,
      finishedAt: startedAt,
    };
    await deps.runStore.appendStep(deps.runState.runId, record);
    steps.push(record);
    deps.runState.updatedAt = startedAt;
    await deps.runStore.putRunState(deps.runState);
  };

  const replayOrExecute = async (
    key: string,
    kind: StepKind,
    name: string,
    execute: () => Promise<unknown>,
  ): Promise<unknown> => {
    const hit = findStepByKey(steps, key);
    if (hit) {
      if (hit.error) {
        throw Object.assign(new Error(hit.error.message), { name: hit.error.name });
      }
      return hit.result;
    }

    try {
      const result = await execute();
      await appendLiveStep(key, kind, name, result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const startedAt = Date.now();
      const record: StepRecord = {
        index: steps.length,
        key,
        kind,
        name,
        error: { name: err.name, message: err.message },
        startedAt,
        finishedAt: startedAt,
      };
      await deps.runStore.appendStep(deps.runState.runId, record);
      steps.push(record);
      throw err;
    }
  };

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
    emit({ type: 'paused', waitingFor: signalName });
    throw new SuspendError(signalName);
  };

  const pauseEffect = async (
    signalName: string,
    meta?: { deadline?: number; meta?: Record<string, unknown>; approval?: { title: string; description?: string } },
  ): Promise<unknown> => {
    const callsite = consumeCallsite();
    const key = pauseEffectKey(deps.runState.runId, callsite, signalName);
    const hit = findStepByKey(steps, key);
    if (hit) {
      if (hit.error) {
        throw Object.assign(new Error(hit.error.message), { name: hit.error.name });
      }
      return hit.result;
    }

    await suspendForSignal(signalName, callsite, meta);
    throw new Error('unreachable');
  };

  return {
    session: deps.session,
    runState: deps.runState,
    runStore: deps.runStore,
    emit,
    toolExecutor: deps.toolExecutor,
    hookRunner: deps.hookRunner ?? {},
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
    tool: async (name, args, options) => {
      // needsApproval gate: a tool flagged `needsApproval` must be approved by a human
      // before it runs. Approval is a durable pause (the `__approval` signal); on resume
      // the recorded decision is replayed, then the tool effect runs exactly once. The
      // approval pause consumes its own callsite ordinal before the tool effect, so the
      // ordering is deterministic across replays. NOTE: the surrounding agent turn is not
      // itself a replayable effect — this is fully deterministic for flow `action` tools;
      // for model-issued tool calls, resume re-enters the agent turn.
      const def = options?.def ?? deps.toolExecutor.getTool?.(name);
      if (def?.needsApproval) {
        const decision = (await pauseEffect(APPROVAL_SIGNAL, {
          approval: { title: `Approve tool: ${name}` },
        })) as { approved: boolean; by?: string };
        if (!decision.approved) {
          throw new ToolApprovalDeniedError(name, decision.by);
        }
      }
      const callsite = consumeCallsite();
      const key = toolEffectKey(deps.runState.runId, callsite, name, args);
      return replayOrExecute(key, 'tool', name, () =>
        deps.toolExecutor.execute({
          name,
          args,
          session: deps.session,
          toolCallId: options?.toolCallId,
          abortSignal: deps.bargeIn ?? deps.abortSignal,
          def: options?.def,
          toolCtx: options?.toolCtx,
        }),
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
      const key = clockEffectKey(deps.runState.runId, callsite, 'now');
      return replayOrExecute(key, 'now', 'now', async () => clock.now()) as Promise<number>;
    },
    uuid: async () => {
      const callsite = consumeCallsite();
      const key = clockEffectKey(deps.runState.runId, callsite, 'uuid');
      return replayOrExecute(key, 'uuid', 'uuid', async () => clock.uuid()) as Promise<string>;
    },
  };
}

export async function createRunContext(deps: CtxDeps): Promise<RunContext> {
  const steps = deps.steps.length > 0 ? deps.steps : await deps.runStore.getSteps(deps.runState.runId);
  return makeCtx({ ...deps, steps });
}
