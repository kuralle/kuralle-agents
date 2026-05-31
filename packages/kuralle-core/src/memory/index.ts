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

// ── Persistent memory blocks (PR-5) ─────────────────────────────────
export type {
  PersistentMemoryStore,
  PersistentMemoryBlock,
  PersistentMemoryConfig,
  MemoryBlockScope,
} from './blocks/types.js';
export {
  DEFAULT_BLOCK_CHAR_LIMIT,
  DEFAULT_AUTO_LOAD_BLOCKS,
} from './blocks/types.js';
export {
  FilePersistentMemoryStore,
  type FilePersistentMemoryStoreOptions,
} from './blocks/FilePersistentMemoryStore.js';
export { scanMemoryWrite, type SafetyScanResult } from './blocks/safetyScanner.js';
export { buildMemoryBlockTool, type MemoryBlockToolOptions } from './blocks/memoryBlockTool.js';
