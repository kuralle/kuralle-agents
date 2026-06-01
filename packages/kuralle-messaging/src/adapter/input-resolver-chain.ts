import type { ResolvedSelection } from '@kuralle-agents/core';
import type { InboundMessage } from '../types/messages.js';

export interface InboundResolverPlugin {
  readonly name: string;
  tryResolve(
    m: InboundMessage,
  ): Promise<{ input: string; selection?: ResolvedSelection } | undefined>;
}

export class InteractiveResolver implements InboundResolverPlugin {
  readonly name = 'interactive';

  async tryResolve(
    m: InboundMessage,
  ): Promise<{ input: string; selection?: ResolvedSelection } | undefined> {
    const interactiveId = m.interactive?.id;
    if (interactiveId) {
      return { input: interactiveId, selection: { id: interactiveId } };
    }
    if (m.button?.payload) {
      return { input: m.button.payload, selection: { id: m.button.payload } };
    }
    if (m.interactive?.formResponse) {
      return {
        input: '__flow__',
        selection: { formData: m.interactive.formResponse },
      };
    }
    return undefined;
  }
}

export class TextResolver implements InboundResolverPlugin {
  readonly name = 'text';

  async tryResolve(
    m: InboundMessage,
  ): Promise<{ input: string; selection?: ResolvedSelection }> {
    return { input: m.text ?? '', selection: undefined };
  }
}

export class InboundResolverChain {
  constructor(private readonly plugins: InboundResolverPlugin[]) {
    if (plugins.length === 0) {
      throw new Error('InboundResolverChain requires at least one plugin');
    }
  }

  async resolve(
    m: InboundMessage,
  ): Promise<{ input: string; selection?: ResolvedSelection }> {
    for (const plugin of this.plugins) {
      const result = await plugin.tryResolve(m);
      if (result !== undefined) return result;
    }
    throw new Error('no inbound resolver matched');
  }
}

export function defaultInboundChain(): InboundResolverChain {
  return new InboundResolverChain([new InteractiveResolver(), new TextResolver()]);
}
