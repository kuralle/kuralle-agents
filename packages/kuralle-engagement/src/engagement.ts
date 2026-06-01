import type { ChannelPolicy } from './policy.js';
import type {
  ConsentStore,
  OwnershipStore,
  WindowStore,
  OutboundMiddleware,
  InboundResolverPlugin,
  MessagingRouterConfig,
  OutboundPipeline,
} from '@kuralle-agents/messaging';
import { InMemoryWindowStore } from '@kuralle-agents/messaging';
import { consentGate } from './consent.js';
import { ownershipGate } from './ownership.js';
import { closedWindowRecovery } from './closed-window-recovery.js';
import { interactiveRenderer } from './interactive-renderer.js';
import { createBroadcasts, type BroadcastApi } from './broadcast.js';
import { createInMemoryBroadcastLedger, type BroadcastLedger } from './broadcast-ledger.js';
import type { AuditSink } from './strategist.js';
import type { Scheduler } from './scheduler.js';

export interface EngagementOptions {
  policies: ChannelPolicy[];
  consent?: ConsentStore;
  ownership?: OwnershipStore;
  audit?: AuditSink;
  scheduler?: Scheduler;
  windowStore?: WindowStore;
  ledger?: BroadcastLedger;
  broadcastPipeline?: OutboundPipeline;
}

export type EngagementBridge = Pick<
  MessagingRouterConfig,
  'outbound' | 'inputResolver' | 'windowStore' | 'ownership' | 'consent' | 'onStatus'
>;

function alwaysOptedIn(): ConsentStore {
  return {
    isOptedIn: async () => true,
    optIn: async () => {},
    optOut: async () => {},
  };
}

export function policyInboundResolver(policies: ChannelPolicy[]): InboundResolverPlugin {
  return {
    name: 'policy-inbound',
    async tryResolve(m) {
      const policy = policies.find((p) => p.channel === m.platform);
      if (!policy) return undefined;
      return policy.resolveInbound(m);
    },
  };
}

function createBroadcastApi(opts: {
  broadcastPipeline?: OutboundPipeline;
  consent: ConsentStore;
  ledger: BroadcastLedger;
  platform: string;
}): BroadcastApi {
  if (!opts.broadcastPipeline) {
    return {
      async send() {
        throw new Error('no broadcast pipeline configured');
      },
    };
  }
  return createBroadcasts({
    pipeline: opts.broadcastPipeline,
    consent: opts.consent,
    ledger: opts.ledger,
    platform: opts.platform,
  });
}

export function engagement(opts: EngagementOptions): {
  bridge: EngagementBridge;
  broadcasts: BroadcastApi;
} {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const outbound: OutboundMiddleware[] = [];
  if (opts.consent) outbound.push(consentGate(opts.consent));
  if (opts.ownership) outbound.push(ownershipGate(opts.ownership));
  outbound.push(closedWindowRecovery(opts.policies));
  outbound.push(interactiveRenderer(opts.policies));

  const inputResolver: InboundResolverPlugin[] = [policyInboundResolver(opts.policies)];

  const bridge: EngagementBridge = {
    outbound,
    inputResolver,
    windowStore,
    ownership: opts.ownership,
    consent: opts.consent,
  };

  const ledger = opts.ledger ?? createInMemoryBroadcastLedger();
  const broadcasts = createBroadcastApi({
    broadcastPipeline: opts.broadcastPipeline,
    consent: opts.consent ?? alwaysOptedIn(),
    ledger,
    platform: opts.policies[0]?.channel ?? 'whatsapp',
  });

  return { bridge, broadcasts };
}
