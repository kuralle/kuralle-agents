import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { InputProcessor, OutputProcessor } from '../../types/processors.js';

export interface ModerationGuardOptions {
  /** Classifier model. Use a small/fast model — this runs on every turn it guards. */
  model: LanguageModel;
  /** Policy categories to flag. Defaults cover the standard abuse set. */
  categories?: string[];
  /** User-facing message when content is flagged. */
  message?: string;
  /**
   * What to do when the classifier itself errors. `allow` (default) fails open —
   * deterministic guards still run and an outage does not take the agent down.
   * `block` fails closed for zero-tolerance deployments.
   */
  onError?: 'allow' | 'block';
  id?: string;
}

const DEFAULT_CATEGORIES = [
  'violence or threats of violence',
  'sexual content involving minors',
  'self-harm encouragement or instructions',
  'hate or harassment targeting a protected group',
  'facilitation of clearly illegal activity (weapons, drugs, fraud)',
];

const moderationSchema = z.object({
  flagged: z.boolean(),
  category: z.union([z.string(), z.null()]),
  rationale: z.union([z.string(), z.null()]),
});

async function classify(
  model: LanguageModel,
  categories: string[],
  role: 'user message' | 'assistant response',
  text: string,
  abortSignal?: AbortSignal,
): Promise<z.infer<typeof moderationSchema>> {
  const { object } = await generateObject({
    model,
    schema: moderationSchema,
    temperature: 0,
    abortSignal,
    system: [
      `You are a content-policy classifier. Flag the ${role} ONLY if it clearly falls into one of these categories:`,
      ...categories.map((category) => `- ${category}`),
      'Ordinary rudeness, frustration, or sensitive-but-legitimate topics (health, finance, returns/refunds) are NOT flagged.',
      'Respond with flagged=false unless the text is a clear match.',
    ].join('\n'),
    prompt: text,
  });
  return object;
}

/**
 * LLM moderation guard over inbound user text. Runs the configured model as a
 * temperature-0 classifier against the policy categories and blocks on a match.
 */
export function createModerationGuard(options: ModerationGuardOptions): InputProcessor {
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const onError = options.onError ?? 'allow';
  return {
    id: options.id ?? 'moderation-guard',
    name: 'Moderation guard',
    description: 'LLM content-policy classifier over user input.',
    process: async ({ input, context }) => {
      let verdict: z.infer<typeof moderationSchema>;
      try {
        verdict = await classify(options.model, categories, 'user message', input, context.abortSignal);
      } catch {
        if (onError === 'block') {
          return {
            action: 'block',
            reason: 'moderation-error',
            message: options.message ?? "Sorry, I can't help with that.",
          };
        }
        return { action: 'allow' };
      }
      if (!verdict.flagged) {
        return { action: 'allow' };
      }
      return {
        action: 'block',
        reason: `moderation: ${verdict.category ?? 'flagged'}`,
        message: options.message ?? "Sorry, I can't help with that.",
      };
    },
  };
}

/** LLM moderation guard over assistant output — the post-turn counterpart. */
export function createModerationOutputGuard(options: ModerationGuardOptions): OutputProcessor {
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const onError = options.onError ?? 'allow';
  return {
    id: options.id ?? 'moderation-output-guard',
    name: 'Moderation output guard',
    description: 'LLM content-policy classifier over assistant output.',
    process: async ({ text, context }) => {
      let verdict: z.infer<typeof moderationSchema>;
      try {
        verdict = await classify(options.model, categories, 'assistant response', text, context.abortSignal);
      } catch {
        if (onError === 'block') {
          return {
            action: 'block',
            reason: 'moderation-error',
            message: options.message ?? 'Sorry, I cannot provide that response.',
          };
        }
        return { action: 'allow' };
      }
      if (!verdict.flagged) {
        return { action: 'allow' };
      }
      return {
        action: 'block',
        reason: `moderation: ${verdict.category ?? 'flagged'}`,
        message: options.message ?? 'Sorry, I cannot provide that response.',
      };
    },
  };
}
