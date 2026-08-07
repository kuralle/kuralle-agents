import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineExtractor, resolveExtractor } from '../../../src/memory/extract/defineExtractor.ts';
import { buildSearchMemoryTool } from '../../../src/memory/extract/searchMemoryTool.ts';
import { InMemoryExtractedValueStore } from '../../../src/memory/extract/InMemoryExtractedValueStore.ts';
import type { ExtractedValueStore } from '../../../src/memory/extract/store.ts';
import type { ResolvedExtractor } from '../../../src/memory/extract/types.ts';

const ctx = { agentId: 'agent-1', sessionId: 'session-1', userId: 'user-1' };

async function factsExtractorFixture(): Promise<ResolvedExtractor<never>> {
  const resolved = await resolveExtractor(
    defineExtractor({
      name: 'Facts',
      scope: 'user',
      instructions: 'Durable facts about the user.',
      schema: z.object({ facts: z.array(z.string()) }),
    }),
    ctx,
  );
  return resolved as unknown as ResolvedExtractor<never>;
}

async function dietaryProfileFixture(): Promise<ResolvedExtractor<never>> {
  const resolved = await resolveExtractor(
    defineExtractor({
      name: 'Dietary Profile',
      scope: 'user',
      instructions: 'Allergies and dietary restrictions this person stated about themselves.',
      schema: z.object({ allergies: z.array(z.string()), avoids: z.array(z.string()) }),
    }),
    ctx,
  );
  return resolved as unknown as ResolvedExtractor<never>;
}

// The AI SDK `tool({...})` shape exposes `execute` and `inputSchema` directly.
type CallableTool = {
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  execute: (input: unknown, options: { messages: unknown[]; toolCallId: string }) => Promise<unknown>;
};

async function call(t: CallableTool, input: unknown) {
  return t.execute(input, { messages: [], toolCallId: 'tc-1' });
}

