import { describe, expect, it } from 'bun:test';
import {
  resolveWorkingMemoryOwner,
  wireWorkingMemory,
  loadWorkingMemoryBlocks,
} from '../../src/runtime/grounding/workingMemory.js';
import { resetMissingUserIdWarningsForTests } from '../../src/runtime/grounding/memory.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { DEFAULT_AUTO_LOAD_BLOCKS } from '../../src/memory/blocks/types.js';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import type { Session } from '../../src/types/session.js';

/**
 * A session with no `userId` used to resolve to the owner `'anonymous'`, which
 * every other userless session also resolved to — so one visitor's USER block
 * loaded into the next visitor's system prompt. `userId` is optional on
 * `chatRouter` and the OpenAI-compat endpoint, so that was reachable on any
 * hosted chat surface that did not pass one.
 */
function agentWith(autoLoad?: Array<{ scope: 'user' | 'agent' | 'shared'; key: string }>): AgentConfig {
  return {
    id: 'agent-a',
    instructions: 'Help.',
    memory: { workingMemory: { store: undefined, ...(autoLoad ? { autoLoad } : {}) } },
  } as unknown as AgentConfig;
}

function sessionWith(id: string, userId?: string): Session {
  return { id, messages: [], ...(userId ? { userId } : {}) } as unknown as Session;
}

describe('working-memory owner resolution fails closed', () => {
  it('returns undefined rather than a shared placeholder when there is no userId', () => {
    expect(resolveWorkingMemoryOwner('user', 'agent-a', undefined)).toBeUndefined();
    expect(resolveWorkingMemoryOwner('shared', 'agent-a', undefined)).toBeUndefined();
    // Agent scope is unaffected — agentId is always present.
    expect(resolveWorkingMemoryOwner('agent', 'agent-a', undefined)).toBe('agent-a');
    // With a userId, unchanged.
    expect(resolveWorkingMemoryOwner('user', 'agent-a', 'alice')).toBe('alice');
  });

  it('treats an empty, null or whitespace userId as absent, not as an owner', () => {
    // `chatRouter` forwards `body.userId` with no guard, so '' and null both
    // reach here from the wire. An `=== undefined` check would make '' a valid
    // shared owner — the same pooling defect wearing a different value.
    expect(resolveWorkingMemoryOwner('user', 'agent-a', '')).toBeUndefined();
    expect(resolveWorkingMemoryOwner('user', 'agent-a', '   ')).toBeUndefined();
    expect(resolveWorkingMemoryOwner('user', 'agent-a', null as unknown as undefined)).toBeUndefined();
    // A present id is returned verbatim — not trimmed — so no existing owner is
    // silently rewritten to a different storage key.
    expect(resolveWorkingMemoryOwner('user', 'agent-a', ' alice ')).toBe(' alice ');
  });

  it('two sessions both sending an empty userId cannot share a block', async () => {
    const store = new InMemoryPersistentMemoryStore();
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'SHOULD NOT BE VISIBLE', charLimit: 10_000 },
      '',
    );
    const loaded = await loadWorkingMemoryBlocks(
      store,
      [{ scope: 'user', key: 'USER' }],
      (scope) => resolveWorkingMemoryOwner(scope, 'agent-a', ''),
    );
    expect(loaded).toEqual([]);
  });

  it('two userless sessions cannot read each other through a shared owner', async () => {
    const store = new InMemoryPersistentMemoryStore();
    // Whatever a previous build wrote under the old placeholder owner...
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'alice is allergic to penicillin', charLimit: 10_000 },
      'anonymous',
    );

    // ...must not be visible to a session that simply has no userId.
    const loaded = await loadWorkingMemoryBlocks(
      store,
      [{ scope: 'user', key: 'USER' }],
      (scope) => resolveWorkingMemoryOwner(scope, 'agent-a', undefined),
    );
    expect(loaded).toEqual([]);
  });

  it('withholds the memory_block tool entirely when nothing is addressable', async () => {
    resetMissingUserIdWarningsForTests();
    const wired = await wireWorkingMemory(
      agentWith([{ scope: 'user', key: 'USER' }]),
      sessionWith('s1'),
      new InMemoryPersistentMemoryStore(),
    );
    // No addressable block => no prompt section AND no write tool.
    expect(wired).toBeUndefined();
  });

  it('keeps agent-scoped blocks working without a userId', async () => {
    resetMissingUserIdWarningsForTests();
    const store = new InMemoryPersistentMemoryStore();
    await store.saveBlock(
      { key: 'MEMORY', scope: 'agent', content: 'deploys run at 02:00 UTC', charLimit: 10_000 },
      'agent-a',
    );

    const wired = await wireWorkingMemory(
      agentWith([{ scope: 'agent', key: 'MEMORY' }]),
      sessionWith('s2'),
      store,
    );
    expect(wired).toBeDefined();
    expect(wired?.promptSection).toContain('deploys run at 02:00 UTC');
  });

  it('drops only the unaddressable blocks from a mixed surface', async () => {
    resetMissingUserIdWarningsForTests();
    const store = new InMemoryPersistentMemoryStore();
    await store.saveBlock(
      { key: 'MEMORY', scope: 'agent', content: 'agent note', charLimit: 10_000 },
      'agent-a',
    );
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'LEAKED USER CONTENT', charLimit: 10_000 },
      'anonymous',
    );

    const wired = await wireWorkingMemory(
      agentWith([...DEFAULT_AUTO_LOAD_BLOCKS] as never),
      sessionWith('s3'),
      store,
    );
    expect(wired).toBeDefined();
    expect(wired?.promptSection).toContain('agent note');
    expect(wired?.promptSection).not.toContain('LEAKED USER CONTENT');
    // The USER heading is gone too — the block is not part of this surface.
    expect(wired?.promptSection).not.toContain('USER (user)');
  });

  it('still serves a user-scoped block when the session has a userId', async () => {
    resetMissingUserIdWarningsForTests();
    const store = new InMemoryPersistentMemoryStore();
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'prefers morning appointments', charLimit: 10_000 },
      'alice',
    );

    const wired = await wireWorkingMemory(
      agentWith([{ scope: 'user', key: 'USER' }]),
      sessionWith('s4', 'alice'),
      store,
    );
    expect(wired?.promptSection).toContain('prefers morning appointments');
  });
});
