# Clothing example — Acme Threads shop bot

Deep example for `@kuralle-agents/engagement`: **interactive catalog/size/color** (routed by stable id), **cart state across turns**, **free-form address extraction** (`collect`), **checkout payment**, and a **promo broadcast template** (`promo_drop`) mixed with conversational flow.

## Flow (`acme-threads` / `shop`)

1. **browse** — `catalog` tool → 3 products in state → **pickProduct**
2. **pickProduct** — product buttons (≤3) by id → **pickSize**
3. **pickSize** — 4 sizes → WhatsApp **list** / Instagram **carousel** (list shape) → **pickColor**
4. **pickColor** — 3 colors → **addToCart**
5. **addToCart** — append line to `state.cart` → **cartReview**
6. **cartReview** — checkout → **address**; more → **browse**; remove → **removeLast** → **cartReview**
7. **address** — extract `{ name, street, city, zip }` → **payment**
8. **payment** — `charge` (cart total) → **orderConfirm**
9. **orderConfirm** — summary + order # → `{ end: 'ordered' }`

**Promo:** `promo_drop` APPROVED template via `broadcasts.send` — opted-in customers only, idempotent per recipient/campaign. Reply `SHOP` re-enters the flow.

## Run (live model, fake Meta clients)

```bash
bun run packages/engagement/examples/clothing/run.ts
```

Without a key, prints `SKIP: no live key` and exits 0. Drives the same bot on **WhatsApp**, **Instagram**, and **web** (recorded outbound shows list vs carousel/list ids for size pick).

## Tests (offline)

```bash
bun test packages/engagement/examples/clothing/clothing.test.ts
```

| Test | What it proves |
|------|----------------|
| `product_size_color_route_by_id` | Product/size/color `decide` + inbound `selection.id` (label-independent) |
| `cart_grows_and_shrinks_across_turns` | Two items added, remove last → `state.cart.length === 1` |
| `size_list_renders_per_channel` | 4 sizes → `renderChoices` + `renderInstagramInteractive` list rows with same ids |
| `checkout_extracts_address_into_state` | `collect` submit → address fields in state → `payment` |
| `promo_broadcast_idempotent_and_opt_in_only` | Opt-in gate + ledger skips duplicate campaign send |

Deterministic tests use a **channel driver** (submit tools + structured `decide` choices), not a live model. Address extraction in tests is via the `submit_address_data` tool path; live parsing is only in `run.ts` when an API key is present.

## Env

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Live model |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Live model |
| `XAI_API_KEY` | Live model |

No WhatsApp / Meta tokens required.
