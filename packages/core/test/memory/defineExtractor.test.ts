import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  defineExtractor,
  slugifyExtractorName,
  validateExtractorList,
  resolveExtractor,
} from '../../src/memory/extract/defineExtractor.js';
import { defineAgent } from '../../src/authoring/index.js';

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
});

describe('validateExtractorList', () => {
  it('throws naming both extractors when two slugify to the same value', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'support   profile', instructions: 'b', schema: z.object({}) });
    expect(() => validateExtractorList([a, b])).toThrow(/Support Profile.*support   profile|support   profile.*Support Profile/);
  });

  it('throws when a slug collides with a reserved key', () => {
    const reserved = defineExtractor({ name: 'Facts', instructions: 'a', schema: z.object({}) });
    expect(() => validateExtractorList([reserved])).toThrow(/reserved/);
  });

  it('passes through a list of distinct, non-reserved extractors', () => {
    const a = defineExtractor({ name: 'Support Profile', instructions: 'a', schema: z.object({}) });
    const b = defineExtractor({ name: 'Order History', instructions: 'b', schema: z.object({}) });
    expect(validateExtractorList([a, b])).toEqual([a, b]);
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
