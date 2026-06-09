/**
 * @module whatsapp/commerce
 *
 * Helpers and limits for WhatsApp commerce messages.
 *
 * Commerce messages let you share products from a Meta catalog and receive
 * orders directly in WhatsApp. The send methods live on the
 * {@link WhatsAppClient} (`sendProduct`, `sendProductList`, `sendCatalog`,
 * `sendAddressRequest`); this module provides the inbound typed accessors.
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/share-products
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order
 */

import type { InboundMessage } from '@kuralle-agents/messaging';

import type { NormalizedMessage } from '../webhook/normalizer.js';
import type { WhatsAppInboundOrder, WhatsAppInboundAddress, WhatsAppInboundProductInquiry } from './types.js';

export type {
  ProductMessage,
  ProductListMessage,
  ProductSection,
  CatalogMessage,
  AddressMessage,
  WhatsAppAddressValues,
  WhatsAppSavedAddress,
  WhatsAppOrderItem,
  WhatsAppInboundOrder,
  WhatsAppInboundAddress,
  WhatsAppInboundProductInquiry,
} from './types.js';

// ---------------------------------------------------------------------------
// Limits (per Meta Cloud API docs)
// ---------------------------------------------------------------------------

/** Maximum number of sections in a multi-product message. */
export const MAX_PRODUCT_LIST_SECTIONS = 10;

/** Maximum number of products across all sections of a multi-product message. */
export const MAX_PRODUCT_LIST_PRODUCTS = 30;

// ---------------------------------------------------------------------------
// Inbound typed accessors
// ---------------------------------------------------------------------------

/**
 * Extract the typed order from an inbound message, when the user placed an
 * order from a catalog, single-, or multi-product message.
 *
 * The generic `InboundMessage` type has no `order` field, so the order
 * travels on `message.raw` (the normalized WhatsApp webhook message). This
 * accessor returns it typed.
 *
 * @param message - An inbound message from the WhatsApp client.
 * @returns The order, or `undefined` if the message is not an order.
 *
 * @example
 * ```ts
 * client.onMessage(async (msg) => {
 *   const order = parseInboundOrder(msg);
 *   if (order) {
 *     console.log(`Order against catalog ${order.catalog_id}:`);
 *     for (const item of order.product_items) {
 *       console.log(`  ${item.quantity}x ${item.product_retailer_id} @ ${item.item_price} ${item.currency}`);
 *     }
 *   }
 * });
 * ```
 */
export function parseInboundOrder(message: InboundMessage): WhatsAppInboundOrder | undefined {
  const raw = message.raw as NormalizedMessage | undefined;
  const order = raw?.order;
  if (!order || typeof order.catalog_id !== 'string' || !Array.isArray(order.product_items)) {
    return undefined;
  }
  return order;
}

/**
 * Extract the typed address submission from an inbound message, when the
 * user replied to an address message (`sendAddressRequest`).
 *
 * Address replies arrive as `interactive.type === "nfm_reply"` messages with
 * `nfm_reply.name === "address_message"`; the address fields are JSON-encoded
 * in `nfm_reply.response_json`.
 *
 * @param message - An inbound message from the WhatsApp client.
 * @returns The parsed address, or `undefined` if the message is not an
 *          address submission (or the payload is malformed).
 */
export function parseInboundAddress(message: InboundMessage): WhatsAppInboundAddress | undefined {
  const raw = message.raw as NormalizedMessage | undefined;
  const nfm = raw?.interactive?.nfm_reply;
  if (!nfm || nfm.name !== 'address_message' || !nfm.response_json) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(nfm.response_json);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as WhatsAppInboundAddress).values === 'object' &&
      (parsed as WhatsAppInboundAddress).values !== null
    ) {
      return parsed as WhatsAppInboundAddress;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a product inquiry from an inbound message when the user replied
 * in the context of a catalog product message (`context.referred_product`).
 */
export function parseProductInquiry(
  message: InboundMessage,
): WhatsAppInboundProductInquiry | undefined {
  const raw = message.raw as NormalizedMessage | undefined;
  const referred = raw?.context?.referred_product;
  if (!referred?.catalog_id || !referred.product_retailer_id) {
    return undefined;
  }
  return {
    catalog_id: referred.catalog_id,
    product_retailer_id: referred.product_retailer_id,
    context_message_id: raw?.context?.message_id,
    context_from: raw?.context?.from,
  };
}
