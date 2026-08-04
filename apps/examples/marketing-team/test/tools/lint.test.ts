import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createLintTools } from '../../agent/lib/lint/tools.js';
import { fakeSkill, makeCtx } from './helpers.js';

const BANNED = ['delve', 'leverage', 'game-changing'];

describe('lint_against_style', () => {
  const { lint_against_style } = createLintTools({ surfaces: ['blog', 'linkedin'] });

  it('returns the banned words found in a fixture', async () => {
    const ctx = makeCtx({
      getSkill: fakeSkill({ 'references/banned-words.json': JSON.stringify(BANNED) }),
    });
    const result = (await lint_against_style.execute(
      { surface: 'blog', text: 'We will leverage this game-changing approach.' },
      ctx,
    )) as { violations: string[] };
    expect(result.violations.sort()).toEqual(['game-changing', 'leverage']);
  });

  it('returns [] for clean input', async () => {
    const ctx = makeCtx({
      getSkill: fakeSkill({ 'references/banned-words.json': JSON.stringify(BANNED) }),
    });
    const result = (await lint_against_style.execute(
      { surface: 'blog', text: 'We shipped the feature and users like it.' },
      ctx,
    )) as { violations: string[] };
    expect(result.violations).toEqual([]);
  });

  it('errors when the banned-words list is missing (fails closed, not open)', async () => {
    const ctx = makeCtx({ getSkill: fakeSkill({}) }); // no references/banned-words.json
    await expect(lint_against_style.execute({ surface: 'blog', text: 'anything' }, ctx)).rejects.toThrow(
      /banned-words\.json/,
    );
  });

  it('errors when the banned-words list is malformed JSON', async () => {
    const ctx = makeCtx({
      getSkill: fakeSkill({ 'references/banned-words.json': '{not valid json' }),
    });
    await expect(lint_against_style.execute({ surface: 'blog', text: 'anything' }, ctx)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('errors when the banned-words list is valid JSON but not an array of strings', async () => {
    const ctx = makeCtx({
      getSkill: fakeSkill({ 'references/banned-words.json': JSON.stringify({ oops: true }) }),
    });
    await expect(lint_against_style.execute({ surface: 'blog', text: 'anything' }, ctx)).rejects.toThrow(
      /array of strings/,
    );
  });

  it('accepts only a surface from the closed set the factory was constructed with', () => {
    // There is no code path in `lint_against_style` that accepts a caller-supplied skill id
    // or file path — the model can only ever select `surface` from this zod enum, and the
    // skill id (`${surface}-style`) is derived from it, never concatenated from raw input.
    const schema = lint_against_style.input;
    if (!(schema instanceof z.ZodObject)) throw new Error('expected a z.object() input schema');
    expect(schema.safeParse({ surface: 'blog', text: 'x' }).success).toBe(true);
    expect(schema.safeParse({ surface: 'newsletter', text: 'x' }).success).toBe(false);
    expect(schema.safeParse({ surface: '../../etc/passwd', text: 'x' }).success).toBe(false);
  });
});