describe('buildSearchMemoryTool', () => {
  it('cannot express a slug the agent did not declare', async () => {
    const facts = await factsExtractorFixture();
    const t = buildSearchMemoryTool({
      store: new InMemoryExtractedValueStore(),
      extractors: [facts],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    // Not "is rejected at runtime" — cannot be constructed. The enum is the boundary.
    expect(t.inputSchema.safeParse({ query: 'anything', slug: 'not-declared' }).success).toBe(false);
    expect(t.inputSchema.safeParse({ query: 'anything', slug: 'facts' }).success).toBe(true);
    expect(t.inputSchema.safeParse({ query: 'anything' }).success).toBe(true);
  });

  it('throws when built with no declared extractors — z.enum([]) is not constructible', () => {
    expect(() =>
      buildSearchMemoryTool({
        store: new InMemoryExtractedValueStore(),
        extractors: [],
        resolveOwner: () => 'owner-1',
      }),
    ).toThrow(/at least one declared extractor/);
  });

  it('finds a declared slug\'s entries by query', async () => {
    const facts = await factsExtractorFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['User lives in Colombo', 'User likes tea'] }, updatedAt: new Date().toISOString() },
      'owner-1',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [facts],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const r = (await call(t, { query: 'Colombo' })) as { results: Array<{ slug: string; entry: string }> };
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.slug).toBe(facts.slug);
    expect(r.results[0]?.entry).toContain('Colombo');
  });

  it('a query matching nothing returns an empty list, never the whole corpus', async () => {
    const facts = await factsExtractorFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['User lives in Colombo'] }, updatedAt: new Date().toISOString() },
      'owner-1',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [facts],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    // Deliberate divergence from preloadMemoryContext, which falls back to
    // returning everything when nothing scores.
    const r = (await call(t, { query: 'spaceship' })) as { results: unknown[] };
    expect(r.results).toEqual([]);
  });

  it('two owners with the same slug never see each other\'s entries', async () => {
    const facts = await factsExtractorFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['Alice likes pizza'] }, updatedAt: new Date().toISOString() },
      'alice',
    );
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['Bob likes pasta'] }, updatedAt: new Date().toISOString() },
      'bob',
    );

    const toolFor = (owner: string) =>
      buildSearchMemoryTool({ store, extractors: [facts], resolveOwner: () => owner }) as unknown as CallableTool;

    const aliceResult = (await call(toolFor('alice'), { query: 'likes' })) as {
      results: Array<{ entry: string }>;
    };
    expect(aliceResult.results.some((r) => r.entry.includes('pizza'))).toBe(true);
    expect(aliceResult.results.some((r) => r.entry.includes('pasta'))).toBe(false);

    const bobResult = (await call(toolFor('bob'), { query: 'likes' })) as {
      results: Array<{ entry: string }>;
    };
    expect(bobResult.results.some((r) => r.entry.includes('pasta'))).toBe(true);
    expect(bobResult.results.some((r) => r.entry.includes('pizza'))).toBe(false);
  });

  it('never falls back to a placeholder owner when resolveOwner returns undefined', async () => {
    const facts = await factsExtractorFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['Secret fact'] }, updatedAt: new Date().toISOString() },
      'someone',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [facts],
      resolveOwner: () => undefined,
    }) as unknown as CallableTool;

    const r = (await call(t, { query: 'secret' })) as { results: unknown[] };
    expect(r.results).toEqual([]);
  });

  it('flattens an object-shaped value (e.g. a schema with named fields) into scorable entries', async () => {
    const dietaryProfile = await dietaryProfileFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: dietaryProfile.slug,
        scope: 'user',
        value: { allergies: ['shellfish'], avoids: [] },
        updatedAt: new Date().toISOString(),
      },
      'owner-1',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [dietaryProfile],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const r = (await call(t, { query: 'shellfish' })) as { results: Array<{ entry: string }> };
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some((res) => res.entry.includes('shellfish'))).toBe(true);
  });

  it('omitting slug searches every declared extractor', async () => {
    const facts = await factsExtractorFixture();
    const dietaryProfile = await dietaryProfileFixture();
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: ['User travels often'] }, updatedAt: new Date().toISOString() },
      'owner-1',
    );
    await store.save(
      {
        slug: dietaryProfile.slug,
        scope: 'user',
        value: { allergies: ['peanuts'], avoids: [] },
        updatedAt: new Date().toISOString(),
      },
      'owner-1',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [facts, dietaryProfile],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const r = (await call(t, { query: 'peanuts' })) as { results: Array<{ slug: string }> };
    expect(r.results.some((res) => res.slug === dietaryProfile.slug)).toBe(true);
  });

  it('respects the limit option', async () => {
    const facts = await factsExtractorFixture();
    const store = new InMemoryExtractedValueStore();
    const many = Array.from({ length: 20 }, (_, i) => `fact number ${i} about testing`);
    await store.save(
      { slug: facts.slug, scope: 'user', value: { facts: many }, updatedAt: new Date().toISOString() },
      'owner-1',
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [facts],
      resolveOwner: () => 'owner-1',
      limit: 3,
    }) as unknown as CallableTool;

    const r = (await call(t, { query: 'testing' })) as { results: unknown[] };
    expect(r.results).toHaveLength(3);
  });
});

