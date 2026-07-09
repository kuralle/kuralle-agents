# @kuralle-agents/commerce

Conversational-commerce primitives for Kuralle agents: typed carts, an
idempotent `create_order` tool, and channel mapping helpers. Tools return
data only — flows own the conversation; the messaging layer owns rendering.

## What's inside

- **Money / Product / Cart / Order types** — integer minor units, never floats.
- **`ProductCatalog`** — the host-implemented product source (your backend,
  MCP server, or API). `createInMemoryCatalog(products)` for dev/tests.
- **`createCartTools({ catalog })`** — durable `product_search`, `cart_add`,
  `cart_remove`, `cart_view` tools. The cart lives in flow state
  (`runState.state.__cart`), so it persists with the conversation and is
  visible to flow nodes and validators.
- **`createOrderTool({ submit, ledger? })`** — idempotent order placement:
  - a **content key** (hash of session + cart lines) dedupes identical
    resubmissions across turns — "place my order" twice returns the same
    order instead of charging twice;
  - **in-flight coalescing** collapses concurrent submissions;
  - the durable effect log still covers replay of the same call.
  Provide a durable `OrderLedger` (Redis/Postgres/DO) in production; the
  default ledger is in-memory.
- **`toWhatsAppProductList(productsOrCart, opts)`** — renders products as a
  WhatsApp multi-product message payload, structurally compatible with
  `@kuralle-agents/messaging-meta`'s `client.sendProductList`.

## Usage

```ts
import { defineAgent, defineFlow } from '@kuralle-agents/core';
import {
  createCartTools,
  createOrderTool,
  createInMemoryCatalog,
} from '@kuralle-agents/commerce';

const catalog = createInMemoryCatalog(products); // or your ProductCatalog impl
const cartTools = createCartTools({ catalog });
const createOrder = createOrderTool({
  submit: async ({ items, total, contentKey }) => {
    const order = await myBackend.createOrder({ items, total, idempotencyKey: contentKey });
    return { orderId: order.id };
  },
  ledger: myDurableLedger, // Redis/Postgres in production
});

const agent = defineAgent({
  id: 'shop',
  instructions: 'You help customers order from our store.',
  globalTools: { product_search: cartTools.product_search, cart_view: cartTools.cart_view },
  tools: { cart_add: cartTools.cart_add, cart_remove: cartTools.cart_remove, create_order: createOrder },
  flows: [checkoutFlow], // gate create_order behind an explicit confirm step
});
```

Showing products natively on WhatsApp (requires a Meta Commerce Manager
catalog and `retailerId` on your products):

```ts
import { toWhatsAppProductList } from '@kuralle-agents/commerce';

const results = await catalog.search('chocolate cake');
await whatsapp.sendProductList(
  to,
  toWhatsAppProductList(results, {
    catalogId: META_CATALOG_ID,
    header: 'Our cakes',
    body: 'Tap to view and add to your order.',
  }),
);
```

Inbound WhatsApp orders (user taps "Add to cart" in the native catalog UI)
arrive via `parseInboundOrder` from `@kuralle-agents/messaging-meta/whatsapp`.

## Design rules honored

- Tools return data only; confirmation wording comes from flow nodes.
- Consequential tools (`cart_add`, `create_order`) stay flow-gated — never in
  `globalTools`.
- `create_order` pairs with `needsApproval` or a flow confirm gate for
  human-in-the-loop checkout.
