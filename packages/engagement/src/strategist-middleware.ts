import type {
  OutboundMiddleware,
  OutboundNext,
  OutboundRequest,
  SendOutcome,
} from '@kuralle-agents/messaging';
import type { SmartSendStrategist, StrategistInput } from './strategist.js';

export function strategistMiddleware(strategist: SmartSendStrategist): OutboundMiddleware {
  return {
    name: 'strategist',
    async send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> {
      if (req.payload.kind !== 'text') return next(req);
      const input: StrategistInput = { text: req.payload.text, window: req.meta.window };
      const decision = await strategist.decide(input);
      switch (decision.kind) {
        case 'freeform':
          return next(req);
        case 'template':
          return next({ ...req, payload: { kind: 'template', template: decision.template } });
        case 'defer':
          return { kind: 'deferred', reason: decision.reason };
      }
    },
  };
}
