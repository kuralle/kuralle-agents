import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.ts';
import { defineExtractor } from '../../src/memory/extract/defineExtractor.ts';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.ts';
import { wireSearchMemory } from '../../src/runtime/grounding/searchMemory.ts';

function makeSession(userId: string | undefined) {
  return {
    id: 's1',
    conversationId: 's1',
    channelId: 'api' as const,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

const dietaryProfile = defineExtractor({
  name: 'Dietary Profile',
  scope: 'user',
  instructions: 'Allergies and dietary restrictions.',
  schema: z.object({ allergies: z.array(z.string()) }),
});

describe('wireSearchMemory', () => {
  it('withholds the tool entirely when the agent declares no extractors', async () => {
    const agent = defineAgent({ id: 'no-extractors' });
    const tool = await wireSearchMemory(agent, makeSession('user-1'), new InMemoryExtractedValueStore());
    expect(tool).toBeUndefined();
  });

  it('withholds the tool when a user-scoped extractor has no userId to resolve against', async () => {
    const agent = defineAgent({
      id: 'concierge',
      memory: { extract: [dietaryProfile] },
    });
    const tool = await wireSearchMemory(agent, makeSession(undefined), new InMemoryExtractedValueStore());
    expect(tool).toBeUndefined();
  });

  it('wires a usable tool when at least one declared extractor is addressable', async () => {
    const agent = defineAgent({
      id: 'concierge',
      memory: { extract: [dietaryProfile] },
    });
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: dietaryProfile.slug,
        scope: 'user',
        value: { allergies: ['shellfish'] },
        updatedAt: new Date().toISOString(),
      },
      'user-1',
    );

    const tool = await wireSearchMemory(agent, makeSession('user-1'), store);
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ query: 'shellfish' })) as {
      results: Array<{ entry: string }>;
    };
    expect(result.results.some((r) => r.entry.includes('shellfish'))).toBe(true);
  });

  it('an agent-scoped extractor is addressable even without a userId (agentId is always present)', async () => {
    const agentScoped = defineExtractor({
      name: 'Agent Notes',
      scope: 'agent',
      instructions: 'Notes the agent keeps about itself.',
      schema: z.object({ notes: z.array(z.string()) }),
    });
    const agent = defineAgent({
      id: 'notetaker',
      memory: { extract: [agentScoped] },
    });
    const store = new InMemoryExtractedValueStore();
    await store.save(
      { slug: agentScoped.slug, scope: 'agent', value: { notes: ['prefers concise replies'] }, updatedAt: new Date().toISOString() },
      'notetaker',
    );

    const tool = await wireSearchMemory(agent, makeSession(undefined), store);
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ query: 'concise' })) as {
      results: Array<{ entry: string }>;
    };
    expect(result.results.length).toBeGreaterThan(0);
  });
});

/**
 * The two branches a cross-family review found shipping unverified. Neither had
 * a defect — both were simply untested, and "correct on reading" is what the
 * repo's own workmanship notes call the state right before a guard turns out to
 * be incapable of failing.
 */
describe('search_memory withholds on a partial resolve failure', () => {
  const throwing = defineExtractor({
    name: 'Throwing',
    scope: 'user',
    // `instructions` accepts a function form, so resolution can throw at runtime.
    instructions: () => {
      throw new Error('boom');
    },
    schema: z.object({ v: z.string() }),
  });
  const healthy = defineExtractor({
    name: 'Healthy',
    scope: 'user',
    instructions: 'Something extractable.',
    schema: z.object({ v: z.string() }),
  });

  it('drops the failing extractor and still wires the rest', async () => {
    const tool = await wireSearchMemory(
      defineAgent({
        id: 'agent-1',
        instructions: 'x',
        memory: { extract: [throwing, healthy] },
      } as never),
      makeSession('alice') as never,
      new InMemoryExtractedValueStore(),
    );
    expect(tool).toBeDefined();
    // The surviving extractor is addressable; the throwing one is not expressible.
    // wrapAiSdkTool maps the AI SDK's `inputSchema` onto `input` — reach for that,
    // not the wrapped tool's own field.
    const slugs = (tool as never as { input: z.ZodTypeAny }).input;
    expect(slugs.safeParse({ query: 'q', slug: healthy.slug }).success).toBe(true);
    expect(slugs.safeParse({ query: 'q', slug: throwing.slug }).success).toBe(false);
  });

  it('withholds the tool entirely when every extractor fails to resolve', async () => {
    const tool = await wireSearchMemory(
      defineAgent({
        id: 'agent-1',
        instructions: 'x',
        memory: { extract: [throwing] },
      } as never),
      makeSession('alice') as never,
      new InMemoryExtractedValueStore(),
    );
    // Absent, not present-and-empty — a search tool that always returns nothing
    // is worse than one that was never offered.
    expect(tool).toBeUndefined();
  });
});
