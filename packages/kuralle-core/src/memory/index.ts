export type { MemoryService } from './MemoryService.js';
export type {
  MemoryEntry,
  SearchMemoryRequest,
  SearchMemoryResponse,
  MemoryIngestionOptions,
} from './types.js';
export { InMemoryMemoryService } from './stores/InMemoryMemoryService.js';
export { preloadMemoryContext } from './preloadMemory.js';
export { extractMemories } from './utils.js';
export {
  createFactMemoryService,
  type FactMemoryServiceOptions,
} from './factMemoryService.js';

// ── Persistent memory blocks (PR-5) ─────────────────────────────────
export type {
  PersistentMemoryStore,
  PersistentMemoryBlock,
  PersistentMemoryConfig,
  MemoryBlockScope,
} from './blocks/types.js';
export type { WorkingMemoryBlockSpec, WorkingMemoryConfig } from '../types/grounding.js';
export {
  DEFAULT_BLOCK_CHAR_LIMIT,
  DEFAULT_AUTO_LOAD_BLOCKS,
} from './blocks/types.js';
export { InMemoryPersistentMemoryStore } from './blocks/InMemoryPersistentMemoryStore.js';
export {
  FilePersistentMemoryStore,
  type FilePersistentMemoryStoreOptions,
} from './blocks/FilePersistentMemoryStore.js';
export {
  RoutedPersistentMemoryStore,
  type RoutedPersistentMemoryStoreConfig,
  type MemoryRouteFn,
} from './blocks/RoutedPersistentMemoryStore.js';
export { TieredPersistentMemoryStore } from './blocks/TieredPersistentMemoryStore.js';
export { scanMemoryWrite, type SafetyScanResult } from './blocks/safetyScanner.js';
export { buildMemoryBlockTool, type MemoryBlockToolOptions } from './blocks/memoryBlockTool.js';
