import { InMemoryExtractedValueStore } from './InMemoryExtractedValueStore.js';
import type { ExtractedValueStore } from './store.js';

let nodeDefaultFactory: (() => ExtractedValueStore) | undefined;

/**
 * Lets the Node-only file store register itself as the default without core
 * importing `node:fs` — the same indirection `defaultStoreRegistry` uses for
 * working-memory blocks, and for the same reason: this module must stay
 * importable on workerd.
 */
export function registerNodeDefaultExtractedValueStore(
  factory: () => ExtractedValueStore,
): void {
  nodeDefaultFactory = factory;
}

/**
 * Resolves the store for `runExtractors`.
 *
 * On Node this defaults to the FILE store, not the in-memory one. The path this
 * replaced took a caller-supplied `PersistentMemoryStore`, so an in-memory
 * default would have been a silent durability regression: facts would survive
 * until the next restart and no error would say so. Off Node (workerd) there is
 * no filesystem, so in-memory remains the fallback and a deployment there is
 * expected to pass a real store.
 */
export function resolveExtractedValueStore(
  harnessDefault?: ExtractedValueStore,
): ExtractedValueStore {
  if (harnessDefault) return harnessDefault;
  const nodeDefault = typeof process !== 'undefined' && process.versions?.node
    ? nodeDefaultFactory
    : undefined;
  return nodeDefault ? nodeDefault() : new InMemoryExtractedValueStore();
}
