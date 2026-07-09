import type { InboundMessage, InteractiveMessage } from '@kuralle-agents/messaging';
import type { ChoiceOption, ResolvedSelection, UserInputContent } from '@kuralle-agents/core';
import type { SmartSendStrategist } from './strategist.js';

export type { SmartSendStrategist } from './strategist.js';
export type { ChoiceOption } from '@kuralle-agents/core';

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
  resolveInbound(m: InboundMessage): { input: UserInputContent; selection?: ResolvedSelection };
}
