import type { PersistentMemoryStore } from '../../memory/blocks/types.js';

let nodeDefaultStoreFactory: (() => PersistentMemoryStore) | undefined;

export function registerNodeDefaultWorkingMemoryStore(
  factory: () => PersistentMemoryStore,
): void {
  nodeDefaultStoreFactory = factory;
}

export function getNodeDefaultWorkingMemoryStore(): (() => PersistentMemoryStore) | undefined {
  if (typeof process === 'undefined' || !process.versions?.node) {
    return undefined;
  }
  return nodeDefaultStoreFactory;
}
