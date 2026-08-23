import type { Runtime } from '@kuralle-agents/core';

export interface AgentRunState {
  activeFlow?: string;
  runEpoch?: number;
  completedFlows?: unknown;
  roles: string[];
}

/** Read flow position + message roles from the public runtime stores (CLI-internal). */
export async function readAgentRunState(
  runtime: Runtime,
  sessionId: string,
): Promise<AgentRunState> {
  const s = await runtime.getSession(sessionId);
  const runState = s ? await runtime.getRunStore(sessionId).getRunState(sessionId) : null;
  return {
    activeFlow: runState?.activeFlow,
    runEpoch: runState?.runEpoch,
    completedFlows: runState?.state.__completedFlows,
    roles: (s?.messages ?? []).map((m) => m.role),
  };
}
