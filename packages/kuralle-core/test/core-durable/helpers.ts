import type { LanguageModel } from 'ai';
import type { Session } from '../../src/types/session.js';
import type { RunState } from '../../src/runtime/durable/types.js';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { loadRecordedSteps } from '../../src/runtime/durable/replay.js';

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

export const stubModel = {} as LanguageModel;

export async function setupDurableHarness(sessionId = 'sess-1', runId = 'run-1') {
  const session = makeTestSession(sessionId);
  const memoryStore = new MemoryStore();
  await memoryStore.save(session);

  const runStore = new SessionRunStore(memoryStore, sessionId);
  const runState = makeRunState(sessionId, runId);
  await runStore.initRun(runState);

  return { session, memoryStore, runStore, runState };
}

export async function buildCtx(
  args: {
    session: Session;
    runStore: SessionRunStore;
    runState: RunState;
    toolExecutor: EffectToolExecutor;
    fs?: import('../../src/types/filesystem.js').FileSystem;
    clock?: { now(): number; uuid(): string };
    emit?: (part: import('../../src/types/stream.js').HarnessStreamPart) => void;
  },
) {
  const steps = await loadRecordedSteps(args.runStore, args.runState.runId);
  const freshRunState = (await args.runStore.getRunState(args.runState.runId)) ?? args.runState;

  return createRunContext({
    session: args.session,
    runState: freshRunState,
    runStore: args.runStore,
    steps,
    toolExecutor: args.toolExecutor,
    model: stubModel,
    fs: args.fs,
    clock: args.clock,
    emit: args.emit,
  });
}

export async function reloadRunState(runStore: SessionRunStore, runId: string): Promise<RunState> {
  const state = await runStore.getRunState(runId);
  if (!state) {
    throw new Error(`Missing run state for ${runId}`);
  }
  return state;
}
