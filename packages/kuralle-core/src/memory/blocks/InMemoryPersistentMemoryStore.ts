import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';

function blockKey(scope: MemoryBlockScope, owner: string, key: string): string {
  return `${scope}:${owner}:${key}`;
}

export class InMemoryPersistentMemoryStore implements PersistentMemoryStore {
  private readonly blocks = new Map<string, PersistentMemoryBlock>();

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    return this.blocks.get(blockKey(scope, owner, key)) ?? null;
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    this.blocks.set(blockKey(block.scope, owner, block.key), {
      ...block,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    this.blocks.delete(blockKey(scope, owner, key));
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    const prefix = `${scope}:${owner}:`;
    return [...this.blocks.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
}
