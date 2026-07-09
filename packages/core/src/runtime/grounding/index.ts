export {
  appendGatherBlocks,
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  buildKnowledgeTool,
} from './knowledge.js';
export {
  buildMemoryService,
  resetMissingUserIdWarningsForTests,
  runMemoryIngest,
  warnMissingUserId,
} from './memory.js';
export {
  wireWorkingMemory,
  loadWorkingMemoryBlocks,
  formatWorkingMemorySection,
  resolveWorkingMemoryStore,
  resolveWorkingMemoryOwner,
  type LoadedWorkingMemoryBlock,
  type WiredWorkingMemory,
} from './workingMemory.js';
export { runGatherPhase, type GatherResult, type GatherScope } from './gather.js';
export { resolveNodeGatherScope } from './nodeScope.js';
export {
  createInMemoryKnowledgeConfig,
  createInMemoryKnowledgeRetriever,
  type InMemoryKnowledgeDocument,
} from './inMemoryKnowledge.js';
