import type { Session } from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core';
import type { RunState } from '@kuralle-agents/core/runtime/durable/types.js';
import { SessionRunStore } from '../../../core/dist/runtime/durable/SessionRunStore.js';
import { createRunContext } from '../../../core/dist/runtime/ctx.js';
import { loadRecordedSteps } from '../../../core/dist/runtime/durable/replay.js';
import type { EffectToolExecutor } from '../../../core/dist/types/run-context.js';
import type { Policy } from '@kuralle-agents/core';

const stubModel = {} as import('ai').LanguageModel;

export function makeTestSession(sessionId = 'sess-1'): Session {
  const now = new Date();
  return {
    id: sessionId,
    conversationId: sessionId,
    channelId: 'api',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

export function makeRunState(sessionId: string, runId = 'run-1'): RunState {
  const now = Date.now();
  return {
    runId,
    sessionId,
    status: 'running',
    activeAgentId: 'agent-1',
    state: {},
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function setupDurableHarness(sessionId = 'sess-1', runId = 'run-1') {
  const session = makeTestSession(sessionId);
  const memoryStore = new MemoryStore();
  await memoryStore.save(session);

  const runStore = new SessionRunStore(memoryStore, sessionId);
  const runState = makeRunState(sessionId, runId);
  await runStore.initRun(runState);

  return { session, memoryStore, runStore, runState };
}

export async function buildPolicyCtx(args: {
  session: Session;
  runStore: SessionRunStore;
  runState: RunState;
  toolExecutor: EffectToolExecutor;
  policy?: Policy;
}) {
  const steps = await loadRecordedSteps(args.runStore, args.runState.runId);
  const freshRunState =
    (await args.runStore.getRunState(args.runState.runId)) ?? args.runState;

  return createRunContext({
    session: args.session,
    runState: freshRunState,
    runStore: args.runStore,
    steps,
    toolExecutor: args.toolExecutor,
    model: stubModel,
    emit: () => {},
    policy: args.policy,
  });
}
