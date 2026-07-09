import type { OutboundMiddleware } from '@kuralle-agents/messaging';

import type { ChannelPolicy } from './policy.js';

export function closedWindowRecovery(policies: ChannelPolicy[]): OutboundMiddleware {
  const byChannel = new Map(policies.map((p) => [p.channel, p]));
  return {
    name: 'closed-window-recovery',
    async send(req, next) {
      const policy = byChannel.get(req.platform);
      if (!policy || !policy.hasWindow || (await policy.isWindowOpen(req.threadId))) {
        return next(req);
      }
      const cw = policy.closedWindow;
      if (cw.kind === 'template') {
        if (req.payload.kind !== 'text') return next(req);
        const d = await cw.strategist.decide({ text: req.payload.text, window: req.meta.window });
        if (d.kind === 'template') {
          return next({ ...req, payload: { kind: 'template', template: d.template } });
        }
        if (d.kind === 'defer') return { kind: 'deferred', reason: d.reason };
        return next(req);
      }
      if (cw.kind === 'message-tag') {
        if (req.payload.kind === 'text') {
          return next({ ...req, payload: { ...req.payload, tag: cw.tag } });
        }
        return { kind: 'deferred', reason: 'window-closed-tag-text-only' };
      }
      return { kind: 'deferred', reason: 'window-closed-no-recovery' };
    },
  };
}
