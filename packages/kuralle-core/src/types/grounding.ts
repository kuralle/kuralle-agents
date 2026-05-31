export interface AgentKnowledge {
  autoRetrieve?: boolean;
  sources?: string[];
}

export interface AgentMemory {
  preload?: {
    enabled?: boolean;
    tokenBudget?: number;
  };
  ingest?: {
    enabled?: boolean;
  };
}
