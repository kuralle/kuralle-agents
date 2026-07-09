export type {
  ChunkDef,
  CagRetrieveInput,
  CagRetrieveOutput,
  CagAnswerInput,
  CagAnswerOutput,
  CagToolOptions,
  CagAnswerToolOptions,
  CagRetrieveTool,
  CagAnswerTool,
} from './cag/types.js';

export { createCagTool } from './cag/createCagTool.js';
export { createCagAnswerTool } from './cag/createCagAnswerTool.js';

// Vector retrieval tool — canonical site (moved from @kuralle-agents/rag in C-8.4).
// @kuralle-agents/rag re-exports until Phase 5 cleanup.
export { createVectorRetrievalTool } from './vector/createVectorRetrievalTool.js';
export type {
  VectorRetrievalToolOptions,
  VectorRetrievalToolOutput,
  VectorRetrievalToolInput,
  FilterableFieldDescriptor,
} from './vector/createVectorRetrievalTool.js';
