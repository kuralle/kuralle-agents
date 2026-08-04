import { randomUUID } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
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
import type {
  FrozenToolOperation,
  InterruptRequest,
  RunState,
  SignalDelivery,
  StepKind,
  StepRecord,
} from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { SuspendError } from './durable/RunStore.js';
import {
  clockEffectKey,
  approvalEffectKey,
  idempotencyKey,
  logicalRunId,
  pauseEffectKey,
  valueHash,
} from './durable/idempotency.js';
import { findStepByKey, recordSignalDelivery } from './durable/replay.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';
import { needsApprovalPolicy, type Policy } from './policies/toolPolicy.js';
import type { StandardSchemaV1 } from '../types/standard-schema.js';
import type { HitlInterrupt } from '../types/stream.js';
import { appendConversationAudit } from '../audit/record.js';
import { toolDeniedResult, toolErrorResult } from '../tools/controlResults.js';
import { z } from 'zod';
import { toolResultMessage } from './channels/executeModelTool.js';
import { createNoSkillsGetSkill } from '../skills/skillHandle.js';
import type { SkillHandle } from '../skills/skillHandle.js';
import type { SkillLike, SkillMeta } from '../types/skills.js';
import {
  isSuccessfulLoadSkillResult,
  recordSkillActivation,
  type SkillActivation,
} from '../skills/skillActivation.js';
import type { LiveSkillCatalog } from '../skills/liveSkillCatalog.js';
import {
  diffSkillCatalog,
  renderSkillCatalogDelta,
  SKILL_CATALOG_NOTE_TAG,
} from '../skills/skillCatalog.js';
import { addSystemNote } from './systemNotes.js';

const APPROVAL_SIGNAL = '__approval';
const APPROVAL_DELIVERY_SCHEMA = z.object({}).strict();
const APPROVAL_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['requestId', 'decision'],
  additionalProperties: false,
  properties: {
    requestId: { type: 'string' },
    decision: { enum: ['approve', 'deny'] },
    reason: { type: 'string' },
  },
};

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
  signalDelivery?: SignalDelivery;
  getSkill?: (name: string) => SkillHandle;
  skillMetaByName?: ReadonlyMap<string, SkillMeta>;
  skillActivations?: SkillActivation[];
  skillCatalog?: LiveSkillCatalog;
}

function publicInterrupt(request: InterruptRequest): HitlInterrupt {
  return {
    requestId: request.requestId,
    kind: request.kind,
    signalName: request.signalName,
    ...(request.operation
      ? {
          operation: {
            toolCallId: request.operation.toolCallId,
            toolName: request.operation.toolName,
            args: request.operation.args,
            argsHash: request.operation.argsHash,
          },
        }
      : {}),
    display: request.display,
    responseSchema: request.responseSchema,
    deadline: request.deadline,
    allowedDecisions: request.allowedDecisions,
    createdAt: request.createdAt,
  };
}

