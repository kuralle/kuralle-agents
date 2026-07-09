/// <reference types="bun-types" />
import { describe, test, expect, beforeEach } from 'bun:test';

import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';

export type PersistentMemoryStoreFactory = () =>
  | PersistentMemoryStore
  | Promise<PersistentMemoryStore>;

export type PersistentMemoryDurabilityFactory = () =>
  | {
      storeA: PersistentMemoryStore;
      storeB: PersistentMemoryStore;
    }
  | Promise<{
      storeA: PersistentMemoryStore;
      storeB: PersistentMemoryStore;
    }>;

const sampleBlock = (
  overrides: Partial<PersistentMemoryBlock> = {},
): PersistentMemoryBlock => ({
  key: 'USER',
  scope: 'user',
  content: 'name: Maya\nprefers: vegetarian',
  charLimit: 1000,
  ...overrides,
});

export function runPersistentMemoryStoreContract(
  factory: PersistentMemoryStoreFactory,
): void {
  describe('PersistentMemoryStore contract', () => {
    let store: PersistentMemoryStore;

    beforeEach(async () => {
      store = await factory();
    });

    test('loadBlock returns null for missing block', async () => {
      expect(await store.loadBlock('user', 'alice', 'USER')).toBeNull();
    });

    test('saveBlock + loadBlock round-trips', async () => {
      const block = sampleBlock();
      await store.saveBlock(block, 'maya@example.com');
      const loaded = await store.loadBlock('user', 'maya@example.com', 'USER');
      expect(loaded).not.toBeNull();
      expect(loaded!.content).toBe(block.content);
      expect(loaded!.scope).toBe('user');
      expect(loaded!.key).toBe('USER');
      expect(typeof loaded!.updatedAt).toBe('string');
    });

    test('listBlocks returns keys within scope+owner', async () => {
      await store.saveBlock(sampleBlock({ key: 'USER' }), 'bob');
      await store.saveBlock(
        sampleBlock({ key: 'preferences', content: 'dark mode' }),
        'bob',
      );
      await store.saveBlock(
        sampleBlock({ key: 'MEMORY', scope: 'agent', content: 'notes' }),
        'bob',
      );
      expect((await store.listBlocks('user', 'bob')).sort()).toEqual([
        'USER',
        'preferences',
      ]);
      expect(await store.listBlocks('agent', 'bob')).toEqual(['MEMORY']);
    });

    test('listBlocks returns empty array when none exist', async () => {
      expect(await store.listBlocks('user', 'never-existed')).toEqual([]);
    });

    test('deleteBlock removes block; no-op when missing', async () => {
      await store.saveBlock(sampleBlock({ key: 'ephemeral' }), 'dave');
      await store.deleteBlock('user', 'dave', 'ephemeral');
      expect(await store.loadBlock('user', 'dave', 'ephemeral')).toBeNull();
      await store.deleteBlock('user', 'dave', 'ephemeral');
    });
  });
}

export function runPersistentMemoryDurabilityContract(
  factory: PersistentMemoryDurabilityFactory,
): void {
  describe('PersistentMemoryStore durability', () => {
    test('store B reads block written by store A', async () => {
      const { storeA, storeB } = await factory();
      await storeA.saveBlock(sampleBlock({ content: 'durable payload' }), 'owner-1');
      const loaded = await storeB.loadBlock('user', 'owner-1', 'USER');
      expect(loaded?.content).toBe('durable payload');
    });
  });
}
