# @kuralle-agents/messaging-meta

WhatsApp, Messenger, and Instagram clients for Kuralle messaging — each implementing the `PlatformClient` interface from `@kuralle-agents/messaging`.

## Install

```bash
npm install @kuralle-agents/messaging-meta @kuralle-agents/messaging
```

## What it does

Provides production-ready clients for Meta's three messaging platforms, built on a shared Graph API foundation with retry logic, rate limiting, and unified error handling.

- **WhatsApp** — full API coverage: text (auto-split at 4096 chars), media, templates, interactive buttons, list messages, CTA buttons, WhatsApp Flows, reactions, locations, contacts, commerce (single/multi-product, catalog, and address messages, plus inbound order parsing).
- **Messenger** — button templates, generic templates (carousel), quick replies, sender actions, user profile lookups.
- **Instagram** — text (auto-split at 1000 bytes), quick replies, carousels, private replies to comments, ice breakers, message tags.
- **Main barrel** — `GraphAPIClient`, `BaseMetaClient`, `verifySignature`, `normalizeWebhook`, error classes.
- **Shared Graph API** — `MetaErrorClassifier`, `SmartSplitter`, `TruncateSplitter`, `ByteLimitSplitter`, unicode utilities.

WhatsApp is available only via the `/whatsapp` subpath (see below).

## Usage

```typescript
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});

whatsapp.onMessage(async (msg) => {
  await whatsapp.markAsRead(msg.id);
  await whatsapp.sendText(msg.from.phone!, `You said: ${msg.text}`);
});

app.route('/whatsapp', whatsapp.webhookRouter());
```

### Messenger

```typescript
import { createMessengerClient } from '@kuralle-agents/messaging-meta/messenger';

const messenger = createMessengerClient({
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
});
```

### Instagram

```typescript
import { createInstagramClient } from '@kuralle-agents/messaging-meta/instagram';

const instagram = createInstagramClient({
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  igId: process.env.INSTAGRAM_ACCOUNT_ID!,
  verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN!,
});
```

### WhatsApp commerce

Share catalog products and receive orders without leaving WhatsApp:

```typescript
import { parseInboundOrder } from '@kuralle-agents/messaging-meta/whatsapp';

// Single product, multi-product (max 10 sections / 30 products), catalog, address request
await whatsapp.sendProduct(to, { catalogId, productRetailerId: 'sku-1', body: { text: 'Check this out' } });
await whatsapp.sendProductList(to, {
  header: { type: 'text', text: 'Bestsellers' },
  body: { text: 'Pick your favorites' },
  catalogId,
  sections: [{ title: 'Cakes', productRetailerIds: ['sku-1', 'sku-2'] }],
});
await whatsapp.sendCatalog(to, { body: { text: 'Browse our catalog' } });
await whatsapp.sendAddressRequest(to, { body: { text: 'Where should we deliver?' }, country: 'IN' });

// Inbound orders (webhook message type "order") arrive typed:
whatsapp.onMessage(async (msg) => {
  const order = parseInboundOrder(msg);
  if (order) {
    // order.catalog_id, order.product_items[].{product_retailer_id, quantity, item_price, currency}
  }
});
```

Address submissions arrive as `nfm_reply` interactive messages — use `parseInboundAddress(msg)` for a typed accessor. Address messages are country-gated by Meta (currently India only).

### Webhook verification without a client

```typescript
import { verifySignature, normalizeWebhook } from '@kuralle-agents/messaging-meta/webhooks';

const valid = verifySignature({ appSecret, rawBody, signatureHeader: sig });
const events = normalizeWebhook(JSON.parse(rawBody));
// events.messages, events.statuses, events.reactions
```

## Subpath exports

| Import path | Contents |
|---|---|
| `@kuralle-agents/messaging-meta` | `GraphAPIClient`, `BaseMetaClient`, errors, `verifySignature`, `normalizeWebhook`, `MessengerClient`, `InstagramClient` |
| `@kuralle-agents/messaging-meta/whatsapp` | `WhatsAppClient`, `createWhatsAppClient`, templates, flows, commerce (`parseInboundOrder`, `parseInboundAddress`), format converter |
| `@kuralle-agents/messaging-meta/messenger` | `MessengerClient`, `createMessengerClient`, format converter |
| `@kuralle-agents/messaging-meta/instagram` | `InstagramClient`, `createInstagramClient`, ice breakers, format converter |
| `@kuralle-agents/messaging-meta/webhooks` | `verifySignature`, `normalizeWebhook` only |

## Related

- [`@kuralle-agents/messaging`](../kuralle-messaging) — runtime router and `PlatformClient` interface
- [`@kuralle-agents/core`](../kuralle-core) — runtime, agents, flows
