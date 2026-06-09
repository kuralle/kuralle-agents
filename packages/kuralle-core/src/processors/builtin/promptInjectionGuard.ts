import type { InputProcessor } from '../../types/processors.js';
import { scanMemoryWrite } from '../../memory/blocks/safetyScanner.js';

export interface PromptInjectionGuardOptions {
  /** User-facing message when a pattern matches. */
  message?: string;
  id?: string;
}

/**
 * Deterministic prompt-injection guard over inbound user text. Reuses the
 * injection pattern set that already protects persistent memory writes
 * (`scanMemoryWrite`) — one audited pattern source, two enforcement points.
 *
 * False positive cost: the turn is refused with a polite message and the user
 * can rephrase. False negative cost: instruction override — so the patterns
 * err toward catching more.
 */
export function createPromptInjectionGuard(
  options: PromptInjectionGuardOptions = {},
): InputProcessor {
  return {
    id: options.id ?? 'prompt-injection-guard',
    name: 'Prompt injection guard',
    description: 'Blocks user input matching known prompt-injection patterns.',
    process: ({ input }) => {
      const scan = scanMemoryWrite(input);
      if (scan.safe) {
        return { action: 'allow' };
      }
      return {
        action: 'block',
        reason: `prompt-injection: ${scan.matchedPattern}`,
        message: options.message ?? "Sorry, I can't act on that request.",
      };
    },
  };
}
