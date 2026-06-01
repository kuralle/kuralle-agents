import type { InboundMessage, InteractiveMessage } from '@kuralle-agents/messaging';
import type { ResolvedSelection } from '@kuralle-agents/core';
import type { SmartSendStrategist } from './strategist.js';

export type { SmartSendStrategist } from './strategist.js';

/** Author-facing choice option (RFC §4.5). Stable shape. */
export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  url?: string;
  flow?: { flowId: string; cta: string };
}

export type ClosedWindowStrategy =
  | { kind: 'template'; strategist: SmartSendStrategist }
  | { kind: 'message-tag'; tag: string }
  | { kind: 'none' };

/** The only channel-specific code (RFC §4.12 / REQ-22). */
export interface ChannelPolicy {
  readonly channel: string;
  readonly hasWindow: boolean;
  isWindowOpen(threadId: string): Promise<boolean>;
  readonly closedWindow: ClosedWindowStrategy;
  readonly consentRequired: boolean;
  renderInteractive(options: ChoiceOption[], prompt: string): InteractiveMessage;
  resolveInbound(m: InboundMessage): { input: string; selection?: ResolvedSelection };
}
