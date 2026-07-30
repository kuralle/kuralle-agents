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
- **`createOrderTool({ submit, ledger?, needsApproval? })`** — approval-gated,
  idempotent order placement:
  - a **content key** (hash of session + cart lines) dedupes identical
    resubmissions across turns — "place my order" twice returns the same
    order instead of charging twice;
  - **in-flight coalescing** collapses concurrent submissions;
  - the durable effect log still covers replay of the same call.
  It sets `needsApproval: true` by default. Provide a durable `OrderLedger`
  with atomic `runOnce` (Postgres advisory lock or a per-key Durable Object)
  in production; the default ledger is process-local. The downstream order
  API must also honor the supplied `contentKey` as an idempotency key because
  a process can fail after the remote effect but before the ledger write.
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
  ledger: myDurableLedger, // Postgres/DO implementation with atomic runOnce
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
- `create_order` requires human approval by default. Set `needsApproval:
  false` only when a controlled flow supplies an equivalent confirmation
  gate.
