import { describe, expect, it } from 'bun:test';
import { PromptTemplateBuilder } from '../../src/prompts/types.js';

/**
 * A date in the system prompt is the canonical prompt-cache anti-pattern: it changes the
 * prefix at every date boundary, and because it renders at build() time, two servers booted
 * on different days serve permanently different prefixes and can never share cache — an
 * invisible fleet-wide split.
 *
 * It defaulted to ON at priority 25, and sections sort ascending, so it landed near the
 * FRONT of the prompt and invalidated everything after it.
 */
const text = (b: PromptTemplateBuilder) => JSON.stringify(b.build());

describe('injectTodayDate', () => {
  it('is OFF by default', () => {
    expect(text(new PromptTemplateBuilder({ id: 'p1', name: 'probe' }))).not.toContain('Today is');
  });

  it('can still be opted into', () => {
    expect(text(new PromptTemplateBuilder({ id: 'p1', name: 'probe' }).injectTodayDate(true))).toContain(
      'Today is',
    );
  });
});
