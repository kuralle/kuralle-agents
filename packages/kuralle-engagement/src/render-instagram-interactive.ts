import type { ChoiceOption } from '@kuralle-agents/core';
import type { InteractiveMessage } from '@kuralle-agents/messaging';

/** Instagram button-template title limit (R-11 / Meta quick-reply parity). */
export const IG_TITLE_MAX = 20;
/** Instagram button template — max buttons per message. */
export const IG_BUTTON_COUNT_MAX = 3;
/** Instagram generic-template carousel — max elements. */
export const IG_CAROUSEL_COUNT_MAX = 10;

function assertIgTitle(label: string, optionId: string): void {
  if (label.length > IG_TITLE_MAX) {
    throw new Error(
      `interactive: title for "${optionId}" exceeds ${IG_TITLE_MAX} characters (got ${label.length})`,
    );
  }
}

/**
 * Renders author choices to a channel-neutral `InteractiveMessage` for Instagram:
 * ≤3 → button template; 4–10 → generic-template carousel via list shape.
 * Quick-replies (≤13) are a future enhancement — not used in this cut.
 */
export function renderInstagramInteractive(
  options: ChoiceOption[],
  prompt: string,
): InteractiveMessage {
  if (options.length === 0) {
    throw new Error('interactive: at least one option is required');
  }

  if (options.some((o) => o.flow)) {
    throw new Error('interactive: flow messages are not supported on Instagram');
  }

  if (options.length > IG_CAROUSEL_COUNT_MAX) {
    throw new Error(
      `interactive: too many options (max ${IG_CAROUSEL_COUNT_MAX} carousel elements)`,
    );
  }

  if (options.some((o) => o.url)) {
    const urlOptions = options.filter((o) => o.url);
    if (urlOptions.length > IG_BUTTON_COUNT_MAX) {
      throw new Error(
        `interactive: too many URL options (max ${IG_BUTTON_COUNT_MAX} buttons)`,
      );
    }
    for (const o of urlOptions) {
      assertIgTitle(o.label, o.id);
    }
    return {
      type: 'buttons',
      body: prompt,
      action: {
        type: 'buttons',
        buttons: urlOptions.map((o) => ({ id: o.id, title: o.label })),
      },
    };
  }

  if (options.length <= IG_BUTTON_COUNT_MAX) {
    for (const o of options) {
      assertIgTitle(o.label, o.id);
    }
    return {
      type: 'buttons',
      body: prompt,
      action: {
        type: 'buttons',
        buttons: options.map((o) => ({ id: o.id, title: o.label })),
      },
    };
  }

  for (const o of options) {
    assertIgTitle(o.label, o.id);
  }
  return {
    type: 'list',
    body: prompt,
    action: {
      type: 'list',
      button: 'Choose',
      sections: [
        {
          title: 'Options',
          rows: options.map((o) => ({
            id: o.id,
            title: o.label,
            description: o.description,
          })),
        },
      ],
    },
  };
}
