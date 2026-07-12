import type { SessionStore } from '@kuralle-agents/core';

export interface AgentRunState {
  activeFlow?: string;
  runEpoch?: number;
  completedFlows?: unknown;
  roles: string[];
}

/** Read flow position + message roles from the durable run journal (CLI-internal). */
export async function readAgentRunState(
  store: SessionStore,
  sessionId: string,
): Promise<AgentRunState> {
  const s = await store.get(sessionId);
  const rs = (s as unknown as {
    durableRuns?: Record<string, {
      runState?: {
        activeFlow?: string;
        runEpoch?: number;
        state?: Record<string, unknown>;
        activeAgentId?: string;
      };
    }>;
  })?.durableRuns?.[sessionId]?.runState;
  return {
    activeFlow: rs?.activeFlow,
    runEpoch: rs?.runEpoch,
    completedFlows: (rs?.state as Record<string, unknown> | undefined)?.__completedFlows,
    roles: (s?.messages ?? []).map((m) => m.role),
  };
}