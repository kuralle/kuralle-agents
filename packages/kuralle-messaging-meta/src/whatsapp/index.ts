/**
 * @module whatsapp
 *
 * WhatsApp Cloud API client for the Kuralle messaging framework.
 *
 * This module provides a complete, production-ready WhatsApp Business Platform
 * integration implementing the `PlatformClient` interface from
 * `@kuralle-agents/messaging`.
 *
 * @example
 * ```ts
 * import {
 *   createWhatsAppClient,
 *   buildTemplateSendPayload,
 *   WhatsAppFormatConverter,
 * } from '@kuralle-agents/messaging-meta/whatsapp';
 *
 * const client = createWhatsAppClient({
 *   accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
 *   appSecret: process.env.META_APP_SECRET!,
 *   phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 *   verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
 * });
 *
 * client.onMessage(async (msg) => {
 *   await client.sendText(msg.from.phone!, `Echo: ${msg.text}`);
 * });
 * ```
 *
 * @packageDocumentation
 */

// ─── Client ───────────────────────────────────────────────────────────────
export { WhatsAppClient, createWhatsAppClient } from './client.js';

// ─── Types ────────────────────────────────────────────────────────────────
export type {
  WhatsAppClientConfig,
  WhatsAppThreadId,
  WhatsAppSendResponse,
  TemplateMessage,
  TemplateLanguage,
  TemplateComponent,
  TemplateParameter,
  MediaObject,
  ListMessage,
  ListSection,
  ListRow,
  ButtonMessage,
  ReplyButton,
  CTAButtonMessage,
  FlowInteractiveInput,
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
  LocationPayload,
  ContactPayload,
  BusinessProfile,
  TemplateDefinition,
  TemplateDefinitionComponent,
  TemplateInfo,
  FlowDefinition,
  FlowInfo,
  FlowAssets,
  WhatsAppMediaResponse,
  TextOrTemplateOptions,
} from './types.js';

// ─── Templates ────────────────────────────────────────────────────────────
export {
  buildTemplateSendPayload,
  buildTemplatePayload,
  mapOutboundTemplateComponents,
} from './templates.js';
export type {
  TypedTemplateConfig,
  RawTemplateComponents,
} from './templates.js';

// ─── Format converter ────────────────────────────────────────────────────
export { WhatsAppFormatConverter } from './format.js';

// ─── Message splitting ──────────────────────────────────────────────────
export { splitMessage } from './split.js';

// ─── Flows ──────────────────────────────────────────────────────────────
export { generateFlowToken, buildFlowInput } from './flows.js';

// ─── Commerce ───────────────────────────────────────────────────────────
export {
  parseInboundOrder,
  parseInboundAddress,
  MAX_PRODUCT_LIST_SECTIONS,
  MAX_PRODUCT_LIST_PRODUCTS,
} from './commerce.js';
