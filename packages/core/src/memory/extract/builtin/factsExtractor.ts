import { z } from 'zod';
import { DEFAULT_BLOCK_CHAR_LIMIT } from '../../blocks/types.js';
import { scanMemoryWrite } from '../../blocks/safetyScanner.js';
import { defineExtractor } from '../defineExtractor.js';
import type { AnyExtractor } from '../types.js';

export const FACTS_EXTRACTOR_SLUG = 'facts';

const factsSchema = z.object({
  facts: z.array(z.string()),
});

export type FactsValue = z.infer<typeof factsSchema>;

export interface FactsExtractorOptions {
  maxFacts?: number;
  charLimit?: number;
}

function mergeInstructions(maxFacts: number): string {
  return [
    'You maintain the long-term memory of a customer-facing assistant.',
    'From the EXISTING FACTS and the NEW CONVERSATION, produce the complete updated fact list about this user.',
    'Keep facts that are still true, update ones that changed, drop obsolete or duplicate ones.',
    'Only durable facts worth remembering across conversations: stable preferences, profile details',
    '(name, address, sizes), recurring context (orders they reference, their business).',
    'Exclude one-off details, small talk, and sensitive payment data (card numbers, passwords).',
    `At most ${maxFacts} facts, each a single self-contained sentence under 200 characters.`,
  ].join('\n');
}

/** Built-in cross-session fact memory — LLM merge via `includePrevious`, shaped in `onExtracted`. */
export function factsExtractor(options: FactsExtractorOptions = {}): AnyExtractor {
  const maxFacts = options.maxFacts ?? 25;
  const charLimit = options.charLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;

  return defineExtractor({
    name: 'Facts',
    scope: 'user',
    includePrevious: true,
    schema: factsSchema,
    instructions: mergeInstructions(maxFacts),
    onExtracted: ({ current }) => {
      let facts = current.facts
        .map((fact) => fact.trim())
        .filter((fact) => fact.length > 0 && scanMemoryWrite(fact).safe)
        .slice(0, maxFacts);

      let serialized = JSON.stringify({ facts });
      while (serialized.length > charLimit && facts.length > 0) {
        facts.pop();
        serialized = JSON.stringify({ facts });
      }

      return { facts };
    },
  });
}