describe('buildSearchMemoryTool — shared-scorer guarantee', () => {
  it('ranks the same corpus in the same order as preloadMemoryContext', async () => {
    const { preloadMemoryContext } = await import('../../../src/memory/preloadMemory.ts');
    const { FACTS_EXTRACTOR_SLUG } = await import('../../../src/memory/extract/builtin/factsExtractor.ts');

    const facts = ['User lives in Colombo', 'User likes blue', 'User travels for work often'];
    const store: ExtractedValueStore = new InMemoryExtractedValueStore();
    await store.save(
      { slug: FACTS_EXTRACTOR_SLUG, scope: 'user', value: { facts }, updatedAt: new Date().toISOString() },
      'owner-1',
    );

    const session = {
      id: 's1',
      conversationId: 's1',
      channelId: 'api' as const,
      userId: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      workingMemory: {},
      currentAgent: 'agent-1',
      activeAgentId: 'agent-1',
      agentStates: {},
      handoffHistory: [],
    };
    const preloaded = await preloadMemoryContext(store, session as never, 'Colombo travels', 5000);
    // At least one fact scored > 0, so preload shows only the relevant facts —
    // the unrelated 'blue' fact is excluded, not merely ranked last.
    expect(preloaded).toContain('Colombo');
    expect(preloaded).not.toContain('blue');

    const factsExtractor = await resolveExtractor(
      defineExtractor({
        name: 'Facts',
        scope: 'user',
        instructions: 'x',
        schema: z.object({ facts: z.array(z.string()) }),
      }),
      ctx,
    );
    const t = buildSearchMemoryTool({
      store,
      extractors: [factsExtractor as unknown as ResolvedExtractor<never>],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;
    const r = (await call(t, { query: 'Colombo travels' })) as {
      results: Array<{ entry: string; score: number }>;
    };
    // Same corpus, same query — the shared scorer must produce the same relative
    // order: the Colombo/travels fact outranks the unrelated 'blue' one.
    expect(r.results[0]?.entry).toContain('Colombo');
    expect(r.results.some((res) => res.entry.includes('blue'))).toBe(false);
  });
});

/**
 * A cross-family review found `flattenExtractedValue` had a blind spot: an
 * extractor whose schema is a bare scalar (`z.string()` is legal) flattened to
 * nothing, so its value was stored and permanently unsearchable — the exact
 * write-only defect this whole tool exists to close, reintroduced for one shape.
 */
describe('flattening covers every shape an extractor schema can produce', () => {
  async function scalarExtractor(schema: z.ZodTypeAny, name: string) {
    const ctx = { agentId: 'agent-1', sessionId: 's1', userId: 'owner-1' };
    return (await resolveExtractor(
      defineExtractor({ name, scope: 'user', instructions: 'x', schema } as never),
      ctx as never,
    )) as unknown as ResolvedExtractor<never>;
  }

  it('finds a value stored under a bare-scalar schema', async () => {
    const store = new InMemoryExtractedValueStore();
    const ex = await scalarExtractor(z.string(), 'Nickname');
    await store.save(
      { slug: ex.slug, scope: 'user', value: 'they go by Sunny', updatedAt: new Date().toISOString() },
      'owner-1',
    );

    const t = buildSearchMemoryTool({
      store,
      extractors: [ex],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const out = (await call(t, { query: 'sunny' })) as { results: Array<{ entry: string }> };
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.entry).toBe('they go by Sunny');
  });

  it('finds a value stored under a bare number schema', async () => {
    const store = new InMemoryExtractedValueStore();
    const ex = await scalarExtractor(z.number(), 'Loyalty Tier');
    await store.save(
      { slug: ex.slug, scope: 'user', value: 4207, updatedAt: new Date().toISOString() },
      'owner-1',
    );

    const t = buildSearchMemoryTool({
      store,
      extractors: [ex],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const out = (await call(t, { query: '4207' })) as { results: Array<{ entry: string }> };
    expect(out.results).toHaveLength(1);
  });

  it('returns nothing rather than throwing on null', async () => {
    const store = new InMemoryExtractedValueStore();
    const ex = await scalarExtractor(z.object({ v: z.string() }).nullable(), 'Nullable');
    await store.save(
      { slug: ex.slug, scope: 'user', value: null, updatedAt: new Date().toISOString() },
      'owner-1',
    );

    const t = buildSearchMemoryTool({
      store,
      extractors: [ex],
      resolveOwner: () => 'owner-1',
    }) as unknown as CallableTool;

    const out = (await call(t, { query: 'anything' })) as { results: unknown[] };
    expect(out.results).toEqual([]);
  });
});
