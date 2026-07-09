import type { WindowStore } from '@kuralle-agents/messaging';
import type { InstagramClient } from '@kuralle-agents/messaging-meta/instagram';

import type { ChannelPolicy } from '../policy.js';
import { renderInstagramInteractive } from '../render-instagram-interactive.js';
import { resolveInboundInstagram } from '../resolve-inbound-instagram.js';

export function instagramPolicy(opts: {
  client: InstagramClient;
  windowStore: WindowStore;
}): ChannelPolicy {
  return {
    channel: 'instagram',
    hasWindow: true,
    async isWindowOpen(threadId) {
      return (await opts.windowStore.get(threadId)).open;
    },
    closedWindow: { kind: 'message-tag', tag: 'HUMAN_AGENT' },
    consentRequired: true,
    renderInteractive: (options, prompt) => renderInstagramInteractive(options, prompt),
    resolveInbound: (m) => resolveInboundInstagram(m),
  };
}
