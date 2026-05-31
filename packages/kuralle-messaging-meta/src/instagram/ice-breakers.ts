/**
 * @module instagram/ice-breakers
 *
 * Ice breaker types and helper utilities for the Instagram Messaging API.
 *
 * Ice breakers are conversation starters that appear when a user opens
 * a DM thread with your Instagram professional account for the first time.
 * When tapped, they deliver a `messaging_postback` webhook event with the
 * configured payload.
 *
 * Ice breaker management is exposed on the {@link InstagramClient} as
 * `client.iceBreakers.set()`, `client.iceBreakers.get()`, and
 * `client.iceBreakers.delete()`.
 *
 * @example
 * ```ts
 * import { createInstagramClient } from '@kuralle-agents/messaging-meta/instagram';
 * import { buildIceBreakerConfig } from '@kuralle-agents/messaging-meta/instagram';
 *
 * const client = createInstagramClient({ ... });
 *
 * // Set ice breakers using the helper
 * const config = buildIceBreakerConfig([
 *   { question: 'What are your hours?', payload: 'HOURS' },
 *   { question: 'Where are you located?', payload: 'LOCATION' },
 * ]);
 * await client.iceBreakers.set([config]);
 * ```
 */

import type { IceBreaker, IceBreakerConfig } from './types.js';

// Re-export types for convenience.
export type { IceBreaker, IceBreakerConfig };

/** Maximum number of ice breakers allowed per locale. */
export const MAX_ICE_BREAKERS = 4;

/**
 * Build an {@link IceBreakerConfig} from an array of question-payload pairs.
 *
 * Validates that the number of items does not exceed the maximum of 4
 * per locale and truncates if necessary.
 *
 * @param items  - Array of ice breaker question-payload pairs.
 * @param locale - Optional BCP 47 locale code (e.g. `"en_US"`).
 * @returns A fully formed {@link IceBreakerConfig}.
 *
 * @example
 * ```ts
 * const config = buildIceBreakerConfig([
 *   { question: 'What services do you offer?', payload: 'SERVICES' },
 *   { question: 'How do I book an appointment?', payload: 'BOOKING' },
 * ]);
 * ```
 */
export function buildIceBreakerConfig(
  items: IceBreaker[],
  locale?: string,
): IceBreakerConfig {
  const config: IceBreakerConfig = {
    call_to_actions: items.slice(0, MAX_ICE_BREAKERS),
  };

  if (locale) {
    config.locale = locale;
  }

  return config;
}

/**
 * Validate an array of {@link IceBreakerConfig} entries.
 *
 * Checks that each config has at most {@link MAX_ICE_BREAKERS} items
 * and that every item has both a `question` and `payload` string.
 *
 * @param configs - The ice breaker configurations to validate.
 * @returns An array of validation error strings (empty if valid).
 */
export function validateIceBreakers(configs: IceBreakerConfig[]): string[] {
  const errors: string[] = [];

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];

    if (config.call_to_actions.length > MAX_ICE_BREAKERS) {
      errors.push(
        `Config at index ${i}: exceeds maximum of ${MAX_ICE_BREAKERS} ice breakers (has ${config.call_to_actions.length})`,
      );
    }

    for (let j = 0; j < config.call_to_actions.length; j++) {
      const item = config.call_to_actions[j];

      if (!item.question || typeof item.question !== 'string') {
        errors.push(`Config[${i}].call_to_actions[${j}]: missing or invalid "question"`);
      }
      if (!item.payload || typeof item.payload !== 'string') {
        errors.push(`Config[${i}].call_to_actions[${j}]: missing or invalid "payload"`);
      }
    }
  }

  return errors;
}
