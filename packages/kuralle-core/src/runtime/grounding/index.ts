export {
  appendGatherBlocks,
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
} from './knowledge.js';
export {
  buildMemoryService,
  resetMissingUserIdWarningsForTests,
  runMemoryIngest,
  warnMissingUserId,
} from './memory.js';
export { runGatherPhase, type GatherResult, type GatherScope } from './gather.js';
export { resolveNodeGatherScope } from './nodeScope.js';
export {
  createInMemoryKnowledgeConfig,
  createInMemoryKnowledgeRetriever,
  type InMemoryKnowledgeDocument,
} from './inMemoryKnowledge.js';
