import { describe, expect, it, beforeEach } from 'bun:test';
import {
  wireWorkingMemory,
  resolveWorkingMemoryStore,
  resetWorkingMemoryWarningsForTests,
} from '../../src/runtime/grounding/workingMemory.js';
import { resetMissingUserIdWarningsForTests } from '../../src/runtime/grounding/memory.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { InvalidOwnerError } from '../../src/memory/blocks/ownerKey.js';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import type { Session } from '../../src/types/session.js';

/**
 * Layer 1 of the owner-key fix, at the boundary rather than in the library.
 *
 * The backends are collision-safe on their own now (a nested Map for InMemory,
 * percent-encoded segments for File and Redis), so an owner containing `/` or
 * `:` no longer lands on someone else's row whatever happens here. What these
 * tests protect is the *other* half of the decision: that a malformed owner
 * fails loudly rather than quietly acquiring a tidy, valid row of its own.
 *
 * `withOwnerValidation` existed and was exercised only by the conformance
 * suite — proven, but wired into nothing. A guard nothing calls is decoration.
 */
function agentWith(
  store: InMemoryPersistentMemoryStore,
  autoLoad?: Array<{ scope: 'user' | 'agent' | 'shared'; key: string }>,
): AgentConfig {
  return {
    id: 'agent-a',
    instructions: 'Help.',
    memory: { workingMemory: { store, ...(autoLoad ? { autoLoad } : {}) } },
  } as unknown as AgentConfig;
}

function sessionWith(id: string, userId?: string): Session {
  return { id, messages: [], ...(userId ? { userId } : {}) } as unknown as Session;
}

describe('working memory withholds itself from an owner it cannot store safely', () => {
  beforeEach(() => {
    resetMissingUserIdWarningsForTests();
    resetWorkingMemoryWarningsForTests();
  });

  it('withholds the user-scoped surface when the userId is outside the allow-list', async () => {
    const store = new InMemoryPersistentMemoryStore();
    const wired = await wireWorkingMemory(
      agentWith(store, [{ scope: 'user', key: 'USER' }]),
      sessionWith('s1', 'alice/bob'),
    );
    // Nothing addressable → no prompt section and no tool, exactly as for a
    // session with no userId at all.
    expect(wired).toBeUndefined();
  });

  it('still wires the surface for an id using the separators real systems use', async () => {
    const store = new InMemoryPersistentMemoryStore();
    for (const userId of ['google-oauth2|123', 'tenant:user', 'a.b@example.com', 'u~1', 'u+1']) {
      resetWorkingMemoryWarningsForTests();
      const wired = await wireWorkingMemory(
        agentWith(store, [{ scope: 'user', key: 'USER' }]),
        sessionWith(`s-${userId}`, userId),
      );
      expect(wired).toBeDefined();
    }
  });

  it('keeps the agent-scoped surface when only the user-scoped owner is unusable', async () => {
    const store = new InMemoryPersistentMemoryStore();
    const wired = await wireWorkingMemory(
      agentWith(store, [
        { scope: 'user', key: 'USER' },
        { scope: 'agent', key: 'MEMORY' },
      ]),
      sessionWith('s2', 'alice/bob'),
    );
    // The agent owner is the agentId, which is valid — that block survives.
    expect(wired).toBeDefined();
    expect(wired!.promptSection).toContain('MEMORY');
    expect(wired!.promptSection).not.toContain('### USER');
  });

  it('withholds a declared block whose key is outside the allow-list', async () => {
    const store = new InMemoryPersistentMemoryStore();
    const wired = await wireWorkingMemory(
      agentWith(store, [
        { scope: 'agent', key: 'bad key/with slash' },
        { scope: 'agent', key: 'MEMORY' },
      ]),
      sessionWith('s3', 'alice'),
    );
    expect(wired).toBeDefined();
    expect(wired!.promptSection).toContain('MEMORY');
    expect(wired!.promptSection).not.toContain('bad key');
  });

  it('resolveWorkingMemoryStore hands out a validating store, never the raw one', async () => {
    // The reachable path for this guard is the exported resolver, not the raw
    // backend: a consumer calling it directly must also get the rejection.
    // Asserting on `withOwnerValidation` in isolation would prove the wrapper
    // works while saying nothing about whether anything applies it — which is
    // exactly the state this test was written to end.
    const raw = new InMemoryPersistentMemoryStore();
    const resolved = resolveWorkingMemoryStore({ store: raw } as never);

    await expect(
      resolved.saveBlock({ key: 'USER', scope: 'user', content: 'x', charLimit: 100 }, 'alice/bob'),
    ).rejects.toBeInstanceOf(InvalidOwnerError);
    await expect(resolved.loadBlock('user', 'alice/bob', 'USER')).rejects.toBeInstanceOf(
      InvalidOwnerError,
    );
    await expect(resolved.listBlocks('user', 'alice/bob')).rejects.toBeInstanceOf(
      InvalidOwnerError,
    );

    // The raw store never saw the write.
    expect(await raw.listBlocks('user', 'alice/bob')).toEqual([]);
    // A legal owner still passes straight through.
    await resolved.saveBlock({ key: 'USER', scope: 'user', content: 'ok', charLimit: 100 }, 'alice');
    expect((await raw.loadBlock('user', 'alice', 'USER'))?.content).toBe('ok');
  });
});
