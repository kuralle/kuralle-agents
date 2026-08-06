import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  defineExtractor,
  slugifyExtractorName,
  validateExtractorList,
  resolveExtractor,
  MAX_SLUG_LENGTH,
} from '../../src/memory/extract/defineExtractor.js';
import { defineAgent } from '../../src/authoring/index.js';
import { createRuntime } from '../../src/runtime/Runtime.js';

describe('slugifyExtractorName', () => {
  it('lowercases and hyphenates a plain name', () => {
    expect(slugifyExtractorName('Support Profile')).toBe('support-profile');
  });

  it('collapses punctuation, quotes, and repeated separators', () => {
    expect(slugifyExtractorName("Bob's   Favorite!!  Color")).toBe('bob-s-favorite-color');
  });

  it('throws with the source name when the slug is empty', () => {
    expect(() => slugifyExtractorName('!!!')).toThrow(/!!!/);
  });

  it('throws with the source name when the slug does not start with a letter', () => {
    expect(() => slugifyExtractorName('123 Profile')).toThrow(/123 Profile/);
  });

  it('NFKD-normalises accented names instead of dropping the accent', () => {
    expect(slugifyExtractorName('Café Profile')).toBe('cafe-profile');
    expect(slugifyExtractorName('Cafe Profile')).toBe('cafe-profile');
  });

  it('NFKD-normalises diaeresis so distinct-looking words fold correctly', () => {
    expect(slugifyExtractorName('naïve prefs')).toBe('naive-prefs');
  });

  it('normalises fullwidth digits before the leading-digit guard runs', () => {
    expect(() => slugifyExtractorName('２ Profile')).toThrow(/２ Profile/);
  });

  it('throws with the source name when the slug exceeds the max length', () => {
    const longName = 'a'.repeat(MAX_SLUG_LENGTH + 1);
    expect(() => slugifyExtractorName(longName)).toThrow(new RegExp(longName));
  });
});

describe('validateExtractorList', () => {
  it('throws naming both extractors when two slugify to the same value', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'support   profile', instructions: 'b', schema: z.object({}) });
    expect(() => validateExtractorList([a, b])).toThrow(/Support Profile.*support   profile|support   profile.*Support Profile/);
  });

  it('throws loudly when non-ASCII normalisation makes two distinct names collide', () => {
    const a = defineExtractor({ name: 'Café Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'Cafe Profile', instructions: 'b', schema: z.object({}) });
    expect(() => validateExtractorList([a, b])).toThrow(/Café Profile.*Cafe Profile|Cafe Profile.*Café Profile/);
  });

  it('passes through a list of distinct, non-reserved extractors', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'Order History', instructions: 'b', schema: z.object({}) });
    expect(validateExtractorList([a, b])).toEqual([a, b]);
  });
});

describe('defineExtractor', () => {
  it('throws immediately when the name resolves to a reserved slug', () => {
    expect(() => defineExtractor({ name: 'Facts', instructions: 'a', schema: z.object({}) })).toThrow(/reserved/);
  });
});

describe('resolveExtractor', () => {
  it('resolves function-form instructions and schema against a runtime context', async () => {
    const extractor = defineExtractor({
      name: 'Tenant Profile',
      instructions: (ctx) => `Extract for tenant ${ctx.agentId}`,
      schema: (ctx) => z.object({ tenant: z.literal(ctx.agentId) }),
    });
    const ctx = { agentId: 'agent-1', sessionId: 'sess-1' };
    const resolved = await resolveExtractor(extractor, ctx);
    expect(resolved.instructions).toBe('Extract for tenant agent-1');
    expect(resolved.schema.parse({ tenant: 'agent-1' })).toEqual({ tenant: 'agent-1' });
  });

  it('passes through static instructions and schema unchanged', async () => {
    const schema = z.object({ x: z.string() });
    const extractor = defineExtractor({ name: 'Static', instructions: 'static instructions', schema });
    const resolved = await resolveExtractor(extractor, { agentId: 'a', sessionId: 's' });
    expect(resolved.instructions).toBe('static instructions');
    expect(resolved.schema).toBe(schema);
  });

  it('throws naming the extractor when a function-form instructions resolves to undefined', async () => {
    const extractor = defineExtractor({
      name: 'Broken Instructions',
      // @ts-expect-error deliberately returning a value that violates the declared type
      instructions: () => undefined,
      schema: z.object({}),
    });
    await expect(resolveExtractor(extractor, { agentId: 'a', sessionId: 's' })).rejects.toThrow(
      /Broken Instructions/,
    );
  });

  it('throws naming the extractor when a function-form schema resolves to a non-Zod value', async () => {
    const extractor = defineExtractor({
      name: 'Broken Schema',
      instructions: 'ok',
      // @ts-expect-error deliberately returning a value that violates the declared type
      schema: () => ({ notAZodSchema: true }),
    });
    await expect(resolveExtractor(extractor, { agentId: 'a', sessionId: 's' })).rejects.toThrow(/Broken Schema/);
  });

  it('surfaces a throwing resolver with the extractor name in the message', async () => {
    const extractor = defineExtractor({
      name: 'Throwing Resolver',
      instructions: () => {
        throw new Error('boom');
      },
      schema: z.object({}),
    });
    await expect(resolveExtractor(extractor, { agentId: 'a', sessionId: 's' })).rejects.toThrow(
      /Throwing Resolver/,
    );
  });
});

describe('defineAgent + memory.extract', () => {
  it('throws at construction on a duplicate-slug memory.extract config', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'support   profile', instructions: 'b', schema: z.object({}) });
    expect(() =>
      defineAgent({
        id: 'dup-extract-agent',
        memory: { extract: [a, b] },
      }),
    ).toThrow();
  });

  it('accepts a valid memory.extract config', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const config = defineAgent({ id: 'ok-extract-agent', memory: { extract: [a] } });
    expect(config.memory?.extract).toEqual([a]);
  });
});

describe('createRuntime + memory.extract', () => {
  it('throws at runtime construction when a raw AgentConfig literal carries duplicate extractor slugs', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'support   profile', instructions: 'b', schema: z.object({}) });
    expect(() =>
      createRuntime({
        agents: [{ id: 'raw-agent', memory: { extract: [a, b] } }],
        defaultAgentId: 'raw-agent',
      }),
    ).toThrow();
  });
});

describe('Extractor<T> generic threading', () => {
  it('infers T from a concrete zod schema so onExtracted.current is typed', () => {
    const extractor = defineExtractor({
      name: 'Typed Profile',
      instructions: 'extract it',
      schema: z.object({ os: z.string() }),
      onExtracted: ({ current }) => {
        // If T were not inferred, `current` would be `unknown` and this line would not typecheck.
        const os: string = current.os;
        void os;
      },
    });
    expect(extractor.slug).toBe('typed-profile');
  });
});
