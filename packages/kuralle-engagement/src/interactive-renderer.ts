import type { ChoiceOption } from '@kuralle-agents/core';
import type {
  InteractiveMessage,
  OutboundMiddleware,
  OutboundNext,
  OutboundRequest,
  SendOutcome,
} from '@kuralle-agents/messaging';

import type { ChannelPolicy } from './policy.js';

/** WhatsApp reply-button title limit (R-11). */
export const BUTTON_TITLE_MAX = 20;
/** WhatsApp list row title limit (R-11). */
export const LIST_ROW_TITLE_MAX = 24;
/** WhatsApp reply buttons per message. */
export const BUTTON_COUNT_MAX = 3;
/** WhatsApp list rows per message. */
export const LIST_ROW_COUNT_MAX = 10;

function assertButtonTitle(label: string, optionId: string): void {
  if (label.length > BUTTON_TITLE_MAX) {
    throw new Error(
      `interactive: button title for "${optionId}" exceeds ${BUTTON_TITLE_MAX} characters (got ${label.length})`,
    );
  }
}

function assertListRowTitle(label: string, optionId: string): void {
  if (label.length > LIST_ROW_TITLE_MAX) {
    throw new Error(
      `interactive: list row title for "${optionId}" exceeds ${LIST_ROW_TITLE_MAX} characters (got ${label.length})`,
    );
  }
}

/**
 * Renders author choices to a channel-neutral `InteractiveMessage`, enforcing
 * WhatsApp limits (R-11). URL options map to a single-button reply shape because
 * `InteractiveMessage` has no dedicated CTA variant — the sink must interpret
 * `ChoiceOption.url` when sending platform CTA messages.
 */
export function renderChoices(options: ChoiceOption[], prompt: string): InteractiveMessage {
  if (options.length === 0) {
    throw new Error('interactive: at least one option is required');
  }

  const flowOption = options.find((o) => o.flow);
  if (flowOption) {
    if (options.length > 1) {
      throw new Error('interactive: flow messages support exactly one option');
    }
    const { flowId } = flowOption.flow!;
    if (!flowOption.flow!.cta) {
      throw new Error('interactive: flow option requires flow.cta');
    }
    return {
      type: 'flow',
      body: prompt,
      action: {
        type: 'flow',
        flowId,
        flowToken: flowOption.id,
      },
    };
  }

  if (options.some((o) => o.url)) {
    const urlOptions = options.filter((o) => o.url);
    if (urlOptions.length > BUTTON_COUNT_MAX) {
      throw new Error(
        `interactive: too many URL options (max ${BUTTON_COUNT_MAX} reply buttons)`,
      );
    }
    for (const o of urlOptions) {
      assertButtonTitle(o.label, o.id);
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

  if (options.length > LIST_ROW_COUNT_MAX) {
    throw new Error(`interactive: too many options (max ${LIST_ROW_COUNT_MAX} list rows)`);
  }

  if (options.length <= BUTTON_COUNT_MAX) {
    for (const o of options) {
      assertButtonTitle(o.label, o.id);
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
    assertListRowTitle(o.label, o.id);
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

function policyFor(policies: ChannelPolicy[], platform: string): ChannelPolicy | undefined {
  return policies.find((p) => p.channel === platform);
}

export function interactiveRenderer(policies?: ChannelPolicy[]): OutboundMiddleware {
  return {
    name: 'interactive-renderer',
    async send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> {
      const part = req.meta.parts.find((p) => p.type === 'interactive');
      if (!part) return next(req);
      const policy = policies ? policyFor(policies, req.platform) : undefined;
      const interactive = policy
        ? policy.renderInteractive(part.options, part.prompt)
        : renderChoices(part.options, part.prompt);
      return next({ ...req, payload: { kind: 'interactive', interactive } });
    },
  };
}
