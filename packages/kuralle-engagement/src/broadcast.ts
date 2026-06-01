import type {
  OutboundPipeline,
  OutboundTemplate,
  WindowState,
  ConsentStore,
} from '@kuralle-agents/messaging';
import type { BroadcastLedger } from './broadcast-ledger.js';

export interface Campaign {
  id: string;
  template: OutboundTemplate;
  recipients: { customerId: string; threadId: string }[];
}

export interface BroadcastApi {
  send(campaign: Campaign): Promise<{ sent: number; skipped: number }>;
}

export function createBroadcasts(opts: {
  pipeline: OutboundPipeline;
  consent: ConsentStore;
  ledger: BroadcastLedger;
  platform: string;
  window?: (threadId: string) => Promise<WindowState>;
}): BroadcastApi {
  return {
    async send(campaign) {
      let sent = 0;
      let skipped = 0;
      for (const r of campaign.recipients) {
        if (!(await opts.consent.isOptedIn(r.customerId))) {
          skipped++;
          continue;
        }
        const key = `${campaign.id}:${r.customerId}`;
        if (!(await opts.ledger.putIfAbsent(key))) {
          skipped++;
          continue;
        }
        const window: WindowState =
          (await opts.window?.(r.threadId)) ?? { open: false, expiresAt: null };
        await opts.pipeline.send({
          threadId: r.threadId,
          platform: opts.platform,
          payload: { kind: 'template', template: campaign.template },
          meta: { window, parts: [], sessionId: r.threadId, userId: r.customerId },
        });
        sent++;
      }
      return { sent, skipped };
    },
  };
}
