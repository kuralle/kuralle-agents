import type { ChoiceOption } from '@kuralle-agents/core';
import type {
  InteractiveMessage,
  OutboundMiddleware,
  OutboundNext,
  OutboundRequest,
  SendOutcome,
} from '@kuralle-agents/messaging';

import type { ChannelPolicy } from './policy.js';

// Canonical ChoiceOption -> InteractiveMessage rendering now lives in
// @kuralle-agents/messaging (the default stream mapper uses it too);
// re-exported here for existing engagement consumers.
export {
  renderChoices,
  BUTTON_TITLE_MAX,
  LIST_ROW_TITLE_MAX,
  BUTTON_COUNT_MAX,
  LIST_ROW_COUNT_MAX,
} from '@kuralle-agents/messaging';
import { renderChoices } from '@kuralle-agents/messaging';

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
