import type { WindowStore } from '@kuralle-agents/messaging';
import type { WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

import { whatsappTemplateCatalog } from '../catalog.js';
import type { ChannelPolicy } from '../policy.js';
import { renderChoices } from '../interactive-renderer.js';
import { resolveInboundWhatsApp } from '../resolve-inbound-whatsapp.js';
import { createSmartSendStrategist, type AuditSink, type TemplateSelector } from '../strategist.js';

export function whatsappPolicy(opts: {
  client: WhatsAppClient;
  selector: TemplateSelector;
  windowStore: WindowStore;
  wabaId: string;
  audit?: AuditSink;
}): ChannelPolicy {
  const catalog = whatsappTemplateCatalog({ client: opts.client, wabaId: opts.wabaId });
  const strategist = createSmartSendStrategist({
    catalog,
    selector: opts.selector,
    audit: opts.audit ?? { record() {} },
  });
  return {
    channel: 'whatsapp',
    hasWindow: true,
    async isWindowOpen(threadId) {
      return (await opts.windowStore.get(threadId)).open;
    },
    closedWindow: { kind: 'template', strategist },
    consentRequired: true,
    renderInteractive: (options, prompt) => renderChoices(options, prompt),
    resolveInbound: (m) => resolveInboundWhatsApp(m),
  };
}
