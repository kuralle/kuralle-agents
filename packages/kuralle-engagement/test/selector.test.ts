import { describe, it, expect } from 'bun:test';
import type { LanguageModel } from 'ai';

import { aiTemplateSelector } from '../src/selector.js';
import type { TemplateDescriptor } from '../src/strategist.js';

const stubModel = {} as LanguageModel;

describe('aiTemplateSelector', () => {
  it('exposes select with the TemplateSelector shape', () => {
    const selector = aiTemplateSelector(stubModel);
    expect(typeof selector.select).toBe('function');
  });

  it('returns null when there are no candidates without calling the model', async () => {
    const selector = aiTemplateSelector(stubModel);
    const result = await selector.select({
      text: 'hello',
      candidates: [] as TemplateDescriptor[],
    });
    expect(result).toBeNull();
  });
});
