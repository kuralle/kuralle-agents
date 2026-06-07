import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';

export class TieredPersistentMemoryStore implements PersistentMemoryStore {
  constructor(
    private readonly cache: PersistentMemoryStore,
    private readonly durable: PersistentMemoryStore,
  ) {}

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    const cached = await this.cache.loadBlock(scope, owner, key);
    if (cached) {
      return cached;
    }
    const fromDurable = await this.durable.loadBlock(scope, owner, key);
    if (fromDurable) {
      await this.cache.saveBlock(fromDurable, owner);
    }
    return fromDurable;
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    await this.durable.saveBlock(block, owner);
    await this.cache.saveBlock(block, owner);
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    await this.durable.deleteBlock(scope, owner, key);
    await this.cache.deleteBlock(scope, owner, key);
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    return this.durable.listBlocks(scope, owner);
  }
}
