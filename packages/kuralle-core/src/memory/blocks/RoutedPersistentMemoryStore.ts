import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';

export type MemoryRouteFn = (
  scope: MemoryBlockScope,
  owner: string,
) => PersistentMemoryStore;

export interface RoutedPersistentMemoryStoreConfig {
  routes: Partial<Record<MemoryBlockScope, PersistentMemoryStore>>;
  default?: PersistentMemoryStore;
  route?: MemoryRouteFn;
}

export class RoutedPersistentMemoryStore implements PersistentMemoryStore {
  private readonly routes: Partial<Record<MemoryBlockScope, PersistentMemoryStore>>;
  private readonly defaultStore?: PersistentMemoryStore;
  private readonly routeFn?: MemoryRouteFn;

  constructor(config: RoutedPersistentMemoryStoreConfig) {
    this.routes = config.routes;
    this.defaultStore = config.default;
    this.routeFn = config.route;
  }

  private resolve(scope: MemoryBlockScope, owner: string): PersistentMemoryStore {
    if (this.routeFn) {
      return this.routeFn(scope, owner);
    }
    const byScope = this.routes[scope];
    if (byScope) {
      return byScope;
    }
    if (this.defaultStore) {
      return this.defaultStore;
    }
    throw new Error(`No PersistentMemoryStore route for scope=${scope}`);
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    return this.resolve(scope, owner).loadBlock(scope, owner, key);
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    await this.resolve(block.scope, owner).saveBlock(block, owner);
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    await this.resolve(scope, owner).deleteBlock(scope, owner, key);
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    return this.resolve(scope, owner).listBlocks(scope, owner);
  }
}
