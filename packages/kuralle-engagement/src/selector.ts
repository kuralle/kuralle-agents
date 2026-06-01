import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';

import type { TemplateSelector } from './strategist.js';

const selectionSchema = z.object({
  fit: z.boolean(),
  name: z.string().nullable(),
  language: z.string().nullable(),
  params: z.record(z.string(), z.string()).nullable(),
});

export function aiTemplateSelector(model: LanguageModel): TemplateSelector {
  return {
    async select({ text, intent, candidates, flowState }) {
      if (candidates.length === 0) return null;

      const candidateLines = candidates
        .map(
          (c) =>
            `- ${c.name} (${c.language}, ${c.category}): params=[${c.params
              .map((p) => `${p.key}${p.required ? '*' : ''}`)
              .join(', ')}]`,
        )
        .join('\n');

      const flowHint =
        flowState && Object.keys(flowState).length > 0
          ? `Flow state:\n${JSON.stringify(flowState)}\n\n`
          : '';

      const { object } = await generateObject({
        model,
        schema: selectionSchema,
        system:
          'You choose the best WhatsApp message template for a user message. ' +
          'Only pick from the listed candidates. Output schema fields only.',
        prompt:
          `User message:\n${text}\n` +
          (intent ? `Intent: ${intent}\n` : '') +
          flowHint +
          `Candidates:\n${candidateLines}\n\n` +
          'Return fit:true with name, language, and params when a candidate matches; otherwise fit:false.',
      });

      if (!object.fit || object.name == null) return null;

      const matched = candidates.find((c) => c.name === object.name);
      if (!matched) return null;

      return {
        name: object.name,
        language: object.language ?? matched.language,
        params: object.params ?? {},
      };
    },
  };
}
