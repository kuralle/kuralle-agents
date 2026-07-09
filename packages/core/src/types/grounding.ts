import type { MemoryBlockScope, PersistentMemoryConfig } from '../memory/blocks/types.js';

export interface AgentKnowledge {
  /** Whether the runtime retrieves automatically. Default: `true`.
   *  - `true` (guaranteed): pre-inject retrieved knowledge before every
   *    answering turn — always grounded; a fused routing turn pays the
   *    retrieval cost (the price of a kept grounding promise).
   *  - `false` (on-demand): the runtime does not auto-inject; instead the model
   *    is given a `knowledge_search` tool and retrieves only when it answers, so
   *    routing/dispatch turns pay zero retrieval tax (grounding becomes
   *    model-discretion). `autoRetrieve` and the tool are mutually exclusive —
   *    the boolean picks the invoker (runtime vs model), not a separate mode. */
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
