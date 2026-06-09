import type { Cart, Product } from './types.js';

/**
 * Structural match for `@kuralle-agents/messaging-meta`'s `ProductListMessage`
 * send options — defined here (not imported) so the commerce package stays
 * channel-agnostic. `client.sendProductList(to, toWhatsAppProductList(...))`
 * type-checks structurally.
 */
export interface WhatsAppProductListOptions {
  catalogId: string;
  header: string;
  body: string;
  footer?: string;
  sections: Array<{ title?: string; productRetailerIds: string[] }>;
}

/**
 * Render products (or a cart) as a WhatsApp multi-product message payload.
 * Products without a `retailerId` are skipped — they don't exist in the Meta
 * catalog and the API would reject them.
 */
export function toWhatsAppProductList(
  source: Product[] | Cart,
  opts: { catalogId: string; header: string; body: string; footer?: string; sectionTitle?: string },
): WhatsAppProductListOptions {
  const retailerIds = (Array.isArray(source) ? source : source.items)
    .map((entry) => entry.retailerId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return {
    catalogId: opts.catalogId,
    header: opts.header,
    body: opts.body,
    footer: opts.footer,
    sections: [{ title: opts.sectionTitle, productRetailerIds: retailerIds }],
  };
}
