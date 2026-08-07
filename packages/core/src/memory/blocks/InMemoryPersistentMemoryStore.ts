import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';

/**
 * Nested by (scope, owner, key) rather than a joined string — a `Map` can key
 * on any value, so there is nothing to flatten and therefore nothing that can
 * rearrange across a delimiter. The previous `` `${scope}:${owner}:${key}` ``
 * composition made `(owner: 'a:b', key: 'K')` and `(owner: 'a', key: 'b:K')`
 * the same map entry, and `listBlocks`'s prefix scan compounded it by also
 * matching owner `a`'s scan against owner `a:b`'s rows.
 */
export class InMemoryPersistentMemoryStore implements PersistentMemoryStore {
  private readonly blocks = new Map<
    MemoryBlockScope,
    Map<string, Map<string, PersistentMemoryBlock>>
  >();

  private ownerBlocks(
    scope: MemoryBlockScope,
    owner: string,
  ): Map<string, PersistentMemoryBlock> | undefined {
    return this.blocks.get(scope)?.get(owner);
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    return this.ownerBlocks(scope, owner)?.get(key) ?? null;
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    let byOwner = this.blocks.get(block.scope);
    if (!byOwner) {
      byOwner = new Map();
      this.blocks.set(block.scope, byOwner);
    }
    let byKey = byOwner.get(owner);
    if (!byKey) {
      byKey = new Map();
      byOwner.set(owner, byKey);
    }
    byKey.set(block.key, { ...block, updatedAt: new Date().toISOString() });
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    this.ownerBlocks(scope, owner)?.delete(key);
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    return [...(this.ownerBlocks(scope, owner)?.keys() ?? [])].sort();
  }
}
