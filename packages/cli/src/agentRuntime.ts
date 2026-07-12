import type { Runtime, SessionStore, TraceStore } from '@kuralle-agents/core';

export interface AgentRuntime {
  runtime: Runtime;
  store: SessionStore;
  sessionId: string;
  agentId: string;
  label: string;
  readState: () => Promise<{
    activeFlow?: string;
    runEpoch?: number;
    completedFlows?: unknown;
    roles: string[];
  }>;
}

export type BuildRuntime = (
  sessionId?: string,
  store?: SessionStore,
  traceStore?: TraceStore,
) => AgentRuntime;