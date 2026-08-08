import type { Session, ToolContext } from '@kuralle-agents/core';
import type { RunState } from '@kuralle-agents/core/runtime/durable/types.js';

export function minimalToolContext(session: Session): ToolContext {
  const runState: RunState = {
    runId: 'run-test',
    sessionId: session.id,
    status: 'running',
    activeAgentId: 'main',
    state: {},
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    session,
    runState,
    tool: async () => undefined,
    now: async () => Date.now(),
    uuid: async () => 'uuid-test',
    emit: () => {},
    getSkill: () => {
      throw new Error('getSkill not available in MCP tests');
    },
  };
}

export function snapshotPersistedState(session: Session, runState: RunState): string {
  return JSON.stringify({
    session: {
      workingMemory: session.workingMemory,
      state: session.state,
      messages: session.messages,
    },
    runState: runState.state,
  });
}
