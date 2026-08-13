import { randomUUID } from 'node:crypto';
import type { ModelMessage, TranscriptionModel } from 'ai';
import { transcribeAudioParts, type UserInputContent } from './userInput.js';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { SignalDelivery } from './durable/types.js';
import {
  readSessionDurableRuns,
  runKind,
  type RunKind,
  type RunState,
} from './durable/types.js';
import { setPendingUserInput } from './channels/inputBuffer.js';
import { SessionRunStore } from './durable/SessionRunStore.js';
import { assertResumableEffectKeys, EFFECT_KEY_VERSION } from './durable/effectKeyVersion.js';
import { RunNotFoundError, type RunStore } from './durable/RunStore.js';
import type { ResolvedSelection } from '../types/selection.js';
import { resetTurnCount } from './policies/limits.js';
import { addSystemNote } from './systemNotes.js';
import { mutateSessionWithRetry } from '../session/utils.js';
import { stripInternalKeys } from './internalRunState.js';

export interface OpenRunOptions {
  sessionId: string;
  userId?: string;
  input?: UserInputContent;
  selection?: ResolvedSelection;
  /** Agent-initiated turn: no user input; a wake note is appended instead. */
  wake?: { reason: string; payload?: Record<string, unknown> };
  agentId?: string;
  seedMessages?: ModelMessage[];
  historyDelta?: ModelMessage[];
  signalDelivery?: SignalDelivery;
  /** Stable key for this inbound user message; duplicate webhook retries are ignored (H2). */
  idempotencyKey?: string;
  transcriptionModel?: TranscriptionModel;
  defaultAgentId: string;
  sessionStore: SessionStore;
  /**
   * Address an existing run. Unknown and cross-session values throw.
   * Omit to open the session's conversation run, or to mint a new flow run
   * when `kind` is `'flow'`.
   */
  runId?: string;
  /** When minting a new run (no `runId`), its kind. Default `'conversation'`. */
  kind?: RunKind;
  /**
   * Creation-only: enter this flow on a newly minted `kind: 'flow'` run.
   * Ignored on resume so a caller cannot retarget another flow.
   */
  flowName?: string;
  /**
   * Server-side id source for a newly minted flow run. Pass a journaled
   * `ctx.uuid` binding so replay yields the same run id. Caller-supplied
   * resume ids go on `runId`, not here.
   */
  mint?: () => string;
  /** Override the default SessionRunStore for this open. */
  runStore?: RunStore;
}

export function resolveRunStore(
  sessionStore: SessionStore,
  sessionId: string,
  override?: RunStore,
): RunStore {
  return override ?? new SessionRunStore(sessionStore, sessionId);
}

export interface OpenRunResult {
  session: Session;
  runState: RunState;
  runStore: RunStore;
  agent: AgentConfig;
}

export function mintRunId(uuid: () => string = randomUUID): string {
  return uuid();
}

export interface ResolvedRunTarget {
  runId?: string;
  lockKind: RunKind;
}

export async function resolveTargetRunId(
  sessionStore: SessionStore,
  sessionId: string,
  opts: { runId?: string; signalDelivery?: SignalDelivery; kind?: RunKind },
): Promise<ResolvedRunTarget> {
  const addressed = opts.runId ?? opts.signalDelivery?.runId;
  if (addressed) {
    if (addressed === sessionId) {
      return { runId: addressed, lockKind: 'conversation' };
    }
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return { runId: addressed, lockKind: 'flow' };
    }
    const existing = readSessionDurableRuns(session)[addressed];
    if (!existing) {
      return { runId: addressed, lockKind: 'flow' };
    }
    return { runId: addressed, lockKind: runKind(existing.runState) };
  }
  if (opts.signalDelivery) {
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return { lockKind: 'conversation' };
    }
    const scanned = findLegacySignalRun(session, opts.signalDelivery);
    if (scanned) {
      const existing = readSessionDurableRuns(session)[scanned];
      return {
        runId: scanned,
        lockKind: existing ? runKind(existing.runState) : 'flow',
      };
    }
    return { lockKind: 'conversation' };
  }
  if (opts.kind === 'flow') {
    return { lockKind: 'flow' };
  }
  return { runId: sessionId, lockKind: 'conversation' };
}

