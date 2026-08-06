import { InMemoryExtractedValueStore } from './InMemoryExtractedValueStore.js';
import type { ExtractedValueStore } from './store.js';

/** Resolves the store for `runExtractors`, defaulting to in-memory when omitted. */
export function resolveExtractedValueStore(
  harnessDefault?: ExtractedValueStore,
): ExtractedValueStore {
  return harnessDefault ?? new InMemoryExtractedValueStore();
}
