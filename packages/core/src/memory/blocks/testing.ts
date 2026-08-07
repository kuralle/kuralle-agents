/// <reference types="bun-types" />
import { describe, test, expect, beforeEach } from 'bun:test';

import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from './types.js';
import { InvalidBlockKeyError, InvalidOwnerError, withOwnerValidation } from './ownerKey.js';

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

    // ── Owner pairs that must not share a row ──────────────────────────
    //
    // Every pair here collided in at least one of InMemoryPersistentMemoryStore
    // (a `${scope}:${owner}:${key}` string) or FilePersistentMemoryStore (a
    // lossy `_`-collapsing sanitizer) before the owner-key fix. Run against
    // the raw store from the factory — this is a property of the backend
    // itself, independent of whatever validates its callers.
    const OWNER_COLLISION_PAIRS: ReadonlyArray<readonly [string, string]> = [
      ['alice/bob', 'alice_bob'],
      ['alice\\bob', 'alice_bob'],
      ['alice//bob', 'alice/bob'],
      ['..', '_'],
      // `['alice.bob', 'alice%2Ebob']` used to sit here and was dropped: it
      // collides in no backend, before or after the fix, so it could never fail.
      // Its replacement does — a literal '%' in an owner must survive a
      // round-trip through the encoder, and must not be readable as the escape
      // introduced by encoding something else.
      ['alice%2Fbob', 'alice/bob'],
      ['100%', '100%25'],
    ];

    test('never lets two distinct owners share a row', async () => {
      for (const [left, right] of OWNER_COLLISION_PAIRS) {
        await store.saveBlock(sampleBlock({ content: `left:${left}` }), left);
        await store.saveBlock(sampleBlock({ content: `right:${right}` }), right);
        expect((await store.loadBlock('user', left, 'USER'))?.content).toBe(`left:${left}`);
        expect((await store.loadBlock('user', right, 'USER'))?.content).toBe(`right:${right}`);
      }
    });

    // `(owner: 'a:b', key: 'K')` and `(owner: 'a', key: 'b:K')` composed to the
    // same string under `${scope}:${owner}:${key}` — no fixed owner-only table
    // can express this, since it is the owner/key *boundary* that moves.
    const REARRANGEMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
      ['a', 'b:K'],
      ['a:b', 'K'],
      // `['x','y.z'] / ['x.y','z']` used to sit here and was dropped: no backend
      // ever joined on '.', so those rows could not rearrange in any version of
      // this code. '/' is a real separator for the File store, so these can.
      ['x', 'y/z'],
      ['x/y', 'z'],
    ];

    test('never lets an (owner, key) pair rearrange into another row', async () => {
      for (const [owner, key] of REARRANGEMENT_PAIRS) {
        await store.saveBlock(sampleBlock({ key, content: `${owner}|${key}` }), owner);
      }
      for (const [owner, key] of REARRANGEMENT_PAIRS) {
        expect((await store.loadBlock('user', owner, key))?.content).toBe(`${owner}|${key}`);
        expect(await store.listBlocks('user', owner)).toContain(key);
      }
    });

    // The File store encodes keys into filenames and decodes them back out in
    // listBlocks. Nothing exercised that decode with a '%' in the key, because
    // every other case writes keys the encoder leaves untouched — so the round
    // trip was asserted only where it could not fail.
    test('a key containing % survives the listBlocks round trip', async () => {
      for (const key of ['100%', 'a%2Fb', 'x%y']) {
        await store.saveBlock(sampleBlock({ key, content: `v:${key}` }), 'pct-owner');
      }
      const listed = await store.listBlocks('user', 'pct-owner');
      for (const key of ['100%', 'a%2Fb', 'x%y']) {
        expect(listed).toContain(key);
        expect((await store.loadBlock('user', 'pct-owner', key))?.content).toBe(`v:${key}`);
      }
    });

    test("listBlocks does not leak a sibling owner's blocks via a prefix match", async () => {
      await store.saveBlock(sampleBlock({ key: 'SECRET', content: 'private' }), 'a:b');
      expect(await store.listBlocks('user', 'a')).toEqual([]);
    });

    // Redis's block index used to live at `${prefix}:wm:${scope}:${owner}:__index`
    // — the same keyspace as blocks themselves, so a block literally named
    // `__index` overwrote the index set. `__index` is inside the encode-safe
    // charset and encodes to itself, so this is not fixed by encoding; it needs
    // its own namespace segment. Written generically so every backend, not just
    // Redis, is checked by construction.
    test('a block literally named "__index" does not corrupt listBlocks for its owner', async () => {
      await store.saveBlock(sampleBlock({ key: 'USER', content: 'real' }), 'idx-owner');
      await store.saveBlock(sampleBlock({ key: '__index', content: 'trap' }), 'idx-owner');
      expect((await store.listBlocks('user', 'idx-owner')).sort()).toEqual(['USER', '__index']);
      expect((await store.loadBlock('user', 'idx-owner', 'USER'))?.content).toBe('real');
      expect((await store.loadBlock('user', 'idx-owner', '__index'))?.content).toBe('trap');
    });
  });

  describe('PersistentMemoryStore owner/key validation', () => {
    let store: PersistentMemoryStore;

    beforeEach(async () => {
      store = withOwnerValidation(await factory());
    });

    const INVALID_OWNERS = [
      'alice/bob',
      'alice\\bob',
      'alice bob',
      '',
      'alice*bob',
      'alice?bob',
      'a\nb',
      'a\0b',
    ];

    test('rejects an owner outside the allow-list on save, rather than silently storing it', async () => {
      for (const owner of INVALID_OWNERS) {
        await expect(store.saveBlock(sampleBlock(), owner)).rejects.toBeInstanceOf(
          InvalidOwnerError,
        );
      }
    });

    test('rejects an invalid owner on load, delete and list too, not just save', async () => {
      await expect(store.loadBlock('user', 'alice/bob', 'USER')).rejects.toBeInstanceOf(
        InvalidOwnerError,
      );
      await expect(store.deleteBlock('user', 'alice/bob', 'USER')).rejects.toBeInstanceOf(
        InvalidOwnerError,
      );
      await expect(store.listBlocks('user', 'alice/bob')).rejects.toBeInstanceOf(
        InvalidOwnerError,
      );
    });

    test('rejects a block key outside the allow-list', async () => {
      for (const key of ['bad/key', 'bad key', '']) {
        await expect(
          store.saveBlock(sampleBlock({ key }), 'alice'),
        ).rejects.toBeInstanceOf(InvalidBlockKeyError);
      }
      await expect(store.loadBlock('user', 'alice', 'bad/key')).rejects.toBeInstanceOf(
        InvalidBlockKeyError,
      );
    });

    test('accepts owners using every legal separator character', async () => {
      const legalOwners = [
        'google-oauth2|123',
        'tenant:user',
        'maya+test@example.com',
        'user.name',
        'user~name',
      ];
      for (const owner of legalOwners) {
        await store.saveBlock(sampleBlock({ content: owner }), owner);
        expect((await store.loadBlock('user', owner, 'USER'))?.content).toBe(owner);
      }
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
