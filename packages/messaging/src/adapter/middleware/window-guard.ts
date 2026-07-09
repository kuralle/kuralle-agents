import type { OutboundMiddleware, OutboundNext, OutboundRequest, SendOutcome } from '../../types/outbound.js';

/** Non-removable, terminal middleware: blocks free-form payloads outside the window (REQ-1/REQ-16).
 *  Templates are window-agnostic and pass. A closed window DEFERS (Sprint 2 adds template conversion). */
export const windowGuard: OutboundMiddleware = {
  name: 'window-guard',
  async send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> {
    if (req.payload.kind === 'template') return next(req);
    if (req.payload.kind === 'text' && req.payload.tag) return next(req);
    if (req.meta.window.open) return next(req);
    return { kind: 'deferred', reason: 'window-closed' };
  },
};