function auditContext(deps: CtxDeps) {
  return {
    sessionId: deps.session.id,
    conversationId: deps.session.conversationId,
    userId: deps.session.userId,
    agentId: deps.runState.activeAgentId,
  };
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
  const getSkill = deps.getSkill ?? createNoSkillsGetSkill();
  const skillActivations = deps.skillActivations;

  // Swappable for the same reason `getSkill`/`policy`/`toolExecutor` are: a handoff changes
  // which agent is acting, and `load_skill` issued after a handoff must record the TARGET's
  // activation — which needs the target's skill metadata. Leaving the source agent's map in
  // place silently dropped the activation: load_skill returned instructions, but no
  // restriction was ever recorded, so the target's `allowed-tools` boundary evaporated.
  const skillMetaHolder = { map: deps.skillMetaByName };

  // Swappable for the same reason as the skill metadata: a handoff changes which agent is
  // acting, and add/remove must mutate the TARGET's live catalog. Held (not captured by value)
  // so the add/remove methods below keep reading the current agent's catalog after a swap.
  const liveCatalogHolder = { current: deps.skillCatalog };

  const maybeActivateLoadedSkill = (toolName: string, args: unknown, result: unknown): void => {
    if (
      toolName !== 'load_skill' ||
      !skillActivations ||
      (!skillMetaHolder.map && !liveCatalogHolder.current) ||
      !isSuccessfulLoadSkillResult(result)
    ) {
      return;
    }
    const skillName = (args as { name?: string }).name;
    if (!skillName) return;
    // A skill added mid-session is not in the frozen baseline map — resolve its metadata
    // (including `allowedTools`) from the live catalog so the a3 tool boundary still applies.
    const meta = skillMetaHolder.map?.get(skillName) ?? liveCatalogHolder.current?.meta(skillName);
    if (!meta) return;
    recordSkillActivation(skillActivations, meta);
  };

  // Announce a live-catalog change exactly once: diff against the last-announced snapshot,
  // and if nothing moved, do nothing (handles a repeated add/remove). Otherwise deliver the
  // delta as a runtime system note (never by rewriting `skillPrompt`), advance the snapshot,
  // and persist the catalog state with the note in one write — so a committed change cannot
  // be narrated twice on resume, and a crash before the write re-diffs and emits once.
  const announceCatalogChange = async (): Promise<void> => {
    const catalog = liveCatalogHolder.current;
    if (!catalog) return;
    const delta = diffSkillCatalog(catalog.announcedSnapshot(), catalog.entries());
    if (delta.added.length === 0 && delta.removed.length === 0) return;
    const roster = catalog.entries().map((entry) => entry.name);
    const text = renderSkillCatalogDelta(delta, roster);
    addSystemNote(deps.runState, text, { lifetime: 'run', tag: SKILL_CATALOG_NOTE_TAG });
    catalog.setAnnouncedSnapshot(catalog.entries());
    deps.runState.state.skillCatalog = catalog.serialize();
    deps.runState.updatedAt = Date.now();
    await deps.runStore.putRunState(deps.runState);
  };

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

  // `resetCallsites()` rebases the effect ordinal to 0 on every flow entry so a resumed
  // run anchors its callsites to the flow rather than to the answering turn before it.
  // That makes callsite 0 ambiguous across flows, so the flow has to be part of the
  // namespace: without it, two flows in one logical run calling a same-named tool with
  // the same arguments collide, and the second REPLAYS the first one's result. Live, that
  // made a handed-off agent replay the previous agent's "hand off to you" instruction and
  // loop until maxHandoffs. Keyed by name, not by an entry counter, so re-entering the
  // same flow on resume lands in the same namespace and still replays exactly once.
  const effectRunId = () => {
    const base = logicalRunId(deps.runState.runId, deps.runState.runEpoch);
    const flow = deps.runState.activeFlow;
    return flow ? `${base}#${flow}` : base;
  };

  let resumedToolOutcome: import('../types/run-context.js').ResumedToolOutcome | undefined;

  const recordDecisionAudit = (decision: NonNullable<StepRecord['interruptDecision']>) => {
    appendConversationAudit(deps.session, auditContext(deps), {
      type: 'interrupt-decided',
      requestId: decision.requestId,
      signalId: decision.signalId,
      actor: decision.actor,
      ...(decision.decision !== undefined ? { decision: decision.decision } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      decidedAt: new Date(decision.decidedAt).toISOString(),
    });
  };

  const suspendForSignal = async (
    request: InterruptRequest,
    recordRequested: boolean,
  ): Promise<never> => {
    if (recordRequested) {
      appendConversationAudit(deps.session, auditContext(deps), {
        type: 'interrupt-requested',
        requestId: request.requestId,
        signalName: request.signalName,
        kind: request.kind,
        ...(request.operation
          ? {
              operation: {
                toolCallId: request.operation.toolCallId,
                toolName: request.operation.toolName,
                args: request.operation.args,
                argsHash: request.operation.argsHash,
              },
            }
          : {}),
        display: request.display,
        deadline: request.deadline,
        allowedDecisions: request.allowedDecisions,
        requestedAt: new Date(request.createdAt).toISOString(),
      });
    }
    deps.runState.waitingFor = request;
    deps.runState.status = 'paused';
    deps.runState.updatedAt = Date.now();
    await deps.runStore.putRunState(deps.runState);
    emit({
      channel: 'internal',
      type: 'paused',
      payload: {
        waitingFor: request.signalName,
        interrupt: publicInterrupt(request),
      },
    });
    throw new SuspendError(request.signalName);
  };

  const pauseEffect = async (
    signalName: string,
    options: {
      kind: 'approval' | 'signal';
      title: string;
      description?: string;
      schema: StandardSchemaV1;
      responseSchema: Record<string, unknown>;
      deadline?: number;
      meta?: Record<string, unknown>;
      callsite?: string;
      resumeKey?: string;
      requestId?: string;
      operation?: FrozenToolOperation;
    },
  ): Promise<unknown> => {
    const callsite = options.callsite ?? consumeCallsite();
    const key = options.resumeKey ?? pauseEffectKey(effectRunId(), callsite, signalName);
    const hit = findStepByKey(steps, key);
    if (hit) {
      if (hit.status === 'error' || hit.error) {
        throw Object.assign(new Error(hit.error!.message), { name: hit.error!.name });
      }
      if (hit.status === 'finished' || hit.result !== undefined) {
        return hit.result;
      }
    }

    const existing =
      deps.runState.waitingFor?.resumeKey === key
        ? deps.runState.waitingFor
        : undefined;
    const createdAt = existing?.createdAt ?? Date.now();
    const request: InterruptRequest = existing ?? {
      requestId: options.requestId ?? `interrupt-${key.slice(0, 24)}`,
      kind: options.kind,
      signalName,
      callsite,
      resumeKey: key,
      createdAt,
      deadline: options.deadline ?? null,
      ...(options.meta !== undefined ? { meta: options.meta } : {}),
      display: {
        title: options.title,
        ...(options.description !== undefined ? { description: options.description } : {}),
      },
      allowedDecisions: options.kind === 'approval' ? ['approve', 'deny'] : [],
      responseSchema: options.responseSchema,
      ...(options.operation ? { operation: options.operation } : {}),
    };

    if (deps.signalDelivery) {
      await recordSignalDelivery(
        deps.runStore,
        deps.runState,
        deps.signalDelivery,
        { schema: options.schema, onDecision: recordDecisionAudit },
      );
      const persisted = await deps.runStore.getSteps(deps.runState.runId);
      steps.splice(0, steps.length, ...persisted);
      const recorded = findStepByKey(steps, key);
      if (!recorded || recorded.result === undefined) {
        throw new Error(`Signal ${signalName} was recorded without a resumable result`);
      }
      return recorded.result;
    }

    await suspendForSignal(request, existing === undefined);
    throw new Error('unreachable');
  };

  const signal = async <T>(
    name: string,
    opts: {
      schema: StandardSchemaV1<unknown, T>;
      responseSchema?: Record<string, unknown>;
      title?: string;
      description?: string;
      deadline?: number;
      meta?: Record<string, unknown>;
    },
  ): Promise<T> => {
    return pauseEffect(name, {
      kind: 'signal',
      title: opts.title ?? `Waiting for ${name}`,
      description: opts.description,
      schema: opts.schema,
      responseSchema: opts.responseSchema ?? {
        type: 'object',
        description: `Payload for ${name}`,
      },
      deadline: opts.deadline,
      meta: opts.meta,
    }) as Promise<T>;
  };

  const context: RunContext = {
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
    getSkill,
    skillActivations,
    get skillMetaByName(): ReadonlyMap<string, SkillMeta> | undefined {
      return skillMetaHolder.map;
    },
    set skillMetaByName(map: ReadonlyMap<string, SkillMeta> | undefined) {
      skillMetaHolder.map = map;
    },
    get skillCatalog(): LiveSkillCatalog | undefined {
      return liveCatalogHolder.current;
    },
    set skillCatalog(catalog: LiveSkillCatalog | undefined) {
      liveCatalogHolder.current = catalog;
    },
    addSkill: async (skill: SkillLike) => {
      const catalog = liveCatalogHolder.current;
      if (!catalog) return;
      catalog.add(skill);
      await announceCatalogChange();
    },
    removeSkill: async (name: string) => {
      const catalog = liveCatalogHolder.current;
      if (!catalog || !catalog.remove(name)) return;
      await announceCatalogChange();
    },
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
      const def = options?.def ?? toolExecutorHolder.executor.getTool?.(name);
      const callsite = options?.callsite ?? consumeCallsite();
      const logicalId = effectRunId();
      const baseEffectKey =
        def?.idempotencyKey != null
          ? def.idempotencyKey(args)
          : idempotencyKey(logicalId, callsite, { name, args });
      const imperative = options?.toolCallId === undefined;
      const toolCallId = options?.toolCallId ?? randomUUID();
      const effectKey =
        def?.replay === false
          ? `${baseEffectKey}:nonreplay:${toolCallId}`
          : baseEffectKey;
      const verdict = await policyHolder.policy.decide({ toolName: name, args, def });
      if (verdict.kind === 'deny') {
        throw new ToolApprovalDeniedError(name, 'policy', verdict.reason);
      }
      if (verdict.kind === 'ask') {
        const approvalKey = approvalEffectKey(logicalId, effectKey, name, args);
        const operation: FrozenToolOperation = {
          toolCallId,
          toolName: name,
          args,
          argsHash: valueHash(args),
          effectKey,
          callsite,
          ...(options?.index !== undefined ? { stepIndex: options.index } : {}),
          source: imperative ? 'action' : 'model',
          ...(deps.runState.activeFlow !== undefined ? { flow: deps.runState.activeFlow } : {}),
          ...(deps.runState.activeNode !== undefined ? { node: deps.runState.activeNode } : {}),
        };
        const decision = (await pauseEffect(APPROVAL_SIGNAL, {
          kind: 'approval',
          title: verdict.title ?? `Approve tool: ${name}`,
          schema: APPROVAL_DELIVERY_SCHEMA,
          responseSchema: APPROVAL_RESPONSE_SCHEMA,
          callsite,
          resumeKey: approvalKey,
          requestId: `approval-${approvalKey.slice(0, 24)}`,
          operation,
        })) as { approved: boolean; by?: string };
        if (!decision.approved) {
          throw new ToolApprovalDeniedError(name, decision.by);
        }
      }
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

      const result = await replayOrExecute(effectKey, 'tool', name, executeTool, { index: options?.index });
      maybeActivateLoadedSkill(name, args, result);
      return finishImperative(result);
    },
    approve: async (req) => {
      return pauseEffect(APPROVAL_SIGNAL, {
        kind: 'approval',
        title: req.title,
        description: req.description,
        schema: APPROVAL_DELIVERY_SCHEMA,
        responseSchema: APPROVAL_RESPONSE_SCHEMA,
      }) as Promise<{
        approved: boolean;
        by?: string;
      }>;
    },
    signal,
    attachInterruptContinuation: async (messages) => {
      const waitingFor = deps.runState.waitingFor;
      if (!waitingFor?.operation || waitingFor.operation.source !== 'model') return;
      waitingFor.continuation = [...messages];
      deps.runState.updatedAt = Date.now();
      await deps.runStore.putRunState(deps.runState);
    },
    resumePendingInterrupt: async (def) => {
      const request = deps.runState.waitingFor;
      const delivery = deps.signalDelivery;
      if (!request || request.kind !== 'approval') return undefined;

      // A delivery is present on the resume call itself. On any later turn there is none,
      // but a decision may already be recorded — that is the crash window between the
      // decision landing and its operation executing, and it must still be recoverable.
      if (delivery) {
        await recordSignalDelivery(
          deps.runStore,
          deps.runState,
          delivery,
          { schema: APPROVAL_DELIVERY_SCHEMA, onDecision: recordDecisionAudit },
        );
      }
      const persisted = await deps.runStore.getSteps(deps.runState.runId);
      steps.splice(0, steps.length, ...persisted);
      const decisionStep = findStepByKey(steps, request.resumeKey);
      const decision = decisionStep?.result as
        | { approved: boolean; by?: string; reason?: string }
        | undefined;
      if (!decision) {
        // Still genuinely waiting on a human; not an error.
        if (!delivery) return undefined;
        throw new Error(`Approval ${request.requestId} has no recorded decision`);
      }
      const operation = request.operation;
      if (!operation) return undefined;

      const operationAudit = {
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
        args: operation.args,
        argsHash: operation.argsHash,
      };
      let result: unknown;
      let failed = false;

      if (!decision.approved) {
        result = toolDeniedResult(operation.toolName, decision.by, decision.reason);
        appendConversationAudit(deps.session, auditContext(deps), {
          type: 'interrupt-executed',
          requestId: request.requestId,
          operation: operationAudit,
          outcome: 'denied',
          resultPreview: JSON.stringify(result).slice(0, 500),
          executedAt: new Date().toISOString(),
        });
      } else {
        emit({
          channel: 'internal',
          type: 'tool-call',
          payload: {
            toolName: operation.toolName,
            args: operation.args,
            toolCallId: operation.toolCallId,
            ...(operation.source === 'action' ? { imperative: true } : {}),
          },
        });
        const execute = () =>
          toolExecutorHolder.executor.execute({
            name: operation.toolName,
            args: operation.args,
            session: deps.session,
            toolCallId: operation.toolCallId,
            abortSignal: deps.bargeIn ?? deps.abortSignal,
            def,
            toolCtx: {
              session: deps.session,
              runState: deps.runState,
              tool: context.tool.bind(context),
              now: context.now.bind(context),
              uuid: context.uuid.bind(context),
              emit: context.emit.bind(context),
              fs: context.fs,
              getSkill: context.getSkill.bind(context),
              abortSignal: deps.bargeIn ?? deps.abortSignal,
            },
          });
        try {
          result = await replayOrExecute(
            operation.effectKey,
            'tool',
            operation.toolName,
            execute,
            { index: operation.stepIndex },
          );
          maybeActivateLoadedSkill(operation.toolName, operation.args, result);
          appendConversationAudit(deps.session, auditContext(deps), {
            type: 'interrupt-executed',
            requestId: request.requestId,
            operation: operationAudit,
            outcome: 'succeeded',
            resultPreview: JSON.stringify(result).slice(0, 500),
            executedAt: new Date().toISOString(),
          });
        } catch (error) {
          appendConversationAudit(deps.session, auditContext(deps), {
            type: 'interrupt-executed',
            requestId: request.requestId,
            operation: operationAudit,
            outcome: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            executedAt: new Date().toISOString(),
          });
          if (operation.source === 'action') throw error;
          failed = true;
          result = toolErrorResult(error);
        }
        emit({
          channel: 'internal',
          type: 'tool-result',
          payload: {
            toolName: operation.toolName,
            result,
            toolCallId: operation.toolCallId,
            ...(operation.source === 'action' ? { imperative: true } : {}),
          },
        });
      }

      if (request.continuation?.length) {
        deps.runState.messages = [...deps.runState.messages, ...request.continuation];
      }
      if (operation.source === 'model') {
        deps.runState.messages = [
          ...deps.runState.messages,
          toolResultMessage(
            {
              toolName: operation.toolName,
              input: operation.args,
              toolCallId: operation.toolCallId,
            },
            result,
          ),
        ];
        resumedToolOutcome = {
          requestId: request.requestId,
          ...(operation.node !== undefined ? { node: operation.node } : {}),
          toolName: operation.toolName,
          args: operation.args,
          toolCallId: operation.toolCallId,
          result,
          failed,
        };
      }
      // The operation has now run (or been denied). The request is finished, so release
      // it — `recordSignalDelivery` deliberately left it set to survive a crash here.
      deps.runState.waitingFor = undefined;
      deps.runState.updatedAt = Date.now();
      await deps.runStore.putRunState(deps.runState);
      return resumedToolOutcome;
    },
    takeResumedToolOutcome: (nodeId) => {
      if (!resumedToolOutcome || resumedToolOutcome.node !== nodeId) return undefined;
      const outcome = resumedToolOutcome;
      resumedToolOutcome = undefined;
      return outcome;
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
  return context;
}

export async function createRunContext(deps: CtxDeps): Promise<RunContext> {
  const steps = deps.steps.length > 0 ? deps.steps : await deps.runStore.getSteps(deps.runState.runId);
  return makeCtx({ ...deps, steps });
}
