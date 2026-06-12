import type { UserInputContent } from '@kuralle-agents/core';
import type { InboundMessage } from '../types/messages.js';
import type { PlatformClient } from '../types/client.js';

export interface MediaResolver {
  resolve(message: InboundMessage, input: UserInputContent): Promise<UserInputContent>;
}

export class PlatformMediaResolver implements MediaResolver {
  constructor(private readonly client: Pick<PlatformClient, 'downloadMedia'>) {}

  async resolve(message: InboundMessage, input: UserInputContent): Promise<UserInputContent> {
    const { attachInboundMedia } = await import('../adapter/inbound-media.js');
    return attachInboundMedia(message, input, this.client);
  }
}

export const systemClock = {
  now: () => Date.now(),
};

export const noopCoalesceScheduler = {
  arm: async () => {},
  cancel: async () => {},
};

