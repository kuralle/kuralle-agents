# ADR 0011 — @kuralle-agents/commerce + WhatsApp commerce surface

Status: accepted (0.8.5)

## Context

Kuralle's stated use case is agentic conversational commerce, but no package
contained a cart, order, catalog, or payment concept, and the WhatsApp client
could not send product/catalog messages or parse inbound orders. The
idempotent-order pattern (content-key dedupe + in-flight coalescing) had been
proven in the Acme production bot but never productized.

## Decisions

### Channel surface (`@kuralle-agents/messaging-meta`)

WhatsApp Cloud API commerce messages, grounded in current Meta docs:
`sendProduct` (single product), `sendProductList` (multi-product, ≤10
sections / ≤30 products validated client-side), `sendCatalog`,
`sendAddressRequest` (address message; India-gated by Meta). Inbound `order`
webhooks are normalized (`NormalizedMessage.order`) with typed accessors
`parseInboundOrder` / `parseInboundAddress` from the `/whatsapp` subpath —
the generic `InboundMessage` type is unchanged (orders ride `message.raw`).
Payment messages (`order_details` / payments APIs) are explicitly out of
scope — market-gated and a separate integration decision.

### Commerce primitives (`@kuralle-agents/commerce`)

A channel-agnostic package owning the typed commerce contract:

- `Money` is integer minor units; `cartTotal` rejects mixed currencies.
- `ProductCatalog` is host-implemented (backend/MCP/API); tools never invent
  products. `createInMemoryCatalog` for dev/tests.
- The cart lives in **flow state** (`runState.state.__cart`) — the durable
  per-conversation kv the runtime already persists at turn boundaries and the
  grounding validator already reads. (Not `session.workingMemory`:
  `SessionRunStore.putRunState` re-fetches the session, so tool mutations of
  the in-memory session object are not durable.)
- `createCartTools` → `product_search`, `cart_add`, `cart_remove`,
  `cart_view` (data-only returns; rendering is the channel layer's job).
- `createOrderTool({ submit, ledger })` — idempotent order placement with two
  dedupe layers beyond the effect log (which only covers replay of the same
  call): a content key (hash of session + sorted cart lines) checked against
  an `OrderLedger`, and in-flight coalescing. This is the productized Acme
  pattern.
- `toWhatsAppProductList` maps products/carts to the messaging-meta
  `sendProductList` payload **structurally** (no hard dependency) so commerce
  stays channel-agnostic.

### Alignment with agent-checkout protocols

Order/cart types use integer minor-unit money and stable idempotency keys so
a future ACP/UCP (agent-initiated checkout) adapter is a mapping layer, not a
remodel. Protocol adapters are deliberately out of scope for 0.8.5.

## Consequences

- "Conversational commerce" is now expressible end-to-end: catalog search →
  native WhatsApp product messages → inbound order → idempotent order
  placement, with checkout gated by flows/`needsApproval`.
- The default `OrderLedger` is in-memory; production deployments must supply
  a durable ledger (Redis/Postgres/DO SQLite) — documented in the README.
