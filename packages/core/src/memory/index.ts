export { preloadMemoryContext } from './preloadMemory.js';

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
export {
  InvalidOwnerError,
  InvalidBlockKeyError,
  assertValidOwner,
  assertValidBlockKey,
  isValidOwner,
  isValidBlockKey,
  withOwnerValidation,
  encodeSegment,
  encodeRedisSegment,
  encodeFileSegment,
  decodeFileSegment,
} from './blocks/ownerKey.js';

// ── Memory extractors ───────────────────────────────────────────────
export type {
  Extractor,
  ExtractorRuntimeContext,
  ExtractorOnExtractedContext,
  ResolvedExtractor,
} from './extract/types.js';
export {
  defineExtractor,
  slugifyExtractorName,
  assertValidSlug,
  validateExtractorList,
  resolveExtractor,
  type DefineExtractorConfig,
} from './extract/defineExtractor.js';

export type { ExtractedValue, ExtractedValueStore } from './extract/store.js';
export { InMemoryExtractedValueStore } from './extract/InMemoryExtractedValueStore.js';
export { FileExtractedValueStore } from './extract/FileExtractedValueStore.js';
export {
  extractedValueStoreConformanceCases,
  type ExtractedValueStoreConformanceCase,
} from './extract/testing.js';
export {
  runExtractors,
  type RunExtractorsOptions,
  type ExtractionRunResult,
} from './extract/runExtractors.js';
export {
  shouldExtract,
  detectTurnHadToolCalls,
  resolveExtractionConfig,
  DEFAULT_EXTRACTION_TRIGGER,
  type ExtractionConfig,
  type ExtractionTrigger,
} from './extract/trigger.js';
export {
  runExtractionAtClose,
  extractionSucceeded,
} from './extract/runExtraction.js';
export { resolveExtractedValueStore } from './extract/resolveExtractedValueStore.js';
export {
  factsExtractor,
  FACTS_EXTRACTOR_SLUG,
  type FactsExtractorOptions,
  type FactsValue,
} from './extract/builtin/factsExtractor.js';
export {
  buildSearchMemoryTool,
  type SearchMemoryToolOptions,
} from './extract/searchMemoryTool.js';
