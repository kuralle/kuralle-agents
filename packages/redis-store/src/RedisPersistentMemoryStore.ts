import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from '@kuralle-agents/core';
import type { RedisClientLike } from './RedisSessionStore.js';
import {
  addMembers,
  callCommand,
  getMembers,
  removeMembers,
} from './redisHelpers.js';

export type RedisPersistentMemoryStoreOptions = {
  client: RedisClientLike;
  prefix?: string;
};

export class RedisPersistentMemoryStore implements PersistentMemoryStore {
  private client: RedisClientLike;
  private prefix: string;

  constructor(options: RedisPersistentMemoryStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'kuralle';
  }

  private blockKey(scope: MemoryBlockScope, owner: string, key: string): string {
    return `${this.prefix}:wm:${scope}:${owner}:${key}`;
  }

  private indexKey(scope: MemoryBlockScope, owner: string): string {
    return `${this.prefix}:wm:${scope}:${owner}:__index`;
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    const raw = await callCommand<string | null>(
      this.client,
      ['get'],
      this.blockKey(scope, owner, key),
    );
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as PersistentMemoryBlock;
      return {
        key,
        scope,
        content: parsed.content,
        charLimit: parsed.charLimit,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    const payload: PersistentMemoryBlock = {
      ...block,
      updatedAt: block.updatedAt ?? new Date().toISOString(),
    };
    const redisKey = this.blockKey(block.scope, owner, block.key);
    await callCommand(this.client, ['set'], redisKey, JSON.stringify(payload));
    await addMembers(this.client, this.indexKey(block.scope, owner), block.key);
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    await callCommand(this.client, ['del'], this.blockKey(scope, owner, key));
    await removeMembers(this.client, this.indexKey(scope, owner), key);
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    const keys = await getMembers(this.client, this.indexKey(scope, owner));
    return keys.sort();
  }
}