function assertKnownFlow(agentsById: Map<string, AgentConfig>, options: OpenRunOptions): void {
  if (!options.flowName) return;
  const agent = agentsById.get(options.agentId ?? options.defaultAgentId);
  if (!agent?.flows?.some((candidate) => candidate.name === options.flowName)) {
    throw new Error(`Unknown flow "${options.flowName}"`);
  }
}

export async function openRun(
  agentsById: Map<string, AgentConfig>,
  options: OpenRunOptions,
): Promise<OpenRunResult> {
  if (
    options.kind === 'flow' &&
    options.runId === undefined &&
    !options.signalDelivery
  ) {
    assertKnownFlow(agentsById, options);
  }

  const session = await loadOrCreateSession(options);
  const runStore = resolveRunStore(options.sessionStore, session.id, options.runStore);
  const addressedRunId = resolveAddressedRunId(options, session);

  let runId: string;
  let runState: RunState | null;

  if (addressedRunId !== undefined) {
    runState = await runStore.getRunState(addressedRunId);
    if (!runState || runState.sessionId !== session.id) {
      throw new RunNotFoundError(addressedRunId);
    }
    runId = addressedRunId;
  } else if (options.kind === 'flow') {
    assertKnownFlow(agentsById, options);
    runId = mintRunId(options.mint);
    runState = null;
  } else {
    runId = session.id;
    runState = await runStore.getRunState(runId);
  }

  if (!runState) {
    const now = Date.now();
    const initialMessages = options.seedMessages ?? [];
    const kind: RunKind = options.kind === 'flow' ? 'flow' : 'conversation';
    runState = {
      runId,
      sessionId: session.id,
      kind,
      status: 'running',
      activeAgentId: options.agentId ?? options.defaultAgentId,
      state: {},
      messages: [...initialMessages],
      createdAt: now,
      updatedAt: now,
      effectKeyVersion: EFFECT_KEY_VERSION,
    };
    if (kind === 'flow' && options.flowName) {
      runState.activeFlow = options.flowName;
    }
    if (runStore.initRun) {
      await runStore.initRun(runState);
    } else {
      await runStore.putRunState(runState);
    }
    if (kind === 'conversation' && initialMessages.length > 0) {
      await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
        latest.messages = [...initialMessages];
      });
    }
  } else if (runState.kind === undefined) {
    runState.kind = 'conversation';
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
  }

  const isConversation = runKind(runState) === 'conversation';

  // A run journaled before effects were scoped by flow cannot resume inside one: its
  // recorded steps are keyed without the flow, so none would match and every effect it
  // already performed would run again. Refuse rather than re-charge a card.
  assertResumableEffectKeys(runState, await runStore.getSteps(runId));
  if (runState.effectKeyVersion !== EFFECT_KEY_VERSION) {
    runState.effectKeyVersion = EFFECT_KEY_VERSION;
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
  }

  if (options.historyDelta?.length) {
    runState.messages = [...runState.messages, ...options.historyDelta];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
    if (isConversation) {
      await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
        latest.messages = [...latest.messages, ...options.historyDelta!];
      });
    }
  }

  if (options.selection?.formData) {
    // Caller data merges into the shared bag, so the framework namespace is stripped first —
    // a request must not be able to overwrite internal run state (see internalRunState.ts).
    runState.state = { ...runState.state, ...stripInternalKeys(options.selection.formData) };
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
  }

  const rawInput = options.selection?.id ?? options.input;
  const effectiveInput =
    rawInput === undefined
      ? undefined
      : await transcribeAudioParts(rawInput, options.transcriptionModel);
  const hasInput =
    typeof effectiveInput === 'string'
      ? effectiveInput.length > 0
      : Array.isArray(effectiveInput) && effectiveInput.length > 0;

  if (isConversation) {
    const isResume = Boolean(options.signalDelivery);
    const isFlowContinuation = Boolean(runState.activeFlow);
    const isFreshLogicalRun =
      (hasInput || Boolean(options.wake)) && !isResume && !isFlowContinuation;
    if (isFreshLogicalRun) {
      runState.runEpoch = (runState.runEpoch ?? 0) + 1;
      await runStore.pruneStepsBeforeEpoch?.(runId, runState.runEpoch);
      resetTurnCount(runState);
      if (Array.isArray(runState.state.__completedFlows)) {
        runState.state.__completedFlows = [];
      }
      runState.updatedAt = Date.now();
      await runStore.putRunState(runState);
    }
  }

  if (hasInput && effectiveInput !== undefined) {
    if (options.idempotencyKey) {
      const processed = runState.processedInboundKeys ?? [];
      if (processed.includes(options.idempotencyKey)) {
        const agent = agentsById.get(runState.activeAgentId);
        if (!agent) {
          throw new Error(`Unknown activeAgentId "${runState.activeAgentId}"`);
        }
        const latestSession = (await options.sessionStore.get(options.sessionId)) ?? session;
        return { session: latestSession, runState, runStore, agent };
      }
      runState.processedInboundKeys = [...processed, options.idempotencyKey];
    }

    runState.updatedAt = Date.now();
    if (runState.activeFlow) {
      if (isConversation) {
        await runStore.putRunState(runState);
        await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
          setPendingUserInput(latest, effectiveInput);
        });
      } else {
        setPendingUserInput(session, effectiveInput, runState);
        await runStore.putRunState(runState);
      }
    } else {
      const userMessage: ModelMessage = { role: 'user', content: effectiveInput };
      runState.messages = [...runState.messages, userMessage];
      runState.updatedAt = Date.now();
      await runStore.putRunState(runState);
      if (isConversation) {
        await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
          latest.messages = [...latest.messages, userMessage];
        });
      }
    }
  }

  if (options.wake && !hasInput) {
    const payloadNote = options.wake.payload
      ? ` Context: ${JSON.stringify(options.wake.payload)}.`
      : '';
    // A wake is an instruction to the model, not a turn anybody took. It goes in the system
    // prompt for exactly this turn; the assistant's proactive message is what belongs in the
    // transcript, and that still lands there normally.
    addSystemNote(
      runState,
      `[Scheduled wake: ${options.wake.reason}]${payloadNote} ` +
        'There is no new user message. Re-engage the user proactively per your instructions; ' +
        'if a task is in progress, follow up on it gently.',
      { lifetime: 'turn', tag: 'wake' },
    );
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
  }

  const agent = agentsById.get(runState.activeAgentId);
  if (!agent) {
    throw new Error(`Unknown activeAgentId "${runState.activeAgentId}"`);
  }

  if (!isConversation) {
    const latestSession = (await options.sessionStore.get(session.id)) ?? session;
    return { session: latestSession, runState, runStore, agent };
  }

  const latestSession = await mutateSessionWithRetry(
    options.sessionStore,
    session.id,
    (latest) => {
      latest.currentAgent = runState.activeAgentId;
      latest.activeAgentId = runState.activeAgentId;
    },
  );

  return { session: latestSession, runState, runStore, agent };
}

