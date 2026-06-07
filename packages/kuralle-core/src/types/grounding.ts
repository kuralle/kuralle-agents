import type { MemoryBlockScope, PersistentMemoryConfig } from '../memory/blocks/types.js';

export interface AgentKnowledge {
  autoRetrieve?: boolean;
  sources?: string[];
}

export interface WorkingMemoryBlockSpec {
  scope: MemoryBlockScope;
  key: string;
  /** Seed content when the block is missing or empty (persisted on first write, not on read). */
  template?: string;
}

export interface WorkingMemoryConfig extends Omit<PersistentMemoryConfig, 'autoLoad'> {
  autoLoad?: WorkingMemoryBlockSpec[];
}

export interface AgentMemory {
  preload?: {
    enabled?: boolean;
    tokenBudget?: number;
  };
  ingest?: {
    enabled?: boolean;
  };
  /** Persistent markdown blocks (USER/MEMORY) loaded at session start and editable via memory_block. */
  workingMemory?: WorkingMemoryConfig;
}
