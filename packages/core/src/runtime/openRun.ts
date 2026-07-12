import { randomUUID } from 'node:crypto';
import type { ModelMessage, TranscriptionModel } from 'ai';
import { transcribeAudioParts, type UserInputContent } from './userInput.js';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { SignalDelivery } from './durable/types.js';
import { setPendingUserInput } from './channels/inputBuffer.js';
import { SessionRunStore } from './durable/SessionRunStore.js';
import type { RunState } from './durable/types.js';
import type { ResolvedSelection } from '../types/selection.js';
import { recordSignalDelivery } from './durable/replay.js';
import { resetTurnCount } from './policies/limits.js';
import { mutateSessionWithRetry } from '../session/utils.js';

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
}

export interface OpenRunResult {
  session: Session;
  runState: RunState;
  runStore: SessionRunStore;
  agent: AgentConfig;
}

export function sessionDerivedRunId(sessionId: string): string {
  return sessionId;
}

export async function openRun(
  agentsById: Map<string, AgentConfig>,
  options: OpenRunOptions,
): Promise<OpenRunResult> {
  const session = await loadOrCreateSession(options);
  const runId = sessionDerivedRunId(session.id);
  const runStore = new SessionRunStore(options.sessionStore, session.id);

  let runState = await runStore.getRunState(runId);
  if (!runState) {
    const now = Date.now();
    const initialMessages = options.seedMessages ?? [];
    runState = {
      runId,
      sessionId: session.id,
      status: 'running',
      activeAgentId: options.agentId ?? options.defaultAgentId,
      state: {},
      messages: [...initialMessages],
      createdAt: now,
      updatedAt: now,
    };
    await runStore.initRun(runState);
    if (initialMessages.length > 0) {
      await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
        latest.messages = [...initialMessages];
      });
    }
  }

  if (options.historyDelta?.length) {
    runState.messages = [...runState.messages, ...options.historyDelta];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
    await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
      latest.messages = [...latest.messages, ...options.historyDelta!];
    });
  }

  if (options.signalDelivery) {
    await recordSignalDelivery(runStore, runState, options.signalDelivery);
    runState = (await runStore.getRunState(runId)) ?? runState;
  }

  if (options.selection?.formData) {
    runState.state = { ...runState.state, ...options.selection.formData };
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

  const isResume = Boolean(options.signalDelivery);
  const isFlowContinuation = Boolean(runState.activeFlow);
  const isFreshLogicalRun =
    (hasInput || Boolean(options.wake)) && !isResume && !isFlowContinuation;
  if (isFreshLogicalRun) {
    runState.runEpoch = (runState.runEpoch ?? 0) + 1;
    await runStore.pruneStepsBeforeEpoch(runId, runState.runEpoch);
    resetTurnCount(runState);
    if (Array.isArray(runState.state.__completedFlows)) {
      runState.state.__completedFlows = [];
    }
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
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
      await runStore.putRunState(runState);
      await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
        setPendingUserInput(latest, effectiveInput);
      });
    } else {
      const userMessage: ModelMessage = { role: 'user', content: effectiveInput };
      runState.messages = [...runState.messages, userMessage];
      runState.updatedAt = Date.now();
      await runStore.putRunState(runState);
      await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
        latest.messages = [...latest.messages, userMessage];
      });
    }
  }

  if (options.wake && !hasInput) {
    const payloadNote = options.wake.payload
      ? ` Context: ${JSON.stringify(options.wake.payload)}.`
      : '';
    const wakeMessage: ModelMessage = {
      role: 'system',
      content:
        `[Scheduled wake: ${options.wake.reason}]${payloadNote} ` +
        'There is no new user message. Re-engage the user proactively per your instructions; ' +
        'if a task is in progress, follow up on it gently.',
    };
    runState.messages = [...runState.messages, wakeMessage];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
    await mutateSessionWithRetry(options.sessionStore, session.id, (latest) => {
      latest.messages = [...latest.messages, wakeMessage];
    });
  }

  const agent = agentsById.get(runState.activeAgentId);
  if (!agent) {
    throw new Error(`Unknown activeAgentId "${runState.activeAgentId}"`);
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

async function loadOrCreateSession(options: OpenRunOptions): Promise<Session> {
  const existing = await options.sessionStore.get(options.sessionId);
  if (existing) {
    return existing;
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