function resolveAddressedRunId(options: OpenRunOptions, session: Session): string | undefined {
  const addressed = options.signalDelivery?.runId ?? options.runId;
  if (addressed) {
    return addressed;
  }
  if (options.signalDelivery) {
    return findLegacySignalRun(session, options.signalDelivery);
  }
  return undefined;
}

function findLegacySignalRun(session: Session, delivery: SignalDelivery): string | undefined {
  const matches: string[] = [];
  for (const [runId, persisted] of Object.entries(readSessionDurableRuns(session))) {
    const waiting = persisted.runState.waitingFor;
    if (
      waiting &&
      waiting.signalName === delivery.name &&
      waiting.requestId === delivery.requestId
    ) {
      matches.push(runId);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `Signal ${delivery.name}/${delivery.requestId} matches multiple runs; pass signalDelivery.runId`,
    );
  }
  return matches[0];
}

async function loadOrCreateSession(options: OpenRunOptions): Promise<Session> {
  const existing = await options.sessionStore.get(options.sessionId);
  if (existing) {
    return existing;
  }

  const probeId = options.runId ?? options.signalDelivery?.runId;
  if (probeId) {
    throw new RunNotFoundError(probeId);
  }

  const now = new Date();
  const session: Session = {
    id: options.sessionId,
    conversationId: options.sessionId,
    channelId: 'api',
    userId: options.userId,
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: options.defaultAgentId,
    activeAgentId: options.defaultAgentId,
    agentStates: {},
    handoffHistory: [],
  };

  await options.sessionStore.save(session);
  return session;
}

export function newSessionId(): string {
  return randomUUID();
}
