import { describe, expect, it } from 'bun:test';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.ts';
import { RoutedPersistentMemoryStore } from '../../src/memory/blocks/RoutedPersistentMemoryStore.ts';
import { TieredPersistentMemoryStore } from '../../src/memory/blocks/TieredPersistentMemoryStore.ts';

describe('RoutedPersistentMemoryStore', () => {
  it('routes by scope to the configured backend', async () => {
    const userStore = new InMemoryPersistentMemoryStore();
    const agentStore = new InMemoryPersistentMemoryStore();
    const store = new RoutedPersistentMemoryStore({
      routes: { user: userStore, agent: agentStore },
    });

    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'user data', charLimit: 1000 },
      'alice',
    );
    await store.saveBlock(
      { key: 'MEMORY', scope: 'agent', content: 'agent notes', charLimit: 1000 },
      'support-bot',
    );

    expect((await store.loadBlock('user', 'alice', 'USER'))?.content).toBe('user data');
    expect((await store.loadBlock('agent', 'support-bot', 'MEMORY'))?.content).toBe(
      'agent notes',
    );
    expect(await userStore.listBlocks('user', 'alice')).toEqual(['USER']);
    expect(await agentStore.listBlocks('agent', 'support-bot')).toEqual(['MEMORY']);
  });

  it('uses default store when scope is not mapped', async () => {
    const fallback = new InMemoryPersistentMemoryStore();
    const store = new RoutedPersistentMemoryStore({ routes: {}, default: fallback });

    await store.saveBlock(
      { key: 'shared-notes', scope: 'shared', content: 'shared ctx', charLimit: 500 },
      'team-1',
    );
    expect((await store.loadBlock('shared', 'team-1', 'shared-notes'))?.content).toBe(
      'shared ctx',
    );
  });

  it('supports custom route function', async () => {
    const east = new InMemoryPersistentMemoryStore();
    const west = new InMemoryPersistentMemoryStore();
    const store = new RoutedPersistentMemoryStore({
      routes: {},
      route: (_scope, owner) => (owner.startsWith('eu-') ? east : west),
    });

    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'eu user', charLimit: 1000 },
      'eu-alice',
    );
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'us user', charLimit: 1000 },
      'us-bob',
    );

    expect((await east.loadBlock('user', 'eu-alice', 'USER'))?.content).toBe('eu user');
    expect((await west.loadBlock('user', 'us-bob', 'USER'))?.content).toBe('us user');
  });
});

describe('TieredPersistentMemoryStore', () => {
  it('read-through: cache miss loads durable and populates cache', async () => {
    const cache = new InMemoryPersistentMemoryStore();
    const durable = new InMemoryPersistentMemoryStore();
    const tiered = new TieredPersistentMemoryStore(cache, durable);

    await durable.saveBlock(
      { key: 'USER', scope: 'user', content: 'from durable', charLimit: 1000 },
      'alice',
    );

    const loaded = await tiered.loadBlock('user', 'alice', 'USER');
    expect(loaded?.content).toBe('from durable');
    expect((await cache.loadBlock('user', 'alice', 'USER'))?.content).toBe('from durable');
  });

  it('cache hit avoids durable read', async () => {
    const cache = new InMemoryPersistentMemoryStore();
    const durable = new InMemoryPersistentMemoryStore();
    const tiered = new TieredPersistentMemoryStore(cache, durable);

    await cache.saveBlock(
      { key: 'USER', scope: 'user', content: 'cached only', charLimit: 1000 },
      'bob',
    );

    expect((await tiered.loadBlock('user', 'bob', 'USER'))?.content).toBe('cached only');
    expect(await durable.loadBlock('user', 'bob', 'USER')).toBeNull();
  });

  it('write-through updates both tiers', async () => {
    const cache = new InMemoryPersistentMemoryStore();
    const durable = new InMemoryPersistentMemoryStore();
    const tiered = new TieredPersistentMemoryStore(cache, durable);

    await tiered.saveBlock(
      { key: 'MEMORY', scope: 'agent', content: 'written once', charLimit: 1000 },
      'bot-1',
    );

    expect((await cache.loadBlock('agent', 'bot-1', 'MEMORY'))?.content).toBe('written once');
    expect((await durable.loadBlock('agent', 'bot-1', 'MEMORY'))?.content).toBe('written once');
  });

  it('delete removes from both tiers', async () => {
    const cache = new InMemoryPersistentMemoryStore();
    const durable = new InMemoryPersistentMemoryStore();
    const tiered = new TieredPersistentMemoryStore(cache, durable);

    await tiered.saveBlock(
      { key: 'temp', scope: 'user', content: 'gone', charLimit: 100 },
      'carol',
    );
    await tiered.deleteBlock('user', 'carol', 'temp');

    expect(await cache.loadBlock('user', 'carol', 'temp')).toBeNull();
    expect(await durable.loadBlock('user', 'carol', 'temp')).toBeNull();
  });
});
