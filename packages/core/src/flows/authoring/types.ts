import type { FlowDefinition } from '../definition/types.js';
import type { FlowDefinitionsStore } from '../definition/store.js';
import type { FlowBuilderCatalogSource } from './catalog.js';

export interface FlowBuilderRuntime {
  addDynamicFlows(
    defs: readonly FlowDefinition[],
    opts: { agentId: string; store?: FlowDefinitionsStore; replace?: boolean },
  ): Promise<void>;
}

export interface FlowBuilderHost {
  /** Agent the saved definition is registered onto. */
  targetAgentId: string;
  getRuntime: () => FlowBuilderRuntime;
  tools: () => FlowBuilderCatalogSource;
  flows?: () => FlowBuilderCatalogSource;
  agents?: () => FlowBuilderCatalogSource;
}
