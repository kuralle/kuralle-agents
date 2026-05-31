import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { SignalDelivery } from './durable/types.js';
import { setPendingUserInput } from './channels/inputBuffer.js';
import { SessionRunStore } from './durable/SessionRunStore.js';
import type { RunState } from './durable/types.js';
import { recordSignalDelivery } from './durable/replay.js';

export interface OpenRunOptions {
  sessionId: string;
  userId?: string;
  input?: string;
  agentId?: string;
  seedMessages?: ModelMessage[];
  historyDelta?: ModelMessage[];
  signalDelivery?: SignalDelivery;
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
      session.messages = [...initialMessages];
      await options.sessionStore.save(session);
    }
  }

  if (options.historyDelta?.length) {
    runState.messages = [...runState.messages, ...options.historyDelta];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
    session.messages = [...session.messages, ...options.historyDelta];
    await options.sessionStore.save(session);
  }

  if (options.signalDelivery) {
    await recordSignalDelivery(runStore, runState, options.signalDelivery);
    runState = (await runStore.getRunState(runId)) ?? runState;
  }

  if (options.input) {
    runState.updatedAt = Date.now();
    if (runState.activeFlow) {
      await runStore.putRunState(runState);
      const sessionAfterPersist = (await options.sessionStore.get(options.sessionId)) ?? session;
      setPendingUserInput(sessionAfterPersist, options.input);
      await options.sessionStore.save(sessionAfterPersist);
    } else {
      const userMessage: ModelMessage = { role: 'user', content: options.input };
      runState.messages = [...runState.messages, userMessage];
      runState.updatedAt = Date.now();
      await runStore.putRunState(runState);
      const sessionAfterPersist = (await options.sessionStore.get(options.sessionId)) ?? session;
      sessionAfterPersist.messages = [...sessionAfterPersist.messages, userMessage];
      await options.sessionStore.save(sessionAfterPersist);
    }
  }

  const agent = agentsById.get(runState.activeAgentId);
  if (!agent) {
    throw new Error(`Unknown activeAgentId "${runState.activeAgentId}"`);
  }

  const latestSession = (await options.sessionStore.get(options.sessionId)) ?? session;
  latestSession.currentAgent = runState.activeAgentId;
  latestSession.activeAgentId = runState.activeAgentId;
  await options.sessionStore.save(latestSession);

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
