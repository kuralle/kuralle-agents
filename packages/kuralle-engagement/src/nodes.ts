import { action } from '@kuralle-agents/core';
import type { ActionNode, FlowState, Transition } from '@kuralle-agents/core';
import type { WindowState } from '@kuralle-agents/messaging';
import type { SendDecision, SmartSendStrategist } from './strategist.js';

export function smartSend(
  strategist: SmartSendStrategist,
  node: {
    id: string;
    message: (s: FlowState) => string;
    intent?: string;
    window?: (s: FlowState) => WindowState;
    next?: (d: SendDecision, s: FlowState) => Transition;
  },
): ActionNode {
  return action({
    id: node.id,
    run: async (state) => {
      const text = node.message(state);
      const window: WindowState = node.window?.(state) ?? {
        open: true,
        expiresAt: new Date(),
      };
      const decision = await strategist.decide({ text, window, intent: node.intent });
      return node.next ? node.next(decision, state) : 'stay';
    },
  });
}
